/* Reusable browser bridge for raw audio -> registered structured processors. */
(function(){
  const root = window;
  if (root.FirstMateAudioStructure) return;

  const clean = (value) => String(value ?? '').trim();

  async function recordAndProcess(options = {}){
    const audioNotes = root.FirstMateAudioNotes;
    if (!audioNotes?.recordInline || !audioNotes?.toWavFile) {
      throw new Error('The audio recording library is not loaded.');
    }
    if (!options.mount) throw new Error('A recording mount is required.');
    if (!clean(options.url)) throw new Error('A structured-audio endpoint is required.');
    const recording = await audioNotes.recordInline({
      mount:options.mount,
      maxSeconds:options.maxSeconds || 600,
      submitStyle:true
    });
    options.mount.innerHTML = `<div class="fm-as-processing"><i class="fas fa-circle-notch fa-spin"></i><span>${clean(options.processingLabel) || 'Understanding checklist…'}</span></div>`;
    try {
      const wav = await audioNotes.toWavFile(recording.file, 24_000);
      const form = new FormData();
      form.append(options.fileField || 'audio', wav, wav.name || `structured-audio-${Date.now()}.wav`);
      Object.entries(options.fields || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null) form.append(key, String(value));
      });
      const headers = { Accept:'application/json', ...(options.headers || {}) };
      const csrf = document.cookie.split(';').map((part) => part.trim())
        .find((part) => part.startsWith('fm_platform_session_csrf='))
        ?.split('=').slice(1).join('=');
      if (csrf && !headers['X-Platform-CSRF']) headers['X-Platform-CSRF'] = decodeURIComponent(csrf);
      const response = await fetch(options.url, {
        method:'POST',
        body:form,
        credentials:'include',
        cache:'no-store',
        headers
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) {}
      if (!response.ok || data?.ok === false) {
        const error = new Error(clean(data?.message || data?.error) || `Structured audio failed (${response.status})`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      options.mount.innerHTML = '';
      return { data, recording, wav };
    } catch (error) {
      options.mount.innerHTML = '';
      throw error;
    }
  }

  root.FirstMateAudioStructure = { recordAndProcess };
})();
