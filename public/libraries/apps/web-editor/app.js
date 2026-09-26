/* public/libraries/apps/web-editor/app.js
 * Web Editor — the portal tab where org admins build and host websites and
 * custom customer-portal pages on the shared document engine.
 *
 * Views:
 *   - Site list: every site the org owns (public sites + the blessed
 *     customer-portal site) with live URLs.
 *   - Site view: page tiles (mini static previews) or a management list with
 *     nav/enabled/home toggles; site settings drawer.
 *   - Page editor: FMDocEditor ("website" profile) over the page draft with
 *     autosave, Draft/Live preview, device toggle, publish + version history,
 *     and a faithful customer-portal chrome preview for portal-site pages.
 *
 * Registered as runtime app id "portal.web_editor" (portalTabId "web_editor",
 * manifest-declared). Contracts: docs/web-builder-spec.md §7.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime || !runtime.registerApp) return;

  const SCRIPT_URL = (document.currentScript && document.currentScript.src) || '';

  // ------------------------------------------------------------- utilities
  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }
  const esc = (value) => runtime.escapeHtml
    ? runtime.escapeHtml(value)
    : String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  function clone(value){
    try { return structuredClone(value); } catch (e) { return JSON.parse(JSON.stringify(value ?? null)); }
  }
  function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function arrayValue(value){ return Array.isArray(value) ? value : []; }
  function numberValue(...values){
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }
  function showToast(title, message, ok = true){
    (window.Portal?.ui?.showToast || (() => {}))(title, message, ok);
  }
  function errorMessage(error, fallback){
    return firstText(error?.data?.message, error?.data?.error, error?.message, fallback, 'Something went wrong.');
  }
  function formatDate(value){
    const time = new Date(value || 0).getTime();
    if (!time) return '';
    return new Date(time).toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function timeAgo(value){
    const time = new Date(value || 0).getTime();
    if (!time) return '';
    const diff = Date.now() - time;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return new Date(time).toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function slugify(value){
    return cleanText(value).toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }
  function isViewDefinition(definition){
    const def = objectValue(definition);
    return cleanText(def.kind) === 'view' || !!def.root || arrayValue(def.pages).length > 0;
  }

  const PT_TO_PX = 96 / 72;

  function ensureStyles(){
    if (document.getElementById('fmwe-web-editor-css')) return;
    const link = document.createElement('link');
    link.id = 'fmwe-web-editor-css';
    link.rel = 'stylesheet';
    try {
      const href = new URL('web-editor.css', SCRIPT_URL || window.location.href);
      if (SCRIPT_URL.includes('?')) href.search = SCRIPT_URL.slice(SCRIPT_URL.indexOf('?'));
      link.href = href.toString();
    } catch (e) {
      link.href = '/libraries/apps/web-editor/web-editor.css';
    }
    document.head.appendChild(link);
  }

  // -------------------------------------------------- color / branding kit
  function parseCssColor(value){
    const text = cleanText(value);
    if (!text) return null;
    let m = text.match(/^#([0-9a-f]{3})$/i);
    if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16) };
    m = text.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
    m = text.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i);
    if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
    return null;
  }
  function relativeLuminance(r, g, b){
    const channels = [r / 255, g / 255, b / 255].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }
  function readableOnColor(color){
    const rgb = parseCssColor(color);
    if (!rgb) return '#fff';
    return relativeLuminance(rgb.r, rgb.g, rgb.b) > 0.40 ? '#111827' : '#fff';
  }
  function orgBranding(){
    return objectValue(window.Portal?.cfg?.branding || window.__APP?.orgBranding);
  }
  function brandPrimary(){
    const branding = orgBranding();
    const colors = objectValue(branding.colors);
    return firstText(colors.primary, branding.primary, colors.brand, branding.brand, colors.accent, branding.accent, '#2563eb');
  }
  function syncOnPrimaryVar(el){
    if (!el) return;
    try {
      const styles = getComputedStyle(el);
      const primary = firstText(styles.getPropertyValue('--primary'), brandPrimary(), '#d93025');
      el.style.setProperty('--fmwe-on-primary', readableOnColor(primary));
    } catch (e) { /* CSS #fff fallback */ }
  }

  // --------------------------------------------------------------- modals
  function openModal(contentHtml, options = {}){
    const back = document.createElement('div');
    back.className = 'fmwe-modal-back';
    back.innerHTML = `<div class="fmwe-modal ${String(esc(options.className || ''))}" role="dialog" aria-modal="true">${String(contentHtml)}<button type="button" class="fmwe-modal-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>`;
    const close = () => { back.remove(); options.onClose?.(); };
    back.querySelector('.fmwe-modal-close').addEventListener('click', close);
    back.addEventListener('mousedown', (event) => { if (event.target === back) close(); });
    document.body.appendChild(back);
    syncOnPrimaryVar(back);
    return { el: back, body: back.querySelector('.fmwe-modal'), close };
  }

  function confirmDialog(message, options = {}){
    return new Promise((resolve) => {
      const modal = openModal(`
        <h2><i class="fas ${String(esc(options.icon || 'fa-circle-question'))}"></i> ${String(esc(options.title || (globalThis.PlatformLanguage?.text("web-editor","m_63c86c5bf4a1b7","Are you sure?") ?? "Are you sure?")))}</h2>
        <p class="hint" style="margin-top:0">${String(esc(message))}</p>
        <div class="fmwe-modal-foot">
          <button type="button" class="fmwe-btn" data-cd-cancel>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
          <button type="button" class="fmwe-btn ${String(options.danger ? 'danger' : 'primary')}" data-cd-ok>${String(esc(options.confirmLabel || 'Confirm'))}</button>
        </div>`, { onClose: () => resolve(false) });
      modal.body.querySelector('[data-cd-cancel]').addEventListener('click', () => modal.close());
      modal.body.querySelector('[data-cd-ok]').addEventListener('click', () => {
        resolve(true);
        modal.el.remove(); // bypass close() so onClose's resolve(false) never fires
      });
    });
  }

  async function copyText(text){
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const holder = document.createElement('textarea');
        holder.value = text;
        holder.style.position = 'fixed';
        holder.style.opacity = '0';
        document.body.appendChild(holder);
        holder.select();
        document.execCommand('copy');
        holder.remove();
        return true;
      } catch (err) { return false; }
    }
  }

  // ---------------------------------------------- customer-portal chrome CSS
  // The portal-frame preview reuses the real customer_portal.css so custom
  // pages preview inside faithful chrome. The stylesheet has global :root and
  // body rules, so we fetch it once and rescope those two selectors to the
  // preview container before injecting.
  let cpCssPromise = null;
  function ensurePortalChromeCss(){
    if (document.getElementById('fmwe-cp-css')) return Promise.resolve();
    if (cpCssPromise) return cpCssPromise;
    let href = '/customer_portal/customer_portal.css';
    try { href = new URL('../../../customer_portal/customer_portal.css', SCRIPT_URL || window.location.href).toString(); } catch (e) {}
    cpCssPromise = fetch(href, { credentials: 'omit' })
      .then((res) => {
        if (!res.ok) return '';
        const type = cleanText(res.headers.get('content-type')).toLowerCase();
        if (type && !type.includes('css')) return '';
        return res.text();
      })
      .then((css) => {
        // Guard against HTML fallback pages served with a 200 status.
        if (!css || /^\s*</.test(css) || document.getElementById('fmwe-cp-css')) return;
        const scoped = css
          .replace(/:root\s*\{/g, '.fmwe-cp-scope {')
          .replace(/(^|\})(\s*)body(\s*,|\s*\{)/g, '$1$2.fmwe-cp-scope$3');
        const style = document.createElement('style');
        style.id = 'fmwe-cp-css';
        style.textContent = scoped;
        document.head.appendChild(style);
      })
      .catch(() => {});
    return cpCssPromise;
  }
  function portalBrandingStyle(){
    const branding = orgBranding();
    const colors = objectValue(branding.colors);
    const primary = brandPrimary();
    const rgb = parseCssColor(primary) || { r: 37, g: 99, b: 235 };
    const secondary = firstText(colors.secondary, branding.secondary, '#111111');
    const accent = firstText(colors.accent, branding.accent, primary);
    return [
      `--cp-primary:${primary}`,
      `--cp-primary-rgb:${rgb.r}, ${rgb.g}, ${rgb.b}`,
      `--cp-primary-readable:${primary}`,
      `--cp-on-primary:${readableOnColor(primary)}`,
      `--cp-secondary:${secondary}`,
      `--cp-accent:${accent}`
    ].join(';');
  }
  function portalLogoHtml(orgName){
    const branding = orgBranding();
    const logo = firstText(branding.logo_url, branding.logoUrl, typeof branding.logo === 'string' ? branding.logo : '', objectValue(branding.logo).url);
    if (logo && /^(https?:\/\/|\/|data:)/i.test(logo)) {
      return `<img class="cp-logo" src="${esc(logo)}" alt="${esc(orgName || 'Company logo')}">`;
    }
    return `<div class="cp-logo-fallback">${esc(cleanText(orgName).slice(0, 1).toUpperCase() || 'C')}</div>`;
  }

  const PORTAL_BUILTIN_TABS = ['Summary', 'Schedule', 'Photos', 'Proposals', 'Payments'];

  // =========================================================================
  function mountWebEditor(context = {}){
    ensureStyles();
    const root = context.roots?.main || context.panelRoot || context.root;
    if (!root) return { destroy(){} };

    const host = context.host || {};
    const state = {
      destroyed: false,
      active: true,
      sidebarCompactRelease: null,
      chromeResizeObserver: null,
      view: 'sites',                 // 'sites' | 'site' | 'editor' | 'domains'
      // site list
      sites: null,
      sitesLoading: false,
      sitesError: null,
      // site view
      siteId: '',
      site: null,
      pages: [],
      systemPages: [],
      siteLoading: false,
      siteError: null,
      siteViewMode: localStorage.getItem('fm_web_editor_view') === 'list' ? 'list' : 'grid',
      domainsHandle: null,
      thumbHandles: [],
      // editor
      pageId: '',
      page: null,
      draftDefinition: null,
      revision: null,
      resolveInfo: null,
      catalog: null,
      catalogSiteId: '',
      editorHandle: null,
      webAgent: null,
      liveHandle: null,
      editorHeader: null,
      editorLoading: false,
      editorError: null,
      editorMode: 'draft',           // editing uses Visual / Preview in FMDocEditor
      device: 'desktop',             // 'desktop' | 'mobile'
      siteChromePreview: {
        header: { visible: true, pageId: '' },
        footer: { visible: true, pageId: '' }
      },
      siteChromeHandles: [],
      siteChromeRenderToken: 0,
      siteChromeResizeObserver: null,
      siteChromeCanvasWidth: 0,
      portalFrame: false,
      saveState: 'saved',            // 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
      saveTimer: 0,
      saving: false,
      pendingSave: false,
      savedSinceLoad: false,
      historyOpen: false,
      versions: null,
      versionsLoading: false,
      // Canva-style editor chrome (rail + slide-out panel + bottom bar).
      // Lives on state so it survives renderEditor() re-renders.
      chromeTab: '',                 // '' closed | templates|elements|media|text|brand|markup|qr
      chromeSearch: {},              // per-tab search text
      elementGroupsCollapsed: null,  // Set of collapsed Elements group ids (persisted)
      uploadsSubtab: 'images',
      uploadsList: null,
      uploadsLoading: false,
      uploadsError: null,
      // media panel: project browsing
      mediaProjects: null,           // cached projects.list result [{id,name}]
      mediaProjectsLoading: false,
      mediaProject: null,            // { id, name } while browsing a project's photos
      mediaProjectPhotos: null,
      mediaProjectPhotosLoading: false,
      // brand kit (real org branding, loaded like settings/company.js)
      brandKit: null,                // { branding, logo, media } cache
      brandKitLoading: false,
      // section-management chrome
      sectionChromeId: '',           // selected root-section node id ('' = hidden)
      sectionPopover: '',            // '' | 'edit' | 'position'
      dragGhost: null,
      pagesStripOpen: localStorage.getItem('fm_webeditor_pages_strip') !== 'closed',
      notesOpen: false,
      notesTimer: 0,
      markupSession: null,           // { instance, overlay, tool, color, nodeId, timer, pendingItems }
      markupColor: '#d93025',
      chromeThumbHandles: [],
      zoomTimer: 0
    };

    const orgId = () => firstText(context.orgId, window.Portal?.cfg?.userOrgId, window.__APP?.userOrgId, window.__APP?.orgId);
    const api = () => window.WebsitesAPI;
    const orgName = () => firstText(window.__APP?.orgName, window.Portal?.cfg?.orgName, 'Your Company');
    const editorTopbarOwner = `web-editor.page.${context.instanceId || 'main'}`;

    function editorHeaderQuery(selector){
      return state.editorHeader?.querySelector?.(selector) || root.querySelector(selector);
    }

    function sizeEditorTitle(input){
      if (!input) return;
      const canvas = sizeEditorTitle.canvas || (sizeEditorTitle.canvas = document.createElement('canvas'));
      const measure = canvas.getContext('2d');
      const style = window.getComputedStyle(input);
      if (measure) measure.font = style.font;
      const value = input.value || input.placeholder || (globalThis.PlatformLanguage?.text("web-editor","m_93c31077edd8ac","Untitled page") ?? "Untitled page");
      const textWidth = measure ? measure.measureText(value).width : value.length * 8;
      const maxWidth = Math.min(340, Math.max(150, window.innerWidth * .3));
      input.style.width = `${Math.max(72, Math.min(maxWidth, Math.ceil(textWidth + 24)))}px`;
    }

    function syncEditorHeaderHost(){
      const header = state.editorHeader;
      const screen = root.querySelector('.fmwe-editor');
      const body = screen?.querySelector('.fmwe-editor-body');
      if (!header || !screen || !body) return;
      const topbar = window.Portal?.topbar;
      const injected = state.active !== false && state.view === 'editor' && topbar?.isVisible?.() && topbar.mountLeft?.(editorTopbarOwner, header);
      header.classList.toggle('platform-topbar-injected', !!injected);
      if (!injected) {
        topbar?.releaseLeft?.(editorTopbarOwner);
        if (header.parentElement !== screen) screen.insertBefore(header, body);
      }
      sizeEditorTitle(header.querySelector('[data-ed-title]'));
    }

    function requestEditorSidebar(){
      if (state.active === false || state.sidebarCompactRelease) return;
      const release = window.Portal?.sidebarMode?.requestCompact?.('web-editor.page-editor');
      if (typeof release === 'function') state.sidebarCompactRelease = release;
    }

    function releaseEditorSidebar(){
      const release = state.sidebarCompactRelease;
      state.sidebarCompactRelease = null;
      try {
        if (release) release();
        else window.Portal?.sidebarMode?.releaseCompact?.('web-editor.page-editor');
      } catch (error) { console.warn('Could not restore the portal sidebar', error); }
    }

    // Route values come from the navigation router, not context.params — the
    // mount context carries the param definitions, not resolved values.
    const routeValue = (key) => {
      const fromNav = cleanText(objectValue(window.Portal?.navigation?.read?.())[key]);
      if (fromNav) return fromNav;
      const fromContext = objectValue(context.params)[key];
      return typeof fromContext === 'string' ? cleanText(fromContext) : '';
    };
    function syncRoute(params){
      try { host.setRoute && host.setRoute(params); } catch (e) {}
    }

    const isPortalSite = (site) => cleanText(objectValue(site || state.site).site_kind) === 'customer_portal';
    const siteKindLabel = (site) => (isPortalSite(site) ? 'Customer Portal' : 'Website');
    const liveSiteUrl = (site) => {
      const key = cleanText(objectValue(site).site_key);
      return key ? `${location.origin}/sites/${key}/` : '';
    };
    function designWidthPx(){
      const pt = numberValue(objectValue(objectValue(state.site).settings).design_width_pt) || 720;
      return pt * PT_TO_PX;
    }
    function themeVarOverrides(){
      return objectValue(objectValue(state.resolveInfo).theme_vars);
    }

    // ------------------------------------------------------------- loading
    async function loadSites(options = {}){
      if (!api()) { state.sitesError = { missing: true }; render(); return; }
      state.sitesLoading = true;
      if (!options.silent) render();
      try {
        let res;
        try {
          res = await api().sites.list(orgId());
        } catch (firstError) {
          // One quiet retry — a single dropped request (server watcher restart,
          // atomic-write read race) shouldn't strand the user on an error panel.
          await new Promise((resolve) => setTimeout(resolve, 1200));
          res = await api().sites.list(orgId());
        }
        state.sites = arrayValue(res.sites || res.items).map(objectValue);
        state.sitesError = null;
      } catch (error) {
        state.sitesError = error;
        state.sites = state.sites || [];
      } finally {
        state.sitesLoading = false;
        if (!state.destroyed && state.view === 'sites') render();
      }
    }

    async function loadSite(siteId, options = {}){
      state.siteLoading = true;
      state.siteError = null;
      if (!options.silent) render();
      try {
        const res = await api().sites.get(orgId(), siteId);
        const site = objectValue(res.site || res);
        state.site = site;
        state.pages = arrayValue(res.pages || site.pages).map(objectValue);
        state.systemPages = arrayValue(res.system_pages || site.system_pages).map(objectValue);
        state.siteError = null;
      } catch (error) {
        state.siteError = error;
      } finally {
        state.siteLoading = false;
        if (!state.destroyed && state.view === 'site') render();
      }
    }

    async function loadCatalog(siteId){
      if (state.catalog && state.catalogSiteId === siteId) return state.catalog;
      try {
        const res = await api().sites.catalog(orgId(), siteId);
        const data = objectValue(res.catalog) && Object.keys(objectValue(res.catalog)).length ? res.catalog : res;
        state.catalog = {
          widgets: arrayValue(data.widgets),
          capabilities: objectValue(data.capabilities),
          fonts: arrayValue(data.fonts),
          lead_forms: arrayValue(data.lead_forms),
          themes: arrayValue(data.themes)
        };
        state.catalogSiteId = siteId;
      } catch (error) {
        console.warn('Websites catalog unavailable', error);
        state.catalog = { widgets: [], fonts: [], lead_forms: [], themes: [], capabilities: {} };
        state.catalogSiteId = siteId;
      }
      return state.catalog;
    }

    function pageById(pageId){
      return state.pages.find((p) => cleanText(p.id) === cleanText(pageId)) || null;
    }
    function mergePage(updated){
      const page = objectValue(updated);
      if (!page.id) return;
      const index = state.pages.findIndex((p) => cleanText(p.id) === cleanText(page.id));
      if (index >= 0) state.pages[index] = { ...state.pages[index], ...page };
    }
    function pageRevision(page){
      return numberValue(objectValue(page).revision, objectValue(page).expected_revision);
    }
    function withRevision(body, revision){
      const rev = numberValue(revision);
      return rev === null ? body : { ...body, expected_revision: rev };
    }

    function siteChromePages(role){
      const candidates = state.pages.filter((page) => cleanText(page.role) === role);
      const selectedId = cleanText(objectValue(state.site)[`${role}_page_id`]);
      const selected = pageById(selectedId);
      if (selected && !candidates.some((page) => cleanText(page.id) === selectedId)) candidates.unshift(selected);
      return candidates;
    }
    function isSiteChromePage(page = state.page){
      const role = cleanText(objectValue(page).role);
      return role === 'header' || role === 'footer';
    }
    function siteChromeEditorUrl(pageId){
      const navigation = window.Portal?.navigation;
      if (!navigation?.urlFor || !cleanText(pageId)) return '';
      const url = navigation.urlFor({
        tab: 'web_editor',
        site: state.siteId,
        page: cleanText(pageId),
        view: '',
        domainSettings: ''
      });
      return url?.href || String(url || '');
    }
    function syncSiteChromePreview(){
      ['header', 'footer'].forEach((role) => {
        const candidates = siteChromePages(role);
        const key = `${role}_page_id`;
        const preview = objectValue(state.siteChromePreview[role]);
        const previewId = cleanText(preview.pageId);
        const siteId = cleanText(objectValue(state.site)[key]);
        const selected = candidates.some((page) => cleanText(page.id) === previewId)
          ? previewId
          : candidates.some((page) => cleanText(page.id) === siteId)
            ? siteId
            : cleanText(objectValue(candidates[0]).id);
        state.siteChromePreview[role] = { visible: preview.visible !== false, pageId: selected };
      });
    }
    function siteChromePreviewSnapshot(){
      // Header/footer definitions are the chrome being authored. Nesting the
      // site's chrome around either file is misleading and can recursively
      // preview the current definition, so these files expose no chrome state.
      if (isPortalSite() || isSiteChromePage()) return {};
      syncSiteChromePreview();
      const snapshot = {};
      ['header', 'footer'].forEach((role) => {
        const preview = objectValue(state.siteChromePreview[role]);
        snapshot[role] = {
          visible: preview.visible !== false,
          pageId: cleanText(preview.pageId),
          options: siteChromePages(role).map((page) => ({ id: cleanText(page.id), title: firstText(page.title, role === 'header' ? 'Header' : 'Footer') }))
        };
      });
      return snapshot;
    }

    function destroySiteChromePreview(){
      state.siteChromeRenderToken += 1;
      try { state.siteChromeResizeObserver?.disconnect?.(); } catch (e) {}
      state.siteChromeResizeObserver = null;
      state.siteChromeCanvasWidth = 0;
      arrayValue(state.siteChromeHandles).forEach((handle) => { try { handle?.destroy?.(); } catch (e) {} });
      state.siteChromeHandles = [];
      root.querySelectorAll('[data-site-chrome-shell]').forEach((node) => node.remove());
      root.querySelectorAll('[data-site-chrome-preview]').forEach((node) => node.remove());
      root.querySelector('.fmde-canvas')?.classList.remove('fmwe-site-chrome-previewing');
    }

    async function ensureSiteChromePage(pageId){
      let page = pageById(pageId);
      if (objectValue(objectValue(page).draft).definition) return page;
      const response = await api().pages.get(orgId(), state.siteId, pageId);
      page = objectValue(response.page || response);
      mergePage(page);
      return page;
    }

    async function renderSiteChromePreview(){
      const token = ++state.siteChromeRenderToken;
      arrayValue(state.siteChromeHandles).forEach((handle) => { try { handle?.destroy?.(); } catch (e) {} });
      state.siteChromeHandles = [];
      root.querySelectorAll('[data-site-chrome-shell]').forEach((node) => node.remove());
      root.querySelectorAll('[data-site-chrome-preview]').forEach((node) => node.remove());
      const canvas = root.querySelector('.fmde-canvas');
      const stage = canvas?.querySelector(':scope > .fmde-stage');
      const mainPage = stage?.querySelector('.fmdoc-page');
      const snapshot = siteChromePreviewSnapshot();
      if (!canvas || !stage || !mainPage || isPortalSite() || isSiteChromePage() || !window.FMDocRenderer?.render) {
        canvas?.classList.remove('fmwe-site-chrome-previewing');
        return;
      }
      canvas.classList.add('fmwe-site-chrome-previewing');
      // Header, footer, and body share one responsive surface. Visual editing
      // keeps breathing room for handles; Preview is the real site viewport
      // and therefore has no synthetic horizontal gutter.
      const mobileViewport = state.device === 'mobile';
      const previewMode = state.editorHandle?.getMode?.() === 'preview';
      const fullBleedViewport = mobileViewport || previewMode;
      const pageWidth = Math.max(120, canvas.clientWidth - (fullBleedViewport ? 0 : 96));
      const scale = Math.min(1, pageWidth / designWidthPx());
      state.siteChromeCanvasWidth = canvas.clientWidth;
      if (!state.siteChromeResizeObserver && typeof ResizeObserver === 'function') {
        state.siteChromeResizeObserver = new ResizeObserver((entries) => {
          const width = entries?.[0]?.contentRect?.width || canvas.clientWidth;
          if (state.destroyed || Math.abs(width - state.siteChromeCanvasWidth) < 1) return;
          state.siteChromeCanvasWidth = width;
          scheduleSiteChromePreview();
        });
        state.siteChromeResizeObserver.observe(canvas);
      }
      for (const role of ['header', 'footer']) {
        const preview = objectValue(snapshot[role]);
        if (preview.visible === false || !preview.pageId) continue;
        try {
          const page = await ensureSiteChromePage(preview.pageId);
          if (token !== state.siteChromeRenderToken || !stage.isConnected) return;
          const definition = clone(objectValue(objectValue(page).draft).definition);
          if (!Object.keys(definition).length) continue;
          const shell = document.createElement('div');
          shell.className = `fmwe-site-chrome-shell fmwe-site-${role}-shell`;
          shell.setAttribute('data-site-chrome-shell', role);
          shell.setAttribute('tabindex', '0');
          shell.setAttribute('role', 'group');
          shell.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_39fb206115d0c7",`Select ${v0} preview`,{v0}) ?? `Select ${v0} preview`)(role));
          shell.style.width = fullBleedViewport ? '100%' : 'calc(100% - 96px)';
          const hostEl = document.createElement('div');
          hostEl.className = `fmwe-site-chrome-preview fmwe-site-${role}-preview`;
          hostEl.setAttribute('data-site-chrome-preview', role);
          hostEl.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_52f99f1fee9f56",`${v0} preview (read only)`,{v0}) ?? `${v0} preview (read only)`)(role === 'header' ? 'Header' : 'Footer'));
          hostEl.inert = true;
          hostEl.style.width = '100%';
          shell.appendChild(hostEl);
          const editorUrl = siteChromeEditorUrl(preview.pageId);
          if (editorUrl) {
            const editLink = document.createElement('a');
            editLink.className = 'fmwe-site-chrome-edit';
            editLink.href = editorUrl;
            editLink.target = '_blank';
            editLink.rel = 'noopener';
            editLink.setAttribute('aria-label', ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_2c0bf568e7c34b",`Edit ${v0} in a new tab`,{v0}) ?? `Edit ${v0} in a new tab`)(role));
            editLink.innerHTML = `<i class="fas fa-pen" aria-hidden="true"></i><span>${((v0) => globalThis.PlatformLanguage?.htmlText("web-editor","m_39b192d8eac13f",`Edit ${v0}`,{v0}) ?? `Edit ${v0}`)(role)}</span>`;
            shell.appendChild(editLink);
          }
          shell.addEventListener('click', (event) => {
            if (event.target.closest?.('.fmwe-site-chrome-edit')) return;
            shell.focus({ preventScroll: true });
          });
          if (role === 'header') canvas.insertBefore(shell, stage);
          else stage.insertAdjacentElement('afterend', shell);
          const handle = window.FMDocRenderer.render(hostEl, {
            document: definition,
            mode: 'static',
            widgetData: {},
            themeContext: { branding: orgBranding(), overrides: themeVarOverrides() },
            mediaUrl: mediaUrlResolver(),
            widgetContext: { resolvePageHref: () => '#', preview: true },
            scale
          });
          handle.setViewSurfaceWidth?.(pageWidth);
          state.siteChromeHandles.push(handle);
        } catch (error) {
          console.warn(`Could not render the ${role} preview`, error);
        }
      }
    }

    function scheduleSiteChromePreview(){
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!state.destroyed && state.view === 'editor' && state.editorMode === 'draft') renderSiteChromePreview();
      }));
    }

    async function updateSiteChromePreview(input = {}){
      const role = input.role === 'footer' ? 'footer' : 'header';
      syncSiteChromePreview();
      const previous = { ...objectValue(state.siteChromePreview[role]) };
      const candidateId = cleanText(input.pageId);
      const validId = siteChromePages(role).some((page) => cleanText(page.id) === candidateId) ? candidateId : previous.pageId;
      state.siteChromePreview[role] = { pageId: validId, visible: input.visible !== false };
      scheduleSiteChromePreview();
      if (!validId || validId === previous.pageId) return objectValue(siteChromePreviewSnapshot()[role]);
      try {
        const response = await api().sites.patch(orgId(), state.siteId, withRevision({ [`${role}_page_id`]: validId }, numberValue(objectValue(state.site).revision)));
        state.site = { ...objectValue(state.site), ...objectValue(response.site || response) };
      } catch (error) {
        state.siteChromePreview[role] = previous;
        scheduleSiteChromePreview();
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, `Could not change the ${role}.`), false);
      }
      return objectValue(siteChromePreviewSnapshot()[role]);
    }

    // ---------------------------------------------------------- navigation
    function gotoSites(){
      releaseEditorSidebar();
      destroyEditor();
      destroyThumbs();
      state.view = 'sites';
      state.siteId = '';
      state.site = null;
      syncRoute({ site: '', page: '', view: '', domainSettings: '' });
      render();
      loadSites({ silent: true });
    }
    function gotoDomains(){
      releaseEditorSidebar();
      destroyEditor();
      destroyThumbs();
      state.view = 'domains';
      state.siteId = '';
      state.pageId = '';
      syncRoute({ site: '', page: '', view: '', domainSettings: 'domains' });
      render();
    }
    function gotoSite(siteId, options = {}){
      releaseEditorSidebar();
      destroyEditor();
      state.view = 'site';
      state.siteId = cleanText(siteId);
      state.pageId = '';
      syncRoute({ site: state.siteId, page: '', view: state.siteViewMode, domainSettings: '' });
      if (!options.keepData || cleanText(objectValue(state.site).id) !== state.siteId) {
        state.site = cleanText(objectValue(state.site).id) === state.siteId ? state.site : null;
        loadSite(state.siteId);
      } else {
        render();
        loadSite(state.siteId, { silent: true });
      }
    }
    function gotoEditor(pageId){
      state.view = 'editor';
      state.pageId = cleanText(pageId);
      syncRoute({ site: state.siteId, page: state.pageId, view: '', domainSettings: '' });
      openEditor();
    }

    // ------------------------------------------------------ render dispatch
    function render(){
      if (state.destroyed) return;
      destroyThumbs();
      if (state.view === 'domains') { renderDomains(); return; }
      if (state.view === 'editor') { renderEditor(); return; }
      if (state.view === 'site') { renderSiteView(); return; }
      renderSiteList();
    }

    function stateHtml(options = {}){
      return `
        <div class="fmwe-state ${options.hero ? 'hero' : ''}">
          ${options.spinner ? '<div class="fmwe-spinner"></div>' : `<i class="fas ${esc(options.icon || 'fa-globe')}"></i>`}
          <strong>${esc(options.title || '')}</strong>
          ${options.message ? `<span>${esc(options.message)}</span>` : ''}
          ${options.retry ? `<button type="button" class="fmwe-btn" data-we-retry><i class="fas fa-rotate-right"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button>` : ''}
          ${options.actionLabel ? `<button type="button" class="fmwe-btn primary" data-we-state-action><i class="fas ${esc(options.actionIcon || 'fa-plus')}"></i> ${esc(options.actionLabel)}</button>` : ''}
        </div>`;
    }

    // ============================================================ SITE LIST
    function renderSiteList(){
      root.innerHTML = `
        <div class="fmwe-shell">
          <header class="fmwe-top">
            <div class="fmwe-top-title">
              <strong><i class="fas fa-globe"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_5493e7e4b3647a"," Web Editor") ?? " Web Editor")}</strong>
              <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_ce8f08fb05b1f0","Build your websites and custom customer-portal pages") ?? "Build your websites and custom customer-portal pages")}</span>
            </div>
            <div class="fmwe-top-actions">
              <button type="button" class="fmwe-btn" data-we-add-domain><i class="fas fa-globe"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_eae8d33522f723"," Domains & Hosting") ?? " Domains & Hosting")}</button>
              <button type="button" class="fmwe-btn primary" data-we-new-site><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_307225fe5b0057"," New website") ?? " New website")}</button>
            </div>
          </header>
          <div class="fmwe-body" data-we-body></div>
        </div>`;
      syncOnPrimaryVar(root.querySelector('.fmwe-shell'));
      root.querySelector('[data-we-new-site]')?.addEventListener('click', () => openNewSiteModal());
      root.querySelector('[data-we-add-domain]')?.addEventListener('click', gotoDomains);
      const body = root.querySelector('[data-we-body]');

      if (state.sitesError?.missing || !api()) {
        body.innerHTML = stateHtml({ icon: 'fa-plug-circle-xmark', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_c31143117e5825","Websites service unavailable") ?? "Websites service unavailable"), message: (globalThis.PlatformLanguage?.htmlText("web-editor","m_0fc57b61368277","The websites API client is not loaded for this session.") ?? "The websites API client is not loaded for this session.") });
        return;
      }
      if (state.sites === null && state.sitesLoading) {
        body.innerHTML = '<div class="fmwe-skel-grid"><div class="fmwe-skel-card"></div><div class="fmwe-skel-card"></div><div class="fmwe-skel-card"></div></div>';
        return;
      }
      if (state.sitesError) {
        body.innerHTML = stateHtml({ icon: 'fa-cloud-bolt', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_075226cfb9e130","Couldn’t load your sites") ?? "Couldn’t load your sites"), message: errorMessage(state.sitesError, ''), retry: true });
        body.querySelector('[data-we-retry]')?.addEventListener('click', () => loadSites());
        return;
      }
      const sites = arrayValue(state.sites).filter((s) => cleanText(s.status) !== 'archived');
      if (!sites.length) {
        body.innerHTML = stateHtml({
          hero: true, icon: 'fa-globe',
          title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_9e989cfc22bd6f","Build your first website") ?? "Build your first website"),
          message: (globalThis.PlatformLanguage?.htmlText("web-editor","m_c0b24cf9b4d0ff","Design pages visually, publish them to a hosted site, and add custom tabs to your customer portal — all from here.") ?? "Design pages visually, publish them to a hosted site, and add custom tabs to your customer portal — all from here."),
          actionLabel: 'New website', actionIcon: 'fa-plus'
        });
        body.querySelector('[data-we-state-action]')?.addEventListener('click', () => openNewSiteModal());
        return;
      }
      // Portal site first is confusing next to marketing sites — keep public
      // sites first, portal site last.
      const ordered = [...sites].sort((a, b) => (isPortalSite(a) ? 1 : 0) - (isPortalSite(b) ? 1 : 0));
      body.innerHTML = `<div class="fmwe-card-grid">${ordered.map((site) => siteCardHtml(site)).join('')}</div>`;
      body.querySelectorAll('[data-site-card]').forEach((card) => {
        const site = ordered.find((s) => cleanText(s.id) === card.dataset.siteCard);
        if (!site) return;
        card.querySelector('[data-site-open]')?.addEventListener('click', () => gotoSite(site.id));
        card.querySelector('[data-site-copy]')?.addEventListener('click', async (event) => {
          event.stopPropagation();
          const ok = await copyText(liveSiteUrl(site));
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), ok ? 'Live site link copied.' : 'Could not copy the link.', ok);
        });
      });
    }

    function renderDomains(){
      root.innerHTML = `
        <div class="fmwe-shell">
          <header class="fmwe-top">
            <button type="button" class="fmwe-plain-back" data-we-back title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_8615f62f7a7921","Back to websites") ?? "Back to websites")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_8615f62f7a7921","Back to websites") ?? "Back to websites")}"><i class="fas fa-arrow-left"></i></button>
            <div class="fmwe-top-title">
              <strong><i class="fas fa-globe"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_eae8d33522f723"," Domains & Hosting") ?? " Domains & Hosting")}</strong>
              <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_362b875c683dfd","Domains, website routing, email, DNS, renewal, and transfer controls") ?? "Domains, website routing, email, DNS, renewal, and transfer controls")}</span>
            </div>
          </header>
          <div class="fmwe-body" data-we-domains></div>
        </div>`;
      syncOnPrimaryVar(root.querySelector('.fmwe-shell'));
      root.querySelector('[data-we-back]')?.addEventListener('click', gotoSites);
      const pane = root.querySelector('[data-we-domains]');
      if (!window.FirstMateDomainsSettings?.mount || !window.DomainsAPI) {
        pane.innerHTML = stateHtml({ icon:'fa-plug-circle-xmark', title:(globalThis.PlatformLanguage?.htmlText("web-editor","m_3bf6302639f497","Domains service unavailable") ?? "Domains service unavailable"), message:(globalThis.PlatformLanguage?.htmlText("web-editor","m_5064d2167004a0","Refresh the portal to load Domains & Hosting.") ?? "Refresh the portal to load Domains & Hosting.") });
        return;
      }
      Promise.resolve(window.FirstMateDomainsSettings.mount({
        pane,
        orgId:orgId(),
        embedded:true,
        onOpenWebsite:(websiteId)=>gotoSite(websiteId)
      })).then((handle)=>{ state.domainsHandle=handle||null; }).catch((error)=>{
        pane.innerHTML=stateHtml({icon:'fa-cloud-bolt',title:(globalThis.PlatformLanguage?.htmlText("web-editor","m_fb0500a556703e","Could not load Domains & Hosting") ?? "Could not load Domains & Hosting"),message:errorMessage(error,'')});
      });
    }

    function siteCardHtml(site){
      const portal = isPortalSite(site);
      const pageCount = numberValue(site.page_count, site.pages_count, arrayValue(site.pages).length) || 0;
      const url = liveSiteUrl(site);
      return `
        <div class="fmwe-site-card" data-site-card="${esc(site.id)}">
          <div class="head" data-site-open>
            <span class="icon"><i class="fas ${portal ? 'fa-id-badge' : 'fa-globe'}"></i></span>
            <div style="min-width:0;flex:1">
              <strong>${esc(firstText(site.name, 'Untitled site'))}</strong>
              <small>
                <span class="fmwe-chip ${portal ? 'portal' : 'website'}">${esc(siteKindLabel(site))}</span>
                <span>${pageCount} ${pageCount === 1 ? 'page' : 'pages'}</span>
              </small>
            </div>
            <span style="color:#98a2b3;font-size:11px;flex:0 0 auto;margin-top:4px"><i class="fas fa-chevron-right"></i></span>
          </div>
          ${portal
            ? `<div class="fmwe-site-note"><i class="fas fa-id-badge"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_cece847693ee99"," Pages appear as tabs in your customer portal") ?? " Pages appear as tabs in your customer portal")}</div>`
            : `<div class="fmwe-site-url">
                <code title="${String(esc(url))}">${String(esc(url.replace(/^https?:\/\//, '')))}</code>
                <button type="button" class="fmwe-icon-btn" data-site-copy title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_cd28b8aa65a947","Copy live link") ?? "Copy live link")}"><i class="fas fa-copy"></i></button>
                <a class="fmwe-icon-btn" href="${String(esc(url))}" target="_blank" rel="noopener" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_2ac59adf8711de","Open live site") ?? "Open live site")}"><i class="fas fa-arrow-up-right-from-square"></i></a>
              </div>`}
        </div>`;
    }

    function openNewSiteModal(){
      const modal = openModal(`
        <h2><i class="fas fa-globe"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_307225fe5b0057"," New website") ?? " New website")}</h2>
        <p class="hint">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_52fb30829acb97","A new public website with a starter home page. It gets its own live URL the moment you publish.") ?? "A new public website with a starter home page. It gets its own live URL the moment you publish.")}</p>
        <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_75c8b2cbb01055","Website name") ?? "Website name")}</span><input type="text" data-ns-name placeholder="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_5374f7febd0f4e","e.g. Main Website") ?? "e.g. Main Website")}" maxlength="80"></label>
        <div class="fmwe-modal-foot">
          <button type="button" class="fmwe-btn primary" data-ns-create><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_9ef9734b18ef66"," Create website") ?? " Create website")}</button>
        </div>`);
      const input = modal.body.querySelector('[data-ns-name]');
      input?.focus();
      const create = async () => {
        const name = firstText(input?.value, 'New Website');
        const button = modal.body.querySelector('[data-ns-create]');
        if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Creating…'; }
        try {
          const res = await api().sites.create(orgId(), { name });
          const site = objectValue(res.site || res);
          modal.close();
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_41233ac28bf7ec",`"${v0}" created.`,{v0}) ?? `"${v0}" created.`)(name), true);
          state.sites = null;
          gotoSite(firstText(site.id));
        } catch (error) {
          if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-plus"></i> Create website'; }
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not create the website.'), false);
        }
      };
      modal.body.querySelector('[data-ns-create]')?.addEventListener('click', create);
      input?.addEventListener('keydown', (event) => { if (event.key === 'Enter') create(); });
    }

    // ============================================================ SITE VIEW
    function renderSiteView(){
      const site = objectValue(state.site);
      const portal = isPortalSite(site);
      root.innerHTML = `
        <div class="fmwe-shell">
          <header class="fmwe-top">
            <button type="button" class="fmwe-icon-btn" data-we-back title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_21b1e372c7ce19","All sites") ?? "All sites")}"><i class="fas fa-chevron-left"></i></button>
            <div class="fmwe-top-title" style="min-width:0">
              <strong style="min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(esc(firstText(site.name, 'Site')))}</span>
                <span class="fmwe-chip ${String(portal ? 'portal' : 'website')}">${String(esc(siteKindLabel(site)))}</span>
              </strong>
              ${String(portal
                ? `<span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_2db04ed62445d8","Published pages appear as tabs in your customer portal") ?? "Published pages appear as tabs in your customer portal")}</span>`
                : (liveSiteUrl(site) ? `<span>${esc(liveSiteUrl(site).replace(/^https?:\/\//, ''))}</span>` : `<span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a9bb69bf4fa53f","Hosted website") ?? "Hosted website")}</span>`))}
            </div>
            <div class="fmwe-top-actions">
              <div class="fmwe-seg" role="tablist">
                <button type="button" class="${String(state.siteViewMode === 'grid' ? 'active' : '')}" data-we-view="grid" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_9ae062c9d0efac","Tile view") ?? "Tile view")}"><i class="fas fa-grip"></i></button>
                <button type="button" class="${String(state.siteViewMode === 'list' ? 'active' : '')}" data-we-view="list" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_d4ab9c9111910c","List view") ?? "List view")}"><i class="fas fa-list"></i></button>
              </div>
              <button type="button" class="fmwe-icon-btn" data-we-settings title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_1b294805a95144","Site settings") ?? "Site settings")}"><i class="fas fa-gear"></i></button>
              <button type="button" class="fmwe-btn primary" data-we-new-page><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_65e8237f1b1836"," New page") ?? " New page")}</button>
            </div>
          </header>
          <div class="fmwe-body" data-we-body></div>
        </div>`;
      syncOnPrimaryVar(root.querySelector('.fmwe-shell'));
      root.querySelector('[data-we-back]')?.addEventListener('click', () => gotoSites());
      root.querySelector('[data-we-settings]')?.addEventListener('click', () => openSiteSettings());
      root.querySelector('[data-we-new-page]')?.addEventListener('click', () => openNewPageModal());
      root.querySelectorAll('[data-we-view]').forEach((btn) => btn.addEventListener('click', () => {
        state.siteViewMode = btn.dataset.weView === 'list' ? 'list' : 'grid';
        localStorage.setItem('fm_web_editor_view', state.siteViewMode);
        syncRoute({ view: state.siteViewMode });
        render();
      }));

      const body = root.querySelector('[data-we-body]');
      if (state.siteLoading && !state.site) {
        body.innerHTML = '<div class="fmwe-skel-grid"><div class="fmwe-skel-card"></div><div class="fmwe-skel-card"></div><div class="fmwe-skel-card"></div><div class="fmwe-skel-card"></div></div>';
        return;
      }
      if (state.siteError && !state.site) {
        body.innerHTML = stateHtml({ icon: 'fa-cloud-bolt', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_b6acd892d01dde","Couldn’t load this site") ?? "Couldn’t load this site"), message: errorMessage(state.siteError, ''), retry: true });
        body.querySelector('[data-we-retry]')?.addEventListener('click', () => loadSite(state.siteId));
        return;
      }
      if (state.siteViewMode === 'list') renderPageList(body);
      else renderPageGrid(body);
    }

    /** One unambiguous status per page — a page is Draft, Hidden or Live,
     *  never a contradictory pairing like "Live" + "Off". */
    function pageStatusChips(page){
      const published = Number(page.published_version || 0) > 0;
      const role = cleanText(page.role) || 'page';
      if (!published) return `<span class="fmwe-chip">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_9ce407c87de615","Draft") ?? "Draft")}</span>`;
      // Chrome pages (header/footer) have no visibility toggle of their own.
      if (role === 'page' && page.enabled === false) {
        const where = isPortalSite() ? 'your customer portal' : 'your live site';
        return ("<span class=\"fmwe-chip off\" title=\"" + ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_de15897b36fc4c",`Published, but currently hidden from ${v0}`,{v0}) ?? `Published, but currently hidden from ${v0}`)(where) + "\">" + (globalThis.PlatformLanguage?.text("web-editor","m_2d72ad0c076a58","Hidden") ?? "Hidden") + "</span>");
      }
      if (page.has_unpublished_changes) return `<span class="fmwe-chip edited">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_51c7ec6147b03c","Live · edited") ?? "Live · edited")}</span>`;
      return `<span class="fmwe-chip live">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_430a0cf632da94","Live") ?? "Live")}</span>`;
    }

    /** Media refs ({media_id}) → displayable URLs for client-side renders
     *  (editor canvas, thumbnails, previews). */
    function mediaUrlResolver(){
      return (mediaRef, variant) => {
        const ref = typeof mediaRef === 'string' ? { media_id: mediaRef } : objectValue(mediaRef);
        if (ref.url) return ref.url;
        if (!window.PlatformAPI?.media?.fileUrl) return '';
        const id = firstText(ref.media_id, ref.id);
        return id ? window.PlatformAPI.media.fileUrl(orgId(), id, variant || ref.variant || 'original') : '';
      };
    }

    function roleIcon(role){
      if (role === 'header') return 'fa-window-maximize';
      if (role === 'footer') return 'fa-window-minimize';
      return '';
    }

    function pageTileHtml(page, options = {}){
      const site = objectValue(state.site);
      const role = cleanText(page.role) || 'page';
      const isHome = cleanText(site.home_page_id) && cleanText(site.home_page_id) === cleanText(page.id);
      const icon = roleIcon(role);
      return `
        <div class="fmwe-page-tile" data-page-tile="${esc(page.id)}" role="button" tabindex="0">
          <div class="fmwe-tile-thumb">
            <div class="fmwe-thumb-fallback"><i class="fas fa-file"></i></div>
            <div class="fmwe-thumb-stage" data-page-thumb="${esc(page.id)}"></div>
          </div>
          <div class="fmwe-tile-info">
            <div class="name">
              ${isHome ? ("<i class=\"fas fa-star\" title=\"" + (globalThis.PlatformLanguage?.htmlText("web-editor","m_8d59e4a1a00432","Home page") ?? "Home page") + "\"></i>") : ''}
              ${icon ? `<i class="fas ${esc(icon)} role-icon"></i>` : ''}
              <span>${esc(firstText(page.title, 'Untitled page'))}</span>
            </div>
            <div class="meta">
              ${pageStatusChips(page)}
              ${cleanText(page.slug) ? `<span class="slug">/${esc(page.slug)}</span>` : ''}
            </div>
          </div>
        </div>`;
    }

    function summaryPage(){
      if (!isPortalSite()) return null;
      const summaryId = cleanText(objectValue(state.site).home_page_id);
      return state.pages.find((page) => cleanText(page.id) === summaryId || cleanText(page.system_key) === 'summary') || null;
    }

    function systemTileHtml(sys){
      const summary = cleanText(sys.id) === 'summary' ? summaryPage() : null;
      return `
        <div class="fmwe-page-tile ${summary ? 'summary-editable' : 'locked'}" ${summary ? `data-page-tile="${esc(summary.id)}" role="button" tabindex="0"` : `data-system-tile="${esc(firstText(sys.id, sys.title))}"`} title="${esc(summary ? 'Customize additional content beneath the required Summary.' : firstText(sys.description, 'Built-in portal page'))}">
          <div class="fmwe-tile-thumb">
            <div class="fmwe-thumb-fallback"><i class="fas ${esc(firstText(sys.icon, 'fa-lock'))}"></i></div>
          </div>
          <div class="fmwe-tile-info">
            <div class="name"><i class="fas ${summary ? 'fa-pen-to-square' : 'fa-lock'} role-icon"></i><span>${esc(firstText(sys.title, 'Portal page'))}</span></div>
            <div class="meta"><span class="fmwe-chip builtin">${summary ? 'Required · customizable' : 'Built-in'}</span></div>
          </div>
        </div>`;
    }

    function chromeRowHtml(){
      const chrome = state.pages.filter((p) => ['header', 'footer'].includes(cleanText(p.role)));
      if (!chrome.length || isPortalSite()) return '';
      return `
        <p class="fmwe-micro-label"><i class="fas fa-table-columns"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_37870bc912b80e"," Site chrome") ?? " Site chrome")}</p>
        <div class="fmwe-tile-grid">${String(chrome.map((p) => pageTileHtml(p)).join(''))}</div>`;
    }

    function renderPageGrid(body){
      const portal = isPortalSite();
      const summary = summaryPage();
      const regular = state.pages.filter((p) => cleanText(p.role) !== 'header' && cleanText(p.role) !== 'footer' && cleanText(p.id) !== cleanText(summary?.id));
      const sections = [];
      if (portal && state.systemPages.length) {
        sections.push(`
          <p class="fmwe-micro-label"><i class="fas fa-id-badge"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_f060cc79fdd795"," Required portal pages ") ?? " Required portal pages ")}<span class="count">${String(state.systemPages.length)}</span></p>
          <div class="fmwe-tile-grid">${String(state.systemPages.map((sys) => systemTileHtml(sys)).join(''))}</div>`);
      }
      sections.push(chromeRowHtml());
      if (!regular.length) {
        sections.push(`
          <p class="fmwe-micro-label"><i class="fas fa-file-lines"></i> ${portal ? 'Custom pages' : 'Pages'}</p>
          ${stateHtml({
            hero: true, icon: 'fa-file-circle-plus',
            title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_89b2a9e024a7f2","Create your first page") ?? "Create your first page"),
            message: portal
              ? 'Custom pages you publish here appear as extra tabs in every customer portal.'
              : 'Pages you publish become part of your live website.',
            actionLabel: 'New page', actionIcon: 'fa-plus'
          })}`);
      } else {
        sections.push(`
          <p class="fmwe-micro-label"><i class="fas fa-file-lines"></i> ${portal ? 'Custom pages' : 'Pages'} <span class="count">${regular.length}</span></p>
          <div class="fmwe-tile-grid">${regular.map((p) => pageTileHtml(p)).join('')}</div>`);
      }
      body.innerHTML = sections.join('');
      body.querySelector('[data-we-state-action]')?.addEventListener('click', () => openNewPageModal());
      wireTiles(body);
      renderThumbnails(body);
    }

    function wireTiles(body){
      body.querySelectorAll('[data-page-tile]').forEach((tile) => {
        const open = () => gotoEditor(tile.dataset.pageTile);
        tile.addEventListener('click', open);
        tile.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      });
      body.querySelectorAll('[data-system-tile]').forEach((tile) => tile.addEventListener('click', () => {
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_83e2d640124d3b","Built-in portal pages are managed by FirstMate.") ?? "Built-in portal pages are managed by FirstMate."), true);
      }));
    }

    function destroyThumbs(){
      state.thumbHandles.forEach((handle) => { try { handle?.destroy?.(); } catch (e) {} });
      state.thumbHandles = [];
    }

    function renderThumbnails(body){
      if (!window.FMDocRenderer?.render) return;
      requestAnimationFrame(() => {
        if (state.destroyed) return;
        body.querySelectorAll('[data-page-thumb]').forEach((stage) => {
          const page = pageById(stage.dataset.pageThumb);
          const definition = objectValue(objectValue(page?.draft).definition);
          if (!isViewDefinition(definition)) return;
          const width = stage.clientWidth || 228;
          const scale = Math.max(0.05, Math.min(1, width / designWidthPx()));
          try {
            const handle = window.FMDocRenderer.render(stage, {
              document: clone(definition),
              mode: 'static',
              widgetData: {},
              widgetContext: { preview: true },
              themeContext: { branding: orgBranding(), overrides: themeVarOverrides() },
              mediaUrl: mediaUrlResolver(),
              scale
            });
            state.thumbHandles.push(handle);
            const fallback = stage.parentElement?.querySelector('.fmwe-thumb-fallback');
            if (fallback) fallback.style.display = 'none';
          } catch (error) {
            /* keep the fallback panel */
          }
        });
      });
    }

    function renderPageList(body){
      const portal = isPortalSite();
      const summary = summaryPage();
      const regular = state.pages.filter((p) => cleanText(p.role) !== 'header' && cleanText(p.role) !== 'footer' && cleanText(p.id) !== cleanText(summary?.id));
      const site = objectValue(state.site);
      const chrome = chromeRowHtml();
      const summarySection = portal && summary ? `<p class="fmwe-micro-label"><i class="fas fa-house"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_c540fb4647cefa"," Required portal page") ?? " Required portal page")}</p><div class="fmwe-tile-grid">${String(systemTileHtml({ id: 'summary', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_9b03ccb29ba168","Summary") ?? "Summary"), icon: 'fa-house' }))}</div>` : '';
      if (!regular.length) {
        body.innerHTML = `${summarySection}${chrome}${stateHtml({ hero: true, icon: 'fa-file-circle-plus', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_89b2a9e024a7f2","Create your first page") ?? "Create your first page"), message: portal ? 'Custom pages you publish here appear as extra tabs in every customer portal.' : 'Pages you publish become part of your live website.', actionLabel: 'New page', actionIcon: 'fa-plus' })}`;
        body.querySelector('[data-we-state-action]')?.addEventListener('click', () => openNewPageModal());
        wireTiles(body);
        renderThumbnails(body);
        return;
      }
      body.innerHTML = `
        ${String(summarySection)}
        ${String(chrome)}
        <p class="fmwe-micro-label"><i class="fas fa-file-lines"></i> ${String(portal ? 'Custom pages' : 'Pages')} <span class="count">${String(regular.length)}</span></p>
        <div class="fmwe-table-wrap">
          <table class="fmwe-table">
            <thead><tr>
              <th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_8cf345002184e5","Name") ?? "Name")}</th><th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_6778c9c2d9a698","Slug") ?? "Slug")}</th><th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_1352cafa75b8da","Status") ?? "Status")}</th>
              ${String(portal
                ? `<th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_97af778bd995b1","In portal") ?? "In portal")}</th>`
                : `<th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_dd2479d2b169d7","Header menu") ?? "Header menu")}</th><th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_279be10a5e8139","Footer menu") ?? "Footer menu")}</th><th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_f1956e2233bd27","Visible") ?? "Visible")}</th>`)}
              ${String(portal ? '' : `<th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_1519fbdf5b87ed","Home") ?? "Home")}</th>`)}<th>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_6a171239c315c1","Updated") ?? "Updated")}</th>
            </tr></thead>
            <tbody>
              ${String(regular.map((page) => {
                const isHome = cleanText(site.home_page_id) === cleanText(page.id);
                const nav = objectValue(page.nav);
                return `
                  <tr data-page-row="${esc(page.id)}">
                    <td><span class="page-name">${isHome ? `<i class="fas fa-star" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_8d59e4a1a00432","Home page") ?? "Home page")}"></i>` : ''}${esc(firstText(page.title, 'Untitled page'))}</span></td>
                    <td class="slug-cell">${cleanText(page.slug) ? `/${esc(page.slug)}` : '—'}</td>
                    <td>${pageStatusChips(page)}</td>
                    ${portal
                      ? `<td><button type="button" class="fmwe-switch ${page.enabled && nav.header ? 'on' : ''}" data-portal-toggle title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_d423f790e25aa6","Show this page as a tab in your customer portal") ?? "Show this page as a tab in your customer portal")}"></button></td>`
                      : `<td><button type="button" class="fmwe-switch ${nav.header ? 'on' : ''}" data-nav-toggle="header" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_0f092ca7d72f68","Show in header menu") ?? "Show in header menu")}"></button></td>
                    <td><button type="button" class="fmwe-switch ${nav.footer ? 'on' : ''}" data-nav-toggle="footer" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a606bea45e84d6","Show in footer menu") ?? "Show in footer menu")}"></button></td>
                    <td><button type="button" class="fmwe-switch ${page.enabled ? 'on' : ''}" data-enabled-toggle title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_fbc252f2b3b59e","Visible on the live site") ?? "Visible on the live site")}"></button></td>`}
                    ${portal ? '' : `<td><button type="button" class="fmwe-radio ${isHome ? 'on' : ''}" data-home-radio title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_e3fecb7ffcdc8c","Set as home page") ?? "Set as home page")}" ${isHome ? 'disabled' : ''}></button></td>`}
                    <td class="muted">${esc(timeAgo(page.updated_at) || '—')}</td>
                  </tr>`;
              }).join(''))}
            </tbody>
          </table>
        </div>`;
      wireTiles(body);
      renderThumbnails(body);
      body.querySelectorAll('[data-page-row]').forEach((row) => {
        const page = pageById(row.dataset.pageRow);
        if (!page) return;
        row.addEventListener('click', (event) => {
          if (event.target.closest('button')) return;
          gotoEditor(page.id);
        });
        row.querySelectorAll('[data-nav-toggle]').forEach((btn) => btn.addEventListener('click', (event) => {
          event.stopPropagation();
          const key = btn.dataset.navToggle;
          const nav = { ...objectValue(page.nav) };
          nav[key] = !nav[key];
          toggleWithRevert(btn, nav[key], () => patchPage(page, { nav }));
        }));
        row.querySelector('[data-enabled-toggle]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          const btn = event.currentTarget;
          const next = !(page.enabled === true);
          toggleWithRevert(btn, next, () => patchPage(page, { enabled: next }));
        });
        // Portal site: visibility and the portal tab are one decision.
        row.querySelector('[data-portal-toggle]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          const btn = event.currentTarget;
          const next = !(page.enabled === true && objectValue(page.nav).header === true);
          toggleWithRevert(btn, next, () => patchPage(page, { enabled: next, nav: { ...objectValue(page.nav), header: next } }));
        });
        row.querySelector('[data-home-radio]')?.addEventListener('click', (event) => {
          event.stopPropagation();
          setHomePage(page);
        });
      });
    }

    async function toggleWithRevert(btn, on, action){
      btn.classList.toggle('on', on);
      btn.disabled = true;
      try {
        await action();
      } catch (error) {
        btn.classList.toggle('on', !on);
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not update the page.'), false);
      } finally {
        btn.disabled = false;
      }
    }

    async function patchPage(page, patch){
      const res = await api().pages.patch(orgId(), state.siteId, page.id, withRevision(patch, pageRevision(page)));
      const updated = objectValue(res.page || res);
      Object.assign(page, patch, updated.id ? updated : {});
      mergePage(page);
      return page;
    }

    async function setHomePage(page){
      const site = objectValue(state.site);
      const previous = cleanText(site.home_page_id);
      try {
        await api().sites.patch(orgId(), state.siteId, withRevision({ home_page_id: cleanText(page.id) }, numberValue(site.revision)));
        state.site = { ...site, home_page_id: cleanText(page.id) };
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_e180da832dfa99",`"${v0}" is now the home page.`,{v0}) ?? `"${v0}" is now the home page.`)(firstText(page.title, 'Page')), true);
        render();
        loadSite(state.siteId, { silent: true });
      } catch (error) {
        state.site = { ...objectValue(state.site), home_page_id: previous };
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not set the home page.'), false);
        render();
      }
    }

    // ------------------------------------------------------- site settings
    function openSiteSettings(){
      const site = objectValue(state.site);
      const portal = isPortalSite(site);
      const settings = objectValue(site.settings);
      const chat = objectValue(settings.chat);
      const seo = objectValue(settings.seo);
      const homeCandidates = state.pages.filter((p) => (cleanText(p.role) || 'page') === 'page');
      const back = document.createElement('div');
      back.className = 'fmwe-drawer-back';
      back.innerHTML = `
        <div class="fmwe-drawer">
          <div class="fmwe-drawer-head">
            <strong><i class="fas fa-gear"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_1255d6e07fca7b"," Site settings") ?? " Site settings")}</strong>
            <button type="button" class="fmwe-icon-btn" data-ss-close title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="fmwe-drawer-body">
            <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_ba8118f379dfa8","Site name") ?? "Site name")}</span><input type="text" data-ss-name value="${String(esc(firstText(site.name)))}" maxlength="80"></label>
            ${String(portal ? '' : `
              <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_8d59e4a1a00432","Home page") ?? "Home page")}</span>
                <select data-ss-home>
                  ${homeCandidates.map((p) => `<option value="${esc(p.id)}" ${cleanText(site.home_page_id) === cleanText(p.id) ? 'selected' : ''}>${esc(firstText(p.title, 'Untitled page'))}</option>`).join('')}
                  ${homeCandidates.length ? '' : `<option value="">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_c47e91f90ebbb4","No pages yet") ?? "No pages yet")}</option>`}
                </select>
              </label>
              <p class="fmwe-micro-label"><i class="fas fa-link"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_448f96fcde9319"," Live URL") ?? " Live URL")}</p>
              <div class="fmwe-site-url" style="margin-bottom:14px">
                <code>${esc(liveSiteUrl(site).replace(/^https?:\/\//, '') || 'Available after creation')}</code>
                <button type="button" class="fmwe-icon-btn" data-ss-copy title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_cd28b8aa65a947","Copy live link") ?? "Copy live link")}"><i class="fas fa-copy"></i></button>
                ${liveSiteUrl(site) ? `<a class="fmwe-icon-btn" href="${esc(liveSiteUrl(site))}" target="_blank" rel="noopener" title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_2ac59adf8711de","Open live site") ?? "Open live site")}"><i class="fas fa-arrow-up-right-from-square"></i></a>` : ''}
              </div>
              <p class="fmwe-micro-label"><i class="fas fa-comments"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_e9747fd9a688ef"," Live chat") ?? " Live chat")}</p>
              <div class="fmwe-check">
                <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_29aeeed68dba2e","Show the chat widget on this site") ?? "Show the chat widget on this site")}<small>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_144bbb11f388a8","Uses your FirstMate live-chat widget.") ?? "Uses your FirstMate live-chat widget.")}</small></span>
                <button type="button" class="fmwe-switch ${chat.enabled ? 'on' : ''}" data-ss-chat-enabled></button>
              </div>
              <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_3dac2af4770318","Chat widget key") ?? "Chat widget key")}</span>
                <input type="text" data-ss-chat-key value="${esc(firstText(chat.widget_key))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_b861d33d8cee56","wk_…") ?? "wk_…")}">
                <span class="sub">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_f6e3be5d9f4ed5","Find this under Settings → Live Chat → Widget.") ?? "Find this under Settings → Live Chat → Widget.")}</span>
              </label>`)}
            <p class="fmwe-micro-label"><i class="fas fa-magnifying-glass"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a3db32a01cd18b"," SEO") ?? " SEO")}</p>
            <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_0ef3402e062834","Site title") ?? "Site title")}</span><input type="text" data-ss-seo-title value="${String(esc(firstText(seo.title)))}" maxlength="120"></label>
            <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_aa136ecb65672f","Description") ?? "Description")}</span><textarea data-ss-seo-desc maxlength="300">${String(esc(firstText(seo.description)))}</textarea></label>
          </div>
          <div class="fmwe-drawer-foot">
            <button type="button" class="fmwe-btn" data-ss-cancel>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="button" class="fmwe-btn primary" data-ss-save><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_072cb2e744ba22"," Save settings") ?? " Save settings")}</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      syncOnPrimaryVar(back);
      const close = () => back.remove();
      back.addEventListener('mousedown', (event) => { if (event.target === back) close(); });
      back.querySelector('[data-ss-close]')?.addEventListener('click', close);
      back.querySelector('[data-ss-cancel]')?.addEventListener('click', close);
      back.querySelector('[data-ss-chat-enabled]')?.addEventListener('click', (event) => {
        event.currentTarget.classList.toggle('on');
      });
      back.querySelector('[data-ss-copy]')?.addEventListener('click', async () => {
        const ok = await copyText(liveSiteUrl(site));
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), ok ? 'Live site link copied.' : 'Could not copy the link.', ok);
      });
      back.querySelector('[data-ss-save]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const patch = {
            name: firstText(back.querySelector('[data-ss-name]')?.value, site.name, 'Site'),
            settings: {
              ...settings,
              ...(portal ? {} : {
                chat: {
                  ...chat,
                  enabled: back.querySelector('[data-ss-chat-enabled]')?.classList.contains('on') === true,
                  widget_key: cleanText(back.querySelector('[data-ss-chat-key]')?.value)
                }
              }),
              seo: {
                ...seo,
                title: cleanText(back.querySelector('[data-ss-seo-title]')?.value),
                description: cleanText(back.querySelector('[data-ss-seo-desc]')?.value)
              }
            }
          };
          if (!portal) {
            const home = cleanText(back.querySelector('[data-ss-home]')?.value);
            if (home) patch.home_page_id = home;
          }
          await api().sites.patch(orgId(), state.siteId, withRevision(patch, numberValue(site.revision)));
          close();
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_67d2f0002fc167","Site settings saved.") ?? "Site settings saved."), true);
          loadSite(state.siteId);
        } catch (error) {
          button.disabled = false;
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not save the site settings.'), false);
        }
      });
    }

    // ------------------------------------------------------------ new page
    async function openNewPageModal(){
      const portal = isPortalSite();
      await loadCatalog(state.siteId);
      const pageTemplates = templateRegistry().filter((entry) => entry.kind === 'page');
      const portalTemplates = pageTemplates.filter((entry) => entry.group === 'portal');
      const generalTemplates = pageTemplates.filter((entry) => entry.group !== 'portal');
      const templateCard = (entry) => `
        <button type="button" class="fmwe-new-template" data-np-template="${esc(entry.id)}" aria-pressed="false">
          <span class="fmwe-new-template-thumb" data-np-template-thumb="${esc(entry.id)}"></span>
          <span><strong>${esc(entry.name)}</strong><small>${esc(firstText(entry.defaultTitle, entry.name))}</small></span>
          <i class="fas fa-circle-check"></i>
        </button>`;
      const modalThumbHandles = [];
      const modal = openModal(`
        <h2><i class="fas fa-file-circle-plus"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_65e8237f1b1836"," New page") ?? " New page")}</h2>
        <p class="hint">${String(portal ? 'New pages start as drafts. Publish and enable one to add it as a customer-portal tab.' : 'New pages start as drafts and never appear on your live site until you publish them.')}</p>
        <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_9d6a9a8ec4fce8","Page title") ?? "Page title")}</span><input type="text" data-np-title placeholder="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_181254e7f4931c","e.g. About Us") ?? "e.g. About Us")}" maxlength="80"></label>
        <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_6778c9c2d9a698","Slug") ?? "Slug")}</span>
          <input type="text" data-np-slug placeholder="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_d0a0e77f36b9c0","about-us") ?? "about-us")}" maxlength="60" spellcheck="false">
          <span class="sub" data-np-slug-hint>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_f0cc796d638dcb","The page address: …/") ?? "The page address: …/")}<b>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_b7cff0444a4804","slug") ?? "slug")}</b></span>
        </label>
        <div class="fmwe-new-template-head">
          <strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_c5c394ca66d257","Start from a template") ?? "Start from a template")}</strong>
          <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_2b3a1096bc91b6","You can replace or customize it in the editor.") ?? "You can replace or customize it in the editor.")}</span>
        </div>
        <div class="fmwe-new-template-grid">
          ${String(portalTemplates.length ? `<p class="fmwe-new-template-label">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_1b9b45cf9e351d","Customer portal templates") ?? "Customer portal templates")}</p>${portalTemplates.map(templateCard).join('')}` : '')}
          ${String(generalTemplates.length ? `<p class="fmwe-new-template-label">${portal ? 'General page templates' : 'Page templates'}</p>${generalTemplates.map(templateCard).join('')}` : '')}
          <p class="fmwe-new-template-label">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_72d3d4a30fd8b6","Start without a template") ?? "Start without a template")}</p>
          <button type="button" class="fmwe-new-template blank selected" data-np-template="" aria-pressed="true">
            <span class="fmwe-new-template-thumb"><i class="fas fa-file"></i></span>
            <span><strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_98697fdffbff97","Blank page") ?? "Blank page")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_9097833e12b8ab","Start from scratch") ?? "Start from scratch")}</small></span>
            <i class="fas fa-circle-check"></i>
          </button>
        </div>
        <div class="fmwe-modal-foot">
          <button type="button" class="fmwe-btn primary" data-np-create><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_6167c02a139b47"," Create &amp; design") ?? " Create &amp; design")}</button>
        </div>`, { className: 'wide fmwe-new-page-modal', onClose: () => modalThumbHandles.splice(0).forEach((handle) => { try { handle?.destroy?.(); } catch (e) {} }) });
      const titleInput = modal.body.querySelector('[data-np-title]');
      const slugInput = modal.body.querySelector('[data-np-slug]');
      let slugEdited = false;
      let titleEdited = false;
      let selectedTemplateId = '';
      titleInput?.focus();
      titleInput?.addEventListener('input', () => {
        titleEdited = true;
        if (!slugEdited && slugInput) slugInput.value = slugify(titleInput.value);
      });
      slugInput?.addEventListener('input', () => { slugEdited = cleanText(slugInput.value).length > 0; });
      modal.body.querySelectorAll('[data-np-template]').forEach((card) => card.addEventListener('click', () => {
        selectedTemplateId = cleanText(card.dataset.npTemplate);
        modal.body.querySelectorAll('[data-np-template]').forEach((item) => {
          const selected = item === card;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        const entry = pageTemplates.find((item) => item.id === selectedTemplateId);
        if (!entry) return;
        if (!cleanText(titleInput?.value) || !titleEdited) {
          titleInput.value = firstText(entry.defaultTitle, entry.name, 'New page');
          if (!slugEdited && slugInput) slugInput.value = slugify(titleInput.value);
        }
      }));
      if (window.FMDocRenderer?.render && M()) {
        requestAnimationFrame(() => modal.body.querySelectorAll('[data-np-template-thumb]').forEach((stage) => {
          const entry = pageTemplates.find((item) => item.id === stage.dataset.npTemplateThumb);
          if (!entry || !stage.isConnected) return;
          try {
            const doc = templatePreviewDoc(entry.build());
            const scale = Math.max(0.035, Math.min(1, (stage.clientWidth || 132) / (designWidthPt() * PT_TO_PX)));
            modalThumbHandles.push(window.FMDocRenderer.render(stage, { document: doc, mode: 'static', widgetData: {}, widgetContext: { preview: true }, themeContext: { branding: orgBranding(), overrides: themeVarOverrides() }, mediaUrl: mediaUrlResolver(), scale }));
          } catch (e) { /* neutral preview remains */ }
        }));
      }
      const create = async () => {
        const title = firstText(titleInput?.value);
        if (!title) { showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_2e442cc1b7843f","Give the page a title first.") ?? "Give the page a title first."), false); titleInput?.focus(); return; }
        const button = modal.body.querySelector('[data-np-create]');
        if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Creating…'; }
        try {
          const body = { title };
          const slug = slugify(slugInput?.value);
          if (slug) body.slug = slug;
          const res = await api().pages.create(orgId(), state.siteId, body);
          let page = objectValue(res.page || res);
          const entry = pageTemplates.find((item) => item.id === selectedTemplateId);
          if (entry) {
            try {
              const definition = templatePreviewDoc(entry.build());
              const saved = await api().pages.saveDraft(orgId(), state.siteId, page.id, withRevision({ definition }, numberValue(page.revision)));
              page = objectValue(saved.page || saved);
            } catch (templateError) {
              showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_554db703cf3ec9","The page was created, but its template could not be applied. You can apply it from Templates in the editor.") ?? "The page was created, but its template could not be applied. You can apply it from Templates in the editor."), false);
            }
          }
          modal.close();
          state.pages.push(page);
          gotoEditor(firstText(page.id));
        } catch (error) {
          if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-plus"></i> Create &amp; design'; }
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not create the page.'), false);
        }
      };
      modal.body.querySelector('[data-np-create]')?.addEventListener('click', create);
      [titleInput, slugInput].forEach((input) => input?.addEventListener('keydown', (event) => { if (event.key === 'Enter') create(); }));
    }

    // ============================================================== EDITOR
    async function openEditor(){
      destroyEditor();
      requestEditorSidebar();
      state.page = null;
      state.draftDefinition = null;
      state.revision = null;
      state.resolveInfo = null;
      state.editorLoading = true;
      state.editorError = null;
      state.editorMode = 'draft';
      state.device = 'desktop';
      state.portalFrame = false;
      state.saveState = 'saved';
      state.savedSinceLoad = false;
      state.historyOpen = false;
      state.versions = null;
      renderEditor();
      try {
        // Site context (design width, portal detection) must exist before the
        // canvas mounts — reload it when deep-linked straight to a page.
        if (!state.site || cleanText(objectValue(state.site).id) !== state.siteId) {
          const siteRes = await api().sites.get(orgId(), state.siteId);
          state.site = objectValue(siteRes.site || siteRes);
          state.pages = arrayValue(siteRes.pages || state.site.pages).map(objectValue);
          state.systemPages = arrayValue(siteRes.system_pages || state.site.system_pages).map(objectValue);
        }
        const [pageRes, , resolveRes] = await Promise.all([
          api().pages.get(orgId(), state.siteId, state.pageId),
          loadCatalog(state.siteId),
          api().pages.resolve(orgId(), state.siteId, state.pageId, { source: 'draft' }).catch(() => null)
        ]);
        if (state.destroyed || state.view !== 'editor') return;
        state.page = objectValue(pageRes.page || pageRes);
        state.revision = numberValue(pageRes.revision, state.page.revision);
        state.draftDefinition = clone(objectValue(objectValue(state.page.draft).definition));
        window.FMDocModel?.normalizeViewHorizontalPositions?.(state.draftDefinition, { parent_width_pt: designWidthPt() });
        state.resolveInfo = resolveRes ? objectValue(resolveRes) : null;
        state.editorLoading = false;
        renderEditor();
        mountEditorCanvas();
      } catch (error) {
        state.editorLoading = false;
        state.editorError = error;
        if (!state.destroyed && state.view === 'editor') renderEditor();
      }
    }

    function destroyEditor(options = {}){
      rememberEditorViewport();
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
      destroySiteChromePreview();
      if (!options.preserveHeader) window.Portal?.topbar?.releaseLeft?.(editorTopbarOwner);
      // The visual-editor wrapper handle tears down the whole chrome (markup
      // session, timers, thumbs, observers) along with the inner doc editor.
      try { state.webAgent?.destroy?.(); } catch (e) {}
      try { state.editorHandle?.destroy?.(); } catch (e) {}
      try { state.liveHandle?.destroy?.(); } catch (e) {}
      state.editorHandle = null;
      state.webAgent = null;
      state.liveHandle = null;
      state.mountedEditorSiteId = '';
      state.mountedEditorPageId = '';
      if (!options.preserveHeader) state.editorHeader = null;
    }

    function unpublishedChanges(){
      const page = objectValue(state.page);
      if (state.savedSinceLoad) return true;
      if (page.has_unpublished_changes === true) return true;
      if (page.has_unpublished_changes === false) return false;
      return Number(page.published_version || 0) === 0;
    }

    function editorLeaveGuard(){
      if (state.saving || state.pendingSave || state.saveTimer || state.saveState === 'dirty' || state.saveState === 'error') {
        return confirmDialog('Your latest edits are still saving. Leave now and they may be lost.', {
          title: (globalThis.PlatformLanguage?.text("web-editor","m_e550775d195182","Leave the editor?") ?? "Leave the editor?"), confirmLabel: 'Leave anyway', icon: 'fa-triangle-exclamation', danger: true
        });
      }
      return Promise.resolve(true);
    }

    function summaryNoteHtml(){
      return `<div class="fmwe-summary-editor-note"><i class="fas fa-shield-halved"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_70fa83050b601a","Required Summary content stays above this canvas") ?? "Required Summary content stays above this canvas")}</strong><small>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_824d006baead30","Project title, address, contact information, next steps, photos, and proposals are always shown. Design any additional sections below.") ?? "Project title, address, contact information, next steps, photos, and proposals are always shown. Design any additional sections below.")}</small></span></div>`;
    }

    function isSummaryPage(){
      const page = objectValue(state.page);
      return isPortalSite() && (cleanText(page.id) === cleanText(objectValue(state.site).home_page_id) || cleanText(page.system_key) === 'summary');
    }

    function renderEditor(){
      // Some host actions rebuild the editor shell. Capture before replacing
      // its DOM so publishing/settings/device fallbacks cannot reset the
      // document viewport to the top.
      rememberEditorViewport();
      const page = objectValue(state.page);
      const isSummary = isSummaryPage();
      root.innerHTML = `
        <div class="fmwe-shell">
          <div class="fmwe-editor fullscreen">
            <header class="fmwe-editor-top">
              <button type="button" class="fmwe-icon-btn" data-ed-back title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_990e88a8ba17e8","Back to pages") ?? "Back to pages")}"><i class="fas fa-arrow-left"></i></button>
              <input class="fmwe-title-input" data-ed-title value="${String(esc(isSummary ? 'Summary' : firstText(page.title, state.editorLoading ? '' : 'Untitled page')))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_9d6a9a8ec4fce8","Page title") ?? "Page title")}" spellcheck="false" ${String(state.editorLoading || isSummary ? 'disabled' : '')}>
              ${String(state.editorLoading ? '' : pageStatusChips(page))}
              <span class="fmwe-save-chip saved" data-ed-save-chip></span>
            </header>
            <div class="fmwe-editor-body" data-ed-body>
              ${String(isSummary ? summaryNoteHtml() : '')}
              <div class="fmwe-editor-main">
                <div class="fmwe-editor-canvas" data-ed-canvas>
                  ${String(state.editorLoading ? `<div class="fmwe-state" style="margin:22px;border:0;background:transparent"><div class="fmwe-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a1e9e1f8008f0c","Opening page") ?? "Opening page")}</strong></div>` : '')}
                  ${String(state.editorError ? stateHtml({ icon: 'fa-cloud-bolt', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_9d086cd5a7a42c","Couldn’t open this page") ?? "Couldn’t open this page"), message: errorMessage(state.editorError, ''), retry: true }) : '')}
                </div>
              </div>
            </div>
          </div>
        </div>`;
      state.editorHeader = root.querySelector('.fmwe-editor-top');
      syncOnPrimaryVar(root.querySelector('.fmwe-shell'));
      updateSaveChip();

      root.querySelector('[data-we-retry]')?.addEventListener('click', () => openEditor());
      root.querySelector('[data-ed-back]')?.addEventListener('click', async () => {
        if (!(await editorLeaveGuard())) return;
        destroyEditor();
        gotoSite(state.siteId, { keepData: true });
      });
      root.querySelector('[data-ed-title]')?.addEventListener('input', (event) => sizeEditorTitle(event.target));
      root.querySelector('[data-ed-title]')?.addEventListener('change', async (event) => {
        const title = firstText(event.target.value, 'Untitled page');
        event.target.value = title;
        sizeEditorTitle(event.target);
        try {
          await patchPage(state.page, { title });
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not rename the page.'), false);
        }
      });
      syncEditorHeaderHost();
    }

    function webAgentEnabled(){
      return !!window.FMDocAgentPanel?.create && window.FMDocAgentPanel?.available?.() !== false;
    }

    function mountWebAgent(hostEl){
      try { state.webAgent?.destroy?.(); } catch (e) {}
      state.webAgent = null;
      if (!hostEl) return;
      if (!window.FMDocAgentPanel?.create) {
        hostEl.innerHTML = `<div class="fmwe-empty"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_85a6a9fb425b48","The design copilot library is not loaded.") ?? "The design copilot library is not loaded.")}</span></div>`;
        return;
      }
      state.webAgent = window.FMDocAgentPanel.create(hostEl, {
        orgId: orgId(),
        subjectId: firstText(state.pageId),
        title: (globalThis.PlatformLanguage?.text("web-editor","m_266931bb32a080","Website copilot") ?? "Website copilot"),
        placeholder: (globalThis.PlatformLanguage?.text("web-editor","m_c7f922163353bf","Describe the page change…") ?? "Describe the page change…"),
        welcome: 'Tell me what to change on this page. I’ll update the shared visual canvas while you keep looking at the preview.',
        suggestions: [
          'Make the hero headline clearer and strengthen the call to action',
          'Add a testimonial section above the footer',
          'Improve the mobile layout without changing the copy'
        ],
        getInput: () => ({
          mode: 'website',
          subject: {
            id: firstText(state.pageId),
            name: firstText(state.page?.title, state.page?.name, 'Website page'),
            site_id: firstText(state.siteId),
            site_name: firstText(state.site?.name)
          },
          definition: objectValue(state.editorHandle?.getDocument?.() || state.draftDefinition)
        }),
        onAction: (action) => {
          if (cleanText(objectValue(action).type) !== 'document.set_definition') return;
          const document_ = clone(objectValue(objectValue(action).document));
          if (cleanText(document_.kind) !== 'view' || objectValue(document_.root).type !== 'frame') return;
          state.editorHandle?.setDocument?.(document_, { source: 'agent' });
          state.draftDefinition = clone(state.editorHandle?.getDocument?.() || document_);
          state.saveState = 'dirty';
          updateSaveChip();
          const publish = root.querySelector('[data-ed-publish]');
          if (publish) publish.disabled = false;
          scheduleAutosave();
        }
      });
    }

    function updateSaveChip(){
      const chip = editorHeaderQuery('[data-ed-save-chip]');
      if (!chip) return;
      const map = {
        saved: state.savedSinceLoad ? '<i class="fas fa-check"></i> Saved' : '',
        dirty: '<i class="fas fa-pen"></i> Editing…',
        saving: '<i class="fas fa-spinner fa-spin"></i> Saving…',
        error: '<i class="fas fa-triangle-exclamation"></i> Save failed — retrying on next edit',
        conflict: '<i class="fas fa-triangle-exclamation"></i> Conflict — <a data-ed-reload>reload</a>'
      };
      chip.className = `fmwe-save-chip ${state.saveState}`;
      chip.innerHTML = map[state.saveState] || '';
      chip.querySelector('[data-ed-reload]')?.addEventListener('click', () => openEditor());
      const publishBtn = editorHeaderQuery('[data-ed-publish]');
      if (publishBtn && !state.editorLoading) publishBtn.disabled = !unpublishedChanges();
    }

    // -------------------------------------------------------- editor canvas
    function canvasHolder(){
      return root.querySelector('[data-ed-canvas]');
    }

    function rememberEditorViewport(){
      const canvas = root.querySelector('.fmde-canvas');
      const siteId = cleanText(state.mountedEditorSiteId);
      const pageId = cleanText(state.mountedEditorPageId);
      if (!canvas || !siteId || !pageId) return;
      state.editorCanvasViewport = {
        siteId,
        pageId,
        left: canvas.scrollLeft,
        top: canvas.scrollTop
      };
    }

    function restoreEditorViewport(){
      const saved = objectValue(state.editorCanvasViewport);
      if (!saved.pageId || saved.siteId !== cleanText(state.siteId) || saved.pageId !== cleanText(state.pageId)) return;
      const apply = () => {
        if (state.destroyed || state.view !== 'editor') return;
        const canvas = root.querySelector('.fmde-canvas');
        if (!canvas) return;
        canvas.scrollLeft = numberValue(saved.left) || 0;
        canvas.scrollTop = numberValue(saved.top) || 0;
      };
      // Restore once after synchronous mount and again after renderer layout;
      // pagination can briefly change the scroll range between those phases.
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
      setTimeout(apply, 120);
    }

    /** Binding scope for live previews and the editor's data preview — the
     *  same inputs the server resolve uses, so both render alike. */
    function editorResolveScope(){
      const resolveInfo = objectValue(state.resolveInfo);
      const siteContext = objectValue(resolveInfo.site_context);
      return {
        ...siteContext,
        org: { id: orgId(), name: orgName(), ...objectValue(siteContext.org) },
        site: { ...objectValue(objectValue(state.site)), ...objectValue(siteContext.site) }
      };
    }

    async function mountEditorCanvas(){
      destroyEditor({ preserveHeader: true });
      const canvas = canvasHolder();
      if (!canvas || state.editorLoading || state.editorError) return;
      if (state.editorMode === 'live') { await mountLivePreview(canvas); return; }

      const stage = canvas;
      canvas.innerHTML = '';
      // Portal frame is a PREVIEW: the page rendered inside the customer
      // portal's chrome, exactly as a customer sees it — never the editor
      // itself wrapped in portal chrome.
      if (state.portalFrame && isPortalSite()) {
        await ensurePortalChromeCss();
        if (state.destroyed || state.view !== 'editor' || state.editorMode !== 'draft' || !state.portalFrame) return;
        const previewStage = buildPortalFrame(canvas);
        if (!window.FMDocRenderer?.render) {
          previewStage.innerHTML = `<div class="cp-custom-page-empty">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_42d08ea7c234b8","Preview unavailable — renderer not loaded.") ?? "Preview unavailable — renderer not loaded.")}</div>`;
          return;
        }
        let previewDoc = clone(state.draftDefinition || {});
        try {
          if (window.FMDocModel?.resolveBindings) previewDoc = window.FMDocModel.resolveBindings(previewDoc, editorResolveScope());
        } catch (error) { /* raw tokens still render */ }
        try {
          state.liveHandle = window.FMDocRenderer.render(previewStage, {
            document: previewDoc,
            mode: 'interactive',
            widgetData: objectValue(state.resolveInfo).widget_data || {},
            themeContext: { branding: orgBranding(), overrides: themeVarOverrides() },
            mediaUrl: mediaUrlResolver(),
            widgetContext: { resolvePageHref: () => '#', preview: true }
          });
        } catch (error) {
          previewStage.innerHTML = `<div class="cp-custom-page-empty">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_c7dfa3c0aa9b5d","We could not render this preview.") ?? "We could not render this preview.")}</div>`;
        }
        return;
      }
      if (!window.FMDocEditor?.mount || !window.FMVisualEditor?.mount) {
        stage.innerHTML = stateHtml({ icon: 'fa-pen-ruler', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_d08399aef41777","Editor unavailable") ?? "Editor unavailable"), message: (globalThis.PlatformLanguage?.htmlText("web-editor","m_a501de9d8db031","The document editor library is not loaded for this session.") ?? "The document editor library is not loaded for this session.") });
        return;
      }
      // The `website` profile ships with the doc-editor changes built in
      // parallel; registerProfile is the same additive API, so its absence
      // means the older library — fall back rather than fail to mount.
      let profile = 'website';
      if (typeof window.FMDocEditor.registerProfile !== 'function') {
        profile = 'designer';
        console.warn('Web Editor: FMDocEditor "website" profile unavailable — falling back to "designer".');
      }
      try {
        // Exposed for automated UI tests (scripts/web-editor-e2e.mjs); the app
        // itself always goes through state.editorHandle / state. `state` is
        // also the shared chrome-state carrier (chrome.state below), so the
        // chrome's fields (brandKit, uploadsList, markupSession, …) keep
        // living on __fmweState exactly as before the extraction.
        window.__fmweState = state;
        const body = root.querySelector('[data-ed-body]') || stage.parentElement || stage;
        body.innerHTML = '';
        // The shared visual editor: identical FMDocEditor options plus the
        // web-only chrome adapters (section/page templates, portal widget
        // items, notes persistence, upload owner metadata). Site routes are
        // deliberately not exposed here: the shared editor derives its
        // section navigator from this route's view document.
        state.editorHandle = window.FMVisualEditor.mount(body, {
          document: window.FMDocModel?.normalizeViewHorizontalPositions?.(clone(state.draftDefinition || {}), { parent_width_pt: designWidthPt() }) || clone(state.draftDefinition || {}),
          profile,
          mode: 'visual',
          agentEnabled: webAgentEnabled(),
          catalog: state.catalog,
          capabilities: objectValue(state.catalog?.capabilities),
          widgetData: objectValue(state.resolveInfo).widget_data || {},
          themeContext: { branding: orgBranding(), overrides: themeVarOverrides() },
          viewportWidth: state.device === 'mobile' ? 390 : null,
          resolveScope: editorResolveScope(),
          sidePanels: webAgentEnabled()
            ? [{ id: 'agent', label: (globalThis.PlatformLanguage?.text("web-editor","m_b8071e017821d8","Agent") ?? "Agent"), render: mountWebAgent }]
            : [],
          media: {
            pick(pickerOptions = {}){
              return new Promise((resolve, reject) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = firstText(pickerOptions.accept, 'image/*');
                input.onchange = async () => {
                  const file = input.files?.[0];
                  if (!file) { reject(new Error('No file selected.')); return; }
                  try {
                    if (!window.PlatformAPI?.media?.upload) throw new Error('Media uploads are unavailable.');
                    const result = await window.PlatformAPI.media.upload(orgId(), file, { ownerType: 'website_page', ownerId: firstText(state.pageId, 'page'), collection: 'websites' });
                    const item = objectValue(result.media || result);
                    resolve({ media_id: firstText(item.id, item.media_id), variant: 'original' });
                  } catch (error) { reject(error); }
                };
                input.click();
              });
            },
            url(mediaRef, variant){
              const ref = typeof mediaRef === 'string' ? { media_id: mediaRef } : objectValue(mediaRef);
              if (ref.url) return ref.url;
              if (!window.PlatformAPI?.media?.fileUrl) return '';
              return window.PlatformAPI.media.fileUrl(orgId(), firstText(ref.media_id, ref.id), variant || ref.variant || 'original');
            }
          },
          onChange: (doc) => {
            state.draftDefinition = doc;
            state.saveState = 'dirty';
            updateSaveChip();
            const publish = root.querySelector('[data-ed-publish]');
            if (publish) publish.disabled = false;
            scheduleAutosave();
          },
          documentActions: {
            getDevice: () => state.device,
            device: ({ device }) => {
              const next = device === 'mobile' ? 'mobile' : 'desktop';
              if (next === state.device) return;
              state.device = next;
              applyDevice();
            },
            deviceViewport: (preview) => {
              const current = objectValue(state.devicePreview);
              Object.assign(current, objectValue(preview));
              state.devicePreview = current;
              scheduleSiteChromePreview();
            },
            ...((isPortalSite() || isSiteChromePage()) ? {} : {
              getSiteChromePreview: () => siteChromePreviewSnapshot(),
              siteChromePreview: (input) => updateSiteChromePreview(input)
            }),
            pageSettings: () => openPageSettingsModal(),
            publish: () => publishPage(),
            canPublish: () => !state.editorLoading && unpublishedChanges(),
            versions: () => openHistoryDrawer()
          },
          chrome: {
            contentKind: 'web',
            state,
            orgId: orgId(),
            orgName: orgName(),
            designWidthPt,
            device: true,
            addSection: false,
            toast: (message, ok) => showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), message, ok),
            confirm: (message, options) => confirmDialog(message, options),
            banner: isSummaryPage() ? summaryNoteHtml() : '',
            templates: { groups: chromeTemplateGroups },
            elements: { widgets: websiteElementWidgets },
            markup: {},
            brand: { branding: orgBranding() },
            qr: {},
            notes: {
              get: () => firstText(objectValue(state.page).notes),
              save: (text, setStatus) => saveNotes(text, setStatus)
            },
            upload: { ownerType: 'website_page', ownerId: firstText(state.pageId, 'page'), collection: 'websites' },
            fullscreenEl: () => root.querySelector('.fmwe-editor')
          }
        });
        // Test hooks: the raw inner doc-editor handle, effective section
        // geometry, and the template registry buildable off-DOM (overlap
        // audit).
        window.__fmweEditor = state.editorHandle.editor;
        window.__fmweSectionRect = (id) => (state.editorHandle && state.editorHandle.sectionRect ? state.editorHandle.sectionRect(id) : null);
        window.__fmweTemplates = {
          list: () => templateRegistry().map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
          buildDoc(id){
            const entry = templateRegistry().find((t) => t.id === id);
            if (!entry) return null;
            const built = entry.build();
            return templatePreviewDoc(Array.isArray(built) ? built : [built]);
          }
        };
        state.mountedEditorSiteId = cleanText(state.siteId);
        state.mountedEditorPageId = cleanText(state.pageId);
        state.editorHandle.setDevicePreview?.({ device: state.device });
        restoreEditorViewport();
        scheduleSiteChromePreview();
      } catch (error) {
        console.warn('FMVisualEditor mount failed', error);
        const body = root.querySelector('[data-ed-body]');
        if (body) body.innerHTML = `<div class="fmwe-editor-main"><div class="fmwe-editor-canvas" data-ed-canvas>${stateHtml({ icon: 'fa-triangle-exclamation', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_61445ee660b4e6","Editor failed to start") ?? "Editor failed to start"), message: errorMessage(error, '') })}</div></div>`;
      }
    }

    function buildPortalFrame(canvas){
      const name = orgName();
      const page = objectValue(state.page);
      const tabPages = state.pages
        .filter((p) => (cleanText(p.role) || 'page') === 'page' && objectValue(p.nav).header)
        .sort((a, b) => (numberValue(objectValue(a.nav).order) || 0) - (numberValue(objectValue(b.nav).order) || 0));
      if (!tabPages.some((p) => cleanText(p.id) === cleanText(page.id)) && (cleanText(page.role) || 'page') === 'page') {
        tabPages.push(page);
      }
      canvas.innerHTML = `
        <div class="fmwe-cp-frame-note"><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a5d1a9c5996acf"," Customer portal preview — how customers will see this page") ?? " Customer portal preview — how customers will see this page")}</div>
        <div class="fmwe-portal-frame">
          <div class="fmwe-cp-scope" style="${String(esc(portalBrandingStyle()))}">
            <div class="cp-shell">
              <header class="cp-header">
                <div class="cp-header-inner">
                  <div class="cp-brand">
                    ${String(portalLogoHtml(name))}
                    <div>
                      <strong>${String(esc(name))}</strong>
                      <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_46ba04ea07c935","Customer portal") ?? "Customer portal")}</span>
                    </div>
                  </div>
                </div>
              </header>
              <nav class="cp-tabs" aria-label="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_e6d980684bc615","Customer portal sections") ?? "Customer portal sections")}">
                ${String(PORTAL_BUILTIN_TABS.map((label) => `<button type="button">${esc(label)}</button>`).join(''))}
                ${String(tabPages.map((p) => `<button type="button" class="${cleanText(p.id) === cleanText(page.id) ? 'active' : ''}">${esc(firstText(p.title, 'Page'))}</button>`).join(''))}
              </nav>
              <div class="cp-wrap">
                <div class="cp-tab-panel" data-ed-portal-stage></div>
              </div>
            </div>
          </div>
        </div>`;
      return canvas.querySelector('[data-ed-portal-stage]');
    }

    async function mountLivePreview(canvas){
      canvas.innerHTML = `
        <div class="fmwe-live-bar"><i class="fas fa-tower-broadcast"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_3c4a636dc121bf"," Viewing live version") ?? " Viewing live version")}</div>
        <div class="fmwe-live-stage"><div class="inner" data-ed-live-stage><div class="fmwe-state" style="border:0;background:transparent"><div class="fmwe-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_b6e4873e77605a","Loading live version") ?? "Loading live version")}</strong></div></div></div>`;
      const stage = canvas.querySelector('[data-ed-live-stage]');
      try {
        const res = await api().pages.resolve(orgId(), state.siteId, state.pageId, { source: 'published' });
        if (state.destroyed || state.view !== 'editor' || state.editorMode !== 'live') return;
        const payload = objectValue(res);
        const definition = objectValue(payload.definition);
        if (!isViewDefinition(definition)) throw new Error('This page has not been published yet.');
        if (!window.FMDocRenderer?.render) throw new Error('The document renderer library is not loaded.');
        stage.innerHTML = '';
        const available = state.device === 'mobile' ? 390 : Math.max(320, (canvas.clientWidth || 900) - 60);
        const scale = Math.min(1, available / designWidthPx());
        state.liveHandle = window.FMDocRenderer.render(stage, {
          document: clone(definition),
          mode: 'static',
          widgetData: objectValue(payload.widget_data),
          themeContext: { branding: orgBranding(), overrides: objectValue(payload.theme_vars) },
          mediaUrl: mediaUrlResolver(),
          scale
        });
      } catch (error) {
        stage.innerHTML = stateHtml({
          icon: Number(error?.status) === 404 ? 'fa-eye-slash' : 'fa-triangle-exclamation',
          title: Number(error?.status) === 404 ? 'Nothing live yet' : 'Couldn’t load the live version',
          message: Number(error?.status) === 404 ? 'Publish this page to see the live version here.' : errorMessage(error, '')
        });
      }
    }

    function applyDevice(){
      if (state.editorMode === 'live') {
        mountEditorCanvas();
        return;
      }
      if (state.editorHandle && typeof state.editorHandle.setDevicePreview === 'function') {
        state.editorHandle.setDevicePreview({ device: state.device });
        scheduleSiteChromePreview();
        return;
      }
      const px = state.device === 'mobile' ? 390 : null;
      if (state.editorHandle && typeof state.editorHandle.setViewportWidth === 'function') {
        try { state.editorHandle.setViewportWidth(px); scheduleSiteChromePreview(); return; } catch (e) {}
      }
      // Older doc-editor without setViewportWidth: remount with the option.
      mountEditorCanvas();
    }

    // ================================================= WEB-ONLY EDITOR BITS
    // The Canva-style editor chrome (icon rail, slide-out panels, add-section
    // pill, section chrome + popovers, pages strip, bottom bar, markup dock,
    // drag-insert plumbing) now lives in the SHARED visual-editor library:
    // public/libraries/visual-editor/firstmate-visual-editor.js (global
    // FMVisualEditor). What remains here is strictly web-specific and is
    // injected into the chrome via adapters at mount time (see
    // mountEditorCanvas): the site design width, the web PAGE templates and
    // the customer-portal template group, the portal widget items for the
    // Elements panel, the site-pages adapter, notes persistence, and the
    // upload owner metadata.

    const M = () => window.FMDocModel;
    const VE = () => window.FMVisualEditor;
    const designWidthPt = () => numberValue(objectValue(objectValue(state.site).settings).design_width_pt) || 720;

    /** Wrap sections in a throwaway view doc for card previews. */
    function templatePreviewDoc(sections){
      return VE().templatePreviewDoc(sections, designWidthPt());
    }

    // ---------------------------------------------------- template registry
    // WEB-ONLY: portal page templates. Built from the shared library's
    // generic node builders (tplSection/tplText/tplWidget).
    function portalTitleSection(title, subtitle, options = {}){
      const { tplSection, tplText } = VE().builders;
      const PRIMARY_VAR = VE().PRIMARY_VAR;
      const section = tplSection(firstText(options.name, title), numberValue(options.height) || 150, [
        tplText(title, { x: 48, y: 34, w: 620, h: 38, z: 1 }, { size_pt: 26, weight: 900, color: options.dark ? '#ffffff' : '#101828' }, { blockType: 'heading' }),
        tplText(subtitle, { x: 48, y: 82, w: 610, h: 42, z: 2 }, { size_pt: 12.5, color: options.dark ? 'rgba(255,255,255,.82)' : '#667085' })
      ], options.dark ? { fill: { type: 'solid', color: PRIMARY_VAR } } : { fill: { type: 'solid', color: '#ffffff' } });
      return section;
    }

    function tplWidgetWithCatalog(widgetId, frame, options = {}){
      return VE().builders.tplWidget(widgetId, frame, options, state.catalog);
    }

    function portalWidgetSection(name, height, widgetId, frame, config = {}, options = {}){
      const { tplSection } = VE().builders;
      const widgetNode = tplWidgetWithCatalog(widgetId, { x: frame.x ?? 48, y: frame.y ?? 28, w: frame.w ?? 624, h: frame.h ?? Math.max(100, height - 56), z: 1 }, { name, config });
      if (options.required) widgetNode.locks = { ...(widgetNode.locks || {}), delete: true };
      const section = tplSection(name, height, [widgetNode], options.style || { fill: { type: 'solid', color: '#ffffff' } });
      if (options.required) section.locks = { ...(section.locks || {}), delete: true };
      return section;
    }

    function portalWelcomeTemplate(){
      return [
        portalTitleSection('Welcome to your project portal', 'A personal message from our team, plus everything you need for the project ahead.', { dark: true, height: 170 }),
        portalWidgetSection('Welcome video', 430, 'doc.video', { x: 80, y: 34, w: 560, h: 360 }, { caption: (globalThis.PlatformLanguage?.text("web-editor","m_8c8aaa0bbf3560","We are glad you are here. Check back anytime for project updates.") ?? "We are glad you are here. Check back anytime for project updates.") }),
        portalTitleSection('We will keep you in the loop', 'Use the tabs above to follow appointments, photos, documents, proposals, and payments. Your project team will update this portal as work progresses.', { name: 'What to expect', height: 170 })
      ];
    }

    function portalTeamTemplate(){
      return [
        portalTitleSection('Meet your project team', 'The people responsible for keeping your work moving and your questions answered.', { dark: true, height: 160 }),
        portalWidgetSection('Meet the team', 470, 'portal.team', { h: 414 }, { title: '', source_mode: 'automatic', layout: 'cards', columns: 3, show_role: true, show_bio: true })
      ];
    }

    function portalPortfolioTemplate(){
      return [
        portalTitleSection('See the transformation', 'Compare progress and finished work with configurable before-and-after galleries.', { dark: true, height: 160 }),
        portalWidgetSection('Before and after', 500, 'portal.portfolio', { h: 444 }, { title: '', source_mode: 'automatic', layout: 'slider', limit: 6, show_labels: true, show_captions: true })
      ];
    }

    function portalActivityTemplate(){
      return [
        portalTitleSection('Project updates', 'A clear, customer-safe timeline of important work and milestones.', { dark: true, height: 160 }),
        portalWidgetSection('Project activity', 520, 'portal.activity_feed', { x: 100, w: 520, h: 464 }, { title: '', source_mode: 'automatic', layout: 'timeline', limit: 20, show_dates: true, show_details: true, newest_first: true })
      ];
    }

    function portalNearbyTemplate(){
      return [
        portalTitleSection('Work near you', 'Explore privacy-safe showcase projects completed in your area.', { dark: true, height: 160 }),
        portalWidgetSection('Nearby projects', 540, 'portal.nearby_jobs', { h: 484 }, { title: '', radius_miles: 10, limit: 8, layout: 'map_list', show_thumbnails: true })
      ];
    }

    /** Full registry: WEB page templates (+ portal page templates on the
     *  portal site) followed by the shared library's generic section
     *  templates. Used by the new-page modal, the chrome's Templates panel
     *  (via chromeTemplateGroups) and the __fmweTemplates test hook. */
    function templateRegistry(){
      if (!M() || !VE()) return [];
      const s = VE().sections(state.catalog);
      return [
        ...(isPortalSite() ? [
          { id: 'tpl_portal_welcome', kind: 'page', group: 'portal', name: 'Welcome video page', defaultTitle: 'Welcome', keywords: 'portal welcome video introduction message', build: portalWelcomeTemplate },
          { id: 'tpl_portal_team', kind: 'page', group: 'portal', name: 'Meet the team page', defaultTitle: 'Meet the Team', keywords: 'portal people users staff crew team', build: portalTeamTemplate },
          { id: 'tpl_portal_portfolio', kind: 'page', group: 'portal', name: 'Before & after portfolio', defaultTitle: 'Portfolio', keywords: 'portal portfolio gallery before after comparison', build: portalPortfolioTemplate },
          { id: 'tpl_portal_activity', kind: 'page', group: 'portal', name: 'Project updates page', defaultTitle: 'Project Updates', keywords: 'portal activity updates log timeline milestones', build: portalActivityTemplate },
          { id: 'tpl_portal_nearby', kind: 'page', group: 'portal', name: 'Nearby projects map', defaultTitle: 'Nearby Projects', keywords: 'portal map nearby jobs showcase locations', build: portalNearbyTemplate }
        ] : []),
        { id: 'tpl_page_landing', kind: 'page', group: 'pages', name: 'Landing page', defaultTitle: 'Landing Page', keywords: 'home marketing full', build: () => [s.hero(), s.services(), s.testimonial(), s.cta()] },
        { id: 'tpl_page_about', kind: 'page', group: 'pages', name: 'About page', defaultTitle: 'About', keywords: 'company story full', build: () => [s.about(), s.gallery(), s.cta()] },
        { id: 'tpl_page_contact', kind: 'page', group: 'pages', name: 'Contact page', defaultTitle: 'Contact', keywords: 'form questions full', build: () => [s.contact(), s.faq(), s.cta()] },
        ...VE().sectionTemplates(state.catalog)
      ];
    }

    /** Template groups for the shared chrome's Templates panel (adapter for
     *  chrome.templates.groups). Group ids/labels are unchanged so the
     *  persisted collapse state keeps working. */
    function chromeTemplateGroups(){
      const entries = templateRegistry();
      return [
        ...(isPortalSite() ? [{ id: 'portal', label: (globalThis.PlatformLanguage?.text("web-editor","m_c4fce6af9221db","Customer portal pages") ?? "Customer portal pages"), description: (globalThis.PlatformLanguage?.text("web-editor","m_5448860a146f64","Purpose-built portal layouts") ?? "Purpose-built portal layouts") }] : []),
        { id: 'pages', label: isPortalSite() ? 'General page layouts' : 'Page layouts', description: (globalThis.PlatformLanguage?.text("web-editor","m_6f9153b504fefe","Complete marketing-style pages") ?? "Complete marketing-style pages") },
        { id: 'sections', label: (globalThis.PlatformLanguage?.text("web-editor","m_6c6dbe9fc5a8cd","Reusable sections") ?? "Reusable sections"), description: (globalThis.PlatformLanguage?.text("web-editor","m_0e629ae9d4413d","Hero, CTA, gallery, contact and more") ?? "Hero, CTA, gallery, contact and more") }
      ].map((group) => ({ ...group, entries: entries.filter((entry) => entry.group === group.id) }));
    }

    /** Host-specific functional blocks for the shared visual-editor Widgets
     * tab. Public websites and customer portals deliberately expose different
     * catalogs while retaining identical insertion and drag behavior. */
    function websiteElementWidgets(){
      if (!VE()) return [];
      const EL = VE().previews;
      const W = tplWidgetWithCatalog;
      if (!isPortalSite()) {
        const forms = arrayValue(objectValue(state.catalog).lead_forms).map(objectValue).filter((form) => form.enabled !== false && cleanText(form.id));
        const formItems = forms.map((form) => {
          const mode = cleanText(form.mode).toLowerCase();
          const scheduling = mode === 'appointment';
          const estimate = mode === 'instant_estimate';
          const name = firstText(form.name, scheduling ? 'Customer scheduling form' : (estimate ? 'Instant estimate' : 'Contact form'));
          return {
            id: `el_web_form_${cleanText(form.id).replace(/[^a-z0-9]+/gi, '_')}`,
            name,
            icon: scheduling ? 'fa-calendar-check' : (estimate ? 'fa-calculator' : 'fa-address-card'),
            preview: EL.leadForm,
            span: 2,
            build: () => W('web.lead_form', { w: 520, h: scheduling ? 400 : 320 }, { name, config: { form_id: cleanText(form.id) } })
          };
        });
        const otherPages = regularPages().filter((page) => cleanText(page.id) !== cleanText(state.pageId));
        const embedDef = arrayValue(objectValue(state.catalog).widgets).find((widget) => cleanText(objectValue(widget).id) === 'web.page_embed');
        if (embedDef) {
          const options = otherPages.map((page) => [cleanText(page.id), firstText(page.title, 'Untitled page')]);
          const field = arrayValue(embedDef.configPanel).find((entry) => cleanText(objectValue(entry).key) === 'page_id');
          if (field) field.options = options;
          embedDef.defaults = { ...objectValue(embedDef.defaults), config: { ...objectValue(objectValue(embedDef.defaults).config), page_id: options[0]?.[0] || '' } };
        }
        const embedItem = otherPages.length ? [{
          id: 'el_web_page_embed',
          name: 'Embedded page section',
          icon: 'fa-window-restore',
          preview: EL.secTall,
          span: 2,
          section: true,
          build: () => {
            const target = otherPages[0];
            const title = firstText(target.title, 'Embedded page');
            return VE().builders.tplSection(`Embedded: ${title}`, 360, [
              W('web.page_embed', { x: 0, y: 0, w: designWidthPt(), h: 360, z: 1 }, {
                name: `Embedded: ${title}`,
                config: { page_id: cleanText(target.id) }
              })
            ]);
          }
        }] : [];
        return formItems.concat(embedItem);
      }
      return [
        { id: 'el_portal_header', name: 'Project header', icon: 'fa-house-chimney', preview: EL.secShort, build: () => W('portal.project_header', { w: 560, h: 120 }, { name: 'Project header' }) },
        { id: 'el_portal_steps', name: 'Next steps', icon: 'fa-list-check', preview: EL.leadForm, build: () => W('portal.next_steps', { w: 360, h: 260 }, { name: 'Next steps' }) },
        { id: 'el_portal_visit', name: 'Next visit', icon: 'fa-calendar-day', preview: EL.secTall, build: () => W('portal.next_appointment', { w: 360, h: 220 }, { name: 'Next visit' }) },
        { id: 'el_portal_photos', name: 'Recent photos', icon: 'fa-images', preview: EL.photoGrid, build: () => W('portal.photo_strip', { w: 560, h: 180 }, { name: 'Recent photos' }) },
        { id: 'el_portal_activity', name: 'Project updates', icon: 'fa-timeline', preview: EL.leadForm, build: () => W('portal.activity_feed', { w: 520, h: 360 }, { name: 'Project updates' }) },
        { id: 'el_portal_team', name: 'Meet the team', icon: 'fa-people-group', preview: EL.photoGrid, build: () => W('portal.team', { w: 560, h: 320 }, { name: 'Meet the team' }) },
        { id: 'el_portal_portfolio', name: 'Before & after', icon: 'fa-images', preview: EL.photoGrid, build: () => W('portal.portfolio', { w: 560, h: 380 }, { name: 'Before & after' }) },
        { id: 'el_portal_video', name: 'Welcome video', icon: 'fa-circle-play', preview: EL.video, build: () => W('portal.welcome_video', { w: 560, h: 340 }, { name: 'Welcome video' }) },
        { id: 'el_portal_nearby', name: 'Nearby projects', icon: 'fa-map-location-dot', preview: EL.secTall, build: () => W('portal.nearby_jobs', { w: 560, h: 440 }, { name: 'Nearby projects' }) }
      ];
    }

    // ------------------------------------------------------- pages adapter
    function regularPages(){
      return state.pages.filter((p) => (cleanText(p.role) || 'page') === 'page');
    }

    async function switchToPage(pageId){
      const target = cleanText(pageId);
      if (!target || target === state.pageId) return;
      // Flush pending edits before leaving (same contract as the back button).
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
      if (state.saveState === 'dirty' || state.pendingSave) await performSave();
      if (!(await editorLeaveGuard())) return;
      gotoEditor(target);
    }

    // ------------------------------------------------------ notes (adapter)
    async function saveNotes(text, setStatus = () => {}){
      setStatus('<i class="fas fa-spinner fa-spin"></i> Saving…');
      // Notes PATCH and draft autosave share the page revision — flush any
      // pending draft save first so the two never race each other.
      if (state.saveTimer || state.saveState === 'dirty' || state.pendingSave) {
        clearTimeout(state.saveTimer);
        state.saveTimer = 0;
        await performSave();
      }
      while (state.saving) await new Promise((resolve) => setTimeout(resolve, 150));
      const applyPatch = (revision) => api().pages.patch(orgId(), state.siteId, state.pageId,
        withRevision({ notes: String(text ?? '') }, revision));
      try {
        let res;
        try {
          res = await applyPatch(state.revision ?? pageRevision(state.page));
        } catch (error) {
          if (Number(error?.status) !== 409) throw error;
          // Stale revision (a draft save landed in between) — refetch and retry once.
          const fresh = await api().pages.get(orgId(), state.siteId, state.pageId);
          const freshPage = objectValue(objectValue(fresh).page || fresh);
          res = await applyPatch(numberValue(objectValue(fresh).revision, freshPage.revision));
        }
        const updated = objectValue(objectValue(res).page || res);
        if (updated.id) {
          state.page = { ...state.page, ...updated };
          mergePage(state.page);
        }
        const nextRevision = numberValue(objectValue(res).revision, updated.revision);
        if (nextRevision !== null) state.revision = nextRevision;
        setStatus('<i class="fas fa-check"></i> Saved');
      } catch (error) {
        setStatus('<i class="fas fa-triangle-exclamation"></i> Save failed');
      }
    }

    // ------------------------------------------------------------ autosave
    function scheduleAutosave(){
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        state.saveTimer = 0;
        performSave();
      }, 800);
    }

    async function performSave(){
      if (state.destroyed || state.view !== 'editor' || !state.page) return;
      if (state.saveState === 'conflict') return;
      if (state.saving) { state.pendingSave = true; return; }
      state.saving = true;
      state.saveState = 'saving';
      updateSaveChip();
      try {
        const definition = clone(state.editorHandle?.getDocument?.() || state.draftDefinition);
        state.draftDefinition = definition;
        const res = await api().pages.saveDraft(orgId(), state.siteId, state.pageId, withRevision({ definition }, state.revision));
        const data = objectValue(res);
        const nextRevision = numberValue(data.revision, objectValue(data.page).revision);
        if (nextRevision !== null) state.revision = nextRevision;
        else if (numberValue(state.revision) !== null) state.revision = numberValue(state.revision) + 1;
        if (objectValue(data.page).id) state.page = { ...state.page, ...objectValue(data.page) };
        state.savedSinceLoad = true;
        if (state.page) state.page.has_unpublished_changes = true;
        state.saveState = 'saved';
      } catch (error) {
        if (Number(error?.status) === 409) {
          state.saveState = 'conflict';
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_2ed00b856d95b8","Someone else edited this page — reload to pick up their changes.") ?? "Someone else edited this page — reload to pick up their changes."), false);
        } else {
          state.saveState = 'error';
        }
      } finally {
        state.saving = false;
        updateSaveChip();
        if (state.pendingSave) {
          state.pendingSave = false;
          if (state.saveState !== 'conflict') scheduleAutosave();
        }
      }
    }

    // ------------------------------------------------------------- publish
    async function publishPage(){
      if (!state.page || state.editorLoading) return;
      clearTimeout(state.saveTimer);
      state.saveTimer = 0;
      if (state.saveState === 'dirty' || state.pendingSave) await performSave();
      if (state.saveState === 'conflict' || state.saveState === 'error') return;
      const nextVersion = Number(objectValue(state.page).published_version || 0) + 1;
      const portal = isPortalSite();
      const firstPublish = nextVersion === 1;
      const confirmed = await confirmDialog(
        portal
          ? (firstPublish
            ? 'Publish this page? It will immediately appear as a tab in your customer portal.'
            : `Publish version ${nextVersion}? This updates your customer portal immediately.`)
          : (firstPublish
            ? 'Publish this page? It goes live on your site immediately.'
            : `Publish version ${nextVersion}? This updates your live site immediately.`),
        { title: (globalThis.PlatformLanguage?.text("web-editor","m_e6bfce67bf000d","Publish this page") ?? "Publish this page"), confirmLabel: `Publish v${nextVersion}`, icon: 'fa-rocket' }
      );
      if (!confirmed) return;
      const button = editorHeaderQuery('[data-ed-publish]');
      if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Publishing…'; }
      try {
        const res = await api().pages.publish(orgId(), state.siteId, state.pageId, withRevision({}, state.revision));
        const data = objectValue(res);
        const updated = objectValue(data.page || data);
        if (updated.id) state.page = { ...state.page, ...updated };
        else state.page = { ...state.page, published_version: nextVersion, has_unpublished_changes: false };
        const nextRevision = numberValue(data.revision, updated.revision);
        if (nextRevision !== null) state.revision = nextRevision;
        state.page.has_unpublished_changes = updated.has_unpublished_changes === true;
        state.savedSinceLoad = false;
        state.versions = null;
        mergePage(state.page);
        showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_5a1923f60f5783",`Published version ${v0}.`,{v0}) ?? `Published version ${v0}.`)(Number(state.page.published_version || nextVersion)), true);
        renderEditor();
        mountEditorCanvas();
      } catch (error) {
        if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-rocket"></i> Publish'; }
        if (Number(error?.status) === 409) {
          state.saveState = 'conflict';
          updateSaveChip();
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_e664d3ee5b5375","Publish conflict — this page changed elsewhere. Reload to continue.") ?? "Publish conflict — this page changed elsewhere. Reload to continue."), false);
        } else {
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not publish the page.'), false);
        }
      }
    }

    // -------------------------------------------------------- page settings
    function openPageSettingsModal(){
      const page = objectValue(state.page);
      const portal = isPortalSite();
      const role = cleanText(page.role) || 'page';
      const nav = objectValue(page.nav);
      const seo = objectValue(page.seo);
      const chromeRole = role === 'header' || role === 'footer';
      const modal = openModal(`
        <h2><i class="fas fa-globe"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_110fb5db03f26e"," Web page settings") ?? " Web page settings")}</h2>
        ${String(chromeRole ? `<p class="hint">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_2399ec3b4373a0","This is a site chrome page — it renders on every page of your site and stays out of menus.") ?? "This is a site chrome page — it renders on every page of your site and stays out of menus.")}</p>` : '')}
        ${String(chromeRole ? '' : `
          <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_6778c9c2d9a698","Slug") ?? "Slug")}</span>
            <input type="text" data-ps-slug value="${esc(firstText(page.slug))}" maxlength="60" spellcheck="false">
            <span class="sub">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_f0cc796d638dcb","The page address: …/") ?? "The page address: …/")}<b>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_b7cff0444a4804","slug") ?? "slug")}</b></span>
          </label>
          ${portal ? `
          <div class="fmwe-check">
            <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_3bac4fc9dda8bb","Show in customer portal") ?? "Show in customer portal")}<small>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_c08285256579b0","Your customers see this page as a portal tab. Turn off to hide it without unpublishing.") ?? "Your customers see this page as a portal tab. Turn off to hide it without unpublishing.")}</small></span>
            <button type="button" class="fmwe-switch ${page.enabled && nav.header ? 'on' : ''}" data-ps-portal-visible></button>
          </div>` : `
          <div class="fmwe-check">
            <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_0f092ca7d72f68","Show in header menu") ?? "Show in header menu")}<small>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_2bc98ea7cc4e03","Adds this page to your site’s header navigation.") ?? "Adds this page to your site’s header navigation.")}</small></span>
            <button type="button" class="fmwe-switch ${nav.header ? 'on' : ''}" data-ps-nav-header></button>
          </div>
          <div class="fmwe-check">
            <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a606bea45e84d6","Show in footer menu") ?? "Show in footer menu")}</span>
            <button type="button" class="fmwe-switch ${nav.footer ? 'on' : ''}" data-ps-nav-footer></button>
          </div>
          <div class="fmwe-check">
            <span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_864ba051ae8d35","Visible on your live site") ?? "Visible on your live site")}<small>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_29131610b16909","Turn off to hide this page without unpublishing.") ?? "Turn off to hide this page without unpublishing.")}</small></span>
            <button type="button" class="fmwe-switch ${page.enabled ? 'on' : ''}" data-ps-enabled></button>
          </div>`}
          <p class="fmwe-micro-label"><i class="fas fa-magnifying-glass"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_a3db32a01cd18b"," SEO") ?? " SEO")}</p>
          <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_d58b8139dce2e2","SEO title") ?? "SEO title")}</span><input type="text" data-ps-seo-title value="${esc(firstText(seo.title))}" maxlength="120"></label>
          <label class="fmwe-field"><span>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_d7ec3a61f94e39","SEO description") ?? "SEO description")}</span><textarea data-ps-seo-desc maxlength="300">${esc(firstText(seo.description))}</textarea></label>`)}
        <div class="fmwe-modal-foot">
          ${String(chromeRole ? '' : `<button type="button" class="fmwe-btn primary" data-ps-save><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_072cb2e744ba22"," Save settings") ?? " Save settings")}</button>`)}
        </div>`);
      modal.body.querySelectorAll('.fmwe-switch').forEach((btn) => btn.addEventListener('click', () => btn.classList.toggle('on')));
      modal.body.querySelector('[data-ps-save]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const portalVisible = modal.body.querySelector('[data-ps-portal-visible]')?.classList.contains('on') === true;
          const patch = {
            slug: slugify(modal.body.querySelector('[data-ps-slug]')?.value) || cleanText(page.slug),
            // Portal site: one switch drives both visibility and the tab.
            enabled: portal ? portalVisible : modal.body.querySelector('[data-ps-enabled]')?.classList.contains('on') === true,
            nav: {
              ...nav,
              header: portal ? portalVisible : modal.body.querySelector('[data-ps-nav-header]')?.classList.contains('on') === true,
              ...(portal ? {} : { footer: modal.body.querySelector('[data-ps-nav-footer]')?.classList.contains('on') === true })
            },
            seo: {
              ...seo,
              title: cleanText(modal.body.querySelector('[data-ps-seo-title]')?.value),
              description: cleanText(modal.body.querySelector('[data-ps-seo-desc]')?.value)
            }
          };
          await patchPage(state.page, patch);
          modal.close();
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), (globalThis.PlatformLanguage?.text("web-editor","m_6769c4704b506e","Web page settings saved.") ?? "Web page settings saved."), true);
          renderEditor();
          mountEditorCanvas();
        } catch (error) {
          button.disabled = false;
          showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not save the page settings.'), false);
        }
      });
    }

    // ------------------------------------------------------------- history
    async function openHistoryDrawer(){
      const page = objectValue(state.page);
      const back = document.createElement('div');
      back.className = 'fmwe-drawer-back';
      back.innerHTML = `
        <div class="fmwe-drawer">
          <div class="fmwe-drawer-head">
            <strong><i class="fas fa-clock-rotate-left"></i>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_b5edeb48c05298"," Version history") ?? " Version history")}</strong>
            <button type="button" class="fmwe-icon-btn" data-vh-close title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="fmwe-drawer-body" data-vh-body>
            <div class="fmwe-state" style="border:0;background:transparent"><div class="fmwe-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_be3a1459d2466d","Loading history") ?? "Loading history")}</strong></div>
          </div>
        </div>`;
      document.body.appendChild(back);
      syncOnPrimaryVar(back);
      const close = () => back.remove();
      back.addEventListener('mousedown', (event) => { if (event.target === back) close(); });
      back.querySelector('[data-vh-close]')?.addEventListener('click', close);
      const body = back.querySelector('[data-vh-body]');
      try {
        if (!state.versions) {
          const res = await api().pages.versions(orgId(), state.siteId, state.pageId);
          state.versions = arrayValue(res.versions || res.items).map(objectValue)
            .sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
        }
      } catch (error) {
        body.innerHTML = stateHtml({ icon: 'fa-cloud-bolt', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_8459bc266435f5","Couldn’t load the history") ?? "Couldn’t load the history"), message: errorMessage(error, '') });
        return;
      }
      if (!body.isConnected) return;
      if (!state.versions.length) {
        body.innerHTML = stateHtml({ icon: 'fa-clock-rotate-left', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_228d7f432a9708","No versions yet") ?? "No versions yet"), message: (globalThis.PlatformLanguage?.htmlText("web-editor","m_e1766e6a9625f5","Publish this page and every published version will be kept here.") ?? "Publish this page and every published version will be kept here.") });
        return;
      }
      const liveVersion = Number(page.published_version || 0);
      body.innerHTML = `
        <p class="hint" style="margin:0 0 10px;color:#667085;font-size:12px;font-weight:700;line-height:1.5">${((v0) => globalThis.PlatformLanguage?.htmlText("web-editor","m_29a6232e7681c5",`Restoring copies an old version into your draft — the live ${v0} is unchanged until you publish.`,{v0}) ?? `Restoring copies an old version into your draft — the live ${v0} is unchanged until you publish.`)(isPortalSite() ? 'portal' : 'site')}</p>
        ${String(state.versions.map((v) => `
          <div class="fmwe-version-row" data-version-row="${esc(v.version)}">
            <span class="fmwe-version-badge">v${esc(v.version)}</span>
            <div class="info">
              <strong>Version ${esc(v.version)} ${Number(v.version) === liveVersion ? `<span class="fmwe-chip live">${(globalThis.PlatformLanguage?.htmlText("web-editor","m_430a0cf632da94","Live") ?? "Live")}</span>` : ''}</strong>
              <small>${esc([formatDate(v.published_at), firstText(v.published_by_name, v.published_by, v.published_by_user_id)].filter(Boolean).join(' · ') || 'Published')}</small>
            </div>
            <div class="actions">
              <button type="button" class="fmwe-icon-btn" data-vh-view title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_dc9e45a6bb3a6b","View this version") ?? "View this version")}"><i class="fas fa-eye"></i></button>
              <button type="button" class="fmwe-icon-btn" data-vh-restore title="${(globalThis.PlatformLanguage?.htmlText("web-editor","m_08616cb653b89e","Restore to draft") ?? "Restore to draft")}"><i class="fas fa-rotate-left"></i></button>
            </div>
          </div>`).join(''))}`;
      body.querySelectorAll('[data-version-row]').forEach((row) => {
        const version = Number(row.dataset.versionRow);
        row.querySelector('[data-vh-view]')?.addEventListener('click', () => viewVersion(version));
        row.querySelector('[data-vh-restore]')?.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            `Copies version ${version} into your draft. Your live ${isPortalSite() ? 'portal' : 'site'} is unchanged until you publish.`,
            { title: ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_878cffdc62a182",`Restore version ${v0}?`,{v0}) ?? `Restore version ${v0}?`)(version), confirmLabel: 'Restore to draft', icon: 'fa-rotate-left' }
          );
          if (!confirmed) return;
          try {
            await api().pages.restore(orgId(), state.siteId, state.pageId, withRevision({ version }, state.revision));
            close();
            showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), ((v0) => globalThis.PlatformLanguage?.text("web-editor","m_d66cdc459fb8b2",`Version ${v0} restored into the draft.`,{v0}) ?? `Version ${v0} restored into the draft.`)(version), true);
            openEditor();
          } catch (error) {
            showToast((globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"), errorMessage(error, 'Could not restore this version.'), false);
          }
        });
      });
    }

    async function viewVersion(version){
      const modal = openModal(`
        <h2><i class="fas fa-eye"></i>${((v0) => globalThis.PlatformLanguage?.htmlText("web-editor","m_fe35838a4d7d84",` Version ${v0}`,{v0}) ?? ` Version ${v0}`)(esc(version))}</h2>
        <div class="fmwe-version-preview" data-vv-stage>
          <div class="fmwe-state" style="border:0;background:transparent"><div class="fmwe-spinner"></div><strong>${(globalThis.PlatformLanguage?.htmlText("web-editor","m_6f4c8d92d84a45","Loading version") ?? "Loading version")}</strong></div>
        </div>`, { className: 'wide' });
      const stage = modal.body.querySelector('[data-vv-stage]');
      try {
        const res = await api().pages.version(orgId(), state.siteId, state.pageId, version);
        const record = objectValue(res.version || res.page_version || res);
        const definition = objectValue(record.definition);
        if (!isViewDefinition(definition)) throw new Error('This version has no stored definition.');
        if (!window.FMDocRenderer?.render) throw new Error('The document renderer library is not loaded.');
        stage.innerHTML = '';
        const scale = Math.min(1, Math.max(220, stage.clientWidth - 30) / designWidthPx());
        window.FMDocRenderer.render(stage, {
          document: clone(definition),
          mode: 'static',
          widgetData: {},
          widgetContext: { preview: true },
          themeContext: { branding: orgBranding(), overrides: themeVarOverrides() },
          mediaUrl: mediaUrlResolver(),
          scale
        });
      } catch (error) {
        stage.innerHTML = stateHtml({ icon: 'fa-triangle-exclamation', title: (globalThis.PlatformLanguage?.htmlText("web-editor","m_05ae2c72e46837","Couldn’t load this version") ?? "Couldn’t load this version"), message: errorMessage(error, '') });
      }
    }

    const onPlatformTopbarVisibility = () => {
      if (!state.destroyed && state.view === 'editor') syncEditorHeaderHost();
    };
    window.addEventListener('fm:platform-topbar-visibility', onPlatformTopbarVisibility);
    window.addEventListener('resize', onPlatformTopbarVisibility);

    // ---------------------------------------------------------------- boot
    const initialDomainSettings = routeValue('domainSettings');
    const initialSite = routeValue('site');
    const initialPage = routeValue('page');
    const initialView = routeValue('view');
    if (initialView === 'list' || initialView === 'grid') state.siteViewMode = initialView;
    if (initialDomainSettings === 'domains') {
      state.view = 'domains';
      renderDomains();
    } else if (initialSite && initialPage) {
      state.view = 'editor';
      state.siteId = initialSite;
      state.pageId = initialPage;
      openEditor();
    } else if (initialSite) {
      state.view = 'site';
      state.siteId = initialSite;
      loadSite(initialSite);
    } else {
      loadSites();
    }

    return {
      setActive(active){
        state.active = active !== false;
        if (!state.active) releaseEditorSidebar();
        else if (state.view === 'editor') requestEditorSidebar();
        if (state.view === 'editor') syncEditorHeaderHost();
        if (!state.active || state.destroyed) return;
        if (state.view === 'sites' && state.sites !== null) loadSites({ silent: true });
        else if (state.view === 'site' && state.site) loadSite(state.siteId, { silent: true });
        else if (state.view === 'domains') renderDomains();
      },
      update(){},
      destroy(){
        state.destroyed = true;
        clearTimeout(state.saveTimer);
        window.removeEventListener('fm:platform-topbar-visibility', onPlatformTopbarVisibility);
        window.removeEventListener('resize', onPlatformTopbarVisibility);
        releaseEditorSidebar();
        destroyEditor();
        destroyThumbs();
        root.innerHTML = '';
      }
    };
  }

  runtime.registerApp({
    id: 'portal.web_editor',
    kind: 'portal_tab',
    portalTabId: 'web_editor',
    title: (globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"),
    label: (globalThis.PlatformLanguage?.text("web-editor","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"),
    visible: true,
    icon: 'fa-globe',
    order: 59,
    fullBleed: true,
    surfaces: ['portal_tab'],
    regions: ['main'],
    mount: (context = {}) => mountWebEditor(context)
  });
})();
