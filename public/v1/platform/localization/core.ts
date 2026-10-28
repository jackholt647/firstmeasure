import { IntlMessageFormat } from "intl-messageformat";
import { terminologyComposer, terminologyOverride, canonicalTerm, terminologyDefault } from './terminology.js';

import { SUPPORTED_LOCALES } from "./languages.js";
export { SUPPORTED_LOCALES } from "./languages.js";
export type Locale = typeof SUPPORTED_LOCALES[number];
export type LanguageContext = {
  locale: Locale; measurement_system: "imperial" | "metric";
  time_zone?: string; currency?: string;
};
export type Message = string | { message: string; format: "icu" };
export type Catalog = Record<string, Message>;
export type CatalogBundle = { version: string; namespaces: Record<string, Partial<Record<Locale, Catalog>>> };
export type Terminology = { labels?: Record<string, Record<string, string>>; localized_labels?: Record<string, Record<string, Record<string, string>>> };
export type LanguageSnapshot = LanguageContext & { schema_version: 1; catalog_versions: Record<string, string>; terminology: Terminology };

export function supportedLocale(value: unknown, fallback: Locale = "en-US"): Locale {
  if (value === "en" || value === "en_US") return "en-US";
  if (value === "en_GB") return "en-GB";
  return SUPPORTED_LOCALES.includes(value as Locale) ? value as Locale : fallback;
}

/** UI language never determines monetary currency, physical units or a time zone. */
export function resolveContext(company: Record<string, unknown> = {}, personal: Record<string, unknown> = {}): LanguageContext {
  return {
    locale: supportedLocale(personal.interface_locale || company.locale || company.report_language),
    measurement_system: company.measurement_system === "metric" ? "metric" : "imperial",
    ...(typeof company.time_zone === "string" && company.time_zone ? { time_zone: company.time_zone } : {}),
    ...(typeof company.currency === "string" && company.currency ? { currency: company.currency } : {})
  };
}

/** `frozenTerminology`: an issued document's language, whose English term labels are the frozen catalog's, not the
 * library's current defaults. */
