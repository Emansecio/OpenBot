const fs = require('fs');
const c = fs.readFileSync('dist/renderer/assets/connector-card-BwCJobd1.js', 'utf8');
const re = /"([a-z][a-z0-9\-]{4,40})"/gi;
const h = {};
let m;
while ((m = re.exec(c)) !== null) {
  const v = m[1];
  if (v.startsWith('sand-') || v.startsWith('ui-')) continue;
  h[v] = (h[v] || 0) + 1;
}
Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 80).forEach(([k, v]) => console.log(String(v).padStart(4), k));
