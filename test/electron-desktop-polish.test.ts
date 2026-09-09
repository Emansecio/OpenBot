import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.):/, "$1:"));
const main = readFileSync(resolve(root, "client/extracted/dist/electron-main/main.cjs"), "utf8");
const preload = readFileSync(resolve(root, "client/extracted/dist/electron-preload/preload.cjs"), "utf8");
const visual = readFileSync(resolve(root, "scripts/visual-ui-verify.mjs"), "utf8");

describe("Electron desktop operational polish", () => {
  it("bundles the terminal renderer failure path before desktop bootstrap rejection", () => {
    expect(main).toMatch(/console\.error\("\[openbot\] terminal renderer load failure", error6\);\r?\n    if \(mainWindow === window2\) mainWindow = void 0;\r?\n    if \(!window2\.isDestroyed\(\)\) window2\.destroy\(\);\r?\n    import_electron50\.app\.exit\(1\);\r?\n    throw error6;/u);
    expect(main).toMatch(/app\.whenReady\(\)\.then\([\s\S]*\.catch\(\(error6\) => \{\r?\n  console\.error\("\[openbot\] desktop bootstrap failed", error6\);/u);
  });

  it("bundles isolated temporary state, a dynamic port, and cleanup in the visual verifier", () => {
    expect(visual).toContain('mkdtempSync(join(tmpdir(), "openbot-visual-native-"))');
    expect(visual).toContain("async function getFreePort()");
    expect(visual).toContain("`--remote-debugging-port=${cdpPort}`");
    expect(visual).toMatch(/taskkill[\s\S]{0,120}["']\/T["']/);
    expect(visual).toMatch(/if \(runRoot\) rmSync\(runRoot, \{[^}]*recursive: true[^}]*force: true[^}]*\}\);/u);
    expect(visual).not.toContain("--remote-debugging-port=9333");
  });

  it("bundles the guarded active-workspace inventory IPC gate", () => {
    expect(main).toMatch(/ipcMain\.handle\("sand:workspace-inventory-get", async \(_event\) => \{\r?\n    senderGuards\.assertTrustedSecretsSender\(_event\);\r?\n    if \(process\.env\.OPENBOT_LOCAL_GATEWAY !== "1"\) throw new Error\("OpenBot local mode is required"\);\r?\n    const current = await callOpenBotProviderRpc\("getProviderConfig"\);\r?\n    const agentId = current\?\.agentId;\r?\n    if \(typeof agentId !== "string" \|\| !agentId\) throw new Error\("Active agent is unavailable"\);\r?\n    return await callOpenBotProviderRpc\("getWorkspaceInventory", \{ agentId \}\);\r?\n  \}\);/u);
    expect(preload).toMatch(/async getWorkspaceInventory\(\) \{\r?\n      return await import_electron\.ipcRenderer\.invoke\("sand:workspace-inventory-get"\);\r?\n    \}/u);
    expect(preload).not.toMatch(/getWorkspaceInventory\(\s*agentId\s*\)/);
  });
});