export function createLanguage(initial: LanguageContext = resolveContext(), missing?: (key: string, locale: Locale) => void, options: { frozenTerminology?: boolean } = {}) {
  let context = { ...initial };
  const catalogs = new Map<string, Partial<Record<Locale, Catalog>>>();
  const versions = new Map<string, string>();
  const formatters = new Map<string, IntlMessageFormat>();
  const reported = new Set<string>();
  let terminology: Terminology = {};
  const composers = new Map<string, (value:string)=>string>();
  function literal(namespace:string, value:string, html=false) {
    const id=namespace+':'+html;
    if(!composers.has(id))composers.set(id,terminologyComposer(namespace,context.locale,terminology,(key,fallback)=>rawTerm(key,fallback),html));
    return composers.get(id)!(value);
  }
  // English term labels are the config library's terminology entries (live on dev); a language pack translates
  // them. The `terminology` catalog's English copy is what an issued document froze, and the fallback before the
  // terms have loaded in a page.
  function rawTerm(key:string, fallback:string) {
    const entries=catalogs.get('terminology');
    const localized=options.frozenTerminology||context.locale!=='en-US'?entries?.[context.locale]?.[key]:undefined;
    const value=localized ?? (options.frozenTerminology?undefined:terminologyDefault(key)) ?? entries?.['en-US']?.[key];
    return typeof value==='string'?value:fallback;
  }
  function register(bundle: CatalogBundle) {
    for (const [namespace, locales] of Object.entries(bundle.namespaces)) {
      catalogs.set(namespace, { ...catalogs.get(namespace), ...locales });
      versions.set(namespace, bundle.version);
    }
    formatters.clear();
    composers.clear();
  }
  function text(namespace: string, key: string, fallback = key, values: Record<string, string | number | boolean | Date> = {}, html=false): string {
    const locales = catalogs.get(namespace);
    const localized = locales?.[context.locale]?.[key];
    const entry = localized ?? locales?.["en-US"]?.[key];
    if (entry === undefined || (!context.locale.startsWith("en-") && localized === undefined)) {
      const id = `${context.locale}:${namespace}:${key}`;
      if (!reported.has(id)) { reported.add(id); missing?.(`${namespace}.${key}`, context.locale); }
      if (entry === undefined) return interpolateFallback(namespace, key, fallback, values);
    }
    if (typeof entry === "string") return namespace==='terminology'?entry:literal(namespace,entry,html);
    return format(namespace, key, entry.message, fallback, values, html, true);
  }
  /** One ICU formatting path for catalog messages and for fallbacks, so `{name}`
   * placeholders, plurals and missing values behave the same either way.
   * Catalog literals are composed with terminology; a fallback is not, because
   * callers may have built user values into it. */
  function format(namespace: string, key: string, message: string, fallback: string, values: Record<string, unknown>, html: boolean, compose: boolean): string {
    const id = `${context.locale}:${namespace}:${key}:${html}:${compose}:${message}`;
    let formatter = formatters.get(id);
    if (!formatter) {
      const original = new IntlMessageFormat(message, context.locale, undefined, { ignoreTag: true });
      const composeNodes=(nodes:any[]):any[]=>nodes.map(node=>node.type===0?{...node,value:literal(namespace,node.value,html)}:node.options?{...node,options:Object.fromEntries(Object.entries(node.options).map(([key,option]:[string,any])=>[key,{...option,value:composeNodes(option.value)}]))}:node.children?{...node,children:composeNodes(node.children)}:node);
      formatter = compose ? new IntlMessageFormat(composeNodes(original.getAst()), context.locale, undefined, { ignoreTag:true }) : original;
      if (formatters.size > 2000) formatters.clear();
      formatters.set(id, formatter);
    }
    // Template-literal migration preserves JavaScript string coercion exactly.
    const parameters = key.startsWith("m_") ? Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])) : values;
    try { return String(formatter.format(parameters as any)); }
    catch { missing?.(`${namespace}.${key}:format`, context.locale); return fallback; }
  }
  function interpolateFallback(namespace: string, key: string, fallback: string, values: unknown): string {
    if (typeof fallback !== "string" || !fallback.includes("{") || !values || typeof values !== "object" || !Object.keys(values).length) return fallback;
    // A fallback that is not a valid message (stray braces) stays as written.
    try { return format(namespace, key, fallback, fallback, values as Record<string, unknown>, false, false); }
    catch { return fallback; }
  }
  function term(key: string, fallback: string, mappings: Terminology = terminology) {
    const [namespace, name] = key.split(".");
    if (!namespace || !name) return fallback;
    const override=terminologyOverride(key,context.locale,mappings);
    if(override)return override;
    const base=rawTerm(canonicalTerm(key),rawTerm(key,fallback));
    if(mappings===terminology)return literal(namespace,base);
    return terminologyComposer(namespace,context.locale,mappings,(id,label)=>rawTerm(id,label))(base);
  }
  function snapshot(mappings: Terminology = terminology): LanguageSnapshot {
    return JSON.parse(JSON.stringify({ schema_version: 1, ...context, catalog_versions: Object.fromEntries(versions), terminology:mappings }));
  }
  return {
    register, text, term, snapshot,
    htmlText: (namespace:string,key:string,fallback=key,values:Record<string,string|number|boolean|Date>={})=>text(namespace,key,fallback,values,true),
    setTerminology: (next:Terminology={})=>{ terminology=JSON.parse(JSON.stringify(next)); composers.clear(); formatters.clear(); },
    /** The terms themselves (the terminology contract) changed: compose again. */
    termsChanged: ()=>{ composers.clear(); formatters.clear(); },
    error: (code: string, fallback: string) => catalogs.get('errors')?.['en-US']?.[code] !== fallback ? fallback : text('errors', code, fallback),
    formatLocale: (legacy?: string) => context.locale === 'en-US' ? legacy : context.locale,
    context: () => ({ ...context }),
    configure: (next: LanguageContext) => { context = { ...next }; composers.clear(); formatters.clear(); },
    number: (value: number, options: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(context.locale, options).format(value),
    date: (value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) => new Intl.DateTimeFormat(context.locale, { ...(context.time_zone ? { timeZone: context.time_zone } : {}), ...options }).format(new Date(value)),
    money: (value: number, currency: string, options: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(context.locale, { ...options, style: "currency", currency }).format(value),
    list: (values: string[], options: Intl.ListFormatOptions = {}) => new Intl.ListFormat(context.locale, options).format(values),
    namespaces: () => [...catalogs.keys()]
  };
}
