/* public/libraries/tab-guides/tab-guides.js
 * Tab pills, first-open tab tutorials and the organization's project tab order
 * (docs/architecture/project-tab-guides.md).
 *
 * - Pills and order are organization data, `project_tabs` on the app-flag state:
 *   { order: [<app id>, ...], pills: { <app id>: 'new' | 'coming_soon' } }.
 *   A "New" pill clears for a person the first time they open the tab
 *   (`seen_tabs` on /me/preferences); "Coming soon" stays.
 * - A tab declares a tutorial with registerTutorial(), or with `tutorial` on its
 *   manifest entry. It plays the first time the person opens the tab, is
 *   remembered in `seen_tutorials`, and replays from the tab's help button.
 *
 * Example (no tab ships with a tutorial yet):
 *
 *   window.FirstMateTabGuides?.registerTutorial({
 *     id: 'project.photos.basics',          // change the id to play it again for everyone
 *     tab: 'project.photos',                // the tab's app id
 *     steps: [
 *       { target: '[data-panel="photos"] .pf-upload', placement: 'bottom',
 *         title: PlatformLanguage.text('photos', 'tut_upload_title', 'Add photos'),
 *         text: PlatformLanguage.text('photos', 'tut_upload_text', 'Drop photos here or tap to take one.') }
 *     ]
 *   });
 *
 * Nothing here decides whether someone has a tab: that is App experience.
 */
