import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

/** Onboarding an outside company: requirements on company types, the record on the company (connections/onboarding.ts). */
const dir = await mkdtemp(path.join(os.tmpdir(), "company-onboarding-"));
Object.assign(process.env, {
  NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", APPOINTMENT_CONFIRMATIONS_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
  PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), MESSAGING_STORAGE_ROOT: path.join(dir, "messaging")
});
let app: any = null;
const ORG = "org_company_onboarding";
before(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Onboarding test" });
  await enableExpandedPlatformFixture(ORG);
});
after(async () => {
  await (await import("../firstmeasure/job_runtime.js")).stopFirstMeasureJobRuntime().catch(() => {});
  if (app) await app.close();
  await closePlatformFixtureStores();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

async function member(id: string, data: Record<string, unknown>) {
  const s = await import("../platform/storage.js");
  const { env } = await import("../src/config/env.js");
  const { createHmac } = await import("node:crypto");
  const identity = await s.createIdentity({ email: `${id}@example.test`, name: id });
  await s.addIdentityMembership(String(identity.id), ORG, id, "member");
  await s.upsertDocument(ORG, "users", { id, data: { identity_id: identity.id, email: `${id}@example.test`, name: id, status: "active", ...data } });
  const auth = await s.createAuthSession({ identity_id: identity.id, organization_id: ORG, user_id: id, role: "member" });
  const signature = createHmac("sha256", env.platformSessionSecret).update(auth.sessionId).digest("base64url");
  return async (method: string, url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, payload, headers: { cookie: `fm_platform_session=${auth.sessionId}.${signature}`, "x-platform-csrf": String(auth.session.csrf_token) } });
    let body: any = null; try { body = response.json(); } catch { body = null; }
    return { status: response.statusCode, body };
  };
}
const invoke = (call: Function, action: string, input: unknown, id = "") => call("POST", `/v1/publication/organizations/${ORG}/actions/invoke`, { action, target: { scope: "organization", organizationId: ORG, ...(id ? { id } : {}) }, input, idempotencyKey: `${action}-${Math.random()}` });

test("each requirement is done, missing, optional, expiring or expired, and the company is complete only when nothing required is missing", async () => {
  const { onboardingStatus, companyRequirements } = await import("../connections/onboarding-contract.js");
  const requirements = companyRequirements([
    { id: "roofing", onboarding_requirements: [{ id: "w9", label: "W-9", kind: "document" }, { id: "coi", label: "Certificate of insurance", kind: "document", expires: true }, { id: "license", label: "License", kind: "date", expires: true }] },
    { id: "gutters", onboarding_requirements: [{ id: "w9", label: "W-9 again", kind: "document" }, { id: "agreement", label: "Signed agreement", kind: "check", required: false }] },
    { id: "other", onboarding_requirements: [{ id: "never", label: "Not this type", kind: "check" }] }
  ], ["roofing", "gutters"]);
  assert.deepEqual(requirements.map((r) => r.id), ["w9", "coi", "license", "agreement"], "each requirement once, from the company's own types");
  const today = "2027-01-01";
  let status = onboardingStatus(requirements, {}, today);
  assert.equal(status.state, "incomplete");
  assert.deepEqual(status.items.map((i) => i.status), ["missing", "missing", "missing", "optional"]);
  status = onboardingStatus(requirements, { items: { license: { date: "2027-01-20" }, agreement: { done: true } }, documents: [{ media_id: "m1", requirement_id: "w9", title: "W-9" }, { media_id: "m2", requirement_id: "coi", title: "COI", expires_at: "2027-06-30" }] }, today);
  assert.deepEqual(status.items.map((i) => [i.id, i.status]), [["w9", "done"], ["coi", "done"], ["license", "expiring"], ["agreement", "done"]]);
  assert.equal(status.state, "attention", "something expires within 30 days");
  status = onboardingStatus(requirements, { items: { license: { date: "2027-06-01" } }, documents: [{ media_id: "m1", requirement_id: "w9", title: "W-9" }, { media_id: "m2", requirement_id: "coi", title: "COI", expires_at: "2026-12-01" }] }, today);
  assert.equal(status.items.find((i) => i.id === "coi")!.status, "expired");
  assert.equal(status.state, "incomplete", "a required item that expired");
  assert.equal(onboardingStatus([], {}).state, "none");
});

test("company types carry onboarding requirements; a company's record is saved whole by connections.onboarding.save", async () => {
  const admin = await member("admin", { org_permissions: { level: "super_admin", items: {} }, permission_overrides: { "*": true } });
  const viewer = await member("viewer", { org_permissions: { level: "viewer", items: {} } });
  const saved = await invoke(admin, "assignees.type.save", { kind: "organization_connection", id: "roofing", name: "Roofing", onboarding_requirements: [{ id: "w9", label: "W-9", kind: "document" }, { id: "coi", label: "Certificate of insurance", kind: "document", expires: true }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { listCompanyTypes, saveAssigneeType } = await import("../assignees/base.js");
  let roofing = (await listCompanyTypes(ORG)).find((type) => type.id === "roofing")!;
  assert.deepEqual(roofing.onboarding_requirements!.map((r) => [r.id, r.kind, r.expires, r.required]), [["w9", "document", false, true], ["coi", "document", true, true]]);
  // Renaming the type keeps its requirements; a group type cannot have any.
  await saveAssigneeType(ORG, { kind: "organization_connection", id: "roofing", name: "Roofers" }, { orgId: ORG, userId: "admin", permissions: { manage_company_settings: true } } as any);
  roofing = (await listCompanyTypes(ORG)).find((type) => type.id === "roofing")!;
  assert.equal(roofing.name, "Roofers");
  assert.equal(roofing.onboarding_requirements!.length, 2);
  assert.equal((await invoke(admin, "assignees.type.save", { kind: "resource_group", id: "crew", name: "Crew", onboarding_requirements: [] })).status, 400);

  const connections = await import("../connections/storage.js");
  const company = await connections.createOrganizationConnection(ORG, { name: "Summit Roofing", metadata: { note: "kept" } });
  await invoke(admin, "assignees.profile.set", { assignee: { type: "organization_connection", id: String(company.id) }, type_ids: ["roofing"] });
  const record = { items: {}, documents: [{ media_id: "media_w9", requirement_id: "w9", title: "W-9 2026" }, { media_id: "media_coi", requirement_id: "coi", title: "Insurance", expires_at: "2099-01-01" }] };
  const denied = await invoke(viewer, "connections.onboarding.save", { expected_revision: Number(company.revision), onboarding: record }, String(company.id));
  assert.equal(denied.status, 403, "company settings access is needed");
  const current = await connections.readOrganizationConnection(ORG, String(company.id));
  const ok = await invoke(admin, "connections.onboarding.save", { expected_revision: Number(current.revision), onboarding: record }, String(company.id));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const value = ok.body.value || ok.body.result || ok.body;
  assert.equal(value.status.state, "complete");
  const stored = await connections.readOrganizationConnection(ORG, String(company.id));
  assert.equal((stored.metadata as any).note, "kept", "other metadata is kept");
  assert.equal((stored.metadata as any).onboarding.documents.length, 2);
  // A stale revision is refused.
  assert.equal((await invoke(admin, "connections.onboarding.save", { expected_revision: Number(current.revision), onboarding: { items: {}, documents: [] } }, String(company.id))).status, 409);
  // Bad dates are refused.
  assert.equal((await invoke(admin, "connections.onboarding.save", { expected_revision: Number(stored.revision), onboarding: { items: { coi: { date: "next week" } }, documents: [] } }, String(company.id))).status, 400);
});
