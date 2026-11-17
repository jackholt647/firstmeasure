// The customer Exteriors order (FM-530). On a phone, the recorder's header is just the title, the
// button beside the shutter uploads a video until something is recorded (no "Can't record?"
// detour), ordering from photos is a small link below, and the upload tile is off the camera.
// Ordering from photos shows no "not enough footage, we may reject it" warning. The desktop copy
// is Jack's: "Upload a video walkaround" / "Upload photos".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/firstmeasure/order/exteriors.js'), 'utf8');
const fn = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `no function ${name}`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 4);
};

test('the phone recorder uploads beside the shutter and links to photos below', () => {
  const mount = fn('mountRecorder');
  assert.doesNotMatch(mount, /ext-rec-guide/, 'the house picture is back in the recorder header');
  assert.match(mount, /data-rec-photos>[^`]*"ext_use_photos_instead","Use photos instead"/);
  assert.match(mount, /\[data-rec-photos\]'\)\.onclick=\(\)=>switchMode\('photos'\)/);
  assert.match(fn('recorderForward'), /if\(!orbitVideos\(structure\)\.length\)\{pickVideo\(structure\);return;\}/);
  const update = fn('updateRecorder');
  assert.doesNotMatch(update, /Can’t record\?/);
  assert.match(update, /"m_48cd840a98035f","Upload"/);
  assert.match(update, /\[data-rec-upload\]'\)\.hidden=!desk/);
  assert.match(update, /\[data-rec-photos\]'\)\.hidden=desk\|\|live/);
  assert.match(update, /"ext_record_a_video_walkaround","Record a video walkaround"/);
  assert.doesNotMatch(update, /One full loop around the house/);
  assert.match(source, /\.ext-rec \.ext-upload-tile\[hidden\]/, 'a hidden upload tile still shows (display:flex)');
  assert.match(source, /\.ext-order \.ext-rec-photos\[hidden\]/, 'a hidden photos link still shows (display:block)');
});

test('ordering from photos shows no footage-risk warning', () => {
  assert.doesNotMatch(source, /ext_photo_footage_risk|PHOTO_RISK|class="ext-photo-warning"/);
});

test('the desktop copy matches the agreed wording', () => {
  for (const text of [
    'Upload a video walkaround', 'Upload photos', 'Upload a video instead', 'Drag your photos here"',
    'Record a video of the entire house then upload it here. Or, upload from your phone at app.1m8.ai.',
    'Upload one exterior photo of the house for each of the eight angles shown below.',
    'Stand far enough back to fit the entire house in the frame.',
    'Walk all the way around the house, capturing all sides and corners.',
    'If anything was hidden from view, take an extra video from a different angle.',
  ]) assert.ok(source.includes(text), `missing "${text}"`);
  assert.match(fn('deskGuideUI'), /\$\{DESK_STEPS\}/);
});
