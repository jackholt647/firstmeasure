import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createLanguage, resolveContext, type CatalogBundle, type LanguageContext, type LanguageSnapshot, type Terminology } from "./core.js";

// Works from the TypeScript tree and the compiled dist/platform tree.
const roots = [new URL("../../../libraries/platform-language/catalogs/", import.meta.url), new URL("../../../../libraries/platform-language/catalogs/", import.meta.url)];
const bundles = new Map<string, Promise<CatalogBundle>>();
async function readCatalog(file: string) {
  for (const root of roots) {
    try { return JSON.parse(await readFile(fileURLToPath(new URL(file, root)), "utf8")); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error(`Missing language catalog: ${file}`);
}

export async function frozenCatalogs(snapshot: LanguageSnapshot, namespaces: string[]) {
  const result: CatalogBundle[] = [];
  for (const namespace of namespaces) {
    const version = snapshot.catalog_versions[namespace];
    if (!version) continue;
    if (!/^[a-z0-9_-]+$/.test(namespace) || !/^[a-f0-9]{16}$/.test(version)) throw new Error("Invalid language catalog reference");
    result.push(await readCatalog(`${namespace}.${version}.json`));
  }
  return result;
}

/** Request/job-local instance: no mutable locale shared between tenants or workers. */
export async function serverLanguage(context: LanguageContext = resolveContext(), namespaces = ["shared"], frozen?: LanguageSnapshot) {
  const language = createLanguage(frozen || context);
  language.setTerminology(frozen?.terminology || {});
  const manifest = frozen ? null : await readCatalog("manifest.json");
  for (const namespace of new Set(['terminology', ...namespaces])) {
    if (!/^[a-z0-9_-]+$/.test(namespace)) throw new Error("Invalid language namespace");
    const version = frozen?.catalog_versions[namespace];
    if (version && !/^[a-f0-9]{16}$/.test(version)) throw new Error("Invalid language catalog version");
    const file = frozen ? (version ? `${namespace}.${version}.json` : undefined) : manifest.namespaces[namespace];
    if (!file) continue;
    if (!bundles.has(file)) bundles.set(file, readCatalog(file).catch(error => { bundles.delete(file); throw error; }));
    language.register(await bundles.get(file)!);
  }
  return language;
}

/** Store this with issued documents or queued emails, never the author's UI override. */
export async function snapshotLanguage(context: LanguageContext, namespaces: string[], terminology: Terminology = {}) {
  return (await serverLanguage(context, namespaces)).snapshot(terminology);
}
