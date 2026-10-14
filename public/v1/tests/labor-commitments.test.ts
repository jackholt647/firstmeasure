import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "labor-commitments-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_commit";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default", identity: {}, organization: {}, user: {}, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any;
const member = (permissions: Record<string, boolean>) => ({ ...owner, userId: "member", role: "member", permissions, accessProfile: { roles: [] } });
let ready: Promise<{ crew: string; sub: string }> | null = null;
/** One organization with a real in-house group and a real outside company, as lists reference them. */
function setup() {
  return ready ||= (async () => {
    const s = await import("../platform/storage.js");
    await s.createOrganization({ id: ORG, name: "Commit" });
    await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
    await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
    await s.upsertDocument(ORG, "projects", { id: "project", data: { title: "12 Oak St" } });
    await s.upsertDocument(ORG, "projects", { id: "other", data: { title: "9 Elm St" } });
    const crew = await (await import("../workforce/storage.js")).createResourceGroup(ORG, { name: "Crew A", kind_id: "crew" });
    const sub = await (await import("../connections/storage.js")).createOrganizationConnection(ORG, { name: "Summit Roofing", relationship_type_ids: ["work_provider"] });
    return { crew: String(crew.id), sub: String(sub.id) };
  })();
}
const ITEMS = [{ id: "l1", name: "Tear off", quantity: 32, unit: "sq", projected_unit_price: 40, metadata: { compensation_kind: "piece_rate" } }, { id: "l2", name: "Hourly help", quantity: 6, unit: "hour" }];
async function labor(title: string, reference: object | null, items: object[] = ITEMS, project = "project") {
  const lists = await import("../materials/storage.js");
  return lists.createMaterialList(ORG, project, { title, resource_type: "labor", items, ...(reference ? { assignment: { work_resource_ref: reference } } : {}) }, owner);
}
function recorder(c: any, planned?: any[]) {
  const calls: any[] = [];
  const effects = {
    todo: async (body: any) => { calls.push(["todo", body.title, body.id]); },
    email: async (input: any) => { calls.push(["email", input.to, input.subject, input.idempotency_key]); },
    run: async (source: string, inputs: any) => { calls.push(["run", source === c.DEFAULT_CUSTOM_DELIVERY, inputs.commitment.assignee.name]); return planned || [{ action: "todo", title: "Send work to " + inputs.commitment.assignee.name }]; }
  };
  return { calls, effects };
}

