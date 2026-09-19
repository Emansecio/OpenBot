/**
 * P2.3 — server-side attachment staging, security and RPC contract (RED→GREEN).
 * Uses the real SqliteTranscriptStore (schema + FTS) and the real attachment
 * staging store through startServer, exercising the production surface.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, promises as fsp, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer, stopServer, type ServerHandle } from "../src/main.js";
import { defaultAttachmentRoots } from "../src/rpc/attachments.js";
import {
  AttachmentStagingStore,
  STAGED_PATH_PREFIX,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_STAGED_PER_AGENT,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  detectAttachmentKind,
  sanitizeDisplayFilename,
  type StagingFileSystem,
} from "../src/attachments/staging.js";
import type { RpcHandler } from "../src/server/gateway.js";
import { SqliteTranscriptStore } from "../src/store/index.js";
import type { ProviderChatRequest } from "../src/providers/router.js";

const handles: ServerHandle[] = [];
const stores: SqliteTranscriptStore[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => stopServer(handle)));
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function handler(handle: ServerHandle, method: string): RpcHandler {
  const fn = handle.gateway.listHandlers().get(method);
  if (!fn) throw new Error("missing RPC handler: " + method);
  return fn;
}

function context(handle: ServerHandle) {
  return { getStatus: () => handle.runner.getStatus(), publish: () => undefined, method: "test" } as never;
}

async function harness(): Promise<ServerHandle> {
  const root = mkdtempSync(join(tmpdir(), "openbot-p23-"));
  roots.push(root);
  const handle = await startServer(0, {
    configPath: join(root, "config.json"), stateRoot: join(root, "state"), runtimeRoot: join(root, "runtime"),
    browserRoot: join(root, "browser"), keystoreDir: join(root, "keystore"), storePath: join(root, "store.db"),
    allowUnauthenticatedLocalGateway: true,
  });
  handles.push(handle);
  await handler(handle, "createAgent")({ id: "agent-a", name: "Agent A" }, context(handle));
  await handler(handle, "createAgent")({ id: "agent-b", name: "Agent B" }, context(handle));
  return handle;
}

function directStaging(nowFn?: () => number, fileSystem?: StagingFileSystem): AttachmentStagingStore {
  const root = mkdtempSync(join(tmpdir(), "openbot-p23-store-"));
  roots.push(root);
  const store = new SqliteTranscriptStore({ path: join(root, "store.db") });
  stores.push(store);
  return new AttachmentStagingStore({ db: store.databaseForSharedStores(), root: join(root, "staging"), nowFn, fileSystem });
}

const TEXT = Buffer.from("hello world hello world", "utf8");
const HTML_TEXT = Buffer.from("plain <b>not html</b> \u2028 text", "utf8");
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF", "latin1"), Buffer.alloc(20, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from(String(randomUUID()).repeat(6), "utf8")]);

function b64(input: Buffer): string { return input.toString("base64"); }

describe("P2.3 staging security (direct store)", () => {
  it("detects kind/mime from magic bytes, never the extension", async () => {
    expect(detectAttachmentKind(TEXT)).toMatchObject({ kind: "text", mime: "text/plain" });
    expect(detectAttachmentKind(PDF)).toMatchObject({ kind: "pdf" });
    expect(detectAttachmentKind(PNG)).toMatchObject({ kind: "image" });
    expect(detectAttachmentKind(Buffer.from("\xff\xd8\xff\xe0...jpeg", "latin1"))).toMatchObject({ kind: "image" });
    expect(detectAttachmentKind(Buffer.from("binary\x00\x01\x02\xff\xfe", "latin1"))).toBeNull();
  });

  it("sanitizes renderer filenames (strips paths, control chars, overlong)", () => {
    expect(sanitizeDisplayFilename("..\\..\\etc\\passwd.txt")).toBe("passwd.txt");
    expect(sanitizeDisplayFilename("a/b/c.md")).toBe("c.md");
    expect(sanitizeDisplayFilename("x\u0000y")).toBe("xy");
    expect(sanitizeDisplayFilename("")).toBe("attachment");
    expect(sanitizeDisplayFilename("a".repeat(500) + ".txt").length).toBeLessThanOrEqual(200);
  });

  it("classifies staged bytes instead of trusting renderer extensions", async () => {
    const staging = directStaging();
    const disguisedText = await staging.stageBytes("agent-a", { filename: "evil.png", bytes: TEXT });
    const disguisedPdf = await staging.stageBytes("agent-a", { filename: "claims.txt", bytes: PDF });
    expect(disguisedText.kind).toBe("text");
    expect(disguisedPdf.kind).toBe("pdf");
  });

  it("rejects unsupported/empty/oversized bytes", async () => {
    const staging = directStaging();
    await expect(staging.stageBytes("agent-a", { filename: "b.bin", bytes: Buffer.from("\x00\x01\x02\xff", "latin1") })).rejects.toThrow(/unsupported_media/);
    await expect(staging.stageBytes("agent-a", { filename: "e.txt", bytes: Buffer.alloc(0) })).rejects.toThrow(/vazio/);
    await expect(staging.stageBytes("agent-a", { filename: "big.txt", bytes: Buffer.alloc(MAX_TEXT_ATTACHMENT_BYTES + 1, 0x61) })).rejects.toThrow(/too_large/);
  });

  it("rejects a symlink/reparse staged file (no following links outside the root)", async () => {
    let stagedPath = "";
    const fileSystem: StagingFileSystem = {
      lstat: async (path) => {
        const stat = await fsp.lstat(path);
        if (path !== stagedPath) return stat;
        return Object.assign(Object.create(stat) as typeof stat, { isSymbolicLink: () => true });
      },
      realpath: (path) => fsp.realpath(path),
      readFile: (path) => fsp.readFile(path),
    };
    const staging = directStaging(undefined, fileSystem);
    const staged = await staging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    stagedPath = staged.storedPath;
    const outcome = await staging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: false });
    expect(outcome.attachments).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe("validação falhou");
  });

  it("uses the exact verified bytes without reopening the staged path", async () => {
    const staging = directStaging();
    const staged = await staging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    const readFile = vi.spyOn(fsp, "readFile");

    const outcome = await staging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: false });

    const stagedReads = readFile.mock.calls.filter(([path]) => path === staged.storedPath);
    expect(outcome.attachments[0]?.text).toBe(TEXT.toString("utf8"));
    expect(stagedReads).toHaveLength(1);
  });

  it("rejects a swapped file between stage and send (SHA-256 divergence)", async () => {
    const staging = directStaging();
    const staged = await staging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    const storedPath = staged.storedPath;
    writeFileSync(storedPath, Buffer.from("tampered content", "utf8"));
    const outcome = await staging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: false });
    expect(outcome.attachments).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toContain("validação");
  });

  it("rejects an already-consumed attachment on a second send", async () => {
    const staging = directStaging();
    const first = await staging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    const once = await staging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + first.id], { providerSupportsImages: false });
    expect(once.attachments).toHaveLength(1);
    const twice = await staging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + first.id], { providerSupportsImages: false });
    expect(twice.attachments).toHaveLength(0);
    expect(twice.skipped[0]?.reason).toBe("já consumido");
  });

  it("rejects an expired attachment (abandoned staging sweep)", async () => {
    let clock = 1_000_000;
    const staging = directStaging(() => clock);
    const staged = await staging.stageBytes("agent-a", { filename: "x.txt", bytes: TEXT });
    clock += 60 * 60_000; // far beyond the 15-minute lifetime
    const outcome = await staging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: false });
    expect(outcome.attachments).toHaveLength(0);
    expect(staging.get("agent-a", staged.id)?.state).toBe("discarded");
  });

  it("retains consumed images only until expiry and keeps reuse and ownership guards", async () => {
    let now = 1000;
    const staging = directStaging(() => now);
    const staged = await staging.stageBytes("agent-a", { filename: "pic.png", bytes: PNG, conversationId: "chat-a" });
    const refs = [STAGED_PATH_PREFIX + staged.id];
    await staging.resolveForSend("agent-a", refs, { providerSupportsImages: true, conversationId: "chat-a" });
    expect(existsSync(staged.storedPath)).toBe(true);
    expect((await staging.resolveForSend("agent-a", refs, { providerSupportsImages: true })).skipped[0]?.reason).toBe("já consumido");
    expect((await staging.resolveForSend("agent-b", refs, { providerSupportsImages: true, retry: true })).attachments).toHaveLength(0);
    expect((await staging.resolveForSend("agent-a", refs, { providerSupportsImages: true, retry: true, conversationId: "chat-b" })).attachments).toHaveLength(0);
    now = staged.expiresAtMs;
    expect((await staging.resolveForSend("agent-a", refs, { providerSupportsImages: true, retry: true, conversationId: "chat-a" })).attachments).toHaveLength(0);
    expect(staging.get("agent-a", staged.id)?.state).toBe("discarded");
    await vi.waitFor(() => expect(existsSync(staged.storedPath)).toBe(false));
  });

  it("never discloses another agent's staged attachment (foreign-agent)", async () => {
    const staging = directStaging();
    const staged = await staging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    expect(staging.get("agent-b", staged.id)).toBeNull();
    const outcome = await staging.resolveForSend("agent-b", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: false });
    expect(outcome.attachments).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe("não encontrado");
  });

  it("enforces per-turn and aggregate count/byte caps at send resolution", async () => {
    const staging = directStaging();
    const refs: string[] = [];
    for (let index = 0; index < MAX_ATTACHMENTS_PER_TURN + 3; index += 1) {
      const staged = await staging.stageBytes("agent-a", { filename: "f" + index + ".txt", bytes: Buffer.from("content " + index) });
      refs.push(STAGED_PATH_PREFIX + staged.id);
    }
    const outcome = await staging.resolveForSend("agent-a", refs, { providerSupportsImages: false });
    expect(outcome.attachments).toHaveLength(MAX_ATTACHMENTS_PER_TURN);
    expect(outcome.skipped[0]?.reason).toBe("limite agregado de anexos");
  });

  it("rejects aggregate byte overflow at send resolution", async () => {
    const staging = directStaging();
    const refs: string[] = [];
    const header = Buffer.from("%PDF-1.4", "latin1");
    const chunk = Buffer.concat([header, Buffer.alloc(MAX_PDF_ATTACHMENT_BYTES - header.length, 0x7a)]);
    for (let index = 0; index < 3; index += 1) {
      const staged = await staging.stageBytes("agent-a", { filename: "big" + index + ".pdf", bytes: chunk });
      refs.push(STAGED_PATH_PREFIX + staged.id);
    }
    const outcome = await staging.resolveForSend("agent-a", refs, { providerSupportsImages: false });
    const total = outcome.attachments.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    expect(total).toBeLessThanOrEqual(MAX_ATTACHMENTS_TOTAL_BYTES);
    expect(outcome.skipped[0]?.reason).toBe("limite agregado de bytes");
  });

  it("bounds the abandoned staging pool per agent", async () => {
    const staging = directStaging();
    for (let index = 0; index < MAX_STAGED_PER_AGENT; index += 1) {
      await staging.stageBytes("agent-a", { filename: "s" + index + ".txt", bytes: Buffer.from("x" + index) });
    }
    await expect(staging.stageBytes("agent-a", { filename: "too-many.txt", bytes: Buffer.from("y") })).rejects.toThrow(/staging_pool/);
  });

  it("keeps the per-agent staging cap under concurrent writes", async () => {
    const staging = directStaging();
    const attempts = await Promise.allSettled(Array.from({ length: MAX_STAGED_PER_AGENT + 8 }, (_value, index) =>
      staging.stageBytes("agent-a", { filename: `parallel-${index}.txt`, bytes: Buffer.from(`parallel ${index}`) }),
    ));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(MAX_STAGED_PER_AGENT);
    expect(staging.listActive("agent-a")).toHaveLength(MAX_STAGED_PER_AGENT);
  });

  it("purges every staged row and byte for one agent only", async () => {
    const staging = directStaging();
    const first = await staging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    const second = await staging.stageBytes("agent-a", { filename: "b.txt", bytes: TEXT });
    const survivor = await staging.stageBytes("agent-b", { filename: "keep.txt", bytes: TEXT });

    await expect(staging.purgeAgent("agent-a")).resolves.toBe(2);

    expect(staging.get("agent-a", first.id)).toBeNull();
    expect(staging.get("agent-a", second.id)).toBeNull();
    expect(existsSync(first.storedPath)).toBe(false);
    expect(existsSync(second.storedPath)).toBe(false);
    expect(staging.get("agent-b", survivor.id)).not.toBeNull();
    expect(existsSync(survivor.storedPath)).toBe(true);
  });

  it("retains rows for a retry when strict purge cannot remove bytes", async () => {
    const staging = directStaging();
    const staged = await staging.stageBytes("agent-a", { filename: "retry.txt", bytes: TEXT });
    const realRm = fsp.rm.bind(fsp);
    let failOnce = true;
    const rm = vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (String(target) === staged.storedPath && failOnce) {
        failOnce = false;
        throw new Error("bytes busy");
      }
      return realRm(target, options);
    });
    try {
      await expect(staging.purgeAgent("agent-a")).rejects.toThrow("bytes busy");
      expect(staging.get("agent-a", staged.id)).toEqual(expect.objectContaining({ id: staged.id }));
      expect(existsSync(staged.storedPath)).toBe(true);

      await expect(staging.purgeAgent("agent-a")).resolves.toBe(1);
      expect(staging.get("agent-a", staged.id)).toBeNull();
      expect(existsSync(staged.storedPath)).toBe(false);
    } finally {
      rm.mockRestore();
    }
  });

  it("restricts legacy path roots to the current agent home", () => {
    expect(defaultAttachmentRoots("C:\\OpenBot\\workspaces\\agent-a"))
      .toEqual([expect.stringMatching(/OpenBot[\\/]workspaces[\\/]agent-a$/)]);
    expect(defaultAttachmentRoots()).toEqual([]);
  });

  it("discard removes bytes and marks state discarded; committed stays committed", async () => {
    const handle = await harness();
    const staged = await handle.attachmentStaging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    expect(await handle.attachmentStaging.commit("agent-a", staged.id)).toBe(true);
    // committed attachments cannot be discarded (still committed state, not consumed)
    expect(await handle.attachmentStaging.discard("agent-a", staged.id)).toBe(false);
    const again = await handle.attachmentStaging.stageBytes("agent-a", { filename: "b.txt", bytes: TEXT });
    expect(await handle.attachmentStaging.discard("agent-a", again.id)).toBe(true);
    expect(handle.attachmentStaging.get("agent-a", again.id)?.state).toBe("discarded");
    expect(existsSync(again.storedPath)).toBe(false);
  });
});

describe("P2.3 staging + image-gating RPC", () => {
  it("refuses delivery when a staged attachment expired, before any provider request", async () => {
    const handle = await harness();
    let calls = 0;
    handle.registry.register({ name: "xai", async streamChat() { calls++; } });
    let now = Date.now();
    const staging = new AttachmentStagingStore({
      db: handle.store.databaseForSharedStores(), root: handle.attachmentStaging.root, nowFn: () => now,
    });
    const staged = await staging.stageBytes("agent-a", { filename: "expirado.txt", bytes: TEXT });
    now += 16 * 60_000;
    staging.expireDue();
    await expect(handle.runner.sendPrompt({
      agentId: "agent-a", prompt: "texto preservável no journal", clientNonce: "expired-send",
      attachments: [{ path: STAGED_PATH_PREFIX + staged.id, name: "expirado.txt" }],
    })).rejects.toThrow(/expirado.txt.*Selecione esses arquivos novamente/);
    await handle.runner.flush("agent-a");
    expect(calls).toBe(0);
    expect(handle.store.hasAcceptedNonce("agent-a", "expired-send")).toBe(false);
    expect(handle.store.getEntries("agent-a").some((entry) => entry.kind === "message" && entry.role === "user")).toBe(false);
  });

  it("retries with the original image and refuses a retry when its bytes are missing", async () => {
    const handle = await harness();
    const requests: ProviderChatRequest[] = [];
    handle.registry.register({
      name: "xai",
      async streamChat(request, emit) {
        requests.push(structuredClone({ ...request, signal: undefined }));
        emit({ type: "delta", delta: "Analisando a imagem." });
        throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      },
    });
    const conversation = handle.conversationStore.ensureDefault("agent-a");
    const staged = await handle.attachmentStaging.stageBytes("agent-a", {
      filename: "pic.png", bytes: PNG, conversationId: conversation.id,
    });
    handle.runner.sendPrompt({
      agentId: "agent-a", conversationId: conversation.id, prompt: "Descreva a imagem", clientNonce: "image-original",
      attachments: [{ name: "pic.png", path: STAGED_PATH_PREFIX + staged.id }],
    });
    await handle.runner.flush("agent-a");
    handle.runner.retryPrompt("agent-a", conversation.id);
    await handle.runner.flush("agent-a");
    expect(requests).toHaveLength(2);
    const images = (request: ProviderChatRequest) => request.messages.flatMap((message) => typeof message.content === "string"
      ? [] : message.content.filter((part) => part.type === "image_url"));
    expect(images(requests[0]!)).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(PNG)}`, detail: "auto" } }]);
    expect(images(requests[1]!)).toEqual(images(requests[0]!));
    expect(handle.store.getEntries("agent-a", conversation.id).filter((entry) => entry.kind === "user-attachment")).toHaveLength(1);
    await fsp.rm(staged.storedPath);
    handle.runner.retryPrompt("agent-a", conversation.id);
    await handle.runner.flush("agent-a");
    expect(requests).toHaveLength(2);
    expect(handle.store.getEntries("agent-a", conversation.id)).toContainEqual(expect.objectContaining({
      kind: "notice", level: "error", text: expect.stringContaining("Anexe a imagem novamente"),
    }));
  });

  it("stageAttachment returns only an opaque id + metadata", async () => {
    const handle = await harness();
    const result = handler(handle, "stageAttachment")({ agentId: "agent-a", filename: "note.md", bytesBase64: b64(TEXT) }, context(handle)) as Promise<any>;
    const staged = await result;
    expect(staged.attachmentId).toMatch(/^att-/);
    expect(staged.name).toBe("note.md");
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(staged.kind).toBe("text");
    expect(staged.attachmentId).not.toContain("\\");
    expect(staged.attachmentId).not.toContain("/");
  });

  it("images stage fine and resolveForSend returns a data URL when the provider declares images", async () => {
    const handle = await harness();
    const staged = await handle.attachmentStaging.stageBytes("agent-a", { filename: "pic.png", bytes: PNG });
    const withImages = await handle.attachmentStaging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: true });
    expect(withImages.attachments).toHaveLength(1);
    expect(withImages.attachments[0]?.imageDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("an image sent to a provider/model WITHOUT images:true is rejected as unsupported_feature", async () => {
    const handle = await harness();
    const staged = await handle.attachmentStaging.stageBytes("agent-a", { filename: "pic.png", bytes: PNG });
    const outcome = await handle.attachmentStaging.resolveForSend("agent-a", [STAGED_PATH_PREFIX + staged.id], { providerSupportsImages: false });
    expect(outcome.attachments).toHaveLength(0);
    expect(outcome.skipped[0]?.reason).toBe("unsupported_feature");
  });

  it("discardStagedAttachment and listStagedAttachments are agent-scoped", async () => {
    const handle = await harness();
    const staged = await handle.attachmentStaging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    const list = handler(handle, "listStagedAttachments")({ agentId: "agent-a" }, context(handle)) as any[];
    expect(list.map((entry: any) => entry.attachmentId)).toContain(staged.id);
    const foreign = handler(handle, "listStagedAttachments")({ agentId: "agent-b" }, context(handle)) as any[];
    expect(foreign.map((entry: any) => entry.attachmentId)).not.toContain(staged.id);
    await handler(handle, "discardStagedAttachment")({ agentId: "agent-a", attachmentId: staged.id }, context(handle));
    expect(handle.attachmentStaging.get("agent-a", staged.id)?.state).toBe("discarded");
  });

  it("preserves mixed staged/legacy input order in durable attachment entries", async () => {
    const handle = await harness();
    handle.registry.register({
      name: "xai",
      async streamChat(_request, emit) {
        emit({ type: "delta", delta: "ok" });
        emit({ type: "done" });
      },
    });
    const home = handle.homes!.pathFor("agent-a");
    const legacyPath = join(home, "legacy.txt");
    writeFileSync(legacyPath, "legacy body");
    const first = await handle.attachmentStaging.stageBytes("agent-a", { filename: "first.txt", bytes: Buffer.from("first body") });
    const third = await handle.attachmentStaging.stageBytes("agent-a", { filename: "third.txt", bytes: Buffer.from("third body") });
    const conversation = handle.conversationStore.getActive("agent-a") ?? handle.conversationStore.ensureDefault("agent-a");

    handle.runner.sendPrompt({
      agentId: "agent-a",
      conversationId: conversation.id,
      prompt: "ordered attachments",
      attachments: [
        { name: "first.txt", path: STAGED_PATH_PREFIX + first.id },
        { name: "legacy.txt", path: legacyPath },
        { name: "third.txt", path: STAGED_PATH_PREFIX + third.id },
      ],
    });
    await handle.runner.flush("agent-a");

    const attachmentEntries = handle.store.getEntries("agent-a", conversation.id)
      .filter((entry) => entry.kind === "user-attachment") as Array<{ file_name: string; extractedText?: string }>;
    expect(attachmentEntries.map((entry) => [entry.file_name, entry.extractedText])).toEqual([
      ["first.txt", "first body"],
      ["legacy.txt", "legacy body"],
      ["third.txt", "third body"],
    ]);
  });

  it("keeps the attachment recoverable when its transcript transaction fails", async () => {
    const handle = await harness();
    handle.store.memoryStore.setSettings("agent-a", "off");
    let calls = 0;
    handle.registry.register({ name: "xai", async streamChat(_request, emit) { calls++; emit({ type: "delta", delta: "saved" }); } });
    const staged = await handle.attachmentStaging.stageBytes("agent-a", { filename: "marker.txt", bytes: TEXT });
    await handle.attachmentStaging.commit("agent-a", staged.id);
    const db = handle.store.databaseForSharedStores();
    db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON transcript_entries WHEN NEW.kind = 'user-attachment' BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    const prompt = { agentId: "agent-a", prompt: "commit marker", clientNonce: "commit-marker", attachments: [{ name: "marker.txt", path: STAGED_PATH_PREFIX + staged.id }] };
    await expect(handle.runner.sendPrompt(prompt)).rejects.toThrow(/storage failure/);
    await handle.runner.flush("agent-a");
    expect(calls).toBe(0);
    expect(handle.attachmentStaging.get("agent-a", staged.id)?.consumedAtMs).toBeNull();
    expect(await fsp.readFile(staged.storedPath)).toEqual(TEXT);
    expect(handle.store.getEntries("agent-a").some((entry) => entry.kind === "message" && entry.role === "user")).toBe(false);
    db.exec("DROP TRIGGER fail_attachment");
    handle.runner.sendPrompt(prompt);
    await handle.runner.flush("agent-a");
    expect(calls).toBe(1);
    expect(handle.store.getEntries("agent-a").filter((entry) => entry.kind === "user-attachment")).toEqual([
      expect.objectContaining({ attachment_id: staged.id, extractedText: TEXT.toString() }),
    ]);
    expect(handle.attachmentStaging.get("agent-a", staged.id)?.consumedAtMs).not.toBeNull();
  });

  it("commitStagedAttachments confirms staged opaque refs and rejects unknown ones", async () => {
    const handle = await harness();
    const staged = await handle.attachmentStaging.stageBytes("agent-a", { filename: "a.txt", bytes: TEXT });
    const committed = await handler(handle, "commitStagedAttachments")({ agentId: "agent-a", paths: [STAGED_PATH_PREFIX + staged.id] }, context(handle)) as string[];
    expect(committed).toEqual([STAGED_PATH_PREFIX + staged.id]);
    expect(handle.attachmentStaging.get("agent-a", staged.id)?.state).toBe("committed");
    await expect(Promise.resolve().then(() => handler(handle, "commitStagedAttachments")({ agentId: "agent-a", paths: [STAGED_PATH_PREFIX + "att-missing"] }, context(handle)))).rejects.toThrow(/409|confirmados|encontrado/);
  });
});
