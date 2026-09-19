import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  discardStage,
  exportHomeArchive,
  HomeArchiveError,
  readHomeArchiveSummary,
  stageHomeArchive,
  validateHomeArchive,
  type ExportHomeArchiveOptions,
  type ImportHomeArchiveOptions,
} from "./home-archive.js";
import {
  DEFAULT_HOME_ACL_ADAPTER,
  type HomeAclAdapter,
  type HomeAclContext,
  type HomeAclResult,
} from "./home-acl.js";
import { HomeWorkspaceBackend } from "./home-backend.js";
import { emptyGrants, writeSharedGrants } from "./home-grants.js";
import {
  calculateVisibleUsage,
  detectDrift,
  readUsageBaseline,
  writeUsageBaseline,
  type DriftReport,
} from "./home-drift.js";
import { inventoryHome, type HomeInventory } from "./home-inventory.js";
import { writeFileExclusive } from "../shared/fs-atomic.js";
import { WorkspaceError, WorkspaceSandbox } from "./workspace.js";

export const HOME_LAYOUT_VERSION = 2;
export const MIN_HOME_LAYOUT_VERSION = 1;
export const HOME_DIRECTORIES = ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "Projects", ".openbot"] as const;

export interface AgentHome {
  agentId: string;
  root: string;
  acl?: HomeAclResult;
  /** True only when this call created the active home directory. */
  created?: boolean;
}

