/**
 * Differences the change history keeps: between a list's lines before and after a change, between a record's fields,
 * and between what a generator made and what the lines became. Lines are matched by id; a line is described by the
 * fields a person changes (name, product, colour and other options, quantity, unit, price, what it accounts for), so a
 * difference reads as what was done to it.
 */
export type JsonObject = Record<string, unknown>;
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const text = (value: unknown) => String(value ?? "").trim();
// Missing, empty text, an empty list and an empty object all mean "nothing", so filling one in is not a change.
const blank = (value: unknown) => value == null || value === "" || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length);
const same = (first: unknown, second: unknown) => (blank(first) && blank(second)) || JSON.stringify(first ?? null) === JSON.stringify(second ?? null);

/** What a line is, for history: the fields a person changes. */
export function lineFacts(value: unknown): JsonObject {
  const line = obj(value), metadata = obj(line.metadata), ref = obj(line.pricebook_ref);
  const facts: JsonObject = {
    // A calculated line is replaced by a new one with the same key each time it is applied; the key is what it is.
    id: text(line.id), match: text(line.key) || text(line.id), name: text(line.name), section: text(line.section || line.group), quantity: Number(line.quantity) || 0, unit: text(line.unit),
    unit_price: line.projected_unit_price != null ? Number(line.projected_unit_price) : line.unit_cost != null ? Number(line.unit_cost) : null, total: line.projected_total == null ? null : Number(line.projected_total),
    item_id: text(ref.item_id || line.product_id), options: Object.keys(obj(line.selected_options || ref.selected_options)).length ? obj(line.selected_options || ref.selected_options) : text(line.variant) ? { variant: text(line.variant) } : {},
    covers: Array.isArray(metadata.covers) ? metadata.covers : [], provides: Array.isArray(metadata.provides) ? metadata.provides : [],
    generated: metadata.generated_from_pay_sheet === true || !!text(metadata.generation_id) || !!text(metadata.calculus_line_id), generation_id: text(metadata.generation_id)
  };
  if (text(line.structure_id)) facts.structure_id = text(line.structure_id);
  return facts;
}

const COMPARED = ["name", "section", "quantity", "unit", "unit_price", "total", "item_id", "options", "covers", "provides", "structure_id"];

/** Lines added, removed and changed (each changed field with its value before and after). Empty when nothing differs. */
export function lineDiff(before: unknown[], after: unknown[]) {
  const facts = (lines: unknown[]) => lines.map((line) => (obj(line).match ? obj(line) : lineFacts(line)));
  const was = new Map(facts(before).map((line) => [text(line.match), line]));
  const now = new Map(facts(after).map((line) => [text(line.match), line]));
  const added = [...now.values()].filter((line) => !was.has(text(line.match)));
  const removed = [...was.values()].filter((line) => !now.has(text(line.match)));
  const changed = [...now.values()].flatMap((line) => {
    const previous = was.get(text(line.match));
    if (!previous) return [];
    const fields: JsonObject = {};
    for (const key of COMPARED) if (!same(previous[key], line[key])) fields[key] = { before: previous[key] ?? null, after: line[key] ?? null };
    return Object.keys(fields).length ? [{ id: text(line.id), name: text(line.name), fields }] : [];
  });
  return { added, removed, changed, empty: !added.length && !removed.length && !changed.length };
}

export function lineDiffSummary(diff: ReturnType<typeof lineDiff>) {
  const part = (count: number, word: string) => (count ? `${count} ${word}` : "");
  return [part(diff.added.length, "added"), part(diff.removed.length, "removed"), part(diff.changed.length, "changed")].filter(Boolean).join(", ") || "no line changes";
}

/** The named fields that differ between two records, each with its value before and after. */
export function fieldDiff(before: JsonObject, after: JsonObject, keys: string[]) {
  const pick = (record: JsonObject, key: string) => key.split(".").reduce<unknown>((value, part) => obj(value)[part], record);
  const fields: JsonObject = {};
  for (const key of keys) { const first = pick(before, key), second = pick(after, key); if (!same(first, second)) fields[key] = { before: first ?? null, after: second ?? null }; }
  return fields;
}

/**
 * What became of a generator's lines: compared with the lines as they stand now, which it made were removed or
 * changed, and which lines were added beside them that no generator made. This is what people did to the generation.
 */
export function generationOutcome(generated: unknown[], current: unknown[]) {
  const diff = lineDiff(generated, current);
  const added = diff.added.filter((line) => !line.generated);
  return { removed: diff.removed, changed: diff.changed, added, untouched: !diff.removed.length && !diff.changed.length && !added.length };
}

/** What a schedule event is, for history: the fields a person or the schedule changes. */
export const SCHEDULE_HISTORY_FIELDS = ["title", "kind", "status", "start_at", "end_at", "all_day", "resource_refs", "parent_event_id", "placement", "locked", "schedule_lock"];
