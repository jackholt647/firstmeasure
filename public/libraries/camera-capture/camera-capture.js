/* FirstMate camera capture: a phone camera for taking photos into the platform, in the look of the
 * FirstMeasure exteriors capture (dark viewport, round shutter, the photos just taken in a strip above it).
 *
 * Two entry points, both phone-only (desktop never shows them):
 *
 *   // 1. A slim bar along the bottom of a host element (the Photos tab). Tapping it expands the bar
 *   //    upwards into a live camera that covers the host; Back collapses it.
 *   const cam = FirstMateCamera.mount(host, {
 *     upload: async (file, entry) => result,      // optional: where a photo goes; throw to show Retry
 *     onCapture(entry) {},                        // optional: each photo, as it is taken or chosen
 *     onDone(entries, nextResult) {},             // optional: when the camera closes, with this session's photos
 *     next: async (entries, step) => value,       // optional "what next" step after Done (see below)
 *     label: 'Take photos',                       // optional bar text
 *   });
 *   cam.open(); cam.close(); cam.destroy(); cam.entries();
 *
 *   // 2. Full screen, straight into the camera (My Projects, the Feed). projectId is optional.
 *   const session = FirstMateCamera.open({ orgId, projectId, projectTitle, onDone(entries, nextResult) {}, upload, next });
 *   session.close();                  // ends the session
 *   const entries = await session;    // (or session.done) resolves when it closes
 *
 * Uploading: with `upload`, each photo is passed to it (one at a time, in order) and the strip shows
 * progress, a check when done and Retry when it threw. With no `upload` and a projectId, photos go into
 * that project's media through PlatformAPI.media (the project upload pipeline's own owner/slot/metadata).
 * With neither (the Feed's unpaired photos), photos are only collected and handed to onDone/next.
 *
 * An entry is { id, file, thumbnail, status: 'pending'|'uploading'|'done'|'failed', error, result }.
 *
 * "What next": when the person taps Done and `next` is given, the camera stops and shows a step panel
 * over the viewport. `next(entries, step)` renders into `step.body` (step.setTitle(text) sets its
 * heading) and resolves with any value, which is passed to onDone as its second argument. Resolve
 * `false` to go back to the camera. Back on the step panel also returns to the camera.
 *
 * Camera permission refused or no camera: a clear message and a "Choose photos" button that opens the
 * device's picker (with the camera capture hint), feeding the same strip and uploads.
 */
