import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { badRequest, forbidden } from "../platform/errors.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { effectiveCapabilities, isCapabilityEnabled } from "../platform/capabilities.js";
import { appDefinition, appDefinitions, canonicalAppId } from "../platform/app-experience/registry.js";
import { invokeAction, registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { listMeasurementDefinitions, listMeasurementSchemas, measurementBase } from "../platform/publication/measurement-schemas.js";
import { createOrganizationConnection, listOrganizationConnections } from "../connections/storage.js";
import { createResourceGroup, listResourceGroups, patchResourceGroup, putResourceGroupMember, readResourceGroup, readWorkforceConfiguration } from "../workforce/storage.js";
import { listDocuments } from "../platform/storage.js";
import { readCompanyProfile } from "../company-profile/profile.js";
import { WORKFORCES, industrySetsFor } from "../company-profile/catalog.js";
import { listPaySheets, measurementsRead, paySheetCoverRoles, type PaySheet } from "./pay-sheets.js";
import { listDeclaredCapabilities, serviceTags } from "./capabilities.js";
import { assigneeTypeIds } from "../assignees/base.js";

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
 *
 * GP-66 adds: within each service, the kinds of it each one does in the company's own words (`service_tags`, saved
 * with its capabilities); a service a crew does that the company profile lacked is added to the profile; which member
 * of a group is in charge (its lead, through the member writer); and which of the crew apps a group's members see
 * (`apps`, the group's App experience settings, docs/architecture/app-experience.md).
 */
const text = (value: unknown) => String(value ?? "").trim();
const SCHEMA_ID = "roofing";
// What a roofing job's labor covers; the same work items the sample sheets name (labor/sample-pay-sheets.ts).
const ROOF_WORK = ["roofing.tear_off", "roofing.dry_in", "roofing.install"];
const TRIM = ["roofing.edge_metal", "roofing.ridge_cap", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"];
export const LABOR_PAY_METHODS = ["per_measurement", "hourly", "per_job"] as const;

const assigneeRef = z.object({ type: z.enum(["resource_group", "organization_connection"]), id: z.string().trim().min(1).max(200) }).strict();
const dollars = z.number().finite().min(0).max(1_000_000);
/** A pitch in twelfths: 0 is flat, null is no upper end. Ranges start and end where the dictionary's pitch bands do. */
const pitch = z.number().finite().min(0).max(24);
/**
 * One piece rate item (GP-162). Pitch ranges are instead of each other: every square is paid at the rate of the one
 * range its pitch falls in, and together the ranges take in every pitch. Everything else is added on top: a bonus for
 * each square in a range of pitches (over 8/12, two dollars more), or a rate per unit of another roofing measurement.
 */
const pieceItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pitch_range"), above: pitch, up_to: pitch.nullable(), rate: dollars }).strict(),
  z.object({ type: z.literal("pitch_bonus"), above: pitch, up_to: pitch.nullable().default(null), rate: dollars }).strict(),
  z.object({ type: z.literal("measurement"), measurement: z.string().trim().min(1).max(120), rate: dollars }).strict()
]);
export type PieceItem = z.infer<typeof pieceItem>;
const payInput = z.object({
  method: z.enum(LABOR_PAY_METHODS),
  /** Dollars per unit (per square, per foot, per hour) or per job. A piece rate with `items` has its rates there. */
  rate: dollars.default(0),
  /** For a one-line piece rate: the roofing measurement it is paid on. Defaults to roof squares. */
  measurement: z.string().trim().max(120).optional(),
  /** For a piece rate: its items, each a line of the pay sheet. Given, they replace `rate` and `measurement`. */
  items: z.array(pieceItem).min(1).max(30).optional()
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
    member_user_ids: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
    /** For a group: the member in charge of it (its lead). One of its members, or one added here. */
    lead_user_id: z.string().trim().min(1).max(200).optional(),
    /** Within each service it does, the kinds of it it does, in the company's own words. Given, they replace the ones saved before. */
    service_tags: z.record(z.string().trim().min(1).max(80), z.array(z.string().trim().min(1).max(60)).max(30)).optional(),
    /** For a group: which apps its members see, and app options (Today's time clock), as the group's App experience settings. */
    apps: z.record(z.string().trim().min(1).max(120), z.object({ visible: z.boolean().optional(), options: z.record(z.string().trim().min(1).max(60), z.boolean()).optional() }).strict()).optional()
  }).strict()).max(40).default([])
}).strict();
export type LaborSetupInput = z.infer<typeof laborSetupInputSchema>;

