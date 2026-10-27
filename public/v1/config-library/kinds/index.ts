import { registerLibraryKind } from "../kinds.js";
import { scopeTemplateKind } from "./scope_template.js";
import { formTemplateKind } from "./form_template.js";
import { automationRuleDefaultKind } from "./automation_rule_default.js";

/**
 * Every config library kind, registered once. One import and one call per kind file; a kind's file belongs to the
 * domain that reads its entries.
 */
let registered = false;
export function registerAllLibraryKinds() {
  if (registered) return;
  registered = true;
  registerLibraryKind(scopeTemplateKind);
  registerLibraryKind(formTemplateKind);
  registerLibraryKind(automationRuleDefaultKind);
}