export interface AgentHomeManifest {
  agentId: string;
  createdAt: string;
  layoutVersion: number;
  /** ISO timestamp of the last completed layout migration. */
  migratedAt?: string;
  /** Append-only log of applied migration steps (oldest first). */
  migrationLog?: string[];
  /** sha256 of the welcome template generation seeded into this home. */
  welcomeHash?: string;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
// Process-local queue: the default gateway is single-process, so serializing
// workspace ACL writes within this process is sufficient for the confirmed race.
const workspaceAclQueues = new Map<string, Promise<void>>();
const WELCOME = [
  "# Computador do OpenBot",
  "",
  "Caminhos relativos em arquivos e comandos apontam para esta pasta física do bot.",
  "Downloads do navegador são salvos em Downloads. Projects é o local padrão para projetos.",
  "Use workspace_info para consultar caminhos físicos, arquivos de redirects antigos e pastas compartilhadas concedidas.",
  "Compartilhamentos são explícitos: shared://Documents, por exemplo. Comandos usam seus caminhos físicos.",
  "",
].join("\n");
const WELCOME_HASH = createHash("sha256").update(WELCOME).digest("hex");

export function defaultWorkspacesRoot(): string {
  const explicitRoot = process.env.OPENBOT_LOCAL_DATA_ROOT?.trim();
  if (explicitRoot) return join(explicitRoot, "workspaces");
  const local = process.env.LOCALAPPDATA;
  const base = local && local.length > 0 ? local : join(homedir(), "AppData", "Local");
  return join(base, "OpenBot", "workspaces");
}

export function sanitizeAgentId(agentId: string): string {
  if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
    throw new WorkspaceError("invalid_path", "Agent id is invalid.");
  }
  if (agentId.endsWith(".")) throw new WorkspaceError("invalid_path", "Agent id is invalid.");
  const stem = agentId.split(".", 1)[0] ?? "";
  if (RESERVED.test(stem)) throw new WorkspaceError("invalid_path", "Agent id is invalid.");
  return agentId;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && (error).code === "ENOENT";

const isWithinRoot = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const sameAgentId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const workspaceQueueKey = (root: string): string => process.platform === "win32" ? root.toLowerCase() : root;

async function atomicCreateFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link() publishes the fully-synced file atomically and never replaces an
    // existing marker. The temporary hard link is removed in finally.
    await link(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function atomicReplaceFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

interface LayoutMigrationStep {
  from: number;
  /** Applies one additive step; returns a human-readable log line. */
  apply: (sandbox: WorkspaceSandbox, agentId: string, manifest: AgentHomeManifest) => Promise<string>;
}

const LAYOUT_MIGRATIONS: readonly LayoutMigrationStep[] = [
  {
    from: 1,
    apply: async (sandbox, _agentId, manifest) => {
      // v1 → v2: pastas do usuário viram opt-in por bot. Semeia um documento
      // de grants vazio (nenhum grant implícito) e registra a geração do
      // template de boas-vindas que esta home recebeu.
      await seedGrantsFile(sandbox);
      manifest.welcomeHash = WELCOME_HASH;
      return "v2: pastas do usuario opt-in (grants.json semeado, welcome hash registrado)";
    },
  },
];

/** Seeds an empty grants document; existing files are never overwritten. */
async function seedGrantsFile(sandbox: WorkspaceSandbox): Promise<void> {
  const grantsPath = await sandbox.resolveDestination(".openbot/grants.json");
  try {
    await writeFileExclusive(grantsPath, `${JSON.stringify(emptyGrants(), null, 2)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export class HomeLifecycleError extends Error {
  constructor(
    readonly code: "conflict" | "not_found" | "integrity_error" | "unsafe_path" | "io_error" | "access_denied",
    message: string,
  ) {
    super(message);
    this.name = "HomeLifecycleError";
  }
}

export interface AgentHomeStoreOptions {
  /** Injectable ACL adapter; the default never broadens permissions. */
  acl?: HomeAclAdapter;
  /** The complete parent tree was already recursively ACL-verified in this boot. */
  parentAclVerified?: boolean;
  /** Injectable only so lifecycle tests can exercise marker-write failures. */
  quarantineMarkerWriter?: (path: string, contents: string) => Promise<void>;
  /** Injectable only so lifecycle tests can exercise restore rollback. */
  quarantineMarkerRemover?: (path: string) => Promise<void>;
  /** Injectable only so lifecycle tests can exercise staging cleanup failures. */
  stageDiscarder?: (path: string) => Promise<void>;
}

export interface QuarantineEntry {
  quarantineId: string;
  agentId: string;
  quarantinedAt: string;
  root: string;
  inventory: HomeInventory;
}

export type QuarantineEntryMetadata = Omit<QuarantineEntry, "inventory">;

export interface HomeRepairResult {
  agentId: string;
  repaired: boolean;
  actions: string[];
  inventory: HomeInventory;
  acl: HomeAclResult;
}

export class AgentHomeStore {
  private readonly backends = new Map<string, Promise<HomeWorkspaceBackend>>();

  /** Snapshots live in a sibling of the workspaces root and never count against the bot quota. */
  static readonly MAX_SNAPSHOTS_PER_AGENT = 5;

  private constructor(
    readonly root: string,
    readonly quarantineRoot: string,
    readonly stagingRoot: string,
    private readonly workspaceAclQueueKey: string,
    private readonly acl: HomeAclAdapter,
    private readonly quarantineMarkerWriter: NonNullable<AgentHomeStoreOptions["quarantineMarkerWriter"]>,
    private readonly quarantineMarkerRemover: NonNullable<AgentHomeStoreOptions["quarantineMarkerRemover"]>,
    private readonly stageDiscarder: NonNullable<AgentHomeStoreOptions["stageDiscarder"]>,
  ) {}

  static async create(root = defaultWorkspacesRoot(), options: AgentHomeStoreOptions = {}): Promise<AgentHomeStore> {
    await mkdir(root, { recursive: true });
    let metadata;
    try {
      metadata = await lstat(root);
    } catch (error) {
      if (isMissing(error)) throw new WorkspaceError("not_found", "Workspace root does not exist.");
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceError("outside_workspace", "Workspace root contains a symbolic link or junction.");
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceError("invalid_path", "Workspace root is not a directory.");
    }
    const resolvedRoot = await realpath(root);
    const quarantineRoot = join(resolvedRoot, ".quarantine");
    await mkdir(quarantineRoot, { recursive: true });
    const quarantineMetadata = await lstat(quarantineRoot);
    if (quarantineMetadata.isSymbolicLink() || !quarantineMetadata.isDirectory()) {
      throw new WorkspaceError("outside_workspace", "Workspace quarantine contains a symbolic link or junction.");
    }
    const stagingRoot = join(resolvedRoot, ".staging");
    await mkdir(stagingRoot, { recursive: true });
    const stagingMetadata = await lstat(stagingRoot);
    if (stagingMetadata.isSymbolicLink() || !stagingMetadata.isDirectory()) {
      throw new WorkspaceError("outside_workspace", "Workspace staging contains a symbolic link or junction.");
    }
    const snapshotsRoot = join(resolvedRoot, ".snapshots");
    await mkdir(snapshotsRoot, { recursive: true });
    const snapshotsMetadata = await lstat(snapshotsRoot);
    if (snapshotsMetadata.isSymbolicLink() || !snapshotsMetadata.isDirectory()) {
      throw new WorkspaceError("outside_workspace", "Workspace snapshots directory contains a symbolic link or junction.");
    }
    const store = new AgentHomeStore(
      resolvedRoot,
      quarantineRoot,
      stagingRoot,
      workspaceQueueKey(resolvedRoot),
      options.acl ?? DEFAULT_HOME_ACL_ADAPTER,
      options.quarantineMarkerWriter ?? atomicCreateFile,
      options.quarantineMarkerRemover ?? ((path) => unlink(path).then(() => undefined)),
      options.stageDiscarder ?? discardStage,
    );
    if (options.parentAclVerified !== true) await store.applyWorkspaceAcls("create");
    return store;
  }

  pathFor(agentId: string): string {
    return join(this.root, sanitizeAgentId(agentId));
  }

  async ensure(agentId: string): Promise<AgentHome> {
    const id = sanitizeAgentId(agentId);
    const homeRoot = join(this.root, id);
    const existedBefore = await this.exists(homeRoot);
    await mkdir(homeRoot, { recursive: true });
    const sandbox = await WorkspaceSandbox.create(homeRoot, { allowAncestorLinks: true });
    for (const name of HOME_DIRECTORIES) {
      // Resolve every pre-existing component before touching it. In particular,
      // Desktop and .openbot must never redirect bootstrap I/O through a
      // symlink or Windows junction.
      const directory = await sandbox.resolveDestination(name);
      try {
        await mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await sandbox.resolveExisting(name);
    }
    const manifestPath = await sandbox.resolveDestination(".openbot/home.json");
    let existing: string | undefined;
    try {
      existing = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (existing !== undefined) {
      let manifest: AgentHomeManifest;
      try {
        manifest = JSON.parse(existing) as AgentHomeManifest;
      } catch {
        throw new Error("home.json corrompido");
      }
      if (typeof manifest.agentId !== "string" || manifest.agentId.length === 0) {
        throw new Error("home.json corrompido");
      }
      if (!sameAgentId(manifest.agentId, id)) {
        throw new Error("pasta de workspace reutilizada por outro agente");
      }
      this.validateManifestLayout(manifest);
      await this.migrateLayout(sandbox, id, manifest);
    } else {
      const manifest: AgentHomeManifest = {
        agentId: id,
        createdAt: new Date().toISOString(),
        layoutVersion: HOME_LAYOUT_VERSION,
        welcomeHash: WELCOME_HASH,
      };
      try {
        await writeFileExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        await seedGrantsFile(sandbox);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const racedPath = await sandbox.resolveExisting(".openbot/home.json");
        const raced = await readFile(racedPath, "utf8");
        let racedManifest: AgentHomeManifest;
        try {
          racedManifest = JSON.parse(raced) as AgentHomeManifest;
        } catch {
          throw new Error("home.json corrompido");
        }
        this.validateManifestLayout(racedManifest);
        if (!sameAgentId(racedManifest.agentId, id)) {
          throw new Error("pasta de workspace reutilizada por outro agente", { cause: error });
        }
        await this.migrateLayout(sandbox, id, racedManifest);
      }
    }
    await this.writeWelcome(sandbox);
    if (existedBefore) {
      return { agentId: id, root: sandbox.root };
    }
    const acl = await this.applyAcl(id, sandbox.root, "create");
    try {
      this.assertAcl(acl);
    } catch (error) {
      // A newly bootstrapped home must never remain active when Windows ACL
      // setup failed. Quarantine preserves any data written concurrently while
      // keeping the failed registration out of the active workspace tree.
      try {
        await this.remove(id);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Failed to rollback home after ACL bootstrap failure.", { cause: rollbackError });
      }
      throw error;
    }
    return { agentId: id, root: sandbox.root, acl, created: true };
  }

  /** Compensates a roster commit that failed after creating a fresh home. */
  async discardCreated(home: AgentHome): Promise<void> {
    if (!home.created) return;
    const id = sanitizeAgentId(home.agentId);
    if (await this.exists(join(this.root, id))) await this.remove(id);
  }

  async remove(agentId: string): Promise<string | undefined> {
    return this.moveToQuarantine(agentId, true);
  }

  /** Crash recovery only: atomic quarantine without reading/hash-walking user files. */
  async quarantineForRecovery(agentId: string): Promise<string | undefined> {
    return this.moveToQuarantine(agentId, false);
  }

  private async moveToQuarantine(agentId: string, verifyInventory: boolean): Promise<string | undefined> {
    const id = sanitizeAgentId(agentId);
    this.backends.delete(id);
    const source = join(this.root, id);
    const quarantineName = `${id}-${Date.now()}-${randomUUID()}`;
    const destination = join(this.quarantineRoot, quarantineName);
    const markerPath = join(source, ".openbot", "quarantine.json");
    const markerContents = `${JSON.stringify({ agentId: id, quarantineId: quarantineName, quarantinedAt: new Date().toISOString() }, null, 2)}\n`;
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new WorkspaceError("outside_workspace", "Agent workspace is unsafe.");
    }
    try {
      await this.readHomeManifest(source, id);
    } catch (error) {
      if (!(error instanceof HomeLifecycleError) || error.code !== "integrity_error") throw error;
      // Containment must not depend on a readable manifest: the directory
      // name is the identity, and quarantine preserves the bytes for manual
      // recovery. A manifest that parses but names another agent proves the
      // content is foreign — refuse instead of quarantining it under a wrong
      // identity.
      const probe = await readFile(join(source, ".openbot", "home.json"), "utf8")
        .then((text) => { try { return JSON.parse(text) as { agentId?: unknown }; } catch { return undefined; } })
        .catch(() => undefined);
      if (probe !== undefined && typeof probe.agentId === "string" && !sameAgentId(probe.agentId, id)) throw error;
      // The marker lives under .openbot; a damaged home may lack the directory.
      await mkdir(join(source, ".openbot"), { recursive: true });
    }
    if (verifyInventory) await inventoryHome(source, id);
    // Prepare the marker while the home is still active. This makes the
    // rename itself the commit point: once the destination exists, its
    // administrative marker is already present and valid.
    try {
      await lstat(markerPath);
      throw new HomeLifecycleError("integrity_error", "Active home already contains a quarantine marker.");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await this.quarantineMarkerWriter(markerPath, markerContents);
    } catch (error) {
      // A writer may have created a partial file before failing. Remove it
      // only when its contents are exactly ours; never delete pre-existing
      // or concurrently-created metadata.
      await this.cleanupPreparedMarker(markerPath, markerContents);
      throw error;
    }
    const markerMetadata = await lstat(markerPath).catch((error: unknown) => {
      if (isMissing(error)) throw new HomeLifecycleError("integrity_error", "Quarantine marker was not created.");
      throw error;
    });
    if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) {
      await this.cleanupPreparedMarker(markerPath, markerContents);
      throw new HomeLifecycleError("integrity_error", "Quarantine marker is not a regular file.");
    }
    const persistedMarker = await readFile(markerPath, "utf8");
    if (persistedMarker !== markerContents) {
      await this.cleanupPreparedMarker(markerPath, markerContents);
      throw new HomeLifecycleError("integrity_error", "Quarantine marker contents are invalid.");
    }
    try {
      await rename(source, destination);
    } catch (error) {
      // The source remains the authoritative home when the commit fails.
      // Best-effort cleanup is safe because the marker was created by us;
      // even if cleanup fails, no user data has been moved or destroyed.
      await this.cleanupPreparedMarker(markerPath, markerContents);
      throw error;
    }
    return quarantineName;
  }

  /** Lists validated quarantine identities without reading/hash-walking user files. */
  async listQuarantineMetadata(): Promise<QuarantineEntryMetadata[]> {
    const children = await readdir(this.quarantineRoot, { withFileTypes: true });
    const entries: QuarantineEntryMetadata[] = [];
    for (const child of children) {
      if (child.isSymbolicLink() || !child.isDirectory()) {
        throw new HomeLifecycleError("unsafe_path", "Workspace quarantine contains an unsafe entry.");
      }
      const quarantineId = child.name;
      const root = join(this.quarantineRoot, quarantineId);
      const markerPath = join(root, ".openbot", "quarantine.json");
      let marker: unknown;
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
      } catch {
        throw new HomeLifecycleError("integrity_error", `Quarantine marker is invalid: ${quarantineId}.`);
      }
      if (
        typeof marker !== "object" || marker === null ||
        typeof (marker as { agentId?: unknown }).agentId !== "string" ||
        typeof (marker as { quarantinedAt?: unknown }).quarantinedAt !== "string" ||
        ((marker as { quarantineId?: unknown }).quarantineId !== undefined && (marker as { quarantineId?: unknown }).quarantineId !== quarantineId)
      ) {
        throw new HomeLifecycleError("integrity_error", `Quarantine marker identity is invalid: ${quarantineId}.`);
      }
      entries.push({
        quarantineId,
        agentId: sanitizeAgentId((marker as { agentId: string }).agentId),
        quarantinedAt: (marker as { quarantinedAt: string }).quarantinedAt,
        root,
      });
    }
    entries.sort((left, right) => right.quarantinedAt.localeCompare(left.quarantinedAt));
    return entries;
  }

  /** Lists quarantine entries with validated metadata and a complete inventory. */
  async listQuarantine(): Promise<QuarantineEntry[]> {
    const entries: QuarantineEntry[] = [];
    for (const metadata of await this.listQuarantineMetadata()) {
      entries.push({ ...metadata, inventory: await inventoryHome(metadata.root, metadata.agentId) });
    }
    return entries;
  }

  /** Restores a quarantined home without replacing an existing active home. */
  async restore(agentId: string, quarantineId?: string): Promise<AgentHome> {
    const id = sanitizeAgentId(agentId);
    const active = join(this.root, id);
    if (await this.exists(active)) throw new HomeLifecycleError("conflict", "An active home already exists for this agent.");
    const candidates = (await this.listQuarantine()).filter((entry) => sameAgentId(entry.agentId, id) && (quarantineId === undefined || entry.quarantineId === quarantineId));
    if (candidates.length === 0) throw new HomeLifecycleError("not_found", "No matching quarantined home exists.");
    if (candidates.length > 1) throw new HomeLifecycleError("conflict", "More than one quarantined home matches this agent; select one explicitly.");
    const candidate = candidates[0]!;
    const manifest = await this.readHomeManifest(candidate.root, id);
    if (!sameAgentId(manifest.agentId, id)) throw new HomeLifecycleError("integrity_error", "Quarantined home belongs to another agent.");
    const quarantineMarkerPath = join(candidate.root, ".openbot", "quarantine.json");
    let markerContents: string;
    try {
      markerContents = await readFile(quarantineMarkerPath, "utf8");
    } catch {
      throw new HomeLifecycleError("integrity_error", "Quarantine marker is missing or unreadable.");
    }
    let moved = false;
    try {
      await rename(candidate.root, active);
      moved = true;
      const activeMarkerPath = join(active, ".openbot", "quarantine.json");
      await this.quarantineMarkerRemover(activeMarkerPath);
      if (await this.exists(activeMarkerPath)) {
        throw new HomeLifecycleError("integrity_error", "Quarantine marker could not be removed.");
      }
      const home = await WorkspaceSandbox.create(active, { allowAncestorLinks: true });
      this.backends.delete(id);
      const acl = await this.applyAcl(id, home.root, "restore");
      this.assertAcl(acl);
      await this.applyWorkspaceAcls("restore");
      return { agentId: id, root: home.root, acl };
    } catch (error) {
      if (!moved && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new HomeLifecycleError("conflict", "An active home already exists for this agent.");
      }
      if (moved) {
        try {
          await rename(active, candidate.root);
          await this.ensureQuarantineMarker(candidate.root, markerContents);
        } catch (rollbackError) {
          throw new HomeLifecycleError(
            "io_error",
            `Failed to rollback quarantined home after restore failure: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      throw error;
    }
  }

  async exportArchive(agentId: string, destination: string, options: ExportHomeArchiveOptions = {}): Promise<{ path: string; manifest: import("./home-archive.js").HomeArchiveManifest }> {
    const id = sanitizeAgentId(agentId);
    const home = await this.ensureExisting(id);
    await this.readHomeManifest(home.root, id);
    try {
      return await exportHomeArchive(home.root, id, destination, options);
    } catch (error) {
      if (error instanceof HomeArchiveError) throw error;
      throw error;
    }
  }

  // ── snapshots (melhoria 3) ─────────────────────────────────────────────

  /** Snapshots live under the workspaces root, outside every agent home, so they never count against a bot quota. */
  private get snapshotsRoot(): string {
    return join(this.root, ".snapshots");
  }

  private snapshotDirectory(agentId: string): string {
    return join(this.snapshotsRoot, sanitizeAgentId(agentId));
  }

  /** Captures a streamed v2 archive under snapshots/<id>/<seq>.obhome. */
  async snapshot(agentId: string): Promise<{ seq: number; path: string; manifest: import("./home-archive.js").HomeArchiveManifest }> {
    const id = sanitizeAgentId(agentId);
    const home = await this.ensureExisting(id);
    await this.readHomeManifest(home.root, id);
    const directory = this.snapshotDirectory(id);
    await mkdir(directory, { recursive: true });
    const seq = await this.nextSnapshotSeq(directory);
    const { path, manifest } = await exportHomeArchive(home.root, id, join(directory, `${seq}.obhome`));
    await this.pruneSnapshots(id);
    return { seq, path, manifest };
  }

  async listSnapshots(agentId: string): Promise<Array<{ seq: number; exportedAt: string; totalBytes: number; entryCount: number; path: string }>> {
    const id = sanitizeAgentId(agentId);
    const directory = this.snapshotDirectory(id);
    const snapshots: Array<{ seq: number; exportedAt: string; totalBytes: number; entryCount: number; path: string }> = [];
    for (const name of (await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    })).sort((left, right) => this.snapshotSeq(left) - this.snapshotSeq(right))) {
      if (!Number.isSafeInteger(this.snapshotSeq(name))) continue;
      const path = join(directory, name);
      try {
        const manifest = await readHomeArchiveSummary(path, id);
        snapshots.push({ seq: this.snapshotSeq(name), exportedAt: manifest.exportedAt, totalBytes: manifest.totalBytes, entryCount: manifest.entryCount, path });
      } catch {
        // Unreadable snapshot: skip instead of failing the listing.
      }
    }
    return snapshots;
  }

