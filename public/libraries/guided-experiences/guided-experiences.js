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
  const L = (copy, fallback) => {
    if (copy && typeof copy === 'object') return root.PlatformLanguage?.text?.(NS, copy.key, copy.text) ?? copy.text;
    return root.PlatformLanguage?.text?.(NS, copy, fallback) ?? fallback;
  };
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
  const state = { experiences: new Map(), faqs: new Map(), loaded: '', loading: null, playing: null, bypass: new WeakSet(), tabTimers: new Set(), openedTabs: new Set() };
  const kinds = new Map();

  async function refresh(force = false){
    if (!orgId() || !root.fetch) return null;
    const here = where();
    const key = `${here.tab}|${here.projectId}`;
    if (!force && state.loaded === key) return state;
    if (state.loading && !force) return state.loading;
    state.loading = api.list(here.tab, here.projectId).then((result) => {
      state.experiences = new Map(array(result.experiences).map((entry) => [entry.id, entry]));
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
    return api.event(experience.id, body).catch((error) => { console.warn('Guided experience event not saved.', error); return null; });
  }

  // ── Playing ────────────────────────────────────────────────────────────
  async function play(id, options = {}){
    if (state.playing) return { status: 'busy' };
    await refresh();
    let experience = state.experiences.get(id);
    if (!experience) { await refresh(true); experience = state.experiences.get(id); }
    if (!experience) return { status: 'unavailable' };
    if (experience.progress && experience.progress.status !== 'started' && !options.replay && !options.force) return { status: 'done' };
    const player = kinds.get(experience.kind);
    if (!player) return { status: 'unavailable' };
    state.playing = experience.id;
    root.dispatchEvent?.(new CustomEvent('fm:guides:playing', { detail: { id: experience.id } }));
    try {
      await track(experience, options.replay ? 'replay' : 'exposure');
      if (!options.replay) await track(experience, 'start');
      const outcome = await player({ experience, api, track: (type, extra) => track(experience, type, extra), where, L, esc, reducedMotion, options });
      return outcome || { status: 'ended' };
    } finally {
      state.playing = null;
      await refresh(true);
      root.dispatchEvent?.(new CustomEvent('fm:guides:ended', { detail: { id: experience.id } }));
    }
  }

  /** After an experience: hand off, let a held click through, then play what follows. */
  async function follow(experience, outcome, held, selector = ''){
    let resumed = false;
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
    if (state.playing || event.defaultPrevented) return;
    const target = event.target?.closest?.('button,[role=button],a,[data-mt-generate-materials],[data-mt-generate-column]');
    if (!target || state.bypass.has(target)) { if (target) state.bypass.delete(target); return; }
    for (const experience of state.experiences.values()) {
      const trigger = array(experience.triggers).find((entry) => entry.kind === 'before_action' && safeMatches(target, entry.selector));
      if (!trigger || (experience.progress && experience.progress.status !== 'started')) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      (async () => {
        const outcome = await play(experience.id, { trigger });
        await follow(experience, outcome || {}, target, trigger.selector);
      })();
      return;
    }
  }, true);
  function safeMatches(element, selector){ try { return !!element.closest(selector); } catch (_) { return false; } }

  // tab_opened: the project route names the tab.
  function onRoute(){
    const here = where();
    refresh().then(() => {
      if (!here.tab || state.openedTabs.has(`${here.projectId}|${here.tab}`)) return;
      state.openedTabs.add(`${here.projectId}|${here.tab}`);
      for (const experience of state.experiences.values()) {
        const trigger = array(experience.triggers).find((entry) => entry.kind === 'tab_opened' && entry.tab === here.tab);
        if (!trigger || (experience.progress && experience.progress.status !== 'started')) continue;
        const timer = setTimeout(() => { state.tabTimers.delete(timer); if (where().tab === here.tab) play(experience.id); }, Number(trigger.delay_ms || 700));
        state.tabTimers.add(timer);
        break;
      }
    });
  }
  root.addEventListener?.('fm:route-state:updated', onRoute);

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
  function injectCss(id, css){
    if (document.getElementById(id)) return;
    const style = document.createElement('style'); style.id = id; style.textContent = css; document.head.appendChild(style);
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
        const pop = document.createElement('div'); pop.className = 'gx-pop'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-modal', 'false'); pop.setAttribute('data-fmr-ignore', ''); pop.tabIndex = -1;
        document.body.append(host, pop);
        const path = host.querySelector('path'), ring = host.querySelector('.gx-ov-ring');
        let index = -1, shown = 0, ended = false, current = null, targets = [], holes = [], animation = 0, clickTarget = null;
        const finish = (status) => {
          if (ended) return; ended = true;
          cancelAnimationFrame(animation); root.removeEventListener('resize', redraw); root.removeEventListener('scroll', redraw, true); document.removeEventListener('keydown', key, true);
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
          pop.classList.toggle('gx-center', !main);
          const arrow = pop.querySelector('.gx-arrow');
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
        function onTargetClick(){ setTimeout(() => go(index + 1, 1), 60); }
        function render(step){
          const total = list.length, position = index + 1, last = position >= total;
          pop.innerHTML = `<button type="button" class="gx-x" data-gx="close" aria-label="${esc(L('gx_ui_skip_tutorial', 'Skip tutorial'))}" title="${esc(L('gx_ui_skip_tutorial', 'Skip tutorial'))}">&times;</button>
            <h3>${esc(L(step.title))}</h3><p>${esc(L(step.body))}</p>
            <footer><span class="gx-dots" aria-label="${esc(L('gx_ui_step_of', 'Step') + ' ' + position + ' / ' + total)}">${list.map((_, i) => `<i class="${i === index ? 'on' : ''}"></i>`).join('')}</span>
              ${position > 1 ? `<button type="button" class="gx-b gx-link" data-gx="back">${esc(L('gx_ui_back', 'Back'))}</button>` : ''}
              ${!last ? `<button type="button" class="gx-b gx-link" data-gx="skip">${esc(L('gx_ui_skip_step', 'Skip step'))}</button>` : ''}
              ${step.advance === 'click' && targets.length ? '' : `<button type="button" class="gx-b gx-primary" data-gx="next">${esc(last ? L('gx_ui_done', 'Done') : L('gx_ui_next', 'Next'))}</button>`}</footer>
            <span class="gx-arrow" aria-hidden="true"></span>`;
          pop.setAttribute('aria-label', L(step.title));
          pop.classList.remove('gx-enter'); void pop.offsetWidth; pop.classList.add('gx-enter');
          setTimeout(() => pop.querySelector('[data-gx=next]')?.focus?.({ preventScroll: true }), 30);
        }
        async function go(to, direction){
          if (ended) return;
          clickTarget?.removeEventListener('click', onTargetClick, true); clickTarget = null;
          for (let i = to; i >= 0 && i < list.length; i += direction) {
            const step = list[i];
            const selectors = array(step.targets);
            let found = [];
            if (selectors.length) {
              const first = await waitFor(selectors, direction > 0 ? Number(step.wait_ms ?? 1500) : 0);
              if (ended) return;
              if (!first) { options.onStep?.({ type: 'step_skip', step: step.id, missing: true }); continue; }
              found = selectors.map(visible).filter(Boolean);
              found.sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
              first.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
            }
            index = i; current = step; targets = found; shown += 1;
            render(step);
            animateTo(targets.map(rectOf));
            requestAnimationFrame(place);
            if (step.advance === 'click' && targets[0]) { clickTarget = targets[0]; clickTarget.addEventListener('click', onTargetClick, true); }
            options.onStep?.({ type: 'step_view', step: step.id, index: i });
            return;
          }
          if (direction > 0) finish('completed');
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
        draw([]);
        go(0, 1);
      });
    }
  };

  kinds.set('overlay', async ({ experience, track: record }) => {
    const result = await overlay.run(experience.steps, { onStep: ({ type, step }) => { if (type !== 'dismiss') record(type, { step_id: step }); } });
    if (result.status === 'completed') await record('complete', { step_id: result.last, properties: { shown: result.shown } });
    else await record('dismiss', { step_id: result.last, properties: { shown: result.shown } });
    return result;
  });

  // ── Assistant suggestions (FAQs) ───────────────────────────────────────
  const faqCss = `
    .gx-faqs{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 8px;scrollbar-width:none;mask-image:linear-gradient(90deg,#000 92%,transparent)}
    .gx-faqs::-webkit-scrollbar{display:none}
    .gx-faqs[hidden]{display:none}
    .gx-faq{flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid #e4e7ec;border-radius:999px;background:#fff;color:#344054;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,transform .15s;animation:gxChip .35s cubic-bezier(.22,1,.36,1) both}
    .gx-faq:hover{background:#f9fafb;border-color:#98a2b3;transform:translateY(-1px)}
    .gx-faq i{color:var(--primary,#d93025);font-size:11px}
    .gx-faq:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
    @keyframes gxChip{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @media(prefers-reduced-motion:reduce){.gx-faq{animation:none;transition:none}}
  `;
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
    if (!drawer || drawer.querySelector(':scope .gx-faqs')) return null;
    injectCss('gx-faq-css', faqCss);
    const composer = drawer.querySelector('[data-fma="composer"]');
    const shell = composer?.querySelector('.fma-compose-shell');
    if (!composer || !shell) return null;
    const strip = document.createElement('div'); strip.className = 'gx-faqs'; strip.hidden = true; strip.setAttribute('role', 'list'); strip.setAttribute('aria-label', L('gx_ui_suggested', 'Suggested questions'));
    composer.insertBefore(strip, shell);
    let shownTab = '';
    const tabNow = () => { const context = object(assistant.getContext?.()); return clean(context.tab) ? (clean(context.tab).includes('.') ? clean(context.tab) : `project.${clean(context.tab)}`) : where().tab; };
    const render = () => {
      const tab = tabNow();
      const questions = faqs(tab);
      if (!questions.length) { strip.hidden = true; strip.innerHTML = ''; shownTab = tab; if (tab && !state.faqs.has(tab)) refresh(); return; }
      if (tab === shownTab && !strip.hidden) return;
      shownTab = tab;
      strip.innerHTML = questions.map((question, i) => `<button type="button" class="gx-faq" role="listitem" data-gx-faq="${esc(question.id)}" style="animation-delay:${i * 40}ms">${question.action === 'play' ? '<i class="fas fa-circle-play" aria-hidden="true"></i>' : '<i class="fas fa-sparkles" aria-hidden="true"></i>'}${esc(L(question.text))}</button>`).join('');
      strip.hidden = false;
    };
    strip.addEventListener('click', (event) => {
      const id = event.target.closest?.('[data-gx-faq]')?.dataset.gxFaq;
      const question = faqs(tabNow()).find((entry) => entry.id === id);
      if (!question) return;
      const experience = question.experience && state.experiences.get(question.experience);
      root.FirstMateStatsig?.track?.('guided_faq', { question: question.id, tab: tabNow() });
      if (experience) api.event(experience.id, { type: 'faq', tab: tabNow(), project_id: where().projectId, properties: { question: question.id } }).catch(() => null);
      if (question.action === 'play') play(question.experience, { replay: true });
      else assistant.ask?.(L(question.prompt || question.text));
    });
    const onChange = () => render();
    root.addEventListener('fm:guides:updated', onChange); root.addEventListener('fm:route-state:updated', onChange); root.addEventListener('fm:project-window:placement', onChange);
    refresh().then(render);
    return { render, destroy(){ root.removeEventListener('fm:guides:updated', onChange); root.removeEventListener('fm:route-state:updated', onChange); root.removeEventListener('fm:project-window:placement', onChange); strip.remove(); } };
  }

  root.FirstMateGuides = {
    refresh: () => refresh(true), play, faqs, attachAssistant, overlay, where, follow,
    registerKind(kind, player){ kinds.set(kind, player); },
    experience: (id) => state.experiences.get(id) || null,
    experiences: () => [...state.experiences.values()],
    isPlaying: () => !!state.playing,
    L, esc, api, injectCss, reducedMotion
  };
  if (document?.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => refresh(), { once: true }); else setTimeout(() => refresh(), 0);
})(window);