test("a commitment is a frozen copy of the list, priced as the list shows it", async () => {
  const { crew } = await setup();
  const s = await import("../platform/storage.js"), c = await import("../labor/commitments.js");
  const { calls, effects } = recorder(c);
  const unassigned = await labor("Unassigned", null);
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: String(unassigned.id) }, owner, effects), /Assign this list/);
  const material = await (await import("../materials/storage.js")).createMaterialList(ORG, "project", { title: "Shingles", resource_type: "material", items: [] }, owner);
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: String(material.id) }, owner, effects), /Only a labor list/);
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: String(unassigned.id) }, member({ manage_projects: false }), effects), /project management access/);
  const ghost = await labor("Ghost", { id: "resource_group_gone", kind: "resource_group", name: "Gone" });
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: String(ghost.id) }, owner, effects), /not available in this organization/, "an assignee that does not exist cannot be committed to");

  const list = await labor("Roof labor", { id: crew, kind: "resource_group", name: "Crew A" }, [...ITEMS, { id: "l3", name: "Flashing", quantity: 32.5, unit: "ft", projected_unit_price: 1.005 }, { id: "l4", name: "Decking", quantity: 4, unit: "sheet", projected_unit_price: 30, projected_total: 150 }]);
  const first = await c.commitLaborList(ORG, { list_id: String(list.id), note: "Start Monday" }, owner, effects);
  assert.equal(first.revision, 1); assert.equal(first.status, "committed"); assert.deepEqual(first.assignee, { type: "resource_group", id: crew, name: "Crew A" });
  const stored = (await s.readDocument(ORG, "material_lists", String(list.id))).data.current_items as any[];
  const shown = (id: string) => { const item = stored.find((entry) => entry.id === id); return item.projected_total == null ? null : Math.round(Number(item.projected_total) * 100); };
  assert.deepEqual(first.lines.map((line) => [line.name, line.total_cents]), [["Tear off", shown("l1")], ["Hourly help", shown("l2")], ["Flashing", shown("l3")], ["Decking", shown("l4")]], "each line is priced as the list itself shows it");
  assert.equal(first.lines.find((line) => line.name === "Flashing")!.rate, 1.005, "a fractional rate is kept exactly");
  assert.equal(first.total_cents, first.lines.reduce((sum, line) => sum + (line.total_cents || 0), 0)); assert.equal(first.unpriced_lines, first.lines.filter((line) => line.total_cents == null).length);
  assert.equal(first.list_revision, Number(list.revision)); assert.equal(first.project_title, "12 Oak St");
  assert.deepEqual([first.delivery.method, first.delivery.status], ["share", "delivered"], "an in-house group uses this organization's FirstMate, so sharing reaches it"); assert.deepEqual(calls, [], "sharing sends nothing");

  // Editing the list afterwards does not change what was committed. Committing the changed list is a new revision.
  const document = await s.readDocument(ORG, "material_lists", String(list.id));
  await s.upsertDocument(ORG, "material_lists", { id: String(list.id), expected_revision: Number(document.revision), data: { ...document.data, current_items: (document.data.current_items as any[]).map((item) => (item.id === "l1" ? { ...item, quantity: 40, projected_total: 1600 } : item)) } }, { replace: true });
  assert.equal((await c.listCommitments(ORG, { list_id: String(list.id) }))[0]!.lines[0]!.quantity, 32);
  const second = await c.commitLaborList(ORG, { list_id: String(list.id), note: "Start Monday" }, owner, effects);
  assert.equal(second.revision, 2); assert.equal(second.lines[0]!.quantity, 40); assert.equal(second.lines[0]!.total_cents, 160000); assert.notEqual(second.content_hash, first.content_hash);
  const history = await c.listCommitments(ORG, { list_id: String(list.id) });
  assert.deepEqual(history.map((entry) => [entry.revision, entry.status, entry.lines[0]!.quantity]), [[1, "superseded", 32], [2, "committed", 40]]);
  assert.deepEqual((await c.currentCommitmentsFor(ORG, { type: "resource_group", id: crew })).map((entry) => entry.id), [second.id]);
});

