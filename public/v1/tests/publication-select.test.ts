import assert from "node:assert/strict";
import test from "node:test";

test("a declared selection filters, bounds and orders a published collection, and an index answers it identically", async () => {
  process.env.NODE_ENV = "test";
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const { registerDataProvider } = await import("../platform/publication/providers.js");
  const { selectPublishedData, selectionSupport } = await import("../platform/publication/select.js");

  const target = { scope: "organization" as const, organizationId: "org_select_test" };
  const ctx = systemPublicationContext({ kind: "module", organizationId: target.organizationId, operations: ["select-test.paged", "select-test.whole", "select-test.indexed", "select-test.single", "select-test.anonymous"], mode: "evaluate" });
  const access = { scopes: ["organization"] as const, permissions: [], systemKinds: ["module"] as const };
  const item = { type: "object", additionalProperties: true };
  const schema = { type: "array", items: item };
  const person = (id: string) => ({ subject_type: "organization_user", subject_id: id });
  const projects = [
    { id: "p1", revision: 3, booked_by: person("ana"), sold_at: "2026-03-01T15:00:00.000Z", total_cents: 100_00 },
    { id: "p2", revision: 1, booked_by: person("ben"), sold_at: "2026-03-02T15:00:00.000Z", total_cents: 900_00 },
    { id: "p3", revision: 7, booked_by: person("ana"), sold_at: "2026-03-31T23:30:00.000Z", total_cents: 500_00 },
    { id: "p4", revision: 2, booked_by: person("ana"), sold_at: "2026-04-01T00:00:00.000Z", total_cents: 700_00 },
    { id: "p5", booked_by: person("ana"), total_cents: 50_00 }
  ];
  let listCalls = 0;
  const list = async (_ctx: unknown, _ref: unknown, page: { limit: number; cursor?: string }) => {
    listCalls += 1;
    const start = Number(page.cursor || 0), size = 2;
    return { items: projects.slice(start, start + size), ...(start + size < projects.length ? { nextCursor: String(start + size) } : {}) };
  };
  let pushed: unknown;
  registerDataProvider({ id: "select-test", version: "1", apps: [], exports: {
    paged: { schema, schemaVersion: "1", description: "test", access, read: async () => ({ value: projects }), list },
    whole: { schema, schemaVersion: "1", description: "test", access, read: async () => ({ value: projects }) },
    indexed: { schema, schemaVersion: "1", description: "test", access, read: async () => ({ value: projects }),
      select: async (_ctx, _ref, selection) => { pushed = selection; return { items: [projects[2]!, projects[0]!], revision: "idx-9" }; } },
    single: { schema: item, schemaVersion: "1", description: "test", access, read: async () => ({ value: { id: "only" } }) },
    anonymous: { schema, schemaVersion: "1", description: "test", access, read: async () => ({ value: [{ name: "no id" }] }) }
  } });

  const ref = (name: string) => ({ provider: "select-test", export: name, target });
  const mineInMarch = {
    where: { match: "all", rules: [{ field: "booked_by.subject_type", operator: "equals", value: "organization_user" }, { field: "booked_by.subject_id", operator: "equals", value: "ana" }] },
    period: { field: "sold_at", from: "2026-03-01", through: "2026-03-31" },
    orderBy: { field: "total_cents", direction: "desc" }
  };

  // The whole-day end bound includes 23:30 on the last day and excludes the next midnight; a row with no date is not in any period.
  const scanned = await selectPublishedData(ctx, ref("paged"), mineInMarch);
  assert.equal(scanned.status, "ready");
  if (scanned.status !== "ready") throw Error("expected rows");
  assert.deepEqual(scanned.rows.map((row) => row.key), ["p3", "p1"]);
  assert.deepEqual(scanned.rows.map((row) => row.revision), ["7", "3"]);
  assert.equal(listCalls, 3, "every page is read when there is no index");
  assert.deepEqual(scanned.provenance, { selection: "scan", scanned: 5 });

  // A collection that is only readable as a whole gives the same answer.
  const whole = await selectPublishedData(ctx, ref("whole"), mineInMarch);
  assert.equal(whole.status, "ready");
  if (whole.status !== "ready") throw Error("expected rows");
  assert.deepEqual(whole.rows, scanned.rows);
  assert.equal(whole.source.revision, scanned.source.revision, "the same rows at the same revisions are the same observation");

  // An indexed provider receives the parsed selection; the caller's request and result shape do not change.
  const indexed = await selectPublishedData(ctx, ref("indexed"), mineInMarch);
  assert.equal(indexed.status, "ready");
  if (indexed.status !== "ready") throw Error("expected rows");
  assert.deepEqual(indexed.rows, scanned.rows);
  assert.equal(indexed.source.revision, "idx-9");
  assert.deepEqual(indexed.provenance, { selection: "indexed" });
  assert.equal((pushed as { limit: number }).limit, 1000);
  assert.deepEqual(selectionSupport({ provider: "select-test", export: "indexed" }), { selectable: true, indexed: true });
  assert.deepEqual(selectionSupport({ provider: "select-test", export: "paged" }), { selectable: true, indexed: false });
  assert.deepEqual(selectionSupport({ provider: "select-test", export: "single" }), { selectable: false, indexed: false });

  // No selection is every row in key order; a row without a stored revision gets a content revision that follows its content.
  const all = await selectPublishedData(ctx, ref("whole"), {});
  if (all.status !== "ready") throw Error("expected rows");
  assert.deepEqual(all.rows.map((row) => row.key), ["p1", "p2", "p3", "p4", "p5"]);
  assert.match(all.rows[4]!.revision, /^sha256:/);

  // Numeric operators, nesting and "any" come from the shared condition contract.
  const large = await selectPublishedData(ctx, ref("whole"), { where: { match: "any", rules: [{ field: "total_cents", operator: "greater_or_equal", value: 70000 }, { match: "all", rules: [{ field: "sold_at", operator: "is_missing" }] }] } });
  if (large.status !== "ready") throw Error("expected rows");
  assert.deepEqual(large.rows.map((row) => row.key), ["p2", "p4", "p5"]);

  // Relative times are measured from asOf, so the same selection repeats.
  const recent = { where: { rules: [{ field: "sold_at", operator: "after", value: "now-2d" }] }, asOf: "2026-04-02T00:00:00.000Z" };
  const first = await selectPublishedData(ctx, ref("whole"), recent);
  if (first.status !== "ready") throw Error("expected rows");
  assert.deepEqual(first.rows.map((row) => row.key), ["p3", "p4"]);

  // Too many matches, a malformed selection, a non-collection and rows without identity all fail visibly.
  const failed = async (name: string, selection: unknown) => { const result = await selectPublishedData(ctx, ref(name), selection); assert.equal(result.status, "error"); return (result as { code: string }).code; };
  assert.equal(await failed("whole", { limit: 2 }), "selection_too_large");
  assert.equal(await failed("whole", { where: { rules: [{ field: "total_cents", operator: "roughly", value: 1 }] } }), "selection_invalid");
  assert.equal(await failed("whole", { where: { "booked_by.subject_id": "ana" } }), "selection_invalid");
  assert.equal(await failed("whole", { period: { field: "sold_at" } }), "selection_invalid");
  assert.equal(await failed("whole", { filter: "mine" }), "selection_invalid");
  assert.equal(await failed("single", {}), "source_not_selectable");
  assert.equal(await failed("anonymous", {}), "selection_identity");
  assert.equal((await selectPublishedData(ctx, { ...ref("whole"), target: { ...target, organizationId: "other" } }, {})).status, "denied");
  assert.equal((await selectPublishedData(ctx, ref("unknown"), {})).status, "error");
});
