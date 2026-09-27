import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ProviderTool } from "../providers/router.js";
import { parseToolArguments, toolFailure, type ToolCallExecutor, type ToolExecutionContext, type ToolExecutionResult } from "../execution/tool-loop.js";
import { assertNoLinkComponentsAsync, InvalidSkillError, skillPathContainedBy, validateSkillDocument, type SkillCatalog } from "./catalog.js";
import { DEFAULT_SKILL_CATALOG_LIMITS, OPENBOT_SKILL_ROOT_SOURCE, type SkillRoot } from "./contracts.js";
import {
  DEFAULT_SKILL_CONTEXT_BYTES,
  isModelSelectable,
  isSkillAllowed,
  resolveSkillContext,
  type ResolvedSkillContext,
  type SkillAgentPolicy,
} from "./references.js";

export type { SkillAgentPolicy } from "./references.js";
export type { ResolvedSkillContext } from "./references.js";

export const SKILL_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "search_skills",
      description: "Search and rank the shared local Skills catalog by task, name, description, or triggers. Use a few concise task keywords.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_skill",
      description: "Load one cataloged Skill as untrusted, delimited instructions for this turn.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

const SAVE_SKILL_TOOL: ProviderTool = {
  type: "function",
  function: {
    name: "save_skill",
    description: "Save a reusable procedure as a Skill for future sessions of any bot. Call this right after you completed a multi-step task whose approach is worth repeating (a specific tool sequence, a workaround, a domain procedure, a checklist). Write the body as concise imperative steps with the exact commands/tools that worked and the pitfalls to avoid. Reuse an existing id to update a skill you saved before; never save secrets, one-off data, or task results.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
        name: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", minLength: 1, maxLength: 500 },
        body: { type: "string", minLength: 1, maxLength: DEFAULT_SKILL_CATALOG_LIMITS.maxSkillBytes },
        triggers: {
          type: "array",
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 64 },
        },
      },
      required: ["id", "name", "description", "body"],
      additionalProperties: false,
    },
  },
};

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_SEARCH_QUERY_CHARACTERS = 256;
const MAX_SAVE_NAME_CHARACTERS = 80;
const MAX_SAVE_DESCRIPTION_CHARACTERS = 500;
const MAX_SAVE_TRIGGERS = 8;
const MAX_SAVE_TRIGGER_CHARACTERS = 64;

export interface SkillDispatcherOptions {
  catalog: SkillCatalog;
  policyForAgent?: (agentId: string) => SkillAgentPolicy | undefined;
  maxSearchResults?: number;
  maxInjectedBytes?: number;
  /** Writable skill root source; defaults to the OpenBot profile root. */
  authoringSource?: string;
}


function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function normalizedId(value: string): string | undefined {
  return SKILL_ID.test(value) ? value.toLowerCase() : undefined;
}

function failure(operation: string, message: string, code = "validation"): ToolExecutionResult {
  return toolFailure(operation, code, message);
}

function success(operation: string, content: string): ToolExecutionResult {
  return { handled: true, ok: true, content, result: { ok: true, operation, bytes: Buffer.byteLength(content, "utf8") } };
}

function callName(context: ToolExecutionContext): string {
  return (context.call).function.name;
}

function composeSkillDocument(args: {
  name: string;
  description: string;
  body: string;
  triggers?: readonly string[];
}): string {
  const lines = ["---", `name: ${JSON.stringify(args.name)}`, `description: ${JSON.stringify(args.description)}`];
  if (args.triggers !== undefined && args.triggers.length > 0) {
    lines.push(`triggers: [${args.triggers.map((trigger) => JSON.stringify(trigger)).join(", ")}]`);
  }
  lines.push("---", "", args.body);
  return `${lines.join("\n")}\n`;
}

const linkFailure = (): ToolExecutionResult =>
  failure("skills.save", "skill path contains a symlink, junction, or reparse point", "policy");

/** Canonical path of an existing path whose whole chain is free of links; undefined otherwise. */
async function linkFreeRealPath(path: string): Promise<string | undefined> {
  try {
    return await assertNoLinkComponentsAsync(resolve(path));
  } catch {
    return undefined;
  }
}

async function assertWritablePath(path: string): Promise<ToolExecutionResult | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return failure("skills.save", "skill path contains a symlink, junction, or reparse point", "policy");
    }
  } catch {
    // Missing paths are created by the caller.
  }
  return undefined;
}

/** Executes only Skills; unknown names return handled:false for the local broker. */
export class SkillDispatcher {
  public readonly tools: ProviderTool[];

  private readonly catalog: SkillCatalog;
  private readonly policyForAgent?: (agentId: string) => SkillAgentPolicy | undefined;
  private readonly maxSearchResults: number;
  private readonly maxInjectedBytes: number;
  private readonly authoringRoot?: SkillRoot;
  private readonly authoringSource: string;
  private readonly toolNames: Set<string>;