test("committing twice, at once or again, never leaves two live commitments or sends twice", async () => {
  const { sub } = await setup();
  const c = await import("../labor/commitments.js");
  await c.saveDeliverySetting(ORG, { subject: { type: "organization_connection", id: sub }, method: "work_order_email", email: "office@summit.test" }, owner);
  const list = await labor("Sub labor", { id: sub, kind: "organization_connection", name: "Summit Roofing" });
  const { calls, effects } = recorder(c);
  // Two managers click at the same moment.
  const results = await Promise.allSettled([c.commitLaborList(ORG, { list_id: String(list.id) }, owner, effects), c.commitLaborList(ORG, { list_id: String(list.id) }, owner, effects)]);
  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
  assert.ok(won.length >= 1); for (const result of lost) assert.match(String(result.reason?.message), /committed by someone else just now/);
  const after1 = await c.listCommitments(ORG, { list_id: String(list.id) });
  assert.deepEqual(after1.map((entry) => [entry.revision, entry.status]), [[1, "committed"]], "exactly one revision 1");
  assert.equal(calls.filter((call) => call[0] === "email").length, 1, "one work order was emailed");
  // A second click on a list that has not changed returns the commitment it already has.
  const again = await c.commitLaborList(ORG, { list_id: String(list.id) }, owner, effects);
  assert.equal(again.id, after1[0]!.id); assert.equal(calls.filter((call) => call[0] === "email").length, 1);
  // The same request key returns the first result even though the note differs.
  const keyed = await c.commitLaborList(ORG, { list_id: String(list.id), note: "Bring ladders", idempotency_key: "click-0001" }, owner, effects);
  assert.equal(keyed.revision, 2);
  assert.equal((await c.commitLaborList(ORG, { list_id: String(list.id), note: "Something else", idempotency_key: "click-0001" }, owner, effects)).id, keyed.id);
  assert.deepEqual((await c.listCommitments(ORG, { list_id: String(list.id) })).map((entry) => [entry.revision, entry.status]), [[1, "superseded"], [2, "committed"]]);
  assert.equal((await c.currentCommitmentsFor(ORG, { type: "organization_connection", id: sub })).length, 1, "one job held, not two");
  // A commit that stopped before marking the older revision still reads as one live commitment.
  const s = await import("../platform/storage.js");
  const older = await s.readDocument(ORG, c.COMMITMENT_COLLECTION, after1[0]!.id);
  await s.upsertDocument(ORG, c.COMMITMENT_COLLECTION, { id: older.id, expected_revision: Number(older.revision), data: { ...older.data, status: "committed" } }, { replace: true });
  assert.deepEqual((await c.listCommitments(ORG, { list_id: String(list.id) })).map((entry) => entry.status), ["superseded", "committed"]);
});

