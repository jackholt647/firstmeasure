// Applies development copy edits to the code (docs/architecture/guided-experiences.md, "Development").
//
//   1. On dev, as a platform administrator: GET /v1/guided-experiences/dev/copy/export > copy.json
//   2. Here: node public/v1/scripts/guided-copy-apply.mjs copy.json      (dry run: prints what would change)
//            node public/v1/scripts/guided-copy-apply.mjs copy.json --write
//   3. Review the diff and commit. Each edit replaces one key's English beside the key, in the file the export named.
//      A reworded key keeps its key only while the language catalog has no entry for it (catalog English wins over the
//      inline text); if it has one, update catalog-source.json with the export's `catalog` too.
import fs from 'node:fs';
import path from 'node:path';

const [file, flag] = process.argv.slice(2);
if (!file) { console.error('Usage: node guided-copy-apply.mjs <export.json> [--write]'); process.exit(2); }
const root = path.resolve(import.meta.dirname, '../../..');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const edits = Array.isArray(data.edits) ? data.edits : [];
let changed = 0;
const bodies = new Map();
for (const edit of edits) {
  if (!edit.file || !edit.from || !edit.to) { console.log(`skip ${edit.key}: not found in the code`); continue; }
  const target = path.resolve(root, edit.file);
  if (!target.startsWith(root + path.sep)) { console.log(`skip ${edit.key}: outside the checkout`); continue; }
  const body = bodies.get(target) ?? fs.readFileSync(target, 'utf8');
  const count = body.split(edit.from).length - 1;
  if (count !== 1) { console.log(`skip ${edit.key}: expected one match in ${edit.file}, found ${count}`); continue; }
  bodies.set(target, body.replace(edit.from, () => edit.to));
  changed += 1;
  console.log(`${edit.file}: ${edit.key} -> ${JSON.stringify(edit.text)}`);
}
if (flag === '--write') {
  for (const [target, body] of bodies) {
    // Compute first, then replace atomically, so a failed run never leaves a half-written file.
    const temporary = `${target}.copy-apply-${process.pid}.tmp`;
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, target);
  }
  console.log(`${changed} edit(s) written.`);
} else console.log(`${changed} edit(s) would be written. Pass --write to apply.`);