(function(root){
  'use strict';
  if (root.FirstMateTabGuides) return;

  const SEEN_TABS = 'seen_tabs';
  const SEEN_TUTORIALS = 'seen_tutorials';
  const ID_PATTERN = /^[a-z0-9][a-z0-9._:@-]{0,119}$/;
  const TUTORIAL_VERSION = '20261024-tab-tutorials';
  const scriptSrc = root.document?.currentScript?.src || '';
  const tutorials = new Map();
  const local = { [SEEN_TABS]: new Set(), [SEEN_TUTORIALS]: new Set() };
  let saveChain = Promise.resolve();
  let enginePromise = null;
  let playing = null;
  const pendingTimers = new Set();

  const clean = (value) => String(value ?? '').trim();
  const lower = (value) => clean(value).toLowerCase();
  const text = (key, fallback) => root.PlatformLanguage?.text?.('tab-guides', key, fallback) ?? fallback;

  const css = `
    .pv-tab-badge.pv-tab-badge--new{background:#e8f5ee;color:#0f6b3a;border-color:#9bd3b3}
    .pv-tab-badge.pv-tab-badge--coming_soon{background:#fff0cb;color:#794c00;border-color:#f2ca72}
    .icon-only .pv-tab-badge--new,
    .r-overlay.entitlement-tab-icons .r-tab .pv-tab-badge--new,
    .r-overlay.mobile-info-navigation:not(.mobile-order) .r-tab .pv-tab-badge--new,
    .r-overlay.window-managed .r-header-icons .r-tab .pv-tab-badge--new{font-size:0!important;width:8px;height:8px;min-width:8px;padding:0;margin-left:-4px;align-self:flex-start;margin-top:-2px;background:#16a34a;border:2px solid #fff;box-sizing:content-box}
    .fm-tab-help{position:absolute;left:12px;bottom:12px;z-index:40;width:30px;height:30px;border-radius:50%;border:1px solid rgba(15,23,42,.14);background:rgba(255,255,255,.94);color:#475467;display:inline-flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;box-shadow:0 6px 18px rgba(15,23,42,.12)}
    .fm-tab-help:hover{color:#101828;background:#fff}
    .fm-tab-help:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    @media(max-width:480px){.pv-tab-badge.pv-tab-badge--new{font-size:8px!important;padding:2px 5px;margin-left:3px}.fm-tab-help{left:10px;bottom:10px}}
  `;
  function injectStyles(){
    if (root.Portal?.util?.injectCSS) return root.Portal.util.injectCSS('tab-guides', css);
    const document = root.document;
    if (!document?.head || document.getElementById('tab-guides-css')) return;
    const style = document.createElement('style');
    style.id = 'tab-guides-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Organization data: the order and pills of project tabs.
  function settings(){
    const api = root.PlatformAPI?.appFlags;
    const value = api?.projectTabs?.() || api?.current?.()?.project_tabs || {};
    return {
      order: (Array.isArray(value.order) ? value.order : []).map(lower).filter(Boolean),
      pills: value.pills && typeof value.pills === 'object' && !Array.isArray(value.pills) ? value.pills : {}
    };
  }

  // Personal: what this person has opened and played, kept in their preferences.
  function identity(){ return root.Portal?.currentUser?.identity || null; }
  function seen(key){
    const saved = identity()?.preferences?.[key];
    return new Set([...(Array.isArray(saved) ? saved.map(lower) : []), ...local[key]]);
  }
  function hasSeen(key, id){ return seen(key).has(lower(id)); }
  function writeLocal(key, values){
    const person = identity();
    if (person) person.preferences = { ...(person.preferences || {}), [key]: [...values] };
  }
  function remember(key, id){
    const value = lower(id);
    if (!ID_PATTERN.test(value) || hasSeen(key, value)) return Promise.resolve(false);
    local[key].add(value);
    writeLocal(key, seen(key));
    root.dispatchEvent?.(new CustomEvent('fm:tab-guides:updated', { detail:{ key, id:value } }));
    const save = saveChain.catch(() => null).then(async () => {
      const api = root.PlatformAPI?.preferences;
      if (!api?.patch) return true;
      // Another device may have added to the list since this page loaded.
      const fresh = await api.get?.().catch(() => null);
      const merged = new Set([...(Array.isArray(fresh?.preferences?.[key]) ? fresh.preferences[key].map(lower) : []), ...seen(key)]);
      const result = await api.patch({ [key]: [...merged] });
      const saved = result?.preferences?.[key];
      writeLocal(key, new Set([...(Array.isArray(saved) ? saved.map(lower) : merged), ...local[key]]));
      return true;
    });
    saveChain = save.catch((error) => {
      // Stays cleared on this page; the next load shows it again.
      console.warn('Could not save that this tab was opened.', error);
      return false;
    });
    return saveChain;
  }

  function pill(appId){
    const id = lower(appId);
    const kind = lower(settings().pills[id]).replace(/[\s-]+/g, '_');
    if (kind === 'new') return hasSeen(SEEN_TABS, id) ? null : { kind:'new', label:text('tg_pill_new', 'New') };
    if (kind === 'coming_soon') return { kind:'coming_soon', label:text('tg_pill_coming_soon', 'Coming soon') };
    return null;
  }

  // Listed tabs first, in the listed order; the rest keep their order after them.
  function order(items = [], idOf = (item) => item?.appId || item?.id){
    const listed = settings().order;
    if (!listed.length) return [...items];
    const rank = new Map(listed.map((id, index) => [id, index]));
    return items
      .map((item, index) => ({ item, index, rank: rank.has(lower(idOf(item))) ? rank.get(lower(idOf(item))) : listed.length }))
      .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
      .map((entry) => entry.item);
  }

  function normalizeTutorial(definition = {}, fallbackTab = ''){
    const tab = lower(definition.tab || definition.appId || fallbackTab);
    const id = lower(definition.id || tab);
    const steps = (Array.isArray(definition.steps) ? definition.steps : [])
      .map((step) => ({
        selector: clean(step?.target || step?.selector),
        title: clean(step?.title),
        text: clean(step?.text),
        pos: ['top', 'bottom', 'left', 'right'].includes(lower(step?.placement || step?.pos)) ? lower(step.placement || step.pos) : 'bottom'
      }))
      .filter((step) => step.selector);
    if (!ID_PATTERN.test(id) || !tab || !steps.length) return null;
    return { id, tab, title: clean(definition.title), steps };
  }
  function registerTutorial(definition = {}){
    const tutorial = normalizeTutorial(definition);
    if (!tutorial) throw new Error('A tab tutorial needs an id, the tab app id and at least one step with a target.');
    if (tutorials.has(tutorial.id)) throw new Error('Duplicate tab tutorial: ' + tutorial.id);
    tutorials.set(tutorial.id, tutorial);
    return tutorial;
  }
  function tutorialFor(appIdOrTutorialId){
    const id = lower(appIdOrTutorialId);
    if (tutorials.has(id)) return tutorials.get(id);
    for (const tutorial of tutorials.values()) if (tutorial.tab === id) return tutorial;
    const declared = root.FirstMateEmbeddableApps?.getApp?.(id)?.tutorial;
    return declared ? normalizeTutorial(declared, id) : null;
  }

  // The overlay engine (apps/tutorial/app.js) loads the first time a tutorial plays.
  function engine(){
    const ready = root.Portal?.modules?.tutorial;
    if (ready?.run) return Promise.resolve(ready);
    if (enginePromise) return enginePromise;
    enginePromise = new Promise((resolve, reject) => {
      const document = root.document;
      if (!document || !root.Portal) return reject(new Error('The tutorial engine needs the portal.'));
      const base = scriptSrc ? new URL('../apps/tutorial/app.js', scriptSrc) : new URL('../libraries/apps/tutorial/app.js', document.baseURI);
      base.searchParams.set('v', TUTORIAL_VERSION);
      const script = document.createElement('script');
      script.src = base.href;
      script.onload = () => root.Portal?.modules?.tutorial?.run ? resolve(root.Portal.modules.tutorial) : reject(new Error('The tutorial engine did not start.'));
      script.onerror = () => reject(new Error('The tutorial engine could not load.'));
      document.head.appendChild(script);
    }).catch((error) => { enginePromise = null; throw error; });
    return enginePromise;
  }

  async function play(appIdOrTutorialId, options = {}){
    const tutorial = tutorialFor(appIdOrTutorialId);
    if (!tutorial || playing) return false;
    if (!options.force && hasSeen(SEEN_TUTORIALS, tutorial.id)) return false;
    playing = tutorial.id;
    try {
      const tour = await engine();
      return await new Promise((resolve) => {
        tour.run(tutorial.steps, { onEnd: ({ shown }) => {
          playing = null;
          // Seen once any step showed, whether finished or closed early.
          if (shown > 0) remember(SEEN_TUTORIALS, tutorial.id);
          resolve(shown > 0);
        } });
      });
    } catch (error) {
      playing = null;
      console.warn('Tab tutorial failed to play.', error);
      return false;
    }
  }

  function syncHelp(container, tabId, appId){
    if (!container?.querySelector) return;
    const tutorial = tutorialFor(appId);
    let button = container.querySelector(':scope > .fm-tab-help');
    if (!tutorial) { button?.remove(); return; }
    if (!button) {
      button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'fm-tab-help';
      button.innerHTML = '<i class="fas fa-circle-question" aria-hidden="true"></i>';
      button.addEventListener('click', () => play(button.dataset.tutorial, { force:true }));
      container.appendChild(button);
    }
    const label = text('tg_replay_tutorial', 'Show me around this tab');
    button.dataset.tab = clean(tabId);
    button.dataset.tutorial = tutorial.id;
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  /**
   * Called by a tab host whenever a tab becomes the active one. Clears its "New"
   * pill (returns true so the host redraws its tabs), keeps the help button in
   * step and plays the tab's tutorial the first time. isActive() is asked again
   * before the tutorial starts.
   */
  function opened({ appId, tabId = '', container = null, isActive = () => true, delay = 700 } = {}){
    const id = lower(appId);
    if (!id) return false;
    injectStyles();
    syncHelp(container, tabId, id);
    const tutorial = tutorialFor(id);
    if (tutorial && !hasSeen(SEEN_TUTORIALS, tutorial.id) && !playing) {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (isActive()) play(tutorial.id);
      }, delay);
      pendingTimers.add(timer);
    }
    if (lower(settings().pills[id]) === 'new' && !hasSeen(SEEN_TABS, id)) {
      remember(SEEN_TABS, id);
      return true;
    }
    return false;
  }

  injectStyles();
  root.FirstMateTabGuides = {
    settings,
    order,
    pill,
    opened,
    registerTutorial,
    tutorialFor,
    play,
    replay: (appIdOrTutorialId) => play(appIdOrTutorialId, { force:true }),
    hasSeenTab: (appId) => hasSeen(SEEN_TABS, appId),
    hasSeenTutorial: (id) => hasSeen(SEEN_TUTORIALS, id),
    tutorials: () => [...tutorials.values()]
  };
})(window);
