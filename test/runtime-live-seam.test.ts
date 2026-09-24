import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startServer } from "../src/main.js";
import type { WslCommandRunner } from "../src/execution/runtime/wsl/provisioner.js";
import { TempRoots } from "./helpers/temp-roots.js";

const temp = new TempRoots();

afterEach(async () => {
  vi.unstubAllEnvs();
  await temp.cleanup();
});

const runner: WslCommandRunner = {
  async run() {
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  },
};

describe("WSL live bootstrap seam", () => {
  it("fecha a seleção de distro temporária quando a flag explícita está desligada", async () => {
    vi.stubEnv("OPENBOT_RUNTIME_WSL_LIVE_TEST", "0");
    const root = await temp.makeAsync("openbot-live-seam-bootstrap-");

    await expect(startServer(0, {
      stateRoot: root,
      runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"),
      workspacesRoot: join(root, "workspaces"),
      disableAgentHome: true,
      allowUnauthenticatedLocalGateway: true,
      runtimeCommandRunner: runner,
      runtimeDistroName: "OpenBotRuntimeLive-12345678-1234-1234-1234-123456789abc",
    })).rejects.toThrow(/not permitted/i);
  });

  it("não expõe quota arbitrária no bootstrap de produção comum", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENBOT_RUNTIME_WSL_LIVE_TEST", "0");
    const root = await temp.makeAsync("openbot-live-quota-closed-");

    await expect(startServer(0, {
      configPath: join(root, "config.json"),
      storePath: join(root, "store.db"),
      keystoreDir: join(root, "keys"),
      runtimeRoot: join(root, "runtime"),
      browserRoot: join(root, "browser"),
      workspacesRoot: join(root, "workspaces"),
      workspaceQuota: { maxBytes: 1, maxFiles: 1 },
      sharedIntegrationsEnabled: false,
      gatewayToken: "runtime-live-quota-test-token",
    })).rejects.toThrow(/quota override is test-only/i);
  });
});
