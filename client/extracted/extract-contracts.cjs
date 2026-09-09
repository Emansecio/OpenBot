// Hunt for data-contract / protocol strings in the renderer bundles.
const fs = require('fs');
const path = require('path');

const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['index-DVUCYGay.js'];

function extractStrings(code) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const pats = process.argv[3] ? new RegExp(process.argv[3], 'i') : /(sessionId|conversationId|agentId|requestId|toolCall|toolResult|tool_use|toolUse|role|streaming|delta|thinking|turn|transcript|messageType|type:|kind:|content|text|status|error|approval|permission|progress|plan)/i;

const h = {};
for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const s of extractStrings(code)) {
    if (s.length >= 2 && s.length <= 60 && pats.test(s)) h[s] = (h[s] || 0) + 1;
  }
}
Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, 300)
  .forEach(([k, v]) => console.log(`${String(v).padStart(5)}\t${k}`));