  /**
   * Restores a snapshot atomically: the active home is quarantined first and
   * rolled back when the import fails, so the bot never ends up homeless.
   */
  async restoreSnapshot(agentId: string, seq: number): Promise<AgentHome> {
    const id = sanitizeAgentId(agentId);
    if (!Number.isSafeInteger(seq) || seq < 1) throw new HomeLifecycleError("not_found", "Snapshot does not exist.");
    const matches = [];
    for (const extension of ["obhome", "json"]) {
      const path = join(this.snapshotDirectory(id), `${seq}.${extension}`);
      if (await this.exists(path)) matches.push(path);
    }
    if (matches.length > 1) throw new HomeLifecycleError("conflict", "More than one snapshot has this sequence.");
    const snapshotPath = matches[0];
    if (snapshotPath === undefined) throw new HomeLifecycleError("not_found", "Snapshot does not exist.");
    const snapshotMetadata = await lstat(snapshotPath).catch((error: unknown) => {
      if (isMissing(error)) throw new HomeLifecycleError("not_found", "Snapshot does not exist.");
      throw error;
    });
    if (snapshotMetadata.isSymbolicLink() || !snapshotMetadata.isFile()) {
      throw new HomeLifecycleError("unsafe_path", "Snapshot is unsafe.");
    }
    // Reject corruption before moving the active home. Import rechecks while staging.
    await validateHomeArchive(snapshotPath, id);
    let quarantineName: string | undefined;
    if (await this.exists(join(this.root, id))) {
      quarantineName = await this.moveToQuarantine(id, true);
    }
    try {
      return await this.importArchive(id, snapshotPath, { preserveGrants: true });
    } catch (error) {
      if (quarantineName !== undefined) {
        try {
          await this.restore(id, quarantineName);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Failed to restore the snapshot; the previous home was rolled back.", { cause: rollbackError });
        }
      }
      throw error;
    }
  }

