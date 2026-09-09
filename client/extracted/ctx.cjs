// Show context windows around important tokens in a bundle.
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const f = process.argv[2] || 'index-DVUCYGay.js';
const code = fs.readFileSync(path.join(dir, f), 'utf8');

const terms = process.argv.slice(3);
const before = parseInt(process.argv[4] || '200', 10);
const after = parseInt(process.argv[5] || '500', 10);
const limit = parseInt(process.argv[6] || '2', 10);

for (const term of terms) {
  let idx = 0, shown = 0;
  while (shown < limit) {
    idx = code.indexOf(term, idx);
    if (idx < 0) break;
    const s = Math.max(0, idx - before);
    const len = Math.min(code.length - s, before + after);
    console.log(`\n\n########## [${term}] @ ${idx} ##########`);
    console.log(code.slice(s, s + len));
    idx += term.length;
    shown++;
  }
  if (shown === 0) console.log(`\n### [${term}] NOT FOUND`);
}