const PITCH_BANDS = "roof.pitch_bands";
/**
 * The roofing measurements a piece rate can be paid on, with their labels and units: every one the roofing kind of
 * work measures (GP-162), squares first, then lines. The pitch bands are not listed one by one: a piece rate reads
 * them as pitch ranges and bonuses (`pitchBands`), and squares at each exact pitch only add up to the roof's squares.
 */
export function payMeasurements() {
  const schema = listMeasurementSchemas().find((entry) => entry.id === SCHEMA_ID);
  const definitions = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
  const offered = (schema?.measurements || []).map((entry) => definitions.get(entry.definition)).filter((definition): definition is NonNullable<typeof definition> => !!definition && definition.slice?.partition !== PITCH_BANDS && !definition.keyPattern);
  const squares = (unit: string) => unit === "roofing_square" || unit === "ft2" ? 0 : 1;
  return offered.sort((a, b) => squares(a.unit) - squares(b.unit)).map((definition) => ({ id: definition.id, label: text(definition.label) || definition.id, unit: text(definition.unit), ...(definition.slice ? { part_of: measurementBase(definition.id) } : {}) }));
}
/**
 * The dictionary's pitch bands of roof squares, flattest first, each with the pitches it takes in (over `above`, up to
 * `up_to`; the first starts at 0). A pitch range or bonus starts and ends where these do.
 */
export function pitchBands() {
  return listMeasurementDefinitions().filter((definition) => definition.slice?.partition === PITCH_BANDS && definition.derive)
    .map((definition) => ({ id: definition.id, label: definition.label, above: Math.max(0, definition.derive!.above), up_to: definition.derive!.upTo }))
    .sort((a, b) => a.above - b.above);
}
const twelfths = (value: number) => `${value}/12`;
/** What a range of pitches is called on a pay sheet: "Squares over 2/12 up to 8/12". */
export function pitchRangeLabel(above: number, upTo: number | null) {
  if (!above && upTo === null) return "All roof squares";
  if (!above) return `Squares up to ${twelfths(upTo!)}`;
  return upTo === null ? `Squares over ${twelfths(above)}` : `Squares over ${twelfths(above)} up to ${twelfths(upTo)}`;
}
/** The bands a range of pitches takes in, or null when it does not start and end where bands do. */
function bandsFor(above: number, upTo: number | null) {
  const bands = pitchBands();
  const inside = bands.filter((band) => band.above >= above && (upTo === null ? true : band.up_to !== null && band.up_to <= upTo));
  if (!inside.length || inside[0]!.above !== above || (upTo === null ? inside.at(-1)!.up_to !== null : inside.at(-1)!.up_to !== upTo)) return null;
  return inside.map((band) => band.id);
}
// The trim a line of the roof is the work of, so a rate per foot of it pays for that work.
const LINE_WORK: Record<string, string> = {
  "roof.eave_length": "roofing.edge_metal", "roof.rake_length": "roofing.edge_metal", "roof.ridge_length": "roofing.ridge_cap", "roof.hip_length": "roofing.ridge_cap", "roof.valley_length": "roofing.valleys",
  "roof.head_wall_length": "roofing.wall_flashing", "roof.side_wall_length": "roofing.wall_flashing", "roof.chimney_back_length": "roofing.wall_flashing", "roof.chimney_step_length": "roofing.wall_flashing", "roof.chimney_apron_length": "roofing.wall_flashing", "roof.skylight_length": "roofing.wall_flashing"
};
const money = (value: number) => Math.round(value * 100);

/**
 * A piece rate's items as pay sheet lines. Pitch ranges must take in every pitch once between them; each reads its
 * bands as one input. A bonus is marked as adjusting the price, so it never counts as paying for the roof a second time.
 */
