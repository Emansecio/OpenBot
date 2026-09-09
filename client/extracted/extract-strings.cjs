// Analyze minified renderer bundle: extract string literals and categorize.
const fs = require('fs');
const path = require('path');

const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const files = process.argv.slice(2);
if (files.length === 0) files.push('index-DVUCYGay.js');

// Match string literals: double-quoted, single-quoted, and backtick template literals
function extractStrings(code) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const s = m[1] ?? m[2] ?? m[3];
    out.push(s);
  }
  return out;
}

const interesting = {};
const counts = {};
const prefixCounts = {};

for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  const strs = extractStrings(code);
  for (const s of strs) {
    counts[s] = (counts[s] || 0) + 1;
    if (s.length >= 4 && s.length <= 64) {
      // categorize
      if (/^(agent|tool|message|msg|view|screen|tab|panel|terminal|computer|diff|preview|chat|session|box|onboarding|settings|sidebar|composer|history|model)/i.test(s)) {
        interesting[s] = (interesting[s] || 0) + 1;
      }
    }
  }
}

console.log('==== INTERESTING (feature-like) strings ====');
Object.entries(interesting)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 200)
  .forEach(([k, v]) => console.log(`${v}\t${k}`));

console.log('\n==== TOP 60 overall strings ====');
Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 60)
  .forEach(([k, v]) => console.log(`${v}\t${JSON.stringify(k)}`));