test("delivery reports what really happened, can be retried or confirmed, and only emails addresses on record", async () => {
  const c = await import("../labor/commitments.js");
  await setup();
  const fresh = await (await import("../connections/storage.js")).createOrganizationConnection(ORG, { name: "Ridge Subs", relationship_type_ids: ["work_provider"] });
  const subject = { type: "organization_connection" as const, id: String(fresh.id) };
  const list = await labor("Ridge labor", { id: subject.id, kind: "organization_connection", name: "Ridge Subs" });
  const { calls, effects } = recorder(c);
  const blocked = await c.commitLaborList(ORG, { list_id: String(list.id) }, owner, effects);
  assert.deepEqual([blocked.delivery.method, blocked.delivery.status], ["work_order_email", "needs_attention"]); assert.match(blocked.delivery.detail, /no email address for Ridge Subs/);
  await assert.rejects(() => c.saveDeliverySetting(ORG, { subject, method: "work_order_email", email: "office@ridge.test" }, member({})), /company settings access/);
  await assert.rejects(() => c.saveDeliverySetting(ORG, { subject: { type: "organization_connection", id: "organization_connection_missing" }, method: "share" }, owner), /not available in this organization/);
  await c.saveDeliverySetting(ORG, { subject, method: "work_order_email", email: "office@ridge.test" }, owner);
  // Retrying delivers the same commitment; it does not make a new revision.
  const retried = await c.redeliverCommitment(ORG, { id: blocked.id }, owner, effects);
  assert.equal(retried.id, blocked.id); assert.equal(retried.revision, 1); assert.equal(retried.delivery.status, "delivered");
  assert.deepEqual(calls.at(-1), ["email", "office@ridge.test", "Work order - 12 Oak St", `labor_commitment:${blocked.id}:0`]);
  assert.equal((await c.redeliverCommitment(ORG, { id: blocked.id }, owner, effects)).delivery.status, "delivered"); assert.equal(calls.filter((call) => call[0] === "email").length, 1, "an arrived commitment is not sent again");

  // Sharing with an outside company does not reach its own account yet, so it is not reported as delivered.
  await c.saveDeliverySetting(ORG, { subject, method: "share" }, owner);
  const shared = await c.commitLaborList(ORG, { list_id: String(list.id), note: "v2" }, owner, effects);
  assert.equal(shared.delivery.status, "pending"); assert.match(shared.delivery.detail, /cannot be reached inside FirstMate yet/);
  const confirmed = await c.confirmDelivery(ORG, { id: shared.id, detail: "Handed over on site." }, owner);
  assert.deepEqual([confirmed.delivery.status, confirmed.delivery.detail], ["delivered", "Handed over on site."]);

  // Custom delivery code plans steps. With none of its own, someone is asked to deliver by hand, which is not arrival.
  await c.saveDeliverySetting(ORG, { subject, method: "custom", email: "office@ridge.test" }, owner);
  const byHand = await c.commitLaborList(ORG, { list_id: String(list.id), note: "v3" }, owner, effects);
  assert.deepEqual([byHand.delivery.method, byHand.delivery.status], ["custom", "pending"]);
  assert.deepEqual(calls.slice(-2), [["run", true, "Ridge Subs"], ["todo", "Send work to Ridge Subs", `labor_delivery_${byHand.id}_0`]]);
  const planned = recorder(c, [{ action: "todo", title: "Print the work order" }, { action: "email", to: "Office@Ridge.test", subject: "Your work", text: "See attached." }]);
  const sent = await c.commitLaborList(ORG, { list_id: String(list.id), note: "v4" }, owner, planned.effects);
  assert.equal(sent.delivery.status, "delivered"); assert.deepEqual(sent.delivery.steps.map((step) => step.action), ["todo", "email"]);
  // Delivery code cannot send pay data to an address that is not the assignee's.
  const leak = recorder(c, [{ action: "email", to: "someone@elsewhere.test", subject: "Rates", text: "All of them." }]);
  const refused = await c.commitLaborList(ORG, { list_id: String(list.id), note: "v5" }, owner, leak.effects);
  assert.equal(refused.delivery.status, "needs_attention"); assert.match(refused.delivery.detail, /not an address on record for Ridge Subs/); assert.equal(leak.calls.some((call) => call[0] === "email"), false);
  const failing = await c.commitLaborList(ORG, { list_id: String(list.id), note: "v6" }, owner, { ...effects, run: async () => { throw new Error("Delivery code failed to run."); } });
  assert.deepEqual([failing.delivery.status, failing.delivery.detail], ["needs_attention", "Delivery code failed to run."]);

  // With the real effects: the default delivery code runs in the sandbox and its to-do is really created.
  const real = await c.commitLaborList(ORG, { list_id: String(list.id), note: "v7" }, owner);
  assert.deepEqual([real.delivery.status, real.delivery.detail], ["pending", "A to-do was created to deliver this work by hand."]);
  const plans = await (await import("../work/service.js")).listWorkPlans(ORG, { project_id: "project" }) as any;
  assert.ok((Array.isArray(plans) ? plans : plans.plans || plans.items || []).some((plan: any) => String(plan.title || "") === "Send work to Ridge Subs"));
});

