import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const focusedTests = [
  "test/mcp-sdk-transport.integration.test.ts",
  "test/mcp-manager.test.ts",
  "test/mcp-security.test.ts",
  "test/skills-catalog.test.ts",
  "test/skill-references.test.ts",
  "test/skill-dispatcher.test.ts",
  "test/rpc-mcp.test.ts",
  "test/rpc-skills.test.ts",
  "test/config-store.test.ts",
  "test/keystore.test.ts",
  "test/keystore-gateway.integration.test.ts",
  "test/store.test.ts",
  "test/transcript-optimization.test.ts",
];

const steps = [
  ["typecheck", ["run", "typecheck"]],
  ["focused Skills/MCP tests", ["test", "--", ...focusedTests, "--maxWorkers=1", "--no-file-parallelism"]],
  ["core acceptance", ["run", "verify:core:acceptance"]],
  ["isolated desktop E2E", ["run", "verify:e2e:desktop"]],
];

for (const [label, args] of steps) {
  console.log(`[verify:skills-mcp] ${label}`);
  const result = spawnSync(npm, args, {
    stdio: "inherit",
    windowsHide: true,
    ...(process.platform === "win32" ? { shell: true } : {}),
  });
  if (result.error) {
    console.error(`[verify:skills-mcp] ${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const status = result.status ?? 1;
    console.error(`[verify:skills-mcp] ${label} failed with exit code ${status}`);
    process.exit(status);
  }
}

console.log("[verify:skills-mcp] GREEN");
