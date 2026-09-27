/**
 * Where the gateway keeps its state and how those roots are protected: the
 * per-user ACL is applied once and remembered by a stamp, so later boots only
 * verify it.
 */
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ConfigStore } from "../config/store.js";
import type { SqliteConversationStore } from "../conversations/store.js";
import type { BrowserSessionManager } from "../browser/browser-session-manager.js";
import type { AgentHomeStore } from "../execution/home.js";
import { WORKSPACE_ACL_STAMP_NAME } from "../execution/home-inventory.js";
import type { AgentRuntimeManager } from "../execution/runtime/contracts.js";
import type { Keystore } from "../keystore/index.js";
import { applyOpenBotStateAcl, verifyOpenBotStateAcl, type OpenBotStateAclOptions } from "../state-acl.js";
import { writeFileExclusive } from "../shared/fs-atomic.js";
import type { SqliteTranscriptStore } from "../store/index.js";

export function stateUsesDefaultPath(opts: {
  config?: ConfigStore;
  configPath?: string;
  store?: SqliteTranscriptStore;
  storePath?: string;
  conversationStore?: SqliteConversationStore;
  keystore?: Keystore;
  keystoreDir?: string;
}): boolean {
  return (opts.config === undefined && opts.configPath === undefined)
    || (opts.store === undefined && opts.storePath === undefined)
    || (opts.keystore === undefined && opts.keystoreDir === undefined);
}

export function localStateUsesDefaultPath(opts: {
  runtimeManager?: AgentRuntimeManager;
  runtimeRoot?: string;
  homes?: AgentHomeStore;
  workspacesRoot?: string;
  disableAgentHome?: boolean;
  browserSessionManager?: BrowserSessionManager;
  browserRoot?: string;
}): boolean {
  const usesDefaultRuntime = opts.runtimeManager === undefined && opts.runtimeRoot === undefined;
  if (usesDefaultRuntime) return true;
  if (opts.disableAgentHome) return false;

  const usesDefaultWorkspaces = opts.homes === undefined && opts.workspacesRoot === undefined;
  const usesDefaultBrowser = opts.browserSessionManager === undefined
    && opts.browserRoot === undefined
    && opts.workspacesRoot === undefined;
  return usesDefaultWorkspaces || usesDefaultBrowser;
}

async function aclStampKey(root: string, options: OpenBotStateAclOptions | undefined): Promise<string> {
  const configured = typeof options?.currentUser === "function"
    ? await options.currentUser()
    : options?.currentUser;
  const principal = configured?.trim()
    || [process.env.USERDOMAIN?.trim(), process.env.USERNAME?.trim()].filter(Boolean).join("\\");
  return JSON.stringify({ schemaVersion: 1, root: resolve(root).toLowerCase(), principal: principal.toLowerCase() });
}

async function hasValidAclStamp(root: string, expected: string): Promise<boolean> {
  const path = join(root, WORKSPACE_ACL_STAMP_NAME);
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && await readFile(path, "utf8") === expected;
  } catch {
    return false;
  }
}

async function replaceAclStamp(root: string, contents: string): Promise<void> {
  const path = join(root, WORKSPACE_ACL_STAMP_NAME);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("existing ACL stamp is not a regular file");
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFileExclusive(path, contents);
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

export async function prepareStateRoot(root: string, options: OpenBotStateAclOptions | undefined): Promise<void> {
  await mkdir(root, { recursive: true });
  const stamp = await aclStampKey(root, options);
  if (await hasValidAclStamp(root, stamp)) {
    const verification = await verifyOpenBotStateAcl(root, options);
    if (verification.status !== "failed") return;
  }
  const result = await applyOpenBotStateAcl(root, options);
  if (result.status === "failed") {
    throw new Error(`OpenBot state ACL failed: ${result.message ?? "verification failed"}`);
  }
  try {
    await replaceAclStamp(root, stamp);
  } catch (error) {
    throw new Error(`OpenBot state ACL stamp failed: ${error instanceof Error ? error.message : "write failed"}`, { cause: error });
  }
}

/**
 * %LOCALAPPDATA%\\OpenBot can hold large trees OpenBot does not own (older
 * installs, backups); protecting that parent recursively would walk all of
 * them on the first boot. Keep ACL coverage on the state trees OpenBot manages.
 */
export function defaultLocalStateRoots(localStateRoot: string): string[] {
  return [
    join(localStateRoot, "runtime"),
    join(localStateRoot, "workspaces"),
    join(localStateRoot, "browser"),
    join(localStateRoot, "electron"),
  ];
}
