// Finalizing work for payment, project closeout and the requirements tray's progress states.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "labor-completion-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_completion";
const base = { orgId: ORG, branchId: "default", identity: {}, organization: {}, user: {}, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } };
const owner = { ...base, userId: "owner", role: "owner", permissions: { "*": true } } as any;
const member = (userId: string, permissions: Record<string, boolean>) => ({ ...base, userId, role: "member", permissions, accessProfile: { roles: [] }, applicationAccess: { management: { enabled: true, permissions } } }) as any;
const manager = member("manager", { manage_projects: true, view_projects: true, view_materials: true });
const viewer = member("viewer", { view_projects: true, view_materials: true });
const ITEMS = [{ id: "l1", name: "Tear off", quantity: 30, unit: "sq", projected_unit_price: 40, metadata: { compensation_kind: "piece_rate", covers: ["roofing.tear_off"] } }, { id: "l2", name: "Install", quantity: 30, unit: "sq", projected_unit_price: 90, metadata: { covers: ["roofing.install"] } }];

let ready: Promise<{ crew: string }> | null = null;
function setup() {
  return ready ||= (async () => {
    const s = await import("../platform/storage.js");
    await s.createOrganization({ id: ORG, name: "Completion" });
    await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
    await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
    for (const id of ["project", "closing", "tray"]) await s.upsertDocument(ORG, "projects", { id, data: { title: `${id} street`, events: [] } });
    const crew = await (await import("../workforce/storage.js")).createResourceGroup(ORG, { name: "Crew A", kind_id: "crew" });
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    return { crew: String(crew.id) };
  })();
}
async function labor(project: string, crew: string, title = "Roof labor", items: object[] = ITEMS) {
  return (await import("../materials/storage.js")).createMaterialList(ORG, project, { title, resource_type: "labor", items, assignment: { work_resource_ref: { id: crew, kind: "resource_group", name: "Crew A" } } }, owner);
}
const quiet = { todo: async () => {}, email: async () => {}, run: async () => [] } as any;
async function payRows() {
  const { paySourceExports } = await import("../payroll/pay-sources.js");
  return ((await paySourceExports().labor_commitments.read!({ organizationId: ORG } as any, { args: {} } as any)) as any).value as any[];
}

