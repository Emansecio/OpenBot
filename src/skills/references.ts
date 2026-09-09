import type { SkillCatalog } from "./catalog.js";
import type { SkillReadResult } from "./contracts.js";

/** Per-agent gate applied after the shared catalog has found a Skill. */
export interface SkillAgentPolicy {
  enabled?: boolean;
  disabledIds?: readonly string[];
}

export interface ParsedSkillCommand {
  skillId: string;
  prompt: string;
}

export interface ResolveSkillContextOptions {
  catalog: SkillCatalog;
  prompt: string;
  richText?: string;
  policy?: SkillAgentPolicy;
  maxInjectedBytes?: number;
}

export interface ResolvedSkillContext {
  /** Prompt with the optional `/skill <id>` prefix removed. */
  prompt: string;
  /** Valid, user-invocable Skill IDs whose bodies were included. */
  skillIds: string[];
  /** IDs found in the request but rejected by validation or policy. */
  rejectedIds: string[];
  /** Ephemeral, delimited Skill instructions for the provider request. */
  context: string;
  /** Present only when a global injection limit prevents a safe result. */
  error?: string;
}

const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WORKFLOW_REFERENCE = /^skill:([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u;
const DEFAULT_MAX_INJECTED_BYTES = 256 * 1024;

function normalizedId(value: string): string | undefined {
  return SKILL_ID.test(value) ? value.toLowerCase() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Extracts only Tiptap workflowReference nodes. Arbitrary text/HTML that looks
 * like a reference is deliberately ignored; only the structured `content`
 * tree has authority to nominate a Skill.
 */
export function parseSkillReferences(richText: string | undefined): string[] {
  if (typeof richText !== "string" || richText.trim().length === 0) return [];
  let root: unknown;
  try {
    root = JSON.parse(richText) as unknown;
  } catch {
    return [];
  }

  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const current = record(node);
    if (!current) return;
    if (current.type === "workflowReference") {
      const attrs = record(current.attrs);
      const rawId = attrs?.id;
      if (typeof rawId === "string") {
        const match = WORKFLOW_REFERENCE.exec(rawId.trim());
        const id = match?.[1] === undefined ? undefined : normalizedId(match[1]);
        if (id !== undefined && !seen.has(id)) {
          seen.add(id);
          found.push(id);
        }
      }
    }
    // Tiptap nests child nodes under `content`; never walk arbitrary attrs.
    if (Array.isArray(current.content)) walk(current.content);
  };
  walk(root);
  return found;
}

/** Alias kept explicit for callers that prefer the extractor terminology. */
export const extractSkillReferenceIds = parseSkillReferences;
export const extractSkillReferences = parseSkillReferences;

/**
 * Parses the accessible textual fallback. It is intentionally anchored at the
 * first character, so a sentence containing `/skill` cannot gain privileges.
 */
export function parseSkillCommand(prompt: string): ParsedSkillCommand | undefined {
  if (typeof prompt !== "string") return undefined;
  const match = /^\/skill[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:[ \t]+([\s\S]*))?$/u.exec(prompt);
  if (!match) return undefined;
  const skillId = normalizedId(match[1] ?? "");
  if (skillId === undefined) return undefined;
  return { skillId, prompt: (match[2] ?? "").trim() };
}

function isAllowed(id: string, policy: SkillAgentPolicy | undefined): boolean {
  if (policy?.enabled === false) return false;
  return !(policy?.disabledIds ?? []).some((candidate) => typeof candidate === "string" && normalizedId(candidate) === id);
}

async function readSkill(
  catalog: SkillCatalog,
  id: string,
  policy: SkillAgentPolicy | undefined,
): Promise<SkillReadResult | undefined> {
  if (!isAllowed(id, policy)) return undefined;
  const invocation = catalog.invocationPolicy(id);
  if (!invocation?.userInvocable) return undefined;
  if (catalog.readCachedValidated) return catalog.readCachedValidated(id);
  if (catalog.readAsync) return catalog.readAsync(id);
  return catalog.read(id);
}

function skillBlock(skill: SkillReadResult): string {
  return `${skill.delimiters.start}\n${skill.content}\n${skill.delimiters.end}`;
}

/** Resolves explicit references into ephemeral provider context. */
export async function resolveSkillContext(options: ResolveSkillContextOptions): Promise<ResolvedSkillContext> {
  const command = parseSkillCommand(options.prompt);
  const prompt = command?.prompt ?? options.prompt;
  const requested = [...parseSkillReferences(options.richText), ...(command ? [command.skillId] : [])];
  const uniqueRequested: string[] = [];
  const requestedSet = new Set<string>();
  for (const id of requested) {
    if (!requestedSet.has(id)) {
      requestedSet.add(id);
      uniqueRequested.push(id);
    }
  }

  const rejectedIds: string[] = [];
  const rejectedSet = new Set<string>();
  const valid: SkillReadResult[] = [];
  for (const id of uniqueRequested) {
    const skill = await readSkill(options.catalog, id, options.policy);
    if (skill === undefined) {
      if (!rejectedSet.has(id)) {
        rejectedSet.add(id);
        rejectedIds.push(id);
      }
      continue;
    }
    valid.push(skill);
  }

  const blocks = valid.map(skillBlock);
  const context = blocks.join("\n\n");
  const maxInjectedBytes = options.maxInjectedBytes ?? DEFAULT_MAX_INJECTED_BYTES;
  if (!Number.isSafeInteger(maxInjectedBytes) || maxInjectedBytes <= 0) {
    throw new TypeError("invalid maxInjectedBytes");
  }
  if (Buffer.byteLength(context, "utf8") > maxInjectedBytes) {
    return {
      prompt,
      skillIds: [],
      rejectedIds: [...rejectedIds, ...valid.map((skill) => skill.id)],
      context: "",
      error: "skill context exceeds the injection limit",
    };
  }
  return {
    prompt,
    skillIds: valid.map((skill) => skill.id),
    rejectedIds,
    context,
  };
}

export const DEFAULT_SKILL_CONTEXT_BYTES = DEFAULT_MAX_INJECTED_BYTES;
