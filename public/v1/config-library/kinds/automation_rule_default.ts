import { z } from "zod";

import { actionCatalogEntry } from "../../work/automations/catalog.js";
import { workEventDefinition } from "../../work/events.js";
import type { LibraryKind } from "../contracts.js";

export const AUTOMATION_RULE_DEFAULT_KIND = "automation_rule_default";

/**
 * Platform default organization rules (work/rules.ts, docs/architecture/automation-authoring.md). Every organization
 * runs each one live unless it has stored a rule with the same id (to switch it off or change it); defaults are
 * never copied into an organization's rules. An entry is one rule in the authoring shape `saveAutomationRules`
 * takes; `sort_order` places it among the defaults, which run before the organization's own rules.
 */
const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const text = (max: number) => z.string().trim().max(max);
const input = z.record(z.unknown());

const actionSchema = z.object({
  id,
  automation: id,
  enabled: z.boolean().optional(),
  title: text(300).optional(),
  explainer: text(2000).optional(),
  input: input.optional(),
  conditions: z.unknown().optional(),
  continue_on_error: z.boolean().optional()
}).strict();

export const automationRuleDefaultSchema = z.object({
  id,
  sort_order: z.number().int().min(0).max(10_000),
  enabled: z.boolean(),
  title: text(300).min(1),
  explainer: text(2000).optional(),
  customer_visible: z.boolean().optional(),
  event: id.optional(),
  schedule: z.object({
    cron: text(120).optional(),
    contact_date: z.object({ field: text(160).min(1), offset_days: z.number().int().min(-365).max(365).optional(), yearly: z.boolean().optional() }).strict().optional()
  }).strict().optional(),
  conditions: z.unknown().optional(),
  automation: id.optional(),
  input: input.optional(),
  actions: z.array(actionSchema).max(50).optional(),
  continue_on_error: z.boolean().optional()
}).strict();
export type AutomationRuleDefault = z.infer<typeof automationRuleDefaultSchema>;

const SCHEDULED_EVENTS = new Set(["time.cron", "contact.date"]);

export const automationRuleDefaultKind: LibraryKind<AutomationRuleDefault> = {
  kind: AUTOMATION_RULE_DEFAULT_KIND,
  title: "Default organization rules",
  description: "Organization rules every organization runs unless it stores a rule with the same id (to switch it off or change it). They are read live, never copied.",
  schema: automationRuleDefaultSchema,
  titleOf: (data) => data.title,
  validate(data, ctx) {
    const problems: string[] = [];
    if (data.id !== ctx.id) problems.push(`The rule id (${data.id}) must be the entry id (${ctx.id}).`);
    const scheduled = !!data.schedule?.cron || !!data.schedule?.contact_date;
    if (!data.event && !scheduled) problems.push("A rule listens for an event or runs on a schedule.");
    if (data.event && !SCHEDULED_EVENTS.has(data.event) && !workEventDefinition(data.event).description) problems.push(`event: "${data.event}" is not a registered event.`);
    const dateField = data.schedule?.contact_date?.field;
    if (dateField && dateField !== "birthday" && !/^cf\.[A-Za-z0-9_.-]+$/.test(dateField)) problems.push("schedule.contact_date.field is a contact's birthday or a date field (cf.<field>).");
    if (!data.automation && !data.actions?.length) problems.push("A rule runs an automation or a list of actions.");
    if (data.automation && !actionCatalogEntry(data.automation)) problems.push(`automation: unknown action "${data.automation}".`);
    if (data.conditions !== undefined) problems.push(...ctx.registries.conditions(data.conditions, "conditions"));
    const seen = new Set<string>();
    for (const action of data.actions || []) {
      if (seen.has(action.id)) problems.push(`actions: "${action.id}" is used more than once.`);
      seen.add(action.id);
      if (!actionCatalogEntry(action.automation)) problems.push(`actions.${action.id}: unknown action "${action.automation}".`);
      if (action.conditions !== undefined) problems.push(...ctx.registries.conditions(action.conditions, `actions.${action.id}.conditions`));
    }
    return problems;
  }
};
