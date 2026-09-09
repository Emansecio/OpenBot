import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateDpapiNativeArtifact } from "./release-common.mjs";

const root = resolve(import.meta.dirname, "..");
const arch = process.env.OPENBOT_TARGET_ARCH ?? process.arch;
if (process.platform !== "win32") {
  console.log("DPAPI_ARTIFACTS_SKIP_NON_WINDOWS");
  process.exit(0);
}
if (arch !== "x64") throw new Error(`unsupported architecture: ${arch}; only x64 DPAPI is currently produced`);
const file = join(root, "native", "dpapi", `win32-${arch}`, "openbot-dpapi.node");
if (!existsSync(file)) throw new Error(`missing DPAPI addon for win32-${arch}: ${file}`);
const metadata = statSync(file);
if (!metadata.isFile() || metadata.size < 1024) throw new Error(`invalid DPAPI addon file: ${file}`);
const header = readFileSync(file).subarray(0, 2).toString("ascii");
if (header !== "MZ") throw new Error(`DPAPI addon is not a Windows PE binary: ${file}`);
await validateDpapiNativeArtifact(file, arch);
console.log(`DPAPI_ARTIFACTS_GREEN arch=${arch} file=${file} bytes=${metadata.size}`);
