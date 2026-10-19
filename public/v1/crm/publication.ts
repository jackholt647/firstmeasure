import { registerDataProvider } from "../platform/publication/providers.js";
import { invokeAction, registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { systemPublicationContext } from "../platform/publication/context.js";
import { readDocument } from "../platform/storage.js";
import { forbidden } from "../platform/errors.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import type { JsonObject } from "../platform/storage.js";
import type { CrmCollection } from "./records.js";

// records.ts and views.ts load only when a read or write runs: shared bootstrap imports this module, and
// records.ts reaches bootstrap through its own imports, so a static import here would be a cycle.
const CRM_COLLECTIONS: CrmCollection[] = ["opportunities", "contacts", "follow_ups", "appointments"];
const collectionPermission = (collection: CrmCollection) => collection === "contacts" ? "view_contacts" : "view_projects";

// The CRM collections as published data (docs/architecture/crm.md, "Published data"), so a program in a
// scope or an organization rule can read leads, contacts, follow-ups and appointments the way the CRM
// tab shows them, and select from them with the shared selection (where, orderBy, period, limit):
// for example a person's open leads for capacity-aware routing. Rows are the CRM's own rows, nested
// by their dotted keys (cf.assignments.estimator becomes cf.assignments.estimator as a path), limited
// by the caller's branch scope and department access. Reads never write.

const row = { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: true };
const DESCRIPTIONS: Record<CrmCollection, string> = {
  opportunities: "Leads and opportunities: one row per project that arrived as a lead or has a sales scope, with its state, scope and stage, source, value, owner fields (cf.<path>), next appointment and follow-up, last touch, outcome and funnel milestones.",
  contacts: "Contacts with what their projects say: relationship, lead, customer, open opportunities, last activity, leads referred and value won.",
  follow_ups: "Open follow-up to-dos and call-list entries: due, overdue, list, attempts, assignees, the project and contact.",
  appointments: "Appointments on projects: start, type, who it is with, confirmation, status and whether it is upcoming."
};

const cache = new WeakMap<PublicationContext, Map<CrmCollection, Promise<JsonObject[]>>>();
let registered = false;
export function registerCrmPublication() {
  if (registered) return;
  registered = true;
  const exports: JsonObject = {};
  for (const collection of CRM_COLLECTIONS) {
    exports[collection] = {
      schema: { type: "array", items: row }, listItemSchema: row, schemaVersion: "1",
      argsSchema: { type: "object", additionalProperties: false },
      access: { scopes: ["organization"], permissions: [collectionPermission(collection)], systemKinds: ["work", "module", "agent"] },
      description: DESCRIPTIONS[collection],
      read: async (ctx: PublicationContext) => {
        // One build per collection per execution: a program's selections share it.
        const built = cache.get(ctx) || new Map<CrmCollection, Promise<JsonObject[]>>();
        cache.set(ctx, built);
        if (!built.has(collection)) built.set(collection, (async () => {
          const [{ collectionFor }, { nestRow }] = await Promise.all([import("./api.js"), import("./views.js")]);
          // Published rows are plain JSON: a field a row has no value for is absent, not undefined.
          return JSON.parse(JSON.stringify((await collectionFor(ctx.auth || null, ctx.organizationId, collection)).rows.map(nestRow))) as JsonObject[];
        })());
        return { value: await built.get(collection)! };
      }
    };
  }
  registerDataProvider({ id: "crm", version: "1", apps: ["crm"], exports } as never);

  // Writing a lead's fields from a program that works across many leads (routing, a reassignment
  // sweep, a score): one organization-level action that names the project, built on the project
  // custom-field writer, with the caller's own access.
  registerAction({
    id: "crm.leads.update", version: "1", implementation: backendImplementationDigest(), domain: "crm",
    description: "Write declared custom fields on one lead's project: values maps dotted field paths (assignments.estimator, crm.score) to values. For programs that route, reassign or score leads.",
    inputSchema: { type: "object", required: ["project_id", "values"], properties: { project_id: { type: "string", minLength: 1, maxLength: 200 }, values: { type: "object", minProperties: 1, maxProperties: 64, additionalProperties: true } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["id", "revision"], properties: { id: { type: "string" }, revision: { type: "integer" } }, additionalProperties: false },
    policy: { scopes: ["organization"], permissions: ["manage_projects"], systemKinds: ["work", "module", "agent"] },
    effect: "write", executionKinds: ["api", "agent", "module", "work"], idempotency: "required",
    execute: async (ctx: PublicationContext, _target: unknown, input: JsonObject, execution: JsonObject) => {
      const projectId = String(input.project_id);
      const project = await readDocument(ctx.organizationId, "projects", projectId);
      const { rowAccess } = await import("./records.js");
      if (ctx.auth && !rowAccess(ctx.auth).project({ id: projectId, ...(project.data as JsonObject) })) throw forbidden("crm_lead_denied", "This lead is outside your access.");
      const child = systemPublicationContext({ kind: "work", organizationId: ctx.organizationId, projectId, branchId: ctx.branchId, operations: ["custom-fields.project.write"], mode: "command" });
      child.auth = ctx.auth;
      const key = String((execution as JsonObject)?.idempotencyKey || "") || `crm.leads.update:${projectId}:${project.revision}`;
      const written = await invokeAction(child, { action: "custom-fields.project.write", target: { scope: "project", organizationId: ctx.organizationId, projectId } }, { values: input.values, expectedRevision: Number(project.revision) }, { idempotencyKey: `${key}:${projectId}` });
      return written.value as never;
    }
  } as never);
}
