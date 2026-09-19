import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const user = join(homedir());
const pitAuth = JSON.parse(readFileSync(join(user, ".pit", "agent", "auth.json"), "utf8"));
const pitModels = JSON.parse(readFileSync(join(user, ".pit", "agent", "models.json"), "utf8"));
const piModels = JSON.parse(readFileSync(join(user, ".pi", "agent", "models.json"), "utf8"));
const clineProviders = JSON.parse(readFileSync(join(user, ".cline", "data", "settings", "providers.json"), "utf8"));

const xai = typeof pitAuth.xai?.access === "string" ? pitAuth.xai.access : null;
const openai = clineProviders.providers?.["openai-native"]?.settings?.apiKey
  ?? pitAuth["openai-codex"]?.access
  ?? null;
const clinepass = piModels.providers?.clinepass?.apiKey ?? null;
const commandcode = pitModels.providers?.commandcode?.apiKey
  ?? piModels.providers?.commandcode?.apiKey
  ?? null;
const commandcodeUrl = pitModels.providers?.commandcode?.baseUrl
  ?? "https://api.commandcode.ai/provider/v1";

const missing = Object.entries({ xai, openai, clinepass, commandcode })
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length > 0) {
  console.error(`missing credentials: ${missing.join(", ")}`);
  process.exit(1);
}

const { createKeystore } = await import(pathToFileURL(join(process.cwd(), "dist", "keystore", "index.js")).href);
const keystore = createKeystore();
await keystore.upsert("xai", xai);
await keystore.upsert("openai", openai);
await keystore.upsert("clinepass", clinepass);
await keystore.upsert("commandcode", commandcode);
await keystore.upsert("openai-compat", commandcode);

const configPath = join(process.env.APPDATA || join(user, "AppData", "Roaming"), "OpenBot", "openbot-config.json");
// This .mjs can't import ConfigStore (TS), so it re-enforces the invariants
// its raw write used to bypass: refuse to write under a live .lock, bump the
// CAS revision so readers notice the external change, and persist atomically
// (exclusive tmp + fsync + rename) so a crash can't leave a torn config.
const lockPath = `${configPath}.lock`;
if (existsSync(lockPath)) {
  let lockPid;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof lock?.pid === "number") lockPid = lock.pid;
  } catch {
    // An unreadable/invalid lock file does not block.
  }
  let alive = false;
  if (Number.isInteger(lockPid) && lockPid > 0) {
    try {
      process.kill(lockPid, 0);
      alive = true;
    } catch (error) {
      alive = error?.code !== "ESRCH";
    }
  }
  if (alive) {
    console.error(`openbot-config.json is locked by a running OpenBot (pid ${lockPid}); close OpenBot before running this import.`);
    process.exit(1);
  }
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.compatBaseUrl = commandcodeUrl;
if (!config.activeProvider) config.activeProvider = "xai";
config.revision = (Number.isSafeInteger(config.revision) ? config.revision : 0) + 1;
const tmpPath = `${configPath}.${randomUUID()}.tmp`;
try {
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, configPath);
} finally {
  try {
    unlinkSync(tmpPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const names = await keystore.list();
console.log(JSON.stringify({
  ok: true,
  configPath,
  compatBaseUrl: config.compatBaseUrl,
  stored: names.sort(),
}, null, 2));
