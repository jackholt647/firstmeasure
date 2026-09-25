import { createLanguage, type CatalogBundle, type LanguageContext } from './core.js';
import { LANGUAGE_PACKS } from './languages.js';

/** Explicit console-only QA session. Provenance markers bind source-owned text, never text matches. */
export function createDeveloperTester(options: { context: () => LanguageContext; ensureAll: () => Promise<void> }) {
  const storageKey = 'fm:language-tester:v1';
  type Session = { active: true; locale: string | null };
  let session: Session | null = null;
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); if (saved?.active === true) session = { active: true, locale: LANGUAGE_PACKS.some(p => p.code === saved.locale) ? saved.locale : null }; } catch { /* Unavailable storage leaves normal pages untouched. */ }
  const capturedAtBoot = !!session;
  const preview = createLanguage(options.context());
  const nonce = Math.random().toString(36).slice(2);
  const marker = new RegExp(`\u2063\u2063(/?)FM${nonce}:(\\d+)\u2063`, 'g');
  const pair = new RegExp(`\u2063\u2063FM${nonce}:(\\d+)\u2063([\\s\\S]*?)\u2063\u2063/FM${nonce}:\\1\u2063`, 'g');
  type Record = { namespace: string; key: string; fallback: string; values: any };
  type Part = string | { id: number; html: boolean };
  type Binding = { node: Text | Element; attribute?: string; parts: Part[]; last: string };
  const records = new Map<number, Record>();
  const bindings = new Set<Binding>();
  const byNode = new WeakMap<Node, Map<string, Binding>>();
  let nextId = 0, observer: MutationObserver | undefined, host: HTMLElement | undefined;
  let select: HTMLSelectElement | undefined, status: HTMLElement | undefined, bootstrap: HTMLButtonElement | undefined;
  let booted = false, busy = false, skipped = 0, revision = 0;
  const visibleAttributes = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'data-fm-tooltip']);
  const strip = (value: string) => value.replace(marker, '');
  function persist() { if (session) sessionStorage.setItem(storageKey, JSON.stringify(session)); else sessionStorage.removeItem(storageKey); }
  function syncContext() { preview.configure({ ...options.context(), ...(session?.locale ? { locale: session.locale } : {}) }); }
  function decode(value: string) {
    // Decode entity spelling from HTML templates without inserting executable markup.
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value.replace(/</g, '&lt;');
    return textarea.value;
  }
  function translated(id: number): string {
    const record = records.get(id);
    if (!record) return '';
    return strip(preview.text(record.namespace, record.key, record.fallback, record.values));
  }
  function valueOf(binding: Binding) { return binding.attribute ? (binding.node as Element).getAttribute(binding.attribute) : binding.node.nodeValue; }
  function write(binding: Binding, value: string) {
    if (binding.attribute) (binding.node as Element).setAttribute(binding.attribute, value); else binding.node.nodeValue = value;
    binding.last = value;
  }
  function render(parts: Part[]) { return parts.map(part => typeof part === 'string' ? part : part.html ? decode(translated(part.id)) : translated(part.id)).join(''); }
  function info(message?: string) {
    if (status) status.textContent = message || (capturedAtBoot ? `${bindings.size} live labels${skipped ? ` · ${skipped} complex/skipped` : ''}` : 'Reload once to enable live capture.');
    if (select) { select.value = session?.locale || ''; select.disabled = !capturedAtBoot || busy; }
  }
  function capture(node: Text | Element, attribute?: string) {
    const value = attribute ? (node as Element).getAttribute(attribute) : node.nodeValue;
    if (!value || !value.includes(`FM${nonce}:`)) return;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    const excluded = element?.closest('script, style, textarea, [contenteditable]:not([contenteditable="false"]), [data-fm-language-preview="off"]');
    const canBind = !excluded && (!attribute || visibleAttributes.has(attribute));
    const parts: Part[] = [];
    let cursor = 0;
    for (const match of value.matchAll(pair)) {
      const id = Number(match[1]);
      if (!records.has(id)) continue;
      parts.push(strip(value.slice(cursor, match.index)), { id, html: strip(match[2]!) !== translated(id) });
      cursor = match.index! + match[0].length;
    }
    parts.push(strip(value.slice(cursor)));
    const binding: Binding = { node, attribute, parts, last: strip(value) };
    const slots = byNode.get(node) || new Map();
    const previous = slots.get(attribute || '');
    if (previous) bindings.delete(previous);
    if (canBind && parts.some(part => typeof part !== 'string')) {
      slots.set(attribute || '', binding); byNode.set(node, slots); bindings.add(binding);
      write(binding, render(parts));
    } else {
      if (canBind) skipped++;
      write(binding, strip(value));
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = strip(element.value);
    }
  }
  function scan(node: Node) {
    if (node === host) return;
    if (node.nodeType === Node.TEXT_NODE) capture(node as Text);
    else if (node.nodeType === Node.ELEMENT_NODE) {
      for (const attribute of Array.from((node as Element).attributes)) capture(node as Element, attribute.name);
    }
    for (const child of Array.from(node.childNodes)) scan(child);
  }
  function repaint() {
    if (!booted) return;
    syncContext();
    // Capture pending inserts before changing existing bindings; never replace DOM subtrees.
    for (const mutation of observer?.takeRecords() || []) processMutation(mutation);
    for (const binding of bindings) {
      if (!binding.node.isConnected || valueOf(binding) !== binding.last) { bindings.delete(binding); continue; }
      const value = render(binding.parts);
      if (value !== binding.last) write(binding, value);
    }
    const context = preview.context();
    document.documentElement.lang = context.locale;
    document.documentElement.dir = LANGUAGE_PACKS.find(p => p.code === context.locale)?.direction || 'ltr';
    info();
  }
  function processMutation(mutation: MutationRecord) {
    if (mutation.type === 'childList') for (const node of Array.from(mutation.addedNodes)) scan(node);
    else if (mutation.type === 'attributes') capture(mutation.target as Element, mutation.attributeName!);
    else capture(mutation.target as Text);
  }
  function boot() {
    if (booted) return;
    booted = true;
    observer = new MutationObserver(mutations => { for (const mutation of mutations) processMutation(mutation); });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    // Value assignments are data, not preview labels. Keep provenance out of form models.
    for (const prototype of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype, HTMLOptionElement.prototype]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor?.set && descriptor.get) Object.defineProperty(prototype, 'value', { ...descriptor, set(value) { descriptor.set!.call(this, typeof value === 'string' ? strip(value) : value); } });
    }
    scan(document.documentElement);
  }
  async function setLocale(locale: string | null) {
    if (locale !== null && !LANGUAGE_PACKS.some(pack => pack.code === locale)) throw Error(`Language pack is not installed: ${locale}`);
    if (!capturedAtBoot) throw Error('Use the tester’s Reload & start button once to enable live capture.');
    const request = ++revision;
    busy = true; info('Loading catalogs…');
    try {
      await options.ensureAll();
      if (request !== revision) return;
      session = { active: true, locale }; persist(); repaint();
      window.dispatchEvent(new CustomEvent('fm:language:preview', { detail: { locale: preview.context().locale } }));
    } finally { if (request === revision) { busy = false; info(); } }
  }
  function panel() {
    if (host?.isConnected || window.top !== window) return;
    host = document.createElement('div'); host.id = 'fm-language-tester';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>:host{all:initial;position:fixed;top:8px;left:8px;z-index:2147483647;direction:ltr}section{box-sizing:border-box;width:228px;max-width:calc(100vw - 16px);padding:9px;background:#16202c;color:#fff;border:1px solid #556477;border-radius:8px;box-shadow:0 3px 12px #0004;font:12px/1.4 system-ui,sans-serif}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}button,select{font:inherit}button{cursor:pointer}header button{background:transparent;border:0;color:#fff;font-size:18px;line-height:16px}select{box-sizing:border-box;width:100%;padding:4px;border-radius:4px;color:#17212b;background:#fff}p{margin:6px 0 0;color:#cbd5e1;font-size:10px}#start{width:100%;margin-top:6px;padding:4px}</style><section aria-label="Developer language tester"><header><strong>Language preview</strong><button id="close" aria-label="Close language tester and restore account language" title="Restore account language">×</button></header><select aria-label="Preview language"></select><button id="start">Reload &amp; start</button><p role="status"></p></section>`;
    select = shadow.querySelector('select')!; status = shadow.querySelector<HTMLElement>('[role="status"]')!; bootstrap = shadow.querySelector<HTMLButtonElement>('#start')!;
    select.add(new Option('Account language', ''));
    for (const pack of LANGUAGE_PACKS) select.add(new Option(pack.label, pack.code));
    select.onchange = () => { void setLocale(select!.value || null).catch(error => info(error.message)); };
    bootstrap.hidden = capturedAtBoot;
    bootstrap.onclick = () => {
      try { session = { active: true, locale: null }; persist(); location.reload(); }
      catch { info('Tab storage is unavailable; live capture could not start.'); }
    };
    shadow.querySelector('#close')!.addEventListener('click', close);
    (document.body || document.documentElement).append(host); info();
  }
  function open() {
    panel();
    if (capturedAtBoot) { session ||= { active: true, locale: null }; persist(); boot(); void options.ensureAll().then(repaint).catch(error => info(error.message)); }
    return api;
  }
  function close() {
    revision++; busy = false;
    session = null;
    try { persist(); } catch { /* Restore this page even when storage is denied. */ }
    repaint(); host?.remove(); host = undefined; select = undefined; status = undefined;
  }
  const api = { open, close, setLocale, status: () => ({ active: !!session, live: capturedAtBoot, locale: session?.locale || null, bindings: bindings.size, skipped }) };
  if (capturedAtBoot) {
    boot(); syncContext();
    window.addEventListener('storage', event => {
      if (event.key !== storageKey) return;
      revision++; busy = false;
      try {
        const saved = JSON.parse(event.newValue || 'null');
        session = saved?.active === true ? { active: true, locale: LANGUAGE_PACKS.some(p => p.code === saved.locale) ? saved.locale : null } : null;
        void options.ensureAll().then(repaint).catch(error => info(error.message));
      } catch { /* Ignore malformed developer-session data. */ }
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open, { once: true }); else queueMicrotask(open);
  }
  return {
    api, repaint,
    register(bundle: CatalogBundle) { preview.register(bundle); },
    text(namespace: string, key: string, fallback: string, values: any, ordinary: () => string) {
      if (!session || !capturedAtBoot) return ordinary();
      syncContext();
      const id = ++nextId;
      records.set(id, { namespace, key, fallback: strip(fallback), values });
      const text = translated(id);
      return `\u2063\u2063FM${nonce}:${id}\u2063${text}\u2063\u2063/FM${nonce}:${id}\u2063`;
    }
  };
}
