import { z } from "zod";
import type { JsonObject } from "../platform/storage.js";
import { measurementSchemaIdsForScope } from "../platform/publication/measurement-schemas.js";
import { listWorkItems, workItemsForSchemas } from "../platform/publication/work-items.js";
import { MANUAL_SCOPE_KEY, projectScope, requiredWork } from "./scope-artifacts.js";
import { listProjectMaterialLists } from "../materials/storage.js";
import type { Assignee } from "./assignees.js";
import { capabilitiesFor } from "./capabilities.js";
import { listAssignee, listExcludedWork, paySheetForList } from "./generation.js";
import { paySheetWork, type PaySheet } from "./pay-sheets.js";
import { projectPayContext } from "./pay-sheet-publication.js";

/**
 * Everything a project requires, and what accounts for each thing.
 *
 * Material lists and work orders carry the money. This is the third list and carries none: it says what has to exist
 * or be done (material, work, and functions such as debris disposal) and which lines on those lists account for it.
 *
 * What is required comes from the project's scope artifacts and from nothing else (labor/scope-artifacts.ts): the
 * sets an accepted document published, a person added or an agent built, added together. The scope set only says
 * what could be required and how it is sized. A project with no artifact that names work has no work required.
 * A requirement nothing accounts for is open. One accounted for with something odd about it (paid for twice, covered
 * by someone not marked as able to do it, covered but not priced) carries a warning and is not blocked: the lists
 * are probably right and a person decides.
 *
 * Coverage is read from the lists as they stand, never from what a pay sheet would write. A generated line carries
 * the work items it pays for; a list records what its assignee does at no charge; a line added by hand can be marked
 * as covering a requirement. Reads only.
 */
const numbers = z.record(z.string().max(200), z.number().finite());
const legacy = z.record(z.string().max(120), z.object({ value: z.number().finite().nonnegative(), unit: z.string().max(40) }).strict());
export const requirementsInputSchema = z.object({ fields: numbers.optional(), legacy_measurements: legacy.optional(), scope_template_ids: z.array(z.string().trim().min(1).max(200)).max(50).optional() }).strict();

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const strings = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);

export type RequirementCover = {
  list_id: string; list_title: string; resource_type: string; assignee_name: string;
  /** paid: a line charges for it. included: done at no separate charge. provided: equipment fulfils it. */
  mode: "paid" | "included" | "provided";
  lines: { id: string; name: string; quantity: number; unit: string; total_cents: number | null; generated: boolean }[];
};
export type Requirement = {
  id: string; kind: "material" | "work" | "function"; label: string; description: string; unit: string;
  quantity: number | null; under: string;
  /** The artifacts that say this is required: a document's set, one added by hand, or a material list. */
  sources: { set_id: string; title: string; origin: string }[];
  status: "open" | "warning" | "covered";
  covered_by: RequirementCover[];
  warnings: { code: string; message: string }[];
  /** Work orders that could take this on because their assignee's pay sheet handles it: it was left to someone else
   * (excluded), or nothing accounts for it and the line that paid for it is gone (missing), so building the work order
   * again from the sheet puts it back. */
  can_cover: { list_id: string; list_title: string; assignee_name: string; reason?: "excluded" | "missing" }[];
  reason: string;
};

/**
 * The kinds of work a project is of, from the scope each list came from and the sheet each work order is priced on.
 * This decides what can be added by hand, never what is required.
 */
async function projectSchemaIds(orgId: string, lists: JsonObject[], hinted: string[]) {
  const { readScopeTemplateVersion } = await import("../scopes/storage.js");
  const found = new Set<string>(), seen = new Set<string>();
  for (const [branchId, templateId] of [...lists.map((list) => [text(list.branch_id) || "default", text(list.scope_template_id)]), ...hinted.map((id) => ["default", id])]) {
    if (!templateId || templateId === "manual" || seen.has(`${branchId}:${templateId}`)) continue;
    seen.add(`${branchId}:${templateId}`);
    for (const schema of measurementSchemaIdsForScope((await readScopeTemplateVersion(orgId, branchId!, templateId).catch(() => null))?.definition)) found.add(schema);
  }
  return found;
}

