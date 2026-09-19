import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileExclusiveSync } from "../shared/fs-atomic.js";
import { homedir } from "node:os";
import type { IncomingMessage } from "node:http";

export function defaultGatewayTokenPath(): string {
  const explicitRoot = process.env.OPENBOT_DATA_ROOT?.trim();
  if (explicitRoot) return join(explicitRoot, "gateway.token");
  const appData = process.env.APPDATA;
  const root = appData && appData.length > 0 ? appData : join(homedir(), "AppData", "Roaming");
  return join(root, "OpenBot", "gateway.token");
}

export function resolveGatewayTokenPath(options: { configPath?: string; stateRoot?: string } = {}): string {
  const explicitPath = process.env.OPENBOT_GATEWAY_TOKEN_PATH?.trim();
  if (explicitPath) return resolve(explicitPath);
  const explicitRoot = process.env.OPENBOT_DATA_ROOT?.trim();
  if (explicitRoot) return join(explicitRoot, "gateway.token");
  if (options.stateRoot?.trim()) return join(resolve(options.stateRoot), "gateway.token");
  if (options.configPath?.trim()) return join(dirname(resolve(options.configPath)), "gateway.token");
  return defaultGatewayTokenPath();
}

export function loadOrCreateGatewayToken(file = defaultGatewayTokenPath()): string {
  const readValid = (): string => {
    const current = readFileSync(file, "utf8").trim();
    if (current.length < 16) throw new Error("gateway token file is invalid");
    return current;
  };
  try {
    return readValid();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(file), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  try {
    writeFileExclusiveSync(file, `${token}\n`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readValid();
  }
}

export function tokenFromRequest(req: IncomingMessage, queryToken?: string | null): string {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
    return match?.[1]?.trim() ?? "";
  }
  const headerToken = req.headers["x-openbot-token"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();
  if (typeof queryToken === "string" && queryToken.trim()) return queryToken.trim();
  return "";
}
