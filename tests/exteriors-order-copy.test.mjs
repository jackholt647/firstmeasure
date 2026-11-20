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
// FM-573: the phone "View sample" opens above the tip (never over Start recording / Add photos) with a close X at the
// top right, and the walkaround intro's button says "Record another video" once a video exists. The X shares a header
// row with the title, so it never sits on the sample video or photos. The popover never opens below the tip and never
// scrolls inside: it covers the tip when it must and shrinks the sample to fit above Start recording / Add photos.
// FM-621: a phone held sideways (touch, landscape, at most 500px tall) keeps the desktop order, but the project window
// fills the screen while the report order is open, and filming the walkaround fills the whole screen until it ends.
// No other landscape view changes. The closed project tray waits 16px past the window's right edge; its column clips
// it, or a focus scrolls the whole window 17px sideways (the order's left padding gone, header icon cut off).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/apps/firstmeasure/order/exteriors.js'), 'utf8');
const request = fs.readFileSync(path.join(root, 'public/libraries/apps/project-request/app.js'), 'utf8');
const windows = fs.readFileSync(path.join(root, 'public/libraries/window-manager/window-manager.js'), 'utf8');
const trays = fs.readFileSync(path.join(root, 'public/libraries/project-trays/project-trays.js'), 'utf8');
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
  assert.match(show, /pop\.innerHTML=`<div class="ext-intro-sample-head">[^`]*<\/div><div class="ext-intro-sample-body">\$\{deskSampleHtml\(key,true\)\}<\/div>`/, 'the phone popover reuses the desktop sample card');
  // On a phone the gallery enlarges in place: the app opens target=_blank links in place of the order.
  assert.match(fn('deskSampleHtml'), /const item=\(src,name=''\)=>phone\?`<button type="button" data-sample-zoom/);
  assert.match(fn('fillExample'), /img\.src=sampleImage\(view\)/, 'the angle Example shows only that angle');
  assert.match(source, /const everyAngleTaken=\(\)=>!!ctx\?\.count&&Array\.from\(\{length:ctx\.count\*8\}/);
  assert.match(fn('mountGuide'), /\[data-guide-forward\]'\)\.onclick=\(\)=>guideIndex\+1<ctx\.count\*8&&!everyAngleTaken\(\)\?visitGuide\(guideIndex\+1\):finishGuide\(\);/);
  assert.match(fn('updateGuide'), /\[data-guide-forward\]'\)\.textContent=everyAngleTaken\(\)\?\(globalThis\.PlatformLanguage\?\.text\("firstmeasure","ext_aff0766a5290e1","Review"\)/);
});

test('the phone sample opens above the tip with a close X and never covers the primary button', () => {
  const show = fn('showIntroSample');
  assert.match(show, /class="ext-intro-sample-close" data-intro-sample-close aria-label="\$\{[^`]*"ext_close_sample"[^`]*<i class="fas fa-xmark"/);
  assert.match(show, /if\(e\.target\.closest\('\[data-intro-sample-close\]'\)\)\{showIntroSample\(null\);/, 'the X closes it');
  // The X sits in a header row with the title (Ben, FM-573: not over the media), outside the body.
  assert.match(show, /<div class="ext-intro-sample-head"><h4>\$\{sampleTitle\(key\)\}<\/h4><button type="button" class="ext-intro-sample-close"/);
  assert.match(source, /\.ext-intro-sample-pop\{[^}]*display:flex;flex-direction:column;overflow:hidden/);
  assert.match(source, /\.ext-intro-sample-head\{flex:none;display:flex/);
  assert.match(source, /\.ext-intro-sample-body\{flex:1 1 auto;min-height:0;overflow:auto/);
  assert.doesNotMatch(source, /\.ext-intro-sample-close\{[^}]*(position:sticky|float:|margin:-)/, 'no floating X over the media');
  // A light shadow that falls away from the tip (Ben, FM-573): opened above, it must not smear down over View sample.
  const shadows = rule => [...(source.match(new RegExp(`${rule.replace(/\./g, '\\.')}\\{[^}]*box-shadow:([^;}]*)`))?.[1] ?? '').matchAll(/(-?\d+)(?:px)? (-?\d+)(?:px)? (\d+)(?:px)?/g)].map(m => m.slice(1).map(Number));
  const below = shadows('.ext-intro-sample-pop');
  assert.ok(below.length, 'the phone popover has a shadow');
  for (const [, y, blur] of below) assert.ok(y >= 0 && blur <= 16, 'the phone popover shadow stays tight');
  const above = shadows('.ext-intro-sample-pop.is-above');
  assert.ok(above.length, 'opened above, the popover has its own shadow');
  for (const [, y, blur] of above) assert.ok(blur + y <= 10, 'opened above, the shadow reaches at most 10px below the popover');
  assert.match(fn('deskSampleHtml'), /const head=phone\?'':`<h4>\$\{sampleTitle\(key\)\}<\/h4>`/, 'the phone card leaves its title to the header');
  // Ben, FM-573 round 4: never below the tip and never a scrollbar inside. The room runs from the top of the page to the
  // action buttons; it sits above the tip when it fits there, else from the top of the page over the tip, and a sample
  // too tall even for that shrinks until it fits. A zoomed photo shows on its own, so zooming never needs a scroll.
  const place = fn('placeIntroSample');
  assert.match(show, /pop\.hidden=false;placeIntroSample\(pop,button\);/);
  assert.match(place, /querySelector\('\.ext-orbit-actions'\)\?\.getBoundingClientRect\(\)/);
  assert.match(place, /top=Math\.max\(0,scroller\?\.top\?\?0\)\+gap,bottom=Math\.min\(window\.innerHeight,scroller\?\.bottom\?\?Infinity,actions\?\.height\?actions\.top:Infinity\)-gap,room=Math\.max\(0,bottom-top\)/);
  assert.match(place, /pop\.classList\.add\('is-above'\)/, 'never opens below the tip');
  assert.doesNotMatch(place, /classList\.(remove|toggle)\('is-above'/);
  assert.match(place, /if\(tall\(\)\)\{let lo=[^}]*card\.style\.width=f\*100\+'%';if\(tall\(\)\)hi=f;else lo=f;\}/, 'too tall: the sample shrinks to fit');
  assert.match(place, /if\(pop\.offsetHeight>tip\.top-8-top\|\|stay&&wasTop\)\{pop\.style\.top=\(top-tip\.top\)\+'px';pop\.style\.bottom='auto';\}/, 'no room above the tip: from the top of the page, over the tip');
  assert.match(place, /pop\.style\.maxHeight=room\+'px'/);
  assert.doesNotMatch(show, /Math\.max\(160,|scrollIntoView/, 'no minimum height over the buttons, no scrolling to a zoomed photo');
  assert.match(show, /classList\.toggle\('is-zoomed',on\);placeIntroSample\(pop,button,true\)/);
  assert.match(source, /\[data-sample-zoom\]\[aria-pressed=true\] img\{aspect-ratio:auto 4\/3;/, 'a zoomed photo keeps its shape while it loads');
  assert.match(source, /\.ext-sample-card\.is-zoomed \[data-sample-zoom\]:not\(\[aria-pressed=true\]\),\.ext-sample-card\.is-zoomed \.ext-sample-more\{display:none\}/);
});

test('the walkaround intro says "Record another video" once a video exists', () => {
  const intro = fn('videoIntroUI');
  assert.match(intro, /\$\{have\?\(globalThis\.PlatformLanguage\?\.htmlText\("firstmeasure","ext_record_another_video","Record another video"\)/);
  assert.doesNotMatch(source, /Record another segment/);
});

test('a phone held sideways fills the screen with the report order and with the walkaround camera', () => {
  const phone = /'\(pointer: coarse\) and \(orientation: landscape\) and \(max-height: 500px\)'/;
  // The project window: maximized only for the open report order, and given back when the order ends.
  const order = slice(request, 'function syncPhoneLandscapeOrder(');
  assert.match(slice(request, 'function isPhoneLandscape('), phone);
  assert.match(order, /!isMobileProjectOrder\(\) && isPhoneLandscape\(\) && reportOrderOpen\(\)/);
  assert.match(order, /if \(want === phoneLandscapeOrder\) return;/, 'a person who shrinks the window keeps their choice');
  assert.match(order, /setMode\('fullscreen', \{ silent:true, allowFullscreen:true \}\)/);
  assert.match(order, /setMode\('modal', \{ silent:true \}\)/);
  assert.match(slice(request, 'function syncMobileOrderPagination('), /syncPhoneLandscapeOrder\(\);/);
  assert.match(slice(request, 'function shouldUseMobileOrderPagination('), /isMobileProjectOrder\(\) && reportOrderOpen\(\)/);
  // The project window offers no Fullscreen control, so the window manager takes the app's word for this one.
  assert.match(windows, /function setMode\(mode,\{silent=false,allowFullscreen=false\}=\{\}\)/);
  assert.match(windows, /mode==='fullscreen' && options\.allowFullscreen===false && !allowFullscreen && !mobileFullscreen\(\)/);
  // The walkaround: its own fixed layer (a fixed child of the size-contained order panel would stay inside it).
  assert.match(source, phone);
  const mount = fn('filmMount');
  assert.match(mount, /if\(!deskRecording\(\)\|\|workspaceSuspended\|\|!phoneLandscape\(\)\)\{closePhoneFilm\(\);return null;\}/);
  assert.match(mount, /document\.body\.append\(filmLayer\)/);
  assert.match(mount, /!page\.dataset\.nativeApp&&!doc\.fullscreenElement&&page\.requestFullscreen/);
  assert.match(fn('mountRecorder'), /\(filmMount\(\)\|\|\(deskRecording\(\)\?deskNode:root\)\.querySelector\('\[data-guide-mount\]'\)\)\?\.append\(recNode\)/);
  assert.match(source, /\.ext-desk\{[^}]*container:ext-desk\/size/, 'if the order panel is no longer a size container, the layer could live inside it');
  assert.match(source, /\.ext-phone-film\{position:fixed;inset:0;z-index:2147483200;/);
  // Filming ends: Done or Back, the order closing or set aside, the guide reset. The layer and full screen go with it.
  assert.match(fn('updateDesk'), /if\(recordingNow\)mountRecorder\(\);else\{[^}]*filmLayer\?\.contains\(recNode\)[^}]*\}closePhoneFilm\(\);\}/);
  assert.match(fn('closeDesk'), /closePhoneFilm\(\);/);
  assert.match(fn('resetGuide'), /closePhoneFilm\(\);/);
  assert.match(source, /if\(workspaceSuspended\)\{stopCamera\(\);closePhoneFilm\(\);/);
  assert.match(fn('closePhoneFilm'), /leaveFilmFullscreen\(\);/);
  assert.match(fn('renderPhotoWorkspace'), /contains\('mobile-order'\)\)\{[^}]*\n[^}]*if\(deskShown\|\|deskNode\?\.isConnected\)closeDesk\(false\);/);
  // Turning the phone upright mid-order: the page request is the phone order, never a desktop render asking again.
  assert.match(source, /setMobilePage\(step\)\{if\(!active\(\)\)return;const wasDesk=!ctx\.mobileOrder;ctx\.mobileOrder=true;[^}]*if\(wasDesk\|\|/);
});

test('a closed project tray never makes the project window scroll sideways', () => {
  assert.match(trays, /\.fm-project-tray\{[^}]*transform:translateX\(16px\)/, 'if the closed tray no longer waits off to the side, this clip may go');
  assert.match(trays, /\.fm-project-content\{overflow-x:clip\}/, 'clip, not hidden: hidden can still be scrolled by a focus');
});
