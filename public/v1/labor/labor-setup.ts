import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { forbidden } from "../platform/errors.js";
import { invokeAction, registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { definitionForKey, listMeasurementSchemas } from "../platform/publication/measurement-schemas.js";
import { createOrganizationConnection, listOrganizationConnections } from "../connections/storage.js";
import { createResourceGroup, listResourceGroups, putResourceGroupMember, readResourceGroup, readWorkforceConfiguration } from "../workforce/storage.js";
import { listDocuments } from "../platform/storage.js";
import { readCompanyProfile } from "../company-profile/profile.js";
import { WORKFORCES, industrySetsFor } from "../company-profile/catalog.js";
import { listPaySheets, type PaySheet } from "./pay-sheets.js";
import { listDeclaredCapabilities } from "./capabilities.js";

/**
 * Who does the labor, as the price book setup asks it (docs/architecture/guided-experiences.md, "Who does your
 * labor"). Labor is installed by a group of users or an outside company. This adds the ones a company names, through
 * the same writers People uses, and sets how each is paid as a pay sheet saved through `pay-sheets.sheet.save`: a
 * piece rate on a roofing measurement (per square, or per foot of a roof line), hourly, or a price per job. It never
 * computes pay; a pay sheet is evaluated against a job like any other. A sheet it did not write (more than one line,
 * or another way of paying) is left alone: that is edited in People.
 *
 * The Operations workforce setup (GP-28) asks more of each one: which of the company's services it does (saved as its
 * capabilities, `assignees.capabilities.save`, so the kinds of work those services are measured as are granted) and,
 * for a group, which of the organization's people are in it (added through the group's own member writer, never
 * removed here).
 */
const text = (value: unknown) => String(value ?? "").trim();
const SCHEMA_ID = "roofing";
// What a roofing job's labor covers; the same work items the sample sheets name (labor/sample-pay-sheets.ts).
const ROOF_WORK = ["roofing.tear_off", "roofing.dry_in", "roofing.install"];
const TRIM = ["roofing.edge_metal", "roofing.ridge_cap", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"];
export const LABOR_PAY_METHODS = ["per_measurement", "hourly", "per_job"] as const;

const assigneeRef = z.object({ type: z.enum(["resource_group", "organization_connection"]), id: z.string().trim().min(1).max(200) }).strict();
const payInput = z.object({
  method: z.enum(LABOR_PAY_METHODS),
  /** Dollars per unit (per square, per foot, per hour) or per job. */
  rate: z.number().finite().min(0).max(1_000_000),
  /** For a piece rate: the roofing measurement it is paid on. Defaults to roof squares. */
  measurement: z.string().trim().max(120).optional()
}).strict();
export const laborSetupInputSchema = z.object({
  assignees: z.array(z.object({
    /** An existing group or outside company. Without one, a new one is added with `kind` and `name`. */
    ref: assigneeRef.optional(),
    kind: z.enum(["resource_group", "organization_connection"]),
    name: z.string().trim().min(1).max(300),
    /** A group's one type (its kind_id), or an outside company's type. */
    type_id: z.string().trim().max(120).optional(),
    pay: payInput.nullable().optional(),
    /** The company profile services it does (company-profile/catalog.ts). Given, it replaces the ones saved before. */
    service_ids: z.array(z.string().trim().min(1).max(80)).max(80).optional(),
    /** For a group: people of the organization to add to it. Members already in it stay; none are removed. */
    member_user_ids: z.array(z.string().trim().min(1).max(200)).max(100).optional()
  }).strict()).max(40).default([])
}).strict();
export type LaborSetupInput = z.infer<typeof laborSetupInputSchema>;

/** The roofing measurements a piece rate can be paid on, with their labels and units. */
export function payMeasurements() {
  const schema = listMeasurementSchemas().find((entry) => entry.id === SCHEMA_ID);
  const ids = (schema?.measurements || []).map((entry) => entry.definition);
  const wanted = ["roof.squares", "roof.flat_squares", "roof.squares_9_to_12", "roof.squares_13_plus", "roof.eave_length", "roof.rake_length", "roof.ridge_length", "roof.hip_length", "roof.valley_length"];
  return wanted.filter((id) => ids.includes(id)).map((id) => { const definition = definitionForKey(id); return { id, label: text(definition?.label) || id, unit: text(definition?.unit) }; });
}

/** A one-line pay sheet as this setup writes it, for one assignee. */
export function laborPaySheet(subject: { type: "resource_group" | "organization_connection"; id: string }, name: string, pay: z.infer<typeof payInput>) {
  const cents = Math.round(pay.rate * 100);
  const covers = [...ROOF_WORK, ...TRIM];
  const base = { subject, name: `${name} roofing pay`, schema_ids: [SCHEMA_ID], equipment: [] as unknown[] };
  if (pay.method === "hourly") return { ...base, inputs: [{ name: "hours", label: "Hours", source: { kind: "manual" as const }, required: true }], entries: [{ label: "Hourly labor", kind: "hourly" as const, unit: "hour", rate_cents: cents, input: "hours", covers }], work: [] };
  if (pay.method === "per_job") return { ...base, inputs: [], entries: [{ label: "Price per job", kind: "flat" as const, rate_cents: cents, covers }], work: [] };
  const measurement = payMeasurements().find((entry) => entry.id === (pay.measurement || "roof.squares")) || payMeasurements()[0]!;
  const squares = measurement.id.startsWith("roof.squares") || measurement.id === "roof.flat_squares";
  return {
    ...base,
    inputs: [{ name: "amount", label: measurement.label, source: { kind: "measurement" as const, definition: measurement.id, per_structure: squares }, required: true }],
    entries: [{ label: `Per ${squares ? "square" : "foot"}: ${measurement.label}`, kind: "piece_rate" as const, unit: squares ? "sq" : "ft", rate_cents: cents, input: "amount", covers: ROOF_WORK }],
    // Paid by the measurement, the trim work is part of the same price.
    work: TRIM.map((item) => ({ item, included: true }))
  };
}

/** How a sheet pays, when it is one this setup could have written (one line, a piece rate, hourly or flat). */
export function simplePay(sheet: Pick<PaySheet, "entries" | "inputs" | "schema_ids">) {
  if (sheet.entries.length !== 1) return null;
  const entry = sheet.entries[0]!;
  const input = sheet.inputs.find((row) => row.name === entry.input);
  const rate = entry.rate_cents / 100;
  if (entry.kind === "hourly") return { method: "hourly" as const, rate };
  if (entry.kind === "flat") return { method: "per_job" as const, rate };
  if (entry.kind === "piece_rate" && input?.source.kind === "measurement") return { method: "per_measurement" as const, rate, measurement: input.source.definition };
  return null;
}

/** The organization's people who can be put in a group: active users, by name. */
async function organizationPeople(orgId: string) {
  return (await listDocuments(orgId, "users")).map((document) => {
    const data = (document.data || {}) as Record<string, unknown>;
    return { id: text(document.id), name: text(data.name) || text(data.email) || text(document.id), status: text(data.status) || "active" };
  }).filter((user) => user.id && user.status !== "disabled" && user.status !== "archived").map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What the labor step shows: the organization's groups and outside companies (suppliers are not), how each is paid
 * for roofing, the services each does and a group's members, the types each kind can have and the measurements a piece
 * rate can read; and for the workforce setup, the company profile it starts from (kind of company, its services, who
 * does the work) and the people who can be put in a group.
 */
export async function laborSetupOptions(orgId: string) {
  const [groups, companies, sheets, configuration, declared, profile, people] = await Promise.all([listResourceGroups(orgId, {}), listOrganizationConnections(orgId, {}), listPaySheets(orgId), readWorkforceConfiguration(orgId), listDeclaredCapabilities(orgId), readCompanyProfile(orgId), organizationPeople(orgId)]);
  const servicesOf = (type: string, id: string) => declared.find((row) => row.assignee.type === type && row.assignee.id === id)?.service_ids || [];
  const membersOf = (group: Record<string, unknown>) => (Array.isArray(group.members) ? group.members as Record<string, unknown>[] : []).filter((member) => text(member.status || "active") === "active").map((member) => text(member.user_id)).filter(Boolean);
  const sheetFor = (type: string, id: string) => sheets.find((sheet) => sheet.subject.type === type && sheet.subject.id === id && (sheet.schema_ids.includes(SCHEMA_ID) || !sheet.schema_ids.length));
  const pay = (type: string, id: string) => { const sheet = sheetFor(type, id); return sheet ? { sheet_id: sheet.id, name: sheet.name, lines: sheet.entries.length, simple: simplePay(sheet) } : null; };
  const types = (rows: unknown) => (Array.isArray(rows) ? rows : []).filter((row) => text((row as { status?: unknown }).status || "active") !== "archived").map((row) => ({ id: text((row as { id?: unknown }).id), name: text((row as { name?: unknown }).name) || text((row as { id?: unknown }).id) }));
  return {
    assignees: [
      ...groups.map((group) => ({ ref: { type: "resource_group", id: text(group.id) }, kind: "resource_group", name: text(group.name), type_id: text(group.kind_id), members: membersOf(group).length, member_user_ids: membersOf(group), service_ids: servicesOf("resource_group", text(group.id)), pay: pay("resource_group", text(group.id)) })),
      ...companies.map((company) => ({ ref: { type: "organization_connection", id: text(company.id) }, kind: "organization_connection", name: text(company.name), type_id: text((Array.isArray(company.relationship_type_ids) ? company.relationship_type_ids : [])[0]), members: 0, member_user_ids: [] as string[], service_ids: servicesOf("organization_connection", text(company.id)), pay: pay("organization_connection", text(company.id)) }))
    ],
    profile: {
      company_type: profile.company_type, industry: profile.industry, industry_sets: industrySetsFor(profile.industry),
      services: profile.services.map((entry) => ({ id: entry.id, label: entry.label, work_kind: entry.work_kind })),
      work_kinds: profile.work_kinds, workforce: profile.workforce
    },
    workforces: WORKFORCES.map((entry) => ({ id: entry.id, label: entry.label, hint: entry.hint, team: entry.team })),
    people,
    group_types: types(configuration.resource_group_kinds),
    company_types: types(configuration.organization_connection_types),
    measurements: payMeasurements(),
    methods: [...LABOR_PAY_METHODS]
  };
}

/**
 * Adds the groups and outside companies the person named and saves how each is paid. New ones go through the same
 * writers as People (createResourceGroup, createOrganizationConnection); pay sheets through their published action,
 * as the person. Returns each assignee's reference so a pay sheet upload can name it.
 */
export async function applyLaborSetup(ctx: PublicationContext, value: unknown) {
  const auth = ctx.auth;
  if (!auth) throw forbidden("labor_setup_user", "Setting up who does the labor needs a signed-in person.");
  const input = laborSetupInputSchema.parse(value);
  const orgId = ctx.organizationId;
  const branchId = text((auth as { branchId?: unknown }).branchId) || "default";
  const [groups, companies, sheets] = await Promise.all([listResourceGroups(orgId, {}), listOrganizationConnections(orgId, {}), listPaySheets(orgId)]);
  const command = { ...ctx, mode: "command" as const };
  const target = { scope: "organization" as const, organizationId: orgId };
  const declared = await listDeclaredCapabilities(orgId);
  const results: { ref: { type: string; id: string }; name: string; kind: string; created: boolean; pay: "saved" | "kept" | "none"; service_ids?: string[]; members?: number }[] = [];
  for (const entry of input.assignees) {
    let ref = entry.ref;
    let created = false;
    // A new one, unless one of that kind already has the name (a draft saved before a pay sheet upload, saved again).
    if (!ref) {
      const same = (entry.kind === "resource_group" ? groups : companies).find((row) => text(row.name).toLowerCase() === entry.name.toLowerCase());
      if (same) ref = { type: entry.kind, id: text(same.id) };
      else if (entry.kind === "resource_group") {
        const group = await createResourceGroup(orgId, { name: entry.name, branch_id: branchId, ...(entry.type_id ? { kind_id: entry.type_id } : {}), ...(entry.member_user_ids?.length ? { member_user_ids: [...new Set(entry.member_user_ids)] } : {}) });
        ref = { type: "resource_group", id: text(group.id) }; created = true; groups.push(group);
      } else {
        const company = await createOrganizationConnection(orgId, { name: entry.name, relationship_type_ids: [entry.type_id || "work_provider"], branch_ids: [branchId] });
        ref = { type: "organization_connection", id: text(company.id) }; created = true; companies.push(company);
      }
    }
    // An existing one's type is changed through its own action.
    if (!created && entry.type_id) {
      const row = ((ref.type === "resource_group" ? groups : companies) as Record<string, unknown>[]).find((item) => text(item.id) === ref!.id);
      const current = ref.type === "resource_group" ? text(row?.kind_id) : text((Array.isArray(row?.relationship_type_ids) ? row!.relationship_type_ids as unknown[] : [])[0]);
      if (row && current !== entry.type_id) await invokeAction(command, { action: "assignees.profile.set", target }, { assignee: ref, type_ids: [entry.type_id] }, { idempotencyKey: `labor-setup:type:${ref.type}:${ref.id}:${entry.type_id}:${Date.now()}` });
    }
    let pay: "saved" | "kept" | "none" = "none";
    if (entry.pay) {
      const existing = sheets.find((sheet) => sheet.subject.type === ref!.type && sheet.subject.id === ref!.id && sheet.schema_ids.includes(SCHEMA_ID));
      if (existing && !simplePay(existing)) pay = "kept";
      else {
        const sheet = { ...laborPaySheet(ref, entry.name, entry.pay), ...(existing ? { id: existing.id, expected_revision: existing.revision } : {}) };
        await invokeAction(command, { action: "pay-sheets.sheet.save", target }, sheet, { idempotencyKey: `labor-setup:sheet:${ref.type}:${ref.id}:${JSON.stringify(entry.pay)}:${Date.now()}` });
        pay = "saved";
      }
    }
    // People added to a group: each through the group's member writer (which gives the group type's roles); none removed.
    let members: number | undefined;
    if (ref.type === "resource_group" && entry.member_user_ids?.length) {
      let group = await readResourceGroup(orgId, ref.id);
      const active = (row: Record<string, unknown>) => (Array.isArray(row.members) ? row.members as Record<string, unknown>[] : []).filter((member) => text(member.status || "active") === "active").map((member) => text(member.user_id));
      for (const userId of [...new Set(entry.member_user_ids)]) {
        if (active(group).includes(userId)) continue;
        group = await putResourceGroupMember(orgId, ref.id, userId, { expected_revision: group.revision });
      }
      members = active(group).length;
    }
    // What it does: the services it was given replace the ones saved before; the rest of its capabilities stay.
    if (entry.service_ids) {
      const current = declared.find((row) => row.assignee.type === ref!.type && row.assignee.id === ref!.id);
      const service_ids = [...new Set(entry.service_ids)];
      if (!current || JSON.stringify([...current.service_ids].sort()) !== JSON.stringify([...service_ids].sort())) {
        await invokeAction(command, { action: "assignees.capabilities.save", target }, { assignee: ref, schema_ids: current?.schema_ids || [], service_ids, item_ids: current?.item_ids || [], excluded_item_ids: current?.excluded_item_ids || [], ...(current ? { expected_revision: current.revision } : {}) }, { idempotencyKey: `labor-setup:services:${ref.type}:${ref.id}:${service_ids.join(",")}:${Date.now()}` });
      }
    }
    results.push({ ref, name: entry.name, kind: ref.type, created, pay, ...(entry.service_ids ? { service_ids: [...new Set(entry.service_ids)] } : {}), ...(members !== undefined ? { members } : {}) });
  }
  return { assignees: results };
}

const strings = { type: "array", items: { type: "string" } };
const named = { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } };
const setupStatusSchema = { type: "object", required: ["assignees", "profile", "people", "group_types", "company_types", "measurements", "methods"], properties: {
  assignees: { type: "array", items: { type: "object", required: ["ref", "kind", "name", "service_ids", "member_user_ids"], properties: { ref: { type: "object" }, kind: { enum: ["resource_group", "organization_connection"] }, name: { type: "string" }, type_id: { type: "string" }, members: { type: "integer" }, member_user_ids: strings, service_ids: strings, pay: { type: ["object", "null"] } } } },
  profile: { type: "object" }, workforces: { type: "array", items: { type: "object" } }, people: { type: "array", items: named },
  group_types: { type: "array", items: named }, company_types: { type: "array", items: named }, measurements: { type: "array", items: { type: "object" } }, methods: strings
} };

export function registerLaborSetupPublication() {
  // What the workforce setup and Operations settings show (GP-28): who does the work, what each does, who is in a group
  // and how each is paid. Pay is commercial, so it is read with the permission that sets it.
  registerDataProvider({ id: "workforce-setup", version: "1", apps: ["materials", "crew"], exports: {
    status: { description: "Who does the organization's work: its groups of users (crews) and outside companies (subcontractors), each with the company profile services it does, a group's members, and how it is paid for roofing (a one-line pay sheet's method and rate, or how many lines a fuller sheet has); with the company profile it starts from (kind of company, industry sets, services, who does most of the work), the people who can be put in a group, the types each kind can have and the measurements a piece rate can read.",
      schema: setupStatusSchema, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"], systemKinds: ["agent"] },
      read: async (ctx) => { const value = await laborSetupOptions(ctx.organizationId); return { value, revision: `sha256:${contentHash(value)}` }; } }
  } });
  registerAction({
    id: "labor.setup.apply", version: "1", domain: "materials", implementation: backendImplementationDigest(),
    description: "Set up who does the labor: add groups of users (employees) and outside companies (subcontractors) by name, change their type, say which of the company's services each does (service_ids, from the company profile catalog), add people of the organization to a group (member_user_ids; none are removed), and save how each is paid for roofing as a one-line pay sheet (piece rate on a roofing measurement, hourly, or per job; rates in dollars). An assignee whose pay sheet has more than one line is left alone. To write a fuller pay sheet from a document, use pay-sheets.try then pay-sheets.sheet.save.",
    inputSchema: zodToJsonSchema(laborSetupInputSchema, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials", "apps.crew"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { laborSetupInputSchema.parse(value); },
    execute: async (ctx, _target, value) => applyLaborSetup(ctx, value)
  });
}