test("finalizing confirms every line, freezes what is paid, locks the list and is recorded", async () => {
  const { crew } = await setup();
  const done = await import("../labor/completion.js"), c = await import("../labor/commitments.js"), g = await import("../labor/generation.js");
  const list = await labor("project", crew);
  const id = String(list.id);
  await assert.rejects(() => done.finalizeLaborList(ORG, { list_id: id, method: "select_all", confirmed_item_ids: ["l1", "l2"] }, viewer), /project management access/, "seeing a project is not enough to mark its work to be paid");
  await assert.rejects(() => done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l1"] }, manager), /Confirm every line item.*"Install"/);
  await assert.rejects(() => done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l1", "l2", "nope"] }, manager), /not on this list/);

  // Never committed: finalizing commits it first and sends nothing, because the work is already done.
  const finalized = await done.finalizeLaborList(ORG, { list_id: id, method: "select_all", confirmed_item_ids: ["l1", "l2"], evidence_media_ids: ["photo_1"], note: "Walked the roof" }, manager);
  assert.equal(finalized.state, "finalized"); assert.equal(finalized.method, "select_all"); assert.equal(finalized.finalized_by_user_id, "manager");
  assert.deepEqual(finalized.items.map((item) => [item.id, item.confirmed]), [["l1", true], ["l2", true]]);
  assert.deepEqual(finalized.evidence.media_ids, ["photo_1"]); assert.equal(finalized.total_cents, 30 * 40 * 100 + 30 * 90 * 100);
  assert.deepEqual(finalized.history.map((entry) => [entry.action, entry.by_user_id, entry.confirmed]), [["finalized", "manager", 2]]);
  const [commitment] = await c.listCommitments(ORG, { list_id: id });
  assert.equal(commitment!.id, finalized.commitment_id); assert.equal(commitment!.status, "committed", "a commitment is never edited; completion is its own record");
  assert.equal(commitment!.delivery.status, "delivered"); assert.match(commitment!.delivery.detail, /nothing was sent/);
  assert.equal((await done.finalizeLaborList(ORG, { list_id: id, method: "approve" }, manager)).id, finalized.id, "finalizing twice returns what is recorded");

  // Locked: nothing that changes what is paid can run, and finished work cannot be released as if taken back.
  await assert.rejects(() => c.commitLaborList(ORG, { list_id: id, note: "again" }, manager, quiet), /finalized to be paid/);
  await assert.rejects(() => g.generateLaborList(ORG, { list_id: id }, manager), /finalized to be paid/);
  await assert.rejects(() => c.releaseCommitment(ORG, { id: commitment!.id }, manager), /reopen it before it can be released/);
  assert.deepEqual(await c.currentCommitmentsFor(ORG, { type: "resource_group", id: crew }), [], "finished work is no longer held by the assignee");
  const events = (await (await import("../materials/storage.js")).listMaterialEvents(ORG, id)).map((event: any) => event.type || event.event_type);
  assert.ok(events.includes("labor_completion.finalized"), "the list's own history says it was finalized");

  // The pay source says when it was finalized; that is when piece-rate pay is earned.
  const row = (await payRows()).find((entry) => entry.id === commitment!.id);
  assert.equal(row.finalized_at, finalized.finalized_at); assert.equal(row.finalized_by_user_id, "manager"); assert.equal(row.completion_method, "select_all"); assert.equal(row.released_at, "");
  const { SAMPLE_PAY_RULES } = await import("../payroll/sample-pay-rules.js");
  const rule = SAMPLE_PAY_RULES.find((entry) => entry.id === "committed_labor")!.definition as any;
  assert.equal(rule.earned_at, "finalized_at", "the sample committed-labor rule earns when the work is finalized, not when it is released");
  assert.ok(!JSON.stringify(rule.inputs).includes("released"));
});

test("released means taken back and is never paid; reopening finalized work needs a manager and is audited", async () => {
  const { crew } = await setup();
  const done = await import("../labor/completion.js"), c = await import("../labor/commitments.js");
  const list = await labor("project", crew, "Taken back");
  const id = String(list.id);
  const first = await c.commitLaborList(ORG, { list_id: id }, manager, quiet);
  await c.releaseCommitment(ORG, { id: first.id, reason: "Crew could not start" }, manager);
  let rows = await payRows();
  assert.deepEqual([rows.find((entry) => entry.id === first.id).status, rows.find((entry) => entry.id === first.id).finalized_at], ["released", ""], "a release is not a completion");
  // The work is done later by the same assignee: finalizing commits a new revision and only that one is finalized.
  const finalized = await done.finalizeLaborList(ORG, { list_id: id, method: "approve" }, manager);
  assert.notEqual(finalized.commitment_id, first.id);
  rows = await payRows();
  assert.equal(rows.find((entry) => entry.id === first.id).finalized_at, ""); assert.ok(rows.find((entry) => entry.id === finalized.commitment_id).finalized_at);

  await assert.rejects(() => done.reopenLaborList(ORG, { list_id: id, reason: "Wrong crew" }, manager), /reopen finalized work/, "project management alone cannot take back finalized work");
  await assert.rejects(() => done.reopenLaborList(ORG, { list_id: id, reason: "" }, owner));
  const supervisor = member("supervisor", { manage_projects: true, reopen_finalized_work: true });
  // The store itself refuses a paid-out list's lines: a direct edit and a new version alike.
  const lists = await import("../materials/storage.js");
  const current = await lists.readMaterialList(ORG, id);
  await assert.rejects(() => lists.patchMaterialList(ORG, id, { title: "Renamed" }, owner), /finalized to be paid/);
  await assert.rejects(() => lists.createMaterialVersion(ORG, id, { expected_revision: Number(current.revision), reason: "revision", items: [{ id: "l1", name: "Tear off", quantity: 40, unit: "sq", projected_unit_price: 40 }] }, owner), /finalized to be paid/);
  const reopened = await done.reopenLaborList(ORG, { list_id: id, reason: "Two lines were for the garage" }, supervisor);
  // Reopened, it can change again.
  const edited = await lists.createMaterialVersion(ORG, id, { expected_revision: Number((await lists.readMaterialList(ORG, id)).revision), reason: "revision", items: ITEMS }, owner);
  assert.ok(edited);
  assert.equal((await lists.patchMaterialList(ORG, id, { title: "Taken back, reworked" }, owner)).title, "Taken back, reworked");
  assert.equal(reopened.state, "reopened"); assert.equal(reopened.reopened_by_user_id, "supervisor");
  assert.deepEqual(reopened.history.map((entry) => [entry.action, entry.by_user_id, entry.reason || ""]), [["finalized", "manager", ""], ["reopened", "supervisor", "Two lines were for the garage"]]);
  assert.equal((await payRows()).find((entry) => entry.id === finalized.commitment_id).finalized_at, "", "pay earned on reopened work is reversed at the next refresh");
  await done.assertLaborListOpen(ORG, id);
  const again = await done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l1", "l2"] }, manager);
  assert.equal(again.id, reopened.id); assert.deepEqual(again.history.map((entry) => entry.action), ["finalized", "reopened", "finalized"], "the history is never shortened");
});

test("published finalize stays in its project, checks reviewed photos, and the permission is in the catalog", async () => {
  const { crew } = await setup();
  const actions = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const list = await labor("project", crew, "Published");
  const invoke = (ctx: any, projectId: string, input: object, key: string, action = "labor.list.finalize") => actions.invokeAction(ctx, { action, target: { scope: "project", organizationId: ORG, projectId } } as any, input, { idempotencyKey: key });
  const user = userPublicationContext(owner, { executionKind: "api", mode: "command" });
  await assert.rejects(() => invoke(user, "closing", { list_id: String(list.id), method: "approve" }, "fin-wrong-project"), /different project/);
  await assert.rejects(() => invoke(user, "project", { list_id: String(list.id), method: "approve", evidence_media_ids: ["not_a_photo"] }, "fin-bad-media"), /not one of this project's photos/);
  await assert.rejects(() => invoke(userPublicationContext(viewer, { executionKind: "api", mode: "command" }), "project", { list_id: String(list.id), method: "approve" }, "fin-viewer"), /denied|permission|forbidden|not permitted/i);
  const result: any = (await invoke(user, "project", { list_id: String(list.id), method: "approve" }, "fin-ok")).value;
  assert.equal(result.state, "finalized");
  const read = await (await import("../platform/publication/providers.js")).readPublishedData(userPublicationContext(manager, { executionKind: "api" }), { provider: "labor-completion", export: "project", target: { scope: "project", organizationId: ORG, projectId: "project" } } as any);
  assert.equal(read.status, "ready"); assert.ok((read as any).value.some((entry: any) => entry.list_id === String(list.id)));
  const { capabilityDefinition } = await import("../platform/capabilities.js");
  await import("../platform/capability_defs.js");
  const node: any = capabilityDefinition("permission.reopen_finalized_work");
  assert.equal(node?.permission_key, "reopen_finalized_work"); assert.equal(node?.permission_group, "financials");
});

test("closeout checks warn and never block; closing finalizes the remaining work orders and is reversible only by a manager", async () => {
  const { crew } = await setup();
  const actions = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js"), done = await import("../labor/completion.js");
  const lists = await import("../materials/storage.js");
  const first = await labor("closing", crew, "Tear-off crew"), second = await labor("closing", crew, "Install crew", [{ id: "i1", name: "Install", quantity: 10, unit: "sq", projected_unit_price: 90 }]);
  const material = await lists.createMaterialList(ORG, "closing", { title: "Shingles", resource_type: "material", items: [{ id: "m1", name: "Shingles", quantity: 30, unit: "bundle", projected_unit_price: 40 }] }, owner);
  await lists.patchMaterialList(ORG, String(material.id), { status: "ordered" }, owner);
  const { closeoutChecks } = await import("../closeout/closeout.js");
  const ctx = userPublicationContext(owner, { executionKind: "api", mode: "command", projectId: "closing" });
  const checks = await closeoutChecks(ctx, "closing");
  assert.deepEqual(checks.steps.map((step) => step.id), ["change_orders", "signatures", "payments", "requirements", "receipts", "work_orders", "expenses"]);
  for (const step of checks.steps) { assert.ok(["ok", "warning", "unavailable"].includes(step.status), step.id); assert.ok(step.summary, step.id); }
  const step = (id: string) => checks.steps.find((entry) => entry.id === id)!;
  assert.equal(step("work_orders").status, "warning"); assert.deepEqual(checks.open_work_orders.sort(), [String(first.id), String(second.id)].sort());
  assert.ok(step("change_orders").missing.some((entry) => /paid/.test(entry)), "what nothing publishes is said, not guessed");
  if (step("receipts").status !== "unavailable") assert.ok(step("receipts").rows.some((row) => row.id === String(material.id) && row.status === "warning"), "an ordered list with no receipt is flagged");
  assert.ok(step("expenses").rows.some((row) => row.id === String(first.id) && /not finalized/.test(row.detail)), "labor costs only count as actual once finalized");
  const published = await (await import("../platform/publication/providers.js")).readPublishedData(ctx, { provider: "project-closeout", export: "checks", target: { scope: "project", organizationId: ORG, projectId: "closing" } } as any);
  assert.equal(published.status, "ready");

  const close = (input: object, key: string, as: any = ctx) => actions.invokeAction(as, { action: "project-closeout.close", target: { scope: "project", organizationId: ORG, projectId: "closing" } } as any, input, { idempotencyKey: key });
  await done.finalizeLaborList(ORG, { list_id: String(first.id), method: "approve" }, manager);
  await assert.rejects(() => close({}, "close-open"), /finalize every work order first: Crew A/, "the only thing that stops a close is work not finalized");
  const record: any = (await close({ finalize: [{ list_id: String(second.id), method: "each", confirmed_item_ids: ["i1"] }], note: "All paid up" }, "close-ok")).value;
  assert.equal(record.state, "closed"); assert.equal(record.closed_by_user_id, "owner"); assert.equal(record.lists.length, 2);
  assert.equal(record.checks.length, 7, "the checks are kept as they stood");
  const secondDone = await done.finalizedCompletionFor(ORG, String(second.id));
  assert.match(secondDone!.closeout_id, /^closeout_closing_/);
  await assert.rejects(() => done.reopenLaborList(ORG, { list_id: String(first.id), reason: "Change it" }, owner), /closed out/);

  const reopen = (as: any, key: string) => actions.invokeAction(as, { action: "project-closeout.reopen", target: { scope: "project", organizationId: ORG, projectId: "closing" } } as any, { reason: "Late invoice from supplier" }, { idempotencyKey: key });
  await assert.rejects(() => reopen(userPublicationContext(manager, { executionKind: "api", mode: "command" }), "reopen-denied"), /denied|permission|forbidden|reopen|not permitted/i);
  const reopened: any = (await reopen(ctx, "reopen-ok")).value;
  assert.equal(reopened.state, "reopened"); assert.deepEqual(reopened.history.map((entry: any) => entry.action), ["closed", "reopened"]); assert.equal(reopened.reopen_reason, "Late invoice from supplier");
  assert.equal((await done.finalizedCompletionFor(ORG, String(first.id)))?.state, "finalized", "reopening the closeout leaves the work orders finalized");
});

test("the tray reads progress from the covering lists: scheduled, then completed", async () => {
  const { crew } = await setup();
  const s = await import("../platform/storage.js"), r = await import("../labor/requirements.js"), done = await import("../labor/completion.js"), lists = await import("../materials/storage.js");
  const { saveManualScope } = await import("../labor/scope-artifacts.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  await saveManualScope(userPublicationContext(owner, { projectId: "tray" }), "tray", { work: [{ item: "roofing.tear_off", quantity: 30 }] });
  const list = await labor("tray", crew, "Tray crew");
  const material = await lists.createMaterialList(ORG, "tray", { title: "Shingles", resource_type: "material", items: [{ id: "m1", name: "Shingles", quantity: 30, unit: "bundle" }] }, owner);
  const read = async () => r.projectRequirements(ORG, "tray", {});
  const row = (set: any, id: string) => set.requirements.find((entry: any) => entry.id === id);
  let set = await read();
  assert.equal(row(set, "roofing.tear_off").status, "covered"); assert.equal(row(set, "roofing.tear_off").progress, "none");
  const shingles: any = set.requirements.find((entry: any) => entry.kind === "material" && entry.covered_by.some((cover: any) => cover.list_id === String(material.id)));
  assert.equal(shingles.progress, "none");
  // Each list's event on the project schedules it.
  const project = await s.readDocument(ORG, "projects", "tray");
  const event = (listId: string, start: string) => ({ id: `ev_${listId}`, title: "Work", scope_resource_list_id: listId, status: "scheduled", start_at: start, end_at: start });
  await s.upsertDocument(ORG, "projects", { id: "tray", expected_revision: Number(project.revision), data: { ...project.data, events: [event(String(list.id), "2099-01-05T14:00:00Z"), event(String(material.id), "2099-01-04T14:00:00Z")] } }, { replace: true });
  set = await read();
  assert.equal(row(set, "roofing.tear_off").progress, "scheduled"); assert.equal(row(set, "roofing.tear_off").covered_by[0].scheduled, true);
  assert.equal((set.requirements.find((entry: any) => entry.id === shingles.id) as any).progress, "scheduled");
  assert.ok(set.counts.scheduled >= 2);
  // Done: the labor is finalized to be paid and the material is delivered.
  await done.finalizeLaborList(ORG, { list_id: String(list.id), method: "approve" }, manager);
  await lists.patchMaterialList(ORG, String(material.id), { status: "delivered", delivery_status: "delivered" }, owner);
  set = await read();
  assert.equal(row(set, "roofing.tear_off").progress, "completed"); assert.equal((set.requirements.find((entry: any) => entry.id === shingles.id) as any).progress, "completed");
  assert.equal(row(set, "roofing.tear_off").status, "covered", "progress never changes whether something is accounted for");
  // The published tray carries the same states.
  const published = await (await import("../platform/publication/providers.js")).readPublishedData(userPublicationContext(owner, { executionKind: "api" }), { provider: "work-requirements", export: "project", target: { scope: "project", organizationId: ORG, projectId: "tray" } } as any);
  assert.equal(published.status, "ready"); assert.equal(row((published as any).value, "roofing.tear_off").progress, "completed");
});

test("paying out part of a work order: each payout is its own record, locks only its lines, and earns on its own date", async () => {
  const { crew } = await setup();
  const s = await import("../platform/storage.js");
  await s.upsertDocument(ORG, "projects", { id: "partial", data: { title: "partial street", events: [] } });
  const done = await import("../labor/completion.js"), c = await import("../labor/commitments.js"), g = await import("../labor/generation.js"), lists = await import("../materials/storage.js");
  const THREE = [...ITEMS, { id: "l3", name: "Ridge", quantity: 100, unit: "ft", projected_unit_price: 2 }];
  const list = await labor("partial", crew, "In parts", THREE);
  const id = String(list.id);
  await assert.rejects(() => done.finalizeLaborList(ORG, { list_id: id, method: "select_all", confirmed_item_ids: [], partial: true }, manager), /at least one line/);
  // The tear-off is done and paid out now; the rest later.
  const first = await done.finalizeLaborList(ORG, { list_id: id, method: "select_all", confirmed_item_ids: ["l1"], partial: true }, manager);
  assert.deepEqual([first.scope, first.line_ids, first.fully_paid, first.total_cents], ["lines", ["l1"], false, 30 * 40 * 100]);
  assert.match(first.id, /^lp_/); assert.equal(first.pay_unit, first.id, "a payout of part of a list earns under its own row");
  assert.deepEqual(first.items.map((item) => [item.id, item.confirmed]), [["l1", true], ["l2", false], ["l3", false]]);
  assert.equal(await done.finalizedCompletionFor(ORG, id), null, "the work order is not finalized while lines are open");
  assert.equal((await done.listPayState(ORG, await lists.readMaterialList(ORG, id))).state, "part");
  await assert.rejects(() => done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l1", "l2"], partial: true }, manager), /already paid out/);

  // Only the paid line is locked. The open lines change; the paid one and the assignee do not; nothing regenerates it or archives it.
  const now = async () => lists.readMaterialList(ORG, id);
  const version = async (items: object[]) => lists.createMaterialVersion(ORG, id, { expected_revision: Number((await now()).revision), reason: "revision", items }, owner);
  await assert.rejects(() => version(THREE.map((item: any) => (item.id === "l1" ? { ...item, quantity: 31 } : item))), /"Tear off" was paid out/);
  await assert.rejects(() => version(THREE.filter((item: any) => item.id !== "l1")), /"Tear off" was paid out/);
  const changed = THREE.map((item: any) => (item.id === "l3" ? { ...item, quantity: 120 } : item));
  assert.ok(await version(changed), "an open line can still change");
  assert.equal((await lists.patchMaterialList(ORG, id, { title: "In parts, renamed" }, owner)).title, "In parts, renamed");
  await assert.rejects(() => lists.patchMaterialList(ORG, id, { assignment: { work_resource_ref: { id: "someone_else", kind: "resource_group", name: "Crew B" } } }, owner), /cannot be given to someone else/);
  await assert.rejects(() => lists.archiveMaterialList(ORG, id, { reason: "x" }, owner), /already paid out/);
  await assert.rejects(() => g.generateLaborList(ORG, { list_id: id }, manager), /already paid out/);
  const items = (await done.completionItems(ORG, "partial", { list_id: id })).items;
  assert.deepEqual(items.map((item) => [item.id, item.done, !!item.paid_at]), [["l1", true, true], ["l2", false, false], ["l3", false, false]]);
  assert.equal((await c.currentCommitmentsFor(ORG, { type: "resource_group", id: crew })).some((entry) => entry.list_id === id), true, "the assignee still holds the open work");

  // Pay: the payout is its own row with its own date; the commitment carries only what is still open.
  let rows = (await payRows()).filter((row) => row.list_id === id);
  const payout = rows.find((row) => row.id === first.pay_unit);
  assert.deepEqual([payout.total_cents, payout.finalized_at, payout.status, payout.payout_id], [30 * 40 * 100, first.finalized_at, "committed", first.id]);
  assert.ok(rows.filter((row) => row.id !== first.pay_unit).every((row) => !row.finalized_at), "nothing else on the list is earned yet");
  const { paySourceExports } = await import("../payroll/pay-sources.js");
  const projected = ((await paySourceExports().labor_commitments.read!({ organizationId: ORG } as any, { args: { projected: true } } as any)) as any).value.filter((row: any) => row.list_id === id);
  assert.deepEqual(projected.map((row: any) => row.total_cents), [30 * 90 * 100 + 100 * 2 * 100], "projected pay counts only the lines not paid out, as they were committed");

  // The rest, in a second payout: every open line must be confirmed unless it is partial again.
  await assert.rejects(() => done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l2"] }, manager), /Confirm every line item.*"Ridge"/);
  const second = await done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l2", "l3"] }, manager);
  assert.deepEqual([second.scope, second.line_ids, second.fully_paid], ["lines", ["l2", "l3"], true]);
  assert.equal((await done.finalizedCompletionFor(ORG, id))?.id, second.id, "every line paid out: the work order is finalized");
  await assert.rejects(() => lists.patchMaterialList(ORG, id, { title: "Again" }, owner), /finalized to be paid/);
  assert.equal((await c.currentCommitmentsFor(ORG, { type: "resource_group", id: crew })).some((entry) => entry.list_id === id), false);
  rows = (await payRows()).filter((row) => row.list_id === id && row.finalized_at);
  assert.deepEqual(rows.map((row) => row.total_cents).sort((a, b) => a - b), [30 * 40 * 100, 30 * 90 * 100 + 120 * 2 * 100], "two payouts, each earned once");
  assert.equal(rows.reduce((sum, row) => sum + row.total_cents, 0), 30 * 40 * 100 + 30 * 90 * 100 + 120 * 2 * 100, "together they are the whole list, never more");
  const { finalizedWorkToPay } = await import("../payroll/finalized-work.js");
  assert.deepEqual((await finalizedWorkToPay(ORG)).filter((row) => row.list_id === id).map((row) => row.id).sort(), [first.id, second.id].sort());

  // A manager reopens the first payout only: its line is open again and its pay is reversed; the second stands.
  const supervisor = member("supervisor", { manage_projects: true, reopen_finalized_work: true });
  const reopened = await done.reopenLaborList(ORG, { list_id: id, reason: "Tear-off was redone", completion_id: first.id }, supervisor);
  assert.equal(reopened.id, first.id); assert.equal(reopened.state, "reopened");
  assert.equal((await done.listPayState(ORG, await now())).state, "part");
  assert.deepEqual((await payRows()).filter((row) => row.list_id === id && row.finalized_at).map((row) => row.id), [second.pay_unit]);
});

test("how work is confirmed is the organization's setting, select_all unless chosen, changed only with company settings access", async () => {
  await setup();
  const done = await import("../labor/completion.js");
  assert.deepEqual(await done.readCompletionSettings(ORG), { method: "select_all", revision: 0 });
  await assert.rejects(() => done.saveCompletionSettings(ORG, { method: "each" }, manager), /company settings access/);
  await assert.rejects(() => done.saveCompletionSettings(ORG, { method: "sometimes" }, owner));
  const saved = await done.saveCompletionSettings(ORG, { method: "each" }, owner);
  assert.equal(saved.method, "each"); assert.ok(saved.revision > 0);
  await assert.rejects(() => done.saveCompletionSettings(ORG, { method: "approve", expected_revision: saved.revision + 5 }, owner), /Someone else changed/);
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const read: any = await (await import("../platform/publication/providers.js")).readPublishedData(userPublicationContext(manager, { executionKind: "api" }), { provider: "labor-completion", export: "settings", target: { scope: "organization", organizationId: ORG } });
  assert.equal(read.status, "ready"); assert.equal(read.value.method, "each", "Pay out and Closeout read it with project access");
  const actions = await import("../platform/publication/actions.js");
  await assert.rejects(() => actions.invokeAction(userPublicationContext(manager, { executionKind: "api", mode: "command" }), { action: "labor-completion.settings.save", target: { scope: "organization", organizationId: ORG } } as any, { method: "approve" }, { idempotencyKey: "cs-denied" }), /denied|permission|forbidden|not permitted/i);
  const changed: any = (await actions.invokeAction(userPublicationContext(owner, { executionKind: "api", mode: "command" }), { action: "labor-completion.settings.save", target: { scope: "organization", organizationId: ORG } } as any, { method: "approve" }, { idempotencyKey: "cs-ok" })).value;
  assert.equal(changed.method, "approve");
  await done.saveCompletionSettings(ORG, { method: "select_all" }, owner);
});

test("the rest of a partly paid work order can be cancelled: it comes off the list, its commitment is released, and the work order is finalized on what was paid", async () => {
  const { crew } = await setup();
  const s = await import("../platform/storage.js");
  await s.upsertDocument(ORG, "projects", { id: "cancelling", data: { title: "cancelling street", events: [] } });
  const done = await import("../labor/completion.js"), c = await import("../labor/commitments.js"), lists = await import("../materials/storage.js");
  const list = await labor("cancelling", crew, "Half done");
  const id = String(list.id);
  await assert.rejects(() => done.cancelRemainingLines(ORG, { list_id: id, reason: "Owner stopped" }, manager), /Nothing on this work order is paid out yet/);
  const first = await done.finalizeLaborList(ORG, { list_id: id, method: "each", confirmed_item_ids: ["l1"], partial: true }, manager);
  await assert.rejects(() => done.cancelRemainingLines(ORG, { list_id: id, reason: "Owner stopped" }, viewer), /project management access/);
  await assert.rejects(() => done.cancelRemainingLines(ORG, { list_id: id, reason: "" }, manager));
  const result = await done.cancelRemainingLines(ORG, { list_id: id, reason: "Owner decided against the new shingles" }, manager);
  assert.deepEqual([result.state, result.cancelled.map((line) => line.id), result.paid_cents], ["paid", ["l2"], 30 * 40 * 100]);
  assert.deepEqual(((await lists.readMaterialList(ORG, id)).current_items as any[]).map((item: any) => item.id), ["l1"], "the open line is off the list");
  assert.equal((await done.finalizedCompletionFor(ORG, id))?.id, first.id, "finalized on the lines already paid out");
  assert.deepEqual((await c.listCommitments(ORG, { list_id: id })).map((entry) => [entry.status, entry.release_reason]), [["released", "Rest cancelled: Owner decided against the new shingles"]]);
  assert.equal((await c.currentCommitmentsFor(ORG, { type: "resource_group", id: crew })).some((entry) => entry.list_id === id), false, "the assignee no longer holds it");
  const rows = (await payRows()).filter((row) => row.list_id === id);
  assert.deepEqual(rows.filter((row) => row.finalized_at).map((row) => row.total_cents), [30 * 40 * 100], "only what was paid out is earned");
  const { paySourceExports } = await import("../payroll/pay-sources.js");
  assert.equal(((await paySourceExports().labor_commitments.read!({ organizationId: ORG } as any, { args: { projected: true } } as any)) as any).value.some((row: any) => row.list_id === id), false, "nothing more is projected for it");
  const events = (await lists.listMaterialEvents(ORG, id)).map((event: any) => event.type || event.event_type);
  assert.ok(events.includes("labor_completion.remainder_cancelled"));
  await assert.rejects(() => done.cancelRemainingLines(ORG, { list_id: id, reason: "Again" }, manager), /already paid out/);
  // Closing out sees it as finished.
  const { closeoutChecks } = await import("../closeout/closeout.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const checks = await closeoutChecks(userPublicationContext(owner, { executionKind: "api", projectId: "cancelling" }), "cancelling");
  assert.deepEqual(checks.open_work_orders, []);
});
