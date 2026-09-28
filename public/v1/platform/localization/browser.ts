import { LANGUAGE_PACKS, TRANSLATION_LANGUAGES } from "./languages.js";
import { createDeveloperTester } from "./developer-tester.js";
import { canonicalTerm } from './terminology.js';
import { createLanguage, resolveContext, SUPPORTED_LOCALES, type CatalogBundle, type LanguageContext } from "./core.js";

const root = window as any;
const script = document.currentScript as HTMLScriptElement | null;
const base = new URL("./catalogs/", script?.src || `${location.origin}/libraries/platform-language/platform-language.js`).href;
const engine = createLanguage(resolveContext(), (key, locale) => {
  root.dispatchEvent(new CustomEvent("fm:language:missing", { detail: { key, locale } }));
});
const loaded = new Map<string, Promise<void>>();
let company: Record<string, unknown> = {};
let personal: Record<string, unknown> = {};
let enabled = false;
let index: Promise<any> | undefined;
const tester = createDeveloperTester({ context: () => engine.context(), ensureAll: async () => { const metadata = await manifest(); await ensure(Object.keys(metadata.namespaces)); } });
const registered:CatalogBundle[]=[];
function register(bundle: CatalogBundle) { registered.push(bundle); engine.register(bundle); tester.register(bundle); }
function text(namespace: string, key: string, fallback = key, values: any = {}) { return tester.text(namespace, key, fallback, values, () => engine.text(namespace, key, fallback, values)); }
function htmlText(namespace: string, key: string, fallback = key, values: any = {}) { return tester.text(namespace, key, fallback, values, () => engine.text(namespace, key, fallback, values)); }
function manifest() {
  return index ??= fetch(`${base}manifest.json`, { cache: "no-cache" }).then(r => { if (!r.ok) throw Error("Language catalog unavailable"); return r.json(); }).catch(error => { index = undefined; throw error; });
}
async function ensure(namespaces: string[] = []) {
  const metadata = await manifest();
  await Promise.all([...new Set(["shared", "platform", "terminology", ...namespaces])].map(namespace => {
    if (!/^[a-z0-9_-]+$/.test(namespace)) throw Error("Invalid language namespace");
    if (!metadata.namespaces[namespace]) return; // Empty apps share the platform catalog.
    if (!loaded.has(namespace)) loaded.set(namespace, fetch(`${base}${metadata.namespaces[namespace]}`).then(async r => {
      if (!r.ok) throw Error(`Language catalog unavailable: ${namespace}`);
      register(await r.json() as CatalogBundle);
    }).catch(error => { loaded.delete(namespace); throw error; }));
    return loaded.get(namespace);
  }));
  tester.repaint();
}
function configure(next: { company?: Record<string, unknown>; personal?: Record<string, unknown>; context?: LanguageContext }) {
  if (next.company) company = { ...next.company };
  if (next.personal) personal = { ...next.personal };
  const context = next.context || resolveContext(company, enabled ? personal : {});
  engine.configure(context);
  document.documentElement.lang = context.locale;
  document.documentElement.dir = LANGUAGE_PACKS.find(pack => pack.code === context.locale)?.direction || "ltr";
  root.dispatchEvent(new CustomEvent("fm:language:updated", { detail: { context } }));
  tester.repaint();
  return context;
}
async function refresh() {
  const result = await root.PlatformAPI?.localization?.get?.();
  if (result) {
    enabled = result.enabled === true;
    configure({ company: result.company, personal: result.personal, context: result.context });
  }
  const metadata = await manifest();
  await ensure(metadata.eagerNamespaces || []);
  return engine.context();
}
root.PlatformLanguage = {
  canonicalTerm,
  previewTerminology(locale:string,mappings:any) { const preview=createLanguage({...engine.context(),locale}); for(const bundle of registered)preview.register(bundle); preview.setTerminology(mappings); return preview; },
  ...engine, text, htmlText, register, configure, refresh, ensure, tester: tester.api, enabled: () => enabled, supportedLocales: SUPPORTED_LOCALES, supportedLanguages: LANGUAGE_PACKS, translationLanguages: TRANSLATION_LANGUAGES, companyContext: () => ({ ...company }),
  forApp(namespace: string) { return { ...engine, text: (key: string, fallback: string, values?: any) => text(namespace, key, fallback, values), htmlText:(key:string,fallback:string,values?:any)=>htmlText(namespace,key,fallback,values) }; }
};
// Source-owned UI strings only. User values never pass through a page-wide replacement.
root.FMText = (namespace: string, key: string, fallback: string, values?: any) => text(namespace, key, fallback, values);
root.addEventListener("fm:user-preferences:updated", (event: any) => configure({ personal: event.detail?.preferences || {} }));