test("an archived list cannot be committed and is released; units belong to their assignee", async () => {
  const { sub } = await setup();
  const c = await import("../labor/commitments.js"), lists = await import("../materials/storage.js");
  const { effects } = recorder(c);
  const summit = { type: "organization_connection" as const, id: sub };
  for (const entry of await c.currentCommitmentsFor(ORG, summit)) await c.releaseCommitment(ORG, { id: entry.id }, owner);
  const north = await c.saveUnit(ORG, { assignee: summit, name: "North", kind_id: "crew" }, owner);
  const south = await c.saveUnit(ORG, { assignee: summit, name: "South" }, owner);
  const southB = await c.saveUnit(ORG, { assignee: summit, name: "South B", parent_unit_id: south.id }, owner);
  assert.equal(north.kind_id, "crew", "what a unit is called is a terminology key, not a platform word");
  await assert.rejects(() => c.saveUnit(ORG, { assignee: summit, name: "South", id: south.id, parent_unit_id: southB.id }, owner), /cannot sit under itself/);
  await assert.rejects(() => c.saveUnit(ORG, { assignee: { type: "resource_group", id: "resource_group_missing" }, name: "Stray" }, owner), /not available in this organization/);
  await assert.rejects(() => c.archiveUnit(ORG, { id: south.id }, owner), /units under this one/);
  const first = await labor("Job one", { id: sub, kind: "organization_connection", name: "Summit Roofing" });
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: String(first.id), unit_id: "unit_elsewhere" }, owner, effects), /does not belong to the assignee/);
  const placed = await c.commitLaborList(ORG, { list_id: String(first.id), unit_id: north.id }, owner, effects);
  assert.deepEqual(placed.unit, { id: north.id, name: "North" });
  await assert.rejects(() => c.archiveUnit(ORG, { id: north.id }, owner), /still holds committed work/);
  const second = await labor("Job two", { id: sub, kind: "organization_connection", name: "Summit Roofing" });
  await c.commitLaborList(ORG, { list_id: String(second.id), unit_id: southB.id }, owner, effects);
  const third = await labor("Job three", { id: sub, kind: "organization_connection", name: "Summit Roofing" });
  const extra = await c.commitLaborList(ORG, { list_id: String(third.id) }, owner, effects);
  assert.equal((await c.currentCommitmentsFor(ORG, summit)).length, 3, "a commitment is a handoff, not a booking: nothing here limits how many an assignee holds");
  // Archiving the list releases what it held; an archived list cannot be committed again.
  await lists.archiveMaterialList(ORG, String(third.id), { reason: "Replaced" }, owner);
  assert.equal(await c.releaseCommitmentsForList(ORG, String(third.id), owner), 1);
  assert.equal((await c.listCommitments(ORG, { list_id: String(third.id) }))[0]!.status, "released");
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: String(third.id), note: "again" }, owner, effects), /archived and cannot be committed/);
  assert.equal((await c.releaseCommitment(ORG, { id: extra.id }, owner)).status, "released", "releasing twice changes nothing");
  assert.equal((await c.currentCommitmentsFor(ORG, summit)).length, 2);
});

