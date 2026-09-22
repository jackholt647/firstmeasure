import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-doc-versions-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  // Version routes are a standalone plugin; register here unless the
  // integrator has already mounted them in src/app.ts.
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  if (!appSource.includes("registerVersionRoutes")) {
    const { registerVersionRoutes } = await import("../documents/versions/routes.js");
    registerVersionRoutes(app);
  }
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closeDocumentCheckpointsDatabase } = await import("../documents/versions/service.js");
  (await closeDocumentCheckpointsDatabase());
  if (app) await app.close();
  await closePlatformFixtureStores();
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Doc Versions Test Org",
    organization_id: `org_doc_versions_${suffix}`
  });
  await enableExpandedPlatformFixture(String(data.organization.id));
  const orgId = data.organization.id as string;
  await enableExpandedPlatformFixture(orgId, {
      "platform.documents": true,
      "documents.templates_studio": true,
      "documents.advanced_definition_editing": true,
      "documents.esign": true,
      "documents.payments": true,
      "platform.customer_portal": true,
      "customer_portal.payments": true,
      "platform.money": true,
      "money.take_payment": true
    });
  return { orgId };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Version Lane",
      title: "Jane Homeowner",
      project_type: "residential",
      contacts: [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

const BEFORE_TEXT = "The quick brown fox jumps over the lazy dog today";
const AFTER_TEXT = "The quick red fox jumps over the lazy dog";
const SECOND_TEXT = "This block gets removed by the edit";
const EXTRA_TEXT = "Brand new closing paragraph";

/** Template with FIXED node/block ids so checkpoints diff over stable ids. */
async function publishVersionsTemplate(client: ReturnType<typeof createSessionClient>, orgId: string, templateId: string) {
  const { FMDocModel } = await import("../documents/schemas.js");
  const definition: any = FMDocModel.createDocument({ first_page_role: "body" });
  const textNode: any = FMDocModel.createNode("text");
  textNode.id = "nd_hero";
  textNode.props.blocks = [
    { id: "blk_hero", type: "paragraph", runs: [{ text: BEFORE_TEXT }] },
    { id: "blk_second", type: "paragraph", runs: [{ text: SECOND_TEXT }] }
  ];
  const shapeNode: any = FMDocModel.createNode("shape");
  shapeNode.id = "nd_box";
  definition.pages[0].children.push(textNode, shapeNode);
  const validation = FMDocModel.validateDocument(definition);
  assert.ok(validation.ok, `fixture definition validates: ${JSON.stringify(validation.errors?.slice(0, 3))}`);
  await client.request("POST", `/v1/documents/organizations/${orgId}/templates`, {
    id: templateId,
    name: "Versions fixture",
    document_type: "generic",
    definition
  });
  return definition;
}

async function createDocFromTemplate(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string, templateId: string, title: string) {
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "generic",
    template_id: templateId,
    title
  });
  return created.document.id as string;
}

function joined(segments: Array<{ type: string; text: string }>, skip: string) {
  return segments.filter((segment) => segment.type !== skip).map((segment) => segment.text).join(" ");
}

