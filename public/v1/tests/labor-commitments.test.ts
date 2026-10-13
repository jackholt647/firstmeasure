import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "labor-commitments-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });

test("committing a labor list freezes it, supersedes the last revision and delivers by the recipient's method", async () => {
  const s = await import("../platform/storage.js");
  const lists = await import("../materials/storage.js");
  const c = await import("../labor/commitments.js");
  try {
    await s.createOrganization({ id: "org_commit", name: "Commit" });
    await s.saveGlobal("org_commit", { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
    await enableExpandedPlatformFixture("org_commit", { "platform.materials": true, "platform.pricebook": true });
    await s.upsertDocument("org_commit", "projects", { id: "project", data: { title: "12 Oak St" } });
    const owner = { orgId: "org_commit", userId: "owner", role: "owner", permissions: {}, branchId: "default" } as any;
    const calls: any[] = [];
    const effects = (planned?: any[]): any => ({
      todo: async (body: any) => { calls.push(["todo", body.title, body.id]); },
      email: async (input: any) => { calls.push(["email", input.to, input.subject, input.idempotency_key]); },
      run: async (source: string, inputs: any) => { calls.push(["run", source === c.DEFAULT_CUSTOM_DELIVERY, inputs.commitment.provider.name]); return planned || [{ action: "todo", title: "Send work to " + inputs.commitment.provider.name }]; }
    });
    const labor = (title: string, reference: object | null, items = [{ id: "l1", name: "Tear off", quantity: 32, unit: "sq", projected_unit_price: 40, metadata: { compensation_kind: "piece_rate" } }, { id: "l2", name: "Hourly help", quantity: 6, unit: "hour" }]) =>
      lists.createMaterialList("org_commit", "project", { title, resource_type: "labor", items, ...(reference ? { assignment: { provider_ref: reference } } : {}) }, owner);

    const unassigned = await labor("Unassigned", null);
    await assert.rejects(() => c.commitLaborList("org_commit", { list_id: String(unassigned.id) }, owner, effects()), /Assign this list/);
    const material = await lists.createMaterialList("org_commit", "project", { title: "Shingles", resource_type: "material", items: [] }, owner);
    await assert.rejects(() => c.commitLaborList("org_commit", { list_id: String(material.id) }, owner, effects()), /Only a labor list/);
    await assert.rejects(() => c.commitLaborList("org_commit", { list_id: String(unassigned.id) }, { ...owner, role: "member", permissions: { manage_projects: false }, accessProfile: { roles: [] } }, effects()), /project management access/);

    // An in-house crew is shared with by default.
    const crewList = await labor("Roof labor", { id: "crew_a", kind: "resource_group", name: "Crew A" });
    const first = await c.commitLaborList("org_commit", { list_id: String(crewList.id), note: "Start Monday" }, owner, effects());
    assert.equal(first.revision, 1); assert.equal(first.status, "committed"); assert.deepEqual(first.provider, { type: "resource_group", id: "crew_a", name: "Crew A" });
    assert.deepEqual(first.lines.map((line) => [line.name, line.quantity, line.rate_cents, line.total_cents]), [["Tear off", 32, 4000, 128000], ["Hourly help", 6, null, null]], "a line with no rate stays unpriced");
    assert.equal(first.total_cents, 128000); assert.equal(first.project_title, "12 Oak St");
    assert.deepEqual([first.delivery.method, first.delivery.status], ["share", "delivered"]); assert.deepEqual(calls, [], "sharing sends nothing");

    // Later edits to the list do not change what was committed; committing again supersedes it.
    const second = await c.commitLaborList("org_commit", { list_id: String(crewList.id) }, owner, effects());
    const history = await c.listCommitments("org_commit", { list_id: String(crewList.id) });
    assert.deepEqual(history.map((entry) => [entry.revision, entry.status]), [[1, "superseded"], [2, "committed"]]); assert.equal(history[0]!.note, "Start Monday");
    assert.deepEqual((await c.currentCommitmentsFor("org_commit", { type: "resource_group", id: "crew_a" })).map((entry) => entry.id), [second.id], "a crew is committed to its current revisions only");

    // A subcontractor with no linked organization is emailed a work order, once an address is known.
    const subList = await labor("Sub labor", { id: "conn_summit", kind: "organization_connection", name: "Summit Roofing" });
    const blocked = await c.commitLaborList("org_commit", { list_id: String(subList.id) }, owner, effects());
    assert.deepEqual([blocked.delivery.method, blocked.delivery.status], ["work_order_email", "needs_attention"]); assert.match(blocked.delivery.detail, /no email address for Summit Roofing/);
    await assert.rejects(() => c.saveDeliverySetting("org_commit", { subject: { type: "organization_connection", id: "conn_summit" }, method: "work_order_email", email: "office@summit.test" }, { ...owner, role: "member", permissions: {}, accessProfile: { roles: [] } }), /company settings access/);
    await c.saveDeliverySetting("org_commit", { subject: { type: "organization_connection", id: "conn_summit" }, method: "work_order_email", email: "office@summit.test" }, owner);
    const emailed = await c.commitLaborList("org_commit", { list_id: String(subList.id) }, owner, effects());
    assert.equal(emailed.revision, 2); assert.equal(emailed.delivery.status, "delivered");
    assert.deepEqual(calls.at(-1), ["email", "office@summit.test", "Work order - 12 Oak St (revision 2)", `labor_commitment:${emailed.id}:0`]);

    // The custom method runs the recipient's delivery code, which only plans steps. With no code of its own it asks
    // someone to deliver by hand, and that to-do is not the work arriving.
    await c.saveDeliverySetting("org_commit", { subject: { type: "resource_group", id: "crew_a" }, method: "custom" }, owner);
    const byHand = await c.commitLaborList("org_commit", { list_id: String(crewList.id) }, owner, effects());
    assert.deepEqual([byHand.delivery.method, byHand.delivery.status], ["custom", "pending"]);
    assert.deepEqual(calls.slice(-2), [["run", true, "Crew A"], ["todo", "Send work to Crew A", `labor_delivery_${byHand.id}_0`]]);
    const planned = await c.commitLaborList("org_commit", { list_id: String(crewList.id) }, owner, effects([{ action: "todo", title: "Print the work order" }, { action: "email", to: "lead@crew.test", subject: "Your work", text: "See attached." }]));
    assert.equal(planned.delivery.status, "delivered"); assert.deepEqual(planned.delivery.steps.map((step) => step.action), ["todo", "email"]);
    const failing = await c.commitLaborList("org_commit", { list_id: String(crewList.id) }, owner, { ...effects(), run: async () => { throw new Error("Delivery code failed to run."); } });
    assert.deepEqual([failing.delivery.status, failing.delivery.detail], ["needs_attention", "Delivery code failed to run."], "a failed delivery never reports delivered");
    assert.equal((await c.listCommitments("org_commit", { project_id: "project" })).filter((entry) => entry.status === "committed").length, 2, "one current commitment per list");

    // Crews inside a provider: capacity is one job per crew with no crews under it, worked out from commitments alone.
    const summit = { type: "organization_connection" as const, id: "conn_summit" };
    const alone = await c.providerAvailability("org_commit", summit);
    assert.deepEqual([alone.capacity, alone.committed, alone.available, alone.over_committed], [1, 1, 0, false], "a provider with no crews is one unit, and it is busy");
    const north = await c.saveCrew("org_commit", { provider: summit, name: "North crew" }, owner);
    const south = await c.saveCrew("org_commit", { provider: summit, name: "South crew" }, owner);
    const southB = await c.saveCrew("org_commit", { provider: summit, name: "South B", parent_crew_id: south.id }, owner);
    await assert.rejects(() => c.saveCrew("org_commit", { provider: summit, name: "South crew", id: south.id, parent_crew_id: southB.id }, owner), /cannot sit under itself/);
    await assert.rejects(() => c.saveCrew("org_commit", { provider: { type: "resource_group", id: "crew_a" }, name: "Stray", parent_crew_id: north.id }, owner), /same labor provider/);
    await assert.rejects(() => c.archiveCrew("org_commit", { id: south.id }, owner), /crews under this one/);
    const split = await c.providerAvailability("org_commit", summit);
    assert.deepEqual(split.units.map((unit) => unit.name), ["North crew", "South B"], "South has a crew under it, so South B is the unit");
    assert.deepEqual([split.capacity, split.committed, split.available], [2, 1, 1]); assert.equal(split.unplaced.length, 1, "work committed to the provider as a whole uses a unit without naming one");
    await assert.rejects(() => c.commitLaborList("org_commit", { list_id: String(subList.id), crew_id: "crew_elsewhere" }, owner, effects()), /does not belong to the assigned labor provider/);
    const placed = await c.commitLaborList("org_commit", { list_id: String(subList.id), crew_id: north.id }, owner, effects());
    assert.deepEqual(placed.crew, { id: north.id, name: "North crew" });
    const second2 = await labor("Second job", { id: "conn_summit", kind: "organization_connection", name: "Summit Roofing" });
    await c.commitLaborList("org_commit", { list_id: String(second2.id), crew_id: southB.id }, owner, effects());
    const third = await labor("Third job", { id: "conn_summit", kind: "organization_connection", name: "Summit Roofing" });
    const extra = await c.commitLaborList("org_commit", { list_id: String(third.id) }, owner, effects());
    const full = await c.providerAvailability("org_commit", summit);
    assert.deepEqual(full.units.map((unit) => [unit.name, unit.available, unit.committed.length]), [["North crew", false, 1], ["South B", false, 1]]);
    assert.deepEqual([full.capacity, full.committed, full.available, full.over_committed], [2, 3, 0, true], "three jobs on two crews is over-committed, and says so");
    // Releasing finished work frees the capacity; nothing else does.
    const released = await c.releaseCommitment("org_commit", { id: extra.id, reason: "Job complete" }, owner);
    assert.equal(released.status, "released"); assert.equal((await c.releaseCommitment("org_commit", { id: extra.id }, owner)).status, "released", "releasing twice changes nothing");
    await c.releaseCommitment("org_commit", { id: placed.id }, owner);
    const freed = await c.providerAvailability("org_commit", summit);
    assert.deepEqual([freed.committed, freed.available, freed.over_committed], [1, 1, false]); assert.deepEqual(freed.units.map((unit) => unit.available), [true, false]);

    // With the real effects: the default delivery code runs in the sandbox and its to-do is really created.
    const handList = await labor("By hand", { id: "crew_b", kind: "resource_group", name: "Crew B" });
    await c.saveDeliverySetting("org_commit", { subject: { type: "resource_group", id: "crew_b" }, method: "custom" }, owner);
    const real = await c.commitLaborList("org_commit", { list_id: String(handList.id) }, owner);
    assert.deepEqual([real.delivery.status, real.delivery.detail], ["pending", "A to-do was created to deliver this work by hand."]);
    const plans = await (await import("../work/service.js")).listWorkPlans("org_commit", { project_id: "project" }) as any;
    const titles = (Array.isArray(plans) ? plans : plans.plans || plans.items || []).map((plan: any) => String(plan.title || ""));
    assert.ok(titles.includes("Send work to Crew B"), `the to-do exists on the project: ${JSON.stringify(titles)}`);
  } finally { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
});

test("delivery code runs in the sandbox and can only return steps", async () => {
  const c = await import("../labor/commitments.js");
  const effects = c.platformDeliveryEffects("org_commit", { project_id: "project" }, { orgId: "org_commit", userId: "owner" } as any);
  const commitment = { title: "Roof labor", project_title: "12 Oak St", provider: { name: "Crew A" } };
  assert.deepEqual(await effects.run(c.DEFAULT_CUSTOM_DELIVERY, { commitment }), [{ action: "todo", title: "Send work to Crew A", body: "Roof labor on 12 Oak St is committed and has not been delivered. Open the project to send it." }]);
  await assert.rejects(() => effects.run(`await api.actions.invoke('pay', {}); return { outputs: { steps: [] } };`, { commitment }), "delivery code cannot act");
  await assert.rejects(() => effects.run(`return { outputs: { steps: [{ action: "wire_money", amount: 5 }] } };`, { commitment }), "only the fixed steps are accepted");
  assert.equal(c.defaultDeliveryMethod({ type: "organization_user", id: "u" }), "share");
  assert.equal(c.defaultDeliveryMethod({ type: "organization_connection", id: "c" }, { linked_organization_id: "org_b", link_status: "active" }), "share");
  assert.equal(c.defaultDeliveryMethod({ type: "organization_connection", id: "c" }, { linked_organization_id: "", link_status: "unlinked" }), "work_order_email");
});
