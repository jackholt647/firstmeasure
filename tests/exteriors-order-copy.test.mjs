// The customer Exteriors order (FM-530). The order is sequential: a video walkaround, then the eight photos, and
// either one can be skipped. The switch links show only before anything is captured; after that, Back is the way to
// change it. On a phone the recorder's Upload tile is on the camera, the button right of the shutter appears only
// once something is recorded (no "Can't record?"), and there is no separate review page: the order button is on the
// delivery page. Ordering from photos shows no "not enough footage, we may reject it" warning. Desktop and phone use
// Jack's and Ben's copy, "View sample" and the per-angle example come from real Full Exterior orders, and "What's
// included" lists "Door & window measurements".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/firstmeasure/order/exteriors.js'), 'utf8');
const request = fs.readFileSync(path.join(root, 'public/libraries/apps/project-request/app.js'), 'utf8');
const slice = (text, start, end = '\n  }\n') => {
  const at = text.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  return text.slice(at, text.indexOf(end, at) + end.length);
};
const fn = (name) => slice(source, `function ${name}(`);

test('the phone recorder keeps Upload on the camera and shows the right button only after recording', () => {
  const mount = fn('mountRecorder');
  assert.doesNotMatch(mount, /ext-rec-guide/, 'the house picture is back in the recorder header');
  assert.match(mount, /class="ext-upload-tile" data-rec-upload/);
  assert.match(mount, /data-rec-photos>[^`]*"ext_upload_photos_instead","Upload photos instead"/);
  assert.match(fn('recorderForward'), /if\(!orbitVideos\(structure\)\.length\)return;/);
  const update = fn('updateRecorder');
  assert.doesNotMatch(update, /Can’t record\?|\[data-rec-upload\]'\)\.hidden/);
  assert.match(update, /forward\.classList\.toggle\('is-hidden',live\|\|!takes\.length\)/);
  assert.match(update, /\[data-rec-photos\]'\)\.hidden=desk\|\|live\|\|anyVideo\(\)/);
  assert.match(update, /"ext_record_a_video_walkaround","Record a video walkaround"/);
  assert.match(source, /\.ext-rec \.ext-upload-tile\[hidden\]/, 'a hidden upload tile still shows (display:flex)');
  assert.match(source, /\.ext-order \.ext-rec-photos\[hidden\]/, 'a hidden photos link still shows (display:block)');
});

test('the order goes video, then photos, and either can be skipped', () => {
  assert.match(source, /const toPhotos=\(\)=>switchMode\('photos'\);/);
  assert.match(fn('skipPhotos'), /if\(!videoCovers\(\)\)return;[^}]*setMobileOrderPage\?\.\('details'\)/);
  const api = slice(source, 'mobileIntroShowing:', 'explainMissingPhotos,');
  assert.match(api, /captureMode==='video'&&photoSummary\)toPhotos\(\)/, 'Next on the walkaround review moves on to the photos');
  assert.match(slice(source, 'mobilePhotoBack(){', '\n    },\n'), /if\(!photoIntroSeen\)\{backToVideo\(\);return true;\}/);
  const intro = fn('photoIntroUI');
  assert.match(intro, /\$\{videoCovers\(\)\?`<button type="button" class="ext-orbit-switch" data-skip-photos>/);
  assert.match(intro, /"ext_desk_upload_photos","Upload photos"/);
  assert.match(fn('videoIntroUI'), /\$\{DESK_STEPS\}[\s\S]*\$\{have\?'':`<button type="button" class="ext-orbit-switch" data-mode="photos">/);
  // Once started, the only way to change course is Back.
  assert.doesNotMatch(source, /m_cab762c293af5c|ext_switch_to_video_walkaround|ext_back_to_video_walkaround|ext_desk_upload_video_instead/);
  assert.match(fn('deskBackUI'), /if\(captureMode==='photos'\)[^\n]*data-desk-mode="video"/);
  assert.match(source, /const deskSkipLink=\(\)=>anyVideo\(\)\?'':/);
  assert.match(fn('deskSideUI'), /const button=videoStep\?`[^`]*data-desk-next/);
  assert.match(fn('deskClick'), /else if\('deskNext' in d\)toPhotos\(\);/);
  // The server takes a walkaround and the eight photos together: a structure needs either.
  const server = fs.readFileSync(path.join(root, 'public/v1/firstmeasure/exteriors.ts'), 'utf8');
  assert.match(server, /if\(own\.some\(r=>r\.view===EXTERIOR_ORBITAL_VIDEO\)\) continue;/);
});

test('the walkaround review has no Upload or photos link, and Record sits under the other angles', () => {
  const review = fn('videoSummaryUI');
  assert.match(review, /videoGroup\(i,ctx\.mobileOrder\?'':/, 'Upload is back in the phone review heading');
  assert.match(review, /\$\{ctx\.mobileOrder\?extrasGroup\(\):extrasUI\(\)\}\$\{record\}<p class="ext-video-hint">/);
  assert.match(review, /"ext_other_angles_hint","Add other angles of anything/);
  assert.doesNotMatch(source, /close-ups?\b/i);
});

test('the phone orders from the delivery page, with no review page', () => {
  assert.match(slice(request, 'function mobileOrderUsesFinalPage(){'), /return !window\.Portal\.ExteriorOrder\?\.active\(\) &&/);
  assert.match(source, /ready:\(\)=>\(page===2\|\|deskShown&&captureMode==='photos'\|\|mobileDetails&&!!ctx\?\.mobileOrder\)&&!orderBlocker\(\)/);
  assert.match(fn('mobileOrderFoot'), /ext-mobile-total[\s\S]*data-order-blocker/);
});

test('samples come from real orders: "View sample" and an example of each angle', () => {
  const dir = path.join(root, 'public/portal/samples/full-exterior');
  for (const view of ['front', 'front-left', 'left', 'back-left', 'back', 'back-right', 'right', 'front-right']) {
    assert.ok(fs.statSync(path.join(dir, view + '.jpg')).size > 10000, `missing sample ${view}.jpg`);
  }
  assert.ok(fs.statSync(path.join(dir, 'walkaround.mp4')).size < 6 * 1024 * 1024, 'the sample walkaround should stay small');
  assert.ok(fs.existsSync(path.join(dir, 'walkaround-poster.jpg')));
  const base = /new URL\('([^']+)',document\.currentScript/.exec(source)?.[1];
  assert.equal(new URL(base, 'https://app.1m8.ai/libraries/apps/firstmeasure/order/exteriors.js').pathname, '/portal/samples/full-exterior/');
  assert.doesNotMatch(fn('mountGuide'), /ext-angle-guide|houseModel/, 'the house picture is back in the photo guide');
  assert.match(fn('mountGuide'), /data-guide-step><\/span><button type="button" class="ext-example-tip" data-guide-example/);
  assert.match(fn('fillExample'), /img\.src=sampleImage\(view\)/);
  assert.match(fn('deskHeadUI'), /data-details="\$\{video\?'sample-video':'sample-photos'\}"/);
  assert.match(fn('showDeskInfo'), /key\.startsWith\('sample-'\)\?deskSampleHtml\(key\)/);
});

test('ordering from photos shows no footage-risk warning', () => {
  assert.doesNotMatch(source, /ext_photo_footage_risk|PHOTO_RISK|class="ext-photo-warning"/);
});

test('the copy matches the agreed wording', () => {
  for (const text of [
    'Upload a video walkaround', 'Upload photos', 'Upload photos instead', 'Drag your photos here"', 'Drag your videos here"',
    'Record a video of the entire house then upload it here. Or, upload from your phone at app.1m8.ai.',
    'Upload one exterior photo of the house for each of the eight angles shown below.',
    'Stand far enough back to fit the entire house in the frame.',
    'Walk all the way around the house, capturing all sides and corners.',
    'If anything was hidden from view, take an extra video from a different angle.',
    'View sample', 'Skip photos',
  ]) assert.ok(source.includes(text), `missing "${text}"`);
  assert.doesNotMatch(source, /Drag your videos here, or|here, or`/);
  assert.match(fn('deskGuideUI'), /\$\{DESK_STEPS\}\$\{deskSkipLink\(\)\}/);
  for (const text of ['Roof & gutter measurements', 'Door & window measurements', 'Siding & trim measurements']) {
    assert.ok(request.includes(`"${text}"`), `What's included is missing "${text}"`);
  }
  assert.doesNotMatch(request, /Doors & window/);
});
