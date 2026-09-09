# Agent Home Workspace Implementation Plan

> **Uso deste plano:** consulte apenas as etapas pertinentes ao pedido vigente. Procedimentos, comandos e checkboxes registram o planejamento desta revisão; não autorizam execução, delegação, commit ou deploy. Siga o AGENTS.md atual e verifique o estado implementado antes de retomar.

**Goal:** Cada agente ganha uma home NTFS privada criada no boot, com tools de arquivo/busca ligadas por padrão, sem wizard e sem VM.

**Architecture:** `AgentHomeStore` semeia `%LOCALAPPDATA%\OpenBot\workspaces\<agentId>\`. `HomeWorkspaceBackend` compõe file+search no mesmo `WorkspaceSandbox`. O broker aceita um backend por `agentId`. `startServer` faz `ensure("openbot-default")` antes do listen e injeta broker + `SAFE_HOME_TOOLS`. `ensureForeverBox` só materializa a pasta. Contrato VNC permanece `{ vncUrl: null, windows: [] }`.

**Tech Stack:** TypeScript, Node.js `fs/promises`, `WorkspaceSandbox` existente, Vitest. Sem dependência nova.

**Spec:** [`../specs/2026-08-13-agent-home-workspace-design.md`](../specs/2026-08-13-agent-home-workspace-design.md)

---

## File map

| File | Role |
|---|---|
| Create `src/execution/home.ts` | root default, sanitize, seed, `AgentHomeStore` |
| Create `src/execution/home-backend.ts` | composite `ExecutionBackend` |
| Create `src/execution/home-tools.ts` | schemas seguros + prompt da home |
| Create `test/execution-home.test.ts` | seed, idempotência, sanitize, isolamento |
| Create `test/execution-home-backend.test.ts` | file+search no mesmo root; escape |
| Create `test/execution-home-bootstrap.test.ts` | boot default cria home e executa write |
| Modify `src/execution/broker.ts` | resolver `(agentId) => backend` |
| Modify `src/execution/commands.ts` | `fromWorkspace` |
| Modify `src/execution/files.ts` | `fromWorkspace` (simetria) |
| Modify `src/rpc/roster.ts` | export `DEFAULT_AGENT_ID`; `ensureForeverBox` chama store |
| Modify `src/rpc/index.ts` | passa `homes` ao roster |
| Modify `src/main.ts` | liga home no caminho padrão |
| Modify testes que chamam `startServer` | `workspacesRoot` temporário |
| Modify `scripts/smoke-local.mjs` | `workspacesRoot` no dir de smoke |
| Modify `README.md` e `docs/phase-2-local-execution-progress.md` | estado atual |

---

### Task 1: AgentHomeStore — path, sanitize, seed idempotente

**Files:**
- Create: `src/execution/home.ts`
- Create: `test/execution-home.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore, defaultWorkspacesRoot, sanitizeAgentId } from "../src/execution/home.js";

const roots: string[] = [];
const temp = async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-home-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("sanitizeAgentId", () => {
  it("accepts the default roster id", () => {
    expect(sanitizeAgentId("openbot-default")).toBe("openbot-default");
  });

  it.each(["", "..", "foo/bar", "foo\\bar", "CON", "COM1", "a".repeat(64), " has space", ".hidden"])(
    "rejects %s",
    (id) => {
      expect(() => sanitizeAgentId(id)).toThrow(/invalid/i);
    },
  );
});

