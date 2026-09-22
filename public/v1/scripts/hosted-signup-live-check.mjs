/**
 * One-shot LIVE check of the hosted-first signup harness against the Forward
 * SANDBOX through the running dev API (:3101): seeds a fresh org with
 * provider "forward", calls the hosted-signup endpoint (creates ONE real
 * sandbox business + draft application, same footprint as
 * forward-sandbox-e2e), asserts a real aapplink URL comes back, then mints a
 * merchant-portal magic link. Requires FORWARD_* sandbox keys in the API's
 * env. Prints URLs but never key material.
 *
 *   node scripts/hosted-signup-live-check.mjs      (from public/v1)
 */
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const jar = new Map();
let csrf = "";
async function req(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
      ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  for (const raw of res.headers.getSetCookie?.() || []) {
    const pair = raw.split(";")[0];
    jar.set(pair.split("=")[0], pair);
    if (pair.startsWith("fm_platform_session_csrf=")) csrf = decodeURIComponent(pair.split("=")[1] || "");
  }
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

const orgId = `org_hostedlive_${suffix}`;
await req("POST", "/v1/platform/auth/register", {
  email: `hosted-live-${suffix}@example.test`, password: "correct horse battery staple",
  name: "Hosted Live Owner", company: "Hosted Live Probe Co", organization_id: orgId
});
await req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "money.merchant_processing": true } });
await req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "forward" });

const config = await req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("environment is the Forward sandbox", config.forward_environment === "sandbox", config.forward_environment);
check("provider is forward", config.merchant_config.provider === "forward");

const signup = await req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/hosted-signup`, {
  business_name: `Hosted Live Probe ${suffix}`
});
check("live draft application created", /^aapp_/.test(signup.application.id), signup.application.id);
check("live hosted link is a real aapplink URL", /getfwd\.com/.test(signup.link.url) && /aapplink_/.test(signup.link.url), signup.link.url);
check("US processing plan auto-assigned", !!signup.merchant_config.forward.processing_plan_id, signup.merchant_config.forward.processing_plan_id);
check("business persisted", /^bus_/.test(signup.merchant_config.forward.business_id), signup.merchant_config.forward.business_id);

const rerun = await req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/hosted-signup`, {});
check("rerun reuses the live application", rerun.application.id === signup.application.id);

const portal = await req("POST", `/v1/payments/organizations/${orgId}/merchant-portal/login-url`, {});
check("live merchant-portal magic link minted", /^https:\/\//.test(portal.login_url), portal.login_url.split("?")[0]);

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
console.log("hosted application link:", signup.link.url);
process.exit(passed === results.length ? 0 : 1);
