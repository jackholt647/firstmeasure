import { putProjectContacts } from "./helpers/project-contacts.js";
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test, { after, before } from "node:test";

/**
 * Document history (docs/architecture/document-history.md): structural
 * patches rebuild every version exactly, lifecycle steps cut their own
 * revisions, signed versions are stored whole and match what was sealed, and
 * the History routes read, compare and restore.
 */

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-doc-history-test-"));
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
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { closeDocumentHistoryDatabase } = await import("../documents/versions/history.js");
  await closeDocumentHistoryDatabase();
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
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Doc History Test Org",
    organization_id: `org_doc_history_${suffix}`
  });
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
  return { orgId, userId: String(data.user.id) };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "100 Version Lane", title: "Jane Homeowner", project_type: "residential", photos: [] },
    metadata: { kind: "platform_project" }
  });
  await putProjectContacts(client, orgId, projectId, [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }]);
}

const BEFORE_TEXT = "The quick brown fox jumps over the lazy dog today";
const AFTER_TEXT = "The quick red fox jumps over the lazy dog";
const SECOND_TEXT = "This block gets removed by the edit";
const EXTRA_TEXT = "Brand new closing paragraph";

/** Template with fixed node/block ids so versions diff over stable ids. */
async function publishTemplate(client: ReturnType<typeof createSessionClient>, orgId: string, templateId: string) {
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
  await client.request("POST", `/v1/documents/organizations/${orgId}/templates`, { id: templateId, name: "History fixture", document_type: "generic", definition });
  return definition;
}

// ---------------------------------------------------------------------------
// Patch engine and storage, without the HTTP layer
// ---------------------------------------------------------------------------

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

function randomValue(random: () => number, depth: number): any {
  const roll = random();
  if (depth > 3 || roll < 0.35) {
    const kind = Math.floor(random() * 5);
    return kind === 0 ? null : kind === 1 ? random() < 0.5 : kind === 2 ? Math.round(random() * 10000) / 100 : kind === 3 ? `t${Math.floor(random() * 50)}` : "";
  }
  if (roll < 0.65) return Array.from({ length: Math.floor(random() * 5) }, (_, i) => random() < 0.5 ? { id: `n${Math.floor(random() * 1e6)}`, v: randomValue(random, depth + 1) } : randomValue(random, depth + 1));
  const object: any = {};
  for (let i = 0; i < Math.floor(random() * 5); i += 1) object[`k${Math.floor(random() * 8)}`] = randomValue(random, depth + 1);
  return object;
}

/** One random edit somewhere in the tree: set, delete, insert, remove, move or reorder. */
function mutate(value: any, random: () => number): any {
  const copy = JSON.parse(JSON.stringify(value));
  const containers: any[] = [];
  const walk = (node: any) => { if (node && typeof node === "object") { containers.push(node); for (const child of Object.values(node)) walk(child); } };
  walk(copy);
  const target = containers[Math.floor(random() * containers.length)];
  if (Array.isArray(target)) {
    const op = Math.floor(random() * 5);
    if (op === 0 || !target.length) target.splice(Math.floor(random() * (target.length + 1)), 0, random() < 0.5 ? { id: `n${Math.floor(random() * 1e6)}`, v: randomValue(random, 2) } : randomValue(random, 2));
    else if (op === 1) target.splice(Math.floor(random() * target.length), 1);
    else if (op === 2) target[Math.floor(random() * target.length)] = randomValue(random, 2);
    else if (op === 3) { const [moved] = target.splice(Math.floor(random() * target.length), 1); target.splice(Math.floor(random() * (target.length + 1)), 0, moved); }
    else target.reverse();
  } else {
    const keys = Object.keys(target);
    const op = Math.floor(random() * 3);
    if (op === 0 && keys.length) delete target[keys[Math.floor(random() * keys.length)]!];
    else target[keys.length && op === 1 ? keys[Math.floor(random() * keys.length)]! : `k${Math.floor(random() * 12)}`] = randomValue(random, 2);
  }
  return copy;
}

