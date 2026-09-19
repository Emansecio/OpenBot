import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore } from "../src/config/store.js";
import { McpManager } from "../src/mcp/manager.js";
import { startServer, stopServer } from "../src/main.js";
import { createProviderRegistry } from "../src/providers/router.js";
import {
  createMemoryTranscriptStore,
  createTurnRunner,
} from "../src/rpc/send.js";
import { SkillCatalog } from "../src/skills/catalog.js";
import type { TranscriptEntry } from "../src/shared/contracts.js";
import type { StateAclCommandRunner } from "../src/state-acl.js";
import { SqliteTranscriptStore } from "../src/store/index.js";

const dirs: string[] = [];
const STATE_ACL_SDDL = "D:P(A;OICI;FA;;;CONTOSO\\alice)(A;;FA;;;CONTOSO\\alice)(A;OICI;FA;;;SY)(A;;FA;;;SY)(A;OICI;FA;;;BA)(A;;FA;;;BA)";

function stateAclFixture(calls: string[], onCall?: () => void): StateAclCommandRunner {
  return async (_file, args) => {
    calls.push(args[1] ?? "");
    onCall?.();
    if (args[1] === "/save") {
      const aclPath = args[2];
      if (aclPath === undefined) throw new Error("ACL fixture save path is missing");
      writeFileSync(aclPath, STATE_ACL_SDDL, "utf8");
    }
    return { exitCode: 0 };
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lifecycle/performance fixes", () => {
  it("keeps cancelled generation state until committed deletion cleanup", async () => {
    const runner = createTurnRunner();
    runner.sendPrompt({ agentId: "deleted-agent", prompt: "queued", clientNonce: "nonce:1" });
    expect(runner.cancelPrompt("deleted-agent").cancelled).toBe(true);
    await runner.flush("deleted-agent");

    const state = runner as unknown as {
      agentGenerations: Map<string, number>;
      queues: Map<string, unknown>;
      pendingCounts: Map<string, number>;
      queuedNonces: Map<string, Set<string>>;
    };
    expect(state.agentGenerations.has("deleted-agent")).toBe(true);
    expect(state.queues.has("deleted-agent")).toBe(false);
    expect(state.pendingCounts.has("deleted-agent")).toBe(false);
    expect(state.queuedNonces.has("deleted-agent")).toBe(false);

    runner.cleanupDeletedAgents(["deleted-agent"]);
    expect(state.agentGenerations.has("deleted-agent")).toBe(false);
  });

  it("cleans generation state after committed delete but preserves it on rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-delete-lifecycle-"));
    dirs.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    config.update({ agents: [
      { id: "committed-agent", name: "Committed", avatarId: "committed-agent" },
      { id: "rollback-agent", name: "Rollback", avatarId: "rollback-agent" },
    ] });
    const handle = await startServer(0, {
      config,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      runtimeRoot: join(root, "runtime"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
      sharedIntegrationsEnabled: false,
      skillCatalog: new SkillCatalog({ roots: [] }),
      mcpManager: new McpManager(),
    });
    try {
      for (const agentId of ["committed-agent", "rollback-agent"]) {
        handle.runner.sendPrompt({ agentId, prompt: "queued", clientNonce: `nonce:${agentId}` });
        expect(handle.runner.cancelPrompt(agentId).cancelled).toBe(true);
        await handle.runner.flush(agentId);
      }
      const state = handle.runner as unknown as { agentGenerations: Map<string, number> };
      expect(state.agentGenerations.has("committed-agent")).toBe(true);
      expect(state.agentGenerations.has("rollback-agent")).toBe(true);

      const committedResponse = await fetch(`http://127.0.0.1:${handle.port}/api/deleteAgents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["committed-agent"] }),
      });
      expect(committedResponse.status).toBe(200);
      expect(state.agentGenerations.has("committed-agent")).toBe(false);

      const clear = vi.spyOn(handle.store, "clear").mockImplementation(() => {
        throw new Error("forced persistence rollback");
      });
      try {
        const rollbackResponse = await fetch(`http://127.0.0.1:${handle.port}/api/deleteAgents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids: ["rollback-agent"] }),
        });
        expect(rollbackResponse.status).toBe(500);
      } finally {
        clear.mockRestore();
      }
      expect(state.agentGenerations.has("rollback-agent")).toBe(true);
      expect(config.snapshot().agents.some((agent) => agent.id === "rollback-agent")).toBe(true);
    } finally {
      await stopServer(handle);
    }
  });

  it("uses an optional local tool-call lookup without scanning getEntries", () => {
    const store = createMemoryTranscriptStore();
    const pending = {
      kind: "tool-call" as const,
      id: "tool-entry",
      localToolCallId: "turn:tool-entry",
      name: "file",
      summary: "read Documents/note.txt",
      status: "pending" as const,
    };
    store.append("agent", [pending]);
    const getEntries = vi.spyOn(store, "getEntries").mockImplementation(() => {
      throw new Error("full transcript scan");
    });
    const runner = createTurnRunner({ store });
    const publishToolCall = (runner as unknown as {
      publishToolCall: (agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>) => void;
    }).publishToolCall.bind(runner);

    publishToolCall("agent", { ...pending, status: "running" });

    expect(getEntries).not.toHaveBeenCalled();
    expect(store.findToolCallByLocalId?.("agent", "turn:tool-entry")).toMatchObject({ status: "running" });
  });

  it("uses the SQLite local tool-call index without scanning getEntries", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      const pending = {
        kind: "tool-call" as const,
        id: "sqlite-tool-entry",
        localToolCallId: "turn:sqlite-tool-entry",
        name: "file",
        summary: "read Documents/note.txt",
        status: "pending" as const,
      };
      store.append("agent", [pending]);
      const getEntries = vi.spyOn(store, "getEntries").mockImplementation(() => {
        throw new Error("full transcript scan");
      });
      const runner = createTurnRunner({ store });
      const publishToolCall = (runner as unknown as {
        publishToolCall: (agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>) => void;
      }).publishToolCall.bind(runner);

      publishToolCall("agent", { ...pending, status: "running" });

      expect(getEntries).not.toHaveBeenCalled();
      expect(store.findToolCallByLocalId("agent", "turn:sqlite-tool-entry")).toMatchObject({ status: "running" });
    } finally {
      store.close();
    }
  });

  it("publishes the completed tool snapshot through the durable tail without scanning getEntries", () => {
    const store = new SqliteTranscriptStore({ path: ":memory:" });
    try {
      store.append("agent", Array.from({ length: 2_000 }, (_, index) => ({
        kind: "message" as const,
        id: `history:${index}`,
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: `h${index}`,
        timestampMs: index,
        streaming: false,
      })));
      const pending = {
        kind: "tool-call" as const,
        id: "sqlite-tool-complete",
        localToolCallId: "turn:sqlite-tool-complete",
        name: "file",
        summary: "read Documents/note.txt",
        status: "pending" as const,
      };
      store.append("agent", [pending]);
      let tailReads = 0;
      const openDurableAgentTail = store.openDurableAgentTail.bind(store);
      store.getEntries = () => {
        throw new Error("full transcript scan");
      };
      store.openDurableAgentTail = (agentId, limit, beforeSeq, conversationId) => {
        tailReads += 1;
        return openDurableAgentTail(agentId, limit, beforeSeq, conversationId);
      };
      const events: Array<{ channel: string; payload: unknown }> = [];
      const runner = createTurnRunner({
        store,
        publish: (channel, payload) => {
          events.push({ channel, payload });
        },
      });
      const publishToolCall = (runner as unknown as {
        publishToolCall: (agentId: string, entry: Extract<TranscriptEntry, { kind: "tool-call" }>) => void;
      }).publishToolCall.bind(runner);

      publishToolCall("agent", {
        ...pending,
        status: "completed",
        result: { ok: true, operation: "file.read", path: "Documents/note.txt", bytes: 1 },
      });

      const snapshot = events.find((event) => event.channel === "transcript" && (event.payload as { type?: string }).type === "snapshot")
        ?.payload as { entries: TranscriptEntry[]; truncated?: boolean; method?: string } | undefined;
      expect(tailReads).toBe(1);
      expect(snapshot?.entries.at(-1)).toMatchObject({ id: "sqlite-tool-complete", status: "completed" });
      expect(snapshot).toMatchObject({ truncated: true, method: "openAgentTail" });
    } finally {
      store.close();
    }
  });

  it("passes the TurnRunner AbortSignal through the bootstrap provider-tools resolver", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-bootstrap-signal-"));
    dirs.push(root);
    const config = new ConfigStore({ configPath: join(root, "config.json") });
    config.update({ agents: [{ id: "signal-agent", name: "Signal agent", avatarId: "signal-agent" }] });
    const registry = createProviderRegistry();
    registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "ok" });
      },
    });
    let signal: AbortSignal | undefined;
    const handle = await startServer(0, {
      config,
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      runtimeRoot: join(root, "runtime"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
      registry,
      sharedIntegrationsEnabled: true,
      skillCatalog: new SkillCatalog({ roots: [] }),
      mcpManager: new McpManager(),
      tools: (_agentId, receivedSignal) => {
        signal = receivedSignal;
        return [];
      },
    });
    try {
      handle.runner.sendPrompt({ agentId: "signal-agent", prompt: "signal" });
      await handle.runner.flush("signal-agent");
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      await stopServer(handle);
    }
  });

  it("protects an injected state root before creating standalone state files", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-state-acl-"));
    dirs.push(root);
    const calls: string[] = [];
    const tokenPath = join(root, "gateway.token");
    const storePath = join(root, "store.db");
    const runner = stateAclFixture(calls, () => {
      if (!existsSync(tokenPath)) expect(existsSync(tokenPath)).toBe(false);
    });

    const handle = await startServer(0, {
      stateRoot: root,
      stateAcl: { platform: "win32", runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    });
    try {
      expect(calls).toEqual(["/reset", "/grant:r", "/inheritance:r", "/verify", "/save"]);
      expect(existsSync(tokenPath)).toBe(false);
      expect(existsSync(storePath)).toBe(true);
    } finally {
      await stopServer(handle);
    }
  });

  it("uses verification-only ACL work on a recurring boot with a valid protected stamp", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-state-acl-recurring-"));
    dirs.push(root);
    const calls: string[] = [];
    const runner = stateAclFixture(calls);
    const options = {
      stateRoot: root,
      stateAcl: { platform: "win32" as const, runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    };

    const first = await startServer(0, options);
    await stopServer(first);
    expect(calls).toEqual(["/reset", "/grant:r", "/inheritance:r", "/verify", "/save"]);

    calls.length = 0;
    const second = await startServer(0, options);
    await stopServer(second);
    expect(calls).toEqual(["/verify", "/save"]);
  });

  it("reapplies the ACL and replaces a corrupted recurring-boot stamp", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-state-acl-corrupt-stamp-"));
    dirs.push(root);
    const calls: string[] = [];
    const runner = stateAclFixture(calls);
    const options = {
      stateRoot: root,
      stateAcl: { platform: "win32" as const, runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    };
    const first = await startServer(0, options);
    await stopServer(first);
    writeFileSync(join(root, ".openbot-acl-v1.json"), "corrupted", "utf8");

    calls.length = 0;
    const second = await startServer(0, options);
    await stopServer(second);
    expect(calls).toEqual(["/reset", "/grant:r", "/inheritance:r", "/verify", "/save"]);
  });

  it("fails closed before opening config/store when state ACL setup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-state-acl-fail-"));
    dirs.push(root);
    const configPath = join(root, "config.json");
    const storePath = join(root, "store.db");
    const tokenPath = join(root, "gateway.token");
    const runner: StateAclCommandRunner = async () => ({ exitCode: 5, stderr: "denied" });

    await expect(startServer(0, {
      stateRoot: root,
      stateAcl: { platform: "win32", runner, currentUser: "CONTOSO\\alice" },
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    })).rejects.toThrow(/ACL/i);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
  });

  it("rejects partially injected test state without touching the default AppData root", async () => {
    const root = mkdtempSync(join(tmpdir(), "openbot-state-partial-"));
    dirs.push(root);
    await expect(startServer(0, {
      configPath: join(root, "config.json"),
      storePath: join(root, "store.db"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
    })).rejects.toThrow(/explicit OpenBot state paths/i);
    expect(existsSync(join(root, "config.json"))).toBe(false);
    expect(existsSync(join(root, "store.db"))).toBe(false);
  });
});