test("checkpoint captures the working definition and diff(current, checkpoint) reports block + word changes", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_versions_diff";
  await createProject(client, orgId, projectId);
  const definition = await publishVersionsTemplate(client, orgId, "tpl_versions_diff");
  const documentId = await createDocFromTemplate(client, orgId, projectId, "tpl_versions_diff", "Versioned doc");

  // --- checkpoint the pristine document (compact route shape) ---------------
  const created = await client.request("POST", `/v1/documents/${documentId}/checkpoints`, {
    name: "Before edits",
    reason: "manual"
  });
  const checkpointId = created.checkpoint.id as string;
  assert.equal(created.checkpoint.reason, "manual");
  assert.equal(created.checkpoint.doc_id, documentId);
  assert.ok(created.checkpoint.size_bytes > 0, "summary carries the uncompressed definition size");
  assert.equal(created.checkpoint.definition, undefined, "create response omits the definition");

  // --- edit: reword blk_hero, drop blk_second, insert a new text node, move the shape
  const pageId = definition.pages[0].id;
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${documentId}`, {
    overrides: [
      {
        op: "node.set",
        node_id: "nd_hero",
        prop: "props.blocks",
        value: [{ id: "blk_hero", type: "paragraph", runs: [{ text: AFTER_TEXT }] }]
      },
      {
        op: "node.insert",
        page_id: pageId,
        node: {
          id: "nd_extra",
          type: "text",
          frame: { x: 72, y: 300, w: 468, h: 40 },
          props: { blocks: [{ id: "blk_extra", type: "paragraph", runs: [{ text: EXTRA_TEXT }] }] }
        }
      },
      { op: "node.set", node_id: "nd_box", prop: "frame.x", value: 250 }
    ]
  });

  // --- diff checkpoint -> current (sibling org route shape) -----------------
  const forward = await client.request(
    "GET",
    `/v1/documents/organizations/${orgId}/documents/${documentId}/checkpoints/${checkpointId}/diff/current`
  );
  const diff = forward.diff;
  assert.deepEqual(
    diff.added_blocks,
    [{ node_id: "nd_extra", block_id: "blk_extra", text: EXTRA_TEXT }],
    "inserted node's block reports as added"
  );
  assert.deepEqual(
    diff.removed_blocks,
    [{ node_id: "nd_hero", block_id: "blk_second", text: SECOND_TEXT }],
    "dropped block reports as removed"
  );
  assert.equal(diff.changed_blocks.length, 1, "one block changed");
  const changed = diff.changed_blocks[0];
  assert.equal(changed.node_id, "nd_hero");
  assert.equal(changed.block_id, "blk_hero");
  assert.equal(changed.before_text, BEFORE_TEXT);
  assert.equal(changed.after_text, AFTER_TEXT);
  // word_diff is a lossless whitespace-token diff: same+del reconstructs the
  // before text, same+add reconstructs the after text.
  assert.equal(joined(changed.word_diff, "add"), BEFORE_TEXT.split(/\s+/).join(" "));
  assert.equal(joined(changed.word_diff, "del"), AFTER_TEXT.split(/\s+/).join(" "));
  assert.ok(changed.word_diff.some((segment: any) => segment.type === "del" && segment.text.includes("brown")));
  assert.ok(changed.word_diff.some((segment: any) => segment.type === "add" && segment.text.includes("red")));
  assert.ok(diff.other_changes >= 1, "the shape frame move counts as a non-text change");

  // --- reverse orientation swaps added/removed ------------------------------
  const reverse = await client.request(
    "GET",
    `/v1/documents/${documentId}/checkpoints/current/diff/${checkpointId}`
  );
  assert.deepEqual(reverse.diff.added_blocks.map((block: any) => block.block_id), ["blk_second"]);
  assert.deepEqual(reverse.diff.removed_blocks.map((block: any) => block.block_id), ["blk_extra"]);
  assert.equal(reverse.diff.changed_blocks[0].before_text, AFTER_TEXT);
  assert.equal(reverse.diff.changed_blocks[0].after_text, BEFORE_TEXT);

  // --- current vs current is empty ------------------------------------------
  const identity = await client.request("GET", `/v1/documents/${documentId}/checkpoints/current/diff/current`);
  assert.deepEqual(identity.diff, { added_blocks: [], removed_blocks: [], changed_blocks: [], other_changes: 0 });

  // --- reads: list omits definitions, detail includes the frozen one --------
  const listed = await client.request("GET", `/v1/documents/${documentId}/checkpoints`);
  assert.equal(listed.count, 1);
  assert.equal(listed.checkpoints[0].id, checkpointId);
  assert.equal(listed.checkpoints[0].definition, undefined, "list rows never carry definitions");
  const detail = await client.request("GET", `/v1/documents/${documentId}/checkpoints/${checkpointId}`);
  assert.ok(JSON.stringify(detail.checkpoint.definition).includes(BEFORE_TEXT), "checkpoint froze the pre-edit text");
  const live = await client.request("GET", `/v1/documents/${documentId}/checkpoints/current`);
  assert.ok(JSON.stringify(live.checkpoint.definition).includes(AFTER_TEXT), "'current' resolves the live working definition");

  // --- validation -----------------------------------------------------------
  const badReason = await client.raw("POST", `/v1/documents/${documentId}/checkpoints`, { reason: "hourly" });
  assert.equal(badReason.statusCode, 400);
  const missingCheckpoint = await client.raw("GET", `/v1/documents/${documentId}/checkpoints/docchk_nope`);
  assert.equal(missingCheckpoint.statusCode, 404);
});

test("auto checkpoints prune to newest 10 + one per day for 30 days; named reasons are kept forever", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_versions_retention";
  await createProject(client, orgId, projectId);
  await publishVersionsTemplate(client, orgId, "tpl_versions_retention");
  const documentId = await createDocFromTemplate(client, orgId, projectId, "tpl_versions_retention", "Retention doc");

  // Backdate rows directly (retention is time-based; tests cannot wait 40
  // days). Each auto is backdated IMMEDIATELY after creation, since the prune
  // step inside createCheckpoint would otherwise collapse a burst of same-day
  // autos before the test can spread them across the calendar.
  const { getDocumentCheckpointsDatabase } = await import("../documents/versions/service.js");
  const db = getDocumentCheckpointsDatabase();
  const backdate = async (id: string, iso: string) =>
    (await db.prepare("UPDATE document_checkpoints SET created_at = ? WHERE id = ?").run(iso, id));
  const daysAgoAt = (days: number, hour: number) => {
    const day = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  };
  const schedule = [
    daysAgoAt(41, 12), // beyond 30d -> delete
    daysAgoAt(40, 12), // beyond 30d -> delete
    daysAgoAt(5, 1), // same day, oldest -> delete
    daysAgoAt(5, 2), // same day, middle -> delete
    daysAgoAt(5, 3), // same day, newest -> daily keeper
    daysAgoAt(15, 9), // lone daily keeper
    ...Array.from({ length: 10 }, (_, offset) => new Date(Date.now() - (10 - offset) * 60_000).toISOString())
  ];
  const autoIds: string[] = [];
  for (const createdAt of schedule) {
    const created = await client.request("POST", `/v1/documents/${documentId}/checkpoints`, { reason: "auto" });
    autoIds.push(created.checkpoint.id);
    (await backdate(created.checkpoint.id, createdAt));
  }
  const manual = await client.request("POST", `/v1/documents/${documentId}/checkpoints`, {
    reason: "manual",
    name: "Ancient named version"
  });
  (await backdate(manual.checkpoint.id, daysAgoAt(60, 8))); // manual survives any age

  // A fresh auto checkpoint triggers the prune step.
  const latest = await client.request("POST", `/v1/documents/${documentId}/checkpoints`, { reason: "auto" });

  const listed = await client.request("GET", `/v1/documents/${documentId}/checkpoints`);
  const autos = listed.checkpoints.filter((row: any) => row.reason === "auto").map((row: any) => row.id);
  const expectedSurvivors = new Set([
    latest.checkpoint.id,
    ...autoIds.slice(6, 16), // ten most recent from the backdated batch; autoIds[6] survives as today's daily keeper
    autoIds[5],
    autoIds[4]
  ]);
  assert.deepEqual(new Set(autos), expectedSurvivors, "prune kept newest 10 + one per day within 30 days");
  for (const doomed of [autoIds[0], autoIds[1], autoIds[2], autoIds[3]]) {
    assert.ok(!autos.includes(doomed), `${doomed} was pruned`);
  }
  assert.ok(
    listed.checkpoints.some((row: any) => row.id === manual.checkpoint.id),
    "60-day-old manual checkpoint is kept forever"
  );
});

test("checkpoints 404 across orgs on every route", async () => {
  const clientA = createSessionClient();
  const { orgId: orgA } = await registerOrg(clientA);
  const projectId = "project_versions_xorg";
  await createProject(clientA, orgA, projectId);
  await publishVersionsTemplate(clientA, orgA, "tpl_versions_xorg");
  const documentId = await createDocFromTemplate(clientA, orgA, projectId, "tpl_versions_xorg", "Org A doc");
  const created = await clientA.request("POST", `/v1/documents/${documentId}/checkpoints`, { reason: "manual" });

  const clientB = createSessionClient();
  const { orgId: orgB } = await registerOrg(clientB);
  assert.notEqual(orgA, orgB);

  // Compact routes resolve the org from the session -> org B never sees A's doc.
  for (const [method, url, payload] of [
    ["GET", `/v1/documents/${documentId}/checkpoints`, undefined],
    ["POST", `/v1/documents/${documentId}/checkpoints`, { reason: "manual" }],
    ["GET", `/v1/documents/${documentId}/checkpoints/${created.checkpoint.id}`, undefined],
    ["GET", `/v1/documents/${documentId}/checkpoints/${created.checkpoint.id}/diff/current`, undefined]
  ] as const) {
    const response = await clientB.raw(method, url, payload);
    assert.equal(response.statusCode, 404, `${method} ${url} is a 404 for the other org`);
    assert.equal(JSON.parse(response.body).error, "document_not_found");
  }

  // Explicit org segment mismatching the session is forbidden outright.
  const forbidden = await clientB.raw("GET", `/v1/documents/organizations/${orgA}/documents/${documentId}/checkpoints`);
  assert.equal(forbidden.statusCode, 403);

  // Checkpoint ids are scoped to their document too.
  const otherDoc = await createDocFromTemplate(clientA, orgA, projectId, "tpl_versions_xorg", "Second doc");
  const crossDoc = await clientA.raw("GET", `/v1/documents/${otherDoc}/checkpoints/${created.checkpoint.id}`);
  assert.equal(crossDoc.statusCode, 404);
});

test("a checkpoint of a seeded proposal stays small (storage estimate)", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_versions_size";
  await createProject(client, orgId, projectId);
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Roof Replacement Proposal",
    params: {
      customer: { name: "Jane Homeowner", email: "jane@example.test" },
      scope_items: [
        { id: "item_roof", name: "Roof replacement", description: "Tear-off and re-shingle", quantity: 1, unit: "job", unit_price: 12500 },
        { id: "item_gutter", name: "Gutter guards", description: "Leaf protection", quantity: 2, unit: "run", unit_price: 500 }
      ],
      deposit_cents: 250000,
      tax_percent: 7
    }
  });
  const documentId = created.document.id as string;
  assert.equal(created.document.template_ref.template_id, "tpl_proposal_default");

  const checkpoint = await client.request("POST", `/v1/documents/${documentId}/checkpoints`, {
    reason: "send",
    name: "Sent to customer"
  });
  const { getDocumentCheckpointsDatabase } = await import("../documents/versions/service.js");
  const row = (await getDocumentCheckpointsDatabase()
    .prepare("SELECT size_bytes, LENGTH(definition_json) AS stored_bytes FROM document_checkpoints WHERE id = ?")
    .get(checkpoint.checkpoint.id)) as any;
  assert.ok(row.size_bytes > 1000, "seeded proposal definition is non-trivial");
  assert.ok(row.stored_bytes < row.size_bytes, "definitions are stored compressed");
  console.log(
    `[documents-versions] seeded proposal checkpoint: raw=${row.size_bytes} bytes, stored (gzip)=${row.stored_bytes} bytes`
  );
});