test("structural patches rebuild every state of randomized edit sequences exactly", async () => {
  const { diffJson, applyPatch, stableStringify } = await import("../documents/versions/patch.js");
  let checked = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const random = rng(seed);
    let state: any = { root: randomValue(random, 0), list: [randomValue(random, 1), { id: "a", v: 1 }, { id: "b", v: 2 }] };
    for (let step = 0; step < 25; step += 1) {
      const next = mutate(state, random);
      const ops = diffJson(state, next);
      const rebuilt = applyPatch(state, ops);
      assert.equal(stableStringify(rebuilt), stableStringify(next), `seed ${seed} step ${step}`);
      assert.deepEqual(applyPatch(next, diffJson(next, state)), JSON.parse(JSON.stringify(state)), `reverse seed ${seed} step ${step}`);
      if (stableStringify(state) === stableStringify(next)) assert.equal(ops.length, 0, "equal states have an empty patch");
      state = next;
      checked += 1;
    }
  }
  assert.equal(checked, 7500);
  // A change in one block of a long id-keyed list costs that block, not the list.
  const blocks = Array.from({ length: 200 }, (_, i) => ({ id: `blk_${i}`, runs: [{ text: `Paragraph ${i} with some words in it` }] }));
  const edited = blocks.map((block) => ({ ...block, runs: [...block.runs] }));
  edited[120] = { id: "blk_120", runs: [{ text: "Paragraph 120, reworded" }] };
  edited.splice(40, 0, { id: "blk_new", runs: [{ text: "Inserted" }] });
  const ops = diffJson({ blocks }, { blocks: edited });
  assert.ok(JSON.stringify(ops).length < 300, `small edit, small patch: ${JSON.stringify(ops)}`);
});

test("history stores long edit sequences as checkpoints plus patches, rebuilds each revision exactly, and is far smaller than full copies", async () => {
  const history = await import("../documents/versions/history.js");
  const { stableStringify } = await import("../documents/versions/patch.js");
  const random = rng(42);
  const orgId = "org_history_storage";
  const subjectId = "doc_storage";
  // A realistic estimate: 60 line items, terms text, a 40-block content override set.
  let state: any = {
    id: subjectId, title: "Roof replacement estimate", status: "draft", document_type: "estimate",
    params: {
      scope_items: Array.from({ length: 60 }, (_, i) => ({ id: `item_${i}`, name: `Line item ${i}`, quantity: i + 1, unit: "sq", unit_price_cents: 1000 + i * 37, selected: i % 3 !== 0, notes: `Install per manufacturer spec ${i}` })),
      terms: "Payment is due on completion. ".repeat(20)
    },
    overrides: Array.from({ length: 40 }, (_, i) => ({ op: "node.set", node_id: `nd_${i}`, prop: "props.blocks", value: [{ id: `blk_${i}`, type: "paragraph", runs: [{ text: `Section ${i}: the work includes tear-off, underlayment and cleanup.` }] }] })),
    outputs: {}, delivery: {}, metadata: {}
  };
  const states: string[] = [];
  const edits = 400;
  for (let step = 0; step < edits; step += 1) {
    const next = JSON.parse(JSON.stringify(state));
    const roll = random();
    if (roll < 0.5) {
      const item = next.params.scope_items[Math.floor(random() * next.params.scope_items.length)];
      item.quantity = Math.round(random() * 40); item.unit_price_cents += 5;
    } else if (roll < 0.75) {
      const override = next.overrides[Math.floor(random() * next.overrides.length)];
      override.value[0].runs[0].text += ` edit ${step}`;
    } else if (roll < 0.85) {
      next.params.scope_items.splice(Math.floor(random() * next.params.scope_items.length), 0, { id: `item_new_${step}`, name: `Added ${step}`, quantity: 1, unit: "ea", unit_price_cents: 4500, selected: true, notes: "" });
    } else if (roll < 0.9) {
      next.params.scope_items.splice(Math.floor(random() * next.params.scope_items.length), 1);
    } else {
      next.title = `Roof replacement estimate rev ${step}`;
    }
    state = next;
    // standalone: every save is its own revision, the worst case for storage.
    await history.recordRevision({ orgId, subjectType: "document", subjectId, state, cut: "edit", source: { kind: "person", user_id: "u1" }, standalone: true });
    states.push(stableStringify(state));
  }
  const list = await history.listRevisions(orgId, "document", subjectId);
  assert.equal(list.length, edits);
  for (let seq = 1; seq <= edits; seq += 1) {
    const rebuilt = await history.reconstructRevision(orgId, "document", subjectId, seq);
    assert.equal(stableStringify(rebuilt!.state), states[seq - 1], `revision ${seq} rebuilds exactly`);
  }
  const storage = await history.revisionStorage(orgId, "document", subjectId);
  const fullGzip = states.reduce((total, json) => total + gzipSync(Buffer.from(json)).length, 0);
  const ratio = storage.stored_bytes / fullGzip;
  const report = { revisions: storage.revisions, checkpoints: storage.checkpoints, stored_bytes: storage.stored_bytes, head_bytes: storage.head_bytes, full_json_bytes: storage.full_json_bytes, full_gzip_bytes: fullGzip, ratio_vs_gzip_copies: Number(ratio.toFixed(4)), ratio_vs_json_copies: Number((storage.stored_bytes / storage.full_json_bytes).toFixed(4)) };
  console.log(`document history storage: ${JSON.stringify(report)}`);
  assert.ok(storage.checkpoints >= 2 && storage.checkpoints < edits / 5, `checkpoints at intervals: ${storage.checkpoints}`);
  assert.ok(ratio < 0.25, `history is far smaller than gzip full copies (${ratio})`);
  // A tampered patch is caught by the checksum rather than returned as a version.
  const db = history.documentHistoryDatabase();
  const victim = list.find((revision) => revision.kind === "patch")!;
  const { encodePayload } = await import("../documents/versions/codec.js");
  await db.prepare("UPDATE document_revisions SET payload=? WHERE organization_id=? AND subject_id=? AND seq=?").run(encodePayload([["s", ["title"], "Tampered"]]), orgId, subjectId, victim.seq);
  await assert.rejects(history.reconstructRevision(orgId, "document", subjectId, victim.seq), history.RevisionIntegrityError);
});

