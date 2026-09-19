import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Read-only client: never creates a token, launches the gateway or executes a bot. */
export async function executionDiagnostics(options = {}) {
  const env = options.env ?? process.env;
  const port = options.port ?? 1340;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local gateway port.");
  const dataRoot = env.OPENBOT_DATA_ROOT?.trim() || join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "OpenBot");
  const tokenPath = options.tokenPath ?? (env.OPENBOT_GATEWAY_TOKEN_PATH?.trim() || join(dataRoot, "gateway.token"));
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (token.length < 16 || token.length > 4096 || /[\r\n]/u.test(token)) throw new Error("Invalid gateway token file.");
  const response = await fetch(`http://127.0.0.1:${port}/api/getExecutionDiagnostics`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Execution diagnostics unavailable (HTTP ${response.status}). The updated gateway must be running.`);
  const envelope = await response.json();
  if (envelope?.ok !== true || envelope.value?.version !== 1) throw new Error("Invalid execution diagnostics response.");
  return envelope.value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  executionDiagnostics().then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    () => { console.error("Execution diagnostics unavailable. Check the running gateway version and local token path."); process.exitCode = 1; },
  );
}
