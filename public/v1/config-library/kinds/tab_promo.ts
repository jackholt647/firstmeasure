import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { ASSET_REF } from "../assets.js";

/**
 * Project tab promos (docs/project-tab-promos.md): a read-only "coming soon" page shown in place of a project tab the
 * organization does not have yet, where an opt-in capability is on. One entry per promo, id = the promo id (its app
 * id is `project.<id>`). Pages read them directly (`GET /v1/config-library/read/tab_promo`); the render engine stays
 * in libraries/apps/tab-promos/project.js. Images are library assets (`asset:<sha256>`).
 */
export const TAB_PROMO = "tab_promo";

/** Text shown as is, or a `tab-promos` language key with its English (a reworded text needs a new key, or none). */
const text = z.union([
  z.string().trim().min(1).max(2000),
  z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,90}$/), text: z.string().trim().min(1).max(2000) }).strict()
]);
const asset = z.string().regex(ASSET_REF, "An image is a library asset: asset:<sha256>.");
const capability = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);

const schema = z.object({
  /** The project tab it stands in for (its route id, shared with the real app). */
  tab_id: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
  title: text,
  icon: z.string().regex(/^fa-[a-z0-9-]{1,40}$/).optional(),
  order: z.number().int().min(0).max(1000).default(55),
  /** The opt-in capability that shows the promo. */
  flag: capability,
  /** The real app's capability: while it is on, the promo is hidden. */
  replaces_capability: capability,
  /** A flag of the project window's context that also says the real app is on (the promo then hides). */
  real_enabled_context: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/).optional(),
  content: z.object({
    eyebrow: text, headline: text, accent: text, intro: text,
    hero_pill: text.optional(),
    rules_eyebrow: text.optional(), rules_title: text, rules_body: text, rules_pill: text.optional(),
    footer_title: text.optional(),
    /** The hero screenshot, then the rules screenshot. */
    images: z.array(z.object({ src: asset, alt: text, caption: text }).strict()).length(2),
    features: z.array(z.object({ title: text, body: text }).strict()).min(1).max(6)
  }).strict()
}).strict();
export type TabPromo = z.infer<typeof schema>;

export const tabPromoKind: LibraryKind<TabPromo> = {
  kind: TAB_PROMO,
  title: "Project tab promos",
  description: "Read-only coming-soon pages shown in place of a project tab, behind an opt-in capability.",
  idPattern: /^[a-z][a-z0-9_]{1,59}$/,
  schema: schema as unknown as LibraryKind<TabPromo>["schema"],
  browser: true,
  titleOf: (data) => (typeof data.title === "string" ? data.title : data.title.text),
  assetsOf: (data) => data.content.images.map((image) => image.src.replace(/^asset:/, "")),
  validate(data, ctx) {
    const errors: string[] = [];
    for (const [field, key] of [["flag", data.flag], ["replaces_capability", data.replaces_capability]] as const) {
      if (!ctx.registries.capability(key)) errors.push(`${field}: ${key} is not a registered capability.`);
    }
    if (data.flag === data.replaces_capability) errors.push("A promo's flag is not the capability it stands in for.");
    return errors;
  }
};
