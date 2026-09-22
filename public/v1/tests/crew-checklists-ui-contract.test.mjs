import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

test('crew checklist ratings use the same data attribute in markup and selected-state CSS', async () => {
  const source = await readFile(new URL('libraries/apps/crew/app.js', root), 'utf8');
  assert.match(source, /data-cl-rate="\$\{value\}"/);
  for (const rating of ['good', 'neutral', 'bad']) {
    assert.match(source, new RegExp(`button\\.on\\[data-cl-rate=${rating}\\]`));
  }
  assert.doesNotMatch(source, /button\.on\[data-rate=(?:good|neutral|bad)\]/);
});

test('crew checklist items expose required evidence uploads and preflight completion', async () => {
  const [app, api] = await Promise.all([
    readFile(new URL('libraries/apps/crew/app.js', root), 'utf8'),
    readFile(new URL('libraries/crew-api/crew-api.js', root), 'utf8')
  ]);
  assert.match(app, /data-cl-evidence-add/);
  assert.match(app, /data-cl-evidence-input/);
  assert.match(app, /attachChecklistEvidence/);
  assert.match(app, /evidenceRequirements\(item\)\.some\(\(requirement\)=>!requirement\.met\)/);
  assert.match(api, /attachChecklistEvidence\(orgId, projectId, checklistId, itemId, file, requirementId = ''\)/);
});

test('crew checklist cards do not render generated checklist subtitles', async () => {
  const source = await readFile(new URL('libraries/apps/crew/app.js', root), 'utf8');
  assert.doesNotMatch(source, /checklist\.description\?`<span>/);
  assert.match(source, /crew-cl-copy"><h3>\$\{esc\(checklist\.title\)\}<\/h3><\/div>/);
});

test('crew voice-explanation requirements use the inline recorder instead of a file picker', async () => {
  const [source, audioNotes] = await Promise.all([
    readFile(new URL('libraries/apps/crew/app.js', root), 'utf8'),
    readFile(new URL('libraries/audio-notes/audio-notes.js', root), 'utf8')
  ]);
  assert.match(source, /recordOnly:kind==='audio'/);
  assert.match(source, /data-cl-evidence-record/);
  assert.match(source, /audioNotes\.recordInline\(\{mount,maxSeconds:600,submitStyle:true,confirmPlayback:true\}\)/);
  assert.match(source, /audioNotes\.toWavFile\(recording\.file,16_000\)/);
  assert.match(source, /Attaching voice explanation/);
  assert.match(audioNotes, /if \(!options\.confirmPlayback\)/);
  assert.match(audioNotes, /data-fm-an-review-player/);
  assert.match(audioNotes, /fm-an-inline-review-action discard/);
  assert.match(audioNotes, /fm-an-inline-review-action approve/);
  assert.match(audioNotes, /createPlayer\(\{ url:previewUrl/);
  assert.doesNotMatch(audioNotes, /Review voice explanation/);
  assert.match(audioNotes, /index % 3 === 0/);
});
