import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { fileAsset, type GeneratedAsset, type Generator } from "./index.js";

/**
 * One-shot: the promos libraries/apps/tab-promos/project.js registers today, evaluated as the page runs it. Text the
 * file words through PlatformLanguage keeps its `tab-promos` key; the `realEnabled(context)` predicate becomes the
 * context flag it reads; bundled screenshots become library assets.
 */
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MARK = "\u0000";
type Text = string | { key: string; text: string };
const keyed = (value: unknown): Text => {
  const raw = String(value ?? "");
  const match = raw.match(/^\u0000([^\u0000]+)\u0000([\s\S]*)$/);
  return match ? { key: match[1]!, text: match[2]! } : raw;
};
const optional = (value: unknown) => (value === undefined || value === null || value === "" ? undefined : keyed(value));

const assets: GeneratedAsset[] = [];
export const tabPromoGenerator: Generator = {
  kind: "tab_promo",
  assets,
  run() {
    const definitions: Record<string, any>[] = [];
    const window = {
      Portal: { capabilities: { value: () => false }, util: { injectCSS() {} } },
      FirstMateEmbeddableApps: { registerApp() {} }
    } as Record<string, any>;
    // The file reads `globalThis.PlatformLanguage`: the context's own global.
    const PlatformLanguage = { text: (_ns: string, key: string, fallback: string) => `${MARK}${key}${MARK}${fallback}`, htmlText: (_ns: string, _key: string, fallback: string) => fallback };
    vm.runInNewContext(readFileSync(path.join(PUBLIC, "libraries", "apps", "tab-promos", "project.js"), "utf8"), { window, PlatformLanguage });
    definitions.push(...window.FirstMateTabPromos.definitions());
    return definitions.map((def) => {
      const c = def.content;
      const realEnabled = def.realEnabled ? String(def.realEnabled).match(/context\.([A-Za-z][A-Za-z0-9_]*)\s*===\s*true/) : null;
      if (def.realEnabled && !realEnabled) throw new Error(`Promo ${def.id}: realEnabled is not a context flag check.`);
      const images = c.images.map((image: Record<string, string>) => {
        const file = fileAsset(path.join(PUBLIC, image.src!.replace(/^\//, "")));
        assets.push(file.asset);
        return { src: file.ref, alt: keyed(image.alt), caption: keyed(image.caption) };
      });
      return {
        id: def.id,
        data: {
          tab_id: def.tabId, title: keyed(def.title), ...(def.icon ? { icon: def.icon } : {}), order: def.order ?? 55,
          flag: def.flag, replaces_capability: def.replacesCapability, ...(realEnabled ? { real_enabled_context: realEnabled[1] } : {}),
          content: {
            eyebrow: keyed(c.eyebrow), headline: keyed(c.headline), accent: keyed(c.accent), intro: keyed(c.intro),
            hero_pill: optional(c.heroPill), rules_eyebrow: optional(c.rulesEyebrow), rules_title: keyed(c.rulesTitle), rules_body: keyed(c.rulesBody),
            rules_pill: optional(c.rulesPill), footer_title: optional(c.footerTitle),
            images,
            features: c.features.map((feature: Record<string, string>) => ({ title: keyed(feature.title), body: keyed(feature.body) }))
          }
        }
      };
    });
  }
};