export async function projectRequirements(orgId: string, projectId: string, input: unknown = {}) {
  const parsed = requirementsInputSchema.parse(input || {});
  const lists = (await listProjectMaterialLists(orgId, projectId)).filter((list) => text(list.status) !== "archived");
  const context = await projectPayContext(orgId, projectId, { fields: parsed.fields, legacy_measurements: parsed.legacy_measurements });
  const schemaIds = await projectSchemaIds(orgId, lists, parsed.scope_template_ids || []);
  const workLists = lists.filter((list) => text(list.resource_type) && text(list.resource_type) !== "material");

  // Each work order: who it is assigned to, the sheet it is priced on, and what that sheet handles.
  type Order = { list: JsonObject; assignee: ReturnType<typeof listAssignee>; sheet: PaySheet | null; excluded: string[]; handles: Map<string, string>; items: JsonObject[] };
  const orders: Order[] = [];
  for (const list of workLists) {
    const assignee = listAssignee(list);
    const sheet = assignee ? await paySheetForList(orgId, list, assignee).catch(() => null) : null;
    for (const schema of sheet?.schema_ids || []) schemaIds.add(schema);
    orders.push({ list, assignee, sheet, excluded: listExcludedWork(list), handles: sheet ? paySheetWork(sheet) : new Map<string, string>(), items: (Array.isArray(list.current_items) ? list.current_items : []).map(obj) });
  }
  const capabilities = await capabilitiesFor(orgId, orders.flatMap((order) => (order.assignee ? [order.assignee as Assignee] : [])));
  const scope = await projectScope(orgId, projectId);
  const required = requiredWork(scope.sets, context);
  const lineWarnings: { list_id: string; item_id: string; code: string; message: string }[] = [];
  const title = (list: JsonObject) => (obj(list.metadata).placeholder_title === true ? "" : text(list.title)) || (text(list.resource_type) === "equipment" ? "Equipment" : "Work order");
  const who = (order: Order) => order.assignee?.name || title(order.list);

  const requirements: Requirement[] = required.map((row) => {
    const covered: RequirementCover[] = [], warnings: Requirement["warnings"] = [], canCover: Requirement["can_cover"] = [];
    let adjustedOnlyBy = "", capacity = 0, unlimited = false, providers = 0;
    for (const order of orders) {
      const id = text(order.list.id), common = { list_id: id, list_title: title(order.list), resource_type: text(order.list.resource_type), assignee_name: order.assignee?.name || "" };
      const line = (item: JsonObject) => ({ id: text(item.id), name: text(item.name), quantity: Number(item.quantity) || 0, unit: text(item.unit), total_cents: obj(item.metadata).unresolved === true ? null : Math.round((Number(item.projected_total ?? (Number(item.quantity) || 0) * (Number(item.projected_unit_price) || 0)) || 0) * 100), generated: obj(item.metadata).generated_from_pay_sheet === true });
      const paying = order.items.filter((item) => strings(obj(item.metadata).covers).includes(row.item));
      const providing = order.items.filter((item) => (Array.isArray(obj(item.metadata).provides) ? obj(item.metadata).provides as unknown[] : []).some((entry) => text(obj(entry).item) === row.item));
      const adjusting = order.items.filter((item) => strings(obj(item.metadata).adjusts).includes(row.item));
      const outside = order.items.filter((item) => strings(obj(item.metadata).covers_outside).includes(row.item));
      const generation = obj(obj(order.list.metadata).labor_generation);
      const included = (Array.isArray(generation.work_items) ? generation.work_items as unknown[] : []).some((entry) => text(obj(entry).item) === row.item && text(obj(entry).state) === "included");
      if (paying.length) {
        covered.push({ ...common, mode: "paid", lines: paying.map(line) });
        // A line with no price yet still says who is doing it; what is missing is the money.
        const unpriced = paying.filter((item) => obj(item.metadata).unresolved === true || (obj(item.metadata).quantity_needed === true && !(Number(item.quantity) > 0)));
        if (unpriced.length) warnings.push({ code: "unpriced", message: `${who(order)} is doing this, but ${unpriced.length === 1 ? `"${text(unpriced[0]!.name)}" is` : "those line items are"} not priced yet.` });
      } else if (providing.length) covered.push({ ...common, mode: "provided", lines: providing.map(line) });
      else if (included) covered.push({ ...common, mode: "included", lines: [] });
      else if (adjusting.length) adjustedOnlyBy = who(order);
      for (const item of providing) for (const entry of (obj(item.metadata).provides as unknown[]).map(obj).filter((entry) => text(entry.item) === row.item)) { providers += 1; if (entry.per_load === true || !(Number(entry.capacity) > 0)) unlimited = true; else capacity += Number(entry.capacity) * Math.max(1, Number(item.quantity) || 1); }
      for (const item of outside) {
        warnings.push({ code: "paid_outside", message: `${who(order)}'s line item "${text(item.name)}" also pays for this, though it is not on their work order.` });
        lineWarnings.push({ list_id: id, item_id: text(item.id), code: "paid_outside", message: `This line item also pays for ${row.label.toLowerCase()}, which is not part of this work order. Its price cannot be split, so it is charged in full.` });
      }
      if (order.assignee && (paying.length || included)) {
        const able = capabilities.get(`${order.assignee.type}:${order.assignee.id}`);
        if (able?.known && !able.items.includes(row.item)) warnings.push({ code: "not_capable", message: `${who(order)} is not marked as able to do this.` });
      }
      if (order.handles.has(row.item) && order.assignee) {
        if (order.excluded.includes(row.item)) canCover.push({ list_id: id, list_title: title(order.list), assignee_name: order.assignee.name, reason: "excluded" });
        else if (!paying.length && !included) canCover.push({ list_id: id, list_title: title(order.list), assignee_name: order.assignee.name, reason: "missing" });
      }
    }
    // Equipment adds up, so two dumpsters are not a duplicate. Two parties paid or relied on for the same thing are.
    const parties = covered.filter((entry) => entry.mode !== "provided");
    if (parties.length > 1) {
      const names = parties.map((entry) => entry.assignee_name || entry.list_title).sort((first, second) => first.localeCompare(second));
      warnings.push({ code: "duplicate", message: `Accounted for ${parties.length === 2 ? "twice" : `${parties.length} times`}: ${names.join(" and ")}.` });
      for (const entry of parties) for (const paid of entry.lines) lineWarnings.push({ list_id: entry.list_id, item_id: paid.id, code: "duplicate", message: `${row.label} is also accounted for by ${names.filter((name) => name !== (entry.assignee_name || entry.list_title)).join(" and ") || "another work order"}.` });
    }
    if (!parties.length && providers && !unlimited && row.quantity !== null && capacity + 1e-9 < row.quantity) warnings.push({ code: "short", message: `What is on the work order holds ${round(capacity)} ${unitLabel(row.unit)} of the ${round(row.quantity)} needed.` });
    if (!covered.length && adjustedOnlyBy) warnings.push({ code: "adjusted_only", message: `${adjustedOnlyBy} has a line item that changes the price of this, but none that pays for it.` });
    if (covered.length) for (let index = canCover.length - 1; index >= 0; index -= 1) if (canCover[index]!.reason === "missing") canCover.splice(index, 1);
    const status = !covered.length ? "open" as const : warnings.length ? "warning" as const : "covered" as const;
    return { id: row.item, kind: row.kind, label: row.label, description: row.description, unit: row.unit, quantity: row.quantity, under: required.some((other) => other.item === row.under) ? row.under : "", sources: row.sources, status, covered_by: covered, warnings, can_cover: canCover, reason: row.reason };
  });

  // Material. A line on a material list, or in a set a document published, is a requirement that has already been
  // made specific, so it is its own cover. A set a document published that has not been generated yet is required
  // and not yet accounted for.
  const byList = new Map(lists.map((list) => [text(list.id), list]));
  const groups = new Map<string, { label: string; units: Set<string>; quantity: number; lists: Map<string, RequirementCover["lines"]>; sources: Requirement["sources"] }>();
  const titles = new Map<string, string>();
  const add = (label: string, listId: string, listTitle: string, origin: string, line: RequirementCover["lines"][number]) => {
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label, units: new Set(), quantity: 0, lists: new Map(), sources: [] });
    const group = groups.get(key)!;
    group.units.add(line.unit.toLowerCase()); group.quantity += line.quantity; titles.set(listId, listTitle);
    if (!group.lists.has(listId)) { group.lists.set(listId, []); group.sources.push({ set_id: listId, title: listTitle, origin }); }
    group.lists.get(listId)!.push(line);
  };
  for (const line of context.materials || []) add(text(line.name) || text(line.item_type) || "Other material", text(line.list_id), text(byList.get(text(line.list_id))?.title) || "Materials", "list", { id: text(line.line_id), name: text(line.name), quantity: Number(line.quantity) || 0, unit: text(line.unit), total_cents: null, generated: false });
  for (const set of scope.sets) for (const line of set.lines) add(text(line.name) || text(line.group) || "Other material", set.id, set.title, set.origin, { id: line.id, name: line.name, quantity: line.quantity, unit: line.unit, total_cents: null, generated: false });
  const materials: Requirement[] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => ({
    id: `material:${key}`, kind: "material", label: group.label, description: "", unit: group.units.size === 1 ? [...group.units][0]! : "", quantity: group.units.size === 1 ? group.quantity : null, under: "", sources: group.sources, status: "covered",
    covered_by: [...group.lists.entries()].map(([listId, lines]) => ({ list_id: listId, list_title: titles.get(listId) || "Materials", resource_type: "material", assignee_name: "", mode: "paid" as const, lines })),
    warnings: [], can_cover: [], reason: ""
  }));
  for (const set of scope.sets.filter((entry) => entry.pending)) materials.push({ id: `material:pending:${set.id}`, kind: "material", label: `Materials for ${set.title}`, description: "", unit: "", quantity: null, under: "", sources: [{ set_id: set.id, title: set.title, origin: set.origin }], status: "open", covered_by: [], warnings: [], can_cover: [], reason: "The accepted document says what material this needs, but the list has not been generated yet." });

  const all = [...materials, ...requirements];
  const counts = { open: all.filter((row) => row.status === "open").length, warning: all.filter((row) => row.status === "warning").length, covered: all.filter((row) => row.status === "covered").length };
  return {
    project_id: projectId, schema_ids: [...schemaIds].sort(), measurement_source: context.measurement_source,
    status: !all.length ? "empty" as const : counts.open ? "open" as const : counts.warning ? "warning" as const : "covered" as const,
    counts, requirements: all, line_warnings: lineWarnings,
    // What a person has added by hand, and what the project's kinds of work would let them add.
    manual_work: scope.sets.filter((set) => set.origin === "manual" && set.key === MANUAL_SCOPE_KEY).flatMap((set) => set.work),
    available: listWorkItems().filter((entry) => workItemsForSchemas([...schemaIds]).includes(entry.id) && !required.some((row) => row.item === entry.id)).map((entry) => ({ item: entry.id, label: entry.label, kind: entry.kind, unit: entry.unit, description: entry.description })),
    reason: all.length ? "" : "No accepted document, and nothing added by hand, says what this job includes yet."
  };
}
const round = (value: number) => Math.round(value * 10) / 10;
const unitLabel = (unit: string) => (unit === "yd3" ? "cubic yards" : unit);