// ---------------------------------------------------------------------------
// Through the documents engine
// ---------------------------------------------------------------------------

test("edit, present, send and sign each cut a revision; the signed version is stored whole and matches what was sealed", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await registerOrg(client);
  await createProject(client, orgId, "history_project");
  const storage = await import("../documents/storage.js");
  const versions = await import("../documents/versions/service.js");
  const history = await import("../documents/versions/history.js");
  const { stableStringify } = await import("../documents/versions/patch.js");

  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/history_project/documents`, { document_type: "contract", params: { body: "Original agreement", effective_date: "2026-10-22" } });
  const id = created.document.id as string;
  await storage.saveDocumentInstance(orgId, id, { ...(await storage.readDocumentInstance(orgId, id)), output_defs: { sig_customer: { type: "signature", signer_id: "customer", required: true } } });
  // Two quick edits by one person are one revision.
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${id}`, { params: { body: "Revised agreement" } });
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${id}`, { params: { body: "Revised agreement, final", deposit_percent: 30 } });
  await versions.markDocumentRevision(orgId, id, { cut: "present", userId });
  await client.request("POST", `/v1/documents/${id}/revisions`, { label: "Ready to send" });
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${id}/send`, { recipients: [{ name: "Alice", email: "alice@example.test", role: "customer" }], consent_contact: "support@example.test" });
  const token = sent.signing.invitations.find((invitation: any) => invitation.signer_id === "customer").token;
  const prepared = await client.request("POST", `/v1/documents/public/${token}/signing/prepare`, {});
  await client.request("POST", `/v1/documents/public/${token}/outputs/sig_customer`, {
    value: { type: "typed", signer_name: "Alice", signed_at: "1900-01-01" }, challenge: prepared.challenge, content_hash: prepared.content_hash,
    consent: { intent: true, electronic_records: true, can_access_and_retain: true, disclosure_hash: prepared.disclosure.hash }
  });
  await (await import("../documents/signing/service.js")).drainSigningOutbox();

  const listed = await client.request("GET", `/v1/documents/${id}/revisions`);
  const cuts = [...listed.revisions].reverse().map((revision: any) => revision.cut);
  assert.deepEqual(cuts.slice(0, 5), ["created", "edit", "edit", "present", "named"], `lifecycle cuts in order: ${cuts.join(", ")}`);
  assert.ok(cuts.includes("send"), `send cut: ${cuts.join(", ")}`);
  assert.ok(cuts.includes("sign") || cuts.includes("complete"), `sign cut: ${cuts.join(", ")}`);
  const personEdit = listed.revisions.find((revision: any) => revision.cut === "edit" && revision.source.user_id === userId);
  assert.ok(personEdit, "the person's edits are attributed to them");
  assert.equal(personEdit.edits, 2, "the two quick edits folded into one revision");
  assert.equal(personEdit.actor_name, "Owner User");
  assert.ok(personEdit.sections.includes("params"));
  const sendRevision = listed.revisions.find((revision: any) => revision.cut === "send");
  assert.equal(listed.revisions.filter((revision: any) => revision.cut === "send").length, 1, "one send is one revision, however many saves it made");
  assert.ok(sendRevision.snapshot_id, "the send revision names the snapshot it sent");

  // The signed (executed) revision is a checkpoint that rebuilds byte for byte to the stored record.
  const final = await storage.readDocumentInstance(orgId, id);
  assert.ok(["signed", "completed"].includes(String(final.status)));
  const signed = listed.revisions.find((revision: any) => revision.status === final.status && ["sign", "complete"].includes(revision.cut));
  assert.ok(signed, "a revision holds the executed state");
  assert.equal(signed.kind, "checkpoint");
  assert.equal(signed.actor_label, "Alice", "a signature is attributed to the signer by name");
  for (const seal of listed.revisions.filter((revision: any) => revision.cut === "seal")) assert.equal(seal.kind, "checkpoint", "the sealed state is stored whole");
  assert.deepEqual(listed.revisions[listed.revisions.length - 1].sections, [], "the first revision lists no touched sections");
  const rebuilt = await history.reconstructRevision(orgId, "document", id, listed.revisions[0].seq);
  assert.equal(stableStringify(rebuilt!.state), stableStringify(versions.documentState(final)), "newest revision equals the stored record exactly");
  const signedState = (await history.reconstructRevision(orgId, "document", id, signed.seq))!.state as any;
  const pkg = (await (await import("../documents/signing/store.js")).packagesForDocument(orgId, id))[0]!;
  assert.equal(signedState.signing.package_id, pkg.id);
  assert.equal(signedState.signing.content_hash, pkg.content_hash, "the signed version carries the sealed content's hash");
  assert.equal(signedState.outputs.sig_customer.signer_name, "Alice");
  // Viewing the signed version shows the frozen snapshot, which is the sealed content.
  const view = await client.request("GET", `/v1/documents/${id}/revisions/${signed.seq}/view`);
  assert.equal(view.frozen, true);
  assert.equal(stableStringify(view.resolved.resolved_definition), stableStringify(pkg.content.resolved_definition));
  // Signed documents cannot be restored over.
  const blocked = await client.raw("POST", `/v1/documents/${id}/revisions/${personEdit.seq}/restore`, {});
  assert.equal(blocked.statusCode, 409);

  // The diff between the created and the sent version reads field by field.
  const diff = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${id}/revisions/1/diff/${sendRevision.seq}`);
  const body = diff.diff.fields.find((field: any) => field.section === "params" && field.path.join(".") === "body");
  assert.deepEqual([body.before, body.after], ["Original agreement", "Revised agreement, final"]);
  assert.ok(diff.diff.fields.some((field: any) => field.section === "status" && field.after === "sent"));
  assert.ok(!JSON.stringify(diff.diff.fields).includes(String(sent.snapshot.public_token)), "tokens never appear in a diff");
});

test("content diffs read block by block, and restoring a version puts its content back as a new revision", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await createProject(client, orgId, "history_restore");
  const definition = await publishTemplate(client, orgId, "tpl_history");
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/history_restore/documents`, { document_type: "generic", template_id: "tpl_history", title: "Versioned doc", params: { note: "first" } });
  const id = created.document.id as string;
  const pageId = definition.pages[0].id;
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${id}`, {
    title: "Versioned doc, edited",
    params: { note: "second" },
    overrides: [
      { op: "node.set", node_id: "nd_hero", prop: "props.blocks", value: [{ id: "blk_hero", type: "paragraph", runs: [{ text: AFTER_TEXT }] }] },
      { op: "node.insert", page_id: pageId, node: { id: "nd_extra", type: "text", frame: { x: 72, y: 300, w: 468, h: 40 }, props: { blocks: [{ id: "blk_extra", type: "paragraph", runs: [{ text: EXTRA_TEXT }] }] } } },
      { op: "node.set", node_id: "nd_box", prop: "frame.x", value: 250 }
    ]
  });
  const listed = await client.request("GET", `/v1/documents/${id}/revisions`);
  assert.deepEqual(listed.revisions.map((revision: any) => revision.cut), ["edit", "created"]);
  const diff = (await client.request("GET", `/v1/documents/${id}/revisions/1/diff/current`)).diff;
  assert.deepEqual(diff.content.added_blocks, [{ node_id: "nd_extra", block_id: "blk_extra", text: EXTRA_TEXT }]);
  assert.deepEqual(diff.content.removed_blocks, [{ node_id: "nd_hero", block_id: "blk_second", text: SECOND_TEXT }]);
  assert.equal(diff.content.changed_blocks[0].before_text, BEFORE_TEXT);
  assert.equal(diff.content.changed_blocks[0].after_text, AFTER_TEXT);
  assert.ok(diff.content.changed_blocks[0].word_diff.some((part: any) => part.type === "add" && part.text.includes("red")));
  assert.ok(diff.content.other_changes >= 1, "the shape move counts as a layout change");
  assert.ok(diff.fields.some((field: any) => field.section === "title" && field.after === "Versioned doc, edited"));
  const read = await client.request("GET", `/v1/documents/${id}/revisions/1`);
  assert.ok(JSON.stringify(read.definition).includes(BEFORE_TEXT), "an earlier version's editable definition");
  const view = await client.request("GET", `/v1/documents/${id}/revisions/1/view`);
  assert.equal(view.frozen, false);
  assert.ok(JSON.stringify(view.resolved.resolved_definition).includes(BEFORE_TEXT), "an earlier version renders as it was");

  const restored = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${id}/revisions/1/restore`, {});
  assert.equal(restored.document.title, "Versioned doc");
  assert.equal(restored.document.params.note, "first");
  assert.deepEqual(restored.document.overrides, []);
  assert.equal(restored.revision.cut, "restore");
  assert.equal(restored.revision.attributes.restored_from, 1);
  const after = await client.request("GET", `/v1/documents/${id}/revisions`);
  assert.deepEqual(after.revisions.map((revision: any) => revision.cut), ["restore", "edit", "created"], "restore is a new revision; nothing is rewritten");
  assert.equal((await client.raw("GET", `/v1/documents/${id}/revisions/99`)).statusCode, 404);
  assert.equal((await client.raw("GET", `/v1/documents/${id}/revisions/zero`)).statusCode, 400);
});

