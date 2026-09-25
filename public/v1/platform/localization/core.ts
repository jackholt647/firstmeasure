import { IntlMessageFormat } from "intl-messageformat";

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

export function createLanguage(initial: LanguageContext = resolveContext(), missing?: (key: string, locale: Locale) => void) {
  let context = { ...initial };
  const catalogs = new Map<string, Partial<Record<Locale, Catalog>>>();
  const versions = new Map<string, string>();
  const formatters = new Map<string, IntlMessageFormat>();
  const reported = new Set<string>();
  function register(bundle: CatalogBundle) {
    for (const [namespace, locales] of Object.entries(bundle.namespaces)) {
      catalogs.set(namespace, { ...catalogs.get(namespace), ...locales });
      versions.set(namespace, bundle.version);
    }
    formatters.clear();
  }
  function text(namespace: string, key: string, fallback = key, values: Record<string, string | number | boolean | Date> = {}): string {
    const locales = catalogs.get(namespace);
    const entry = locales?.[context.locale]?.[key] ?? locales?.["en-US"]?.[key];
    if (entry === undefined) {
      const id = `${context.locale}:${namespace}:${key}`;
      if (!reported.has(id)) { reported.add(id); missing?.(`${namespace}.${key}`, context.locale); }
      return fallback;
    }
    if (typeof entry === "string") return entry;
    const id = `${context.locale}:${namespace}:${key}:${entry.message}`;
    let formatter = formatters.get(id);
    if (!formatter) {
      formatter = new IntlMessageFormat(entry.message, context.locale, undefined, { ignoreTag: true });
      if (formatters.size > 2000) formatters.clear();
      formatters.set(id, formatter);
    }
    // Template-literal migration preserves JavaScript string coercion exactly.
    const parameters = key.startsWith("m_") ? Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])) : values;
    try { return String(formatter.format(parameters)); }
    catch { missing?.(`${namespace}.${key}:format`, context.locale); return fallback; }
  }
  function term(key: string, fallback: string, mappings: Terminology = {}) {
    const [namespace, name] = key.split(".");
    if (!namespace || !name) return fallback;
    const localized = mappings.localized_labels?.[context.locale]?.[namespace]?.[name];
    // Existing overrides remain English terminology, including British English.
    const legacy = context.locale.startsWith("en-") ? mappings.labels?.[namespace]?.[name] : undefined;
    return localized || legacy || text("terminology", key, fallback);
  }
  function snapshot(terminology: Terminology = {}): LanguageSnapshot {
    return JSON.parse(JSON.stringify({ schema_version: 1, ...context, catalog_versions: Object.fromEntries(versions), terminology }));
  }
  return {
    register, text, term, snapshot,
    error: (code: string, fallback: string) => context.locale === 'en-US' || catalogs.get('errors')?.['en-US']?.[code] !== fallback ? fallback : text('errors', code, fallback),
    formatLocale: (legacy?: string) => context.locale === 'en-US' ? legacy : context.locale,
    context: () => ({ ...context }),
    configure: (next: LanguageContext) => { context = { ...next }; },
    number: (value: number, options: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(context.locale, options).format(value),
    date: (value: string | number | Date, options: Intl.DateTimeFormatOptions = {}) => new Intl.DateTimeFormat(context.locale, { ...(context.time_zone ? { timeZone: context.time_zone } : {}), ...options }).format(new Date(value)),
    money: (value: number, currency: string, options: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(context.locale, { ...options, style: "currency", currency }).format(value),
    list: (values: string[], options: Intl.ListFormatOptions = {}) => new Intl.ListFormat(context.locale, options).format(values),
    namespaces: () => [...catalogs.keys()]
  };
}
