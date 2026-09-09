const fs = require('fs');
const c = fs.readFileSync('dist/renderer/assets/index-DVUCYGay.js', 'utf8');
// Search for the payload builder for sendPrompt
const terms = ['hasMessageText', 'nonce:', 'clientNonce', 'isFork', 'sendPrompt({', 'content:', 'prompt:', 'attachments:', 'text:', 'author:'];
for (const t of terms) {
  let i = c.indexOf(t, 5700000);
  if (i < 0) i = c.indexOf(t, 800000);
  console.log('\n### ' + t + ' @ ' + i);
  if (i >= 0) console.log(c.slice(Math.max(0, i - 180), i + 380));
}