describe("AgentHomeStore", () => {
  it("seeds layout once and keeps user files on the second ensure", async () => {
    const store = await AgentHomeStore.create(await temp());
    const first = await store.ensure("openbot-default");
    const note = join(first.root, "Documents", "nota.md");
    await writeFile(note, "keep-me");
    const welcome = join(first.root, "Desktop", "Bem-vindo.md");
    const originalWelcome = await readFile(welcome, "utf8");
    await writeFile(welcome, "user-edited");

    const second = await store.ensure("openbot-default");
    expect(second.root).toBe(first.root);
    await expect(readFile(note, "utf8")).resolves.toBe("keep-me");
    await expect(readFile(welcome, "utf8")).resolves.toBe("user-edited");
    const manifest = JSON.parse(await readFile(join(first.root, ".openbot", "home.json"), "utf8")) as {
      agentId: string;
      layoutVersion: number;
      createdAt: string;
    };
    expect(manifest).toMatchObject({ agentId: "openbot-default", layoutVersion: 1 });
    expect(manifest.createdAt.length).toBeGreaterThan(0);
    expect(originalWelcome.length).toBeGreaterThan(0);
    for (const name of ["Desktop", "Documents", "Downloads", "Projects", ".openbot"]) {
      expect((await stat(join(first.root, name))).isDirectory()).toBe(true);
    }
  });

  it("isolates two agent ids and refuses a stolen folder", async () => {
    const store = await AgentHomeStore.create(await temp());
    const a = await store.ensure("agent-a");
    const b = await store.ensure("agent-b");
    expect(a.root).not.toBe(b.root);
    await writeFile(join(a.root, "Documents", "secret.txt"), "only-a");
    await expect(stat(join(b.root, "Documents", "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const stolen = await AgentHomeStore.create(await temp());
    await stolen.ensure("agent-a");
    await writeFile(join(stolen.pathFor("agent-a"), ".openbot", "home.json"), JSON.stringify({
      agentId: "agent-b",
      createdAt: "2026-01-01T00:00:00.000Z",
      layoutVersion: 1,
    }));
    await expect(stolen.ensure("agent-a")).rejects.toThrow(/reutil/i);
  });

  it("recreates missing layout dirs and rejects corrupt home.json", async () => {
    const store = await AgentHomeStore.create(await temp());
    const home = await store.ensure("openbot-default");
    await rm(join(home.root, "Documents"), { recursive: true, force: true });
    await store.ensure("openbot-default");
    expect((await stat(join(home.root, "Documents"))).isDirectory()).toBe(true);

    await writeFile(join(home.root, ".openbot", "home.json"), "{not-json");
    await expect(store.ensure("openbot-default")).rejects.toThrow(/corromp/i);
  });

  it("refuses a workspaces root that is a symbolic link", async () => {
    const parent = await temp();
    const real = await temp();
    const linked = join(parent, "linked");
    await symlink(real, linked, "junction");
    await expect(AgentHomeStore.create(linked)).rejects.toMatchObject({ code: "outside_workspace" });
  });

  it("defaultWorkspacesRoot lives under Local AppData", () => {
    const expected = process.env.LOCALAPPDATA
      ?? join(process.env.USERPROFILE ?? "", "AppData", "Local");
    expect(defaultWorkspacesRoot()).toBe(join(expected, "OpenBot", "workspaces"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/execution-home.test.ts`

Expected: FAIL — `Cannot find module '../src/execution/home.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/execution/home.ts` (sem `backendFor` — isso entra na Task 2):

```ts
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { WorkspaceError, WorkspaceSandbox } from "./workspace.js";

export const HOME_LAYOUT_VERSION = 1;
export const HOME_DIRECTORIES = ["Desktop", "Documents", "Downloads", "Projects", ".openbot"] as const;

export interface AgentHome {
  agentId: string;
  root: string;
}

export interface AgentHomeManifest {
  agentId: string;
  createdAt: string;
  layoutVersion: number;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
const WELCOME = [
  "# Computador do OpenBot",
  "",
  "Esta pasta é o disco deste agente. Arquivos que ele criar ficam aqui.",
  "Pastas: Desktop, Documents, Downloads, Projects.",
  "",
].join("\n");

export function defaultWorkspacesRoot(): string {
  const local = process.env.LOCALAPPDATA;
  const base = local && local.length > 0 ? local : join(homedir(), "AppData", "Local");
  return join(base, "OpenBot", "workspaces");
}

export function sanitizeAgentId(agentId: string): string {
  if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
    throw new WorkspaceError("invalid_path", "Agent id is invalid.");
  }
  const stem = agentId.split(".", 1)[0] ?? "";
  if (RESERVED.test(stem)) throw new WorkspaceError("invalid_path", "Agent id is invalid.");
  return agentId;
}

export class AgentHomeStore {
  private constructor(readonly root: string) {}

  static async create(root = defaultWorkspacesRoot()): Promise<AgentHomeStore> {
    await mkdir(root, { recursive: true });
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceError("outside_workspace", "Workspace root contains a symbolic link or junction.");
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceError("invalid_path", "Workspace root is not a directory.");
    }
    return new AgentHomeStore(root);
  }

  pathFor(agentId: string): string {
    return join(this.root, sanitizeAgentId(agentId));
  }

  async ensure(agentId: string): Promise<AgentHome> {
    const id = sanitizeAgentId(agentId);
    const homeRoot = join(this.root, id);
    await mkdir(homeRoot, { recursive: true });
    const sandbox = await WorkspaceSandbox.create(homeRoot, { allowAncestorLinks: true });
    for (const name of HOME_DIRECTORIES) {
      await mkdir(join(sandbox.root, name), { recursive: true });
    }
    const manifestPath = join(sandbox.root, ".openbot", "home.json");
    let existing: string | undefined;
    try {
      existing = await readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
      if (manifest.agentId !== id) throw new Error("pasta de workspace reutilizada por outro agente");
    } else {
      const manifest: AgentHomeManifest = {
        agentId: id,
        createdAt: new Date().toISOString(),
        layoutVersion: HOME_LAYOUT_VERSION,
      };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    }
    const welcome = join(sandbox.root, "Desktop", "Bem-vindo.md");
    await writeFile(welcome, WELCOME, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return { agentId: id, root: sandbox.root };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run test/execution-home.test.ts`

Expected: PASS. If the stolen-folder assertion language does not match, keep the Portuguese `reutil` in the thrown `Error` message.

- [ ] **Step 5: Commit**

```bash
git add src/execution/home.ts test/execution-home.test.ts
git commit -m "feat(execution): seed an idempotent Windows home per agent id"
```

---

### Task 2: Composite backend + fromWorkspace

**Files:**
- Create: `src/execution/home-backend.ts`
- Create: `test/execution-home-backend.test.ts`
- Modify: `src/execution/files.ts` — add `static fromWorkspace(workspace: WorkspaceSandbox)`
- Modify: `src/execution/commands.ts` — add `static fromWorkspace(workspace: WorkspaceSandbox)`
- Modify: `src/execution/home.ts` — add `backendFor`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHomeStore } from "../src/execution/home.js";
import { HomeWorkspaceBackend } from "../src/execution/home-backend.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("HomeWorkspaceBackend", () => {
  it("writes and searches inside one home and refuses escape", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openbot-home-be-"));
    roots.push(parent);
    const store = await AgentHomeStore.create(parent);
    const home = await store.ensure("agent-a");
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "untouched");

    const backend = await HomeWorkspaceBackend.create(home.root);
    const written = await backend.execute({
      operation: "file.write",
      path: "Documents/nota.md",
      content: "needle",
      encoding: "utf8",
    });
    expect(written).toMatchObject({ ok: true });
    await expect(readFile(join(home.root, "Documents", "nota.md"), "utf8")).resolves.toBe("needle");

    const found = await backend.execute({
      operation: "command.run",
      command: "search.text",
      cwd: ".",
      params: { pattern: "needle", mode: "fixed", paths: ["Documents"] },
    });
    expect(found).toMatchObject({ ok: true });
    if (found.ok && found.operation === "command.run") {
      expect(found.stdout).toContain("Documents/nota.md");
    }

    await expect(backend.execute({
      operation: "file.write",
      path: "..\\outside.txt",
      content: "pwned",
      encoding: "utf8",
    })).resolves.toMatchObject({ ok: false, code: "outside_workspace" });
    await expect(readFile(outside, "utf8")).resolves.toBe("untouched");
  });

  it("backendFor caches per agent and does not leak files", async () => {
    const store = await AgentHomeStore.create(await mkdtemp(join(tmpdir(), "openbot-home-cache-")).then((d) => (roots.push(d), d)));
    const a = await store.backendFor("agent-a");
    const b = await store.backendFor("agent-b");
    expect(a).not.toBe(b);
    expect(await store.backendFor("agent-a")).toBe(a);
    await a.execute({ operation: "file.write", path: "Documents/a.txt", content: "aaa", encoding: "utf8" });
    const listed = await b.execute({ operation: "file.list", path: "Documents" });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok && listed.operation === "file.list") {
      expect(listed.entries.map((entry) => entry.name)).not.toContain("a.txt");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/execution-home-backend.test.ts`

Expected: FAIL — missing `home-backend` module.

- [ ] **Step 3: Write minimal implementation**

In `files.ts`, next to the existing constructor:

```ts
static fromWorkspace(workspace: WorkspaceSandbox): LocalFileExecutor {
  return new LocalFileExecutor(workspace);
}
```

Keep `create(root)` as `fromWorkspace(await WorkspaceSandbox.create(root))`.

In `commands.ts`, make the constructor usable from `fromWorkspace`:

```ts
static fromWorkspace(workspace: WorkspaceSandbox): LocalCommandExecutor {
  return new LocalCommandExecutor(workspace);
}
```

`create(root)` becomes `fromWorkspace(await WorkspaceSandbox.create(root))`. Constructor stays `private`.

Create `src/execution/home-backend.ts`:

```ts
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "./contracts.js";
import { LocalCommandExecutor } from "./commands.js";
import { LocalFileExecutor } from "./files.js";
import { WorkspaceSandbox } from "./workspace.js";

export class HomeWorkspaceBackend implements ExecutionBackend {
  private constructor(
    readonly workspace: WorkspaceSandbox,
    private readonly files: LocalFileExecutor,
    private readonly commands: LocalCommandExecutor,
  ) {}

  static async create(root: string): Promise<HomeWorkspaceBackend> {
    const workspace = await WorkspaceSandbox.create(root);
    return new HomeWorkspaceBackend(
      workspace,
      LocalFileExecutor.fromWorkspace(workspace),
      LocalCommandExecutor.fromWorkspace(workspace),
    );
  }

  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    if (request.operation === "command.run") return this.commands.execute(request, signal);
    return this.files.execute(request, signal);
  }
}
```

Add to `AgentHomeStore` in `home.ts` (no dynamic import):

```ts
import { HomeWorkspaceBackend } from "./home-backend.js";

private readonly backends = new Map<string, HomeWorkspaceBackend>();

async backendFor(agentId: string): Promise<HomeWorkspaceBackend> {
  const cached = this.backends.get(agentId);
  if (cached) return cached;
  const home = await this.ensure(agentId);
  const backend = await HomeWorkspaceBackend.create(home.root);
  this.backends.set(agentId, backend);
  return backend;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --run test/execution-home.test.ts test/execution-home-backend.test.ts test/execution-files.test.ts test/execution-commands.test.ts`

Expected: PASS (existing file/search tests still use `.create(root)`).

- [ ] **Step 5: Commit**

```bash
git add src/execution/home.ts src/execution/home-backend.ts src/execution/files.ts src/execution/commands.ts test/execution-home-backend.test.ts
git commit -m "feat(execution): compose file and search on one agent home"
```

---

### Task 3: Broker resolves backend by agentId

**Files:**
- Modify: `src/execution/broker.ts`
- Modify: `test/execution-approval.test.ts` — keep existing cases; add one factory case

- [ ] **Step 1: Write the failing factory test** (append to `test/execution-approval.test.ts`)

```ts
it("resolve um backend por agentId quando o construtor recebe fábrica", async () => {
  const seen: string[] = [];
  const backends = new Map<string, FakeBackend>();
  const broker = new LocalExecutionBroker(
    (agentId) => {
      seen.push(agentId);
      const existing = backends.get(agentId);
      if (existing) return existing;
      const next = new FakeBackend();
      backends.set(agentId, next);
      return next;
    },
    () => "always",
    () => {},
  );
  await broker.execute("agent-a", "r1", request);
  await broker.execute("agent-b", "r2", request);
  expect(seen).toEqual(["agent-a", "agent-b"]);
  expect(backends.get("agent-a")?.calls).toBe(1);
  expect(backends.get("agent-b")?.calls).toBe(1);
});
```

- [ ] **Step 2: Run the new test**

Run: `npm test -- --run test/execution-approval.test.ts`

Expected: FAIL — constructor still types `backend` as `ExecutionBackend` only (or factory is ignored).

- [ ] **Step 3: Write minimal implementation**

Replace the backend field in `src/execution/broker.ts`:

```ts
export type ExecutionBackendSource =
  | ExecutionBackend
  | ((agentId: string) => ExecutionBackend | Promise<ExecutionBackend>);

export class LocalExecutionBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private closed = false;

  constructor(
    private readonly backend: ExecutionBackendSource,
    private readonly permission: () => LocalToolPermission,
    private readonly onApprovalRequired: (approval: ExecutionApprovalRequest) => void,
  ) {}

  private resolveBackend(agentId: string): Promise<ExecutionBackend> {
    return Promise.resolve(typeof this.backend === "function" ? this.backend(agentId) : this.backend);
  }
```

In `execute`, when policy is `always`:

```ts
if (policy === "always") {
  return this.resolveBackend(agentId).then((backend) => backend.execute(request, signal));
}
```

In `resolve`, on `allow`:

```ts
void this.resolveBackend(item.approval.agentId)
  .then((backend) => backend.execute(item.approval.request, item.signal))
  .then(item.resolve, () => item.resolve({
    ok: false,
    operation: item.approval.request.operation,
    code: "io_error",
    message: "Execution backend failed.",
  }));
```

Do not change `permission` signature. Home uses `() => "always"`.

Add at the bottom of `broker.ts` (duck type — sem import de `home.ts`):

```ts
export function createAgentHomeBroker(store: {
  backendFor(agentId: string): Promise<ExecutionBackend>;
}): LocalExecutionBroker {
  return new LocalExecutionBroker((agentId) => store.backendFor(agentId), () => "always", () => {});
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- --run test/execution-approval.test.ts test/rpc-send-tools.test.ts test/local-exec-gateway.integration.test.ts`

Expected: PASS. Existing `new LocalExecutionBroker(backend, ...)` still type-checks.

- [ ] **Step 5: Commit**

```bash
git add src/execution/broker.ts test/execution-approval.test.ts
git commit -m "feat(execution): route local tools to a per-agent backend"
```

---

### Task 4: Schemas seguros e prompt da home

**Files:**
- Create: `src/execution/home-tools.ts`
- Create: `test/execution-home-tools.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { HOME_SYSTEM_PROMPT, SAFE_HOME_TOOLS } from "../src/execution/home-tools.js";

describe("SAFE_HOME_TOOLS", () => {
  it("publishes file/search only, without shell or delete", () => {
    const names = SAFE_HOME_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual(["file", "search_files", "search_text"]);
    expect(JSON.stringify(SAFE_HOME_TOOLS)).not.toMatch(/shell|"delete"/);
    const file = SAFE_HOME_TOOLS[0];
    expect(file?.type).toBe("function");
    expect(file?.function.parameters).toMatchObject({
      type: "object",
      required: ["op", "path"],
    });
  });

  it("tells the model the home is already there, without an absolute path", () => {
    expect(HOME_SYSTEM_PROMPT).toMatch(/Desktop/);
    expect(HOME_SYSTEM_PROMPT).toMatch(/Documents/);
    expect(HOME_SYSTEM_PROMPT).not.toMatch(/[A-Za-z]:\\/);
    expect(HOME_SYSTEM_PROMPT).not.toMatch(/LOCALAPPDATA/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run test/execution-home-tools.test.ts`

Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Create `src/execution/home-tools.ts`:

```ts
import type { ProviderTool } from "../providers/router.js";

export const HOME_SYSTEM_PROMPT =
  "You have a private computer: a Windows folder home. All file paths are relative " +
  "to that home. Desktop, Documents, Downloads, and Projects already exist. You cannot " +
  "see the user's other disks. Use the file, search_files, and search_text tools. " +
  "Do not ask the user to pick a folder.";

export const SAFE_HOME_TOOLS: ProviderTool[] = [
  {
    type: "function",
    function: {
      name: "file",
      description:
        "Read, write, or list files in your private home. Paths are relative " +
        "(for example Documents/note.md). Desktop, Documents, Downloads, and Projects exist. " +
        "Never ask the user to choose a folder.",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "read", "write"] },
          path: { type: "string" },
          content: { type: "string" },
          encoding: { type: "string", enum: ["utf8", "base64"] },
        },
        required: ["op", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "List files under relative paths in your home.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Search file contents in your home. mode is fixed or regex.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          mode: { type: "string", enum: ["fixed", "regex"] },
          paths: { type: "array", items: { type: "string" } },
          cwd: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
];
```

- [ ] **Step 4: Run test**

Run: `npm test -- --run test/execution-home-tools.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/home-tools.ts test/execution-home-tools.test.ts
git commit -m "feat(execution): publish home file tools without shell"
```

---

### Task 5: Roster + bootstrap padrão

**Files:**
- Modify: `src/rpc/roster.ts`
- Modify: `src/rpc/index.ts`
- Modify: `src/main.ts`
- Modify: `test/bootstrap.test.ts`
- Modify: `test/gateway.integration.test.ts`
- Modify: `test/rpc-send-gateway.integration.test.ts`
- Modify: `test/keystore-gateway.integration.test.ts`
- Modify: `test/local-exec-gateway.integration.test.ts`
- Create: `test/execution-home-bootstrap.test.ts`
- Modify: `scripts/smoke-local.mjs`

- [ ] **Step 1: Write the failing bootstrap test**

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { createProviderRegistry, type ProviderAdapter, type ProviderChatRequest } from "../src/providers/router.js";
import { DEFAULT_AGENT_ID } from "../src/rpc/roster.js";

const dirs: string[] = [];
const handles: ServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbot-home-boot-"));
  dirs.push(dir);
  return dir;
};

describe("startServer agent home", () => {
  it("creates the default home before listen and writes without asking", async () => {
    const dir = await tempDir();
    const workspacesRoot = join(dir, "workspaces");
    const requests: ProviderChatRequest[] = [];
    const registry = createProviderRegistry();
    const adapter: ProviderAdapter = {
      name: "xai",
      async streamChat(request, emit) {
        requests.push(request);
        if (requests.length === 1) {
          emit({
            type: "tool-call",
            call: {
              id: "w1",
              type: "function",
              function: { name: "file", arguments: JSON.stringify({
                op: "write",
                path: "Documents/nota.md",
                content: "from-boot",
                encoding: "utf8",
              }) },
            },
          });
          return;
        }
        emit({ type: "delta", delta: "gravado" });
      },
    };
    registry.register(adapter);

    const handle = await startServer(0, {
      registry,
      workspacesRoot,
      storePath: join(dir, "store.db"),
      configPath: join(dir, "config.json"),
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);

    expect(handle.executionBroker).toBeDefined();
    expect(handle.homes).toBeDefined();
    const home = await handle.homes!.ensure(DEFAULT_AGENT_ID);
    await handle.runner.sendPrompt({ agentId: DEFAULT_AGENT_ID, prompt: "escreve" });
    await handle.runner.flush(DEFAULT_AGENT_ID);
    await expect(readFile(join(home.root, "Documents", "nota.md"), "utf8")).resolves.toBe("from-boot");
    expect(JSON.stringify(requests[0]?.tools ?? [])).not.toMatch(/shell/);
    expect(requests[0]?.system).toMatch(/private computer/i);
  });

  it("ensureForeverBox is idempotent and getForeverBoxStatus stays frozen", async () => {
    const dir = await tempDir();
    const handle = await startServer(0, {
      workspacesRoot: join(dir, "workspaces"),
      storePath: join(dir, "store.db"),
      configPath: join(dir, "config.json"),
      keystoreDir: join(dir, "keys"),
    });
    handles.push(handle);
    const post = async (method: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json() as Promise<{ ok: boolean; value: unknown }>;
    };
    const first = await post("ensureForeverBox", { agentId: DEFAULT_AGENT_ID });
    const second = await post("ensureForeverBox", { agentId: DEFAULT_AGENT_ID });
    expect(first).toEqual({ ok: true, value: { ok: true } });
    expect(second).toEqual({ ok: true, value: { ok: true } });
    const status = await post("getForeverBoxStatus", {});
    expect(status).toEqual({ ok: true, value: { vncUrl: null, windows: [] } });
  });
});
```

Check the gateway envelope: existing tests expect `{ ok: true, value: ... }`. If `ensureForeverBox` is registered as a raw handler returning `{ ok: true }`, the HTTP body is `{ ok: true, value: { ok: true } }`. Match that.

- [ ] **Step 2: Run the new test**

Run: `npm test -- --run test/execution-home-bootstrap.test.ts`

Expected: FAIL — `workspacesRoot` / `homes` / `DEFAULT_AGENT_ID` export missing.

- [ ] **Step 3: Wire roster and bootstrap**

`src/rpc/roster.ts`:

```ts
export const DEFAULT_AGENT_ID = "openbot-default";
```

Replace the private `AGENT_ID` with `DEFAULT_AGENT_ID`.

Change signature:

```ts
import type { AgentHomeStore } from "../execution/home.js";

export function registerRosterHandlers(gateway: Gateway, config: ConfigStore, homes?: AgentHomeStore): void {
```

Replace the ensure handler:

```ts
gateway.registerHandler("ensureForeverBox", async (body) => {
  agent(body);
  const id = record(body).agentId;
  const agentId = id === undefined ? DEFAULT_AGENT_ID : id;
  if (typeof agentId !== "string") return bad("agente não encontrado");
  await homes?.ensure(agentId);
  return { ok: true };
});
```

`agent(body)` already 400s when `agentId` is present and ≠ default.

`src/rpc/index.ts` — extend opts and pass homes:

```ts
import type { AgentHomeStore } from "../execution/home.js";

export function registerRpcHandlers(
  gateway: Gateway,
  opts: TurnRunnerOptions & {
    store?: TranscriptStore;
    config?: ConfigStore;
    keystore?: Keystore;
    homes?: AgentHomeStore;
  } = {},
): { runner: ReturnType<typeof registerSendPromptHandler>; store: TranscriptStore } {
  const store = opts.store ?? createMemoryTranscriptStore();
  const runner = registerSendPromptHandler(gateway, { ...opts, store });
  registerTranscriptHandlers(gateway, store);
  if (opts.config) registerRosterHandlers(gateway, opts.config, opts.homes);
  if (opts.keystore && "getInteractionDecision" in store) {
    registerInteractionHandlers(gateway, store as never, opts.keystore, opts.executionBroker);
  }
  return { runner, store };
}
```

`src/main.ts` — import and extend opts/`ServerHandle`:

```ts
import { AgentHomeStore, defaultWorkspacesRoot } from "./execution/home.js";
import { createAgentHomeBroker } from "./execution/broker.js";
import { HOME_SYSTEM_PROMPT, SAFE_HOME_TOOLS } from "./execution/home-tools.js";
import { DEFAULT_SYSTEM_PROMPT } from "./rpc/send.js";
import { DEFAULT_AGENT_ID } from "./rpc/roster.js";
```

Add to `ServerHandle` and `startServer` opts:

```ts
homes?: AgentHomeStore;
workspacesRoot?: string;
disableAgentHome?: boolean;
```

Change `export function startServer` to `export async function startServer`. Before `createGateway`:

```ts
let homes = opts.homes;
let executionBroker = opts.executionBroker;
let tools = opts.tools;
let systemPrompt = opts.systemPrompt;

if (!opts.disableAgentHome) {
  homes = homes ?? await AgentHomeStore.create(opts.workspacesRoot ?? defaultWorkspacesRoot());
  await homes.ensure(DEFAULT_AGENT_ID);
  if (!executionBroker) {
    executionBroker = createAgentHomeBroker(homes);
    tools = tools ?? SAFE_HOME_TOOLS;
  }
  if (!systemPrompt) {
    systemPrompt = () => `${DEFAULT_SYSTEM_PROMPT}\n\n${HOME_SYSTEM_PROMPT}`;
  }
}
```

Pass `homes`, `executionBroker`, `tools`, `systemPrompt` into `registerRpcHandlers`. Resolve the handle with `homes` and the effective `executionBroker`.

`TurnRunnerOptions` already has `systemPrompt?: (agentId: string) => string`. No send.ts change required if `main` injects it.

**Test hygiene — every `startServer` in the suite gets a temp `workspacesRoot`**, except tests that set `disableAgentHome: true`. Pattern:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspacesRoot = mkdtempSync(join(tmpdir(), "openbot-ws-"));
// pass workspacesRoot in startServer opts
// rmSync(workspacesRoot, { recursive: true, force: true }) in afterEach
```

Update these call sites:

- `test/bootstrap.test.ts` — pass `workspacesRoot`; also assert `handle.homes` exists after `startServer()`.
- `test/gateway.integration.test.ts` `boot()` — add `workspacesRoot`.
- `test/rpc-send-gateway.integration.test.ts` — every `startServer`.
- `test/keystore-gateway.integration.test.ts` — both `startServer`s.
- `test/local-exec-gateway.integration.test.ts` — both `startServer`s (injected broker stays; home still created).
- `scripts/smoke-local.mjs` — `workspacesRoot: join(dir, "workspaces")` on both starts.

- [ ] **Step 4: Run focused then full tests**

Run:

```
npm test -- --run test/execution-home-bootstrap.test.ts test/bootstrap.test.ts test/gateway.integration.test.ts
npm test
npm run build
```

Expected: all PASS. `getForeverBoxStatus` fixture still `{ vncUrl: null, windows: [] }`.

If `bootstrap.test.ts` hits real `%LOCALAPPDATA%` because an opts merge was forgotten, stop and fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts src/rpc/roster.ts src/rpc/index.ts test scripts/smoke-local.mjs
git commit -m "feat(execution): provision agent home on default bootstrap"
```

---

### Task 6: Docs + aceite da spec

**Files:**
- Modify: `README.md` — seção Fase 2: home automática, bootstrap deixa de ser chat-only
- Modify: `docs/phase-2-local-execution-progress.md` — marcar itens 1–3 feitos; apontar a spec nova

- [ ] **Step 1: Update README**

Replace the bullet that says execução é opt-in / chat-only until workspace automático with:

- `startServer` cria `%LOCALAPPDATA%\OpenBot\workspaces\<agentId>\` (Desktop/Documents/Downloads/Projects) e liga `file` / `search_files` / `search_text` na home. Sem shell, sem VNC, sem pasta do usuário. `ensureForeverBox` só garante essa pasta. Testes passam `workspacesRoot`.

- [ ] **Step 2: Update phase-2 progress**

In `docs/phase-2-local-execution-progress.md`:

- item 1 → feito (home automática);
- item 2 → feito (backend composto no bootstrap);
- item 3 → feito (schemas seguros);
- apontar `docs/superpowers/specs/2026-08-13-agent-home-workspace-design.md`;
- remover a frase “ativação permanece opt-in”.

- [ ] **Step 3: Final verification**

Run:

```
npm run build
npm test
npm run smoke:local
```

Expected: build verde; suíte verde; smoke `{ ok: true, ... restartPersisted: true }`.

Manual check of spec §12:

- home criada no boot do teste novo;
- write real em `Documents/nota.md`;
- escape coberto em `execution-home-backend.test.ts`;
- dois agentIds cobertos;
- `ensureForeverBox` idempotente;
- schemas sem `shell`;
- status VNC congelado.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/phase-2-local-execution-progress.md
git commit -m "docs: record default agent home as the local computer"
```

---

## Spec coverage

| Spec § | Task |
|---|---|
| Layout + seed + manifesto + idempotência | Task 1 |
| sanitize / device names | Task 1 |
| LOCALAPPDATA root | Task 1 |
| Isolation A/B + stolen folder | Task 1 |
| Composite file+search, same sandbox | Task 2 |
| Escape `..` | Task 2 |
| Cache `backendFor` | Task 2 |
| Broker factory + `always` na home | Task 3 |
| `createAgentHomeBroker` | Task 3 |
| SAFE_HOME_TOOLS / no shell / no delete | Task 4 |
| Prompt sem path absoluto | Task 4 |
| Bootstrap default + `workspacesRoot` | Task 5 |
| `ensureForeverBox` / status frozen | Task 5 |
| Test hygiene (no real LocalAppData) | Task 5 |
| Zero tela nova / VNC / local-exec | unchanged; Task 5 keeps stubs and 501 |
| Docs 1–3 fechados | Task 6 |

## Type consistency

- `DEFAULT_AGENT_ID = "openbot-default"` exported from `roster.ts`, consumed by `main.ts` and tests.
- `AgentHomeStore.create(root)`, `ensure`, `pathFor`, `backendFor`.
- `HomeWorkspaceBackend.create(root)` implements `ExecutionBackend`.
- `ExecutionBackendSource = ExecutionBackend | ((agentId) => ExecutionBackend | Promise<...>)`.
- `createAgentHomeBroker(store)` policy is always `always`.
- `startServer` opts: `workspacesRoot`, `disableAgentHome`, `homes`.
- `ServerHandle.homes`, `ServerHandle.executionBroker`.
- `SAFE_HOME_TOOLS: ProviderTool[]`, `HOME_SYSTEM_PROMPT: string`.
- `SandForeverBoxStatus` stays `{ vncUrl: null, windows: [] }`.