function pieceSheet(items: PieceItem[]) {
  const offered = new Map(payMeasurements().map((entry) => [entry.id, entry]));
  const inputs: { name: string; label: string; source: { kind: "measurement"; definition: string; also?: string[]; per_structure?: boolean }; required: boolean }[] = [];
  const entries: { label: string; kind: "piece_rate"; unit: string; rate_cents: number; input: string; covers: string[]; role?: "adjusts" }[] = [];
  const read = (name: string, label: string, bands: string[]) => { inputs.push({ name, label, source: { kind: "measurement", definition: bands[0]!, ...(bands.length > 1 ? { also: bands.slice(1) } : {}), per_structure: true }, required: true }); return name; };
  const ranges = items.filter((item): item is Extract<PieceItem, { type: "pitch_range" }> => item.type === "pitch_range").sort((a, b) => a.above - b.above);
  if (ranges.length) {
    // One rate for each range: together they take in every pitch, each once.
    let from = 0;
    for (const range of ranges) {
      if (range.above !== from || (range.up_to !== null && range.up_to <= range.above)) throw badRequest("labor_setup_pitch_ranges", "Pitch ranges must follow on from each other, from flat to the steepest, with no gaps.");
      from = range.up_to ?? Infinity;
    }
    if (from !== Infinity) throw badRequest("labor_setup_pitch_ranges", "The steepest pitch range must take in every pitch above it.");
  }
  const used = new Set<string>();
  for (const item of items) {
    if (item.type === "measurement") {
      const measurement = offered.get(item.measurement);
      if (!measurement) throw badRequest("labor_setup_measurement", `${item.measurement} is not a roofing measurement a piece rate can be paid on.`);
      if (used.has(item.measurement)) throw badRequest("labor_setup_measurement_twice", `${measurement.label} is paid twice.`);
      used.add(item.measurement);
      const area = measurement.unit === "roofing_square" || measurement.unit === "ft2";
      const name = item.measurement.replace(/^roof\./, "").replace(/[^a-z0-9_]/g, "_");
      inputs.push({ name, label: measurement.label, source: { kind: "measurement", definition: measurement.id, ...(area ? { per_structure: true } : {}) }, required: !measurement.part_of });
      entries.push({ label: measurement.label, kind: "piece_rate", unit: measurement.unit === "roofing_square" ? "sq" : measurement.unit === "ft2" ? "sq ft" : "ft", rate_cents: money(item.rate), input: name, covers: area ? ROOF_WORK : LINE_WORK[measurement.id] ? [LINE_WORK[measurement.id]!] : [] });
      continue;
    }
    const bands = bandsFor(item.above, item.up_to);
    if (!bands) throw badRequest("labor_setup_pitch", `Pitches go over ${pitchBands().map((band) => twelfths(band.above)).join(", ")}; a range starts and ends at one of them.`);
    const label = pitchRangeLabel(item.above, item.up_to);
    if (item.type === "pitch_range") entries.push({ label, kind: "piece_rate", unit: "sq", rate_cents: money(item.rate), input: read(`pitch_${item.above}_${item.up_to ?? "up"}`, label, bands), covers: ROOF_WORK });
    else entries.push({ label: `Bonus: ${label.charAt(0).toLowerCase()}${label.slice(1)}`, kind: "piece_rate", unit: "sq", rate_cents: money(item.rate), input: read(`bonus_${item.above}_${item.up_to ?? "up"}`, label, bands), covers: ROOF_WORK, role: "adjusts" });
  }
  // Trim nobody is paid for by the foot is part of the price.
  const paid = new Set(entries.flatMap((entry) => entry.covers));
  return { inputs, entries, work: TRIM.filter((item) => !paid.has(item)).map((item) => ({ item, included: true })) };
}

