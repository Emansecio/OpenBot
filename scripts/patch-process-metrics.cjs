// patch-process-metrics.cjs — endurecimento T17: neutraliza o reporter do
// SandProcessMetricsCollector (remove o client AiService). Substituição exata.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'client', 'extracted', 'dist', 'electron-main', 'main.cjs');
let src = fs.readFileSync(file, 'utf8');

const oldBlock = `          if (reporterInstance == null) {
            reporterInstance = new SandProcessMetricsReporter({
              client: createSandCursorBackendClient(AiService, {
                getAccessToken: async (options) => (await deps.ensureCursorAuthService()).getValidAccessToken(options),
                getMachineId: () => deps.getMachineId()
              }),
              meta: {
                os: process.platform,
                osVersion: (0, import_node_os14.release)(),
                arch: process.arch,
                clientVersion: deps.getClientVersion(),
                clientId: await deps.getMachineId()
              }
            });
          }`;

const newBlock = `          if (reporterInstance == null) {
            // OPENBOT PATCH T17 (harden): process-metrics reporter neutralized —
            // the AiService backend client (reportSandProcessMetrics egress) is
            // never constructed on OpenBot; report() stays a no-op sink.
            reporterInstance = {
              report: async () => {
              }
            };
          }`;

const idx = src.indexOf(oldBlock);
if (idx < 0) {
  console.error('OLD BLOCK NOT FOUND — nothing changed');
  process.exit(2);
}
src = src.slice(0, idx) + newBlock + src.slice(idx + oldBlock.length);

fs.writeFileSync(file, src, 'utf8');
console.log(`replaced @${idx} (removed ${oldBlock.length} chars, added ${newBlock.length} chars)`);
