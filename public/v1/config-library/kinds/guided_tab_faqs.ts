import type { LibraryKind } from "../contracts.js";
import { faqSchema, type TabFaqs } from "../../guided-experiences/contracts.js";
import { experienceMissing, GUIDED_TAB_FAQS_KIND } from "../../guided-experiences/library-checks.js";

/**
 * The assistant's suggested questions on one project tab (docs/architecture/guided-experiences.md, "Assistant
 * suggestions"): one entry per tab, id = the tab's app id, up to eight questions. A `play` question names an
 * experience and is offered only where that experience exists for the person.
 */
export const GUIDED_TAB_FAQS = GUIDED_TAB_FAQS_KIND;

export const guidedTabFaqsKind: LibraryKind<TabFaqs> = {
  kind: GUIDED_TAB_FAQS,
  title: "Assistant questions per tab",
  description: "The suggested questions shown above the assistant's composer on a project tab: ask the assistant, or replay a tour.",
  schema: faqSchema as unknown as LibraryKind<TabFaqs>["schema"],
  titleOf: (data) => `Questions on ${data.tab}`,
  validate(data, ctx) {
    const errors: string[] = [];
    if (data.tab !== ctx.id) errors.push(`The questions' tab ${data.tab} is not the entry's id ${ctx.id}.`);
    const ids = data.questions.map((question) => question.id);
    if (new Set(ids).size !== ids.length) errors.push("Two questions have the same id.");
    for (const question of data.questions) {
      if (question.action === "play" && question.experience && experienceMissing(ctx.registries, question.experience)) errors.push(`${question.id} plays ${question.experience}, which is not an experience.`);
    }
    return errors;
  }
};
