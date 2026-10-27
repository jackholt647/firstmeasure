import type { Generator } from "./index.js";
import { guidedDefinitions, plain } from "./guided_experience.js";

/** One-shot: each tab's questions together with what other files added to it (addTabFaqs), merged as they were read. */
export const guidedTabFaqsGenerator: Generator = {
  kind: "guided_tab_faqs",
  async run() {
    const { registry } = await guidedDefinitions();
    return registry.listTabFaqs().map((faqs) => ({ id: faqs.tab, data: plain(faqs) }));
  }
};
