/**
 * Política de ação declarativa por bot (melhoria 2 do spec
 * 2026-08-21-workspace-quality-improvements-design.md).
 *
 * `.openbot/policy.json` aperta o modo `always` do broker: regras
 * ferramenta+path com efeito allow/ask/deny e rate-limit opcional. A primeira
 * regra que casa vence; o que não casa usa `default`. O efeito nunca afrouxa
 * a permissão global — só aperta (deny > ask > allow).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExecutionRequest } from "./contracts.js";

export type PolicyEffect = "allow" | "ask" | "deny";

export interface PolicyRule {
  match: {
    /** Operation name; trailing `*` is a prefix wildcard ("file.*"). */
    tool: string;
    /** Glob over bot-relative paths; "**" matches any request. */
    path?: string;
  };
  effect: PolicyEffect;
  /** Sliding-window limit like "30/minute". */
  rateLimit?: string;
}

export interface PolicyDocument {
  rules: PolicyRule[];
  default: PolicyEffect;
}

/** Shipped default: zero burocracia — tudo permitido dentro da home. */
export const DEFAULT_HOME_POLICY: PolicyDocument = {
  rules: [
    { match: { tool: "file.*", path: "**" }, effect: "allow" },
    { match: { tool: "command.run", path: "**" }, effect: "allow" },
    { match: { tool: "browser.*", path: "**" }, effect: "allow" },
    { match: { tool: "whatsapp", path: "**" }, effect: "allow" },
  ],
  default: "allow",
};

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface PolicyDecision {
  effect: PolicyEffect;
  /** Index of the matched rule, or null when `default` decided. */
  ruleIndex: number | null;
}

const RATE_LIMIT_PATTERN = /^(\d{1,6})\/(second|minute|hour)$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePolicy(raw: unknown): PolicyDocument {
  if (!isPlainObject(raw)) throw new PolicyError("policy.json deve ser um objeto");
  const rulesRaw = raw.rules;
  if (!Array.isArray(rulesRaw)) throw new PolicyError("policy.rules deve ser um array");
  const rules: PolicyRule[] = [];
  for (const candidate of rulesRaw) {
    if (!isPlainObject(candidate) || !isPlainObject(candidate.match)) {
      throw new PolicyError("cada rule exige match { tool, path? }");
    }
    const { tool, path } = candidate.match;
    if (typeof tool !== "string" || tool.length === 0) throw new PolicyError("match.tool é obrigatório");
    if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
      throw new PolicyError("match.path deve ser uma string não vazia");
    }
    if (candidate.effect !== "allow" && candidate.effect !== "ask" && candidate.effect !== "deny") {
      throw new PolicyError("effect deve ser allow, ask ou deny");
    }
    const rule: PolicyRule = { match: path === undefined ? { tool } : { tool, path }, effect: candidate.effect };
    if (candidate.rateLimit !== undefined) {
      if (typeof candidate.rateLimit !== "string" || !RATE_LIMIT_PATTERN.test(candidate.rateLimit)) {
        throw new PolicyError('rateLimit deve ser "N/second", "N/minute" ou "N/hour"');
      }
      rule.rateLimit = candidate.rateLimit;
    }
    rules.push(rule);
  }
  if (raw.default !== "allow" && raw.default !== "ask" && raw.default !== "deny") {
    throw new PolicyError("default deve ser allow, ask ou deny");
  }
  return { rules, default: raw.default };
}

/** Lê `.openbot/policy.json`; ausente → default embarcado. Corrompido falha. */
export async function readHomePolicy(homeRoot: string): Promise<PolicyDocument> {
  let raw: string;
  try {
    raw = await readFile(join(homeRoot, ".openbot", "policy.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_HOME_POLICY;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyError("policy.json corrompido");
  }
  return parsePolicy(parsed);
}

/** Bot-relative paths touched by a request (for path-pattern matching). */
export function extractRequestPaths(request: ExecutionRequest): string[] {
  switch (request.operation) {
    case "file.list":
    case "file.stat":
    case "file.mkdir":
    case "file.trash":
    case "file.read":
    case "file.write":
      return [request.path];
    case "file.copy":
    case "file.move":
      return [request.source, request.destination];
    case "file.restore":
      return [request.path ?? ""];
    case "command.run":
      return [request.cwd, ...request.params.paths];
    default:
      return [];
  }
}

function globToRegExp(pattern: string): RegExp {
  if (pattern === "**") return /^[\s\S]*$/;
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^\\\\/]*";
      }
    } else if (char === "?") {
      source += "[^\\\\/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "iu");
}

function matchesTool(pattern: string, operation: string): boolean {
  if (pattern === "**") return true;
  if (pattern.endsWith("*")) return operation.startsWith(pattern.slice(0, -1));
  return pattern === operation;
}

interface RateWindow {
  windowMs: number;
  limit: number;
  hits: number[];
}

export class PolicyEngine {
  private readonly compiled: { rule: PolicyRule; pathMatcher: RegExp | null }[];
  private readonly rates = new Map<string, RateWindow>();

  constructor(readonly document: PolicyDocument) {
    this.compiled = document.rules.map((rule) => ({
      rule,
      pathMatcher: rule.match.path === undefined ? null : globToRegExp(rule.match.path),
    }));
  }

  /**
   * First matching rule wins; `default` decides otherwise. A matching
   * rate-limited rule consumes one slot and degrades to "ask" when full.
   */
  evaluate(agentId: string, operation: string, paths: string[], now: number = Date.now()): PolicyDecision {
    for (let index = 0; index < this.compiled.length; index += 1) {
      const { rule, pathMatcher } = this.compiled[index]!;
      if (!matchesTool(rule.match.tool, operation)) continue;
      if (pathMatcher !== null) {
        const normalized = paths.map((path) => path.replaceAll("\\", "/"));
        if (!normalized.some((path) => pathMatcher.test(path))) continue;
      }
      if (rule.effect !== "deny" && rule.rateLimit !== undefined && !this.consume(agentId, index, rule.rateLimit, now)) {
        return { effect: "ask", ruleIndex: index };
      }
      return { effect: rule.effect, ruleIndex: index };
    }
    return { effect: this.document.default, ruleIndex: null };
  }

  private consume(agentId: string, ruleIndex: number, rateLimit: string, now: number): boolean {
    const match = RATE_LIMIT_PATTERN.exec(rateLimit);
    if (!match) return true;
    const limit = Number(match[1]);
    const unit = match[2];
    const windowMs = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 3_600_000;
    const key = `${agentId}\u0000${ruleIndex}`;
    let window = this.rates.get(key);
    if (window === undefined || now - (window.hits[0] ?? now) >= windowMs || window.windowMs !== windowMs) {
      window = { windowMs, limit, hits: [] };
      this.rates.set(key, window);
    }
    window.hits = window.hits.filter((timestamp) => now - timestamp < windowMs);
    if (window.hits.length >= limit) return false;
    window.hits.push(now);
    return true;
  }
}
