// Replay real saved editable faces through the production command boundary.
const fs = require('node:fs');
const path = require('node:path');
const M = require('../public/measure/internal/editor_scripts/exterior_model.js');
const C = require('../public/measure/internal/editor_scripts/wall_chimneys.js');
function replay(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  C.normalizeDrafts(state.wallEdits); C.syncFoundation(state);
  const original = JSON.stringify(state);
  const faces = M.collect(state, C.compose(state.mergedWalls || [], state));
  const base = state.wallEdits.$base || state.base;
  const failures = [], times = []; let previews = 0;
  for (const face of faces) {
    if (face.chimney) continue;
    let command;
    try { command = M.createExtrusion({face, scene: faces, base}); }
    catch (error) { failures.push({face:face.id, stage:'start', error:error.message});continue; }
    for (const amount of [-1.524, -.762, -.3048, -.01, .01, .3048, .762, 1.524]) {
      const start = performance.now();
      try { if (!command.preview(amount).cap) throw Error('Missing cap'); previews++; }
      catch (error) { failures.push({face:face.id, amount, error:error.message}); }
      times.push(performance.now() - start);
    }
  }
  if (JSON.stringify(state) !== original) throw Error('Replay modified its input');
  times.sort((a,b)=>a-b);
  return {file, faces:faces.length, previews, failed:failures.length, medianMs:times[Math.floor(times.length/2)], maxMs:Math.max(...times), failures};
}
module.exports = replay;
if (require.main === module) {
  const result = replay(process.argv[2] || path.join(__dirname, 'fixtures/exterior-engine-saved.json'));
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.failed ? 1 : 0;
}
