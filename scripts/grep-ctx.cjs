// grep-ctx.cjs <file> <pattern> [maxMatches] [ctxChars]
// Grep cirúrgico com contexto pequeno (~120 chars) e contagem, para bundle minificado.
const fs = require('fs');
const file = process.argv[2];
const pattern = process.argv[3];
const maxMatches = parseInt(process.argv[4] || '12', 10);
const ctx = parseInt(process.argv[5] || '120', 10);
const src = fs.readFileSync(file, 'utf8');
const re = new RegExp(pattern, 'g');
let m, count = 0;
const out = [];
while ((m = re.exec(src)) !== null && count < maxMatches) {
  count++;
  const i = m.index;
  const pre = src.slice(Math.max(0, i - ctx), i);
  const post = src.slice(i + m[0].length, i + m[0].length + ctx);
  out.push(`#${count} @${i} [${m[0].replace(/\n/g, '\\n')}]`);
  out.push(`  < ${pre.replace(/\n/g, '\\n')}`);
  out.push(`  > ${post.replace(/\n/g, '\\n')}`);
  if (m[0].length === 0) re.lastIndex++;
}
console.log(out.join('\n'));
console.log(`\nTOTAL_MATCHES(full)=${(src.match(new RegExp(pattern, 'g')) || []).length}  SHOWN=${count}`);
