// diff-regions.cjs — extrai regiões alteradas entre main.cjs.original e main.cjs
// (sem carregar o conteúdo na conversa: grava em patches\diff-t15-t17.txt)
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'client', 'extracted', 'dist', 'electron-main');
const A = fs.readFileSync(path.join(DIR, 'main.cjs.original'), 'utf8');
const B = fs.readFileSync(path.join(DIR, 'main.cjs'), 'utf8');

const CTX = 200;      // contexto antes/depois (~200 chars)
const W = 48;         // janela de re-sincronização
const MAX_SCAN = 40000; // limite de procura por região

const out = [];
out.push(`# DIFF main.cjs.original (A, ${A.length} chars) vs main.cjs (B, ${B.length} chars)`);
out.push(`# gerado por scripts/diff-regions.cjs em ${new Date().toISOString()}`);
out.push('');

function window(s, i, len) {
  return s.slice(i, i + len);
}

let i = 0, j = 0, n = 0;
const regions = [];

while (i < A.length && j < B.length) {
  // avança enquanto igual
  if (A[i] === B[j]) { i++; j++; continue; }

  // mismatch: registra início
  const a0 = i, b0 = j;
  let ai = -1, bj = -1;

  // tenta resincronizar: procura janela de A em B a partir de b0+1
  const wA = window(A, i + 1, W);
  let p = wA.length >= 8 ? B.indexOf(wA, j + 1) : -1;
  let dA = (p < 0) ? Infinity : (p - j);

  // procura janela de B em A a partir de a0+1
  const wB = window(B, j + 1, W);
  let q = wB.length >= 8 ? A.indexOf(wB, i + 1) : -1;
  let dB = (q < 0) ? Infinity : (q - i);

  if (dA === Infinity && dB === Infinity) {
    // fallback: janela menor
    const wA2 = window(A, i + 1, 16);
    p = wA2.length >= 8 ? B.indexOf(wA2, j + 1) : -1;
    dA = (p < 0) ? Infinity : (p - j);
    const wB2 = window(B, j + 1, 16);
    q = wB2.length >= 8 ? A.indexOf(wB2, i + 1) : -1;
    dB = (q < 0) ? Infinity : (q - i);
  }

  if (dA === Infinity && dB === Infinity) {
    // sem re-sync: região vai até o fim (provável fim do arquivo)
    ai = A.length; bj = B.length;
  } else if (dA <= dB) {
    ai = i + 1; bj = p;
  } else {
    ai = q; bj = j + 1;
  }

  // recorta contexto
  const aCtx = A.slice(Math.max(0, a0 - CTX), Math.min(A.length, ai + CTX));
  const bCtx = B.slice(Math.max(0, b0 - CTX), Math.min(B.length, bj + CTX));
  const aLead = a0 > CTX ? '…' : '';
  const bLead = b0 > CTX ? '…' : '';
  const aTail = ai + CTX < A.length ? '…' : '';
  const bTail = bj + CTX < B.length ? '…' : '';

  regions.push({ a0, aLen: ai - a0, b0, bLen: bj - b0 });
  n++;
  out.push(`=== REGION ${n} (A@${a0} len=${ai - a0} | B@${b0} len=${bj - b0}) ===`);
  out.push(`--- ORIGINAL ---`);
  out.push(aLead + aCtx + aTail);
  out.push(`--- PATCHED ---`);
  out.push(bLead + bCtx + bTail);
  out.push('');

  i = ai; j = bj;
  if (n > 500) { out.push('# CAP 500 regiões'); break; }
}

const outPath = path.join(__dirname, '..', 'patches', 'diff-t15-t17.txt');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join('\n'), 'utf8');

let totalA = 0, totalB = 0;
for (const r of regions) { totalA += r.aLen; totalB += r.bLen; }
console.log(`regions=${n} removedChars=${totalA} addedChars=${totalB} -> ${outPath}`);
