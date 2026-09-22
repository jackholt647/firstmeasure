/* FirstMate Insights
 * Reusable contextual recommendations with adaptive popovers and optional,
 * insight-scoped agent conversations. Load this file once, then call
 * FirstMateInsights.mount(target, definition).
 */
(function(root){
  'use strict';

  const scriptUrl = document.currentScript?.src || '';
  const libraryBase = scriptUrl ? new URL('.', scriptUrl).href : '/libraries/insights/';
  const definitions = new Map();
  const instances = new Set();
  const sessions = new Map();
  let active = null;
  let configured = false;
  let preferencesPromise = null;
  let settings = { enabled:true, agent_enabled:false };
  let options = {};

  const clean = (value) => String(value ?? '').trim();
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match]));
  const iconUrl = () => clean(options.iconUrl) || `${libraryBase}assets/insights.png`;
  const iconCssUrl = () => `url(${JSON.stringify(iconUrl())})`;
  const orgId = () => clean(options.orgId || root.__APP?.userOrgId || root.__APP?.orgId);
  const branchId = () => clean(options.branchId || root.Portal?.branchModules?.currentBranchId?.() || root.__APP?.userBranchId || 'default') || 'default';
  const normalizeSettings = (value = {}) => ({ enabled:object(value).enabled !== false, agent_enabled:object(value).agent_enabled === true });

  function ensureAssets(){
    if (!document.querySelector('link[data-firstmate-insights-css]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = clean(options.cssUrl) || `${libraryBase}firstmate-insights.css`;
      link.dataset.firstmateInsightsCss = 'true';
      document.head.appendChild(link);
    }
  }

  function configure(next = {}){
    options = { ...options, ...object(next) };
    configured = true;
    ensureAssets();
    if (next.settings) setSettings(next.settings, { persist:false });
    if (next.loadPreferences !== false && !next.settings) void loadPreferences();
    return api;
  }

  async function loadPreferences({ force = false } = {}){
    if (preferencesPromise && !force) return preferencesPromise;
    preferencesPromise = (async () => {
      try {
        if (!orgId() || !root.PlatformAPI?.branchModules?.get) return settings;
        const module = await root.PlatformAPI.branchModules.get(orgId(), branchId(), 'insights_settings');
        settings = normalizeSettings(module?.data || module || {});
      } catch (_) {
        settings = normalizeSettings(settings);
      }
      syncVisibility();
      dispatchSettings();
      return { ...settings };
    })();
    try { return await preferencesPromise; }
    finally { preferencesPromise = null; }
  }

  function dispatchSettings(){
    root.dispatchEvent(new CustomEvent('fm:insights:settings-changed', { detail:{ ...settings } }));
  }

  function setSettings(next = {}, meta = {}){
    settings = normalizeSettings({ ...settings, ...object(next) });
    syncVisibility();
    dispatchSettings();
    if (meta.persist) return savePreferences(settings);
    return Promise.resolve({ ...settings });
  }

  async function savePreferences(next = settings){
    const normalized = normalizeSettings(next);
    if (!orgId() || !root.PlatformAPI?.branchModules?.save) throw new Error('Insights settings cannot be saved right now.');
    await root.PlatformAPI.branchModules.save(orgId(), branchId(), 'insights_settings', normalized, { kind:'branch_insights_settings', source:'insights_settings' });
    settings = normalized;
    syncVisibility();
    dispatchSettings();
    return { ...settings };
  }

  function normalizeDefinition(value = {}){
    const definition = object(value);
    const id = clean(definition.id);
    if (!id) throw new Error('An insight requires a stable id.');
    return {
      ...definition,
      id,
      title:clean(definition.title) || 'Insight',
      label:clean(definition.label) || `Open insight: ${clean(definition.title) || id}`,
      body:definition.body ?? definition.content ?? '',
      developerContext:definition.developerContext ?? definition.systemPrompt ?? '',
      preferredSide:['top','right','bottom','left'].includes(definition.preferredSide) ? definition.preferredSide : ''
    };
  }

  function register(id, value = {}){
    const definition = normalizeDefinition({ ...object(value), id:id || value.id });
    definitions.set(definition.id, definition);
    return definition;
  }

  function resolveDefinition(value){
    if (typeof value === 'string') {
      const definition = definitions.get(value);
      if (!definition) throw new Error(`Unknown insight "${value}".`);
      return definition;
    }
    const definition = normalizeDefinition(value);
    definitions.set(definition.id, definition);
    return definition;
  }

  function create(value){
    if (!configured) configure();
    const definition = resolveDefinition(value);
    const wrap = document.createElement(definition.inline === false ? 'div' : 'span');
    wrap.className = `fm-insight-anchor${clean(definition.className) ? ` ${clean(definition.className)}` : ''}`;
    wrap.dataset.insightId = definition.id;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'fm-insight-trigger';
    trigger.setAttribute('aria-label', definition.label);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.style.setProperty('--fm-insight-icon', iconCssUrl());
    trigger.innerHTML = '<span class="fm-insight-logo" aria-hidden="true"></span>';
    if (definition.size) trigger.style.setProperty('--fm-insight-size', `${Math.max(18, Number(definition.size) || 25)}px`);
    wrap.appendChild(trigger);
    const instance = { definition, element:wrap, trigger, preview:definition.preview === true, destroy:null };
    const onClick = (event) => { event.preventDefault(); event.stopPropagation(); active?.instance === instance ? close() : open(instance); };
    trigger.addEventListener('click', onClick);
    instance.destroy = () => {
      trigger.removeEventListener('click', onClick);
      if (active?.instance === instance) close({ returnFocus:false });
      instances.delete(instance);
      wrap.remove();
    };
    instances.add(instance);
    syncInstance(instance);
    return instance;
  }

  function mount(target, value){
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error('FirstMateInsights.mount requires a target element.');
    const instance = create(value);
    host.appendChild(instance.element);
    return instance;
  }

  function syncInstance(instance){
    instance.element.hidden = !instance.preview && !settings.enabled;
  }

  function syncVisibility(){
    instances.forEach(syncInstance);
    if (active && !active.instance.preview && !settings.enabled) close({ returnFocus:false });
    if (active) syncComposer(active);
  }

  function bodyText(definition){
    if (typeof definition.body === 'string') return definition.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (definition.body instanceof Node) return clean(definition.body.textContent);
    return clean(definition.body);
  }

  function renderBody(host, definition){
    const body = definition.body;
    if (typeof body === 'function') {
      const result = body({ insight:definition, settings:{ ...settings } });
      if (result instanceof Node) host.appendChild(result);
      else if (definition.allowHtml) host.innerHTML = String(result ?? '');
      else host.textContent = String(result ?? '');
    } else if (body instanceof Node) {
      host.appendChild(body.cloneNode(true));
    } else if (definition.allowHtml) {
      host.innerHTML = String(body ?? '');
    } else {
      host.textContent = String(body ?? '');
    }
    renderMedia(host, definition);
  }

  function renderMedia(host, definition){
    const media = [];
    if (definition.image) media.push({ kind:'image', ...object(typeof definition.image === 'string' ? { src:definition.image } : definition.image) });
    if (definition.video) media.push({ kind:'video', ...object(typeof definition.video === 'string' ? { src:definition.video } : definition.video) });
    if (Array.isArray(definition.media)) media.push(...definition.media.map((item) => object(item)));
    if (!media.length) return;
    const gallery = document.createElement('div');
    gallery.className = 'fm-insight-media';
    media.forEach((item) => {
      const src = clean(item.src);
      if (!src) return;
      const figure = document.createElement('figure');
      figure.style.margin = '0';
      if (item.kind === 'video' || item.type === 'video') {
        const video = document.createElement('video');
        video.src = src;
        video.controls = item.controls !== false;
        video.preload = clean(item.preload) || 'metadata';
        if (item.poster) video.poster = clean(item.poster);
        figure.appendChild(video);
      } else {
        const image = document.createElement('img');
        image.src = src;
        image.alt = clean(item.alt);
        image.loading = 'lazy';
        figure.appendChild(image);
      }
      if (item.caption) {
        const caption = document.createElement('figcaption');
        caption.textContent = clean(item.caption);
        figure.appendChild(caption);
      }
      gallery.appendChild(figure);
    });
    host.appendChild(gallery);
  }

  function sessionFor(definition){
    if (!sessions.has(definition.id)) sessions.set(definition.id, { threadId:'', messages:[], pending:false });
    return sessions.get(definition.id);
  }

  function buildPopover(instance){
    const definition = instance.definition;
    const popover = document.createElement('section');
    popover.className = 'fm-insight-popover';
    popover.setAttribute('popover', 'manual');
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-label', definition.title);
    popover.style.setProperty('--fm-insight-icon', iconCssUrl());
    popover.innerHTML = `<header class="fm-insight-head"><span class="fm-insight-head-icon fm-insight-logo" aria-hidden="true"></span><div class="fm-insight-heading"><span class="fm-insight-kicker">${(globalThis.PlatformLanguage?.text("insights","m_89b8c4efe6661d","Insight") ?? "Insight")}</span><h3 class="fm-insight-title">${String(esc(definition.title))}</h3></div><button class="fm-insight-close" type="button" aria-label="${(globalThis.PlatformLanguage?.text("insights","m_e8d6e1ba2cb635","Close insight") ?? "Close insight")}">${(globalThis.PlatformLanguage?.text("insights","m_dd0c616953d455","&times;") ?? "&times;")}</button></header><div class="fm-insight-scroll"><div class="fm-insight-conversation"></div></div>`;
    const conversation = popover.querySelector('.fm-insight-conversation');
    const initial = document.createElement('div');
    initial.className = 'fm-insight-message insight';
    renderBody(initial, definition);
    conversation.appendChild(initial);
    document.body.appendChild(popover);
    try { popover.showPopover?.(); } catch {}
    const view = { instance, popover, conversation, composer:null, session:sessionFor(definition) };
    if (typeof ResizeObserver === 'function') {
      view.resizeObserver = new ResizeObserver(() => {
        if (active === view) requestAnimationFrame(() => { if (active === view) position(view); });
      });
      view.resizeObserver.observe(popover);
    }
    view.session.messages.forEach((message) => appendMessage(view, message));
    syncComposer(view);
    popover.querySelector('.fm-insight-close')?.addEventListener('click', () => close());
    return view;
  }

  function syncComposer(view){
    const allowed = settings.agent_enabled && view.instance.definition.agent !== false;
    if (!allowed) {
      view.composer?.remove();
      view.composer = null;
      return;
    }
    if (view.composer) return;
    const form = document.createElement('form');
    form.className = 'fm-insight-composer';
    form.innerHTML = `<textarea class="fm-insight-input" rows="1" maxlength="4000" placeholder="${(globalThis.PlatformLanguage?.text("insights","m_2f4c19ca03f27f","Ask about this insight…") ?? "Ask about this insight…")}" aria-label="${(globalThis.PlatformLanguage?.text("insights","m_3cfe2fbbe87ff9","Ask the Insights agent") ?? "Ask the Insights agent")}"></textarea><button class="fm-insight-send" type="submit" aria-label="${(globalThis.PlatformLanguage?.text("insights","m_c23a056552a09f","Send") ?? "Send")}"><i class="fas fa-arrow-up" aria-hidden="true"></i></button>`;
    view.popover.appendChild(form);
    view.composer = form;
    const input = form.querySelector('.fm-insight-input');
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(92, input.scrollHeight)}px`;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); void send(view); });
  }

  function appendMessage(view, message){
    const element = document.createElement('div');
    element.className = `fm-insight-message ${message.role === 'user' ? 'user' : 'agent'}${message.failed ? ' failed' : ''}`;
    if (message.pending) {
      element.dataset.insightThinking = 'true';
      element.innerHTML = `<span class="fm-insight-thinking"><span class="fm-insight-thinking-mark"><span class="fm-insight-logo" aria-hidden="true"></span></span><span class="fm-insight-thinking-dots" aria-label="${(globalThis.PlatformLanguage?.text("insights","m_c65c4642411503","Agent is thinking") ?? "Agent is thinking")}"><i></i><i></i><i></i></span></span>`;
    } else if (message.role === 'agent' && root.FirstMateAgentChat?.renderMarkdown) {
      element.innerHTML = root.FirstMateAgentChat.renderMarkdown(message.content);
    } else {
      element.textContent = message.content;
    }
    view.conversation.appendChild(element);
    requestAnimationFrame(() => { view.popover.querySelector('.fm-insight-scroll').scrollTop = view.popover.querySelector('.fm-insight-scroll').scrollHeight; });
    return element;
  }

  async function send(view){
    if (view.session.pending || !root.AgentsAPI) return;
    const input = view.composer?.querySelector('.fm-insight-input');
    const message = clean(input?.value);
    if (!message) return;
    input.value = '';
    input.style.height = 'auto';
    view.session.messages.push({ role:'user', content:message });
    appendMessage(view, { role:'user', content:message });
    view.session.pending = true;
    view.composer.querySelector('.fm-insight-send').disabled = true;
    const pending = appendMessage(view, { role:'agent', pending:true });
    const definition = view.instance.definition;
    try {
      if (!view.session.threadId) {
        const created = await root.AgentsAPI.createThread(orgId(), clean(options.agentId) || 'insights', { branch_id:branchId(), subject_id:definition.id });
        view.session.threadId = clean(created?.thread?.id);
      }
      const result = await root.AgentsAPI.send(orgId(), clean(options.agentId) || 'insights', view.session.threadId, {
        message,
        branch_id:branchId(),
        input:{
          insight_id:definition.id,
          insight_title:definition.title,
          insight:bodyText(definition),
          developer_context:typeof definition.developerContext === 'function' ? String(definition.developerContext({ insight:definition }) ?? '') : String(definition.developerContext ?? '')
        }
      }, { signal:typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(150000) : undefined });
      const response = object(result?.assistant_message);
      const reply = { role:'agent', content:String(response.content ?? 'I could not find an answer for that yet.'), failed:object(response.data).status === 'failed' };
      view.session.messages.push(reply);
      pending.remove();
      appendMessage(view, reply);
    } catch (error) {
      const reply = { role:'agent', content:clean(error?.message) || 'The Insights agent is unavailable right now. Please try again.', failed:true };
      view.session.messages.push(reply);
      pending.remove();
      appendMessage(view, reply);
    } finally {
      view.session.pending = false;
      if (view.composer?.isConnected) view.composer.querySelector('.fm-insight-send').disabled = false;
      input?.focus();
      position(view);
    }
  }

  function topChromeElements(){
    return Array.from(new Set(document.querySelectorAll([
      '#platformTopbar',
      '.platform-topbar',
      '.mobile-topbar',
      '[data-insights-viewport-top]',
      '[data-insights-top-boundary]'
    ].join(','))));
  }

  function usableViewport(){
    let top = 0;
    topChromeElements().forEach((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width < 1 || rect.height < 1) return;
      if (rect.bottom <= 0 || rect.top >= innerHeight) return;
      top = Math.max(top, Math.min(innerHeight, rect.bottom));
    });
    return { top, right:innerWidth, bottom:innerHeight, left:0, width:innerWidth, height:Math.max(0, innerHeight-top) };
  }

  function bestSide(rect, width, height, preferred, bounds){
    const gap = 10;
    const space = {
      top:rect.top-gap-bounds.top,
      bottom:bounds.bottom-rect.bottom-gap,
      left:rect.left-gap-bounds.left,
      right:bounds.right-rect.right-gap
    };
    const fits = { top:space.top >= height, bottom:space.bottom >= height, left:space.left >= width, right:space.right >= width };
    if (preferred && fits[preferred]) return preferred;
    const order = ['bottom','top','right','left'];
    const fitting = order.filter((side) => fits[side]);
    return (fitting.length ? fitting : order).sort((a,b) => space[b]-space[a])[0];
  }

  function position(view){
    if (!view?.instance.trigger.isConnected || !view.popover.isConnected) return;
    const margin = 8;
    const gap = 10;
    const bounds = usableViewport();
    const rect = view.instance.trigger.getBoundingClientRect();
    const availableWidth = Math.max(1, bounds.width-margin*2);
    const availableHeight = Math.max(1, bounds.height-margin*2);
    const requestedMaxHeight = Number(view.instance.definition.maxHeight || options.maxPopoverHeight);
    const maximumHeight = Math.max(280, Math.min(requestedMaxHeight > 0 ? requestedMaxHeight : 560, 720));
    view.popover.style.maxHeight = `${Math.min(availableHeight, maximumHeight)}px`;
    const popRect = view.popover.getBoundingClientRect();
    const width = Math.min(popRect.width || 390, availableWidth);
    const height = Math.min(popRect.height || 260, availableHeight);
    const side = bestSide(rect, width, height, view.instance.definition.preferredSide, bounds);
    let left = rect.left + rect.width/2 - width/2;
    let top = rect.bottom + gap;
    if (side === 'top') top = rect.top-height-gap;
    if (side === 'left') { left = rect.left-width-gap; top = rect.top+rect.height/2-height/2; }
    if (side === 'right') { left = rect.right+gap; top = rect.top+rect.height/2-height/2; }
    left = Math.max(bounds.left+margin, Math.min(left, bounds.right-width-margin));
    top = Math.max(bounds.top+margin, Math.min(top, bounds.bottom-height-margin));
    view.popover.dataset.side = side;
    view.popover.dataset.viewportTop = String(Math.round(bounds.top));
    view.popover.style.left = `${Math.round(left)}px`;
    view.popover.style.top = `${Math.round(top)}px`;
    view.popover.style.setProperty('--fm-insight-arrow-x', `${Math.max(15, Math.min(width-15, rect.left+rect.width/2-left))}px`);
    view.popover.style.setProperty('--fm-insight-arrow-y', `${Math.max(15, Math.min(height-15, rect.top+rect.height/2-top))}px`);
  }

  function open(instance){
    if (!instance.preview && !settings.enabled) return false;
    close({ returnFocus:false });
    active = buildPopover(instance);
    instance.trigger.setAttribute('aria-expanded', 'true');
    position(active);
    requestAnimationFrame(() => active?.popover.classList.add('open'));
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    window.addEventListener('fm:platform-topbar-visibility', onViewport);
    if (typeof ResizeObserver === 'function') {
      active.chromeResizeObserver = new ResizeObserver(onViewport);
      topChromeElements().forEach((element) => active?.chromeResizeObserver?.observe(element));
    }
    return true;
  }

  function close({ returnFocus = true } = {}){
    if (!active) return;
    const closing = active;
    active = null;
    closing.resizeObserver?.disconnect?.();
    closing.chromeResizeObserver?.disconnect?.();
    closing.instance.trigger.setAttribute('aria-expanded', 'false');
    closing.popover.classList.remove('open');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('scroll', onViewport, true);
    window.removeEventListener('fm:platform-topbar-visibility', onViewport);
    window.setTimeout(() => closing.popover.remove(), 260);
    if (returnFocus && closing.instance.trigger.isConnected) closing.instance.trigger.focus({ preventScroll:true });
  }

  function onOutside(event){ if (active && !active.popover.contains(event.target) && !active.instance.trigger.contains(event.target)) close({ returnFocus:false }); }
  function onKeydown(event){ if (event.key === 'Escape') close(); }
  function onViewport(){ if (active) position(active); }

  function mountSettings(target, config = {}){
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) throw new Error('FirstMateInsights.mountSettings requires a target element.');
    configure(config);
    host.innerHTML = `<div class="fm-insights-settings"><section class="fm-insights-settings-hero"><div><h3>${(globalThis.PlatformLanguage?.text("insights","m_5430e6902b900e","Insights") ?? "Insights")}</h3><p>${(globalThis.PlatformLanguage?.text("insights","m_164d2262739a4e","Place clear, contextual recommendations beside the settings and tools that need them. Insights stay out of the way until opened and automatically choose the clearest direction on screen.") ?? "Place clear, contextual recommendations beside the settings and tools that need them. Insights stay out of the way until opened and automatically choose the clearest direction on screen.")}</p></div><div class="fm-insights-preview-orbit" data-insights-preview></div></section><div class="fm-insights-settings-grid"><label class="fm-insights-setting"><span class="fm-insights-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("insights","m_cf99b36a994097","Show Insights") ?? "Show Insights")}</strong><span>${(globalThis.PlatformLanguage?.text("insights","m_a48f727d2a1dde","Display recommendation icons throughout FirstMate. Turning this off hides every insight without changing its content.") ?? "Display recommendation icons throughout FirstMate. Turning this off hides every insight without changing its content.")}</span></span><span class="fm-insights-switch"><input type="checkbox" data-insights-enabled><span></span></span></label><label class="fm-insights-setting"><span class="fm-insights-setting-copy"><strong>${(globalThis.PlatformLanguage?.text("insights","m_8edb1954aa90fe","Add the Insights agent") ?? "Add the Insights agent")}</strong><span>${(globalThis.PlatformLanguage?.text("insights","m_49d657042fa263","Add a compact reply box so your team can ask follow-up questions inside each insight.") ?? "Add a compact reply box so your team can ask follow-up questions inside each insight.")}</span></span><span class="fm-insights-switch"><input type="checkbox" data-insights-agent><span></span></span></label></div><div class="fm-insights-settings-status" role="status" data-insights-status></div></div>`;
    const enabled = host.querySelector('[data-insights-enabled]');
    const agent = host.querySelector('[data-insights-agent]');
    const status = host.querySelector('[data-insights-status]');
    let preview = mount(host.querySelector('[data-insights-preview]'), {
      id:'insights_settings_preview',
      title:(globalThis.PlatformLanguage?.text("insights","m_6d0bed8ebd74a7","A well-placed recommendation") ?? "A well-placed recommendation"),
      body:'Insights give your team practical guidance exactly where a decision is being made. This preview also demonstrates the optional inline agent conversation.',
      developerContext:'This is the customer-facing Insights settings preview. Explain how contextual recommendations help a team make confident choices in FirstMate.',
      preview:true,
      size:42
    });
    const draw = () => {
      enabled.checked = settings.enabled;
      agent.checked = settings.agent_enabled;
      agent.disabled = !settings.enabled;
    };
    const save = async () => {
      status.textContent = (globalThis.PlatformLanguage?.text("insights","m_ea600c018fb36c","Saving…") ?? "Saving…");
      try {
        await setSettings({ enabled:enabled.checked, agent_enabled:agent.checked && enabled.checked }, { persist:true });
        status.textContent = (globalThis.PlatformLanguage?.text("insights","m_4bb4688766e904","Saved") ?? "Saved");
        root.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("insights","m_7863a9cab81c41","Insights updated") ?? "Insights updated"), (globalThis.PlatformLanguage?.text("insights","m_b6eb7fd836174e","Your Insights preferences were saved.") ?? "Your Insights preferences were saved."), true);
      } catch (error) {
        status.textContent = clean(error?.message) || 'Could not save Insights settings.';
        draw();
      }
      window.setTimeout(() => { if (status.textContent === (globalThis.PlatformLanguage?.text("insights","m_4bb4688766e904","Saved") ?? "Saved")) status.textContent = ''; }, 1800);
    };
    enabled.addEventListener('change', () => {
      if (!enabled.checked) agent.checked = false;
      agent.disabled = !enabled.checked;
      void save();
    });
    agent.addEventListener('change', () => void save());
    loadPreferences().then(draw).catch(draw);
    draw();
    return { destroy(){ preview?.destroy?.(); host.innerHTML = ''; }, preview };
  }

  function scan(scope = document){
    const mounted = [];
    scope.querySelectorAll('[data-firstmate-insight]').forEach((host) => {
      if (host.dataset.firstmateInsightMounted === 'true') return;
      const id = clean(host.dataset.firstmateInsight);
      if (!definitions.has(id)) return;
      host.dataset.firstmateInsightMounted = 'true';
      mounted.push(mount(host, id));
    });
    return mounted;
  }

  const api = {
    version:1,
    configure,
    register,
    create,
    mount,
    scan,
    open(value){
      const instance = value?.trigger
        ? value
        : Array.from(instances).find((candidate) => candidate.definition.id === clean(value));
      return instance ? open(instance) : false;
    },
    close,
    mountSettings,
    loadPreferences,
    savePreferences,
    setSettings,
    getSettings(){ return { ...settings }; },
    getDefinition(id){ return definitions.get(clean(id)) || null; },
    clearSession(id){ sessions.delete(clean(id)); }
  };

  root.FirstMateInsights = api;
  configure({ loadPreferences:true });
})(window);
