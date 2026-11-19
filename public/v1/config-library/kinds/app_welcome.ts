import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { copySchema } from "../../guided-experiences/contracts.js";
import { isOfferableApp } from "../../platform/app-experience/offers.js";

/**
 * App welcomes (docs/architecture/app-experience.md, "Offers"): the static advertisement an offered app shows until
 * the organization starts it. One entry per offerable app id (any app with an organization switch; which switches an
 * offer holds back stays code, offers.ts); an offered app with no entry shows offers.ts `placeholderWelcome`. Read
 * live on the server into each person's app entitlements; the browser draws it with libraries/app-runtime/app-welcome.js. Copy is `{ key, text }` in the `guided-experiences` namespace.
 */
export const APP_WELCOME = "app_welcome";

const schema = z.object({
  /** The illustration (app-welcome.js `icons`); its colours are the organization's, the theme's only a fallback. */
  theme: z.enum(["photos", "documents", "portal", "equipment", "materials", "money", "checklists", "scheduling", "comms", "generic"]),
  /** `page`: one full-width page (the copy, then the illustration below it) instead of the default two sides. */
  layout: z.enum(["page"]).optional(),
  /** A switch whose required setup workflow Get Started continues into (app-setup-workflows.js). */
  setup: z.string().max(120).optional(),
  setup_note: copySchema.optional(),
  eyebrow: copySchema,
  headline: copySchema,
  description: copySchema,
  benefits: z.array(copySchema).min(1).max(6),
  caption: copySchema
}).strict();
export type AppWelcome = z.infer<typeof schema>;

export const appWelcomeKind: LibraryKind<AppWelcome> = {
  kind: APP_WELCOME,
  title: "App welcomes",
  description: "The advertisement an offered app shows until the organization starts it.",
  schema,
  titleOf: (data, id) => `${id}: ${data.headline.text}`,
  validate(data, ctx) {
    const errors: string[] = [];
    if (!isOfferableApp(ctx.id)) errors.push(`${ctx.id} is not an offerable app (an app with an organization switch).`);
    if (data.setup && !ctx.registries.capability(data.setup)) errors.push(`setup: ${data.setup} is not a registered capability.`);
    if (data.setup_note && !data.setup) errors.push("A setup note belongs to a welcome that names its setup.");
    return errors;
  }
};