(function(root){
  'use strict';
  if (root.FirstMateCamera) return;
  // PlatformLanguage returns the fallback as written when its catalog has no entry (or is not loaded), so the
  // placeholders are filled here: "Zoom {level}" with { level: '2x' } reads "Zoom 2x".
  const fill = (text, vars) => (vars && typeof text === 'string')
    ? text.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match)
    : text;
  const T = (key, fallback, vars) => fill(globalThis.PlatformLanguage?.text?.('camera-capture', key, fallback, vars) ?? fallback, vars);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MOBILE = '(max-width: 760px)';
  let sequence = 0;

  function styles(){
    if (document.getElementById('fm-camera-capture-style')) return;
    const style = document.createElement('style');
    style.id = 'fm-camera-capture-style';
    style.textContent = `
.fmc-bar{display:none}
.fmc-shell{display:none}
@media ${MOBILE}{
  .fmc-host-bar{padding-bottom:0}
  .fmc-bar{position:absolute;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:40;display:flex;align-items:center;justify-content:center;gap:9px;height:44px;border:0;border-radius:14px;background:#101828;color:#fff;font:inherit;font-size:14px;font-weight:700;box-shadow:0 10px 28px rgba(16,24,40,.28);cursor:pointer;transition:transform .24s cubic-bezier(.2,.8,.2,1),opacity .2s ease;-webkit-tap-highlight-color:transparent}
  .fmc-bar i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--primary,#d93025);font-size:14px}
  .fmc-bar:active{transform:scale(.98)}
  .fmc-bar[hidden],.fmc-host.fmc-open>.fmc-bar{display:none}
  .fmc-shell{position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;background:#000;color:#fff;overflow:hidden;clip-path:inset(calc(100% - 54px - env(safe-area-inset-bottom,0px)) 10px calc(10px + env(safe-area-inset-bottom,0px)) 10px round 16px);opacity:0;pointer-events:none;transition:clip-path .36s cubic-bezier(.2,.8,.2,1),opacity .18s ease}
  .fmc-shell.open{clip-path:inset(0 0 0 0 round 0);opacity:1;pointer-events:auto}
}
.fmc-shell.fullscreen{position:fixed;inset:0;z-index:2147483300;display:flex;flex-direction:column;background:#000;color:#fff;overflow:hidden;clip-path:none;opacity:0;transform:translateY(28px);pointer-events:none;transition:opacity .2s ease,transform .32s cubic-bezier(.2,.8,.2,1)}
.fmc-shell.fullscreen.open{opacity:1;transform:none;pointer-events:auto}
.fmc-shell *{box-sizing:border-box}
.fmc-head{position:relative;z-index:4;display:flex;align-items:center;gap:8px;min-height:50px;padding:calc(env(safe-area-inset-top,0px) + 6px) 10px 6px;background:#0b111b;flex:none}
.fmc-shell:not(.fullscreen) .fmc-head{position:absolute;left:0;right:0;top:0;background:linear-gradient(rgba(0,0,0,.55),transparent);padding-top:10px}
.fmc-head-title{flex:1;min-width:0;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fmc-head-title small{display:block;font-size:11px;font-weight:500;color:rgba(255,255,255,.65)}
.fmc-round{flex:none;width:40px;height:40px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.14);border-radius:50%;background:rgba(16,24,40,.6);color:#fff;font:inherit;font-size:16px;cursor:pointer;backdrop-filter:blur(10px);-webkit-tap-highlight-color:transparent}
.fmc-round[aria-pressed=true]{background:#fdb022;border-color:#fdb022;color:#101828}
.fmc-round:disabled{opacity:.35}
.fmc-round[hidden],.fmc-shell [hidden]{display:none!important}
.fmc-done{flex:none;height:36px;padding:0 14px;border:0;border-radius:999px;background:var(--primary,#d93025);color:#fff;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
.fmc-stage{position:relative;flex:1;min-height:0;overflow:hidden;background:linear-gradient(145deg,#1d2939,#101828);touch-action:none}
.fmc-stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;visibility:hidden;transform-origin:center}
.fmc-stage.live video{visibility:visible}
.fmc-flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:3}
.fmc-flash.fire{animation:fmcFlash .32s ease-out}
.fmc-idle{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;color:#cbd5e1}
.fmc-idle>i{font-size:30px}
.fmc-idle p{margin:0;max-width:280px;font-size:14px;line-height:1.45}
.fmc-stage.live .fmc-idle{display:none}
.fmc-pick{height:44px;padding:0 18px;border:0;border-radius:12px;background:#fff;color:#101828;font:inherit;font-size:14px;font-weight:700;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
.fmc-tools{position:relative;z-index:4;flex:none;display:flex;flex-direction:column;gap:10px;padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 14px);background:#000}
.fmc-strip{display:flex;gap:8px;min-height:0;overflow-x:auto;overflow-y:hidden;padding:2px 2px 2px 2px;scrollbar-width:none;overscroll-behavior-x:contain}
.fmc-strip::-webkit-scrollbar{display:none}
.fmc-strip:empty{display:none}
.fmc-tile{position:relative;flex:0 0 64px;width:64px;height:64px;border-radius:12px;overflow:hidden;background:#1d2939;border:2px solid transparent;animation:fmcTileIn .26s cubic-bezier(.2,.8,.2,1)}
.fmc-tile img{width:100%;height:100%;object-fit:cover;display:block}
.fmc-tile.failed{border-color:#f04438}
.fmc-busy{position:absolute;inset:0;display:grid;place-items:center;background:rgba(16,24,40,.45)}
.fmc-busy i{width:20px;height:20px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:fmcSpin .8s linear infinite}
.fmc-ok{position:absolute;right:4px;bottom:4px;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;background:#12b76a;color:#fff;font-size:9px;animation:fmcPop .3s ease-out}
.fmc-retry{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;border:0;background:rgba(153,43,38,.78);color:#fff;font:inherit;font-size:10px;font-weight:700;cursor:pointer}
.fmc-retry i{font-size:14px}
.fmc-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:center}
.fmc-row>:first-child{justify-self:start}.fmc-row>:last-child{justify-self:end}
.fmc-library{width:48px;height:48px;border:1px dashed rgba(255,255,255,.6);border-radius:12px;background:rgba(255,255,255,.06);color:#fff;display:grid;place-items:center;font-size:18px;cursor:pointer}
.fmc-shutter{width:68px;height:68px;border:5px solid #fff;outline:2px solid var(--primary,#d93025);outline-offset:0;border-radius:50%;background:var(--primary,#d93025);color:#fff;font-size:22px;cursor:pointer;transition:transform .12s ease;-webkit-tap-highlight-color:transparent}
.fmc-shutter:active{transform:scale(.92)}
.fmc-shutter:disabled{opacity:.45}
.fmc-zoom{align-self:center;display:flex;gap:2px;padding:3px;border-radius:999px;background:rgba(16,24,40,.66)}
.fmc-zoom:empty{display:none}
.fmc-zoom button{min-width:38px;height:30px;border:0;border-radius:999px;background:transparent;color:#fff;font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.fmc-zoom button[aria-pressed=true]{background:#fff;color:#101828}
.fmc-status{position:absolute;left:12px;right:12px;bottom:12px;z-index:3;padding:8px 12px;border-radius:12px;background:rgba(16,24,40,.72);color:#fff;font-size:12px;line-height:1.4;text-align:center;pointer-events:none}
.fmc-status:empty{display:none}
.fmc-step{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;background:#fff;color:#101828;animation:fmcStepIn .28s cubic-bezier(.2,.8,.2,1)}
.fmc-step-head{display:flex;align-items:center;gap:8px;min-height:52px;padding:calc(env(safe-area-inset-top,0px) + 6px) 10px 6px;border-bottom:1px solid #eaecf0}
.fmc-step-head strong{flex:1;min-width:0;font-size:16px}
.fmc-step-head .fmc-round{background:#f2f4f7;color:#344054;border-color:transparent}
.fmc-step-body{flex:1;min-height:0;overflow:auto;padding:12px}
@keyframes fmcFlash{0%{opacity:.85}100%{opacity:0}}
@keyframes fmcSpin{to{transform:rotate(360deg)}}
@keyframes fmcTileIn{from{opacity:0;transform:translateY(10px) scale(.9)}}
@keyframes fmcPop{from{transform:scale(.4);opacity:0}}
@keyframes fmcStepIn{from{opacity:0;transform:translateY(16px)}}
@media(prefers-reduced-motion:reduce){.fmc-shell,.fmc-bar{transition:none}.fmc-tile,.fmc-step,.fmc-ok{animation:none}.fmc-flash.fire{animation-duration:.01s}}
`;
    document.head.append(style);
  }

  // The project upload pipeline's ownership and metadata, for a project the page has not loaded.
  function projectUploader(orgId, projectId){
    return async (file) => {
      const media = root.PlatformAPI?.media;
      if (!media?.upload) throw new Error(T('upload_unavailable', 'Uploading is not available here.'));
      const app = root.__APP || {};
      return media.upload(orgId, file, {
        ownerType: 'project', ownerId: projectId, slot: 'photos', collection: 'projects', scope: 'projects', replaceSlot: false,
        thumbnails: true, compression: { quality: 0.88, max_width: 2400, max_height: 2400 },
        metadata: { field: 'photos', document_collection: 'projects', document_id: projectId, source: 'project_camera_capture', media_type: 'image', mime_type: file.type || 'image/jpeg', uploaded_by_name: app.userName || '', uploaded_by_email: app.userEmail || '', uploaded_by_user_id: app.userId || app.user_id || '', uploaded_at: new Date().toISOString() }
      });
    };
  }

  // One camera session UI: viewport, controls, strip, uploads. `shell` is created here; the caller places it.
  function createSession(options = {}){
    styles();
    const fullscreen = options.fullscreen === true;
    const shell = document.createElement('section');
    shell.className = 'fmc-shell' + (fullscreen ? ' fullscreen' : '');
    shell.setAttribute('role', fullscreen ? 'dialog' : 'region');
    shell.setAttribute('aria-label', T('camera', 'Camera'));
    shell.inert = true;
    const title = String(options.title || '');
    shell.innerHTML = `
      <header class="fmc-head">
        <button type="button" class="fmc-round" data-fmc-back aria-label="${esc(fullscreen ? T('close_camera', 'Close camera') : T('back', 'Back'))}"><i class="fas ${fullscreen ? 'fa-xmark' : 'fa-chevron-left'}" aria-hidden="true"></i></button>
        <div class="fmc-head-title">${title ? `${esc(title)}${options.subtitle ? `<small>${esc(options.subtitle)}</small>` : ''}` : ''}</div>
        <button type="button" class="fmc-round" data-fmc-torch aria-label="${esc(T('torch', 'Light'))}" aria-pressed="false" hidden><i class="fas fa-bolt" aria-hidden="true"></i></button>
        <button type="button" class="fmc-done" data-fmc-done hidden>${esc(T('done', 'Done'))}</button>
      </header>
      <div class="fmc-stage">
        <video autoplay muted playsinline aria-label="${esc(T('preview', 'Live camera preview'))}"></video>
        <div class="fmc-idle"><i class="fas fa-camera" aria-hidden="true"></i><p data-fmc-message>${esc(T('starting', 'Starting the camera…'))}</p><button type="button" class="fmc-pick" data-fmc-pick hidden><i class="fas fa-images" aria-hidden="true"></i>${esc(T('choose_photos', 'Choose photos'))}</button></div>
        <div class="fmc-flash"></div>
        <div class="fmc-status" role="status" aria-live="polite"></div>
      </div>
      <div class="fmc-tools">
        <div class="fmc-strip" aria-label="${esc(T('taken', 'Photos taken'))}"></div>
        <div class="fmc-zoom" role="group" aria-label="${esc(T('zoom', 'Zoom'))}"></div>
        <div class="fmc-row">
          <button type="button" class="fmc-library" data-fmc-library aria-label="${esc(T('choose_photos', 'Choose photos'))}" title="${esc(T('choose_photos', 'Choose photos'))}"><i class="fas fa-images" aria-hidden="true"></i></button>
          <button type="button" class="fmc-shutter" data-fmc-shutter aria-label="${esc(T('take_photo', 'Take photo'))}" disabled><i class="fas fa-camera" aria-hidden="true"></i></button>
          <button type="button" class="fmc-round" data-fmc-switch aria-label="${esc(T('switch_camera', 'Switch camera'))}" title="${esc(T('switch_camera', 'Switch camera'))}" hidden><i class="fas fa-camera-rotate" aria-hidden="true"></i></button>
        </div>
      </div>
      <input type="file" accept="image/*" capture="environment" multiple hidden data-fmc-input>`;
    const $ = (sel) => shell.querySelector(sel);
    const video = $('video'), stage = $('.fmc-stage'), strip = $('.fmc-strip'), zoomGroup = $('.fmc-zoom'), status = $('.fmc-status');
    const shutter = $('[data-fmc-shutter]'), torchBtn = $('[data-fmc-torch]'), flip = $('[data-fmc-switch]'), doneBtn = $('[data-fmc-done]'), input = $('[data-fmc-input]');
    let stream = null, facing = 'environment', starting = false, torchOn = false, zoom = null, devices = 0, active = false, closing = false;
    let entries = [], sessionEntries = [], queue = Promise.resolve(), statusTimer = 0, step = null;
    const upload = typeof options.upload === 'function' ? options.upload : (options.orgId && options.projectId ? projectUploader(options.orgId, options.projectId) : null);

    function say(text, sticky = false){
      clearTimeout(statusTimer);
      status.textContent = text || '';
      if (text && !sticky) statusTimer = setTimeout(() => { status.textContent = ''; }, 2600);
    }
    function fallback(message){
      stage.classList.remove('live');
      $('[data-fmc-message]').textContent = message;
      $('[data-fmc-pick]').hidden = false;
      shutter.disabled = true;
    }
    function stop(){
      stream?.getTracks().forEach((track) => track.stop());
      stream = null; zoom = null; torchOn = false;
      video.srcObject = null;
      stage.classList.remove('live');
      shutter.disabled = true;
      syncControls();
    }
    async function start(){
      if (starting || !active) return;
      if (!navigator.mediaDevices?.getUserMedia) { fallback(T('no_camera_api', 'This browser cannot open the camera. Choose photos instead.')); return; }
      starting = true;
      $('[data-fmc-message]').textContent = T('starting', 'Starting the camera…');
      $('[data-fmc-pick]').hidden = true;
      try {
        const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        if (!active) { next.getTracks().forEach((track) => track.stop()); return; }
        stop();
        stream = next;
        video.srcObject = stream;
        await video.play?.().catch(() => null);
        stage.classList.add('live');
        shutter.disabled = false;
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() || {}, settings = track?.getSettings?.() || {};
        if (settings.facingMode) facing = settings.facingMode;
        zoom = caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1, value: settings.zoom || caps.zoom.min } : null;
        torchBtn.dataset.supported = String(!!caps.torch);
        devices = (await navigator.mediaDevices.enumerateDevices?.().catch(() => []) || []).filter((device) => device.kind === 'videoinput').length;
      } catch (error) {
        const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
        const missing = error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError';
        fallback(denied ? T('denied', 'Camera access is off for this site. Allow the camera in your browser settings, or choose photos instead.')
          : missing ? T('missing', 'No camera was found on this device. Choose photos instead.')
          : T('failed', 'The camera could not start. Choose photos instead.'));
      } finally {
        starting = false;
        syncControls();
      }
    }
    function syncControls(){
      torchBtn.hidden = !stream || torchBtn.dataset.supported !== 'true';
      torchBtn.setAttribute('aria-pressed', String(torchOn));
      flip.hidden = !stream || devices < 2;
      const presets = zoom ? [zoom.min, ...[1, 2, 3, 5].filter((v) => v > zoom.min && v <= zoom.max)].filter((v, i, all) => all.indexOf(v) === i) : [];
      const label = (v) => `${Number(v.toFixed(1))}x`;
      zoomGroup.innerHTML = presets.length > 1 ? presets.map((v) => `<button type="button" data-zoom="${v}" aria-pressed="${Math.abs(v - zoom.value) < 0.05}" aria-label="${esc(T('zoom_to', 'Zoom {level}', { level: label(v) }))}">${label(v)}</button>`).join('') : '';
      const count = sessionEntries.length;
      doneBtn.hidden = !count;
      doneBtn.textContent = count ? `${T('done', 'Done')} · ${count}` : T('done', 'Done');
    }
    async function setZoom(value){
      const track = stream?.getVideoTracks()[0];
      if (!zoom || !track) return;
      zoom.value = Math.max(zoom.min, Math.min(zoom.max, value));
      try { await track.applyConstraints({ advanced: [{ zoom: zoom.value }] }); } catch (_) { say(T('zoom_failed', 'This camera could not change zoom.')); }
      syncControls();
    }
    async function setTorch(on){
      const track = stream?.getVideoTracks()[0];
      if (!track) return;
      try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); torchOn = !!on; } catch (_) { say(T('torch_failed', 'The light could not be turned on.')); }
      syncControls();
    }
    function renderTile(entry){
      let tile = strip.querySelector(`[data-fmc-entry="${entry.id}"]`);
      if (!tile) {
        tile = document.createElement('div');
        tile.className = 'fmc-tile';
        tile.dataset.fmcEntry = entry.id;
        tile.innerHTML = '<img alt="">';
        tile.querySelector('img').src = entry.thumbnail;
        tile.querySelector('img').alt = T('photo_n', 'Photo {number}', { number: entries.indexOf(entry) + 1 });
        strip.append(tile);
        strip.scrollTo?.({ left: strip.scrollWidth, behavior: 'smooth' });
      }
      tile.classList.toggle('failed', entry.status === 'failed');
      tile.querySelector('.fmc-busy')?.remove(); tile.querySelector('.fmc-ok')?.remove(); tile.querySelector('.fmc-retry')?.remove();
      if (entry.status === 'pending' || entry.status === 'uploading') tile.insertAdjacentHTML('beforeend', `<span class="fmc-busy" role="status" aria-label="${esc(T('uploading', 'Uploading'))}"><i></i></span>`);
      if (entry.status === 'done' && upload) tile.insertAdjacentHTML('beforeend', '<span class="fmc-ok" aria-hidden="true"><i class="fas fa-check"></i></span>');
      if (entry.status === 'failed') {
        tile.insertAdjacentHTML('beforeend', `<button type="button" class="fmc-retry" title="${esc(entry.error || '')}" aria-label="${esc(T('retry_upload', 'Upload failed. Retry'))}"><i class="fas fa-rotate-right" aria-hidden="true"></i>${esc(T('retry', 'Retry'))}</button>`);
        tile.querySelector('.fmc-retry').onclick = () => send(entry);
      }
    }
    function send(entry){
      if (!upload) { entry.status = 'done'; renderTile(entry); return Promise.resolve(); }
      entry.status = 'pending'; entry.error = ''; renderTile(entry);
      queue = queue.then(async () => {
        entry.status = 'uploading'; renderTile(entry);
        try { entry.result = await upload(entry.file, entry); entry.status = 'done'; }
        catch (error) { entry.status = 'failed'; entry.error = error?.message || T('upload_failed', 'Upload failed'); say(T('upload_failed_retry', 'A photo did not upload. Tap it to retry.'), true); }
        renderTile(entry);
        if (!entries.some((item) => item.status === 'failed')) say('');
      });
      return queue;
    }
    function add(file, thumbnail){
      const entry = { id: 'fmc' + (++sequence), file, thumbnail, status: 'pending', error: '', result: null };
      entries.push(entry); sessionEntries.push(entry);
      renderTile(entry); syncControls();
      try { options.onCapture?.(entry); } catch (error) { console.warn('Camera onCapture failed', error); }
      void send(entry);
      return entry;
    }
    async function capture(){
      if (!stream || !video.videoWidth) return;
      shutter.disabled = true;
      const flash = $('.fmc-flash'); flash.classList.remove('fire'); void flash.offsetWidth; flash.classList.add('fire');
      navigator.vibrate?.(10);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        const thumb = document.createElement('canvas');
        thumb.width = 192; thumb.height = Math.max(1, Math.round(192 * canvas.height / canvas.width));
        thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        if (!blob) throw new Error('capture');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        add(new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg', lastModified: Date.now() }), thumb.toDataURL('image/jpeg', 0.8));
      } catch (_) {
        say(T('capture_failed', 'That photo could not be taken. Try again.'));
      } finally {
        shutter.disabled = !stream;
      }
    }
    function choose(){ input.value = ''; input.click(); }
    input.addEventListener('change', () => {
      for (const file of input.files || []) {
        if (!String(file.type || '').startsWith('image/')) continue;
        add(file, URL.createObjectURL(file));
      }
    });
    // Pinch on the viewport zooms when the camera supports it.
    let pinch = null;
    const distance = (event) => Math.hypot(event.touches[0].clientX - event.touches[1].clientX, event.touches[0].clientY - event.touches[1].clientY);
    stage.addEventListener('touchstart', (event) => { if (zoom && event.touches.length === 2) { pinch = { d: distance(event), z: zoom.value }; event.preventDefault(); } }, { passive: false });
    stage.addEventListener('touchmove', (event) => { if (pinch && event.touches.length === 2) { event.preventDefault(); void setZoom(pinch.z * distance(event) / Math.max(1, pinch.d)); } }, { passive: false });
    stage.addEventListener('touchend', (event) => { if (event.touches.length < 2) pinch = null; });
    shutter.onclick = capture;
    $('[data-fmc-library]').onclick = choose;
    $('[data-fmc-pick]').onclick = choose;
    torchBtn.onclick = () => setTorch(!torchOn);
    flip.onclick = async () => { facing = facing === 'environment' ? 'user' : 'environment'; stop(); await start(); };
    zoomGroup.onclick = (event) => { const button = event.target.closest('[data-zoom]'); if (button) void setZoom(Number(button.dataset.zoom)); };

    async function finish(){
      if (closing) return;
      const taken = sessionEntries.slice();
      let nextResult;
      if (typeof options.next === 'function' && taken.length) {
        stop();
        step?.remove();
        step = document.createElement('div');
        step.className = 'fmc-step';
        step.innerHTML = `<div class="fmc-step-head"><button type="button" class="fmc-round" data-fmc-step-back aria-label="${esc(T('back_to_camera', 'Back to the camera'))}"><i class="fas fa-chevron-left" aria-hidden="true"></i></button><strong></strong></div><div class="fmc-step-body"></div>`;
        shell.append(step);
        const back = new Promise((resolve) => { step.querySelector('[data-fmc-step-back]').onclick = () => resolve(false); });
        const api = { element: step, body: step.querySelector('.fmc-step-body'), setTitle: (text) => { step.querySelector('strong').textContent = String(text || ''); }, close: () => {} };
        nextResult = await Promise.race([Promise.resolve().then(() => options.next(taken, api)), back]);
        step?.remove(); step = null;
        if (nextResult === false) { void start(); return; }
      }
      closing = true;
      await queue.catch(() => null);
      hide();
      sessionEntries = [];
      syncControls();
      closing = false;
      try { options.onDone?.(taken, nextResult); } catch (error) { console.warn('Camera onDone failed', error); }
      options.onFinished?.(taken, nextResult);
    }
    $('[data-fmc-back]').onclick = finish;
    doneBtn.onclick = finish;
    const onKey = (event) => { if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); void finish(); } };
    const onVisibility = () => { if (!active) return; if (document.hidden) stop(); else void start(); };

    function show(){
      if (active) return;
      active = true;
      shell.inert = false;
      requestAnimationFrame(() => shell.classList.add('open'));
      root.addEventListener('keydown', onKey, true);
      document.addEventListener('visibilitychange', onVisibility);
      options.onOpen?.();
      void start();
    }
    function hide(){
      if (!active) return;
      active = false;
      stop();
      if (torchOn) torchOn = false;
      shell.classList.remove('open');
      shell.inert = true;
      root.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVisibility);
      options.onClose?.();
    }
    return {
      shell, show, finish,
      get active(){ return active; },
      entries: () => entries.slice(),
      destroy(){ hide(); step?.remove(); shell.remove(); }
    };
  }

  function mount(host, options = {}){
    if (!host) throw new Error('FirstMateCamera.mount needs a host element.');
    styles();
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.classList.add('fmc-host');
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'fmc-bar';
    bar.setAttribute('aria-label', T('open_camera', 'Open camera'));
    bar.innerHTML = `<i class="fas fa-camera" aria-hidden="true"></i><span>${esc(options.label || T('take_photos', 'Take photos'))}</span>`;
    const session = createSession({ ...options, onOpen: () => { host.classList.add('fmc-open'); options.onOpen?.(); }, onClose: () => { host.classList.remove('fmc-open'); bar.focus({ preventScroll: true }); options.onClose?.(); } });
    host.append(bar, session.shell);
    bar.onclick = () => session.show();
    return {
      element: session.shell, bar,
      open: () => session.show(),
      close: () => session.finish(),
      isOpen: () => session.active,
      entries: () => session.entries(),
      destroy(){ session.destroy(); bar.remove(); host.classList.remove('fmc-host', 'fmc-open'); }
    };
  }

  function open(options = {}){
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const session = createSession({
      ...options,
      fullscreen: true,
      title: options.projectTitle || options.title || T('camera', 'Camera'),
      onFinished: (entries, nextResult) => { session.destroy(); settle(entries); }
    });
    document.body.append(session.shell);
    session.show();
    return {
      close: () => session.finish(),
      entries: () => session.entries(),
      done,
      then: (resolve, reject) => done.then(resolve, reject)
    };
  }

  root.FirstMateCamera = { mount, open, version: '20261026-camera-v2' };
})(window);