  private snapshotSeq(name: string): number {
    const match = /^(\d+)\.(?:json|obhome)$/u.exec(name);
    return match === null ? Number.NEGATIVE_INFINITY : Number(match[1]);
  }

  private async nextSnapshotSeq(directory: string): Promise<number> {
    const children = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    let max = 0;
    for (const name of children) {
      const seq = this.snapshotSeq(name);
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
    return max + 1;
  }

  private async pruneSnapshots(agentId: string): Promise<void> {
    const directory = this.snapshotDirectory(agentId);
    const children = (await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    })).filter((name) => Number.isFinite(this.snapshotSeq(name))).sort((left, right) => this.snapshotSeq(right) - this.snapshotSeq(left));
    for (const name of children.slice(AgentHomeStore.MAX_SNAPSHOTS_PER_AGENT)) {
      const target = join(directory, name);
      if (!isWithinRoot(this.snapshotsRoot, target)) {
        throw new HomeLifecycleError("unsafe_path", "Snapshot path is outside the managed snapshots root.");
      }
      await rm(target, { force: true }).catch(() => undefined);
    }
  }

  async importArchive(agentId: string, archivePath: string, options: ImportHomeArchiveOptions & { preserveGrants?: boolean } = {}): Promise<AgentHome> {
    const id = sanitizeAgentId(agentId);
    const target = join(this.root, id);
    if (await this.exists(target)) throw new HomeLifecycleError("conflict", "An active home already exists for this agent.");
    const stage = join(this.stagingRoot, `${id}-${randomUUID()}`);
    let moved = false;
    let primaryFailure: unknown;
    try {
      await stageHomeArchive(resolve(archivePath), id, stage, options);
      await this.validateCompleteHome(stage, id);
      if (options.preserveGrants !== true) {
        // Grants are consent, not content: an archive from outside the managed
        // snapshots root must not arrive carrying pre-approved access to the
        // user's real folders. Reseed empty so the imported home starts with
        // no grants and the user grants explicitly on this machine.
        await writeSharedGrants(stage, emptyGrants());
      }
      if (await this.exists(target)) throw new HomeLifecycleError("conflict", "An active home already exists for this agent.");
      try {
        await rename(stage, target);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HomeLifecycleError("conflict", "An active home already exists for this agent.");
        throw error;
      }
      const home = await WorkspaceSandbox.create(target, { allowAncestorLinks: true });
      this.backends.delete(id);
      const acl = await this.applyAcl(id, home.root, "import");
      this.assertAcl(acl);
      await this.applyWorkspaceAcls("import");
      return { agentId: id, root: home.root, acl };
    } catch (error) {
      primaryFailure = error;
      if (moved) {
        try {
          await rename(target, stage);
        } catch (rollbackError) {
          primaryFailure = new AggregateError([error, rollbackError], "Failed to rollback imported home after lifecycle failure.");
          throw primaryFailure;
        }
      }
      throw error;
    } finally {
      try {
        if (!isWithinRoot(this.stagingRoot, stage)) {
          throw new HomeLifecycleError("unsafe_path", "Staging path is outside the managed staging root.");
        }
        await this.stageDiscarder(stage);
      } catch (cleanupError) {
        if (primaryFailure !== undefined) {
          throw new AggregateError([primaryFailure, cleanupError], "Failed to import home and discard staged archive.", { cause: cleanupError });
        }
        throw cleanupError;
      }
    }
  }

  async inventory(agentId: string): Promise<HomeInventory>;
  async inventory(): Promise<HomeInventory[]>;
  async inventory(agentId?: string): Promise<HomeInventory | HomeInventory[]> {
    if (agentId !== undefined) {
      const id = sanitizeAgentId(agentId);
      const home = await this.ensureExisting(id);
      return inventoryHome(home.root, id);
    }
    const children = await readdir(this.root, { withFileTypes: true });
    const homes: HomeInventory[] = [];
    for (const child of children) {
      if (child.isSymbolicLink()) throw new HomeLifecycleError("unsafe_path", "Workspace root contains an unsafe entry.");
      if (child.name === ".quarantine" || child.name === ".staging" || child.name === ".snapshots") {
        if (!child.isDirectory()) throw new HomeLifecycleError("unsafe_path", "Workspace lifecycle directory is unsafe.");
        continue;
      }
      if (!child.isDirectory()) throw new HomeLifecycleError("unsafe_path", "Workspace root contains an unsafe entry.");
      const id = sanitizeAgentId(child.name);
      homes.push(await inventoryHome(join(this.root, id), id));
    }
    return homes.sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  /** Repairs only missing canonical layout pieces; corrupt identity fails closed. */
  async repair(agentId: string): Promise<HomeRepairResult> {
    const id = sanitizeAgentId(agentId);
    const target = join(this.root, id);
    if (!(await this.exists(target))) {
      const created = await this.ensure(id);
      const current = await inventoryHome(created.root, id);
      return { agentId: id, repaired: true, actions: ["created-home"], inventory: current, acl: created.acl ?? await this.applyAcl(id, created.root, "repair") };
    }
    const sandbox = await WorkspaceSandbox.create(target, { allowAncestorLinks: true });
    const manifest = await this.readHomeManifest(sandbox.root, id);
    if (!sameAgentId(manifest.agentId, id)) throw new HomeLifecycleError("integrity_error", "Home manifest identity does not match the requested agent.");
    const actions: string[] = [];
    const migrated = await this.migrateLayout(sandbox, id, manifest);
    if (migrated.layoutVersion !== manifest.layoutVersion) actions.push(`migrated-layout-v${manifest.layoutVersion}-v${migrated.layoutVersion}`);
    for (const name of HOME_DIRECTORIES) {
      const destination = await sandbox.resolveDestination(name);
      let existed = true;
      try {
        const existing = await lstat(destination);
        if (existing.isSymbolicLink()) throw new HomeLifecycleError("unsafe_path", `Home directory ${name} is unsafe.`);
      } catch (error) {
        if (!isMissing(error)) throw error;
        existed = false;
      }
      try {
        await mkdir(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await sandbox.resolveExisting(name);
      const repairedMetadata = await lstat(destination);
      if (!repairedMetadata.isDirectory()) throw new HomeLifecycleError("integrity_error", `Home directory ${name} is not a directory.`);
      if (!existed) actions.push(`created-${name}`);
    }
    const welcomeCreated = await this.writeWelcome(sandbox);
    if (welcomeCreated) actions.push("created-welcome");
    // Refresh the usage baseline as part of a repair (best-effort).
    try {
      await writeUsageBaseline(sandbox.root, await calculateVisibleUsage(sandbox.root));
      actions.push("refreshed-usage-baseline");
    } catch {
      // Baseline refresh is observational.
    }
    const acl = await this.applyAcl(id, sandbox.root, "repair");
    this.assertAcl(acl);
    await this.applyWorkspaceAcls("repair");
    return { agentId: id, repaired: actions.length > 0, actions, inventory: await inventoryHome(sandbox.root, id), acl };
  }

  async backendFor(agentId: string): Promise<HomeWorkspaceBackend> {
    const id = sanitizeAgentId(agentId);
    const cached = this.backends.get(id);
    if (cached) return cached;
    const pending = this.ensure(id).then((home) => HomeWorkspaceBackend.create(home.root));
    this.backends.set(id, pending);
    try {
      return await pending;
    } catch (error) {
      this.backends.delete(id);
      throw error;
    }
  }

  // ── uso e drift (melhoria 6) ───────────────────────────────────────────

  /**
   * Full-usage audit for one bot: compares the persisted baseline with the
   * current disk usage, refreshes the baseline and reports drift. Drift is
   * a signal, never a blocker.
   */
  async auditUsage(agentId: string): Promise<DriftReport> {
    const id = sanitizeAgentId(agentId);
    const home = await this.ensureExisting(id);
    const baseline = await readUsageBaseline(home.root);
    const current = await calculateVisibleUsage(home.root);
    await writeUsageBaseline(home.root, current);
    return detectDrift(baseline, current);
  }

  /** Read-only drift check; does not refresh the baseline. */
  async driftReport(agentId: string): Promise<DriftReport> {
    const id = sanitizeAgentId(agentId);
    const home = await this.ensureExisting(id);
    return detectDrift(await readUsageBaseline(home.root), await calculateVisibleUsage(home.root));
  }

  private async ensureExisting(agentId: string): Promise<AgentHome> {
    const source = join(this.root, sanitizeAgentId(agentId));
    let metadata;
    try {
      metadata = await lstat(source);
    } catch (error) {
      if (isMissing(error)) throw new HomeLifecycleError("not_found", "Agent home does not exist.");
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new HomeLifecycleError("unsafe_path", "Agent home is unsafe.");
    const sandbox = await WorkspaceSandbox.create(source, { allowAncestorLinks: true });
    return { agentId, root: sandbox.root };
  }

  private async writeWelcome(sandbox: WorkspaceSandbox): Promise<boolean> {
    let created = false;
    for (const relative of ["Desktop/Bem-vindo.md", "Projects/Bem-vindo.md"]) {
      const welcome = await sandbox.resolveDestination(relative);
      try {
        await writeFileExclusive(welcome, WELCOME);
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return created;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private async cleanupPreparedMarker(path: string, expected: string): Promise<void> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return;
      return;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) return;
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === expected) await unlink(path).catch(() => undefined);
  }

  private async ensureQuarantineMarker(root: string, contents: string): Promise<void> {
    const path = join(root, ".openbot", "quarantine.json");
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new HomeLifecycleError("unsafe_path", "Quarantine marker is not a regular file.");
      }
      if (await readFile(path, "utf8") !== contents) {
        throw new HomeLifecycleError("integrity_error", "Quarantine marker contents are invalid.");
      }
      return;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await atomicCreateFile(path, contents);
  }

  private async applyAcl(agentId: string, root: string, operation: HomeAclContext["operation"]): Promise<HomeAclResult> {
    try {
      return await this.acl.apply(root, { agentId, operation });
    } catch (error) {
      // Best effort must be observable but never replaced by a permissive ACL.
      return {
        status: "failed",
        platform: process.platform,
        message: error instanceof Error ? error.message : "ACL helper failed.",
      };
    }
  }

  private async applyWorkspaceAcls(operation: HomeAclContext["operation"]): Promise<void> {
    const pending = (workspaceAclQueues.get(this.workspaceAclQueueKey) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runWorkspaceAclPass(operation));
    const tail = pending.catch(() => undefined);
    workspaceAclQueues.set(this.workspaceAclQueueKey, tail);
    void tail.finally(() => {
      if (workspaceAclQueues.get(this.workspaceAclQueueKey) === tail) {
        workspaceAclQueues.delete(this.workspaceAclQueueKey);
      }
    });
    return pending;
  }

  private async runWorkspaceAclPass(operation: HomeAclContext["operation"]): Promise<void> {
    let failure: unknown;
    for (const target of [this.root, this.quarantineRoot, this.stagingRoot, this.snapshotsRoot]) {
      const result = await this.applyAcl("workspace", target, operation);
      try {
        this.assertAcl(result);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  private assertAcl(result: HomeAclResult): void {
    if (result.platform === "win32" && result.status === "failed") {
      throw new HomeLifecycleError("access_denied", `Windows ACL bootstrap failed: ${result.message ?? "ACL could not be verified."}`);
    }
  }

  private async readHomeManifest(root: string, agentId: string): Promise<AgentHomeManifest> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(root, ".openbot", "home.json"), "utf8")) as unknown;
    } catch {
      throw new HomeLifecycleError("integrity_error", "Home manifest is missing or corrupt.");
    }
    if (
      typeof value !== "object" || value === null ||
      typeof (value as { agentId?: unknown }).agentId !== "string" ||
      typeof (value as { createdAt?: unknown }).createdAt !== "string" ||
      typeof (value as { layoutVersion?: unknown }).layoutVersion !== "number" ||
      !sameAgentId((value as { agentId: string }).agentId, agentId)
    ) throw new HomeLifecycleError("integrity_error", "Home manifest identity is invalid.");
    const manifest = value as AgentHomeManifest;
    this.validateManifestLayout(manifest);
    return manifest;
  }

  private validateManifestLayout(manifest: AgentHomeManifest): void {
    if (
      !Number.isSafeInteger(manifest.layoutVersion) ||
      manifest.layoutVersion < MIN_HOME_LAYOUT_VERSION ||
      manifest.layoutVersion > HOME_LAYOUT_VERSION
    ) {
      throw new HomeLifecycleError("integrity_error", "Home manifest layout version is unsupported.");
    }
  }

  /**
   * Brings a home manifest up to HOME_LAYOUT_VERSION with additive,
   * idempotent steps. Never deletes user content; the manifest write is
   * atomic (tmp + rename) so a crash leaves the previous version readable.
   */
  private async migrateLayout(sandbox: WorkspaceSandbox, agentId: string, manifest: AgentHomeManifest): Promise<AgentHomeManifest> {
    if (manifest.layoutVersion === HOME_LAYOUT_VERSION) return manifest;
    const working: AgentHomeManifest = { ...manifest };
    const log = [...(manifest.migrationLog ?? [])];
    while (working.layoutVersion < HOME_LAYOUT_VERSION) {
      const step = LAYOUT_MIGRATIONS.find((candidate) => candidate.from === working.layoutVersion);
      if (!step) {
        throw new HomeLifecycleError("integrity_error", `No layout migration exists from version ${working.layoutVersion}.`);
      }
      const entry = await step.apply(sandbox, agentId, working);
      working.layoutVersion = step.from + 1;
      log.push(`${new Date().toISOString()} ${entry}`);
    }
    working.migratedAt = new Date().toISOString();
    working.migrationLog = log;
    const manifestPath = await sandbox.resolveDestination(".openbot/home.json");
    await atomicReplaceFile(manifestPath, `${JSON.stringify(working, null, 2)}\n`);
    return working;
  }

  private async validateCompleteHome(root: string, agentId: string): Promise<void> {
    await this.readHomeManifest(root, agentId);
    const sandbox = await WorkspaceSandbox.create(root, { allowAncestorLinks: true });
    for (const name of HOME_DIRECTORIES) {
      const path = await sandbox.resolveExisting(name);
      const metadata = await lstat(path);
      if (!metadata.isDirectory()) throw new HomeLifecycleError("integrity_error", `Imported home is missing directory ${name}.`);
    }
  }
}
