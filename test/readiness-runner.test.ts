import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The readiness runner is executable JavaScript and intentionally lives outside
// the TypeScript build. Its small pure helpers remain importable for regression
// coverage.
// @ts-expect-error -- no declaration file is emitted for scripts/*.mjs
import { buildIsolatedEnvironment, evaluateCommandResult, findOperationLocks, getRootProcesses, listStaleReadinessRoots, parseVitestSkipEvidence } from "../scripts/verify-readiness.mjs";
// @ts-expect-error -- no declaration file is emitted for scripts/*.mjs
import { shortcutPaths } from "../scripts/release-common.mjs";

describe("readiness runner classification", () => {
  it("isolates OS defaults without changing explicit OpenBot root contracts", () => {
    const env = buildIsolatedEnvironment({
      PATH: "fixture-path",
      USERPROFILE: "C:\\Users\\real-user",
      OPENBOT_DATA_ROOT: "real-data",
      OPENBOT_LOCAL_DATA_ROOT: "real-local",
      OPENBOT_USER_DATA: "real-user-data",
      OPENBOT_GATEWAY_TOKEN: "must-not-leak",
    }, "C:\\Temp\\openbot-readiness-test", "C:\\package\\openbot-runtime-package.tar");

    expect(env).toMatchObject({
      TEMP: "C:\\Temp\\openbot-readiness-test",
      TMP: "C:\\Temp\\openbot-readiness-test",
      APPDATA: "C:\\Temp\\openbot-readiness-test\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Temp\\openbot-readiness-test\\AppData\\Local",
      USERPROFILE: "C:\\Users\\real-user",
      OPENBOT_SHORTCUT_ROOT: "C:\\Temp\\openbot-readiness-test\\Shortcuts",
      OPENBOT_GUEST_PACKAGE: "C:\\package\\openbot-runtime-package.tar",
      NODE_DISABLE_COMPILE_CACHE: "1",
      NPM_CONFIG_CACHE: "C:\\Temp\\openbot-readiness-test\\.readiness-cache\\npm",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    });
    expect(env).not.toHaveProperty("OPENBOT_DATA_ROOT");
    expect(env).not.toHaveProperty("OPENBOT_LOCAL_DATA_ROOT");
    expect(env).not.toHaveProperty("OPENBOT_USER_DATA");
    expect(env).not.toHaveProperty("OPENBOT_GATEWAY_TOKEN");
    expect(shortcutPaths(undefined, env)).toEqual({
      desktop: "C:\\Temp\\openbot-readiness-test\\Shortcuts\\Desktop\\OpenBot.lnk",
      startMenu: "C:\\Temp\\openbot-readiness-test\\Shortcuts\\Start Menu\\OpenBot.lnk",
    });
  });

  it("does not inherit conventional credentials or OpenBot runtime paths", () => {
    const env = buildIsolatedEnvironment({
      PATH: "fixture-path",
      AWS_ACCESS_KEY_ID: "real-aws-key",
      DOCKER_AUTH_CONFIG: "real-docker-auth",
      DATABASE_URL: "postgres://user:password@real-host/db",
      NPM_CONFIG__AUTH: "real-npm-auth",
      "npm_config_//registry.npmjs.org/:_authToken": "real-npm-token",
      NODE_OPTIONS: "--require C:\\untrusted\\hook.cjs",
      NODE_PATH: "C:\\untrusted\\modules",
      NPM_CONFIG_USERCONFIG: "C:\\real\\.npmrc",
      DOCKER_CONFIG: "C:\\real\\.docker",
      OPENBOT_LOG_DIR: "C:\\real\\logs",
      OPENBOT_ATTACHMENT_STAGING: "C:\\real\\attachments",
      OPENBOT_RUNTIME_WSL_LIVE_TEST: "1",
    }, "C:\\Temp\\openbot-readiness-test", "C:\\package\\openbot-runtime-package.tar");

    expect(env.PATH).toBe("fixture-path");
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "DOCKER_AUTH_CONFIG",
      "DATABASE_URL",
      "NPM_CONFIG__AUTH",
      "npm_config_//registry.npmjs.org/:_authToken",
      "NODE_OPTIONS",
      "NODE_PATH",
      "NPM_CONFIG_USERCONFIG",
      "DOCKER_CONFIG",
      "OPENBOT_LOG_DIR",
      "OPENBOT_ATTACHMENT_STAGING",
      "OPENBOT_RUNTIME_WSL_LIVE_TEST",
    ]) expect(env).not.toHaveProperty(key);
  });

  it("finds the sibling directory name used by the real release operation lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-readiness-locks-"));
    try {
      const localData = join(root, "OpenBot");
      const lock = join(localData, "install.openbot-operation.lock");
      await mkdir(lock, { recursive: true });

      await expect(findOperationLocks(localData)).resolves.toEqual([lock]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an operation-lock subtree cannot be inventoried", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-readiness-lock-denied-"));
    const blocked = join(root, "blocked");
    try {
      await mkdir(blocked);
      const readDirectory = async (path: Parameters<typeof readdir>[0], options: { withFileTypes: true }) => {
        if (String(path) === blocked) throw Object.assign(new Error("access denied"), { code: "EACCES" });
        return readdir(path, options);
      };

      await expect(findOperationLocks(root, { readDirectory }))
        .rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a stale readiness root represented by a symbolic link", async () => {
    const parent = await mkdtemp(join(tmpdir(), "openbot-readiness-parent-"));
    const current = join(parent, "openbot-readiness-current");
    const stale = join(parent, "openbot-readiness-stale");
    const target = join(parent, "target");
    try {
      await mkdir(current);
      await mkdir(target);
      await symlink(target, stale, process.platform === "win32" ? "junction" : "dir");

      await expect(listStaleReadinessRoots(current)).resolves.toEqual([stale]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("tracks an owned child even when TempRoot is absent from its command line", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-readiness-processes-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { ...process.env, TEMP: root, TMP: root },
      stdio: "ignore",
      windowsHide: true,
    });
    await once(child, "spawn");
    try {
      const processes = await getRootProcesses(root, [child.pid]);
      expect(processes.some((process: { ProcessId?: number }) => process.ProcessId === child.pid)).toBe(true);
    } finally {
      child.kill();
      await once(child, "exit");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never converts an explicit environment block into GREEN", () => {
    expect(evaluateCommandResult({ exitCode: 0, output: '{"status":"BLOCKED_ENV"}' })).toMatchObject({
      status: "BLOCKED_ENV",
    });
  });

  it("rejects an unapproved Vitest skip even when the process exits zero", () => {
    const output = [
      " ↓ test/unexpected.test.ts (2 tests | 1 skipped)",
      " Tests  1 passed | 1 skipped (2)",
    ].join("\n");

    expect(evaluateCommandResult({ exitCode: 0, output, allowedSkipFiles: [] })).toMatchObject({
      status: "RED",
      skipped: 1,
      unexpectedSkipFiles: ["test/unexpected.test.ts"],
    });
  });

  it("accepts only the explicitly justified live tests skipped by the isolated suite", () => {
    const output = [
      " ↓ test/home-acl.test.ts (7 tests | 1 skipped)",
      " ↓ test/keystore-dpapi-live.test.ts (5 tests | 1 skipped)",
      " ↓ test/host-whatsapp.test.ts (4 tests | 1 skipped)",
      " Tests  1450 passed | 3 skipped (1453)",
    ].join("\n");

    const evidence = parseVitestSkipEvidence(output);
    expect(evidence).toEqual({
      count: 3,
      files: ["test/home-acl.test.ts", "test/keystore-dpapi-live.test.ts", "test/host-whatsapp.test.ts"],
    });
    expect(evaluateCommandResult({
      exitCode: 0,
      output,
      allowedSkipFiles: ["test/home-acl.test.ts", "test/keystore-dpapi-live.test.ts", "test/host-whatsapp.test.ts"],
    })).toMatchObject({ status: "GREEN", skipped: 3, unexpectedSkipFiles: [] });
  });

  it("treats a non-zero command without an environment marker as RED", () => {
    expect(evaluateCommandResult({ exitCode: 1, output: "assertion failed" })).toMatchObject({ status: "RED" });
  });
});
