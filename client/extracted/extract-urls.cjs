// Find URL strings, fetch calls, and gateway endpoints in renderer bundles
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && (f.startsWith('index') || f.startsWith('chunk') || f.startsWith('view') || f.startsWith('connector')));

const urlRe = /["'`]((?:https?:)?\/\/[^"'`\s]{4,120})["'`]/g;
const fetchRe = /\bfetch\s*\(/g;
const wsRe = /new\s+WebSocket\s*\(/g;
const xhrRe = /XMLHttpRequest/g;

for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  const urls = new Map();
  let m;
  while ((m = urlRe.exec(code)) !== null) {
    const u = m[1];
    // dedupe, only show distinctive hosts
    urls.set(u, (urls.get(u) || 0) + 1);
  }
  const fetches = (code.match(fetchRe) || []).length;
  const wss = (code.match(wsRe) || []).length;
  if (urls.size || fetches || wss) {
    console.log(`\n===== ${f} | fetch=${fetches} WebSocket=${wss} =====`);
    [...urls.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25).forEach(([k,v])=>console.log(`  ${String(v).padStart(3)}  ${k}`));
  }
}
