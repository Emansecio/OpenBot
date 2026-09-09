// Context dump: find app shell / tabs / message kinds / views in main bundle.
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const f = process.argv[2] || 'index-DVUCYGay.js';
const code = fs.readFileSync(path.join(dir, f), 'utf8');

function show(term, before = 260, after = 700, limit = 3) {
  let idx = 0, shown = 0;
  while (shown < limit) {
    idx = code.indexOf(term, idx);
    if (idx < 0) break;
    const s = Math.max(0, idx - before);
    const len = Math.min(code.length - s, before + after);
    console.log(`\n----- [${term}] @ ${idx} -----`);
    console.log(code.slice(s, s + len));
    idx += term.length;
    shown++;
  }
}

// Tab-related
for (const t of ['"chat"', '"terminal"', '"diff"', '"preview"', '"composer"', '"onboarding"', '"settings"', '"history"', '"plan"', '"computer"', '"vnc"', '"docs"']) {
  const n = (code.match(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  console.log(`COUNT ${t} = ${n}`);
}
