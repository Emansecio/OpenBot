import { argv, env, stderr, stdout } from "node:process";

const modeIndex = argv.indexOf("--mode");
const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "stream";
const providerIndex = argv.indexOf("--provider");
const provider = providerIndex >= 0 ? argv[providerIndex + 1] : "fixture";

const write = (value) => stdout.write(`${JSON.stringify(value)}\n`);

if (mode === "stderr-secret") {
  stderr.write(`fixture secret ${env.OPENBOT_TEST_SECRET ?? "missing"}\n`);
  write({ type: "error", code: "fixture_error", message: "fixture failed" });
  process.exitCode = 1;
} else if (mode === "oversized") {
  write({ type: "delta", text: "x".repeat(32_768) });
  write({ type: "done", cursor: "fixture-cursor-oversized" });
} else if (mode === "sleep") {
  write({ type: "session", provider, sessionId: "fixture-session-v1" });
  setInterval(() => write({ type: "heartbeat" }), 25);
} else {
  write({ type: "session", provider, sessionId: "fixture-session-v1" });
  write({ type: "delta", text: `${provider}-hello` });
  write({ type: "usage", inputTokens: 3, outputTokens: 1 });
  write({ type: "done", cursor: "fixture-cursor-v1" });
}
