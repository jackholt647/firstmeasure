import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema, PublicationContext } from "../platform/publication/contracts.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { MAX_LOCATIONS } from "../company-profile/profile.js";
import { EQUIPMENT_MANAGE, EQUIPMENT_VIEW, authorizeEquipmentOwner } from "./access.js";
import { equipmentProvidesSchema } from "./functions.js";
import { ensureEquipmentSeed } from "./service.js";
import { listCategories, listTypes, listUnits, listYards, saveType, saveUnit, saveYard } from "./storage.js";

/**
 * The equipment setup (GP-15, docs/architecture/guided-experiences.md, "Equipment setup"): where the company keeps its
 * equipment (one facility per location it works out of, the `company.locations` setup step), what kinds of equipment
 * it uses, and how many of each it has at each facility. The `equipment.setup` experience asks; the kinds it offers
 * are data in that experience's library entry (by company type), so this file holds no list of equipment. Finishing
 * runs `equipment.setup.apply`, which writes through the Equipment app's own writers (facilities are its yards, kinds
 * its types, each unit a unit with that facility as its home), so the Equipment tab shows the result at once.
 *
 * Running it again only adds: a facility it was given back keeps its id, a kind of equipment it made before (its
 * type's `seed_key` is `setup.<key>`) is reused, and a facility gets only the units it is short of. Nothing is
 * renamed behind the person's back or removed. What was set up is kept in the default branch's `equipment_setup`
 * module, apart from the fleet.
 */
export const EQUIPMENT_SETUP_MODULE = "equipment_setup";
const SEED_PREFIX = "setup.";
const MAX_UNITS = 50;

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => String(value ?? "").trim();
const words = (max: number) => z.string().trim().min(1).max(max).transform((value) => value.replace(/[<>]/g, ""));
const key = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/);

export const facilityInputSchema = z.object({
  /** The widget's own name for the row, which the equipment's counts are keyed by. */
  key,
  /** An existing facility (yard) given back: it keeps its id and gets this name. */
  id: z.string().trim().max(120).optional(),
  name: words(120)
}).strict();
export const equipmentInputSchema = z.object({
  /** The kind's id in the experience's options, or the person's own (custom_…). */
  key,
  name: words(120),
  kind: z.enum(["vehicle", "trailer", "tool", "other"]).optional(),
  /** One of the Equipment app's built-in categories, by its seed key. */
  category: z.string().trim().max(60).optional(),
  icon: z.string().trim().regex(/^fa-[a-z0-9-]+$/).max(60).optional(),
  description: z.string().trim().max(400).optional(),
  provides: equipmentProvidesSchema.optional(),
  ownership: z.enum(["owned", "leased", "rented"]).default("owned"),
  /** How many units at each facility, by the facility's key. */
  units: z.record(key, z.number().int().min(0).max(MAX_UNITS)).default({})
}).strict();
export const applyInputSchema = z.object({
  facilities: z.array(facilityInputSchema).min(1).max(MAX_LOCATIONS),
  equipment: z.array(equipmentInputSchema).max(30).default([])
}).strict();

const yardLocation = (yard: JsonObject) => ({ kind: "yard", yard_id: text(yard.id), label: text(yard.name), address: object(yard.address) });
const homeYard = (unit: JsonObject) => text(object(unit.home_location).yard_id) || text(object(unit.location).yard_id);

