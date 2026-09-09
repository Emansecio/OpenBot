const fs = require('fs');
const c = fs.readFileSync('dist/renderer/assets/index-DVUCYGay.js', 'utf8');
// Look for event subscription names in coordinator bridge — likely "event:" strings or subscribe({...})
const terms = ['onEvent', 'event:', 'e:', 'subscribe(', 'transcript', 'replica', 'send-journal', 'roster', 'snapshot', 'update', 'stream', 'agent-update', 'entry-update', 'journal'];
// Find strings that look like coordinator events
const re = /"([a-z][a-z0-9\-\.\/:]{3,60})"/g;
const ev = new Map();
let m;
while ((m = re.exec(c)) !== null) {
  const v = m[1];
  if (/^(transcript|roster|agent|journal|entry|send|widget|tray|channel|room|automation|computer|box|teach|sharing|typing|notification|approval|secret|skill|workflow|listener|cloud|subagent|task|capabilit|sharing)/.test(v)) {
    ev.set(v, (ev.get(v) || 0) + 1);
  }
}
[...ev.entries()].sort((a,b)=>b[1]-a[1]).slice(0,160).forEach(([k,v])=>console.log(`${String(v).padStart(4)}  ${k}`));
