import { rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [mainPath, readyPath] = process.argv.slice(2);
if (!mainPath || !readyPath) throw new Error("usage: electron-p23-backend-fixture.mjs <main.js> <ready.json>");

const { startServer, stopServer } = await import(pathToFileURL(mainPath).href);
const handle = await startServer(0);
const readyTemporaryPath = `${readyPath}.${process.pid}.tmp`;
try {
  await writeFile(readyTemporaryPath, JSON.stringify({ pid: process.pid, requestedPort: 0, port: handle.port }), "utf8");
  await rename(readyTemporaryPath, readyPath);
} catch (error) {
  await unlink(readyTemporaryPath).catch(() => undefined);
  throw error;
}

let stopping;
const stop = () => {
  stopping ??= stopServer(handle).finally(() => process.exit(0));
  return stopping;
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
console.log(`P23_BACKEND_READY ${handle.port}`);
await new Promise(() => {});