test("published actions stay inside their project, run for the platform, and pay data needs the right permission", async () => {
  const { crew } = await setup();
  (await import("../platform/publication/bootstrap.js")).initializePublication();
  const actions = await import("../platform/publication/actions.js"), providers = await import("../platform/publication/providers.js"), publication = await import("../platform/publication/context.js");
  const sheets = await import("../labor/pay-sheets.js");
  const { listWorkEventDefinitions } = await import("../work/events.js");
  assert.deepEqual(listWorkEventDefinitions().map((event: any) => event.name).filter((name: string) => name.startsWith("labor.")).sort(), ["labor.list.committed", "labor.list.delivered", "labor.list.finalized", "labor.list.released", "labor.list.reopened"], "the events exist before anything is committed");
  const list = await labor("Scoped", { id: crew, kind: "resource_group", name: "Crew A" });
  const commit = (ctx: any, project: string, key: string) => actions.invokeAction(ctx, { action: "labor.list.commit", target: { scope: "project", organizationId: ORG, projectId: project } } as any, { list_id: String(list.id) }, { idempotencyKey: key });
  const user = publication.userPublicationContext(owner, { executionKind: "api", mode: "command" });
  await assert.rejects(() => commit(user, "other", "scope-wrong-01"), /different project/, "a call aimed at one project cannot commit another project's list");
  // The platform itself can commit, for an automation, when it has been granted the operation.
  const system = publication.systemPublicationContext({ kind: "work", organizationId: ORG, projectId: "project", operations: ["labor.list.commit", "labor.commitment.release"], mode: "command" });
  const made: any = (await commit(system, "project", "scope-right-01")).value;
  assert.equal(made.status, "committed"); assert.equal(made.committed_by_user_id, "");
  await assert.rejects(() => actions.invokeAction(user, { action: "labor.commitment.release", target: { scope: "project", organizationId: ORG, projectId: "other" } } as any, { id: made.id }, { idempotencyKey: "scope-wrong-02" }), /different project/);
  assert.equal(((await actions.invokeAction(system, { action: "labor.commitment.release", target: { scope: "project", organizationId: ORG, projectId: "project" } } as any, { id: made.id }, { idempotencyKey: "scope-right-02" })).value as any).status, "released");

  // Pay sheets are compensation records. Seeing materials is not enough to read them or what a job pays.
  await sheets.savePaySheet(ORG, { subject: { type: "resource_group", id: crew }, name: "Crew A hourly", inputs: [{ name: "hours", source: { kind: "manual" } }], entries: [{ label: "Hourly", kind: "hourly", rate_cents: 3200, input: "hours" }] }, owner);
  const read = (ctx: any, provider: string, exported: string, target: object, args?: object) => providers.readPublishedData(ctx, { provider, export: exported, target, ...(args ? { args } : {}) } as any);
  const org = { scope: "organization", organizationId: ORG }, project = { scope: "project", organizationId: ORG, projectId: "project" };
  const viewer = publication.userPublicationContext(member({ view_materials: true, view_projects: true }), { executionKind: "api" });
  const manager = publication.userPublicationContext(member({ view_materials: true, view_projects: true, manage_projects: true }), { executionKind: "api" });
  const denied = async (run: () => Promise<any>) => { const result = await run().catch((error) => ({ status: "denied", error })); assert.notEqual(result.status, "ready"); };
  await denied(() => read(viewer, "pay-sheets", "catalog", org)); await denied(() => read(viewer, "pay-sheets", "evaluation", project)); await denied(() => read(viewer, "labor-commitments", "project", project)); await denied(() => read(viewer, "labor-commitments", "settings", org));
  await denied(() => read(manager, "pay-sheets", "catalog", org));
  assert.equal((await read(manager, "pay-sheets", "evaluation", project, { manual: { hours: 10 } })).status, "ready"); assert.equal((await read(manager, "labor-commitments", "project", project)).status, "ready");
  const settings = publication.userPublicationContext(owner, { executionKind: "api" });
  assert.equal(((await read(settings, "pay-sheets", "catalog", org)) as any).value.length, 1);
});

test("delivery code runs in the sandbox and can only return steps", async () => {
  const c = await import("../labor/commitments.js");
  const effects = c.platformDeliveryEffects(ORG, { project_id: "project" }, owner);
  const commitment = { title: "Roof labor", project_title: "12 Oak St", assignee: { name: "Crew A" } };
  assert.deepEqual(await effects.run(c.DEFAULT_CUSTOM_DELIVERY, { commitment }), [{ action: "todo", title: "Send work to Crew A", body: "Roof labor on 12 Oak St is committed and has not been delivered. Open the project to send it." }]);
  await assert.rejects(() => effects.run(`await api.actions.invoke('pay', {}); return { outputs: { steps: [] } };`, { commitment }), /does not act|Effects denied/);
  await assert.rejects(() => effects.run(`const x = await api.data.read('pay-sheets'); return { outputs: { steps: [] } };`, { commitment }), /reads only its inputs|denied/i);
  await assert.rejects(() => effects.run(`return { outputs: { steps: [{ action: "wire_money", amount: 5 }] } };`, { commitment }), /discriminator|invalid/i);
  await assert.rejects(() => effects.run(`return { outputs: { steps: Array.from({ length: 11 }, () => ({ action: "share" })) } };`, { commitment }), /at most 10|too_big/i);
  assert.equal(c.defaultDeliveryMethod({ type: "organization_user", id: "u" }), "share"); assert.equal(c.defaultDeliveryMethod({ type: "resource_group", id: "g" }), "share");
  assert.equal(c.defaultDeliveryMethod({ type: "organization_connection", id: "c" }), "work_order_email");
});
