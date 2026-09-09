// Search for specific protocol-relevant strings across all renderer bundles.
const fs = require('fs');
const path = require('path');
const dir = 'C:/SuperAgent/grokbot-src/extracted/dist/renderer/assets';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));

const patterns = [
  // backend coupling
  /api2\.cursor\.sh/i, /cursor\.sh/i, /cursor\.com/i, /cloudflare/i, /gateway/i,
  // message kind values
  /["'`](user|assistant|system|agent|tool|thinking|plan|human|model|bot)["'`]/i,
  // tool names (cursor-style)
  /apply_patch|applyPatch|read_file|readFile|write_file|writeFile|edit_file|editFile|run_terminal|terminal_command|execute_command|shell|grep|glob|list_dir|search|web_search|webSearch|fetch_url|open_url|computer|click|type_text|screenshot|notebook|task|agent_tool|mcp/i,
  // streaming events
  /streamStart|streamstart|onText|textDelta|toolUseDelta|messageDelta|stream_end|streamEnd|done|finalMessage|partial/i,
  // protocol-ish
  /protobuf|proto3|connectrpc|grpc|websocket|ws:\/\//i,
];

const hits = {};
for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const p of patterns) {
    const re = new RegExp(p.source, 'gi');
    let m;
    while ((m = re.exec(code)) !== null) {
      const s = m[0];
      const key = s.length <= 60 ? s : s.slice(0, 60);
      hits[key] = hits[key] || { count: 0, files: new Set() };
      hits[key].count++;
      hits[key].files.add(f);
    }
  }
}
Object.entries(hits).sort((a, b) => b[1].count - a[1].count)
  .slice(0, 200)
  .forEach(([k, v]) => console.log(`${String(v.count).padStart(5)}  ${[...v.files].slice(0,4).join(',')}  ${k}`));
