/* Signup language hand-off (1M8-240).
 *
 * The contract: a page that rendered in a language passes it on as `?lang=<BCP-47 tag>` on links into the app
 * (es, es-MX, fr-FR, de, pt-BR ...), and the first page that sees `lang` also stores it in the `fm_lang` cookie
 * (Domain=.1m8.ai on our hosts, 30 days), so it survives redirects and links that drop the query.
 * Landing page -> login.php -> signup -> onboarding -> the new organization's company language.
 *
 * The server resolves the language actually used (commerce/regions.ts resolveSignupLanguage): the hand-off, then
 * the edge country, then the browser languages, then the time zone; any tag maps onto a shipped language pack.
 * Visitors never choose a country or language on the form. */
(function (root) {
  'use strict';
  const COOKIE = 'fm_lang';
  const SCRIPT_SRC = root.document?.currentScript?.src || '';
  const NAMESPACE = 'signup';
  let started = null;

  const validTag = (value) => /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(String(value || '').trim());
  function cookieDomain(host) {
    const name = String(host || '').toLowerCase();
    return name === '1m8.ai' || name.endsWith('.1m8.ai') ? '.1m8.ai' : '';
  }
  function readCookie(doc) {
    const match = String(doc?.cookie || '').match(/(?:^|;\s*)fm_lang=([^;]+)/);
    const value = match ? decodeURIComponent(match[1]) : '';
    return validTag(value) ? value : '';
  }
  /** Store the language for later pages on any 1m8.ai host (or this host elsewhere). */
  function remember(tag, doc = root.document) {
    if (!validTag(tag) || !doc) return;
    const domain = cookieDomain(root.location?.hostname);
    doc.cookie = `${COOKIE}=${encodeURIComponent(tag)}; Max-Age=${60 * 60 * 24 * 30}; Path=/; SameSite=Lax${domain ? '; Domain=' + domain : ''}${root.location?.protocol === 'https:' ? '; Secure' : ''}`;
  }
  /** The explicit hand-off: `?lang=` (also `hl`), else the cookie. A `lang` seen here is remembered. */
  function handoff(doc = root.document) {
    let params;
    try { params = new URLSearchParams(root.location?.search || ''); } catch (_) { params = new URLSearchParams(); }
    const fromUrl = [params.get('lang'), params.get('hl')].find(validTag) || '';
    if (fromUrl) { remember(fromUrl, doc); return fromUrl; }
    return readCookie(doc);
  }
  /** A URL into the app carrying the language (absolute or relative; other hosts are left alone). */
  function withLang(url, tag) {
    if (!validTag(tag)) return url;
    try {
      const parsed = new URL(url, root.location?.href);
      const host = parsed.hostname.toLowerCase();
      if (parsed.origin !== root.location?.origin && host !== 'app.1m8.ai' && !host.endsWith('.1m8.ai')) return url;
      if (!parsed.searchParams.has('lang')) parsed.searchParams.set('lang', tag);
      return parsed.toString();
    } catch (_) { return url; }
  }

  function loadPlatformLanguage(doc) {
    if (root.PlatformLanguage) return Promise.resolve(root.PlatformLanguage);
    return new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.src = SCRIPT_SRC ? new URL('../platform-language/platform-language.js', SCRIPT_SRC).toString() : '/libraries/platform-language/platform-language.js';
      script.addEventListener('load', () => root.PlatformLanguage ? resolve(root.PlatformLanguage) : reject(new Error('Language runtime did not initialize.')), { once: true });
      script.addEventListener('error', () => reject(new Error('Language runtime could not be loaded.')), { once: true });
      doc.head.appendChild(script);
    });
  }

  function browserHints() {
    let timeZone = '';
    try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
    const nav = root.navigator || {};
    return { time_zone: timeZone, locale: nav.language || '', locales: (nav.languages || []).join(',') };
  }

  /**
   * Resolve the page language with the server, switch the language runtime to it and load the signup catalogs.
   * Resolves to { language, options } (options are the signup options the phone picker uses); never rejects.
   */
  function start({ apiBase, namespaces = [], doc = root.document } = {}) {
    if (started) return started;
    const lang = handoff(doc);
    const hints = browserHints();
    const params = new URLSearchParams({ ...hints, ...(lang ? { lang } : {}) });
    const url = String(apiBase || `${root.location.origin}/v1/platform`).replace(/\/$/, '') + '/auth/signup-options?' + params;
    started = fetch(url, { credentials: 'include', cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .catch(() => null)
      .then(async (options) => {
        const language = options?.language || 'en-US';
        state.language = language; state.options = options; state.hints = { ...hints, lang };
        try {
          const runtime = await loadPlatformLanguage(doc);
          runtime.configure({ context: { locale: language, measurement_system: 'imperial' } });
          await runtime.ensure([NAMESPACE, ...namespaces]);
        } catch (_) { /* English fallbacks stay on screen. */ }
        return { language, options };
      });
    return started;
  }
  const state = { language: '', options: null, hints: {} };

  /** A signup string in the page language (`{name}` placeholders filled from values). */
  function t(key, fallback, values) {
    const readable = String(fallback).replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''));
    return root.PlatformLanguage?.text(NAMESPACE, key, readable, values) ?? readable;
  }

  /**
   * Translate marked elements: data-i18n (text), data-i18n-placeholder, data-i18n-aria-label, data-i18n-title.
   * data-i18n-slots="name": the message has {name}, filled by the child element marked data-i18n-slot="name"
   * (a link keeps its element and attributes; only text around it is replaced).
   */
  function translate(scope) {
    if (!scope) return;
    scope.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!el.dataset.i18nFallback) el.dataset.i18nFallback = el.dataset.i18nSlots ? templateOf(el) : el.textContent.trim();
      if (!el.dataset.i18nSlots) { el.textContent = t(key, el.dataset.i18nFallback); return; }
      const slots = new Map([...el.querySelectorAll('[data-i18n-slot]')].map(child => [child.getAttribute('data-i18n-slot'), child]));
      // ICU needs a value for every placeholder: pass each slot through as itself, then put the element there.
      const message = t(key, el.dataset.i18nFallback, Object.fromEntries([...slots.keys()].map(name => [name, `{${name}}`])));
      const parts = message.split(/\{(\w+)\}/);
      const nodes = parts.map((part, index) => index % 2 ? (slots.get(part) || el.ownerDocument.createTextNode('')) : el.ownerDocument.createTextNode(part));
      el.replaceChildren(...nodes);
    });
    for (const attr of ['placeholder', 'aria-label', 'title']) {
      scope.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        const key = el.getAttribute(`data-i18n-${attr}`);
        const store = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}Fallback`;
        if (!el.dataset[store]) el.dataset[store] = el.getAttribute(attr) || '';
        el.setAttribute(attr, t(key, el.dataset[store]));
      });
    }
    if (scope.documentElement && state.language) scope.documentElement.lang = state.language;
  }
  /** "By creating an account, you agree to our {terms}." from an element whose slot children are the variables. */
  function templateOf(el) {
    return [...el.childNodes].map(node => node.nodeType === 1 && node.hasAttribute('data-i18n-slot') ? `{${node.getAttribute('data-i18n-slot')}}` : node.textContent).join('').replace(/\s+/g, ' ').trim();
  }

  /** Add `lang` to links into the app (login, landing pages) inside scope. */
  function decorateLinks(scope, tag = state.language) {
    if (!scope || !validTag(tag)) return;
    scope.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
      if (!/\/portal\//.test(new URL(href, root.location?.href).pathname)) return;
      a.setAttribute('href', withLang(href, tag));
    });
  }

  root.FirstMateSignupLanguage = {
    COOKIE, handoff, remember, withLang, start, t, translate, decorateLinks, validTag,
    language: () => state.language, options: () => state.options, hints: () => ({ ...state.hints })
  };
})(globalThis);
