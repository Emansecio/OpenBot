import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryProcessEvidence } from "./release-common.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedExecutable = resolve(process.execPath);
const expectedGatewayScript = resolve(join(root, "dist", "main.js"));
const mode = process.argv[2];
const expectedPid = process.argv[3] == null ? null : Number(process.argv[3]);

if (mode !== "check" && mode !== "wait" && mode !== "pid") {
  process.exit(2);
}
if (expectedPid != null && !Number.isInteger(expectedPid)) {
  process.exit(2);
}

const attempts = mode === "wait" ? 50 : 1;
for (let attempt = 0; attempt < attempts; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:1340/health", {
      signal: AbortSignal.timeout(1_000),
    });
    const health = await response.json();
    if (response.ok && health?.ok === true && Number.isInteger(health.pid) && (expectedPid == null || health.pid === expectedPid)) {
      const evidence = await queryProcessEvidence(health.pid);
      const owned = evidence?.executablePath != null
        && evidence.commandLine != null
        && resolve(evidence.executablePath).toLowerCase() === expectedExecutable.toLowerCase()
        && evidence.commandLine.toLowerCase().includes(expectedGatewayScript.toLowerCase());
      if (owned) {
        if (mode === "pid") process.stdout.write(String(health.pid));
        process.exit(0);
      }
    }
  } catch {
    // The gateway is still starting or is not listening.
  }
  if (attempt + 1 < attempts) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

process.exit(1);
