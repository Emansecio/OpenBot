const fs = require('fs');
const c = fs.readFileSync('dist/renderer/assets/index-DVUCYGay.js', 'utf8');
const terms = ['"meet"', '"computer-demo"', '"jobs"', '"done"', '"launch"', '"intro"', 'step==="', 'mee', 'LQe', 'DQe', 'RQe', '"welcome"', '"name"', '"avatar"'];
for (const t of terms) {
  const idx = c.indexOf(t, 5890000);
  console.log(t, '=>', idx);
  if (idx >= 0 && idx < 6000000) console.log('  ', c.slice(idx - 40, idx + 80).replace(/\n/g, ' '));
}
