import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { copySchema } from "../../guided-experiences/contracts.js";
import { APP_OFFERS } from "../../platform/app-experience/offers.js";

/**
 * App welcomes (docs/architecture/app-experience.md, "Offers"): the static advertisement an offered app shows until
 * the organization starts it. One entry per offered app id (a key of APP_OFFERS, which stays code: which switches an
 * offer holds back). Read live on the server into each person's app entitlements; the browser draws it with
 * libraries/app-runtime/app-welcome.js. Copy is `{ key, text }` in the `guided-experiences` namespace.
 */
export const APP_WELCOME = "app_welcome";

const schema = z.object({
  /** The illustration and colours (app-welcome.js `icons`). */
  theme: z.enum(["photos", "documents", "portal", "equipment", "materials", "money", "checklists"]),
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
    if (!Object.prototype.hasOwnProperty.call(APP_OFFERS, ctx.id)) errors.push(`${ctx.id} is not an offered app (APP_OFFERS).`);
    if (data.setup && !ctx.registries.capability(data.setup)) errors.push(`setup: ${data.setup} is not a registered capability.`);
    if (data.setup_note && !data.setup) errors.push("A setup note belongs to a welcome that names its setup.");
    return errors;
  }
};
