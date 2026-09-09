// Auditoria estática dos patches T15/T17 — extrai janelas ao redor de padrões-chave.
const fs = require('fs');
const path = 'C:/SuperAgent/openbot/client/extracted/dist/electron-main/main.cjs';
const src = fs.readFileSync(path, 'utf8');

const checks = [
  ['T15 status local', /status\s*:\s*"local"/],
  ['T15 access full', /access\s*:\s*"full"/],
  ['T15 usage null', /getWeeklyUsage|getUsageSummary/],
  ['T15 client id OAuth', /KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB/],
  ['T15 auth poll', /auth\/poll/],
  ['T17 update off', /status\s*:\s*"off"/],
  ['T17 sentry dsn', /metrics\.cursor\.sh/],
  ['T17 statsig', /statsigcdn\.com/],
  ['T17 tev1', /tev1/],
  ['T17 updates api', /updates\/api/],
  ['T17 cursorvm', /cursorvm\.com/],
  ['T17 api2', /api2\.cursor\.sh/],
];

for (const [label, re] of checks) {
  const matches = [];
  let m;
  const g = new RegExp(re.source, 'g');
  while ((m = g.exec(src)) !== null && matches.length < 3) {
    const start = Math.max(0, m.index - 120);
    const end = Math.min(src.length, m.index + 120);
    matches.push(src.slice(start, end).replace(/\n/g, ' '));
  }
  console.log(`\n=== ${label} (${matches.length}${matches.length === 3 ? '+' : ''} matches) ===`);
  matches.forEach((w, i) => console.log(`  [${i}] ...${w}...`));
}