test("a document saved before history existed starts with its stored state; templates record each publish", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await createProject(client, orgId, "history_baseline");
  const storage = await import("../documents/storage.js");
  const history = await import("../documents/versions/history.js");
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/history_baseline/documents`, { document_type: "contract", params: { body: "Old document" } });
  const id = created.document.id as string;
  // Forget its history, as for a document written before this module.
  const db = history.documentHistoryDatabase();
  await db.prepare("DELETE FROM document_revisions WHERE organization_id=? AND subject_id=?").run(orgId, id);
  await db.prepare("DELETE FROM document_revision_heads WHERE organization_id=? AND subject_id=?").run(orgId, id);
  await storage.saveDocumentInstance(orgId, id, { ...(await storage.readDocumentInstance(orgId, id)), title: "Renamed" });
  const listed = await client.request("GET", `/v1/documents/${id}/revisions`);
  assert.deepEqual(listed.revisions.map((revision: any) => revision.cut), ["edit", "baseline"]);
  assert.equal(listed.revisions[1].kind, "checkpoint");

  await publishTemplate(client, orgId, "tpl_history_assets");
  const template = await storage.readDocumentTemplate(orgId, "tpl_history_assets");
  const version = await storage.readDocumentTemplateVersion(orgId, "tpl_history_assets");
  const definition: any = JSON.parse(JSON.stringify((version as any).definition));
  definition.pages[0].children[0].props.blocks[0].runs[0].text = AFTER_TEXT;
  await client.request("POST", `/v1/documents/organizations/${orgId}/templates/tpl_history_assets/publish`, { definition, expected_version: Number(template.current_version) });
  const assets = await client.request("GET", `/v1/documents/history/document_template/tpl_history_assets/revisions`);
  assert.ok(assets.revisions.filter((revision: any) => revision.cut === "publish").length >= 2, JSON.stringify(assets.revisions.map((r: any) => r.cut)));
  const [newest, previous] = assets.revisions.filter((revision: any) => revision.cut === "publish");
  const assetDiff = await client.request("GET", `/v1/documents/history/document_template/tpl_history_assets/revisions/${previous.seq}/diff/${newest.seq}`);
  assert.equal(assetDiff.diff.content.changed_blocks[0].after_text, AFTER_TEXT);
});
