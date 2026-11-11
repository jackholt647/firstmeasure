/* public/libraries/platform-offline/native-uploads.js
 *
 * window.PlatformOfflineNativeUploads: in the native app, queued uploads are sent by the host, which keeps each
 * file in private app storage and uploads it in the background, also after the app is closed
 * (docs/architecture/offline.md, "Photos and files"; the bridge contract is in native/firstmate/README.md, "Offline").
 *
 * Loaded by platform-offline.js in the top-level page, after the engine, only where
 * PhoneFeatures.offlineUploads.available(). The queue stays the one record of what is waiting:
 *
 *   waiting upload  ->  delegated (FMOffline.queue.delegate)  ->  file to the host (putBlob, or a native camera
 *   capture's token)  ->  offlineUploads.enqueue  ->  status polled  ->  FMOffline.replay.report  ->  ack
 *
 * An entry is marked `delegated` before its file is handed over, and this page's replay never sends an upload this
 * module will take (FMOffline.configure({ external })), so one entry is never uploaded from both sides. Each step
 * can be repeated: after the page was closed anywhere in between, the next start reads the host's status and
 * continues from there. The job's id is the entry's id.
 */
(function () {
  'use strict';
  if (window.PlatformOfflineNativeUploads) return;
  const FM = window.FMOffline;
  const phone = window.PhoneFeatures;
  const offline = window.PlatformOffline;
  if (!FM || !phone || !phone.offlineUploads || !offline) return;

  const uploads = phone.offlineUploads;
  const APP = window.__APP || {};
  const identity = { user: String(APP.userId || ''), org: String(APP.userOrgId || '') };
  const LOCK = 'fm-offline-native-uploads';
  const TOKENS = 'native-camera-tokens';
  const timers = { set: (work, ms) => window.setTimeout(work, ms), clear: (id) => window.clearTimeout(id) };
  const settings = { pollMs: 5000, retryMs: 30000 };

  /** Reasons the host can never take this file or this request: the page sends the entry itself instead. */
  const NEVER = new Set(['file_too_large', 'queue_full', 'untrusted_url', 'header_not_allowed', 'idempotency_key_required', 'invalid_request', 'invalid_file', 'empty_file', 'unsupported']);
  /** Entries left to the page (id -> reason), until the page is loaded again. */
  const leftToPage = new Map();
  /** Entries whose hand-over failed for now (id -> time it may be tried again). */
  const tryAgainAt = new Map();
  /** Jobs whose need to sign in was already passed on to the queue. */
  const signInTold = new Set();
  const available = () => { try { return !!uploads.available(); } catch (_) { return false; } };
  const mine = (entry) => entry.user === identity.user && entry.org === identity.org;
  const code = (error) => String((error && (error.code || error.message)) || 'failed');

  // This page's replay leaves waiting uploads alone: they are about to be handed to the host.
  FM.configure({ external: (entry) => entry.kind === 'upload' && available() && mine(entry) && !leftToPage.has(entry.id) });

  // ---------------------------------------------------------------------------------------------------------
  // Native camera captures (Android): a capture can be queued by its token, without reading its bytes again
  // ---------------------------------------------------------------------------------------------------------

  /** Says that the upload of `recordId` (the media id) is the native camera capture `capture` ({ token, size, name, mime }). */
  async function useCameraToken(recordId, capture) {
    if (!recordId || !capture || !capture.token) return false;
    const all = Object.assign({}, await FM.meta.get(TOKENS, {}));
    all[String(recordId)] = { token: String(capture.token), size: Number(capture.size) || 0, at: Date.now() };
    await FM.meta.set(TOKENS, all);
    return true;
  }
  async function cameraToken(entry) {
    const all = await FM.meta.get(TOKENS, {});
    for (const record of entry.records || []) if (all[record]) return Object.assign({ record }, all[record]);
    return null;
  }
  async function forgetCameraToken(record) {
    const all = Object.assign({}, await FM.meta.get(TOKENS, {}));
    if (!(record in all)) return;
    delete all[record];
    await FM.meta.set(TOKENS, all);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Handing one entry to the host
  // ---------------------------------------------------------------------------------------------------------

  /** The entry's request as the host sends it: one file and the form's text fields. */
  async function requestOf(entry) {
    const parsed = await FM.queue.parsed(entry);
    if (parsed.type !== 'form' || parsed.urlencoded) return null;
    const files = parsed.fields.filter(([, value]) => typeof value !== 'string');
    if (files.length !== 1 || !files[0][1].blob || !files[0][1].blob.size) return null;
    const fields = {};
    for (const [name, value] of parsed.fields) if (typeof value === 'string') fields[name] = value;
    return { field: files[0][0], file: files[0][1], fields };
  }

  /** Back to an ordinary waiting entry, sent by this page's replay. */
  async function leaveToPage(entry, reason) {
    leftToPage.set(entry.id, reason);
    const current = await FM.queue.get(entry.id);
    if (current && current.state === 'delegated') {
      Object.assign(current, { state: 'waiting', delegated: null, nextAt: 0 });
      await FM.queue.save(current);
      await FM.queue.changed({ user: current.user, org: current.org });
    }
    await Promise.resolve(uploads.cancel(entry.id)).catch(() => {});
    offline.syncNow();
  }

  /**
   * Marks the entry delegated, gives the host its file, and queues the job. Safe to repeat: the host answers a
   * known id with the job as it is, and queues a failed one again with this call's request.
   */
  async function handOver(entry, options) {
    const again = !!(options && options.again);            // the host has the job (failed) and its file
    await FM.queue.delegate(entry.id, { host: 'native', step: 'file', at: Date.now() });
    try {
      const request = await requestOf(entry);
      if (!request) { await leaveToPage(entry, 'not_one_file'); return 'page'; }
      const job = {
        id: entry.id, url: entry.url, fileField: request.field, fileName: request.file.name, contentType: request.file.type, fields: request.fields,
        headers: { 'Idempotency-Key': entry.key || entry.id, 'X-FM-Offline-User': entry.user, 'X-FM-Offline-Org': entry.org, 'X-FM-Offline-Replay': '1', Accept: 'application/json' },
        csrfCookie: offline.csrfCookie, size: request.file.size,
        saveToPhotos: offline.settings.get('saveToCameraRoll') === true && phone.supports('photoLibrarySave') && /^(image|video)\//i.test(request.file.type || '')
      };
      let answer = null;
      if (again) answer = await uploads.enqueue(job).catch((error) => { if (code(error) === 'unknown_source' || code(error) === 'put_incomplete') return null; throw error; });
      const token = answer ? null : await cameraToken(entry);
      if (!answer && token) {
        // A native camera capture is already in the host's private storage: the job takes it by its token.
        answer = await uploads.enqueue(Object.assign({}, job, { source: { cameraToken: token.token }, size: token.size || undefined, fileName: undefined, contentType: undefined }))
          .catch((error) => { if (['unknown_source', 'size_mismatch', 'empty_file'].includes(code(error))) return null; throw error; });
        await forgetCameraToken(token.record);
      }
      if (!answer) {
        await uploads.putBlob(entry.id, request.file.blob);
        answer = await uploads.enqueue(Object.assign({}, job, { source: { put: entry.id } })).catch(async (error) => {
          // The host holds something else under this id (an older transfer): start the file again, once.
          if (!['size_mismatch', 'put_incomplete', 'unknown_source'].includes(code(error))) throw error;
          await uploads.put(entry.id, 0, '', false).catch(() => {});
          await Promise.resolve(uploads.cancel(entry.id)).catch(() => {});
          await uploads.putBlob(entry.id, request.file.blob);
          return uploads.enqueue(Object.assign({}, job, { source: { put: entry.id } }));
        });
      }
      tryAgainAt.delete(entry.id);
      signInTold.delete(entry.id);
      await FM.queue.delegate(entry.id, { host: 'native', step: 'queued', at: Date.now(), savedToPhotos: !!(answer && answer.savedToPhotos), photosError: (answer && answer.photosError) || null });
      return 'host';
    } catch (error) {
      if (NEVER.has(code(error))) { await leaveToPage(entry, code(error)); return 'page'; }
      // The bridge did not answer, or the phone is out of space for now: the entry stays delegated and the next
      // pass finds no job for it and hands it over again.
      tryAgainAt.set(entry.id, Date.now() + settings.retryMs);
      return 'later';
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // The host's answers
  // ---------------------------------------------------------------------------------------------------------

  const response = (job) => new Response(job.body == null ? '' : String(job.body), { status: Number(job.status), headers: { 'Content-Type': 'application/json' } });

  /** Applies what the host says about one delegated entry (the answer table of the README). */
  async function settle(entry, job) {
    if (!job) {
      // The host has no such job: the page was closed before the job was queued, or the app's data was cleared.
      if ((tryAgainAt.get(entry.id) || 0) > Date.now()) return 'later';
      return handOver(entry);
    }
    if (job.state === 'queued' || job.state === 'uploading') return 'host';
    if (job.state === 'done') {
      // The answer is recorded first and acknowledged after: closed in between, the next start reports it again
      // (the entry is gone by then, which report() takes as nothing to do).
      await FM.replay.report(entry.id, response(job));
      await uploads.ack([entry.id]);
      return 'done';
    }
    if (job.state === 'needs_sign_in') {
      // The host waits for a sign-in and queues the job again by itself. The queue says so once.
      if (!signInTold.has(entry.id)) { signInTold.add(entry.id); await FM.replay.report(entry.id, new Response('{}', { status: 401 })); }
      return 'host';
    }
    if (job.state !== 'failed') return 'host';
    if (job.error === 'file_missing') { await Promise.resolve(uploads.cancel(entry.id)).catch(() => {}); return handOver(entry); }
    if (job.error === 'untrusted_url') { await leaveToPage(entry, 'untrusted_url'); return 'page'; }
    // A redirect is never an upload's answer (iOS cannot refuse one): the same as no answer, tried again later.
    if (job.status == null) { await FM.replay.report(entry.id, null); return 'reported'; }
    // A refusal (4xx) waits for the person; the eighth server error in a row is counted as one and tried again
    // later. The host keeps the failed job and its file until the entry is sent again or discarded.
    await FM.replay.report(entry.id, response(job));
    return 'reported';
  }

  /** An upload may go to the host when nothing before it in its scope has to reach the server first. */
  function ready(entries) {
    const out = [];
    const scopes = new Map();
    for (const entry of entries) { if (!scopes.has(entry.scope)) scopes.set(entry.scope, []); scopes.get(entry.scope).push(entry); }
    const now = Date.now();
    for (const list of scopes.values()) {
      for (const entry of list) {
        const held = entry.kind === 'create' && (entry.state === 'failed' || entry.state === 'parked');
        if (entry.kind === 'upload') {
          if (entry.state === 'waiting' && !leftToPage.has(entry.id) && entry.nextAt <= now && (tryAgainAt.get(entry.id) || 0) <= now) out.push(entry);
          continue;
        }
        // The photo-list save of an earlier photo does not have to arrive before the next photo's upload; any
        // other waiting change (the project's own create, a note) does.
        if (held || ((entry.state === 'waiting' || entry.state === 'delegated') && entry.contract !== 'media')) break;
      }
    }
    return out;
  }

  let running = null;
  let asked = false;
  let timer = null;

  async function pass() {
    if (!available() || !identity.user) return { delegated: 0 };
    FM.queue.invalidate();
    const all = await FM.queue.all();
    const entries = all.filter(mine);
    // 1. What the host says about the entries it holds.
    const delegated = entries.filter((entry) => entry.state === 'delegated' && entry.kind === 'upload');
    if (delegated.length) {
      const jobs = new Map();
      for (let index = 0; index < delegated.length; index += 400) {
        for (const job of (await uploads.status(delegated.slice(index, index + 400).map((entry) => entry.id))) || []) jobs.set(job.id, job);
      }
      for (const entry of delegated) {
        let job = jobs.get(entry.id);
        // One reply carries at most 1 MB of answers; a job beyond that is asked for by itself.
        if (job && job.bodyOmitted) job = ((await uploads.status([entry.id])) || [])[0] || job;
        await settle(entry, job).catch(() => 'later');
      }
    }
    // 2. Waiting uploads go to the host: a new photo, or one the person asked to send again.
    FM.queue.invalidate();
    const fresh = (await FM.queue.all()).filter(mine);
    for (const entry of ready(fresh)) {
      const known = ((await uploads.status([entry.id]).catch(() => [])) || [])[0];
      if (known && known.state === 'done') { await FM.replay.report(entry.id, response(known)); await uploads.ack([entry.id]); continue; }
      await handOver(entry, { again: !!known });
    }
    // 3. Answers with nowhere to go (the change is gone from the queue) are let go. A job that has not arrived is
    //    never cancelled here: it is someone's photo. It is cancelled when the person discards its change (below).
    const everyone = new Set((await FM.queue.all()).map((entry) => entry.id));
    const forgotten = ((await uploads.status().catch(() => [])) || []).filter((job) => job.state === 'done' && !everyone.has(job.id)).map((job) => job.id);
    if (forgotten.length) await Promise.resolve(uploads.ack(forgotten)).catch(() => {});
    FM.queue.invalidate();
    return { delegated: (await FM.queue.all()).filter((entry) => mine(entry) && entry.state === 'delegated').length };
  }

  /** One pass at a time; a pass asked for while one runs follows it. Polls while the host holds entries. */
  function pump() {
    if (running) { asked = true; return running; }
    const locked = () => (navigator.locks && navigator.locks.request ? navigator.locks.request(LOCK, { ifAvailable: true }, (lock) => (lock ? pass() : { delegated: 0, busy: true })) : pass());
    running = Promise.resolve().then(locked).catch((error) => { console.warn('[offline] native uploads', error); return { delegated: 0, error: true }; }).then((result) => {
      running = null;
      timers.clear(timer);
      timer = null;
      if (asked) { asked = false; return pump(); }
      if (result.delegated || result.error || tryAgainAt.size) timer = timers.set(() => { timer = null; if (document.visibilityState !== 'hidden') pump(); }, settings.pollMs);
      return result;
    });
    return running;
  }

  // A change was queued, retried or discarded (here, in a frame, or by the worker); the app came back to the front;
  // the connection returned.
  let soon = null;
  const nudge = () => { if (soon) return; soon = timers.set(() => { soon = null; pump(); }, 50); };
  offline.on('queued', nudge);
  // Discarded by the person: the host's job and its file go too. An upload already in flight may still arrive.
  offline.on('discarded', (entry) => { if (entry && entry.kind === 'upload') Promise.resolve(uploads.cancel(entry.id)).catch(() => {}); nudge(); });
  FM.events.on('changed', (detail, info) => { if (info && info.remote) nudge(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') nudge(); });
  window.addEventListener('online', nudge);

  window.PlatformOfflineNativeUploads = {
    /** Runs one pass now: reads the host's answers, hands over what waits. Resolves { delegated }. */
    pump,
    useCameraToken,
    /** What was left to the page and why: { '<entry id>': '<reason>' }. */
    leftToPage: () => Object.fromEntries(leftToPage),
    configure(options) { for (const [name, value] of Object.entries(options || {})) { if (name === 'timers') Object.assign(timers, value); else settings[name] = value; } }
  };
  pump();
})();
