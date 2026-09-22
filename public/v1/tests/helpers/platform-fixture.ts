// Distinct reserved fictional numbers for registrations in one isolated test process.
let phoneIndex = 0;
export function nextTestPhone() {
  if (phoneIndex >= 100) throw new Error("This fixture exhausted its reserved phone numbers.");
  return `20255501${String(phoneIndex++).padStart(2, "0")}`;
}
export async function enableExpandedPlatformFixture(orgId: string, values: Record<string, unknown> = {}) {
  const { saveCapabilityValues } = await import("../../platform/capabilities.js");
  return saveCapabilityValues(orgId, { ...values, "platform.expanded_access": true });
}

/** Release local database handles before Windows removes isolated fixture folders. */
export async function closePlatformFixtureStores() {
  const { closeSqlStoresForTests } = await import("../../platform/sql_store.js");
  const { closeFirstMeasureProjectIndex } = await import("../../firstmeasure/project_index.js");
  await closeSqlStoresForTests();
  await closeFirstMeasureProjectIndex();
}

/** An explicit operator session for tests of operator-only configuration APIs. */
export async function operatorFixtureClient(app: any, orgId: string) {
  process.env.PLATFORM_TEST_ORG_IDS = [...new Set([...(process.env.PLATFORM_TEST_ORG_IDS || "").split(",").filter(Boolean), orgId])].join(",");
  const storage = await import("../../platform/storage.js");
  const { env } = await import("../../src/config/env.js");
  const { createHmac } = await import("node:crypto");
  const identity = await storage.findIdentityByEmail("notifications@1m8.ai").catch(error => { if (error?.code === "not_found") return null; throw error; })
    || await storage.createIdentity({ email: "notifications@1m8.ai", name: "Fixture operator" });
  const userId = "fixture_operator";
  await storage.addIdentityMembership(String(identity.id), orgId, userId, "owner");
  await storage.upsertDocument(orgId, "users", { id: userId, data: { identity_id: identity.id,
    email: identity.email, status: "active", org_permissions: { level: "owner", items: {} } } });
  const auth = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: userId, role: "owner" });
  const signature = createHmac("sha256", env.platformSessionSecret).update(auth.sessionId).digest("base64url");
  const raw = (method: string, url: string, payload?: unknown) => app.inject({ method, url, payload,
    headers: { cookie: `fm_platform_session=${auth.sessionId}.${signature}`, "x-platform-csrf": String(auth.session.csrf_token) } });
  return { raw, request: async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
    return response.json();
  } };
}
