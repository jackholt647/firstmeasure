import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { libraryEntries } from "../library.js";
import { copyObjects, GUIDED_COPY_KIND, GUIDED_COPY_KINDS } from "../../guided-experiences/library-checks.js";

/**
 * The English of one string the guided-experience browser libraries draw themselves (Back, Skip step, "Your price
 * book is ready": `L('gx_ui_back', 'Back')` in libraries/guided-experiences/), edited in place on dev. Id = the
 * string's `gx_` language key; it replaces the library's built-in English for that key, everywhere, through the
 * experiences list (`copy_overrides`). Copy that belongs to an experience, a tab's questions or a setup step is edited
 * in that entry instead. Deleting the entry goes back to the library's built-in text.
 */
export const GUIDED_COPY = GUIDED_COPY_KIND;
const schema = z.object({
  /** Plain text: markup is refused, not stripped. */
  text: z.string().trim().min(1).max(2000).refine((value) => !/[<>]/.test(value), "Copy is plain text.")
}).strict();
export type GuidedCopy = z.infer<typeof schema>;

export const guidedCopyKind: LibraryKind<GuidedCopy> = {
  kind: GUIDED_COPY,
  title: "Guided library strings",
  description: "English for strings the guided-experience browser libraries draw themselves, by gx_ language key.",
  idPattern: /^gx_[a-z0-9_]{2,90}$/,
  schema,
  titleOf: (data, id) => `${id}: ${data.text.slice(0, 80)}`,
  validate(_data, ctx) {
    for (const kind of GUIDED_COPY_KINDS) {
      const holder = libraryEntries(kind).find((entry) => copyObjects(entry.data).some((copy) => copy.key === ctx.id));
      if (holder) return [`${ctx.id} is copy of ${kind}/${holder.id}: edit it there.`];
    }
    return [];
  }
};
