// Find enum-like definitions: "X=0","X=1" patterns and kind dispatchers
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['index-DVUCYGay.js', 'messages-ByIkiGdI.js', 'index-B53yfdff.js'];

for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  console.log(`\n========== ${f} ==========`);
  // find enum numeric assignments: Name=0,Name=1,Name=2,Name=3,Name=4,Name=5
  const re = /[a-zA-Z_$][\w$]*\[[a-zA-Z_$][\w$]*\.([A-Z][\w]+)=(\d+)\]/g;
  const m2 = /[a-zA-Z_$][\w$]*\[[a-zA-Z_$][\w$]*\.([A-Z][\w]+)=\d+\]/g;
  const set = new Map();
  let m;
  while ((m = m2.exec(code)) !== null) {
    set.set(m[1], (set.get(m[1]) || 0) + 1);
  }
  if (set.size) {
    console.log('-- enum-ish member names --');
    [...set.entries()].sort((a,b)=>b[1]-a[1]).slice(0,120).forEach(([k,v])=>console.log(`${String(v).padStart(4)}  ${k}`));
  }
}
