// Auditoria fina — rodada 2: marcadores de patch e formas alternativas.
const fs = require('fs');
const src = fs.readFileSync('C:/SuperAgent/openbot/client/extracted/dist/electron-main/main.cjs', 'utf8');

const checks = [
  ['marcador T15', /OPENBOT PATCH T15/g],
  ['marcador T17', /OPENBOT PATCH T17/g],
  ['getSandAccess', /getSandAccess/g],
  ['cursorAuth getStatus', /cursorAuth|cursor_auth/g],
  ['status local (aspas simples)', /status:'local'/g],
  ['access full (aspas simples)', /access:'full'/g],
  ['local profile', /localProfile|local-profile|perfil local/gi],
  ['updateStatus', /getUpdateStatus|updateStatus/gi],
  ['autoUpdater', /autoUpdater/g],
  ['loginItem/openAtLogin', /openAtLogin|loginItem/g],
];

for (const [label, re] of checks) {
  const matches = [];
  let m;
  while ((m = re.exec(src)) !== null && matches.length < 4) {
    const start = Math.max(0, m.index - 150);
    const end = Math.min(src.length, m.index + 150);
    matches.push(src.slice(start, end).replace(/\n/g, ' '));
  }
  console.log(`\n=== ${label} (${matches.length}${matches.length === 4 ? '+' : ''}) ===`);
  matches.forEach((w, i) => console.log(`  [${i}] ...${w}...`));
}
