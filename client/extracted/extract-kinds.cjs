// Extract strings around "kind:" values to find the message union shape
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const f = process.argv[2] || 'index-DVUCYGay.js';
const code = fs.readFileSync(path.join(dir, f), 'utf8');

// find kind:"..." occurrences and collect distinct values
const re = /kind:\s*"([A-Za-z0-9_\-\.]+)"/g;
const vals = new Map();
let m;
while ((m = re.exec(code)) !== null) vals.set(m[1], (vals.get(m[1]) || 0) + 1);
console.log('==== kind: "..." VALUES ====');
[...vals.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${String(v).padStart(5)}  ${k}`));

// also find "role:" string values
const re2 = /role:\s*"([A-Za-z0-9_\-]+)"/g;
const vals2 = new Map();
while ((m = re2.exec(code)) !== null) vals2.set(m[1], (vals2.get(m[1]) || 0) + 1);
console.log('\n==== role: "..." VALUES ====');
[...vals2.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${String(v).padStart(5)}  ${k}`));

// state / status values
for (const key of ['status', 'state', 'phase', 'tone']) {
  const r = new RegExp(`${key}:\\s*"([A-Za-z0-9_\\-]+)"`, 'g');
  const vv = new Map();
  while ((m = r.exec(code)) !== null) vv.set(m[1], (vv.get(m[1]) || 0) + 1);
  if (vv.size) {
    console.log(`\n==== ${key}: "..." VALUES ====`);
    [...vv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).forEach(([k, v]) => console.log(`${String(v).padStart(5)}  ${k}`));
  }
}
