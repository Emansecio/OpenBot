const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const mainFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, "client/extracted/dist/electron-main/main.cjs");
const daemonFile = path.join(projectRoot, "client/extracted/dist/local-exec-daemon/main.cjs");
const main = fs.readFileSync(mainFile, "utf8");
const daemon = fs.readFileSync(daemonFile, "utf8");

const checks = [
  ["local descriptor connector", /EnvDescriptorHostConnector/, main, true],
  ["broker connector fallback", /new BrokeredHostConnector/, main, true],
  ["loopback opt-in", /OPENBOT_LOCAL_GATEWAY === "1"/, main, true],
  ["unsafe loopback default", /OPENBOT_LOCAL_GATEWAY !== "0"/, main, false],
  ["real remote MCP marketplace path detected", /async function fetchMarketplaceMcpPlugins[\s\S]{0,1200}client\.listMarketplacePlugins/, main, true],
  ["remote MCP catalog guarded in local mode", /async getCatalog\(getAccessToken, options\) \{[\s\S]{0,300}OPENBOT_LOCAL_GATEWAY === "1"\) return \[\];[\s\S]{0,500}fetchMarketplaceMcpPlugins/, main, true],
  ["remote MCP warmup guarded in local mode", /fillCatalogCacheBeforeRendererReads\(\) \{[\s\S]{0,250}OPENBOT_LOCAL_GATEWAY === "1"\) return;/, main, true],
  ["remote MCP popularity guarded in local mode", /"sand:mcp-team-popularity"[\s\S]{0,180}OPENBOT_LOCAL_GATEWAY === "1"\) return \{\};/, main, true],
  ["remote MCP logo fetch guarded in local mode", /"sand:mcp-plugin-logo"[\s\S]{0,180}OPENBOT_LOCAL_GATEWAY === "1"\) return null;/, main, true],
  ["default model RPC uses authenticated provider helper", /callOpenBotProviderRpc2\("getAgentDefaultModel"\)[\s\S]{0,900}callOpenBotProviderRpc2\("setAgentDefaultModel"/, main, true],
  ["default model raw unauthenticated RPC", /fetch\("http:\/\/127\.0\.0\.1:1340\/api\/(?:get|set)AgentDefaultModel/, main, false],
  ["Cursor API URL executable", /fetch\([^)]*api2\.cursor\.sh|new URL\([^)]*api2\.cursor\.sh/, main, false],
  ["Cursor auth client id active", /startDevHostTokenHandoff\([^)]*PROD_AUTH_CLIENT_ID|PROD_AUTH_CLIENT_ID[^;]*(?:fetch|request)/, main, false],
  ["auth polling guarded in local mode", /function pollAuthenticationStatus[\s\S]{0,350}OPENBOT_LOCAL_GATEWAY === "1"\) return null;[\s\S]{0,350}pollingEndpoint/, main, true],
  ["Statsig polling active", /this\.pollHandle = this\.refreshPoll\.start/, main, false],
  ["Statsig cache hydration active", /const cached3 = loadCachedBootstrap\(this\.options\.getCacheDir\(\)\)/, main, false],
  ["desktop Sentry active", /initSandSentryForDesktop\(\{\s*enabled:\s*true/, main, false],
  ["daemon telemetry kill switch", /function initSandSentryDaemon\(\) \{\s*if \(process\.env\.SAND_DISABLE_TELEMETRY === "1"\) return void 0;/, daemon, true],
];

let failed = false;
for (const [label, pattern, source, expected] of checks) {
  const found = pattern.test(source);
  console.log(`${found ? "FOUND" : "absent"}: ${label}`);
  if (found !== expected) failed = true;
}
if (failed) process.exitCode = 1;
