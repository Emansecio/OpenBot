import { readFileSync, writeFileSync } from "node:fs";
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
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.compatBaseUrl = commandcodeUrl;
if (!config.activeProvider) config.activeProvider = "xai";
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

const names = await keystore.list();
console.log(JSON.stringify({
  ok: true,
  configPath,
  compatBaseUrl: config.compatBaseUrl,
  stored: names.sort(),
}, null, 2));
