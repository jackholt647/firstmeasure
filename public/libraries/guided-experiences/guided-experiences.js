/* public/libraries/guided-experiences/guided-experiences.js
 * Guided experiences in the browser (docs/architecture/guided-experiences.md): the runtime that plays in-app
 * setups, overlay tutorials and the assistant's suggested questions, all defined as data on the server.
 *
 *   window.FirstMateGuides
 *     refresh()                     reload what this person may play for the current page
 *     play(id, { replay })          play one now (a tutorial replay, a setup from a button)
 *     faqs(tab)                     the assistant's suggested questions for a project tab
 *     attachAssistant(drawer, api)  draws those questions above an assistant composer (platform-assistant.js)
 *     overlay                       the overlay tutorial engine, run(steps, options)
 *     registerKind(kind, player)    a player for a kind of experience (guided-setup.js registers modal and agentic)
 *
 * Triggers are data: `before_action` holds a click on a matching button, plays the experience and then lets the
 * click through; `tab_opened` plays when a project tab opens; `after_experience` follows another experience. What
 * someone has seen is kept on the server (progress), never in this page. The overlay and every popover are left out
 * of session replays (data-fmr-ignore).
 */
(function(root){
  'use strict';
  if (root.FirstMateGuides) return;
  const document = root.document;
  const NS = 'guided-experiences';
  const clean = (value) => String(value ?? '').trim();
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  /** Copy from a definition ({ key, text }) or a library string, through PlatformLanguage. */
  // Development copy edits (dev.ts) replace a key's English. Other languages keep their translation.
  const overrides = {};
  const english = () => { const locale = clean(root.PlatformLanguage?.locale?.() || root.document?.documentElement?.lang || 'en').toLowerCase(); return !locale || locale.startsWith('en'); };
  const L = (copy, fallback) => {
    const key = copy && typeof copy === 'object' ? copy.key : copy;
    if (key && overrides[key] !== undefined && english()) return overrides[key];
    if (copy && typeof copy === 'object') return root.PlatformLanguage?.text?.(NS, copy.key, copy.text) ?? copy.text;
    return root.PlatformLanguage?.text?.(NS, copy, fallback) ?? fallback;
  };
  /** Copy as HTML: escaped text, marked with its key so a development editor can change it in place. */
  const H = (copy, fallback) => {
    const key = copy && typeof copy === 'object' ? copy.key : copy;
    const value = esc(L(copy, fallback));
    return devState.editor && key ? `<span class="gx-copy" data-gx-copy="${esc(key)}">${value}</span>` : value;
  };
  const devState = { editor: false };
  const reducedMotion = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  // ── API ────────────────────────────────────────────────────────────────
  const APP = () => root.__APP || {};
  function baseUrl(){
    const configured = clean(APP().guidedExperiencesApiBase);
    if (configured) return configured.replace(/\/+$/, '');
    const platform = clean(APP().platformApiBase);
    if (platform) return platform.replace(/\/v1\/platform\/?$/i, '/v1/guided-experiences').replace(/\/+$/, '');
    return `${root.location.origin}/v1/guided-experiences`;
  }
  function csrf(){
    const name = clean(APP().platformSessionCookieName || 'fm_platform_session');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) return '';
    const prefix = `${encodeURIComponent(name + '_csrf')}=`;
    let jar = ''; try { jar = document.cookie; } catch (_) {}
    const cookie = jar.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    try { return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : ''; } catch (_) { return ''; }
  }
  async function request(path, options = {}){
    const method = (options.method || 'GET').toUpperCase();
    const headers = { Accept:'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') { const token = csrf(); if (token) headers['X-Platform-CSRF'] = token; }
    const response = await fetch(`${baseUrl()}${path}`, { method, headers, credentials:'include', cache:'no-store', body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const text = await response.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) { const error = new Error(clean(data?.message || data?.error) || `Guided experiences request failed (${response.status})`); error.status = response.status; error.code = clean(data?.error); throw error; }
    return data || {};
  }
  const orgId = () => clean(APP().userOrgId || root.Portal?.currentUser?.orgId);
  const orgPath = (suffix) => `/organizations/${encodeURIComponent(orgId())}${suffix}`;
  const api = {
    list: (tab, projectId) => request(orgPath(`/experiences?tab=${encodeURIComponent(tab || '')}&project_id=${encodeURIComponent(projectId || '')}`)),
    event: (id, body) => request(orgPath(`/experiences/${encodeURIComponent(id)}/events`), { method:'POST', body }),
    complete: (id, body) => request(orgPath(`/experiences/${encodeURIComponent(id)}/complete`), { method:'POST', body }),
    conversation: (id, body) => request(orgPath(`/experiences/${encodeURIComponent(id)}/conversation`), { method:'POST', body })
  };

  // ── Where the person is ────────────────────────────────────────────────
  /** The open project and project tab, from the route (portal core.js): `project` and `projectTab`. */
  function where(){
    const route = object(root.Portal?.navigation?.read?.());
    const projectTab = clean(route.projectTab);
    const project = clean(route.project) || lastProject;
    return { projectId: project, tab: projectTab ? (projectTab.includes('.') ? projectTab : `project.${projectTab}`) : '' };
  }
  let lastProject = '';
  root.addEventListener?.('fm:project-modal:hydrated', (event) => { lastProject = clean(event?.detail?.projectId) || lastProject; });

  // ── State ──────────────────────────────────────────────────────────────
  const state = { reveals: null, experiences: new Map(), faqs: new Map(), loaded: '', loading: null, playing: null, bypass: new WeakSet(), tabTimers: new Set(), openedTabs: new Set() };
  const kinds = new Map();

  async function refresh(force = false){
    if (!orgId() || !root.fetch) return null;
    const here = where();
    const key = `${here.tab}|${here.projectId}`;
    if (!force && state.loaded === key) return state;
    if (state.loading && !force) return state.loading;
    state.loading = api.list(here.tab, here.projectId).then((result) => {
      state.experiences = new Map(array(result.experiences).map((entry) => [entry.id, entry]));
      Object.keys(overrides).forEach((key) => { delete overrides[key]; });
      Object.assign(overrides, object(result.copy_overrides));
      state.devExperiences = array(result.dev?.experiences);
      if (result.dev?.editor && !devState.editor) { devState.editor = true; installDev(document); }
      const reveals = array(result.reveals);
      if (JSON.stringify(reveals) !== JSON.stringify(state.reveals)) {
        const first = state.reveals === null;
        state.reveals = reveals;
        // The project window redraws its tabs (project-request/app.js); nothing to redraw on the first load.
        if (!first || reveals.length) root.dispatchEvent?.(new CustomEvent('fm:guides:tabs-changed', { detail: { reveals } }));
      }
      if (result.faqs?.tab) state.faqs.set(result.faqs.tab, result.faqs);
      else if (here.tab) state.faqs.set(here.tab, { tab: here.tab, questions: [] });
      state.loaded = key;
      root.dispatchEvent?.(new CustomEvent('fm:guides:updated', { detail: { tab: here.tab } }));
      return state;
    }).catch((error) => { console.warn('Guided experiences could not load.', error); return null; }).finally(() => { state.loading = null; });
    return state.loading;
  }

  /** Records an event and mirrors it to the existing analytics (Statsig) without opening any stream. */
  function track(experience, type, extra = {}){
    const here = where();
    const body = { type, tab: here.tab, project_id: here.projectId, ...extra };
    root.FirstMateStatsig?.track?.('guided_experience', { experience: experience.id, version: experience.version, variant: experience.variant?.id, bucket: experience.variant?.bucket, type, step: extra.step_id || '' });
    // Sent in order in the background: nothing on screen waits for the server.
    const sent = eventChain.then(() => api.event(experience.id, body)).catch((error) => { console.warn('Guided experience event not saved.', error); return null; });
    eventChain = sent;
    return sent;
  }
  let eventChain = Promise.resolve();

  // ── Playing ────────────────────────────────────────────────────────────
  /**
   * One experience at a time for the whole page. The portal and every project window (an iframe of the portal) each
   * load this library, so the lock and the queue live on the top window: whichever frame asks second waits its turn.
   */
  const shared = (() => {
    let host = root;
    try { if (root.top && root.top !== root && root.top.document) host = root.top; } catch (_) { host = root; }
    return host.__fmGuidedLock || (host.__fmGuidedLock = { active: null, queue: [] });
  })();
  function nextInQueue(){
    while (!shared.active && shared.queue.length) {
      const request = shared.queue.shift();
      try { request.run(); return; } catch (_) { /* that frame is gone */ }
    }
  }
  /**
   * Plays one experience, then what its completion says to do next whatever started it: let a held click through
   * (`options.held`, `options.selector`) and play the next experience.
   */
  async function play(id, options = {}){
    let ran = null;
    const outcome = await playOne(id, options, (experience) => { ran = experience; });
    if (ran || options.held) await follow(ran || { completion: {} }, outcome || {}, options.held, options.selector);
    return outcome;
  }
  async function playOne(id, options, started){
    // The same experience asked for again (a second trigger, a double click) is ignored, never stacked.
    if (shared.active?.id === id || shared.queue.some((entry) => entry.id === id)) return { status: 'busy' };
    if (shared.active) {
      return new Promise((resolve) => shared.queue.push({ id, run: () => { playOne(id, options, started).then(resolve, () => resolve({ status: 'failed' })); } }));
    }
    const token = { id, frame: root };
    shared.active = token;
    let experience = null;
    try {
      // Always from the server: another frame or tab may have finished it a moment ago.
      await refresh(true);
      experience = state.experiences.get(id);
      if (!experience) return { status: 'unavailable' };
      if (experience.progress && experience.progress.status !== 'started' && !options.replay && !options.force) return { status: 'done' };
      const player = kinds.get(experience.kind);
      if (!player) return { status: 'unavailable' };
      state.playing = experience.id;
      started(experience);
      root.dispatchEvent?.(new CustomEvent('fm:guides:playing', { detail: { id: experience.id } }));
      track(experience, options.replay ? 'replay' : 'exposure');
      if (!options.replay) track(experience, 'start');
      const outcome = await player({ experience, api, track: (type, extra) => track(experience, type, extra), where, L, esc, reducedMotion, options });
      return outcome || { status: 'ended' };
    } finally {
      state.playing = null;
      if (shared.active === token) shared.active = null;
      if (experience) root.dispatchEvent?.(new CustomEvent('fm:guides:ended', { detail: { id: experience.id } }));
      refresh(true).finally(nextInQueue);
    }
  }

  /**
   * After an experience: hand off, let a held click through, then play what follows. An outcome that asks to
   * generate (the price book setup's "Start generating materials") presses the tab's own Generate when no click was held.
   */
  async function follow(experience, outcome, held, selector = ''){
    let resumed = false;
    if (outcome.generate && !held) { held = document.querySelector('[data-mt-generate-materials]'); selector = '[data-mt-generate-materials]'; }
    for (const step of array(experience.completion?.then)) {
      if (step.resume && held && !resumed) { resumed = true; letThrough(held, selector); }
      if (step.play && outcome.status === 'completed') {
        // Wait for the held action's own screen to settle before the next experience looks for its targets.
        await new Promise((resolve) => setTimeout(resolve, 900));
        await play(step.play);
      }
    }
    if (!resumed && held) letThrough(held, selector);
  }
  function letThrough(element, selector = ''){
    // The page may have drawn its buttons again while the experience played: press the trigger's button anew.
    if (!element?.isConnected) {
      try { element = selector ? document.querySelector(selector) : null; } catch (_) { element = null; }
      if (!element) return;
    }
    state.bypass.add(element);
    element.click();
  }

  // before_action: hold the click, play, then let it through.
  document?.addEventListener('click', (event) => {
    if (shared.active || event.defaultPrevented) return;
    const target = event.target?.closest?.('button,[role=button],a,[data-mt-generate-materials],[data-mt-generate-column]');
    if (!target || state.bypass.has(target)) { if (target) state.bypass.delete(target); return; }
    for (const experience of state.experiences.values()) {
      const trigger = array(experience.triggers).find((entry) => entry.kind === 'before_action' && safeMatches(target, entry.selector));
      if (!trigger || (experience.progress && experience.progress.status !== 'started')) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      (async () => {
        await play(experience.id, { trigger, held: target, selector: trigger.selector });
      })();
      return;
    }
  }, true);
  function safeMatches(element, selector){ try { return !!element.closest(selector); } catch (_) { return false; } }

  // tab_opened: the project window says which tab became active (tab-guides.js `opened`), in the frame that shows it.
  function onTabOpened(event){
    const tab = clean(event?.detail?.appId);
    const key = `${where().projectId}|${tab}`;
    if (!tab || state.openedTabs.has(key)) return;
    state.openedTabs.add(key);
    refresh().then(() => {
      for (const experience of state.experiences.values()) {
        const trigger = array(experience.triggers).find((entry) => entry.kind === 'tab_opened' && entry.tab === tab);
        if (!trigger || (experience.progress && experience.progress.status !== 'started')) continue;
        const timer = setTimeout(() => { state.tabTimers.delete(timer); if (!event.detail?.isActive || event.detail.isActive()) play(experience.id); }, Number(trigger.delay_ms || 700));
        state.tabTimers.add(timer);
        break;
      }
    });
  }
  root.addEventListener?.('fm:project-tab:opened', onTabOpened);
  // The route only refreshes what is offered (questions for the tab); it never starts anything.
  root.addEventListener?.('fm:route-state:updated', () => { refresh(); });

  // ── Overlay tutorials ──────────────────────────────────────────────────
  const overlayCss = `
    .gx-ov{position:fixed;inset:0;z-index:2147483300;pointer-events:none}
    .gx-ov svg{position:absolute;inset:0;width:100%;height:100%}
    .gx-ov-dim{fill:rgba(16,24,40,.62);fill-rule:evenodd;pointer-events:auto;transition:opacity .3s ease}
    .gx-ov-ring{position:fixed;border-radius:12px;box-shadow:0 0 0 3px var(--primary,#d93025),0 0 0 9px rgba(var(--primary-rgb,217,48,37),.22);pointer-events:none;transition:all .45s cubic-bezier(.22,1,.36,1);animation:gxPulse 1.8s ease-in-out infinite}
    @keyframes gxPulse{0%,100%{box-shadow:0 0 0 3px var(--primary,#d93025),0 0 0 8px rgba(var(--primary-rgb,217,48,37),.22)}50%{box-shadow:0 0 0 3px var(--primary,#d93025),0 0 0 14px rgba(var(--primary-rgb,217,48,37),.06)}}
    .gx-pop{position:fixed;z-index:2147483400;width:min(340px,calc(100vw - 24px));background:#fff;color:#101828;border-radius:16px;box-shadow:0 24px 60px rgba(16,24,40,.35);padding:18px 18px 14px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;pointer-events:auto;transition:left .45s cubic-bezier(.22,1,.36,1),top .45s cubic-bezier(.22,1,.36,1),opacity .25s;outline:none}
    .gx-pop.gx-enter{animation:gxPopIn .35s cubic-bezier(.22,1,.36,1)}
    @keyframes gxPopIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}
    .gx-pop h3{margin:0 26px 6px 0;font-size:16px;font-weight:750;letter-spacing:-.01em}
    .gx-pop p{margin:0;color:#475467}
    .gx-pop .gx-x{position:absolute;top:10px;right:10px;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#98a2b3;cursor:pointer;font-size:16px}
    .gx-pop .gx-x:hover{background:#f2f4f7;color:#344054}
    .gx-pop footer{display:flex;align-items:center;gap:8px;margin-top:14px}
    .gx-dots{display:flex;gap:5px;margin-right:auto}
    .gx-dots i{width:6px;height:6px;border-radius:3px;background:#d0d5dd;transition:width .3s,background .3s}
    .gx-dots i.on{width:18px;background:var(--primary,#d93025)}
    .gx-pop button.gx-b{height:32px;padding:0 12px;border-radius:9px;border:1px solid #d0d5dd;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:650;cursor:pointer}
    .gx-pop button.gx-b.gx-primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
    .gx-pop button.gx-b.gx-link{border-color:transparent;color:#667085;padding:0 6px}
    .gx-pop button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    .gx-pop .gx-arrow{position:absolute;width:14px;height:14px;background:#fff;transform:rotate(45deg)}
    .gx-pop.gx-center{left:50%!important;top:50%!important;transform:translate(-50%,-50%)}
    .gx-pop.gx-center.gx-enter{animation:gxCenterIn .4s cubic-bezier(.22,1,.36,1)}
    @keyframes gxCenterIn{from{opacity:0;transform:translate(-50%,-46%) scale(.96)}to{opacity:1;transform:translate(-50%,-50%)}}
    @media(max-width:640px){.gx-pop:not(.gx-center){left:12px!important;right:12px;top:auto!important;bottom:12px;width:auto}.gx-pop:not(.gx-center) .gx-arrow{display:none}}
    @media(prefers-reduced-motion:reduce){.gx-ov-ring,.gx-pop,.gx-ov-dim{transition:none!important;animation:none!important}}
  `;
  /** Styles go into the document that shows the element: the project tray's assistant lives in a project window frame. */
  function injectCss(id, css, doc = document){
    if (!doc?.head || doc.getElementById(id)) return;
    const style = doc.createElement('style'); style.id = id; style.textContent = css; doc.head.appendChild(style);
  }
  const visible = (selector) => { try { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && el.offsetParent !== null ? el : null; } catch (_) { return null; } };
  const waitFor = (selectors, timeout) => new Promise((resolve) => {
    const started = Date.now();
    const poll = () => { for (const s of selectors) { const el = visible(s); if (el) return resolve(el); } if (Date.now() - started >= timeout) return resolve(null); setTimeout(poll, 100); };
    poll();
  });

  const overlay = {
    /**
     * Plays overlay steps: { id, title, body, targets[], placement, advance, wait_ms }. Every target found is left
     * undimmed; the first is highlighted with the popover beside it. A step whose targets never appear is skipped.
     * Resolves { status: 'completed' | 'dismissed', shown, last }.
     */
    run(steps, options = {}){
      injectCss('gx-overlay-css', overlayCss);
      const list = array(steps);
      return new Promise((resolve) => {
        const host = document.createElement('div'); host.className = 'gx-ov'; host.setAttribute('data-fmr-ignore', ''); host.setAttribute('data-gx-overlay', '');
        host.innerHTML = '<svg aria-hidden="true"><path class="gx-ov-dim"></path></svg><div class="gx-ov-ring" hidden></div>';
        const pop = document.createElement('div'); pop.className = 'gx-pop'; pop.setAttribute('data-gx-overlay', ''); pop.dataset.gxExperience = clean(options.experienceId); pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false'); pop.setAttribute('data-fmr-ignore', ''); pop.tabIndex = -1;
        document.body.append(host, pop);
        const path = host.querySelector('path'), ring = host.querySelector('.gx-ov-ring');
        let index = -1, shown = 0, ended = false, current = null, targets = [], holes = [], animation = 0, clickTarget = null;
        const finish = (status) => {
          if (ended) return; ended = true;
          cancelAnimationFrame(animation); cancelAnimationFrame(trackFrame); root.removeEventListener('resize', redraw); root.removeEventListener('scroll', redraw, true); document.removeEventListener('keydown', key, true);
          clickTarget?.removeEventListener('click', onTargetClick, true);
          host.remove(); pop.remove();
          resolve({ status, shown, last: list[index]?.id || '' });
        };
        const rectOf = (el) => { const r = el.getBoundingClientRect(), pad = 6; return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2, r: Math.min(14, parseFloat(getComputedStyle(el).borderTopLeftRadius || '0') + 4) }; };
        const rr = (h) => { const r = Math.min(h.r, h.w / 2, h.h / 2); return `M${h.x + r},${h.y}h${h.w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h.h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${h.w - 2 * r}a${r},${r} 0 0 1 -${r},-${r}v-${h.h - 2 * r}a${r},${r} 0 0 1 ${r},-${r}z`; };
        const draw = (list) => { path.setAttribute('d', `M0,0H${root.innerWidth}V${root.innerHeight}H0Z` + list.map(rr).join('')); };
        // The hole slides from the last target to the next one.
        const animateTo = (next) => {
          cancelAnimationFrame(animation);
          const from = holes.length ? holes : next.map((h) => ({ x: h.x + h.w / 2, y: h.y + h.h / 2, w: 0, h: 0, r: h.r }));
          if (reducedMotion() || !next.length) { holes = next; draw(holes); return; }
          const start = performance.now(), duration = 420;
          const tick = (now) => {
            const t = Math.min(1, (now - start) / duration), e = 1 - Math.pow(1 - t, 3);
            const mid = next.map((h, i) => { const f = from[Math.min(i, from.length - 1)] || h; return { x: f.x + (h.x - f.x) * e, y: f.y + (h.y - f.y) * e, w: f.w + (h.w - f.w) * e, h: f.h + (h.h - f.h) * e, r: h.r }; });
            draw(mid);
            if (t < 1) animation = requestAnimationFrame(tick); else holes = next;
          };
          animation = requestAnimationFrame(tick);
        };
        function place(){
          const step = list[index];
          const main = targets[0];
          // A step with nothing to point at is a centred card with no arrow.
          pop.classList.toggle('gx-center', !main || step.placement === 'center');
          const arrow = pop.querySelector('.gx-arrow');
          if (!main || step.placement === 'center') { arrow?.remove(); ring.hidden = !main; if (!main) return; }
          if (!main) { ring.hidden = true; return; }
          const r = main.getBoundingClientRect(), p = pop.getBoundingClientRect(), gap = 16, W = root.innerWidth, H = root.innerHeight;
          ring.hidden = false; Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
          let placement = step.placement && step.placement !== 'auto' ? step.placement : (H - r.bottom > p.height + gap ? 'bottom' : r.top > p.height + gap ? 'top' : W - r.right > p.width + gap ? 'right' : 'left');
          let left, top;
          if (placement === 'bottom') { left = r.left + r.width / 2 - p.width / 2; top = r.bottom + gap; }
          else if (placement === 'top') { left = r.left + r.width / 2 - p.width / 2; top = r.top - p.height - gap; }
          else if (placement === 'right') { left = r.right + gap; top = r.top + r.height / 2 - p.height / 2; }
          else { left = r.left - p.width - gap; top = r.top + r.height / 2 - p.height / 2; }
          left = Math.max(12, Math.min(left, W - p.width - 12)); top = Math.max(12, Math.min(top, H - p.height - 12));
          pop.style.left = `${left}px`; pop.style.top = `${top}px`;
          if (arrow) {
            const ax = Math.max(14, Math.min(p.width - 28, r.left + r.width / 2 - left - 7)), ay = Math.max(14, Math.min(p.height - 28, r.top + r.height / 2 - top - 7));
            Object.assign(arrow.style, placement === 'bottom' ? { left: `${ax}px`, top: '-7px' } : placement === 'top' ? { left: `${ax}px`, top: `${p.height - 7}px` } : placement === 'right' ? { left: '-7px', top: `${ay}px` } : { left: `${p.width - 7}px`, top: `${ay}px` });
          }
        }
        function redraw(){ if (ended) return; holes = targets.map(rectOf); draw(holes); place(); }
        /**
         * Follows the target while a step shows: what the person does can move it (a bar appearing above it, a list
         * growing), so its box is compared every frame and the spotlight, ring and popover follow it. A target that
         * goes away is looked for again by its selectors; when nothing matches, the step stays as a centred card
         * rather than pointing at whatever took its place.
         */
        let trackFrame = 0, trackedKey = '', lastSearch = 0;
        const boxKey = () => targets.map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`; }).join('|');
        function follow(now){
          if (ended) return;
          trackFrame = requestAnimationFrame(follow);
          if (!current || !targets.length) return;
          if (targets.some((el) => !el.isConnected || !el.getClientRects().length)) {
            if (now - lastSearch < 150) return;
            lastSearch = now;
            const again = array(current.targets).map(visible).filter(Boolean);
            clickTarget?.removeEventListener('click', onTargetClick, true); clickTarget = null;
            targets = again;
            if (current.advance === 'click' && targets[0]) { clickTarget = targets[0]; clickTarget.addEventListener('click', onTargetClick, true); }
            if (!targets.length) { cancelAnimationFrame(animation); holes = []; draw(holes); render(current); place(); trackedKey = ''; return; }
            trackedKey = '';
          }
          const key = boxKey();
          // Following is immediate: the ring and popover jump with the target instead of easing after it.
          if (key !== trackedKey) { if (trackedKey) { cancelAnimationFrame(animation); ring.style.transition = 'none'; pop.style.transition = 'none'; redraw(); requestAnimationFrame(() => { ring.style.transition = ''; pop.style.transition = ''; }); } trackedKey = key; }
        }
        function onTargetClick(){ setTimeout(() => go(index + 1, 1), 60); }
        function render(step){
          const total = list.length, position = index + 1, last = position >= total;
          pop.innerHTML = `<button type="button" class="gx-x" data-gx="close" aria-label="${esc(L('gx_ui_skip_tutorial', 'Skip tutorial'))}" title="${esc(L('gx_ui_skip_tutorial', 'Skip tutorial'))}">&times;</button>
            <h3>${H(step.title)}</h3><p>${H(step.body)}</p>
            <footer><span class="gx-dots" aria-label="${esc(L('gx_ui_step_of', 'Step') + ' ' + position + ' / ' + total)}">${list.map((_, i) => `<i class="${i === index ? 'on' : ''}"></i>`).join('')}</span>
              ${position > 1 ? `<button type="button" class="gx-b gx-link" data-gx="back">${H('gx_ui_back', 'Back')}</button>` : ''}
              ${!last ? `<button type="button" class="gx-b gx-link" data-gx="skip">${H('gx_ui_skip_step', 'Skip step')}</button>` : ''}
              ${step.advance === 'click' && targets.length ? '' : `<button type="button" class="gx-b gx-primary" data-gx="next">${last ? H('gx_ui_done', 'Done') : H('gx_ui_next', 'Next')}</button>`}</footer>
            ${targets.length && step.placement !== 'center' ? '<span class="gx-arrow" aria-hidden="true"></span>' : ''}`;
          pop.setAttribute('aria-label', L(step.title)); pop.dataset.gxStep = step.id;
          pop.classList.remove('gx-enter'); void pop.offsetWidth; pop.classList.add('gx-enter');
          setTimeout(() => pop.querySelector('[data-gx=next]')?.focus?.({ preventScroll: true }), 30);
        }
        /**
         * Moves to the next step that can show. Only the first step waits for its target to appear (the page may
         * still be drawing); after that a missing target is skipped at once, so Next and Back answer immediately.
         * A newer move cancels an older one that is still looking, so fast clicks never pile up.
         */
        let move = 0;
        async function go(to, direction){
          if (ended) return;
          const mine = ++move;
          clickTarget?.removeEventListener('click', onTargetClick, true); clickTarget = null;
          for (let i = to; i >= 0 && i < list.length; i += direction) {
            const step = list[i];
            const selectors = array(step.targets);
            let found = [];
            if (selectors.length) {
              const first = await waitFor(selectors, shown === 0 && direction > 0 ? Number(step.wait_ms ?? 1500) : 0);
              if (ended || mine !== move) return;
              if (!first) { options.onStep?.({ type: 'step_skip', step: step.id, missing: true }); continue; }
              found = selectors.map(visible).filter(Boolean);
              found.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
              first.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
            }
            if (mine !== move) return;
            index = i; current = step; targets = found; shown += 1; trackedKey = '';
            render(step);
            animateTo(targets.map(rectOf));
            requestAnimationFrame(place);
            if (step.advance === 'click' && targets[0]) { clickTarget = targets[0]; clickTarget.addEventListener('click', onTargetClick, true); }
            options.onStep?.({ type: 'step_view', step: step.id, index: i });
            return;
          }
          if (direction > 0 && mine === move) finish('completed');
        }
        function key(event){
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); options.onStep?.({ type: 'dismiss', step: current?.id }); finish('dismissed'); }
          else if (event.key === 'ArrowRight' && document.activeElement?.closest?.('.gx-pop')) { event.preventDefault(); go(index + 1, 1); }
          else if (event.key === 'ArrowLeft' && document.activeElement?.closest?.('.gx-pop') && index > 0) { event.preventDefault(); go(index - 1, -1); }
        }
        pop.addEventListener('click', (event) => {
          const action = event.target.closest?.('[data-gx]')?.dataset.gx;
          if (action === 'next') { options.onStep?.({ type: 'step_done', step: current?.id }); go(index + 1, 1); }
          else if (action === 'skip') { options.onStep?.({ type: 'step_skip', step: current?.id }); go(index + 1, 1); }
          else if (action === 'back') { options.onStep?.({ type: 'back', step: current?.id }); go(index - 1, -1); }
          else if (action === 'close') { options.onStep?.({ type: 'dismiss', step: current?.id }); finish('dismissed'); }
        });
        root.addEventListener('resize', redraw); root.addEventListener('scroll', redraw, true); document.addEventListener('keydown', key, true);
        trackFrame = requestAnimationFrame(follow);
        draw([]);
        go(0, 1);
      });
    }
  };

  kinds.set('overlay', async ({ experience, track: record }) => {
    const result = await overlay.run(experience.steps, { experienceId: experience.id, onStep: ({ type, step }) => { if (type !== 'dismiss') record(type, { step_id: step }); } });
    if (result.status === 'completed') await record('complete', { step_id: result.last, properties: { shown: result.shown } });
    else await record('dismiss', { step_id: result.last, properties: { shown: result.shown } });
    return result;
  });

  // ── Assistant suggestions (FAQs) ───────────────────────────────────────
  const faqCss = `
    .gx-faqs-wrap{padding:0 2px 5px}
    .gx-faqs-wrap[hidden]{display:none}
    .gx-faqs{display:flex;flex-wrap:wrap;align-items:center;gap:5px;overflow:hidden;transition:height .28s cubic-bezier(.22,1,.36,1)}
    .gx-faq{flex:0 1 auto;max-width:calc(50% - 3px);min-width:0;display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:3px 10px;border:1px solid #e4e7ec;border-radius:999px;background:#fff;color:#344054;font:inherit;font-size:12px;line-height:1.25;font-weight:600;text-align:left;cursor:pointer;white-space:normal;box-sizing:border-box;transition:background .15s,border-color .15s,transform .15s;animation:gxChip .35s cubic-bezier(.22,1,.36,1) both}
    .gx-faq[hidden]{display:none}
    .gx-faq-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gx-faq-more{flex:none;min-height:26px;padding:3px 10px;border:1px dashed #d0d5dd;border-radius:999px;background:#f9fafb;color:#475467;font:inherit;font-size:12px;font-weight:650;cursor:pointer}
    .gx-faq-more:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
    @media(prefers-reduced-motion:reduce){.gx-faqs{transition:none}}
    .gx-faq:hover{background:#f9fafb;border-color:#98a2b3;transform:translateY(-1px)}
    .gx-faq i{color:var(--primary,#d93025);font-size:11px}
    .gx-faq:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
    @keyframes gxChip{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @media(prefers-reduced-motion:reduce){.gx-faq{animation:none;transition:none}}
  `;
  /** Loads one tab's questions (the tray's tab, which may differ from this frame's route). */
  const faqLoads = new Map();
  function loadFaqs(tab){
    if (!faqLoads.has(tab)) faqLoads.set(tab, api.list(tab, where().projectId).then((result) => {
      state.faqs.set(tab, result.faqs?.tab ? result.faqs : { tab, questions: [] });
      for (const entry of array(result.experiences)) if (!state.experiences.has(entry.id)) state.experiences.set(entry.id, entry);
    }).catch(() => { faqLoads.delete(tab); }));
    return faqLoads.get(tab);
  }
  /** The suggested questions for a project tab, without those this person cannot play. */
  function faqs(tab){
    const entry = state.faqs.get(clean(tab));
    return entry ? array(entry.questions) : [];
  }
  /**
   * Draws the current tab's suggested questions above an assistant composer. `ask(text)` sends a question in that
   * conversation; `getContext()` names the project and tab the assistant is showing (the project tray's context).
   */
  function attachAssistant(drawer, assistant = {}){
    if (!drawer || drawer.querySelector('.gx-faqs-wrap')) return null;
    const doc = drawer.ownerDocument || document;
    injectCss('gx-faq-css', faqCss, doc);
    // A frame with its own copy of this library edits its own document; installing there too would save every edit twice.
    const ownGuides = (() => { try { return doc.defaultView?.FirstMateGuides; } catch (_) { return null; } })();
    if (devState.editor && (!ownGuides || ownGuides === root.FirstMateGuides)) installDev(doc);
    const composer = drawer.querySelector('[data-fma="composer"]');
    const shell = composer?.querySelector('.fma-compose-shell');
    if (!composer || !shell) return null;
    // The first three questions at once, inline; the rest behind a More chip at the end of the row.
    const wrap = doc.createElement('div'); wrap.className = 'gx-faqs-wrap'; wrap.hidden = true;
    const VISIBLE = 3;
    const strip = doc.createElement('div'); strip.className = 'gx-faqs'; strip.dataset.collapsed = 'true'; strip.setAttribute('role', 'list'); strip.setAttribute('aria-label', L('gx_ui_suggested', 'Suggested questions'));
    wrap.append(strip);
    composer.insertBefore(wrap, shell);
    let shownTab = '';
    // The tab the assistant says it is showing; else the route of the frame the drawer is in.
    const tabNow = () => { const context = object(assistant.getContext?.()); return clean(context.tab) ? (clean(context.tab).includes('.') ? clean(context.tab) : `project.${clean(context.tab)}`) : (doc.defaultView?.FirstMateGuides?.where?.() || where()).tab; };
    const render = () => {
      const tab = tabNow();
      const questions = faqs(tab);
      if (!questions.length) { wrap.hidden = true; strip.innerHTML = ''; shownTab = tab; if (tab && !state.faqs.has(tab)) loadFaqs(tab).then(() => { if (faqs(tab).length) render(); }); return; }
      if (tab === shownTab && !wrap.hidden) return;
      shownTab = tab;
      // A replay ("Show me the tutorial again") leads, so it is never behind "More".
      strip.innerHTML = [...questions].sort((a, b) => Number(b.action === 'play') - Number(a.action === 'play')).map((question, i) => `<button type="button" class="gx-faq" role="listitem" data-gx-faq="${esc(question.id)}" title="${esc(L(question.text))}" style="animation-delay:${i * 40}ms"${i >= VISIBLE ? ' hidden data-gx-extra' : ''}>${question.action === 'play' ? '<i class="fas fa-circle-play" aria-hidden="true"></i>' : '<i class="fas fa-sparkles" aria-hidden="true"></i>'}<span class="gx-faq-text">${H(question.text)}</span></button>`).join('')
        + (questions.length > VISIBLE ? `<button type="button" class="gx-faq-more" data-gx-more aria-expanded="false">${H('gx_ui_more_questions', 'More')}</button>` : '');
      wrap.hidden = false;
      strip.dataset.collapsed = 'true';
      strip.style.height = '';
    };
    /** Shows or hides the rest, animating the strip's height from where it is to where it ends up. */
    function toggleMore(){
      const collapsed = strip.dataset.collapsed === 'true';
      const from = strip.getBoundingClientRect().height;
      strip.dataset.collapsed = String(!collapsed);
      strip.querySelectorAll('[data-gx-extra]').forEach((chip) => { chip.hidden = !collapsed; });
      const more = strip.querySelector('[data-gx-more]');
      more.innerHTML = collapsed ? H('gx_ui_fewer_questions', 'Less') : H('gx_ui_more_questions', 'More');
      more.setAttribute('aria-expanded', String(collapsed));
      strip.style.height = 'auto';
      const to = strip.getBoundingClientRect().height;
      if (reducedMotion()) { strip.style.height = ''; return; }
      strip.style.height = `${from}px`;
      void strip.offsetHeight;
      strip.style.height = `${to}px`;
      setTimeout(() => { strip.style.height = ''; }, 320);
    }
    strip.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-gx-more]')) { toggleMore(); return; }
      const id = event.target.closest?.('[data-gx-faq]')?.dataset.gxFaq;
      const question = faqs(tabNow()).find((entry) => entry.id === id);
      if (!question) return;
      const experience = question.experience && state.experiences.get(question.experience);
      root.FirstMateStatsig?.track?.('guided_faq', { question: question.id, tab: tabNow() });
      if (experience) api.event(experience.id, { type: 'faq', tab: tabNow(), project_id: where().projectId, properties: { question: question.id } }).catch(() => null);
      // A tour plays in the frame that shows the tab it points at, where the tray is.
      if (question.action === 'play') (doc.defaultView?.FirstMateGuides?.play || play)(question.experience, { replay: true });
      else assistant.ask?.(L(question.prompt || question.text));
    });
    const onChange = () => render();
    // The tray may sit in a project window frame: follow its tab changes there as well as here.
    const windows = [...new Set([root, doc.defaultView].filter(Boolean))];
    const names = ['fm:guides:updated', 'fm:route-state:updated', 'fm:project-window:placement', 'fm:project-tab:opened'];
    windows.forEach((win) => names.forEach((name) => win.addEventListener(name, onChange)));
    render();
    return { render, destroy(){ windows.forEach((win) => names.forEach((name) => win.removeEventListener(name, onChange))); wrap.remove(); } };
  }

  // ── Revealing tabs (onboarding sequencing) ─────────────────────────────
  /**
   * Facts about a project that a reveal rule can name. `has_report`: a measurement report has been delivered for it
   * (a report link or file, or a completed report). Ordered but not delivered does not count: Materials would have
   * nothing to work from yet.
   */
  function projectFacts(project){
    const p = object(project), m = object(p.measurement_project || p.measurement), raw = object(m.raw), manifest = object(p.manifest || raw.manifest);
    const rows = [p, m, raw, manifest];
    const delivered = rows.some((row) => row.has_report === true || !!clean(row.report_url) || !!clean(row.pdf_url) || !!clean(row.summary_url) || !!clean(row.xml_url) || ['completed', 'complete', 'delivered'].includes(clean(row.workflow_state || row.status).toLowerCase()));
    return { has_report: delivered, is_draft: !clean(p.platform_project_id || p.id) };
  }
  /** Map-form equality (`{ "project.has_report": true }`), the part of the condition contract a reveal may use. */
  function factsMatch(when, facts){
    return Object.entries(object(when)).every(([field, expected]) => {
      const actual = field.startsWith('project.') ? facts[field.slice(8)] : undefined;
      return Array.isArray(expected) ? expected.map(String).includes(String(actual)) : String(actual) === String(expected);
    });
  }
  /**
   * The project tabs this person sees now: a tab held back by an unfinished reveal shows only on projects that match
   * its rule. Never a permission check, and the given order is kept.
   */
  function filterProjectTabs(apps, project){
    const rules = array(state.reveals);
    if (!rules.length) return apps;
    const facts = projectFacts(project);
    return array(apps).filter((app) => rules.every((rule) => clean(rule.tab) !== clean(app?.appId || app?.id) || factsMatch(rule.when, facts)));
  }

  // ── Development: edit copy in place, reset and replay ──────────────────
  /*
   * Only for a development editor (the server says so: development data environment, platform administrator or the
   * development tools audience). Every piece of copy rendered with H() carries its key; while "Editing copy" is on
   * it is plain-text contenteditable and saves (debounced) to the platform copy overrides. Shown on top of the code's
   * English for everyone in development on their next load.
   */
  const devCss = `
    html.gx-editing [data-gx-copy]{outline:1px dashed rgba(217,48,37,.55);outline-offset:2px;border-radius:3px;cursor:text;-webkit-user-select:text;user-select:text}
    html.gx-editing [data-gx-copy]:hover{background:rgba(217,48,37,.06)}
    html.gx-editing [data-gx-copy]:focus{outline:2px solid var(--primary,#d93025);background:rgba(255,236,153,.35)}
    .gx-dev{position:fixed;left:12px;bottom:12px;z-index:2147483600;font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#101828}
    .gx-dev-pill{display:inline-flex;align-items:center;gap:6px;padding:4px;border-radius:999px;background:#101828;color:#fff;box-shadow:0 8px 24px rgba(16,24,40,.3)}
    .gx-dev-pill button{border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;font-weight:650;padding:5px 10px;cursor:pointer}
    .gx-dev-pill button[aria-pressed=true]{background:#d93025}
    .gx-dev-pill button:hover{background:rgba(255,255,255,.14)}
    .gx-dev-pill button[aria-pressed=true]:hover{background:#b42318}
    .gx-dev-status{opacity:.75;padding-right:6px;min-width:42px}
    .gx-dev-pill .gx-dev-handle{width:26px;height:26px;padding:0;display:grid;place-items:center;font-size:10px;font-weight:800;letter-spacing:.02em}
    .gx-dev[data-collapsed=true] .gx-dev-pill{padding:3px}
    .gx-dev[data-corner=true]{left:2px;bottom:2px}
    .gx-dev[data-corner=true][data-collapsed=true] .gx-dev-pill{padding:2px}
    .gx-dev[data-corner=true][data-collapsed=true] .gx-dev-handle{width:22px;height:22px;font-size:9px}
    .gx-dev[data-collapsed=true] .gx-dev-pill>:not(.gx-dev-handle),.gx-dev[data-collapsed=true] .gx-dev-panel{display:none}
    .gx-dev-panel{position:absolute;left:0;bottom:44px;width:min(340px,calc(100vw - 24px));max-height:min(60vh,520px);overflow:auto;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 18px 50px rgba(16,24,40,.25);padding:10px}
    .gx-dev-panel[hidden]{display:none}
    .gx-dev-panel h4{margin:8px 4px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#667085}
    .gx-dev-row{display:flex;align-items:center;gap:6px;padding:6px 4px;border-top:1px solid #f2f4f7}
    .gx-dev-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .gx-dev-row button,.gx-dev-panel .gx-dev-btn{border:1px solid #d0d5dd;border-radius:7px;background:#fff;font:inherit;font-size:11.5px;font-weight:650;padding:3px 8px;cursor:pointer;color:#344054;white-space:nowrap}
    .gx-dev-row button:hover{background:#f9fafb}
    .gx-dev-history small{display:block;color:#667085}
    .gx-dev-empty{color:#667085;padding:6px 4px}
  `;
  const EDIT_KEY = 'fm-gx-edit-copy';
  // Copy editing is off until a development editor turns it on (the pill's switch), in each browser.
  const editing = () => { try { return root.localStorage?.getItem(EDIT_KEY) === 'on'; } catch (_) { return false; } };
  const devApi = {
    save: (body) => request('/dev/copy', { method:'PUT', body }),
    history: (key) => request(`/dev/copy/history?key=${encodeURIComponent(key)}`),
    revert: (key, revision) => request('/dev/copy/revert', { method:'POST', body:{ key, revision } }),
    reset: (experience_id, scope) => request(orgPath('/dev/reset'), { method:'POST', body:{ experience_id, scope } })
  };
  const devDocs = new Set();
  let lastKey = '', devStatus = '';
  function setEditable(el){
    if (!el?.matches?.('[data-gx-copy]')) return;
    if (editing()) { el.setAttribute('contenteditable', 'plaintext-only'); if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true'); el.spellcheck = true; }
    else el.removeAttribute('contenteditable');
  }
  function syncEditing(doc){
    doc.documentElement.classList.toggle('gx-editing', editing());
    doc.querySelectorAll('[data-gx-copy]').forEach(setEditable);
    doc.querySelectorAll('.gx-dev [data-gxd=toggle]').forEach((button) => button.setAttribute('aria-pressed', String(editing())));
  }
  function status(text){
    devStatus = text;
    const docs = new Set(devDocs);
    try { if (root.top !== root && root.top.document) docs.add(root.top.document); } catch (_) {}
    docs.forEach((doc) => doc.querySelectorAll('.gx-dev-status').forEach((el) => { el.textContent = text; }));
  }
  const pending = new Map();
  function copyPlace(el){
    const host = el.closest('[data-gx-setup],[data-gx-overlay]');
    return { experience_id: clean(host?.dataset.gxSetup || host?.dataset.gxExperience), step_id: clean(el.closest('[data-gx-step]')?.dataset.gxStep), field: clean(el.closest('h2,h3') ? 'title' : el.closest('p') ? 'body' : el.closest('button') ? 'button' : 'text') };
  }
  function save(el, now = false){
    const key = el.dataset.gxCopy, text = clean(el.textContent).replace(/\s+/g, ' ');
    clearTimeout(pending.get(key));
    if (!text || text === clean(el.dataset.gxOriginal ?? '').replace(/\s+/g, ' ') && !pending.has(key)) return;
    const run = () => {
      pending.delete(key);
      status(L('gx_dev_saving', 'Saving…'));
      devApi.save({ key, text, ...copyPlace(el) }).then(() => {
        overrides[key] = text;
        // Every other place showing this copy, in every frame, shows the new text.
        devDocs.forEach((doc) => doc.querySelectorAll(`[data-gx-copy="${CSS.escape(key)}"]`).forEach((other) => { if (other !== el && other !== doc.activeElement) other.textContent = text; }));
        status(L('gx_dev_saved', 'Saved'));
      }).catch((error) => status(clean(error?.message) || L('gx_dev_failed', 'Not saved')));
    };
    if (now) run(); else pending.set(key, setTimeout(run, 700));
  }
  root.addEventListener?.('storage', (event) => { if (event.key === EDIT_KEY) devDocs.forEach(syncEditing); });
  function installDev(doc){
    if (!doc?.documentElement || devDocs.has(doc)) return;
    devDocs.add(doc);
    injectCss('gx-dev-css', devCss, doc);
    const inEditable = (event) => editing() && event.target?.closest?.('[data-gx-copy]');
    // Editing a label inside a button must not press the button.
    doc.addEventListener('click', (event) => { if (inEditable(event)) { event.preventDefault(); event.stopImmediatePropagation(); event.target.closest('[data-gx-copy]').focus(); } }, true);
    doc.addEventListener('keydown', (event) => {
      const el = inEditable(event);
      if (!el) return;
      event.stopImmediatePropagation();
      if (event.key === 'Enter') { event.preventDefault(); el.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); el.textContent = el.dataset.gxOriginal ?? el.textContent; el.blur(); }
    }, true);
    doc.addEventListener('keyup', (event) => { if (inEditable(event)) { event.stopImmediatePropagation(); event.preventDefault(); } }, true);
    doc.addEventListener('focusin', (event) => { const el = inEditable(event); if (el) { el.dataset.gxOriginal = el.textContent; lastKey = el.dataset.gxCopy; try { root.top.__gxLastCopyKey = lastKey; } catch (_) {} } });
    doc.addEventListener('input', (event) => { const el = inEditable(event); if (el) save(el); }, true);
    doc.addEventListener('focusout', (event) => { const el = inEditable(event); if (el && el.textContent !== el.dataset.gxOriginal) save(el, true); });
    new (doc.defaultView?.MutationObserver || MutationObserver)((records) => {
      if (!editing()) return;
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        setEditable(node);
        node.querySelectorAll?.('[data-gx-copy]').forEach(setEditable);
      }
    }).observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    syncEditing(doc);
    mountDevPill(doc);
    watchDevTools(doc);
  }
  /**
   * The pill: "Editing copy" on or off, the last edited field's history, and reset or replay for each experience.
   * One pill, on the top page, fixed to the bottom left of the screen above the project window (2147483200); it
   * acts on the open project frame. It folds to a small "GX" handle.
   */
  const COLLAPSE_KEY = 'fm-gx-dev-collapsed';
  function mountDevPill(doc){
    // Only the top page gets the pill. A project frame (whichever library instance draws into it: its own, or the
    // page's when it attaches the frame's assistant) leaves it to the page above; only an unreachable parent gets one.
    const reachableTop = (win) => { try { return win && win.top !== win && win.top.document ? win.top : null; } catch (_) { return null; } };
    if (reachableTop(root) || reachableTop(doc.defaultView)) return;
    if (doc.querySelector('.gx-dev')) return;
    const host = doc.createElement('div'); host.className = 'gx-dev'; host.setAttribute('data-fmr-ignore', '');
    let collapsed = true;
    try { collapsed = root.localStorage?.getItem(COLLAPSE_KEY) !== 'open'; } catch (_) {}
    host.dataset.collapsed = String(collapsed);
    host.innerHTML = `<div class="gx-dev-panel" hidden></div><div class="gx-dev-pill"><button type="button" class="gx-dev-handle" data-gxd="collapse" aria-expanded="${!collapsed}" aria-label="${esc(L('gx_dev_handle', 'Guided experience tools'))}" title="${esc(L('gx_dev_handle', 'Guided experience tools'))}">GX</button><button type="button" data-gxd="toggle" aria-pressed="${editing()}">${esc(L('gx_dev_editing', 'Editing copy'))}</button><span class="gx-dev-status" role="status">${esc(devStatus)}</span><button type="button" data-gxd="menu" aria-expanded="false" aria-label="${esc(L('gx_dev_menu', 'Guided experience tools'))}">&#8943;</button></div>`;
    (doc.body || doc.documentElement).appendChild(host);
    const panel = host.querySelector('.gx-dev-panel');
    host.addEventListener('click', async (event) => {
      const action = event.target.closest?.('[data-gxd]');
      if (!action) return;
      const kind = action.dataset.gxd;
      if (kind === 'collapse') { const next = host.dataset.collapsed !== 'true'; host.dataset.collapsed = String(next); action.setAttribute('aria-expanded', String(!next)); try { root.localStorage?.setItem(COLLAPSE_KEY, next ? 'closed' : 'open'); } catch (_) {} return; }
      if (kind === 'toggle') { try { root.localStorage?.setItem(EDIT_KEY, editing() ? 'off' : 'on'); } catch (_) {} devDocs.forEach(syncEditing); doc.querySelectorAll('iframe').forEach((frame) => { try { const guides = frame.contentWindow?.FirstMateGuides; if (guides && guides !== root.FirstMateGuides) guides.syncDevEditing?.(); } catch (_) {} }); return; }
      if (kind === 'menu') { panel.hidden = !panel.hidden; action.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) renderDevPanel(panel); return; }
      await devAction(action.dataset, () => renderDevPanel(panel));
    });
    host.hidden = false;
    // Beside the portal sidebar's footer rather than over its settings button: just right of the sidebar, following
    // its width as it expands and collapses.
    // When something covers the sidebar (the project window), it sits small in the very corner of the screen, clear of
    // that window's frame. Checked again as windows open and close.
    const dock = () => {
      const side = doc.querySelector('.sidebar'), box = side?.getBoundingClientRect(), win = doc.defaultView;
      const shown = box && box.width > 0 && box.left < 8 && getComputedStyle(side).display !== 'none';
      let covered = false;
      if (shown && win) {
        const x = Math.max(1, Math.min(box.right - 4, box.left + 24)), y = Math.max(1, win.innerHeight - 24);
        const hit = doc.elementsFromPoint(x, y).find((el) => !host.contains(el));
        covered = !!hit && !side.contains(hit);
      }
      host.dataset.corner = String(!shown || covered);
      host.style.left = shown && !covered ? `${Math.round(box.right + 12)}px` : '';
    };
    dock();
    const side = doc.querySelector('.sidebar');
    if (side && doc.defaultView?.ResizeObserver) new doc.defaultView.ResizeObserver(dock).observe(side);
    doc.defaultView?.addEventListener('resize', dock);
    setInterval(dock, 1000);
  }
  async function devAction(data, rerender){
    const kind = data.gxd, id = data.gxdId;
    try {
      if (kind === 'revert') { await devApi.revert(data.gxdKey, Number(data.gxdRevision)); status(L('gx_dev_reverted', 'Reverted')); await refresh(true); rerender?.(); return; }
      if (kind === 'reset-me' || kind === 'reset-org') {
        const result = await devApi.reset(id, kind === 'reset-org' ? 'organization' : 'me');
        status(L('gx_dev_reset', 'Reset') + ` (${result.progress})`);
        await refresh(true); rerender?.();
        return;
      }
      if (kind === 'restart' || kind === 'replay') {
        // Plays where the tab is: a project window frame when one is open.
        const target = projectFrameGuides() || root.FirstMateGuides;
        if (kind === 'restart') { await devApi.reset(id, 'me'); }
        await target.refresh();
        target.play(id, { replay: true, force: true });
      }
    } catch (error) { status(clean(error?.message) || L('gx_dev_failed', 'Not saved')); }
  }
  function projectFrameGuides(){
    for (const frame of document.querySelectorAll('iframe')) {
      try { const guides = frame.contentWindow?.FirstMateGuides; if (guides && frame.getClientRects().length && frame.contentWindow.FirstMateGuides !== root.FirstMateGuides) return guides; } catch (_) { /* another origin */ }
    }
    return null;
  }
  async function renderDevPanel(panel){
    const list = array(state.devExperiences);
    let history = [];
    try { if (root.__gxLastCopyKey) lastKey = root.__gxLastCopyKey; } catch (_) {}
    if (lastKey) history = array((await devApi.history(lastKey).catch(() => ({}))).history);
    panel.innerHTML = `<h4>${esc(L('gx_dev_field', 'Last edited copy'))}</h4>${lastKey ? `<div class="gx-dev-history">${history.map((entry) => `<div class="gx-dev-row"><span>${esc(entry.text || '(code)')}<small>${esc(entry.author)} · ${esc(new Date(entry.created_at).toLocaleString())} · r${entry.revision}</small></span><button type="button" data-gxd="revert" data-gxd-key="${esc(lastKey)}" data-gxd-revision="${entry.revision}">${esc(L('gx_dev_use', 'Use'))}</button></div>`).join('')}<div class="gx-dev-row"><span>${esc(lastKey)}</span><button type="button" data-gxd="revert" data-gxd-key="${esc(lastKey)}" data-gxd-revision="0">${esc(L('gx_dev_code_text', 'Use the code’s text'))}</button></div></div>` : `<div class="gx-dev-empty">${esc(L('gx_dev_no_field', 'Edit any copy to see its history here.'))}</div>`}
      <h4>${esc(L('gx_dev_experiences', 'Experiences'))}</h4>${list.map((entry) => `<div class="gx-dev-row"><span title="${esc(entry.id)}">${esc(L(entry.title))}</span>${entry.kind === 'overlay' ? `<button type="button" data-gxd="replay" data-gxd-id="${esc(entry.id)}">${esc(L('gx_dev_replay', 'Replay'))}</button>` : `<button type="button" data-gxd="restart" data-gxd-id="${esc(entry.id)}">${esc(L('gx_dev_restart', 'Restart'))}</button>`}<button type="button" data-gxd="reset-me" data-gxd-id="${esc(entry.id)}">${esc(L('gx_dev_reset_me', 'Reset me'))}</button><button type="button" data-gxd="reset-org" data-gxd-id="${esc(entry.id)}">${esc(L('gx_dev_reset_org', 'Reset org'))}</button></div>`).join('') || `<div class="gx-dev-empty">${esc(L('gx_dev_none', 'No experiences.'))}</div>`}`;
  }
  /** Adds a "Guided experiences" section to the development tools window (libraries/development-tools) when it opens. */
  function watchDevTools(doc){
    const add = () => doc.querySelectorAll('.fm-dev-window .fm-dev-body').forEach((body) => {
      if (body.querySelector('[data-gx-devtools]')) return;
      const section = doc.createElement('details'); section.className = 'fm-dev-section'; section.dataset.gxDevtools = ''; section.setAttribute('data-fmr-ignore', '');
      section.innerHTML = `<summary><span><i class="fas fa-route" aria-hidden="true"></i> ${esc(L('gx_dev_section', 'Guided experiences'))}</span></summary><div class="gx-dev-panel" style="position:static;width:auto;box-shadow:none;border:0;padding:0"></div><label class="fm-dev-option"><span><strong>${esc(L('gx_dev_editing', 'Editing copy'))}</strong></span><input type="checkbox" role="switch" data-gxd-edit ${editing() ? 'checked' : ''}></label>`;
      const footer = body.querySelector('.fm-dev-footer');
      body.insertBefore(section, footer || null);
      const panel = section.querySelector('.gx-dev-panel');
      section.addEventListener('toggle', () => { if (section.open) renderDevPanel(panel); });
      section.addEventListener('click', (event) => { const action = event.target.closest?.('[data-gxd]'); if (action && !action.matches('[data-gxd-edit]')) devAction(action.dataset, () => renderDevPanel(panel)); });
      section.querySelector('[data-gxd-edit]').addEventListener('change', (event) => { try { root.localStorage?.setItem(EDIT_KEY, event.target.checked ? 'on' : 'off'); } catch (_) {} devDocs.forEach(syncEditing); projectFrameGuides()?.syncDevEditing?.(); });
    });
    let queued = false;
    new (doc.defaultView?.MutationObserver || MutationObserver)(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; add(); }); }).observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    add();
  }

  root.FirstMateGuides = {
    /** Development: re-reads the editing switch (the pill on the page above calls it on project frames). */
    syncDevEditing: () => devDocs.forEach(syncEditing),
    copyHtml: H, installDev, syncDevEditing: () => devDocs.forEach(syncEditing), isDevEditor: () => devState.editor,
    filterProjectTabs, projectFacts,
    refresh: () => refresh(true), play, faqs, attachAssistant, overlay, where, follow,
    registerKind(kind, player){ kinds.set(kind, player); },
    experience: (id) => state.experiences.get(id) || null,
    experiences: () => [...state.experiences.values()],
    isPlaying: () => !!shared.active,
    L, esc, api, injectCss, reducedMotion
  };
  if (document?.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => refresh(), { once: true }); else setTimeout(() => refresh(), 0);
})(window);