  public constructor(options: SkillDispatcherOptions) {
    this.catalog = options.catalog;
    this.policyForAgent = options.policyForAgent;
    this.maxSearchResults = options.maxSearchResults ?? DEFAULT_SEARCH_RESULTS;
    this.maxInjectedBytes = options.maxInjectedBytes ?? DEFAULT_SKILL_CONTEXT_BYTES;
    this.authoringSource = options.authoringSource ?? OPENBOT_SKILL_ROOT_SOURCE;
    // Test doubles may implement only the read-side catalog surface.
    this.authoringRoot = typeof this.catalog.rootFor === "function" ? this.catalog.rootFor(this.authoringSource) : undefined;
    this.tools = this.authoringRoot ? [...SKILL_TOOLS, SAVE_SKILL_TOOL] : SKILL_TOOLS;
    this.toolNames = new Set(this.tools.map((tool) => tool.function.name));
    if (!Number.isSafeInteger(this.maxSearchResults) || this.maxSearchResults <= 0 || this.maxSearchResults > 50) {
      throw new TypeError("invalid maxSearchResults");
    }
    if (!Number.isSafeInteger(this.maxInjectedBytes) || this.maxInjectedBytes <= 0) {
      throw new TypeError("invalid maxInjectedBytes");
    }
  }

  public canHandle(name: string): boolean {
    return this.toolNames.has(name);
  }

  public async execute(context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const name = callName(context);
    if (!this.canHandle(name)) return { handled: false };
    const operation = name === "use_skill" ? "skills.use" : name === "save_skill" ? "skills.save" : "skills.search";
    if (context.signal?.aborted) return failure(operation, "skill operation aborted", "aborted");
    const args = parseToolArguments(context.call.function.arguments);
    if (args === undefined) return failure(operation, "tool arguments must be a JSON object");
    try {
      if (name === "search_skills") return this.search(context.agentId, args);
      if (name === "save_skill") return await this.save(context.agentId, args, context.signal);
      return await this.use(context.agentId, args);
    } catch {
      // Do not expose filesystem, parser, or policy internals in provider output.
      return failure(operation, "skill operation failed", "io_error");
    }
  }

  /** A callable executor with the canHandle hint consumed by runToolLoop. */
  public executor(): ToolCallExecutor {
    const execute = (context: ToolExecutionContext) => this.execute(context);
    return Object.assign(execute, { canHandle: (name: string) => this.canHandle(name) });
  }

  /** Resolves explicit composer references into a non-transcript context string. */
  public async resolveTurnContext(agentId: string, args: { prompt: string; richText?: string }): Promise<string> {
    const resolved = await this.resolveSkillContext(agentId, args);
    return resolved.context;
  }

  public resolveSkillContext(agentId: string, args: { prompt: string; richText?: string }): Promise<ResolvedSkillContext> {
    return resolveSkillContext({
      catalog: this.catalog,
      policy: this.policyForAgent?.(agentId),
      prompt: args.prompt,
      richText: args.richText,
      maxInjectedBytes: this.maxInjectedBytes,
    });
  }

  private policy(agentId: string): SkillAgentPolicy | undefined {
    return this.policyForAgent?.(agentId);
  }

  private allowed(agentId: string, id: string): boolean {
    return isSkillAllowed(this.policy(agentId), id);
  }

  private search(agentId: string, args: Record<string, unknown>): ToolExecutionResult {
    if (!exactKeys(args, ["query", "limit"])) return failure("skills.search", "unknown skill search argument");
    if (typeof args.query !== "string" || args.query.trim().length === 0 || args.query.length > MAX_SEARCH_QUERY_CHARACTERS) {
      return failure("skills.search", "skill search query is invalid");
    }
    const rawLimit = args.limit;
    if (rawLimit !== undefined && (!Number.isSafeInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 50)) {
      return failure("skills.search", "skill search limit is invalid");
    }
    const limit = Math.min((rawLimit as number | undefined) ?? this.maxSearchResults, this.maxSearchResults);
    const policy = this.policy(agentId);
    if (policy?.enabled === false) return success("skills.search", "[]");
    const results = this.catalog
      .list(args.query.trim())
      .filter((entry) => isSkillAllowed(policy, entry.id) && isModelSelectable(this.catalog.invocationPolicy(entry.id)))
      .slice(0, limit);
    return success("skills.search", JSON.stringify(results));
  }

