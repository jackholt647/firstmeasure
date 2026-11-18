import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { SMS_POLICY_PAGES, smsPolicyPageProblems } from "../../messaging/policy_pages.js";

/**
 * The wording of the privacy policy and SMS terms FirstMate hosts for a business's 10DLC registration (FM-585,
 * messaging/policy_pages.ts). One entry per page (`privacy_policy`, `sms_terms`); `{{placeholder}}` is filled from the
 * registration's brand details, and a paragraph with a placeholder the business has no value for (no phone number,
 * say) is left out. Plain text only: the page escapes it and links URLs and email addresses. US carrier pages, so
 * English only.
 */
export const SMS_POLICY_PAGE = "sms_policy_page";

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[<>]/.test(value), "Plain text only.");
const schema = z.object({
  title: text(200),
  /** Shown under the title, before the sections. */
  intro: z.array(text(2000)).max(10).default([]),
  sections: z.array(z.object({ heading: text(200), paragraphs: z.array(text(2000)).min(1).max(20) }).strict()).min(1).max(30),
  /** Small print at the end of the page. */
  footer: text(500).optional()
}).strict();
export type SmsPolicyPage = z.infer<typeof schema>;

export const smsPolicyPageKind: LibraryKind<SmsPolicyPage> = {
  kind: SMS_POLICY_PAGE,
  title: "Hosted SMS policy pages",
  description: "The privacy policy and SMS terms FirstMate hosts for a business's texting registration.",
  idPattern: /^(?:privacy_policy|sms_terms)$/,
  schema,
  titleOf: (data, id) => `${id}: ${data.title}`,
  validate(data, ctx) {
    const page = SMS_POLICY_PAGES.find((candidate) => candidate.entry === ctx.id);
    if (!page) return [`${ctx.id} is not a hosted policy page (${SMS_POLICY_PAGES.map((candidate) => candidate.entry).join(", ")}).`];
    return smsPolicyPageProblems(page.id, data);
  }
};
