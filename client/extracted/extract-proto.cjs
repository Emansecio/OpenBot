// Extract protobuf type names, field lists, and RPC channel names.
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const f = process.argv[2] || 'index-DVUCYGay.js';
const code = fs.readFileSync(path.join(dir, f), 'utf8');

// 1. proto type names: "pkg.v1.TypeName"
const re = /"([a-z][a-z0-9_]*\.v\d\.[A-Za-z0-9_\.]+)"/g;
const types = new Map();
let m;
while ((m = re.exec(code)) !== null) types.set(m[1], (types.get(m[1]) || 0) + 1);
console.log('==== PROTO TYPE NAMES ====');
[...types.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([k, v]) => console.log(`${String(v).padStart(4)}  ${k}`));

// 2. typeName= assignments (protobuf message classes)
const re2 = /typeName="([^"]+)"/g;
const t2 = new Set();
while ((m = re2.exec(code)) !== null) t2.add(m[1]);
console.log('\n==== typeName= (message classes) ====');
[...t2].sort().forEach(k => console.log(k));

// 3. RPC channels used by renderer
const re3 = /(?:sand-rpc|sand:)([a-zA-Z0-9\-\/:\.]+)/g;
const ch = new Map();
while ((m = re3.exec(code)) !== null) ch.set(m[0], (ch.get(m[0]) || 0) + 1);
console.log('\n==== sand RPC/IPC channels (top 150) ====');
[...ch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 150).forEach(([k, v]) => console.log(`${String(v).padStart(4)}  ${k}`));

// 4. coordinator message kinds
const re4 = /coordinatorPort|postMessage\(/g;
console.log('\ncoordinatorPort refs: ' + (code.match(/coordinatorPort/g) || []).length);
