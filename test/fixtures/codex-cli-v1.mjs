import { argv, env, stderr, stdout } from "node:process";
import { spawn } from "node:child_process";

const modeIndex = argv.indexOf("--mode");
const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "stream";
const protocol = "codex-cli.v1";
let sequence = 0;

const write = (type, payload = {}) => stdout.write(`${JSON.stringify({ protocol, sequence: ++sequence, type, ...payload })}\n`);

if (mode === "malformed") {
  stdout.write("{not-json\n");
} else if (mode === "eof") {
  write("session", { sessionId: "codex-fixture-session" });
  write("delta", { text: "partial" });
} else if (mode === "unknown") {
  write("session", { sessionId: "codex-fixture-session" });
  write("future.event", { value: "must-be-rejected" });
} else if (mode === "duplicate-terminal") {
  write("session", { sessionId: "codex-fixture-session" });
  write("done", { cursor: "codex-cursor-v1" });
  write("done", { cursor: "codex-cursor-duplicate" });
} else if (mode === "oversized") {
  write("session", { sessionId: "codex-fixture-session" });
  write("delta", { text: "x".repeat(32_768) });
} else if (mode === "sleep" || mode === "ignore-term" || mode === "descendant") {
  write("session", { sessionId: "codex-fixture-session" });
  write("child-start", { pid: process.pid });
  if (mode === "descendant") {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "--mode", "sleep"], {
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    write("descendant-start", { pid: child.pid });
  }
  if (mode === "ignore-term") process.on("SIGTERM", () => undefined);
  setInterval(() => write("heartbeat"), 25);
} else if (mode === "stderr-secret") {
  stderr.write(`fixture secret ${env.OPENBOT_TEST_SECRET ?? "missing"}\n`);
  process.exitCode = 1;
} else if (mode === "tools") {
  write("session", { sessionId: "codex-fixture-session" });
  write("tool-call", { id: "call-codex-1", name: "fixture_tool", arguments: "{}" });
  write("done", { cursor: "codex-cursor-tools-v1" });
} else {
  write("session", { sessionId: "codex-fixture-session" });
  write("delta", { text: "codex-fixture-hello" });
  write("usage", { inputTokens: 3, outputTokens: 1, totalTokens: 4 });
  write("done", { cursor: "codex-cursor-v1" });
}
