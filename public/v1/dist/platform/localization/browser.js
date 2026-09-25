import { LANGUAGE_PACKS, TRANSLATION_LANGUAGES } from "./languages.js";
import { createDeveloperTester } from "./developer-tester.js";
import { createLanguage, resolveContext, SUPPORTED_LOCALES } from "./core.js";
const root = window;
const script = document.currentScript;
const base = new URL("./catalogs/", script?.src || `${location.origin}/libraries/platform-language/platform-language.js`).href;
const engine = createLanguage(resolveContext(), (key, locale) => {
    root.dispatchEvent(new CustomEvent("fm:language:missing", { detail: { key, locale } }));
});
const loaded = new Map();
let company = {};
let personal = {};
let enabled = false;
let index;
const tester = createDeveloperTester({ context: () => engine.context(), ensureAll: async () => { const metadata = await manifest(); await ensure(Object.keys(metadata.namespaces)); } });
function register(bundle) { engine.register(bundle); tester.register(bundle); }
function text(namespace, key, fallback = key, values = {}) { return tester.text(namespace, key, fallback, values, () => engine.text(namespace, key, fallback, values)); }
function manifest() {
    return index ??= fetch(`${base}manifest.json`, { cache: "no-cache" }).then(r => { if (!r.ok)
        throw Error("Language catalog unavailable"); return r.json(); }).catch(error => { index = undefined; throw error; });
}
async function ensure(namespaces = []) {
    const metadata = await manifest();
    await Promise.all([...new Set(["shared", "platform", "terminology", ...namespaces])].map(namespace => {
        if (!/^[a-z0-9_-]+$/.test(namespace))
            throw Error("Invalid language namespace");
        if (!metadata.namespaces[namespace])
            return; // Empty apps share the platform catalog.
        if (!loaded.has(namespace))
            loaded.set(namespace, fetch(`${base}${metadata.namespaces[namespace]}`).then(async (r) => {
                if (!r.ok)
                    throw Error(`Language catalog unavailable: ${namespace}`);
                register(await r.json());
            }).catch(error => { loaded.delete(namespace); throw error; }));
        return loaded.get(namespace);
    }));
    tester.repaint();
}
function configure(next) {
    if (next.company)
        company = { ...next.company };
    if (next.personal)
        personal = { ...next.personal };
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
    ...engine, text, register, configure, refresh, ensure, tester: tester.api, enabled: () => enabled, supportedLocales: SUPPORTED_LOCALES, supportedLanguages: LANGUAGE_PACKS, translationLanguages: TRANSLATION_LANGUAGES, companyContext: () => ({ ...company }),
    forApp(namespace) { return { ...engine, text: (key, fallback, values) => text(namespace, key, fallback, values) }; }
};
// Source-owned UI strings only. User values never pass through a page-wide replacement.
root.FMText = (namespace, key, fallback, values) => text(namespace, key, fallback, values);
root.addEventListener("fm:user-preferences:updated", (event) => configure({ personal: event.detail?.preferences || {} }));
