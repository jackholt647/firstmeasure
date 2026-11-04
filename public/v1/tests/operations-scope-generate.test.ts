import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PublicationContext } from "../platform/publication/contracts.js";

// Operations setup "What does this project need?" generates its lines through the
// published `operations.scope.generate` action. A fresh organization (price book
// materialized from the global market book, no saved measurements) must get a
// default estimate, through the same action path the browser uses.
const ORG = "ops_generate";
let root: string;
let storage: typeof import("../platform/storage.js");
const auth = { orgId: ORG, userId: "owner", role: "owner", permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.materials": true, "platform.documents": true, "platform.pricebook": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } };
const ctx = { auth, organizationId: ORG, executionKind: "api", mode: "command" } as unknown as PublicationContext;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "operations-generate-"));
  process.env.NODE_ENV = "test"; process.env.PLATFORM_STORAGE_ROOT = root; process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(root, "pricebook");
  storage = await import("../platform/storage.js");
  await storage.createOrganization({ id: ORG });
  (await import("../platform/publication/bootstrap.js")).initializePublication();
  await import("../platform/capability_defs.js");
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.documents": true, "platform.pricebook": true });
});
after(async () => {
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
  await (await import("../platform/publication/bindings.js")).closeBindingStoreForTests();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const leaves = (row: any): any[] => (Array.isArray(row.children) && row.children.length ? row.children.flatMap(leaves) : [row]);

test("a fresh organization generates a default estimate through the published action", async () => {
  const p = `project_${randomUUID()}`; await storage.upsertDocument(ORG, "projects", { id: p, data: {} });
  const operations = await import("../operations/documents.js");
  await operations.prepareOperationsDocument({ ...ctx, projectId: p }, { project_id: p, path: "scope" });
  const { invokeAction } = await import("../platform/publication/actions.js");
  const target = { scope: "project" as const, organizationId: ORG, projectId: p };
  const piece = (id: string, name: string) => ({ id: `piece_${id}`, template_id: id, name });
  const generate = async (id: string, name: string, measurements: Record<string, unknown>) =>
    (await invokeAction({ ...ctx, projectId: p }, { action: "operations.scope.generate", target }, { selection: [piece(id, name)], measurements }) as { value: { items: any[] } }).value.items;
  const cases: [string, string, Record<string, unknown>][] = [
    ["roof_replacement", "Roof replacement", { roofSquares: 30, wastePercent: 10, eavesLf: 120, rakesLf: 80, ridgesLf: 40 }],
    ["roof_replacement", "Roof replacement", {}],
    ["gutters", "Gutter replacement", { gutterLf: 100 }],
    ["siding_replacement", "Siding replacement", { wallNetArea: 500, wallTerminationsLf: 60 }]
  ];
  for (const [id, name, measurements] of cases) {
    const items = await generate(id, name, measurements);
    const label = `${id} ${JSON.stringify(measurements)}`;
    assert.equal(items.length, 1, `${label}: one section`);
    const lines = leaves(items[0]);
    assert.ok(lines.length > 0, `${label}: generates lines`);
    assert.ok(lines.some((line) => line.operations_resource === "material"), `${label}: has material lines`);
  }
  const roof = (await generate("roof_replacement", "Roof replacement", cases[0]![2]))[0];
  assert.ok(leaves(roof).some((line) => line.operations_resource === "work"), "the roof scope includes work-order lines");
});

test("every default price book item resolves to a plain JSON scope item", async () => {
  const { readOrganizationPricebook } = await import("../pricebook/storage.js");
  const { resolveCatalogItemToScopeItem } = await import("../pricebook/resolver.js");
  const { jsonClone } = await import("../platform/publication/validation.js");
  const catalog = (await readOrganizationPricebook(ORG)).catalog as any;
  assert.ok(catalog.items.length > 0);
  for (const item of catalog.items) {
    const line = resolveCatalogItemToScopeItem(catalog, String(item.id));
    assert.doesNotThrow(() => jsonClone(line), `${item.id} resolves to plain JSON`);
  }
});

test("a proposal with generated lines resolves through the published action", async () => {
  const p = `project_${randomUUID()}`; await storage.upsertDocument(ORG, "projects", { id: p, data: {} });
  const { invokeAction } = await import("../platform/publication/actions.js");
  const target = { scope: "project" as const, organizationId: ORG, projectId: p };
  const pctx = { ...ctx, projectId: p };
  const run = async (action: string, input: Record<string, unknown>) => ((await invokeAction(pctx, { action, target }, input, { idempotencyKey: randomUUID() })) as { value: any }).value;
  const prepared = await run("operations.document.prepare", { project_id: p, path: "proposal" });
  const doc = prepared.document || prepared;
  const pieces = [{ id: "piece_roof", template_id: "roof_replacement", name: "Roof replacement" }];
  const measurements = { roofSquares: 22, wastePercent: 10, eavesLf: 120, rakesLf: 80, ridgesLf: 40 };
  const items = (await run("operations.scope.generate", { selection: pieces, measurements })).items;
  const saved = await run("operations.document.save", { document_id: doc.id, expected_revision: doc.revision ?? 1, params: { scope_pieces: pieces, measurements, scope_items: items } });
  assert.ok(saved);
  const resolved = await run("operations.document.resolve", { document_id: doc.id });
  assert.ok(resolved, "the proposal resolves for the live preview");
});