  private async use(agentId: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!exactKeys(args, ["id"]) || typeof args.id !== "string") return failure("skills.use", "skill id is invalid");
    const id = normalizedId(args.id);
    const invocation = id === undefined ? undefined : this.catalog.invocationPolicy(id);
    if (id === undefined || !this.allowed(agentId, id) || invocation?.modelInvocable !== true) {
      return failure("skills.use", "skill is unavailable");
    }
    if (!invocation.autoSelect) {
      return failure("skills.use", "skill requires explicit user selection");
    }
    const skill = this.catalog.readCachedValidated
      ? await this.catalog.readCachedValidated(id)
      : this.catalog.readAsync
        ? await this.catalog.readAsync(id)
        : this.catalog.read(id);
    if (skill === undefined) return failure("skills.use", "skill is unavailable");
    const content = `${skill.delimiters.start}\n${skill.content}\n${skill.delimiters.end}`;
    if (Buffer.byteLength(content, "utf8") > this.maxInjectedBytes) {
      return failure("skills.use", "skill content exceeds the injection limit");
    }
    return success("skills.use", content);
  }

  private async save(agentId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    if (this.authoringRoot === undefined) return failure("skills.save", "skill authoring is unavailable", "policy");
    const policy = this.policy(agentId);
    if (policy?.enabled === false) return failure("skills.save", "skills are disabled for this bot", "policy");

    if (!exactKeys(args, ["id", "name", "description", "body", "triggers"])) {
      return failure("skills.save", "unknown skill save argument");
    }
    if (typeof args.id !== "string" || typeof args.name !== "string" || typeof args.description !== "string" || typeof args.body !== "string") {
      return failure("skills.save", "skill save arguments are invalid");
    }

    const id = normalizedId(args.id);
    if (id === undefined) return failure("skills.save", "skill id is invalid");
    const name = args.name.trim();
    const description = args.description.trim();
    const body = args.body;
    if (!name || name.length > MAX_SAVE_NAME_CHARACTERS) return failure("skills.save", "skill name is invalid");
    if (!description || description.length > MAX_SAVE_DESCRIPTION_CHARACTERS) return failure("skills.save", "skill description is invalid");
    if (!body || Buffer.byteLength(body, "utf8") > DEFAULT_SKILL_CATALOG_LIMITS.maxSkillBytes) {
      return failure("skills.save", "skill body is invalid");
    }
    if (body.trimStart().startsWith("---")) return failure("skills.save", "skill body must not start with frontmatter markers");

    let triggers: string[] | undefined;
    if (args.triggers !== undefined) {
      if (!Array.isArray(args.triggers) || args.triggers.length > MAX_SAVE_TRIGGERS) {
        return failure("skills.save", "skill triggers are invalid");
      }
      triggers = [];
      for (const trigger of args.triggers) {
        if (typeof trigger !== "string" || !trigger.trim() || trigger.length > MAX_SAVE_TRIGGER_CHARACTERS) {
          return failure("skills.save", "skill triggers are invalid");
        }
        triggers.push(trigger.trim());
      }
    }

    const existingSource = this.catalog.sourceOf(id);
    if (existingSource !== undefined && existingSource !== this.authoringSource) {
      return failure("skills.save", "skill id belongs to a read-only root", "policy");
    }
    const created = existingSource !== this.authoringSource;

    const text = composeSkillDocument({ name, description, body, triggers });
    try {
      validateSkillDocument(text, id);
    } catch (error) {
      const message = error instanceof InvalidSkillError ? error.message : "invalid skill";
      return failure("skills.save", message);
    }

    const skillDir = join(this.authoringRoot.path, id);
    const skillFile = join(skillDir, "SKILL.md");
    // The authoring root was validated at startup; it must still be link-free
    // now, or a root swapped for a junction would redirect the write.
    const rootRealPath = await linkFreeRealPath(this.authoringRoot.path);
    if (rootRealPath === undefined) return linkFailure();
    const dirPolicy = await assertWritablePath(skillDir);
    if (dirPolicy !== undefined) return dirPolicy;
    const filePolicy = await assertWritablePath(skillFile);
    if (filePolicy !== undefined) return filePolicy;
    if (signal?.aborted) return failure("skills.save", "skill operation aborted", "aborted");

    await mkdir(skillDir, { recursive: true });
    // Revalidate after mkdir and again before committing: the pre-check above
    // races an attacker with write access to the profile swapping the root or
    // the directory for a link. The whole chain must stay link-free and inside
    // the authoring root.
    const insideRoot = async (): Promise<boolean> => {
      const dirRealPath = await linkFreeRealPath(skillDir);
      return dirRealPath !== undefined && skillPathContainedBy(rootRealPath, dirRealPath);
    };
    if (!await insideRoot()) return linkFailure();
    if (signal?.aborted) return failure("skills.save", "skill operation aborted", "aborted");
    const tempFile = join(skillDir, `SKILL.md.tmp-${randomBytes(8).toString("hex")}`);
    let committed = false;
    try {
      await writeFile(tempFile, text, { encoding: "utf8", flag: "wx", signal });
      if (signal?.aborted) return failure("skills.save", "skill operation aborted", "aborted");
      if (!await insideRoot()) return linkFailure();
      await rename(tempFile, skillFile);
      committed = true;
    } catch (error) {
      if (signal?.aborted) return failure("skills.save", "skill operation aborted", "aborted");
      throw error;
    } finally {
      if (!committed) await rm(tempFile, { force: true }).catch(() => undefined);
    }

    this.catalog.refresh();
    if (!this.catalog.list("").some((entry) => entry.id === id)) {
      return failure("skills.save", "skill was written but not indexed");
    }

    return success("skills.save", JSON.stringify({
      ok: true,
      id,
      created,
      path: `${this.authoringSource}/${id}/SKILL.md`,
    }));
  }
}

export function createSkillDispatcher(options: SkillDispatcherOptions): SkillDispatcher {
  return new SkillDispatcher(options);
}
