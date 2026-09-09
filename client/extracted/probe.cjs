const fs = require('fs');
const c = fs.readFileSync('dist/renderer/assets/index-DVUCYGay.js', 'utf8');
const terms = ['tool-call', 'kind:"tool', 'toolUseId', 'kind:"message"', 'local-tool-permission', 'auto-review', 'AskQuestion', 'kind:"ask', 'approval', 'widget'];
for (const t of terms) {
  let i = c.indexOf(t, 0);
  let n = 0;
  while (i >= 0 && n < 3) {
    console.log('\n### ' + t + ' @ ' + i);
    console.log(c.slice(Math.max(0, i - 120), i + 500));
    i = c.indexOf(t, i + 1);
    n++;
  }
  if (n === 0) console.log('\n### ' + t + ': NOT FOUND');
}
