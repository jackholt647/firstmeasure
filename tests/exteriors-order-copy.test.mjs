// The customer Exteriors order (FM-530). The order is sequential: a video walkaround, then the eight photos, and
// either one can be skipped. The switch links show only before anything is captured; after that, Back is the way to
// change it. On a phone the recorder's Upload tile is on the camera, the button right of the shutter appears only
// once something is recorded (no "Can't record?"), and there is no separate review page: the order button is on the
// delivery page. Ordering from photos shows no "not enough footage, we may reject it" warning. Desktop and phone use
// Jack's and Ben's copy, "View sample" and the per-angle example come from real Full Exterior orders, and "What's
// included" lists "Door & window measurements".
// FM-563: on desktop the order column waits until the photos are uploaded or skipped (a Continue button at the bottom
// right moves on from the video), the price is on the order button with no Total line (like the roof report), the
// walkaround review says "Additional videos" with no upload area, the recorder title stays "Record a video
// walkaround" while recording, and the link that skips the video reads "Skip video upload".
// FM-567: a second recording on the same structure is titled "Record another video" (not "Segment saved") and has
// no tip on the camera.
// FM-568: the walkaround review shows the videos, then the other-angles line, then a "Record additional videos"
// button (no "Additional videos"/"Nothing added yet": recordings go into the walkaround). The phone photo page uses
// Jack's copy with the steps right under the picture. On desktop the photos have no "Optional with a video walkaround"
// line, and Continue sits at the bottom right whatever is uploaded. The samples are Ben's house, plus other angles.
// FM-569: on a phone, "View sample" sits under the steps of the walkaround and photo intros (the sample video, or the
// whole sample gallery); each angle's Example shows just that angle. Once every angle has a photo (Add photos from the
// review), the guide's forward button says "Review" and goes back to the review instead of on to the next angle.
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
  assert.match(mount, /data-rec-photos>[^`]*"ext_skip_video_upload","Skip video upload"/);
  assert.match(fn('recorderForward'), /if\(!orbitVideos\(structure\)\.length\)return;/);
  const update = fn('updateRecorder');
  assert.doesNotMatch(update, /Can’t record\?|\[data-rec-upload\]'\)\.hidden/);
  assert.match(update, /forward\.classList\.toggle\('is-hidden',live\|\|!takes\.length\)/);
  assert.match(update, /\[data-rec-photos\]'\)\.hidden=desk\|\|live\|\|anyVideo\(\)/);
  assert.match(update, /:live\?\(globalThis\.PlatformLanguage\?\.text\("firstmeasure","ext_record_a_video_walkaround","Record a video walkaround"\)/);
  assert.doesNotMatch(source, /Keep walking the loop|ext_keep_walking_loop/);
  assert.match(update, /:takes\.length\?\(globalThis\.PlatformLanguage\?\.text\("firstmeasure","ext_record_another_video","Record another video"\)/);
  assert.match(update, /\[data-rec-hint\]'\)\.textContent=live\|\|!cameraStream\|\|takes\.length\?'':/);
  assert.doesNotMatch(source, /Segment saved|ext_88dded33784dcd|Record another segment to continue/);
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
  assert.match(intro, /\$\{videoCovers\(\)\?`<button type="button" class="ext-orbit-switch" data-skip-photos>\$\{\(globalThis\.PlatformLanguage\?\.htmlText\("firstmeasure","ext_skip_photo_upload","Skip photo upload"\)/);
  // Jack's copy (FM-568): no lead paragraph, two plain steps under the picture, "Add photos".
  assert.match(intro, /<\/h3>\$\{orbitScene\(true\)\}<div class="ext-intro-middle">/);
  assert.match(intro, /"ext_photo_step_eight_angles","Upload one exterior photo of the house for each of the eight angles shown above\."/);
  assert.match(intro, /"ext_photo_step_extras","Add extra photos or a video to show any details that are missed or hidden in the eight photos\."/);
  assert.match(intro, /data-photos-start><i class="fas fa-camera" aria-hidden="true"><\/i>\$\{\(globalThis\.PlatformLanguage\?\.htmlText\("firstmeasure","ext_add_photos","Add photos"\)/);
  assert.doesNotMatch(intro, /<b>|Take all eight angles|Anything hard to see|Start the eight photos|ext_desk_photos_lead/);
  // The steps are anchored under the picture, not spread over the page.
  assert.match(source, /\.mobile-order \.ext-fill-intro>\.ext-orbit-steps,\.mobile-order \.ext-fill-intro>\.ext-intro-middle\{display:flex;flex-direction:column;justify-content:flex-start;/);
  assert.match(intro, /"ext_desk_upload_photos","Upload photos"/);
  assert.match(fn('videoIntroUI'), /\$\{DESK_STEPS\}[\s\S]*\$\{have\?'':`<button type="button" class="ext-orbit-switch" data-mode="photos">/);
  // Once started, the only way to change course is Back.
  assert.doesNotMatch(source, /m_cab762c293af5c|ext_switch_to_video_walkaround|ext_back_to_video_walkaround|ext_desk_upload_video_instead/);
  assert.match(fn('deskBackUI'), /if\(captureMode==='photos'\)[^\n]*data-desk-mode="video"/);
  assert.match(source, /const deskSkipLink=\(\)=>anyVideo\(\)\?'':/);
  // Desktop: Continue sits at the bottom right after the video and after the photos, whatever is uploaded (FM-568);
  // the order column waits for it (or all eight photos) and says what is still missing.
  assert.match(fn('deskFootUI'), /if\(captureMode==='video'\)return ready\(\)\?`[^`]*data-desk-next/);
  assert.match(fn('deskFootUI'), /return deskOrderShown\(\)\?'':`<button type="button" class="ext-desk-btn primary ext-desk-next" data-desk-skip-photos [^`]*"ext_desk_continue","Continue"/);
  assert.match(source, /const deskOrderShown=\(\)=>\{if\(captureMode!=='photos'\)return false;if\(deskAllPhotos\(\)\)deskPhotosDone=true;return deskPhotosDone;\};/);
  assert.doesNotMatch(source, /ext_desk_photos_optional|Optional with a video walkaround|"ext_skip_photos"/);
  assert.match(fn('updateDesk'), /toggle\('is-ready',deskOrderShown\(\)&&!recordingNow\)/);
  assert.match(fn('deskClick'), /else if\('deskSkipPhotos' in d\)\{deskPhotosDone=true;render\(\);\}/);
  assert.doesNotMatch(fn('deskSideUI'), /data-desk-next|videoStep/);
  assert.match(fn('deskClick'), /else if\('deskNext' in d\)toPhotos\(\);/);
  // The server takes a walkaround and the eight photos together: a structure needs either.
  const server = fs.readFileSync(path.join(root, 'public/v1/firstmeasure/exteriors.ts'), 'utf8');
  assert.match(server, /if\(own\.some\(r=>r\.view===EXTERIOR_ORBITAL_VIDEO\)\) continue;/);
});

test('the walkaround review shows the videos, the other-angles line, then a Record additional videos button', () => {
  const review = fn('videoSummaryUI');
  assert.match(review, /videoGroup\(i,ctx\.mobileOrder\?'':/, 'Upload is back in the phone review heading');
  assert.match(review, /\$\{groups\}\$\{videoExtrasGroup\(\)\}<p class="ext-video-hint">[^`]*<\/p>\$\{record\}<\/section>`/);
  assert.doesNotMatch(review, /extrasDrop|extrasUI|extrasGroup\(\)/, 'the walkaround review has no "Additional photos and videos" area');
  // A recording goes into the walkaround, so an always-shown "Additional videos" only ever said "Nothing added yet".
  assert.match(source, /const videoExtrasGroup=\(\)=>videoExtras\(\)\?summaryGroup\('',/);
  assert.match(review, /class="ext-orbit-actions ext-video-record">[^\n]*class="ext-orbit-secondary" data-video-record="\$\{i\}"/);
  assert.match(review, /"ext_record_additional_videos","Record additional videos"/);
  assert.doesNotMatch(source, /ext-record-link/);
  // The final screen, after the eight photos, keeps "Additional photos and videos".
  assert.match(fn('photoUI'), /\$\{extrasGroup\(\)\}\$\{extrasDrop\(true\)\}<\/section>`;/);
  assert.match(review, /"ext_other_angles_hint","Add other angles of anything/);
  assert.doesNotMatch(source, /close-ups?\b/i);
});

test('the phone orders from the delivery page, with no review page', () => {
  assert.match(slice(request, 'function mobileOrderUsesFinalPage(){'), /return !window\.Portal\.ExteriorOrder\?\.active\(\) &&/);
  assert.match(source, /ready:\(\)=>\(page===2\|\|deskShown&&deskOrderShown\(\)\|\|mobileDetails&&!!ctx\?\.mobileOrder\)&&!orderBlocker\(\)/);
  // The price is on the order button, like the roof report's: no separate Total line.
  assert.doesNotMatch(fn('mobileOrderFoot'), /ext-mobile-total|m_9403c7637d4905/);
  assert.doesNotMatch(fn('deskSideUI'), /ext-desk-total|m_9403c7637d4905/);
  assert.match(source, /"ext_order_full_exterior_price",`Order Full Exterior - \$\{v0\}`/);
  assert.match(fn('deskSideUI'), /esc\(orderLabel\(\)\)\}<\/button>`;/);
  assert.match(request, /window\.Portal\.ExteriorOrder\.orderLabel\?\.\(\) \|\|/);
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
  // Ben's house (FM-568): other angles at the bottom of the sample photos; the version makes browsers refetch.
  for (let i = 1; i <= 4; i++) assert.ok(fs.statSync(path.join(dir, `other-${i}.jpg`)).size > 10000, `missing sample other-${i}.jpg`);
  assert.match(source, /SAMPLE_OTHER_ANGLES=4;/);
  assert.match(source, /sampleImage=view=>SAMPLE_BASE\+view\+'\.jpg'\+SAMPLE_V/);
  assert.match(fn('deskSampleHtml'), /"ext_sample_other_angles","Other angles"[\s\S]*sampleImage\('other-'\+\(i\+1\)\)/);
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jpg'))) {
    assert.ok(!fs.readFileSync(path.join(dir, name)).includes(Buffer.from('GPS')), `${name} keeps location metadata`);
  }
  assert.match(fn('deskHeadUI'), /data-details="\$\{video\?'sample-video':'sample-photos'\}"/);
  assert.match(fn('showDeskInfo'), /key\.startsWith\('sample-'\)\?deskSampleHtml\(key\)/);
});

test('ordering from photos shows no footage-risk warning', () => {
  assert.doesNotMatch(source, /ext_photo_footage_risk|PHOTO_RISK|class="ext-photo-warning"/);
});

test('the copy matches the agreed wording', () => {
  for (const text of [
    'Upload a video walkaround', 'Upload photos', 'Skip video upload', 'Additional videos', 'Drag your photos here"', 'Drag your videos here"',
    'Record a video of the entire house then upload it here. Or, upload from your phone at app.1m8.ai.',
    'Upload one exterior photo of the house for each of the eight angles shown below.',
    'Stand far enough back to fit the entire house in the frame.',
    'Walk all the way around the house, capturing all sides and corners.',
    'If anything was hidden from view, take an extra video from a different angle.',
    'View sample', 'Skip photo upload', 'Add photos', 'Record additional videos', 'Other angles',
  ]) assert.ok(source.includes(text), `missing "${text}"`);
  assert.doesNotMatch(source, /Drag your videos here, or|here, or`/);
  assert.doesNotMatch(source, /Upload photos instead/);
  assert.match(fn('deskGuideUI'), /\$\{DESK_STEPS\}\$\{deskSkipLink\(\)\}/);
  for (const text of ['Roof & gutter measurements', 'Door & window measurements', 'Siding & trim measurements']) {
    assert.ok(request.includes(`"${text}"`), `What's included is missing "${text}"`);
  }
  assert.doesNotMatch(request, /Doors & window/);
});

test('phone intros show "View sample" under the steps, and Add photos from the review returns to it', () => {
  assert.match(fn('videoIntroUI'), /<div class="ext-intro-middle">\$\{DESK_STEPS\}\$\{introSampleUI\('sample-video'\)\}<\/div><div class="ext-orbit-actions">/);
  assert.match(fn('photoIntroUI'), /<\/li><\/ol>\$\{introSampleUI\('sample-photos'\)\}<\/div><div class="ext-orbit-actions">/);
  assert.match(source, /const introSampleUI=key=>`<div class="ext-intro-sample"><button type="button" class="ext-example-tip" data-intro-sample="\$\{key\}"[^`]*"ext_view_sample","View sample"/);
  const show = fn('showIntroSample');
  assert.match(show, /pop\.innerHTML=deskSampleHtml\(key,true\)/, 'the phone popover reuses the desktop sample card');
  // On a phone the gallery enlarges in place: the app opens target=_blank links in place of the order.
  assert.match(fn('deskSampleHtml'), /const item=\(src,name=''\)=>phone\?`<button type="button" data-sample-zoom/);
  assert.match(fn('fillExample'), /img\.src=sampleImage\(view\)/, 'the angle Example shows only that angle');
  assert.match(source, /const everyAngleTaken=\(\)=>!!ctx\?\.count&&Array\.from\(\{length:ctx\.count\*8\}/);
  assert.match(fn('mountGuide'), /\[data-guide-forward\]'\)\.onclick=\(\)=>guideIndex\+1<ctx\.count\*8&&!everyAngleTaken\(\)\?visitGuide\(guideIndex\+1\):finishGuide\(\);/);
  assert.match(fn('updateGuide'), /\[data-guide-forward\]'\)\.textContent=everyAngleTaken\(\)\?\(globalThis\.PlatformLanguage\?\.text\("firstmeasure","ext_aff0766a5290e1","Review"\)/);
});
