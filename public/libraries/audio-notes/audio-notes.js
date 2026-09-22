/* libraries/audio-notes/audio-notes.js
 * Reusable audio-note recorder, OpenAI transcription client, and waveform player.
 * Audio notes keep their transcript in the host record's normal text field and
 * store only presentation data in metadata.audio_note.
 */
(function(){
  const root = window;
  if (root.FirstMateAudioNotes) return;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[char]);
  const clean = (value) => String(value ?? '').trim();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

  function ensureStyles(){
    if (document.getElementById('fm-audio-note-styles')) return;
    const style = document.createElement('style');
    style.id = 'fm-audio-note-styles';
    style.textContent = `
.fm-an-player{display:flex;align-items:center;gap:7px;width:min(100%,520px);min-height:30px;padding:3px 5px;border:1px solid rgba(15,23,42,.09);border-radius:9px;background:#f8fafc;color:#344054;box-sizing:border-box}
.fm-an-play{flex:0 0 auto;width:24px;height:24px;border:0;border-radius:999px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;display:grid;place-items:center;cursor:pointer}
.fm-an-play i{font-size:8px;margin-left:1px}.fm-an-play.playing i{margin-left:0}
.fm-an-wave{position:relative;display:flex;align-items:center;gap:2px;flex:1;min-width:80px;height:22px;cursor:pointer;touch-action:none}
.fm-an-bar{flex:1;min-width:1px;height:var(--h);border-radius:999px;background:#d0d5dd;transition:background .08s linear}
.fm-an-bar.played{background:var(--primary-readable,var(--primary,#d93025))}
.fm-an-time{flex:0 0 auto;min-width:60px;text-align:right;font-size:9px;font-weight:800;color:#667085;font-variant-numeric:tabular-nums}
.fm-an-modal-backdrop{position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.46);display:grid;place-items:center;padding:18px}
.fm-an-modal{width:min(100%,430px);border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.28);padding:18px;box-sizing:border-box;color:#101828}
.fm-an-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.fm-an-head strong{font-size:15px}
.fm-an-close{width:30px;height:30px;border:0;border-radius:8px;background:#f2f4f7;color:#667085;cursor:pointer}
.fm-an-live{height:82px;display:flex;align-items:center;justify-content:center;gap:3px;margin:18px 0 10px;padding:0 8px;border-radius:13px;background:#f8fafc;overflow:hidden}
.fm-an-live span{width:4px;height:var(--h);min-height:3px;border-radius:999px;background:var(--primary-readable,var(--primary,#d93025));opacity:.82}
.fm-an-status{text-align:center;color:#667085;font-size:12px;font-weight:750}.fm-an-clock{text-align:center;margin-top:4px;font-size:20px;font-weight:950;font-variant-numeric:tabular-nums}
.fm-an-actions{display:flex;justify-content:center;gap:8px;margin-top:18px}.fm-an-actions button{border:0;border-radius:10px;padding:9px 14px;font:inherit;font-size:12px;font-weight:900;cursor:pointer}
.fm-an-cancel{background:#f2f4f7;color:#475467}.fm-an-stop{background:#b42318;color:#fff}.fm-an-use{background:#101828;color:#fff}
.fm-an-record-dot{display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:999px;background:#d92d20;animation:fm-an-pulse 1.15s infinite}
.fm-an-inline{position:relative;width:100%;box-sizing:border-box;border:1px solid rgba(15,23,42,.1);border-radius:10px;background:#f8fafc;padding:7px 8px;margin-top:6px}
.fm-an-inline-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px;color:#475467;font-size:9px;font-weight:900}
.fm-an-inline-remove{flex:0 0 auto;width:24px;height:24px;border:0;border-radius:7px;background:transparent;color:#98a2b3;display:grid;place-items:center;cursor:pointer}.fm-an-inline-remove:hover{background:#eaecf0;color:#475467}
.fm-an-inline-body{display:flex;align-items:center;gap:7px;min-width:0}.fm-an-inline-wave{display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:27px;overflow:hidden}
.fm-an-inline-wave span{flex:1;min-width:1px;height:var(--h);border-radius:999px;background:var(--primary-readable,var(--primary,#d93025));opacity:.76;transition:height .07s linear}
.fm-an-inline-clock{flex:0 0 auto;min-width:32px;color:#667085;font-size:9px;font-weight:850;font-variant-numeric:tabular-nums}.fm-an-inline-stop{flex:0 0 auto;width:25px;height:25px;border:0;border-radius:999px;background:#b42318;color:#fff;display:grid;place-items:center;cursor:pointer}.fm-an-inline-stop i{font-size:8px}.fm-an-inline-stop.submit{width:34px;height:30px;border-radius:9px;background:var(--primary-readable,var(--primary,#d93025))}.fm-an-inline-stop.submit i{font-size:11px;margin-left:1px}
.fm-an-inline-status{display:flex;align-items:center;gap:6px;color:#667085;font-size:10px;font-weight:850}.fm-an-inline-status i{color:var(--primary-readable,var(--primary,#d93025))}
.fm-an-inline.review{margin:0;padding:2px 0;border:0;background:transparent}.fm-an-inline-review-body{display:grid;grid-template-columns:24px minmax(0,220px) 24px;align-items:center;justify-content:center;gap:4px;min-width:0}.fm-an-inline-review-action{width:24px;height:24px;border:0;border-radius:0;background:transparent;display:grid;place-items:center;padding:0;cursor:pointer;font-size:11px}.fm-an-inline-review-action.discard{color:#667085}.fm-an-inline-review-action.approve{color:#079455}.fm-an-inline-review-action:hover,.fm-an-inline-review-action:focus-visible{background:transparent;outline:none}.fm-an-inline-review-action.discard:hover{color:#b42318}.fm-an-inline-review-action.approve:hover{color:#067647}.fm-an-inline-review-player{min-width:0}.fm-an-inline-review-player .fm-an-player{display:grid;grid-template-columns:24px minmax(0,1fr) 50px;gap:4px;width:100%;min-height:26px;border:0;background:transparent;padding:0}.fm-an-inline-review-player .fm-an-play{width:24px;height:24px;border-radius:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));font-size:10px}.fm-an-inline-review-player .fm-an-wave{min-width:0;height:20px;gap:1px}.fm-an-inline-review-player .fm-an-bar{min-width:0}.fm-an-inline-review-player .fm-an-time{min-width:0;text-align:right;white-space:nowrap;font-size:8px}
.fm-an-inline.ready{padding:3px 25px 3px 4px}.fm-an-inline.ready .fm-an-inline-head{position:absolute;z-index:2;right:-6px;top:-7px;margin:0}.fm-an-inline.ready .fm-an-inline-head>span{display:none}.fm-an-inline.ready .fm-an-inline-remove{width:20px;height:20px;border:1px solid #e4e7ec;border-radius:999px;background:#fff;color:#667085;box-shadow:0 2px 7px rgba(15,23,42,.14);font-size:8px}.fm-an-inline.ready .fm-an-player{width:100%;padding:2px 0;border:0;background:transparent}
@keyframes fm-an-pulse{50%{opacity:.3}}`;
    document.head.appendChild(style);
  }

  function formatTime(seconds){
    const numeric = Number(seconds);
    const value = Math.max(0, Math.round(Number.isFinite(numeric) ? numeric : 0));
    const minutes = Math.floor(value / 60);
    return `${minutes}:${String(value % 60).padStart(2, '0')}`;
  }

  function audioBaseUrl(){
    const app = root.__APP || {};
    if (app.audioNotesApiBase) return clean(app.audioNotesApiBase).replace(/\/+$/, '');
    if (app.platformApiBase) return clean(app.platformApiBase).replace(/\/+$/, '').replace(/\/v1\/platform$/, '/v1/audio-notes');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '10.0.2.2') {
      return `${location.origin}/v1/audio-notes`;
    }
    return `${location.origin}/v1/audio-notes`;
  }

  function csrfToken(){
    const target = `${encodeURIComponent('fm_platform_session_csrf')}=`;
    const raw = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(target))?.slice(target.length) || '';
    return decodeURIComponent(raw);
  }

  async function transcribe(orgId, file, options = {}){
    const form = new FormData();
    form.append('file', file, file.name || 'audio-note.webm');
    if (clean(options.language)) form.append('language', clean(options.language));
    if (clean(options.prompt)) form.append('prompt', clean(options.prompt));
    const headers = { Accept:'application/json' };
    const csrf = csrfToken();
    if (csrf) headers['X-Platform-CSRF'] = csrf;
    const response = await fetch(`${audioBaseUrl()}/organizations/${encodeURIComponent(clean(orgId))}/transcriptions`, {
      method:'POST', headers, body:form, credentials:'include', cache:'no-store', signal:options.signal
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (error) {}
    if (!response.ok || data?.ok === false) {
      throw new Error(clean(data?.message || data?.error) || `Audio transcription failed (${response.status})`);
    }
    return data.transcription;
  }

  async function upload(orgId, file, options = {}){
    const form = new FormData();
    form.append('file', file, file.name || 'audio-note.webm');
    const headers = { Accept:'application/json' };
    const csrf = csrfToken();
    if (csrf) headers['X-Platform-CSRF'] = csrf;
    const response = await fetch(`${audioBaseUrl()}/organizations/${encodeURIComponent(clean(orgId))}/uploads`, {
      method:'POST', headers, body:form, credentials:'include', cache:'no-store', signal:options.signal
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (error) {}
    if (!response.ok || data?.ok === false) {
      throw new Error(clean(data?.message || data?.error) || `Audio upload failed (${response.status})`);
    }
    return data.attachment;
  }

  async function toWavFile(file, sampleRate = 8000){
    const AudioContext = root.AudioContext || root.webkitAudioContext;
    if (!AudioContext) return file;
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(await file.arrayBuffer());
      const targetRate = Math.max(8000, Math.min(48000, Number(sampleRate) || 8000));
      const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
      const pcm = new Int16Array(length);
      const channels = Array.from({ length:decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      for (let index = 0; index < length; index += 1) {
        const sourceIndex = Math.min(decoded.length - 1, Math.floor(index * decoded.sampleRate / targetRate));
        let value = 0;
        channels.forEach((channel) => { value += channel[sourceIndex] || 0; });
        value = clamp(value / Math.max(1, channels.length), -1, 1);
        pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      const bytes = new ArrayBuffer(44 + pcm.byteLength);
      const view = new DataView(bytes);
      const write = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
      write(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); write(8, 'WAVE');
      write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, targetRate, true);
      view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      write(36, 'data'); view.setUint32(40, pcm.byteLength, true);
      new Int16Array(bytes, 44).set(pcm);
      return new File([bytes], `audio-note-${Date.now()}.wav`, { type:'audio/wav' });
    } finally {
      await context.close().catch(() => {});
    }
  }

  function preferredMimeType(){
    const choices = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    return choices.find((type) => root.MediaRecorder?.isTypeSupported?.(type)) || '';
  }

  function extensionFor(type){
    if (type.includes('mp4')) return 'm4a';
    if (type.includes('ogg')) return 'ogg';
    return 'webm';
  }

  async function decodePeaks(blob, count = 72){
    const AudioContext = root.AudioContext || root.webkitAudioContext;
    if (!AudioContext) return [];
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      const data = buffer.getChannelData(0);
      const block = Math.max(1, Math.floor(data.length / count));
      const peaks = [];
      for (let index = 0; index < count; index += 1) {
        let max = 0;
        const start = index * block;
        const end = Math.min(data.length, start + block);
        for (let sample = start; sample < end; sample += Math.max(1, Math.floor(block / 80))) {
          max = Math.max(max, Math.abs(data[sample] || 0));
        }
        peaks.push(Math.round(clamp(max * 1.7, .08, 1) * 100) / 100);
      }
      return peaks;
    } catch (error) {
      return [];
    } finally {
      await context.close().catch(() => {});
    }
  }

  function record(options = {}){
    ensureStyles();
    if (!navigator.mediaDevices?.getUserMedia || !root.MediaRecorder) {
      return Promise.reject(new Error('Audio recording is not supported in this browser.'));
    }
    return new Promise(async (resolve, reject) => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      } catch (error) {
        reject(new Error('Microphone access is required to record an audio note.'));
        return;
      }

      const backdrop = document.createElement('div');
      backdrop.className = 'fm-an-modal-backdrop';
      backdrop.innerHTML = `<section class="fm-an-modal" role="dialog" aria-modal="true" aria-label="${String(esc(options.title || 'Record audio note'))}">
        <div class="fm-an-head"><strong>${String(esc(options.title || 'Record audio note'))}</strong><button class="fm-an-close" type="button" aria-label="${(globalThis.PlatformLanguage?.text("audio-notes","m_cbef679b21abb4","Cancel") ?? "Cancel")}"><i class="fas fa-xmark"></i></button></div>
        <div class="fm-an-live" aria-hidden="true"></div>
        <div class="fm-an-status"><span class="fm-an-record-dot"></span>${(globalThis.PlatformLanguage?.text("audio-notes","m_94f900bf5e2ad6","Recording") ?? "Recording")}</div>
        <div class="fm-an-clock">0:00</div>
        <div class="fm-an-actions"><button class="fm-an-cancel" type="button">${(globalThis.PlatformLanguage?.text("audio-notes","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="fm-an-stop" type="button"><i class="fas fa-stop"></i>${(globalThis.PlatformLanguage?.text("audio-notes","m_9cb65d38fbf170"," Stop") ?? " Stop")}</button></div>
      </section>`;
      document.body.appendChild(backdrop);
      const live = backdrop.querySelector('.fm-an-live');
      const clock = backdrop.querySelector('.fm-an-clock');
      const status = backdrop.querySelector('.fm-an-status');
      const actions = backdrop.querySelector('.fm-an-actions');
      const bars = Array.from({ length:72 }, () => {
        const bar = document.createElement('span');
        bar.style.setProperty('--h', '8%');
        live.appendChild(bar);
        return bar;
      });

      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      const startedAt = Date.now();
      const maxSeconds = clamp(options.maxSeconds || 600, 10, 3600);
      let stopped = false;
      let cancelled = false;
      let analyserContext = null;
      let animation = 0;
      let timer = 0;
      let previewUrl = '';
      let previewAudio = null;

      try {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (AudioContext) {
          analyserContext = new AudioContext();
          const analyser = analyserContext.createAnalyser();
          analyser.fftSize = 256;
          analyserContext.createMediaStreamSource(stream).connect(analyser);
          const values = new Uint8Array(analyser.frequencyBinCount);
          const paint = () => {
            analyser.getByteFrequencyData(values);
            const stride = Math.max(1, Math.floor(values.length / bars.length));
            bars.forEach((bar, index) => {
              const value = values[Math.min(values.length - 1, index * stride)] / 255;
              bar.style.setProperty('--h', `${Math.round(8 + value * 84)}%`);
            });
            animation = root.requestAnimationFrame(paint);
          };
          paint();
        }
      } catch (error) {}

      const cleanup = () => {
        root.clearInterval(timer);
        root.cancelAnimationFrame(animation);
        stream?.getTracks?.().forEach((track) => track.stop());
        analyserContext?.close?.().catch(() => {});
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        backdrop.remove();
      };
      const cancel = () => {
        cancelled = true;
        if (recorder.state !== 'inactive') recorder.stop();
        else { cleanup(); reject(new Error('Audio note recording was cancelled.')); }
      };
      backdrop.querySelector('.fm-an-close').addEventListener('click', cancel);
      backdrop.querySelector('.fm-an-cancel').addEventListener('click', cancel);
      backdrop.querySelector('.fm-an-stop').addEventListener('click', () => recorder.state !== 'inactive' && recorder.stop());
      backdrop.addEventListener('click', (event) => { if (event.target === backdrop) cancel(); });

      recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('error', () => {
        cleanup();
        reject(new Error('The browser could not record this audio note.'));
      });
      recorder.addEventListener('stop', async () => {
        if (stopped) return;
        stopped = true;
        stream.getTracks().forEach((track) => track.stop());
        root.clearInterval(timer);
        root.cancelAnimationFrame(animation);
        if (cancelled) {
          cleanup();
          reject(new Error('Audio note recording was cancelled.'));
          return;
        }
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          cleanup();
          reject(new Error('No audio was captured.'));
          return;
        }
        const duration = Math.max(.1, (Date.now() - startedAt) / 1000);
        const peaks = await decodePeaks(blob);
        const fallbackPeaks = bars.map((bar) => clamp(parseFloat(bar.style.getPropertyValue('--h')) / 100, .08, 1));
        const file = new File([blob], `audio-note-${Date.now()}.${extensionFor(type)}`, { type });
        previewUrl = URL.createObjectURL(file);
        live.innerHTML = '';
        previewAudio = createPlayer({ url:previewUrl, duration, peaks:peaks.length ? peaks : fallbackPeaks });
        live.appendChild(previewAudio);
        live.style.height = 'auto';
        live.style.padding = '12px 0';
        status.innerHTML = 'Recording ready';
        clock.textContent = formatTime(duration);
        actions.innerHTML = `<button class="fm-an-cancel" type="button">${(globalThis.PlatformLanguage?.text("audio-notes","m_4ab5419992b0f7","Discard") ?? "Discard")}</button><button class="fm-an-use" type="button"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.text("audio-notes","m_f32042ccf7223d"," Use recording") ?? " Use recording")}</button>`;
        actions.querySelector('.fm-an-cancel').addEventListener('click', cancel);
        actions.querySelector('.fm-an-use').addEventListener('click', () => {
          const result = { file, duration, peaks:peaks.length ? peaks : fallbackPeaks };
          cleanup();
          resolve(result);
        });
      });

      recorder.start(250);
      timer = root.setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        clock.textContent = formatTime(elapsed);
        if (elapsed >= maxSeconds && recorder.state !== 'inactive') recorder.stop();
      }, 250);
    });
  }

  function recordInline(options = {}){
    ensureStyles();
    const mount = options.mount;
    if (!mount) return Promise.reject(new Error('An inline audio-note mount is required.'));
    if (!navigator.mediaDevices?.getUserMedia || !root.MediaRecorder) {
      return Promise.reject(new Error('Audio recording is not supported in this browser.'));
    }
    return new Promise(async (resolve, reject) => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
      } catch (error) {
        reject(new Error('Microphone access is required to record an audio note.'));
        return;
      }
      mount.innerHTML = `<div class="fm-an-inline recording">
        <div class="fm-an-inline-head"><span><span class="fm-an-record-dot"></span>${(globalThis.PlatformLanguage?.text("audio-notes","m_114d45a4f9a9ba","Recording audio note") ?? "Recording audio note")}</span><button class="fm-an-inline-remove" type="button" aria-label="${(globalThis.PlatformLanguage?.text("audio-notes","m_ac946bb11e0417","Cancel recording") ?? "Cancel recording")}"><i class="fas fa-xmark"></i></button></div>
        <div class="fm-an-inline-body"><div class="fm-an-inline-wave" aria-hidden="true"></div><span class="fm-an-inline-clock">0:00</span><button class="fm-an-inline-stop ${String(options.submitStyle ? 'submit' : '')}" type="button" aria-label="${String(options.submitStyle ? 'Submit recording' : 'Finish recording')}"><i class="fas ${String(options.submitStyle ? 'fa-arrow-right' : 'fa-stop')}"></i></button></div>
      </div>`;
      const card = mount.firstElementChild;
      const wave = card.querySelector('.fm-an-inline-wave');
      const clock = card.querySelector('.fm-an-inline-clock');
      const bars = Array.from({ length:72 }, () => {
        const bar = document.createElement('span');
        bar.style.setProperty('--h', '8%');
        wave.appendChild(bar);
        return bar;
      });
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      const startedAt = Date.now();
      const maxSeconds = clamp(options.maxSeconds || 600, 10, 3600);
      let cancelled = false;
      let settled = false;
      let context = null;
      let animation = 0;
      let timer = 0;
      const cleanup = () => {
        root.clearInterval(timer);
        root.cancelAnimationFrame(animation);
        stream?.getTracks?.().forEach((track) => track.stop());
        context?.close?.().catch(() => {});
      };
      const cancel = () => {
        if (settled) return;
        cancelled = true;
        if (recorder.state !== 'inactive') recorder.stop();
      };
      card.querySelector('.fm-an-inline-remove').addEventListener('click', cancel);
      card.querySelector('.fm-an-inline-stop').addEventListener('click', () => recorder.state !== 'inactive' && recorder.stop());
      try {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (AudioContext) {
          context = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          context.createMediaStreamSource(stream).connect(analyser);
          const values = new Uint8Array(analyser.frequencyBinCount);
          const paint = () => {
            analyser.getByteFrequencyData(values);
            const stride = Math.max(1, Math.floor(values.length / bars.length));
            bars.forEach((bar, index) => {
              const value = values[Math.min(values.length - 1, index * stride)] / 255;
              bar.style.setProperty('--h', `${Math.round(8 + value * 84)}%`);
            });
            animation = root.requestAnimationFrame(paint);
          };
          paint();
        }
      } catch (error) {}
      recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
      recorder.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        cleanup();
        mount.innerHTML = '';
        reject(new Error('The browser could not record this audio note.'));
      });
      recorder.addEventListener('stop', async () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cancelled) {
          mount.innerHTML = '';
          reject(new Error('Audio note recording was cancelled.'));
          return;
        }
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (!blob.size) {
          mount.innerHTML = '';
          reject(new Error('No audio was captured.'));
          return;
        }
        const duration = Math.max(.1, (Date.now() - startedAt) / 1000);
        const peaks = await decodePeaks(blob);
        const fallback = bars.map((bar) => clamp(parseFloat(bar.style.getPropertyValue('--h')) / 100, .08, 1));
        const result = {
          file:new File([blob], `audio-note-${Date.now()}.${extensionFor(type)}`, { type }),
          duration,
          peaks:peaks.length ? peaks : fallback
        };
        if (!options.confirmPlayback) { resolve(result); return; }
        const previewUrl = URL.createObjectURL(result.file);
        mount.innerHTML = `<div class="fm-an-inline review"><div class="fm-an-inline-review-body"><button class="fm-an-inline-review-action discard" type="button" aria-label="${(globalThis.PlatformLanguage?.text("audio-notes","m_46a483e740de95","Discard recording") ?? "Discard recording")}"><i class="fas fa-xmark"></i></button><div class="fm-an-inline-review-player" data-fm-an-review-player></div><button class="fm-an-inline-review-action approve" type="button" aria-label="${(globalThis.PlatformLanguage?.text("audio-notes","m_2f3e450aa07011","Use recording") ?? "Use recording")}"><i class="fas fa-check"></i></button></div></div>`;
        const reviewPeaks = result.peaks.filter((_value, index) => index % 3 === 0);
        mount.querySelector('[data-fm-an-review-player]')?.appendChild(createPlayer({ url:previewUrl, duration:result.duration, peaks:reviewPeaks }));
        let reviewSettled = false;
        const finishReview = (approved) => {
          if (reviewSettled) return;
          reviewSettled = true;
          URL.revokeObjectURL(previewUrl);
          if (approved) resolve(result);
          else { mount.innerHTML = ''; reject(new Error('Audio note recording was cancelled.')); }
        };
        mount.querySelector('.fm-an-inline-review-action.discard')?.addEventListener('click', () => finishReview(false));
        mount.querySelector('.fm-an-inline-review-action.approve')?.addEventListener('click', () => finishReview(true));
      });
      recorder.start(250);
      timer = root.setInterval(() => {
        const elapsed = (Date.now() - startedAt) / 1000;
        clock.textContent = formatTime(elapsed);
        if (elapsed >= maxSeconds && recorder.state !== 'inactive') recorder.stop();
      }, 250);
    });
  }

  function mountProcessing(mount, recording, onRemove){
    const peaks = recording.peaks || [];
    mount.innerHTML = `<div class="fm-an-inline processing">
      <div class="fm-an-inline-head"><span class="fm-an-inline-status"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("audio-notes","m_5ee55174f196c9"," Generating transcript…") ?? " Generating transcript…")}</span><button class="fm-an-inline-remove" type="button" aria-label="${(globalThis.PlatformLanguage?.text("audio-notes","m_c98e98ebafeaae","Remove audio note") ?? "Remove audio note")}"><i class="fas fa-xmark"></i></button></div>
      <div class="fm-an-inline-body"><div class="fm-an-inline-wave" aria-hidden="true">${String(peaks.map((value) => `<span style="--h:${Math.round(16 + clamp(value,.06,1) * 78)}%"></span>`).join(''))}</div><span class="fm-an-inline-clock">${String(formatTime(recording.duration))}</span></div>
    </div>`;
    mount.querySelector('.fm-an-inline-remove')?.addEventListener('click', onRemove);
  }

  function mountPrepared(mount, options = {}){
    if (!mount) return null;
    mount.innerHTML = `<div class="fm-an-inline ready"><div class="fm-an-inline-head"><span><i class="fas fa-wave-square"></i>${(globalThis.PlatformLanguage?.text("audio-notes","m_deddf0a9a92a81"," Audio note") ?? " Audio note")}</span><button class="fm-an-inline-remove" type="button" aria-label="${(globalThis.PlatformLanguage?.text("audio-notes","m_c98e98ebafeaae","Remove audio note") ?? "Remove audio note")}"><i class="fas fa-xmark"></i></button></div><div data-fm-an-player></div></div>`;
    const card = mount.firstElementChild;
    card.querySelector('[data-fm-an-player]').appendChild(createPlayer({
      url:options.url,
      duration:options.duration,
      peaks:options.peaks
    }));
    card.querySelector('.fm-an-inline-remove').addEventListener('click', () => {
      mount.innerHTML = '';
      options.onRemove?.();
    });
    return card;
  }

  async function prepareInline(orgId, channelId, options = {}){
    const mount = options.mount;
    const recording = await recordInline(options);
    let recordedFile = recording.file;
    if (options.format === 'wav') recordedFile = await toWavFile(recordedFile, options.sampleRate || 8000);
    const sendUpload = typeof options.upload === 'function'
      ? options.upload
      : channelId && typeof root.ChannelsAPI?.uploads?.send === 'function'
        ? (file) => root.ChannelsAPI.uploads.send(orgId, file, channelId).then((result) => result.attachment)
        : (file) => upload(orgId, file, options);
    const controller = new AbortController();
    let removed = false;
    const remove = () => {
      removed = true;
      controller.abort();
      mount.innerHTML = '';
      options.onRemove?.();
    };
    mountProcessing(mount, recording, remove);
    try {
      const combined = typeof options.prepareRecording === 'function'
        ? await options.prepareRecording(recordedFile, { signal:controller.signal })
        : null;
      const transcription = combined?.transcription
        || await (typeof options.transcribe === 'function' ? options.transcribe(recordedFile, { signal:controller.signal }) : transcribe(orgId, recordedFile, { ...options, signal:controller.signal }));
      if (removed) throw new Error('Audio note recording was cancelled.');
      if (options.mode === 'dictation') {
        mount.innerHTML = '';
        const result = { text:clean(transcription.text), attachment:null, metadata:null };
        options.onPrepared?.(result);
        return result;
      }
      const attachment = combined?.attachment || await sendUpload(recordedFile);
      if (removed) throw new Error('Audio note recording was cancelled.');
      const prepared = {
        text:clean(transcription.text),
        attachment,
        metadata:{
          version:1,
          duration_seconds:Math.round(recording.duration * 100) / 100,
          peaks:recording.peaks.map((value) => Math.round(clamp(value, .04, 1) * 100) / 100),
          transcription_model:clean(transcription.model)
        }
      };
      const fileUrl = clean(prepared.attachment?.url || prepared.attachment?.public_url)
        || (channelId && root.ChannelsAPI?.mediaFileUrl ? root.ChannelsAPI.mediaFileUrl(orgId, prepared.attachment.media_id) : '');
      mountPrepared(mount, {
        url:fileUrl,
        duration:prepared.metadata.duration_seconds,
        peaks:prepared.metadata.peaks,
        onRemove:options.onRemove
      });
      options.onPrepared?.(prepared);
      return prepared;
    } catch (error) {
      if (!removed) mount.innerHTML = '';
      if (error?.name === 'AbortError' || removed) throw new Error('Audio note recording was cancelled.');
      throw error;
    }
  }

  async function prepare(orgId, channelId, options = {}){
    const recording = await record(options);
    const upload = root.ChannelsAPI?.uploads?.send;
    if (typeof upload !== 'function') throw new Error('Audio upload is unavailable.');
    // Transcribe before storing so provider failures do not leave unattached
    // media records behind.
    const transcription = await transcribe(orgId, recording.file, options);
    const uploaded = await upload(orgId, recording.file, channelId);
    return {
      text:clean(transcription.text),
      attachment:uploaded.attachment,
      metadata:{
        version:1,
        duration_seconds:Math.round(recording.duration * 100) / 100,
        peaks:recording.peaks.map((value) => Math.round(clamp(value, .04, 1) * 100) / 100),
        transcription_model:clean(transcription.model)
      }
    };
  }

  async function prepareFile(orgId, channelId, file, options = {}){
    if (!(file instanceof Blob) || !String(file.type || '').toLowerCase().startsWith('audio/')) {
      throw new Error('Choose an audio file to transcribe.');
    }
    const uploadFile = file instanceof File
      ? file
      : new File([file], `audio-note-${Date.now()}.${extensionFor(file.type || '')}`, { type:file.type || 'audio/webm' });
    const upload = root.ChannelsAPI?.uploads?.send;
    if (typeof upload !== 'function') throw new Error('Audio upload is unavailable.');
    const [transcription, peaks] = await Promise.all([
      transcribe(orgId, uploadFile, options),
      decodePeaks(uploadFile)
    ]);
    const uploaded = await upload(orgId, uploadFile, channelId);
    return {
      text:clean(transcription.text),
      attachment:uploaded.attachment,
      metadata:{
        version:1,
        duration_seconds:0,
        peaks:peaks.map((value) => Math.round(clamp(value, .04, 1) * 100) / 100),
        transcription_model:clean(transcription.model),
        source:'uploaded_audio'
      }
    };
  }

  function createPlayer(options = {}){
    ensureStyles();
    const player = document.createElement('div');
    player.className = 'fm-an-player';
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = clean(options.url);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'fm-an-play';
    button.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("audio-notes","m_ee4f1bcb190626","Play audio note") ?? "Play audio note"));
    button.innerHTML = '<i class="fas fa-play"></i>';
    const wave = document.createElement('div');
    wave.className = 'fm-an-wave';
    wave.setAttribute('role', 'slider');
    wave.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("audio-notes","m_927f9140952c71","Audio progress") ?? "Audio progress"));
    wave.tabIndex = 0;
    const peaks = Array.isArray(options.peaks) && options.peaks.length
      ? options.peaks.slice(0, 120).map((value) => clamp(value, .06, 1))
      : Array.from({ length:56 }, (_, index) => .18 + Math.abs(Math.sin(index * .71)) * .62);
    const bars = peaks.map((value) => {
      const bar = document.createElement('span');
      bar.className = 'fm-an-bar';
      bar.style.setProperty('--h', `${Math.round(16 + value * 78)}%`);
      wave.appendChild(bar);
      return bar;
    });
    const time = document.createElement('span');
    time.className = 'fm-an-time';
    let duration = Number.isFinite(Number(options.duration)) ? Math.max(0, Number(options.duration)) : 0;
    const render = () => {
      const rawCurrent = Number(audio.currentTime);
      const rawDuration = Number(audio.duration);
      const current = Number.isFinite(rawCurrent) ? Math.max(0, rawCurrent) : 0;
      const total = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : duration;
      const progress = total > 0 ? clamp(current / total, 0, 1) : 0;
      bars.forEach((bar, index) => bar.classList.toggle('played', index / bars.length <= progress));
      time.textContent = `${formatTime(current)} / ${formatTime(total)}`;
      wave.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    };
    const seek = (fraction) => {
      const rawDuration = Number(audio.duration);
      const total = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : duration;
      if (Number.isFinite(total) && total > 0) audio.currentTime = clamp(fraction, 0, 1) * total;
    };
    wave.addEventListener('click', (event) => {
      const rect = wave.getBoundingClientRect();
      seek((event.clientX - rect.left) / Math.max(1, rect.width));
    });
    wave.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const rawDuration = Number(audio.duration);
      const total = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : duration;
      const current = Number.isFinite(Number(audio.currentTime)) ? Number(audio.currentTime) : 0;
      audio.currentTime = clamp(current + (event.key === 'ArrowRight' ? 5 : -5), 0, total);
    });
    button.addEventListener('click', () => audio.paused ? audio.play() : audio.pause());
    audio.addEventListener('play', () => { button.classList.add('playing'); button.innerHTML = '<i class="fas fa-pause"></i>'; });
    audio.addEventListener('pause', () => { button.classList.remove('playing'); button.innerHTML = '<i class="fas fa-play"></i>'; });
    audio.addEventListener('ended', () => { audio.currentTime = 0; render(); });
    audio.addEventListener('durationchange', () => {
      const nextDuration = Number(audio.duration);
      if (Number.isFinite(nextDuration) && nextDuration > 0) duration = nextDuration;
      render();
    });
    audio.addEventListener('timeupdate', render);
    player.append(button, wave, time, audio);
    audio.hidden = true;
    render();
    return player;
  }

  function playerHtml(options = {}){
    const peaks = Array.isArray(options.peaks) ? options.peaks.map((value) => clamp(value, .04, 1)).join(',') : '';
    return `<div data-fm-audio-player data-url="${esc(options.url)}" data-duration="${esc(options.duration || 0)}" data-peaks="${esc(peaks)}"></div>`;
  }

  function hydrate(container = document){
    container.querySelectorAll?.('[data-fm-audio-player]').forEach((mount) => {
      if (mount.dataset.hydrated === '1') return;
      mount.dataset.hydrated = '1';
      const peaks = clean(mount.dataset.peaks).split(',').map(Number).filter(Number.isFinite);
      mount.appendChild(createPlayer({ url:mount.dataset.url, duration:Number(mount.dataset.duration), peaks }));
    });
  }

  ensureStyles();
  root.FirstMateAudioNotes = {
    record, recordInline, transcribe, upload, toWavFile, prepare, prepareInline, prepareFile, createPlayer, mountPrepared, playerHtml, hydrate, formatTime
  };
})();
