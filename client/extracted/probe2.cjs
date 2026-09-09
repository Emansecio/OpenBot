const fs = require('fs');
const c = fs.readFileSync('dist/renderer/assets/index-DVUCYGay.js', 'utf8');
// Find transcript event type names: strings like "pushed", "entry-pushed", "update"
const target = c.indexOf('ingestTranscriptEvent');
console.log('ingestTranscriptEvent @', target);
// Search nearby region (transcript store definition ~ 6.1-6.2M)
const seg = c.slice(5800000, 6230000);
const re = /"(pushed|entry-pushed|entry-updated|entry-removed|append|update|snapshot|entries|reset|restore|cleared|undo)"[^}]{0,40}case/g;
let m, found = new Map();
while ((m = re.exec(seg)) !== null) {
  found.set(m[1], (found.get(m[1]) || 0) + 1);
}
console.log(found);
// Also find the Q reducer function by looking for "case\"snapshot\"" occurrences
let idx = 0, n = 0;
while ((idx = c.indexOf('case"snapshot"', idx + 1)) >= 0 && n < 10) {
  console.log('case"snapshot" @', idx, '::', c.slice(Math.max(0, idx - 60), idx + 80).replace(/\n/g, ' '));
  n++;
}