async function stored(orgId: string) {
  try { return await readBranchModule(orgId, "default", EQUIPMENT_SETUP_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}

/** What the setup knows: the facilities, the kinds of equipment it made and how many units each has where, and when it was finished. */
export async function readEquipmentSetup(orgId: string) {
  const [record, yards, types, units] = await Promise.all([stored(orgId), listYards(orgId), listTypes(orgId), listUnits(orgId, { ownership: "internal" })]);
  const data = object(record?.data);
  const counts = new Map<string, Record<string, number>>();
  for (const unit of units) {
    if (text(unit.status) === "retired") continue;
    const at = counts.get(text(unit.type_id)) || {};
    const yard = homeYard(unit) || "";
    at[yard] = (at[yard] || 0) + 1;
    counts.set(text(unit.type_id), at);
  }
  return {
    answered: { applied: !!text(data.applied_at) },
    facilities: yards.map((yard) => ({ id: text(yard.id), name: text(yard.name) })),
    equipment: types.filter((type) => text(type.seed_key).startsWith(SEED_PREFIX)).map((type) => ({
      key: text(type.seed_key).slice(SEED_PREFIX.length), type_id: text(type.id), name: text(type.name), units: counts.get(text(type.id)) || {}
    })),
    types: types.length,
    units: units.filter((unit) => text(unit.status) !== "retired").length,
    applied_at: text(data.applied_at) || null,
    revision: Number(record?.revision || 0)
  };
}

/** Finishes the setup: the facilities, a type for each kind of equipment, and the units each facility is short of. */
export async function applyEquipmentSetup(auth: PlatformAuthContext, input: unknown) {
  const parsed = applyInputSchema.parse(input);
  const orgId = auth.orgId;
  const facilityKeys = new Set(parsed.facilities.map((row) => row.key));
  if (facilityKeys.size !== parsed.facilities.length) throw badRequest("equipment_setup_facility_twice", "Each location needs its own row.");
  const unknown = parsed.equipment.flatMap((row) => Object.keys(row.units).filter((name) => !facilityKeys.has(name)));
  if (unknown.length) throw badRequest("equipment_setup_facility_unknown", `${unknown[0]} is not one of the locations given.`);
  await ensureEquipmentSeed(orgId);

  // Facilities: the ones given back keep their id; the rest are new.
  const yards = new Map((await listYards(orgId)).map((yard) => [text(yard.id), yard]));
  const facility = new Map<string, JsonObject>();
  for (const row of parsed.facilities) {
    const existing = row.id ? yards.get(row.id) : undefined;
    if (row.id && !existing) throw badRequest("equipment_setup_facility_missing", `The location ${row.name} was removed. Close the setup and try again.`);
    const yard = existing
      ? (text(existing.name) === row.name ? existing : await saveYard(orgId, { ...existing, name: row.name, expected_revision: Number(existing.revision || 0) }))
      : await saveYard(orgId, { name: row.name, address: {} });
    facility.set(row.key, yard);
  }

  // Kinds of equipment: one type each, made once (seed_key setup.<key>) and then left as the person keeps it.
  const categories = new Map((await listCategories(orgId)).map((category) => [text(category.seed_key), text(category.id)]));
  const made = new Map((await listTypes(orgId, { includeArchived: true })).filter((type) => text(type.seed_key).startsWith(SEED_PREFIX)).map((type) => [text(type.seed_key), type]));
  const units = await listUnits(orgId, { ownership: "internal" });
  let added = 0;
  const types: JsonObject[] = [];
  for (const row of parsed.equipment) {
    const seed = SEED_PREFIX + row.key;
    let type = made.get(seed);
    if (!type || text(type.status) === "archived") {
      const values = { name: row.name, kind: row.kind || "other", category_id: categories.get(text(row.category)) || "", description: row.description || "", icon: row.icon || "", provides: row.provides || [], tracking: "unit", mobility: "mobile", status: "active" };
      type = type ? await saveType(orgId, { ...type, ...values, expected_revision: Number(type.revision || 0) }) : await saveType(orgId, { ...values, seed_key: seed });
    }
    types.push(type);
    // Units: only what each facility is short of, numbered after the units of this type there are already.
    const ofType = units.filter((unit) => text(unit.type_id) === text(type!.id) && text(unit.status) !== "retired");
    let number = ofType.length;
    for (const [name, wanted] of Object.entries(row.units)) {
      const yard = facility.get(name)!;
      const have = ofType.filter((unit) => homeYard(unit) === text(yard.id)).length;
      for (let at = have; at < wanted; at++) {
        number += 1;
        const unit = { type_id: text(type.id), name: `${row.name} ${number}`, ownership: row.ownership, status: "available", home_location: yardLocation(yard), location: yardLocation(yard) };
        await authorizeEquipmentOwner(auth, unit);
        await saveUnit(orgId, unit);
        added += 1;
      }
    }
  }

  const current = await stored(orgId);
  await saveBranchModule(orgId, "default", EQUIPMENT_SETUP_MODULE, { data: { ...object(current?.data), applied_at: new Date().toISOString(), equipment: parsed.equipment.map((row) => row.key), facilities: [...facility.values()].map((yard) => text(yard.id)), updated_by: auth.userId } as JsonObject, expected_revision: Number(current?.revision || 0) }, { replace: true });
  return { ...(await readEquipmentSetup(orgId)), units_added: added, types_set_up: types.map((type) => text(type.id)) };
}

// ── Publication ─────────────────────────────────────────────────────────
const setupSchema = z.object({
  answered: z.object({ applied: z.boolean() }).strict(),
  facilities: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  equipment: z.array(z.object({ key: z.string(), type_id: z.string(), name: z.string(), units: z.record(z.string(), z.number().int()) }).strict()),
  types: z.number().int(), units: z.number().int(),
  applied_at: z.string().nullable(), revision: z.number().int()
}).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const readAccess: AccessPolicy = { scopes: ["organization"], permissions: [EQUIPMENT_VIEW], capabilities: ["apps.equipment"], systemKinds: ["work", "module", "agent"] };
const person = (ctx: PublicationContext) => { if (!ctx.auth) throw forbidden("equipment_setup_person", "The equipment setup is answered by a person."); return ctx.auth; };

let registered = false;
export function registerEquipmentSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "equipment-setup", version: "1", apps: ["equipment"], exports: {
    status: { description: "What the equipment setup knows: the organization's facilities (where it keeps equipment), the kinds of equipment the setup made with how many units each has at each facility (by facility id; '' is no facility), how many types and units the fleet has in all, and when the setup was finished.",
      schema: json(setupSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => { const value = await readEquipmentSetup(ctx.organizationId); return { value, revision: String(value.revision) }; } }
  } });
  registerAction({ id: "equipment.setup.apply", version: "1", domain: "equipment", implementation: backendImplementationDigest(),
    description: "Finish the equipment setup: the facilities the company keeps equipment at (an existing one by id, or a new one by name), the kinds of equipment it uses (a type each, with its category, functions and whether units are owned, leased or rented) and how many units of each are at each facility. Only adds: existing facilities, types and units are kept, and a facility gets only the units it is short of.",
    inputSchema: json(applyInputSchema) as Record<string, unknown>, outputSchema: { type: "object" },
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: [EQUIPMENT_MANAGE], capabilities: ["apps.equipment"] },
    validateInput: (value) => { applyInputSchema.parse(value); },
    execute: (ctx, _target, value) => applyEquipmentSetup(person(ctx), value) });
}
