import { DEFAULT_AUTOMATION_RULES } from "../../work/rules.js";
import type { Generator } from "./index.js";

/** One-shot: the platform default organization rules from work/rules.ts. Their order becomes `sort_order`. */
export const automationRuleDefaultGenerator: Generator = {
  kind: "automation_rule_default",
  run: () => DEFAULT_AUTOMATION_RULES.map((rule, index) => ({ id: String(rule.id), data: { ...JSON.parse(JSON.stringify(rule)), sort_order: index } }))
};
