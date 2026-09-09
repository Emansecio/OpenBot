#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? process.env.OPENBOT_DESCRIPTOR_PATH ?? "openbot-local-descriptor.json");
const port = Number(process.env.OPENBOT_GATEWAY_PORT ?? 1340);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPENBOT_GATEWAY_PORT inválida");
const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
const tokenRoot = process.env.OPENBOT_DATA_ROOT?.trim() || join(appData, "OpenBot");
const explicitTokenPath = process.env.OPENBOT_GATEWAY_TOKEN_PATH?.trim();
const tokenFile = explicitTokenPath || join(tokenRoot, "gateway.token");
let token = "";
if (explicitTokenPath) {
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error(`Token do gateway ausente: inicie o gateway ou defina SAND_HOST_GATEWAY_TOKEN (${tokenFile})`);
  }
} else {
  token = process.env.SAND_HOST_GATEWAY_TOKEN?.trim() || process.env.OPENBOT_GATEWAY_TOKEN?.trim() || "";
  if (!token) {
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch {
      throw new Error(`Token do gateway ausente: inicie o gateway ou defina SAND_HOST_GATEWAY_TOKEN (${tokenFile})`);
    }
  }
}
if (token.length < 16) throw new Error("Token do gateway vazio ou inválido; descriptor não foi gerado");
const descriptor = {
  version: 1,
  gatewayUrl: `http://127.0.0.1:${port}`,
  networkToken: null,
  local: true,
  env: {
    SAND_HOST_GATEWAY_URL: `http://127.0.0.1:${port}`,
    SAND_HOST_GATEWAY_TOKEN: token,
    SAND_HOST_GATEWAY_NETWORK_TOKEN: "",
  },
};
mkdirSync(dirname(output), { recursive: true });
const temp = `${output}.${process.pid}.tmp`;
try {
  writeFileSync(temp, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const { renameSync, rmSync } = await import("node:fs");
  renameSync(temp, output);
  console.log(output);
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(temp, { force: true });
}
