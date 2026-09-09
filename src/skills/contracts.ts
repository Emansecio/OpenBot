/** A local, explicitly approved directory from which Skills may be loaded. */
export interface SkillRoot {
  /** Absolute or process-relative path supplied by the host, never by a chat turn. */
  path: string;
  /** A short display label such as `project` or `profile`; this is not a filesystem path. */
  source: string;
}

/** Public catalog data. Deliberately contains no filesystem path or Markdown body. */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: string;
}

/** Invocation hints are advisory metadata, not an authority grant. */
export interface SkillInvocationPolicy {
  modelInvocable: boolean;
  userInvocable: boolean;
  autoSelect: boolean;
  triggers: readonly string[];
  argumentHint?: string;
}

/**
 * A body returned by an explicit read. Skill Markdown is untrusted instructions;
 * callers must keep it in the delimited instruction section of a model request and
 * must not derive tools, filesystem access, or network permissions from it.
 */
export interface SkillReadResult extends SkillSummary {
  content: string;
  delimiters: {
    start: string;
    end: string;
  };
  invocation: SkillInvocationPolicy;
  trust: "untrusted";
}

export interface SkillCatalogLimits {
  /** Maximum bytes for a single complete SKILL.md. */
  maxSkillBytes: number;
  /** Maximum UTF-8 bytes occupied by the frontmatter section. */
  maxFrontmatterBytes: number;
  /** Maximum immediate skill directories considered across all roots per refresh. */
  maxCandidates: number;
  /** Maximum number of explicitly supplied roots. */
  maxRoots: number;
  /** Maximum characters in a metadata name. */
  maxNameCharacters: number;
  /** Maximum characters in a metadata description. */
  maxDescriptionCharacters: number;
  /** Maximum characters in a single invocation trigger. */
  maxTriggerCharacters: number;
  /** Maximum number of invocation triggers. */
  maxTriggers: number;
}

export interface SkillCatalogOptions {
  /** Roots are evaluated in this order; an earlier root wins an id collision. */
  roots: readonly SkillRoot[];
  limits?: Partial<SkillCatalogLimits>;
}

/** Source label for the OpenBot-owned writable skill root under the user profile. */
export const OPENBOT_SKILL_ROOT_SOURCE = "profile-openbot";

export const DEFAULT_SKILL_CATALOG_LIMITS: SkillCatalogLimits = Object.freeze({
  maxSkillBytes: 256 * 1024,
  maxFrontmatterBytes: 32 * 1024,
  maxCandidates: 512,
  maxRoots: 16,
  maxNameCharacters: 160,
  maxDescriptionCharacters: 8_000,
  maxTriggerCharacters: 160,
  maxTriggers: 32,
});

