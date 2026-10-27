import type { Generator } from "./index.js";
import { scopeTemplateGenerator } from "./scope_template.js";
import { formTemplateGenerator } from "./form_template.js";
import { automationRuleDefaultGenerator } from "./automation_rule_default.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [scopeTemplateGenerator, formTemplateGenerator, automationRuleDefaultGenerator];
}
