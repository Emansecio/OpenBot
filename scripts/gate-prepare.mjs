// Runs the typecheck or build that a gate needs before its checks, unless
// verify:readiness already ran it for the whole run (OPENBOT_GATE_PREPARED=1).
// Run on its own, every gate still prepares itself.
import { spawnSync } from "node:child_process";

const step = process.argv[2];
if (step !== "typecheck" && step !== "build") {
  console.error("usage: node scripts/gate-prepare.mjs typecheck|build");
  process.exit(2);
}
if (process.env.OPENBOT_GATE_PREPARED === "1") {
  console.log(`[gate-prepare] ${step} already done by verify:readiness`);
  process.exit(0);
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", step], {
  stdio: "inherit",
  windowsHide: true,
  ...(process.platform === "win32" ? { shell: true } : {}),
});
if (result.error) {
  console.error(`[gate-prepare] ${step} could not start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
