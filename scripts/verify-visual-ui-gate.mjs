import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.env.OPENBOT_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const rendererBoundaryVerifier = join(root, "scripts", "verify-renderer-boundary.mjs");
const artifactVerifier = join(root, "scripts", "verify-client-artifacts.mjs");
const visualVerifier = join(root, "scripts", "visual-ui-verify.mjs");
const artifactsOnly = process.argv.includes("--artifacts-only");

function run(label, script, args = []) {
  console.log(`VISUAL_UI_GATE ${label}`);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, OPENBOT_ROOT: root },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(`VISUAL_UI_GATE ${label} failed to start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    const suffix = result.signal ? ` (signal ${result.signal})` : ` (exit ${result.status ?? 1})`;
    console.error(`VISUAL_UI_GATE ${label} failed${suffix}`);
    return result.status ?? 1;
  }
  return 0;
}

const boundaryExit = run("renderer-boundary", rendererBoundaryVerifier, ["--json"]);
if (boundaryExit !== 0) process.exit(boundaryExit);
const artifactExit = run("client-artifacts", artifactVerifier);
if (artifactExit !== 0) process.exit(artifactExit);
if (artifactsOnly) {
  console.log("VISUAL_UI_GATE GREEN (artifacts-only)");
  process.exit(0);
}
const visualExit = run("visual-ui", visualVerifier);
if (visualExit !== 0) process.exit(visualExit);
console.log("VISUAL_UI_GATE GREEN");
