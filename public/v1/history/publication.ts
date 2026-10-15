import { registerDataProvider } from "../platform/publication/providers.js";
import { listProjectChanges } from "./storage.js";
import { generationsWithOutcomes } from "./outcomes.js";

/**
 * The project change history, published read-only. `changes` is what happened on one project, in order, each with who
 * or what made it. `generations` is each generator run on one project beside what people then did to its lines.
 * `generation-outcomes` is the same across the organization for one generator: what an agent reads to find what
 * people keep changing after a generation, and from what inputs. See docs/architecture/project-history.md.
 */
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});
const text = (value: unknown) => String(value ?? "").trim();
const str = { type: "string" }, int = { type: "integer", minimum: 1, maximum: 500 };
const source = { type: "object", required: ["kind"], properties: { kind: { enum: ["person", "agent", "automation", "module", "generator", "system"] }, user_id: str, action: str, invocation_id: str, generator: str, generator_version: str, generation_id: str, tool: str } };
const change = { type: "object", required: ["id", "project_id", "at", "domain", "subject_type", "subject_id", "op", "summary", "source"], properties: { id: str, organization_id: str, project_id: str, at: str, domain: { enum: ["materials", "work_order", "equipment", "scope", "schedule"] }, subject_type: str, subject_id: str, op: str, summary: str, source, generation_id: str, before: {}, after: {}, diff: {} } };
const outcome = { type: "object", required: ["removed", "changed", "added", "untouched"], properties: { removed: { type: "array", items: { type: "object" } }, changed: { type: "array", items: { type: "object" } }, added: { type: "array", items: { type: "object" } }, untouched: { type: "boolean" }, edited_by: { type: "array", items: str }, last_change_at: str } };
const generation = { type: "object", required: ["id", "project_id", "at", "generator", "subject_id", "inputs", "made", "outcome"], properties: { id: str, project_id: str, at: str, generator: str, generator_version: str, subject_type: str, subject_id: str, started_by: source, inputs: { type: "object" }, made: { type: "integer" }, outcome, superseded_at: str } };
const revision = (value: unknown) => String(JSON.stringify(value).length) + ":" + text(obj((value as Obj[])?.[0]).id || obj((value as Obj[])?.[(value as Obj[]).length - 1]).id);

export function registerProjectHistoryPublication() {
  registerDataProvider({ id: "project-history", version: "1", apps: ["materials", "crew", "scheduling"], exports: {
    changes: {
      description: "What happened to this project's real work, oldest first: every change to its material lists, work orders, equipment, scope and schedule, with what it was before and after and who or what made it (source.kind is person, agent, automation, module, generator or system; a generator names itself, its version and the run). A lines change carries the lines added, removed and changed (each changed field before and after) and, in after, the lines as they then stood. Filter by domain, subject (a list id), generation run or time.",
      schema: { type: "array", items: change }, schemaVersion: "1",
      argsSchema: { type: "object", properties: { domain: { enum: ["materials", "work_order", "equipment", "scope", "schedule"] }, subject_id: str, generation_id: str, since: str, limit: { type: "integer", minimum: 1, maximum: 2000 } }, additionalProperties: false },
      access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const args = obj(ref.args); const value = await listProjectChanges(ctx.organizationId, { project_id: ref.target.projectId!, domain: text(args.domain), subject_id: text(args.subject_id), generation_id: text(args.generation_id), since: text(args.since), limit: Number(args.limit) || 500 }); return { value, revision: revision(value) }; }
    },
    generations: {
      description: "Each time a generator wrote part of this project (a pay sheet pricing a work order, a document's calculation making material, a scope building its lists), newest first: what it was given (inputs), how many lines it made, and what people then did to those lines before it was generated again: removed, changed (each field before and after) and added beside them.",
      schema: { type: "array", items: generation }, schemaVersion: "1",
      argsSchema: { type: "object", properties: { generator: str, limit: int }, additionalProperties: false },
      access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const args = obj(ref.args); const value = await generationsWithOutcomes(ctx.organizationId, { project_id: ref.target.projectId!, generator: text(args.generator), limit: Number(args.limit) || 50 }); return { value, revision: revision(value) }; }
    },
    "generation-outcomes": {
      description: "Generator runs across every project in the organization for one generator, newest first, each with its inputs and what people did to its lines afterwards. Use it to find patterns: a line people always add, remove or change when the inputs say something (a measurement, a product chosen in the document, an assignee). edited_only leaves out runs nobody changed. Generators: labor.pay_sheet (work orders priced on a pay sheet), materials.calculus (material a document's calculation made), scope.resources (lists a scope built).",
      schema: { type: "array", items: generation }, schemaVersion: "1",
      argsSchema: { type: "object", required: ["generator"], properties: { generator: str, since: str, edited_only: { type: "boolean" }, limit: int }, additionalProperties: false },
      access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const args = obj(ref.args); const value = await generationsWithOutcomes(ctx.organizationId, { generator: text(args.generator), since: text(args.since), edited_only: args.edited_only === true, limit: Number(args.limit) || 100 }); return { value, revision: revision(value) }; }
    }
  } });
}
