// Dump context around named internals referenced at the app root.
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const code = fs.readFileSync(path.join(dir, 'index-DVUCYGay.js'), 'utf8');

function ctx(term, before, after, limit = 1) {
  let idx = 0, n = 0;
  while (n < limit) {
    idx = code.indexOf(term, idx);
    if (idx < 0) { console.log(`\n### ${term}: NOT FOUND`); return; }
    const s = Math.max(0, idx - before);
    console.log(`\n####### ${term} @ ${idx} #######`);
    console.log(code.slice(s, s + before + after));
    idx += term.length;
    n++;
  }
}

// Wfe = root variant app component
ctx('function Wfe', 100, 1600, 1);
