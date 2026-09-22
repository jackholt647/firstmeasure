/**
 * LIVE Forward sandbox org-wiring check.
 *
 * !!! REQUIRES REAL SANDBOX KEYS loaded by the API server (:3101) from
 * !!! public/v1/.env. MAKES REAL Forward sandbox API calls through OUR
 * !!! /v1/payments routes (HTTP -> adapter -> sandbox chain).
 *
 * Seeds a local test org, sets merchant provider "forward", lists live
 * processing plans through /merchant-boarding/*, creates a REAL sandbox
 * application (reusing the harness business via FORWARD_WIRE_BUSINESS_ID, or
 * creating one), walks get/update/submit, then verifies the Boarding Ops
 * staff admin endpoints see the live application and plans.
 *
 *   node scripts/forward-org-wire-e2e.mjs     (from public/v1; stack on :3101)
 */
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const REUSE_BUSINESS = process.env.FORWARD_WIRE_BUSINESS_ID || "";
const REUSE_APPLICATION = process.env.FORWARD_WIRE_APPLICATION_ID || "";
const US_PLAN = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

function apiClient() {
  const jar = new Map();
  let csrf = "";
  return {
    async req(method, url, body, headers = {}) {
      const res = await fetch(API + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
          ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const pair = raw.split(";")[0];
        jar.set(pair.split("=")[0], pair);
        if (pair.startsWith("fm_platform_session_csrf=")) csrf = decodeURIComponent(pair.split("=")[1] || "");
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
      return { status: res.status, data, text: text.slice(0, 500) };
    }
  };
}

const owner = apiClient();
const orgId = `org_fwdwire_${suffix}`;
const ownerEmail = `fwd-owner-${suffix}@example.test`;
const password = "correct horse battery staple";

// --- seed org wired to provider "forward" ------------------------------------
let r = await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password, name: "Forward Wire Owner",
  company: "FM Sandbox Test Co", organization_id: orgId
});
check("seed: org registered", r.status < 400, r.status);
r = await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
check("seed: preset applied", r.status < 400, { status: r.status, error: r.status >= 400 ? r.text : undefined });
r = await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "money.merchant_processing": true } });
check("seed: merchant_processing capability on", r.status < 400, { status: r.status, error: r.status >= 400 ? r.text : undefined });
r = await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "forward" });
check("seed: provider set to forward", r.data?.merchant_config?.provider === "forward", r.data?.merchant_config?.provider);

// --- live plans through OUR route --------------------------------------------
r = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/processing-plans`);
const planIds = (r.data?.processing_plans || []).map((p) => p.id);
check("route: live processing plans returned", r.status === 200 && planIds.includes(US_PLAN), planIds);

// --- live application through OUR route --------------------------------------
let applicationId = REUSE_APPLICATION;
if (applicationId) {
  // Reuse mode: point this org's merchant config at the existing sandbox ids
  // so the admin console checks below resolve.
  r = await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    forward: { business_id: REUSE_BUSINESS, application_id: applicationId, processing_plan_id: US_PLAN, boarding_status: "DRAFT" }
  });
  check("seed: reuse ids recorded on merchant config", r.status === 200, r.status);
}
const APP_INPUT = {
  name: "FM Sandbox Test Co",
  processing_plan_id: US_PLAN,
  company: {
      legal_name: "FM Sandbox Test Co",
      dba: "FM Sandbox Test Co",
      ein: "000000000",
      description: "Roofing and exterior services (sandbox validation harness test data).",
      ownership_type: "LLC",
      mcc: "1761",
      category: "RETAIL",
      business_start_date: "2015-04-01",
      phone: "2065550123",
      website: "https://example.com"
    },
    address: { address1: "600 Test Harness Way", city: "Seattle", state: "WA", postal_code: "98101", country: "US" },
    owners: [{
      name: "Testy McTestface",
      email: "testy.mctestface@firstmate.test",
      phone: "2065550124",
      dob: "1980-01-01",
      ssn: "000000001",
      ownership_percent: 100,
      title: "Member",
      signer: true,
      address: { address1: "601 Test Harness Way", city: "Seattle", state: "WA", postal_code: "98101", country: "US" }
    }],
    volumes: { annual_volume: 250000, avg_ticket: 8000, high_ticket: 25000, card_present_percent: 70 },
    user_fields: { firstmate_org_id: orgId, harness: "forward-org-wire-e2e" }
};

if (!applicationId) {
  r = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications`, {
    ...(REUSE_BUSINESS ? { business_id: REUSE_BUSINESS } : { business: { name: "FM Sandbox Test Co", email: "sandbox-boarding@firstmate.test", phone: "2065550123" } }),
    ...APP_INPUT
  });
  check("route: live application created (201)", r.status === 201 && /^aapp_/.test(r.data?.application?.id || ""), { status: r.status, id: r.data?.application?.id, error: r.status >= 400 ? r.text : undefined });
  applicationId = r.data?.application?.id || "";
  check("route: merchant config captured business + application ids", /^bus_/.test(r.data?.merchant_config?.forward?.business_id || REUSE_BUSINESS || "") && r.data?.merchant_config?.forward?.application_id === applicationId, r.data?.merchant_config?.forward);
}

if (applicationId) {
  r = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${applicationId}`);
  check("route: getApplication returns DRAFT", r.status === 200 && r.data?.application?.status === "DRAFT", r.data?.application?.status);
  r = await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${applicationId}`, {
    ...APP_INPUT,
    business_id: r.data?.application?.business_id || REUSE_BUSINESS,
    user_fields: { ...APP_INPUT.user_fields, updated: "yes" }
  });
  check("route: updateApplication succeeds", r.status === 200, { status: r.status, error: r.status >= 400 ? r.text : undefined });
  r = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${applicationId}/submit`, {});
  const blocked = /not enabled for your integration/i.test(r.text);
  check("route: submit surfaces the partner-capability block (KNOWN rep question)", r.status >= 400 && blocked, { status: r.status, body: r.text.slice(0, 200) });
}

// --- Boarding Ops staff console admin endpoints ------------------------------
const STAFF_EMAIL = `fwd-staff-${suffix}@1m8.ai`;
await apiClient().req("POST", "/v1/internal/users", {
  email: STAFF_EMAIL, name: "Forward Wire Admin", role: "admin", password, training_complete: true
});
async function staffApi(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: { "Content-Type": "application/json", "X-Internal-User-Email": STAFF_EMAIL, "X-Internal-User-Name": "Forward Wire Admin" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: res.status, data, text: text.slice(0, 400) };
}

r = await staffApi("GET", "/v1/payments/admin/merchant-configs");
const row = (r.data?.merchant_configs || r.data?.pipeline || []).find?.((entry) => entry.org_id === orgId);
check("admin: pipeline lists the live forward org", r.status === 200 && !!row && row.provider === "forward" && /^aapp_/.test(row.application_id || ""), row);
r = await staffApi("GET", `/v1/payments/admin/merchant-configs/${orgId}`);
check("admin: org detail resolves live application", r.status === 200 && /^aapp_/.test(r.data?.application?.id || r.data?.merchant_config?.forward?.application_id || ""), { status: r.status, application: r.data?.application?.id });
r = await staffApi("GET", "/v1/payments/admin/processing-plans");
const adminPlans = (r.data?.processing_plans || []).map((p) => p.id);
check("admin: processing plans include live sandbox plans", r.status === 200 && adminPlans.includes(US_PLAN), adminPlans);

const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log("org:", orgId, "application:", applicationId);
if (failed.length) { console.log("FAILED:", failed.map((x) => x.name)); process.exit(1); }