/** A one-line pay sheet as this setup writes it, for one assignee. */
export function laborPaySheet(subject: { type: "resource_group" | "organization_connection"; id: string }, name: string, pay: z.infer<typeof payInput>) {
  const cents = Math.round(pay.rate * 100);
  const covers = [...ROOF_WORK, ...TRIM];
  const base = { subject, name: `${name} roofing pay`, schema_ids: [SCHEMA_ID], equipment: [] as unknown[] };
  if (pay.method === "hourly") return { ...base, inputs: [{ name: "hours", label: "Hours", source: { kind: "manual" as const }, required: true }], entries: [{ label: "Hourly labor", kind: "hourly" as const, unit: "hour", rate_cents: cents, input: "hours", covers }], work: [] };
  if (pay.method === "per_job") return { ...base, inputs: [], entries: [{ label: "Price per job", kind: "flat" as const, rate_cents: cents, covers }], work: [] };
  if (pay.items?.length) return { ...base, ...pieceSheet(pay.items) };
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

/**
 * How a sheet pays, when it is one this setup could have written: one hourly or flat line, or piece rates that each
 * read one roofing measurement, a pitch range or a bonus over a range of pitches. A piece rate comes back as its items.
 */
export function simplePay(sheet: Pick<PaySheet, "entries" | "inputs" | "schema_ids"> & Partial<Pick<PaySheet, "equipment" | "duration">>) {
  if (!sheet.entries.length) return null;
  const entry = sheet.entries[0]!;
  if (sheet.entries.length === 1 && entry.kind === "hourly") return { method: "hourly" as const, rate: entry.rate_cents / 100 };
  if (sheet.entries.length === 1 && entry.kind === "flat" && !entry.input) return { method: "per_job" as const, rate: entry.rate_cents / 100 };
  // More than one line, with equipment or a duration besides, is more than this setup writes: saving it here would lose them.
  if (sheet.entries.length > 1 && (sheet.equipment?.length || sheet.duration)) return null;
  const bands = pitchBands(), offered = new Set(payMeasurements().map((row) => row.id)), roles = paySheetCoverRoles(sheet);
  const items: PieceItem[] = [];
  for (const line of sheet.entries) {
    const source = sheet.inputs.find((row) => row.name === line.input)?.source;
    if (line.kind !== "piece_rate" || source?.kind !== "measurement" || line.when || line.minimum_cents || (line.multiplier ?? 1) !== 1) return null;
    const rate = line.rate_cents / 100, read = measurementsRead(source);
    const run = read.map((id) => bands.find((band) => band.id === id));
    if (run.every(Boolean)) {
      // Bands read together are a range only when they follow on from each other.
      const sorted = run.map((band) => band!).sort((a, b) => a.above - b.above);
      if (sorted.some((band, at) => at > 0 && sorted[at - 1]!.up_to !== band.above)) return null;
      // A range that only adjusts the price of the roof (over 8/12, on top of every square) is a bonus.
      const adjusts = line.role === "adjusts" || [...(roles.get(line)?.values() || [])].includes("adjusts");
      items.push({ type: adjusts ? "pitch_bonus" : "pitch_range", above: sorted[0]!.above, up_to: sorted.at(-1)!.up_to, rate });
    } else if (read.length === 1 && offered.has(source.definition)) items.push({ type: "measurement", measurement: source.definition, rate });
    else return null;
  }
  // Only a sheet this setup would write again line for line: anything else (pitch ranges that leave pitches out, a
  // measurement paid twice, a line that pays for other work) is People's to edit, and saving it here would change it.
  const one = items.length === 1 && items[0]!.type === "measurement" ? items[0] : null;
  let again: Pick<PaySheet, "schema_ids" | "inputs" | "entries">;
  try { again = one ? laborPaySheet({ type: "resource_group", id: "-" }, "-", { method: "per_measurement", rate: one.rate, measurement: one.measurement }) as never : { schema_ids: [SCHEMA_ID], ...pieceSheet(items) } as never; } catch { return null; }
  if (JSON.stringify(payLines(sheet)) !== JSON.stringify(payLines(again))) return null;
  if (one) return { method: "per_measurement" as const, rate: one.rate, measurement: one.measurement, items };
  return { method: "per_measurement" as const, rate: 0, items };
}

/** A sheet's lines as what they pay: rate, what they read, what they pay for and whether they only adjust its price. */
function payLines(sheet: Pick<PaySheet, "schema_ids" | "inputs" | "entries">) {
  const roles = paySheetCoverRoles(sheet);
  return sheet.entries.map((entry) => {
    const source = sheet.inputs.find((row) => row.name === entry.input)?.source;
    return JSON.stringify([entry.kind, entry.rate_cents, source?.kind === "measurement" ? [...measurementsRead(source)].sort() : [], [...(entry.covers || [])].sort(), [...(roles.get(entry)?.values() || [])].includes("adjusts")]);
  }).sort();
}

/** The organization's people who can be put in a group, by name, with their email and whether they have joined yet (`invited`). */
async function organizationPeople(orgId: string) {
  return (await listDocuments(orgId, "users")).map((document) => {
    const data = (document.data || {}) as Record<string, unknown>;
    return { id: text(document.id), name: text(data.name) || text(data.email) || text(document.id), email: text(data.email).toLowerCase(), status: text(data.status) || "active", deleted: data.deleted === true };
  }).filter((user) => user.id && !user.deleted && user.status !== "disabled" && user.status !== "archived").map(({ id, name, email, status }) => ({ id, name, email, status: status === "invited" || status === "pending" ? "invited" : "active" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A group's App experience settings as the setup shows them: shown or hidden on every device it exists on, and its options. */
function groupApps(group: Record<string, unknown>) {
  const stored = ((group.attributes as Record<string, unknown> | undefined)?.app_defaults || {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, { visible?: boolean; options?: Record<string, boolean> }> = {};
  for (const [appId, setting] of Object.entries(stored && typeof stored === "object" ? stored : {})) {
    const values = Object.values((setting?.visible && typeof setting.visible === "object" ? setting.visible : {}) as Record<string, unknown>);
    const options = Object.fromEntries(Object.entries((setting?.options && typeof setting.options === "object" ? setting.options : {}) as Record<string, unknown>).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean>;
    const visible = values.length && values.every((value) => value === true) ? true : values.length && values.every((value) => value === false) ? false : undefined;
    if (visible !== undefined || Object.keys(options).length) out[appId] = { ...(visible !== undefined ? { visible } : {}), ...(Object.keys(options).length ? { options } : {}) };
  }
  return out;
}

/**
 * What the labor step shows: the organization's groups and outside companies (suppliers are not), how each is paid
 * for roofing, the services each does and a group's members, the types each kind can have and the measurements a piece
 * rate can read; and for the workforce setup, the company profile it starts from (kind of company, its services, who
 * does the work) and the people who can be put in a group.
 */
export async function laborSetupOptions(orgId: string, auth?: PlatformAuthContext | null) {
  const [groups, companies, sheets, configuration, declared, profile, people, capabilities] = await Promise.all([listResourceGroups(orgId, {}), listOrganizationConnections(orgId, {}), listPaySheets(orgId), readWorkforceConfiguration(orgId), listDeclaredCapabilities(orgId), readCompanyProfile(orgId), organizationPeople(orgId), effectiveCapabilities(orgId).catch(() => null)]);
  const declaredOf = (type: string, id: string) => declared.find((row) => row.assignee.type === type && row.assignee.id === id);
  const servicesOf = (type: string, id: string) => declaredOf(type, id)?.service_ids || [];
  const tagsOf = (type: string, id: string) => declaredOf(type, id)?.service_tags || {};
  // The kinds of each service any one of them does, to offer the next one.
  const used: Record<string, string[]> = {};
  for (const row of declared) for (const [service, tags] of Object.entries(row.service_tags || {})) used[service] = [...new Set([...(used[service] || []), ...tags])];
  const leadOf = (group: Record<string, unknown>) => text(group.primary_member_user_id) || text((Array.isArray(group.members) ? group.members as Record<string, unknown>[] : []).find((member) => member.is_lead === true && text(member.status || "active") === "active")?.user_id);
  // Apps the organization has off: their switches are all off, so nobody is asked about them.
  const on = capabilities?.effectiveByKey || {};
  const appsOff = capabilities ? appDefinitions().filter((app) => app.capabilities.length && !app.capabilities.some((key) => on[key] === true)).map((app) => app.id) : [];
  const membersOf = (group: Record<string, unknown>) => (Array.isArray(group.members) ? group.members as Record<string, unknown>[] : []).filter((member) => text(member.status || "active") === "active").map((member) => text(member.user_id)).filter(Boolean);
  const sheetFor = (type: string, id: string) => sheets.find((sheet) => sheet.subject.type === type && sheet.subject.id === id && (sheet.schema_ids.includes(SCHEMA_ID) || !sheet.schema_ids.length));
  // `simple` is a one-line sheet as the price book setup's labor step edits it; `items` is a piece rate the workforce
  // setup edits item by item (GP-162). A sheet with neither is edited in People.
  const pay = (type: string, id: string) => {
    const sheet = sheetFor(type, id); if (!sheet) return null;
    const read = simplePay(sheet);
    const simple = read && (read.method !== "per_measurement" || read.items.length === 1) ? { method: read.method, rate: read.rate, ...(read.method === "per_measurement" ? { measurement: read.measurement } : {}) } : null;
    return { sheet_id: sheet.id, name: sheet.name, lines: sheet.entries.length, simple, ...(read?.method === "per_measurement" ? { items: read.items } : {}) };
  };
  const types = (rows: unknown) => (Array.isArray(rows) ? rows : []).filter((row) => text((row as { status?: unknown }).status || "active") !== "archived").map((row) => ({ id: text((row as { id?: unknown }).id), name: text((row as { name?: unknown }).name) || text((row as { id?: unknown }).id) }));
  // Each one's types as the assignee base keeps them (a company's types are not its relationship types).
  const typeIds = async (type: "resource_group" | "organization_connection", id: string, fallback: string[]) => { const found = await assigneeTypeIds(orgId, { type, id }).catch(() => [] as string[]); return found.length ? found : fallback; };
  const withTypes = <T extends { ref: { type: string; id: string }; type_ids: string[] }>(rows: T[]) => Promise.all(rows.map(async (row) => ({ ...row, type_ids: await typeIds(row.ref.type as "resource_group", row.ref.id, row.type_ids) })));
  return {
    assignees: await withTypes([
      ...groups.map((group) => ({ ref: { type: "resource_group", id: text(group.id) }, kind: "resource_group", name: text(group.name), type_id: text(group.kind_id), type_ids: [text(group.kind_id)].filter(Boolean), members: membersOf(group).length, member_user_ids: membersOf(group), lead_user_id: leadOf(group), service_ids: servicesOf("resource_group", text(group.id)), service_tags: tagsOf("resource_group", text(group.id)), apps: groupApps(group), pay: pay("resource_group", text(group.id)) })),
      ...companies.map((company) => ({ ref: { type: "organization_connection", id: text(company.id) }, kind: "organization_connection", name: text(company.name), type_id: text((Array.isArray(company.relationship_type_ids) ? company.relationship_type_ids : [])[0]), type_ids: (Array.isArray(company.relationship_type_ids) ? company.relationship_type_ids : []).map(text).filter(Boolean), members: 0, member_user_ids: [] as string[], lead_user_id: "", service_ids: servicesOf("organization_connection", text(company.id)), service_tags: tagsOf("organization_connection", text(company.id)), apps: {}, pay: pay("organization_connection", text(company.id)) }))
    ]),
    profile: {
      company_type: profile.company_type, industry: profile.industry, industry_sets: industrySetsFor(profile.industry),
      services: profile.services.map((entry) => ({ id: entry.id, label: entry.label, work_kind: entry.work_kind })),
      work_kinds: profile.work_kinds, workforce: profile.workforce
    },
    workforces: WORKFORCES.map((entry) => ({ id: entry.id, label: entry.label, hint: entry.hint, team: entry.team })),
    people,
    service_tags_used: used,
    apps_off: appsOff,
    // What the person may do from the setup beyond it: add people to the organization and invite them (People's permission),
    // and say how each is paid: pay sheets are Operations', so without it the setup has no pay page (GP-143).
    can: { add_people: !!auth && hasPermission(auth, "manage_company_users|manage_users"), invite: !!auth && hasPermission(auth, "manage_company_users|manage_users"), pay: !capabilities || on["platform.materials"] === true },
    group_types: types(configuration.resource_group_kinds),
    company_types: types(configuration.organization_connection_types),
    measurements: payMeasurements(),
    // Where a piece rate's pitch ranges and bonuses can start and end.
    pitch_bands: pitchBands(),
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
  // Crews and subcontractors are set up with the crew app alone (GP-143: from Scheduling's New appointment, before
  // Operations is on); how they are paid is a pay sheet, which only Operations keeps, so pay is left for then.
  const payable = await isCapabilityEnabled(orgId, "platform.materials");
  // Apps and options are checked before anything is written.
  for (const entry of input.assignees) {
    if (entry.apps && Object.keys(entry.apps).length && entry.kind !== "resource_group") throw badRequest("labor_setup_apps_group", "Only a group's members are shown apps from here.");
    for (const [appId, want] of Object.entries(entry.apps || {})) {
      const definition = appDefinition(canonicalAppId(appId));
      if (!definition) throw badRequest("labor_setup_app_unknown", `There is no app called ${appId}.`);
      for (const key of Object.keys(want.options || {})) if (!definition.options.some((option) => option.key === key)) throw badRequest("labor_setup_app_option_unknown", `${definition.title} has no option called ${key}.`);
    }
    if (entry.lead_user_id && entry.kind !== "resource_group") throw badRequest("labor_setup_lead_group", "Only a group has someone in charge.");
  }
  // A service one of them does that the company profile lacked: the company does it too.
  const profile = await readCompanyProfile(orgId);
  const offered = profile.services.map((entry) => entry.id);
  const added = [...new Set(input.assignees.flatMap((entry) => entry.service_ids || []))].filter((id) => !offered.includes(id));
  if (added.length) await invokeAction(command, { action: "company-profile.save", target }, { services: [...offered, ...added] }, { idempotencyKey: `labor-setup:profile-services:${[...offered, ...added].join(",")}:${Date.now()}` });
  const results: { ref: { type: string; id: string }; name: string; kind: string; created: boolean; pay: "saved" | "kept" | "none"; service_ids?: string[]; members?: number; lead_user_id?: string }[] = [];
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
    if (entry.pay && payable) {
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
    // Who is in charge: one of its members, made its lead through the same writer (the member writer keeps one lead).
    let lead: string | undefined;
    if (ref.type === "resource_group" && entry.lead_user_id) {
      let group = await readResourceGroup(orgId, ref.id);
      const member = (Array.isArray(group.members) ? group.members as Record<string, unknown>[] : []).find((row) => text(row.user_id) === entry.lead_user_id && text(row.status || "active") === "active");
      if (!member) throw badRequest("labor_setup_lead_not_member", `${entry.name}'s lead must be one of its members.`);
      if (member.is_lead !== true) group = await putResourceGroupMember(orgId, ref.id, entry.lead_user_id, { expected_revision: group.revision, is_lead: true, role: text(member.role) || "member" });
      lead = entry.lead_user_id;
    }
    // Which apps its members see: the group's App experience settings, on every device each app exists on.
    if (ref.type === "resource_group" && entry.apps && Object.keys(entry.apps).length) {
      const group = await readResourceGroup(orgId, ref.id);
      const attributes = { ...((group.attributes || {}) as Record<string, unknown>) };
      const settings = { ...((attributes.app_defaults && typeof attributes.app_defaults === "object" ? attributes.app_defaults : {}) as Record<string, Record<string, unknown>>) };
      for (const [appId, want] of Object.entries(entry.apps)) {
        const definition = appDefinition(canonicalAppId(appId))!;
        const before = { ...(settings[definition.id] || {}) };
        settings[definition.id] = { ...before,
          ...(want.visible !== undefined ? { visible: Object.fromEntries(definition.devices.map((device) => [device, want.visible])) } : {}),
          ...(want.options ? { options: { ...((before.options && typeof before.options === "object" ? before.options : {}) as Record<string, unknown>), ...want.options } } : {}) };
      }
      if (JSON.stringify(settings) !== JSON.stringify(attributes.app_defaults || {})) await patchResourceGroup(orgId, ref.id, { attributes: { ...attributes, app_defaults: settings }, expected_revision: group.revision });
    }
    // What it does: the services it was given replace the ones saved before; the rest of its capabilities stay.
    // The kinds within a service are kept for the services it does.
    if (entry.service_ids || entry.service_tags) {
      const current = declared.find((row) => row.assignee.type === ref!.type && row.assignee.id === ref!.id);
      const service_ids = entry.service_ids ? [...new Set(entry.service_ids)] : current?.service_ids || [];
      const service_tags = serviceTags(entry.service_tags ?? current?.service_tags ?? {}, service_ids);
      const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
      if (!current || !same([...current.service_ids].sort(), [...service_ids].sort()) || !same(current.service_tags || {}, service_tags)) {
        await invokeAction(command, { action: "assignees.capabilities.save", target }, { assignee: ref, schema_ids: current?.schema_ids || [], service_ids, service_tags, item_ids: current?.item_ids || [], excluded_item_ids: current?.excluded_item_ids || [], ...(current ? { expected_revision: current.revision } : {}) }, { idempotencyKey: `labor-setup:services:${ref.type}:${ref.id}:${service_ids.join(",")}:${Date.now()}` });
      }
    }
    results.push({ ref, name: entry.name, kind: ref.type, created, pay, ...(entry.service_ids ? { service_ids: [...new Set(entry.service_ids)] } : {}), ...(members !== undefined ? { members } : {}), ...(lead ? { lead_user_id: lead } : {}) });
  }
  return { assignees: results };
}

const strings = { type: "array", items: { type: "string" } };
const named = { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } };
const setupStatusSchema = { type: "object", required: ["assignees", "profile", "people", "group_types", "company_types", "measurements", "methods"], properties: {
  assignees: { type: "array", items: { type: "object", required: ["ref", "kind", "name", "service_ids", "member_user_ids"], properties: { ref: { type: "object" }, kind: { enum: ["resource_group", "organization_connection"] }, name: { type: "string" }, type_id: { type: "string" }, type_ids: strings, members: { type: "integer" }, member_user_ids: strings, lead_user_id: { type: "string" }, service_ids: strings, service_tags: { type: "object" }, apps: { type: "object" }, pay: { type: ["object", "null"] } } } },
  profile: { type: "object" }, workforces: { type: "array", items: { type: "object" } }, people: { type: "array", items: { ...named, properties: { ...named.properties, email: { type: "string" }, status: { enum: ["active", "invited"] } } } },
  service_tags_used: { type: "object" }, apps_off: strings, can: { type: "object" },
  group_types: { type: "array", items: named }, company_types: { type: "array", items: named }, measurements: { type: "array", items: { type: "object" } }, pitch_bands: { type: "array", items: { type: "object" } }, methods: strings
} };

export function registerLaborSetupPublication() {
  // What the workforce setup and Operations settings show (GP-28): who does the work, what each does, who is in a group
  // and how each is paid. Pay is commercial, so it is read with the permission that sets it.
  registerDataProvider({ id: "workforce-setup", version: "1", apps: ["materials", "crew"], exports: {
    status: { description: "Who does the organization's work: its groups of users (crews) and outside companies (subcontractors), each with the company profile services it does and the kinds of each in the company's words (service_tags), a group's members, who is in charge of it (lead_user_id) and which apps its members are shown or not (apps), and how it is paid for roofing (a one-line pay sheet's method and rate; a piece rate's items, its pitch ranges, bonuses and rates per measurement; or how many lines a fuller sheet has); with the company profile it starts from (kind of company, industry sets, services, who does most of the work), the people who can be put in a group (with their email, and `invited` while they have not joined), the kinds of each service any of them does (service_tags_used), the apps the organization has off (apps_off), whether the person may add and invite people (can), the types each kind can have, the measurements a piece rate can read and the pitch bands its ranges start and end at.",
      schema: setupStatusSchema, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["apps.crew"], systemKinds: ["agent"] },
      read: async (ctx) => { const value = await laborSetupOptions(ctx.organizationId, ctx.auth); return { value, revision: `sha256:${contentHash(value)}` }; } }
  } });
  registerAction({
    id: "labor.setup.apply", version: "1", domain: "materials", implementation: backendImplementationDigest(),
    description: "Set up who does the labor: add groups of users (employees) and outside companies (subcontractors) by name, change their type, say which of the company's services each does (service_ids, from the company profile catalog; one the company profile lacks is added to it) and the kinds of each in the company's words (service_tags), add people of the organization to a group (member_user_ids; none are removed) and say which member is in charge (lead_user_id), choose which apps a group's members see (apps: { \"portal.crew_payouts\": { visible: true } }, its App experience settings), and save how each is paid for roofing as a pay sheet (hourly, per job, or a piece rate; rates in dollars). A piece rate is either one rate on a roofing measurement (measurement, rate) or its items: pitch ranges ({ type: \"pitch_range\", above, up_to, rate }, one rate per range, instead of each other, which together take in every pitch from 0 to up_to null), bonuses added on top for squares in a range of pitches ({ type: \"pitch_bonus\", above, up_to, rate }) and rates per unit of any roofing measurement added on top ({ type: \"measurement\", measurement, rate }). Pitches are in twelfths and start and end where the status's pitch_bands do. An assignee whose pay sheet is more than this setup writes is left alone. To write a fuller pay sheet from a document, use pay-sheets.try then pay-sheets.sheet.save.",
    inputSchema: zodToJsonSchema(laborSetupInputSchema, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" },
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["apps.crew"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    validateInput: (value) => { laborSetupInputSchema.parse(value); },
    execute: async (ctx, _target, value) => applyLaborSetup(ctx, value)
  });
}
