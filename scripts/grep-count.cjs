// grep-count.cjs <file> <pattern> [maxMatches]
// Lista TODAS as posições/trechos curtos de um padrão (sem contexto) — para contagens.
const fs = require('fs');
const file = process.argv[2];
const pattern = process.argv[3];
const maxMatches = parseInt(process.argv[4] || '40', 10);
const src = fs.readFileSync(file, 'utf8');
const re = new RegExp(pattern, 'g');
let m, count = 0;
const out = [];
while ((m = re.exec(src)) !== null && count < maxMatches) {
  count++;
  const i = m.index;
  out.push(`@${i} [...${src.slice(Math.max(0, i - 60), i + m[0].length + 60).replace(/\n/g, '\\n')}...]`);
  if (m[0].length === 0) re.lastIndex++;
}
console.log(out.join('\n'));
console.log(`\nTOTAL_MATCHES(full)=${(src.match(new RegExp(pattern, 'g')) || []).length}  SHOWN=${count}`);
