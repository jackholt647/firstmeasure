/* libraries/session-replay/session-replay-viewer.js
 * The replay viewer page (viewer.html): sessions, the organization switch, the
 * player, and what each session costs. Platform administrators only; the server
 * enforces it. See docs/architecture/session-replay.md.
 */
(function () {
  'use strict';
  const Codec = window.FMReplayCodec;
  const Player = window.FMReplayPlayer;
  const { E, PTR, DIAG_FIELDS } = Codec;
  const API = location.origin + '/v1/platform';
  const LIVE_MS = 60000;
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DIAG = Object.fromEntries(DIAG_FIELDS.map((name, index) => [name, index]));

  const state = {
    me: null, csrf: '', sessions: [], sessionId: '', detail: null, model: null, blobs: new Map(), player: null,
    poll: 0, polling: false, scope: 'current', query: '', events: [], eventTimes: [], live: false, currentEvent: -1,
    stats: null, orgs: [], openToken: 0
  };

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function fmtBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function fmtDuration(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  }
  function fmtAgo(t, now) {
    const seconds = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function shortUrl(url) {
    try { const u = new URL(url); return u.pathname + u.search + u.hash; } catch (error) { return url || ''; }
  }
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ---------------------------------------------------------------------------
  // Server
  // ---------------------------------------------------------------------------
  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) headers['X-Platform-CSRF'] = state.csrf;
    const response = await fetch(API + path, {
      method, credentials: 'include', cache: 'no-store', headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok || (data && data.ok === false)) {
      const error = new Error((data && (data.message || data.error)) || 'Request failed (' + response.status + ')');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function gunzipBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }

  // ---------------------------------------------------------------------------
  // Organization switch
  // ---------------------------------------------------------------------------
  async function loadOrganizations(query) {
    const data = await api('/session-replay/admin/organizations' + (query ? '?q=' + encodeURIComponent(query) : ''));
    return data.organizations || [];
  }

  async function refreshCurrentOrg() {
    const orgs = await loadOrganizations('');
    state.orgs = orgs;
    const current = orgs.find((org) => org.current);
    $('org-panel').hidden = !current;
    if (!current) return;
    $('org-name').textContent = current.name;
    $('org-name').title = current.organization_id;
    $('org-toggle').checked = current.enabled;
    $('org-toggle').dataset.org = current.organization_id;
    $('org-hint').textContent = current.enabled
      ? 'Recording everyone in this organization. Pages start recording when they load.'
      : 'Off. Turn it on, then refresh any page in this organization to start recording.';
  }

  async function setOrgReplay(orgId, enabled) {
    const result = await api('/session-replay/admin/organizations/' + encodeURIComponent(orgId), { method: 'PUT', body: { enabled } });
    toast('Session replay is ' + (result.enabled ? 'on' : 'off') + ' for ' + (state.orgs.find((o) => o.organization_id === orgId)?.name || orgId) + '.');
    return result.enabled;
  }

  function renderOrgList(orgs) {
    const list = $('org-list');
    if (!orgs.length) { list.innerHTML = '<div class="empty">No organizations match.</div>'; return; }
    list.innerHTML = orgs.map((org) => '<div class="org-item"><div style="min-width:0"><div class="name">' + esc(org.name) + (org.current ? ' <span class="meta">(yours)</span>' : '') + '</div>'
      + '<div class="meta">' + esc(org.organization_id) + (org.totals ? ' · ' + org.totals.sessions + ' sessions · ' + fmtBytes(org.totals.bytes_stored) : '') + '</div></div>'
      + '<label class="switch"><input type="checkbox" data-org="' + esc(org.organization_id) + '"' + (org.enabled ? ' checked' : '') + '><span></span></label></div>').join('');
  }

  function bindOrgPanel() {
    $('org-toggle').addEventListener('change', async (event) => {
      const input = event.target;
      input.disabled = true;
      try { input.checked = await setOrgReplay(input.dataset.org, input.checked); await refreshCurrentOrg(); }
      catch (error) { input.checked = !input.checked; toast(error.message); }
      finally { input.disabled = false; }
    });
    $('org-more').addEventListener('click', async () => {
      const picker = $('org-picker');
      picker.hidden = !picker.hidden;
      if (!picker.hidden) { renderOrgList(await loadOrganizations('')); $('org-search').focus(); }
    });
    let timer = 0;
    $('org-search').addEventListener('input', (event) => {
      clearTimeout(timer);
      timer = setTimeout(async () => { try { renderOrgList(await loadOrganizations(event.target.value.trim())); } catch (error) { toast(error.message); } }, 250);
    });
    $('org-list').addEventListener('change', async (event) => {
      const input = event.target;
      if (!input.dataset.org) return;
      input.disabled = true;
      try { input.checked = await setOrgReplay(input.dataset.org, input.checked); if (input.dataset.org === $('org-toggle').dataset.org) await refreshCurrentOrg(); }
      catch (error) { input.checked = !input.checked; toast(error.message); }
      finally { input.disabled = false; }
    });
  }

  // ---------------------------------------------------------------------------
  // Session list
  // ---------------------------------------------------------------------------
  async function loadSessions() {
    const params = new URLSearchParams({ limit: '80' });
    if (state.scope === 'current' && state.me) params.set('org_id', state.me.org_id);
    if (state.query) params.set('q', state.query);
    try {
      const data = await api('/session-replay/admin/sessions?' + params.toString());
      state.sessions = data.sessions || [];
      state.serverNow = data.now || Date.now();
      renderSessions();
    } catch (error) {
      $('session-list').innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
    }
  }

  function renderSessions() {
    const list = $('session-list');
    if (!state.sessions.length) {
      list.innerHTML = '<div class="empty">No sessions yet. Turn session replay on for the organization, then load a page while signed in.</div>';
      return;
    }
    list.innerHTML = state.sessions.map((s) => {
      const live = state.serverNow - s.last_at < LIVE_MS;
      return '<div class="session' + (s.id === state.sessionId ? ' active' : '') + '" data-id="' + esc(s.id) + '">'
        + '<div class="line1"><span class="who">' + (live ? '<span class="dot-live"></span>' : '') + esc(s.user_name || s.user_email || 'Unknown') + '</span>'
        + '<span class="when">' + esc(fmtAgo(s.last_at, state.serverNow)) + '</span></div>'
        + '<div class="line2">' + esc(fmtDuration(s.last_at - s.started_at)) + ' · ' + s.pages + (s.pages === 1 ? ' page' : ' pages') + ' · ' + esc(fmtBytes(s.bytes_stored))
        + (state.scope === 'all' ? ' · ' + esc(s.organization_name) : '') + '</div>'
        + '<div class="line3">' + esc(shortUrl(s.last_url)) + '</div></div>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // Opening a session
  // ---------------------------------------------------------------------------
  async function syncChunks(detail) {
    let added = false;
    for (const page of detail.pages) {
      const track = state.model.addPage(page.page_id, page.started_at);
      if (page.max_seq < track.nextSeq) continue;
      let after = track.nextSeq - 1;
      for (let guard = 0; guard < 1000; guard++) {
        const data = await api('/session-replay/admin/sessions/' + encodeURIComponent(detail.session.id) + '/chunks?page_id=' + encodeURIComponent(page.page_id) + '&after_seq=' + after + '&limit=200');
        for (const chunk of data.chunks) {
          let parsed;
          try { parsed = JSON.parse(await gunzipBase64(chunk.data)); } catch (error) { console.warn('[session replay] unreadable chunk', page.page_id, chunk.seq, error); continue; }
          if (state.model.addChunk(page.page_id, chunk.seq, parsed, { seq: chunk.seq, t_start: chunk.t_start, t_end: chunk.t_end, bytes_stored: chunk.bytes_stored, bytes_raw: chunk.bytes_raw, events: chunk.events })) added = true;
          after = chunk.seq;
        }
        if (data.chunks.length < 200) break;
      }
    }
    return added;
  }

  async function syncBlobs() {
    const wanted = [...state.model.blobKeys()].filter((key) => !state.blobs.has(key));
    if (!wanted.length || !state.detail) return false;
    let added = false;
    for (let i = 0; i < wanted.length; i += 40) {
      const keys = wanted.slice(i, i + 40);
      const data = await api('/session-replay/admin/blobs?org_id=' + encodeURIComponent(state.detail.session.organization_id) + '&keys=' + encodeURIComponent(keys.join(',')));
      for (const [key, b64] of Object.entries(data.blobs || {})) {
        try { state.blobs.set(key, await gunzipBase64(b64)); added = true; } catch (error) { console.warn('[session replay] unreadable blob', key); }
      }
    }
    return added;
  }

  function ensurePlayer() {
    if (state.player) return state.player;
    const placeholder = $('placeholder');
    if (placeholder) placeholder.remove();
    state.player = Player.create({ stage: $('stage'), blobs: state.blobs });
    state.player.on(onPlayer);
    return state.player;
  }

  async function openSession(id, follow) {
    if (!id) return;
    const token = ++state.openToken;
    stopPolling();
    state.sessionId = id;
    renderSessions();
    const wanted = '#session=' + encodeURIComponent(id) + (follow ? '&live=1' : '');
    if (location.hash !== wanted) history.replaceState(null, '', wanted);
    $('session-title').textContent = 'Loading…';
    let detail;
    try { detail = await api('/session-replay/admin/sessions/' + encodeURIComponent(id)); }
    catch (error) { $('session-title').textContent = error.message; return; }
    if (token !== state.openToken) return;
    state.detail = detail;
    state.model = new Player.SessionModel();
    state.blobs.clear();
    const player = ensurePlayer();
    player.pause();
    player.model = state.model;
    try {
      await syncChunks(detail);
      await syncBlobs();
    } catch (error) { toast(error.message); }
    if (token !== state.openToken) return;
    const s = detail.session;
    $('session-title').textContent = (s.user_name || s.user_email || 'Session') + ' · ' + new Date(s.started_at).toLocaleString();
    $('play').disabled = !isFinite(state.model.start);
    renderAll();
    refreshStats();
    const live = detail.now - s.last_at < LIVE_MS;
    setLive(live);
    if (live && follow) setFollow(true);
    else player.seek(state.model.start);
    if (!isFinite(state.model.start)) $('session-title').textContent += ' · nothing recorded yet';
    if (live) startPolling();
  }

  function renderAll() {
    buildEvents();
    renderEvents();
    renderTimeline();
    renderStorage();
    renderPerformance();
    renderDevice();
  }

  function setLive(live) {
    state.live = live;
    $('live-badge').hidden = !live;
    $('follow').hidden = !live;
    if (!live) setFollow(false);
  }

  function setFollow(on) {
    const player = state.player;
    if (!player) return;
    player.follow = on;
    $('follow').classList.toggle('on', on);
    $('follow').textContent = on ? 'Following live' : 'Follow live';
    if (on) {
      player.speed = 1;
      $('speed').value = '1';
      player.seek(state.model.end - 1000);
      player.play();
    }
  }

  function startPolling() {
    stopPolling();
    state.poll = setInterval(poll, 2500);
  }
  function stopPolling() {
    if (state.poll) clearInterval(state.poll);
    state.poll = 0;
  }

  async function poll() {
    if (state.polling || !state.detail) return;
    state.polling = true;
    const id = state.detail.session.id;
    try {
      const detail = await api('/session-replay/admin/sessions/' + encodeURIComponent(id));
      if (!state.detail || state.detail.session.id !== id) return;
      state.detail = detail;
      const added = await syncChunks(detail);
      const newBlobs = await syncBlobs();
      if (added || newBlobs) {
        renderAll();
        if (newBlobs) state.player.rebuild(); else state.player.refresh();
        $('play').disabled = false;
      }
      const live = detail.now - detail.session.last_at < LIVE_MS;
      if (live !== state.live) setLive(live);
      if (!live) stopPolling();
    } catch (error) {
      console.warn('[session replay] poll failed', error);
    } finally {
      state.polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Events list and timeline
  // ---------------------------------------------------------------------------
  const QUIET_KEYS = new Set(['char', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified']);
  function keyName(key, mods) {
    const parts = [];
    if (mods & 1) parts.push('Ctrl');
    if (mods & 2) parts.push('Alt');
    if (mods & 4 && key.length > 1) parts.push('Shift');
    if (mods & 8) parts.push('Cmd');
    parts.push(key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key);
    return parts.join('+');
  }

  function buildEvents() {
    const out = [];
    let lastInput = null;
    let lastKey = null;
    for (const event of state.model.allEvents()) {
      const page = event.page, a = event.a;
      const text = (id) => page.text(id);
      switch (event.type) {
        case E.SNAPSHOT:
          out.push({ t: event.t, kind: 'page', title: (page.meta && page.meta.title) || 'Page loaded', sub: page.meta ? shortUrl(page.meta.url) : '' });
          break;
        case E.NAV: out.push({ t: event.t, kind: 'nav', title: 'Went to ' + shortUrl(text(a[0])), sub: '' }); break;
        case E.PTR:
          if (a[0] === PTR.CLICK || a[0] === PTR.CONTEXTMENU || a[0] === PTR.DBLCLICK) {
            const label = a.length > 6 ? text(a[6]) : '';
            const verb = a[0] === PTR.CONTEXTMENU ? 'Right-clicked' : a[0] === PTR.DBLCLICK ? 'Double-clicked' : (a[5] === 1 ? 'Tapped' : 'Clicked');
            out.push({ t: event.t, kind: 'click', title: verb + (label ? ' “' + label + '”' : ''), sub: a.length > 7 ? text(a[7]) : '' });
          }
          break;
        case E.KEY: {
          const key = text(a[0]);
          if (QUIET_KEYS.has(key)) break;
          const name = keyName(key, a[1]);
          if (lastKey && lastKey.name === name && event.t - lastKey.t < 2000) { lastKey.count++; lastKey.t = event.t; lastKey.entry.title = name + ' ×' + lastKey.count; break; }
          const entry = { t: event.t, kind: 'key', title: name, sub: '' };
          out.push(entry);
          lastKey = { name, t: event.t, count: 1, entry };
          break;
        }
        case E.INPUT:
          if (lastInput && lastInput.id === a[0] && event.t - lastInput.t < 4000) { lastInput.count++; lastInput.t = event.t; lastInput.entry.sub = lastInput.count + ' changes'; break; }
          lastInput = { id: a[0], t: event.t, count: 1, entry: { t: event.t, kind: 'input', title: a[1] === 1 ? (a[2] ? 'Checked a box' : 'Unchecked a box') : 'Typed in a field', sub: '' } };
          out.push(lastInput.entry);
          break;
        case E.ERR: out.push({ t: event.t, kind: 'error', title: text(a[0]), sub: (text(a[1]) || '') + (a[2] ? ':' + a[2] : '') }); break;
        case E.VIS: out.push({ t: event.t, kind: 'vis', title: a[0] ? 'Switched away from the tab' : 'Came back to the tab', sub: '' }); break;
        case E.END: out.push({ t: event.t, kind: 'vis', title: 'Left the page', sub: '' }); break;
        case E.CUSTOM: out.push({ t: event.t, kind: 'custom', title: text(a[0]), sub: text(a[1]) }); break;
        default: break;
      }
    }
    state.events = out;
    state.eventTimes = out.map((entry) => entry.t);
  }

  function renderEvents() {
    const list = $('event-list');
    const start = state.model.start;
    if (!state.events.length) { list.innerHTML = '<div class="empty">Nothing happened yet.</div>'; return; }
    list.innerHTML = state.events.map((entry, index) => '<div class="event" data-index="' + index + '"><span class="t">' + fmtDuration(entry.t - start) + '</span>'
      + '<span class="k ' + entry.kind + '"></span><span class="d">' + esc(entry.title) + (entry.sub ? '<small>' + esc(entry.sub) + '</small>' : '') + '</span></div>').join('');
    state.currentEvent = -1;
    highlightEvent(true);
  }

  function highlightEvent(force) {
    if (!state.player) return;
    const t = state.player.time;
    let lo = 0, hi = state.eventTimes.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (state.eventTimes[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    if (found === state.currentEvent && !force) return;
    const list = $('event-list');
    const previous = list.querySelector('.event.current');
    if (previous) previous.classList.remove('current');
    state.currentEvent = found;
    const el = found >= 0 ? list.querySelector('[data-index="' + found + '"]') : null;
    if (el) {
      el.classList.add('current');
      if (state.player.playing) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderTimeline() {
    const track = $('track');
    const model = state.model;
    const start = model.start, end = model.end, span = Math.max(1, end - start);
    if (!isFinite(start)) { track.innerHTML = ''; return; }
    const pct = (t) => ((t - start) / span) * 100;
    let html = '';
    for (const page of model.pages) {
      if (!isFinite(page.firstT)) continue;
      html += '<div class="seg" style="left:' + pct(page.firstT) + '%;width:' + Math.max(0.3, pct(page.lastT) - pct(page.firstT)) + '%"></div>';
    }
    for (const gap of model.idleGaps()) html += '<div class="idle" style="left:' + pct(gap[0]) + '%;width:' + (pct(gap[1]) - pct(gap[0])) + '%"></div>';
    let marks = 0;
    for (const entry of state.events) {
      if (marks++ > 2500) break;
      const kind = entry.kind === 'click' || entry.kind === 'page' || entry.kind === 'nav' || entry.kind === 'error' || entry.kind === 'key' ? entry.kind : '';
      if (!kind) continue;
      html += '<div class="mark ' + kind + '" style="left:' + pct(entry.t) + '%" title="' + esc(entry.title) + '"></div>';
    }
    track.innerHTML = html;
    $('time-total').textContent = fmtDuration(span);
    updateTime();
  }

  function updateTime() {
    if (!state.player || !state.model || !isFinite(state.model.start)) return;
    const start = state.model.start, span = Math.max(1, state.model.end - start);
    const t = state.player.time;
    $('time-now').textContent = fmtDuration(t - start);
    $('time-total').textContent = fmtDuration(span);
    $('playhead').style.left = (((t - start) / span) * 100) + '%';
    const mirror = state.player.mirror;
    $('page-url').textContent = mirror.url ? shortUrl(mirror.url) : '';
    $('skip-badge').hidden = !state.player.skipping;
  }

  function onPlayer(kind) {
    if (kind === 'time' || kind === 'data') {
      updateTime();
      highlightEvent(false);
    }
    if (kind === 'state') {
      $('play').textContent = state.player.playing ? '❚❚' : '▶';
      $('skip-badge').hidden = !state.player.skipping;
    }
  }

  function seekToFraction(fraction) {
    const model = state.model;
    if (!state.player || !model || !isFinite(model.start)) return;
    if (state.player.follow) setFollow(false);
    state.player.seek(model.start + fraction * (model.end - model.start));
  }

  // ---------------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------------
  function drawChart(canvas, series, options = {}) {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 320, height = canvas.clientHeight || 120;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    const points = series.flatMap((s) => s.points);
    if (!points.length) {
      ctx.fillStyle = '#8b93a1'; ctx.font = '12px Inter, sans-serif'; ctx.fillText('No data yet', 10, 20);
      return;
    }
    const linePoints = series.filter((s) => !s.bars).flatMap((s) => s.points);
    const xMin = options.xMin ?? Math.min(...points.map((p) => p[0]));
    const xMax = options.xMax ?? Math.max(...points.map((p) => p[0]));
    const yMax = Math.max(options.yMin || 0, ...linePoints.map((p) => p[1])) * 1.1 || 1;
    const pad = { l: 8, r: 8, t: 18, b: 16 };
    const x = (v) => pad.l + ((v - xMin) / Math.max(1, xMax - xMin)) * (width - pad.l - pad.r);
    const y = (v) => height - pad.b - (v / yMax) * (height - pad.t - pad.b);
    ctx.strokeStyle = '#262b35'; ctx.lineWidth = 1;
    for (let i = 0; i <= 2; i++) { const gy = pad.t + (i / 2) * (height - pad.t - pad.b); ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(width - pad.r, gy); ctx.stroke(); }
    series.forEach((s) => {
      if (!s.points.length) return;
      if (s.bars) {
        // Bars use their own scale, up to 40% of the plot height.
        const max = Math.max(...s.points.map((p) => p[1])) || 1;
        const barWidth = Math.max(2, ((width - pad.l - pad.r) / Math.max(40, s.points.length)) * 0.6);
        ctx.fillStyle = s.color;
        s.points.forEach((p) => { const h = (p[1] / max) * (height - pad.t - pad.b) * 0.4; ctx.fillRect(x(p[0]) - barWidth / 2, height - pad.b - h, barWidth, h); });
        return;
      }
      if (s.points.length === 1) {
        ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x(s.points[0][0]), y(s.points[0][1]), 3, 0, Math.PI * 2); ctx.fill();
        return;
      }
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.beginPath();
      s.points.forEach((p, i) => { const px = x(p[0]), py = y(p[1]); if (i && s.step) ctx.lineTo(px, y(s.points[i - 1][1])); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
    });
    ctx.fillStyle = '#8b93a1'; ctx.font = '11px Inter, sans-serif';
    ctx.fillText((options.format || String)(yMax / 1.1) + ' max', pad.l, 12);
    if (options.xLabel) { const label = options.xLabel; ctx.fillText(label, width - pad.r - ctx.measureText(label).width, height - 3); }
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  async function refreshStats() {
    try {
      const data = await api('/session-replay/admin/stats');
      state.stats = data.organizations || [];
      renderStorage();
    } catch (error) { state.stats = null; }
  }

  // A page's first 15 seconds are its load: the snapshot plus the app rendering into it. Everything later is
  // the steady cost of having the page open, idle time included.
  const LOAD_MS = 15000;
  const HOURS_PER_MONTH = 730;

  function storageNumbers() {
    const detail = state.detail;
    const s = detail.session;
    const sizes = (detail.chunk_sizes || []).slice().sort((a, b) => a.t_end - b.t_end);
    const durationMs = Math.max(1000, s.last_at - s.started_at);
    const pageStart = new Map((detail.pages || []).map((page) => [page.page_id, page.started_at]));
    const pageCount = Math.max(1, (detail.pages || []).length);
    let loadBytes = 0, steadyBytes = 0;
    for (const c of sizes) {
      const start = pageStart.get(c.page_id) ?? s.started_at;
      if (c.t_end - start <= LOAD_MS) loadBytes += c.bytes_stored; else steadyBytes += c.bytes_stored;
    }
    let steadyMs = 0;
    for (const page of detail.pages || []) steadyMs += Math.max(0, page.last_at - page.started_at - LOAD_MS);
    return { s, sizes, durationMs, pageCount, loadBytes, steadyBytes, steadyMs, loadPerPage: loadBytes / pageCount, steadyPerMin: steadyMs >= 60000 ? steadyBytes / (steadyMs / 60000) : null };
  }

  function renderStorage() {
    const root = $('storage');
    if (!state.detail) { root.innerHTML = '<div class="empty">No session open.</div>'; return; }
    const n = storageNumbers();
    const org = (state.stats || []).find((o) => o.organization_id === n.s.organization_id);
    const orgRate = org && org.active_ms > 0 ? org.bytes_stored / (org.active_ms / 3600000) : 0;
    const sessionRate = n.s.bytes_stored / (n.durationMs / 3600000);
    const provisional = !org || org.active_ms < 30 * 60000;
    const defaultLoadKb = Math.round(n.loadPerPage / 1024);
    const defaultSteadyKb = n.steadyPerMin === null ? 5 : Math.round((n.steadyPerMin / 1024) * 10) / 10;
    root.innerHTML = '<div class="cards">'
      + card('Stored (gzip)', fmtBytes(n.s.bytes_stored), 'raw JSON ' + fmtBytes(n.s.bytes_raw) + (n.s.bytes_stored ? ' · ' + (n.s.bytes_raw / n.s.bytes_stored).toFixed(1) + '× smaller' : ''))
      + card('Per open hour', fmtBytes(sessionRate), 'this session: ' + fmtBytes(n.s.bytes_stored) + ' over ' + fmtDuration(n.durationMs))
      + card('Per page load', fmtBytes(n.loadPerPage), 'snapshot plus the first 15 s while the app renders; ' + n.pageCount + (n.pageCount === 1 ? ' load' : ' loads'))
      + card('After loading', n.steadyPerMin === null ? 'too short' : fmtBytes(n.steadyPerMin) + '/min', n.steadyPerMin === null ? 'needs a minute past the load' : 'open page, idle time included')
      + '</div><div class="section"><h3>Size as the session grows</h3><canvas class="chart" id="growth-chart"></canvas>'
      + '<div class="legend"><span><i style="background:#60a5fa"></i>stored total</span><span><i style="background:#f59e0b"></i>per chunk</span></div>'
      + '<p>Most of a short session is its page loads: the snapshot and the app filling the page in. After that only changes are sent, '
      + 'repeated markup is written once and referred to by number, and an idle tab sends almost nothing. A one-minute session '
      + 'multiplied by sixty assumes a fresh page load every minute, so it overstates the hourly cost.</p>'
      + (org ? '<h3>This organization</h3><div class="kv"><div>Sessions</div><div>' + org.sessions + '</div><div>Stored</div><div>' + fmtBytes(org.bytes_stored)
        + '</div><div>Shared stylesheets</div><div>' + fmtBytes(org.blob_bytes_stored) + ' (' + org.blobs + ', stored once for all sessions)</div><div>Per open hour</div><div>'
        + fmtBytes(orgRate) + ' from ' + esc(fmtDuration(org.active_ms)) + ' of recordings' + (provisional ? ' (too little to rely on yet)' : '') + '</div></div>' : '')
      + '<h3>What it would cost</h3><div class="calc">'
      + field('concurrent', 'Average concurrent users', 1000) + field('loads', 'Page loads per user-hour', 4)
      + field('load', 'KB per page load', defaultLoadKb) + field('steady', 'KB per minute after loading', defaultSteadyKb)
      + field('retention', 'Keep for (days)', 90) + field('price', '$ per GB-month', 0.02)
      + field('archive', 'Archive compression (×)', 1) + field('archiveAfter', 'Archive after (days)', 7)
      + '</div><div class="result" id="projection"></div>'
      + '<p>Average concurrent users is people with a recorded page open, averaged over every hour of the month (nights and other time zones included), so a month is '
      + HOURS_PER_MONTH + ' hours of it. Page loads are full loads or reloads; moving between apps inside the portal is not a page load. '
      + 'The defaults come from this session. $0.02 is object storage (DigitalOcean Spaces); managed database storage costs about five times more.</p>'
      + '<h3>Session</h3><button class="danger" id="delete-session" type="button">Delete this recording</button></div>';
    const growth = [];
    const chunks = [];
    let total = 0;
    for (const c of n.sizes) { total += c.bytes_stored; growth.push([c.t_end - n.s.started_at, total]); chunks.push([c.t_end - n.s.started_at, c.bytes_stored]); }
    drawChart($('growth-chart'), [{ points: chunks, color: 'rgba(245,158,11,.75)', bars: true }, { points: [[0, 0]].concat(growth), color: '#60a5fa' }],
      { format: fmtBytes, xMin: 0, xMax: n.durationMs, xLabel: fmtDuration(n.durationMs) });
    root.querySelectorAll('.calc input').forEach((input) => input.addEventListener('input', project));
    project();
    $('delete-session').addEventListener('click', deleteSession);
  }

  function card(label, value, note) {
    return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="note">' + esc(note) + '</div></div>';
  }
  function field(id, label, value) {
    return '<label>' + esc(label) + '<input type="number" min="0" step="any" id="calc-' + id + '" value="' + esc(value) + '"></label>';
  }
  function project() {
    const v = (id) => Number(($('calc-' + id) || {}).value) || 0;
    const mbPerUserHour = (v('loads') * v('load') + 60 * v('steady')) / 1024;
    const userHours = v('concurrent') * HOURS_PER_MONTH;
    const gbPerMonth = (userHours * mbPerUserHour) / 1024;
    const gbPerDay = gbPerMonth / (HOURS_PER_MONTH / 24);
    const keep = v('retention');
    const fresh = Math.min(keep, v('archiveAfter'));
    const ratio = Math.max(1, v('archive'));
    const stored = gbPerDay * fresh + (gbPerDay * Math.max(0, keep - fresh)) / ratio;
    const gb = (value) => value >= 1024 ? (value / 1024).toFixed(2) + ' TB' : value.toFixed(1) + ' GB';
    $('projection').innerHTML = esc(v('loads')) + ' loads × ' + esc(v('load')) + ' KB + 60 min × ' + esc(v('steady')) + ' KB = <strong>' + mbPerUserHour.toFixed(2) + ' MB per user-hour</strong>.<br>'
      + esc(v('concurrent').toLocaleString()) + ' users × ' + HOURS_PER_MONTH + ' h = ' + esc(Math.round(userHours).toLocaleString()) + ' user-hours → <strong>' + gb(gbPerMonth) + '</strong> new each month.<br>'
      + 'Keeping ' + esc(keep) + ' days' + (ratio > 1 ? ' (archived ' + ratio + '× smaller after ' + fresh + ' days)' : '') + ' holds about <strong>' + gb(stored) + '</strong>: '
      + '<strong>$' + (stored * v('price')).toFixed(2) + ' a month</strong> in object storage, $' + (stored * v('price') * 5).toFixed(2) + ' in the database.';
  }

  async function deleteSession() {
    if (!state.detail || !window.confirm('Delete this recording for good?')) return;
    try {
      await api('/session-replay/admin/sessions/' + encodeURIComponent(state.detail.session.id), { method: 'DELETE' });
      toast('Recording deleted.');
      state.sessionId = '';
      history.replaceState(null, '', location.pathname);
      location.reload();
    } catch (error) { toast(error.message); }
  }

  // ---------------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------------
  function renderPerformance() {
    const root = $('performance');
    if (!state.model) { root.innerHTML = '<div class="empty">No session open.</div>'; return; }
    const diag = state.model.allEvents().filter((event) => event.type === E.DIAG);
    const start = state.model.start;
    const cpu = [], heap = [], recorder = [], dom = [], lag = [];
    let longTasks = 0, longMs = 0, cpuSum = 0, windowSum = 0, cpuPeak = 0;
    for (const event of diag) {
      const a = event.a, x = event.t - start;
      const percent = a[DIAG.window_ms] ? (a[DIAG.cpu_tenths_ms] / 10 / a[DIAG.window_ms]) * 100 : 0;
      cpu.push([x, percent]);
      cpuPeak = Math.max(cpuPeak, percent);
      cpuSum += a[DIAG.cpu_tenths_ms] / 10;
      windowSum += a[DIAG.window_ms];
      if (a[DIAG.heap_used_kb]) heap.push([x, a[DIAG.heap_used_kb] / 1024]);
      recorder.push([x, (a[DIAG.recorder_kb] || 0) / 1024]);
      dom.push([x, a[DIAG.dom_nodes]]);
      lag.push([x, a[DIAG.lag_ms]]);
      longTasks += a[DIAG.long_tasks];
      longMs += a[DIAG.long_task_ms];
    }
    // Snapshot cost is known only after the snapshot, so it comes from the server's page record.
    const snapMs = ((state.detail && state.detail.pages) || []).map((page) => Number(page.meta && page.meta.snapshot_ms) || 0).filter(Boolean);
    const heapNow = heap.length ? heap[heap.length - 1][1] : 0;
    root.innerHTML = '<div class="cards">'
      + card('Recorder CPU', windowSum ? ((cpuSum / windowSum) * 100).toFixed(2) + ' %' : '–', 'average; peak ' + cpuPeak.toFixed(2) + ' %')
      + card('Snapshot', snapMs.length ? (snapMs.reduce((a, b) => a + b, 0) / snapMs.length).toFixed(1) + ' ms' : '–', 'average per page load')
      + card('Page JS heap', heap.length ? heapNow.toFixed(1) + ' MB' : 'n/a', heap.length ? 'whole page, last sample' : 'only Chrome reports it')
      + card('Long tasks', String(longTasks), Math.round(longMs) + ' ms blocked (whole page)')
      + '</div><div class="section"><h3>Recorder CPU (% of wall time)</h3><canvas class="chart" id="cpu-chart"></canvas>'
      + '<h3>Memory (MB)</h3><canvas class="chart" id="mem-chart"></canvas><div class="legend"><span><i style="background:#60a5fa"></i>page heap</span><span><i style="background:#a78bfa"></i>recorder estimate</span></div>'
      + '<h3>DOM elements</h3><canvas class="chart" id="dom-chart"></canvas>'
      + '<h3>Main-thread lag (ms)</h3><canvas class="chart" id="lag-chart"></canvas>'
      + '<p>Recorder CPU is time spent in the recorder\'s own code (listeners, batching, encoding, compression) as a share of elapsed time. '
      + 'Heap, long tasks and lag describe the whole page, so they show whether the page was struggling while the recorder ran. Samples arrive every 5 seconds while the person is active.</p></div>';
    const xMax = Math.max(1, state.model.end - start);
    drawChart($('cpu-chart'), [{ points: cpu, color: '#f97316' }], { format: (v) => v.toFixed(2) + '%', xMin: 0, xMax, xLabel: fmtDuration(xMax) });
    drawChart($('mem-chart'), [{ points: heap, color: '#60a5fa' }, { points: recorder, color: '#a78bfa' }], { format: (v) => v.toFixed(1) + ' MB', xMin: 0, xMax });
    drawChart($('dom-chart'), [{ points: dom, color: '#22c55e' }], { format: (v) => Math.round(v) + '', xMin: 0, xMax });
    drawChart($('lag-chart'), [{ points: lag, color: '#ef4444' }], { format: (v) => Math.round(v) + ' ms', xMin: 0, xMax });
  }

  // ---------------------------------------------------------------------------
  // Device
  // ---------------------------------------------------------------------------
  function renderDevice() {
    const root = $('device');
    if (!state.detail) { root.innerHTML = '<div class="empty">No session open.</div>'; return; }
    const s = state.detail.session;
    const first = state.model.pages.find((page) => page.meta) || null;
    const meta = (first && first.meta) || s.device || {};
    const row = (k, v) => (v === undefined || v === null || v === '' ? '' : '<div>' + esc(k) + '</div><div>' + esc(v) + '</div>');
    const screen = meta.screen || {};
    const connection = meta.connection || null;
    root.innerHTML = '<div class="section"><h3>Person</h3><div class="kv">'
      + row('Name', s.user_name) + row('Email', s.user_email) + row('Organization', state.detail.organization_name) + row('Session', s.id)
      + row('Started', new Date(s.started_at).toLocaleString()) + row('Recorder', s.recorder_version)
      + '</div><h3>Device</h3><div class="kv">'
      + row('Browser', (meta.brands || []).filter((b) => !/Not.?A.?Brand/i.test(b)).join(', ') || meta.user_agent)
      + row('Platform', meta.platform + (meta.mobile ? ' (mobile)' : ''))
      + row('Screen', screen.width ? screen.width + ' × ' + screen.height + ' @' + meta.device_pixel_ratio + 'x' : '')
      + row('Window', meta.viewport ? meta.viewport.width + ' × ' + meta.viewport.height : '')
      + row('Touch points', meta.touch_points) + row('CPU cores', meta.cores) + row('Memory', meta.memory_gb ? meta.memory_gb + ' GB or more' : '')
      + row('Network', connection ? connection.type + (connection.downlink ? ', ' + connection.downlink + ' Mb/s' : '') + (connection.rtt ? ', ' + connection.rtt + ' ms' : '') : '')
      + row('Language', meta.language) + row('Time zone', meta.timezone) + row('Theme', meta.color_scheme) + row('User agent', meta.user_agent)
      + '</div><h3>Pages</h3>' + state.model.pages.map((page) => {
        const stored = (state.detail.pages || []).find((entry) => entry.page_id === page.pageId);
        const m = Object.assign({}, page.meta || {}, (stored && stored.meta) || {});
        const nav = m.navigation || {};
        return '<div class="kv" style="margin-bottom:10px">' + row('Page', m.title || page.pageId) + row('URL', m.url)
          + row('Loaded', isFinite(page.firstT) ? new Date(page.firstT).toLocaleTimeString() : '') + row('Window', m.viewport ? m.viewport.width + ' × ' + m.viewport.height : '')
          + row('Load timing', nav.load_ms ? 'first byte ' + nav.ttfb_ms + ' ms · DOM ready ' + nav.dom_content_loaded_ms + ' ms · loaded ' + nav.load_ms + ' ms' : '')
          + row('Snapshot', m.snapshot_ms ? m.snapshot_ms + ' ms · ' + m.snapshot_nodes + ' nodes' : '')
          + (page.error ? row('Problem', page.error) : '') + '</div>';
      }).join('') + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function bindControls() {
    $('play').addEventListener('click', () => {
      const player = state.player;
      if (!player) return;
      if (player.playing) { if (player.follow) setFollow(false); player.pause(); } else player.play();
    });
    $('speed').addEventListener('change', (event) => { if (state.player) state.player.speed = Number(event.target.value); });
    $('skip-idle').addEventListener('change', (event) => { if (state.player) state.player.skipIdle = event.target.checked; });
    $('show-trail').addEventListener('change', (event) => { if (state.player) state.player.showTrail = event.target.checked; });
    $('follow').addEventListener('click', () => setFollow(!(state.player && state.player.follow)));
    const timeline = $('timeline');
    const fraction = (event) => { const rect = timeline.getBoundingClientRect(); return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)); };
    let dragging = false;
    timeline.addEventListener('pointerdown', (event) => { dragging = true; timeline.setPointerCapture(event.pointerId); seekToFraction(fraction(event)); });
    timeline.addEventListener('pointermove', (event) => {
      const f = fraction(event);
      if (dragging) seekToFraction(f);
      const tip = $('hover-time');
      if (state.model && isFinite(state.model.start)) {
        tip.hidden = false;
        tip.style.left = (f * 100) + '%';
        tip.textContent = fmtDuration(f * (state.model.end - state.model.start));
      }
    });
    timeline.addEventListener('pointerup', () => { dragging = false; });
    timeline.addEventListener('pointerleave', () => { $('hover-time').hidden = true; });
    $('event-list').addEventListener('click', (event) => {
      const row = event.target.closest('.event');
      if (!row || !state.player) return;
      const entry = state.events[Number(row.dataset.index)];
      if (!entry) return;
      if (state.player.follow) setFollow(false);
      state.player.seek(entry.t - 400);
    });
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('active', other === tab));
      document.querySelectorAll('.panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab.dataset.tab; });
      if (tab.dataset.tab === 'storage') renderStorage();
      if (tab.dataset.tab === 'performance') renderPerformance();
    }));
    $('session-list').addEventListener('click', (event) => {
      const row = event.target.closest('.session');
      if (row) openSession(row.dataset.id, false);
    });
    let searchTimer = 0;
    $('session-search').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.query = event.target.value.trim(); loadSessions(); }, 250);
    });
    $('session-scope').addEventListener('change', (event) => { state.scope = event.target.value; loadSessions(); });
    document.addEventListener('keydown', (event) => {
      if (event.target.closest && event.target.closest('input, select, textarea')) return;
      const player = state.player;
      if (!player) return;
      if (event.key === ' ') { event.preventDefault(); $('play').click(); }
      else if (event.key === 'ArrowRight') { player.seek(player.time + 5000); }
      else if (event.key === 'ArrowLeft') { if (player.follow) setFollow(false); player.seek(player.time - 5000); }
    });
    window.addEventListener('hashchange', () => {
      const hash = parseHash();
      if (!hash.session || hash.session === state.sessionId) return;
      // A linked session may belong to any organization: list them all.
      if (state.scope !== 'all') { state.scope = 'all'; $('session-scope').value = 'all'; loadSessions(); }
      openSession(hash.session, hash.live);
    });
  }

  function parseHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { session: params.get('session') || '', live: params.get('live') === '1' };
  }

  function denied(error) {
    const signedOut = error.status === 401;
    document.body.innerHTML = '<div class="denied"><h1>' + (signedOut ? 'Sign in first' : 'Not available') + '</h1><p>'
      + (signedOut ? 'Sign in to the portal in this browser, then reload this page.' : esc(error.message)) + '</p>'
      + (signedOut ? '<p><a href="/portal/" style="color:#60a5fa">Open the portal</a></p>' : '') + '</div>';
  }

  async function boot() {
    try { state.me = await api('/session-replay/admin/me'); }
    catch (error) { denied(error); return; }
    state.csrf = state.me.csrf || '';
    $('who').textContent = state.me.email;
    bindOrgPanel();
    bindControls();
    refreshCurrentOrg().catch((error) => toast(error.message));
    const hash = parseHash();
    if (hash.session) state.scope = 'all';
    $('session-scope').value = state.scope;
    await loadSessions();
    setInterval(loadSessions, 10000);
    if (hash.session) openSession(hash.session, hash.live);
  }

  boot();
})();
