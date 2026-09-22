/**
 * LIVE Forward sandbox validation harness.
 *
 * !!! REQUIRES REAL SANDBOX KEYS in public/v1/.env (FORWARD_API_BASE,
 * !!! FORWARD_PRIVATE_KEY). MAKES REAL API CALLS against the Forward
 * !!! sandbox (api.sandbox.getfwd.com) on the FirstMate partner account.
 *
 * Exercises the boarding adapter (processing plans, business, application
 * create/get/update/submit) and — when an approved merchant account exists —
 * the payments adapter (PMI, intent, charge with documented test cards,
 * refund, payouts/balances/transactions/disputes reads). Never prints key
 * material: all console output is scrubbed against the loaded secrets.
 *
 *   node --import tsx scripts/forward-sandbox-e2e.mjs [phase...]
 *
 * Phases: probe plans business application payments errors   (default: all)
 * Run from public/v1. Creates at most ONE business + ONE application per run;
 * pass FORWARD_E2E_REUSE_APP=app_... to iterate on an existing application.
 */
import { readFileSync } from "node:fs";

// --- output scrubbing: never let key material escape -------------------------
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const secrets = [];
for (const line of envText.split(/\r?\n/)) {
  const match = /^(FORWARD_PRIVATE_KEY|FORWARD_PUBLIC_KEY|FORWARD_WEBHOOK_SECRET|TELNYX_API_KEY|OPENAI_API_KEY)=(.*)$/.exec(line.trim());
  if (match && match[2].trim().length > 6) secrets.push(match[2].trim());
}
function scrub(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}
const rawLog = console.log.bind(console);
console.log = (...args) => rawLog(...args.map((a) => typeof a === "string" ? scrub(a) : scrub(JSON.stringify(a, null, 2))));

const { fileURLToPath } = await import("node:url");
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const { createForwardAdapter, createForwardBoardingAdapter, ForwardApiError } =
  await import("../payments/providers/forward.ts");
const { env } = await import("../src/config/env.ts");

if (!env.forwardApiBase || !env.forwardPrivateKey) {
  console.log("FORWARD_API_BASE / FORWARD_PRIVATE_KEY missing — aborting (this harness requires real sandbox keys).");
  process.exit(1);
}
console.log(`Forward sandbox base: ${env.forwardApiBase}`);

const phases = process.argv.slice(2).length ? process.argv.slice(2) : ["probe", "plans", "business", "application", "payments", "errors"];
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + scrub(JSON.stringify(detail))}`);
};

// Raw client (for envelope truth-checks independent of the adapter mappers).
async function raw(method, path, body, accountId) {
  const res = await fetch(`${env.forwardApiBase}${path}`, {
    method,
    headers: {
      "x-api-key": env.forwardPrivateKey,
      Accept: "application/json",
      ...(accountId ? { "x-account-id": accountId } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-idempotency-key": `fmprobe_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw_text: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const boarding = createForwardBoardingAdapter();
const state = { businessId: "", applicationId: process.env.FORWARD_E2E_REUSE_APP || "", accountId: "", planId: "" };

// --- phase: probe — current partner-level state ------------------------------
if (phases.includes("probe")) {
  console.log("\n=== PHASE probe: partner-level state ===");
  for (const path of ["/processing_plans", "/businesses", "/applications", "/accounts"]) {
    const { status, json } = await raw("GET", path);
    console.log(`GET ${path} -> ${status}`);
    console.log(json);
  }
}

// --- phase: plans — adapter listProcessingPlans ------------------------------
if (phases.includes("plans")) {
  console.log("\n=== PHASE plans: adapter listProcessingPlans ===");
  try {
    const plans = await boarding.listProcessingPlans();
    check("plans: at least one plan returned", plans.length >= 1, plans.length);
    check("plans: mapper resolves id (partppl_...)", plans.every((p) => /^partppl_/.test(p.id)), plans.map((p) => p.id));
    check("plans: mapper resolves name", plans.every((p) => p.name.length > 0), plans.map((p) => p.name));
    state.planId = plans.find((p) => /US/i.test(p.name))?.id || plans[0]?.id || "";
    console.log("selected plan:", state.planId);
  } catch (error) {
    check("plans: listProcessingPlans threw", false, describeError(error));
  }
}

// --- phase: business — adapter createBusiness --------------------------------
if (phases.includes("business")) {
  console.log("\n=== PHASE business: adapter createBusiness ===");
  try {
    const business = await boarding.createBusiness({
      name: "FM Sandbox Test Co",
      email: "sandbox-boarding@firstmate.test",
      phone: "2065550123"
    });
    check("business: id resolved by mapper", business.id.length > 0, business.id);
    state.businessId = business.id;
    console.log("business raw:", business.raw);
  } catch (error) {
    check("business: createBusiness threw", false, describeError(error));
  }
}

// --- phase: application ------------------------------------------------------
// Obviously-fake but schema-valid application data (sandbox only).
const APPLICATION_INPUT = {
  name: "FM Sandbox Test Co",
  external_account_id: "org_fm_sandbox_e2e",
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
    email: "sandbox-boarding@firstmate.test",
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
    title: "MEMBER",
    signer: true,
    address: { address1: "601 Test Harness Way", city: "Seattle", state: "WA", postal_code: "98101", country: "US" }
  }],
  volumes: { annual_volume: 250000, avg_ticket: 8000, high_ticket: 25000, card_present_percent: 70 },
  user_fields: { firstmate_org_id: "org_fm_sandbox_e2e", harness: "forward-sandbox-e2e" }
};

if (phases.includes("application")) {
  console.log("\n=== PHASE application: create/get/update/submit ===");
  if (!state.planId) {
    const plans = await boarding.listProcessingPlans().catch(() => []);
    state.planId = plans.find((p) => /US/i.test(p.name))?.id || plans[0]?.id || "";
  }
  if (!state.businessId && !state.applicationId) {
    const { json } = await raw("GET", "/businesses");
    const list = Array.isArray(json?.data) ? json.data : [];
    state.businessId = list.find((b) => (b.name || "") === "FM Sandbox Test Co")?.business_id || list[0]?.business_id || "";
    console.log("reusing business:", state.businessId || "(none found)");
  }
  try {
    if (!state.applicationId) {
      const application = await boarding.createApplication({
        ...APPLICATION_INPUT,
        business_id: state.businessId,
        processing_plan_id: state.planId
      });
      check("application: id resolved by mapper", application.id.length > 0, application.id);
      check("application: status mapped", application.status.length > 0, application.status);
      state.applicationId = application.id;
      console.log("application raw:", application.raw);
    }
    const fetched = await boarding.getApplication(state.applicationId);
    check("application: getApplication round-trips id", fetched.id === state.applicationId, fetched.id);
    console.log("get status:", fetched.status);
    const updated = await boarding.updateApplication(state.applicationId, {
      ...APPLICATION_INPUT,
      business_id: fetched.business_id || state.businessId,
      processing_plan_id: state.planId,
      user_fields: { ...APPLICATION_INPUT.user_fields, updated: "yes" }
    });
    check("application: updateApplication succeeds", updated.id === state.applicationId, updated.status);
    try {
      const submitted = await boarding.submitApplication(state.applicationId);
      check("application: submitApplication succeeds", submitted.id === state.applicationId, submitted.status);
      console.log("post-submit status:", submitted.status);
    } catch (error) {
      const message = String(error?.message || "");
      if (/not enabled for your integration/i.test(message)) {
        check("application: API submit blocked by partner capability (KNOWN — ask rep to enable API submission)", true, message);
      } else {
        throw error;
      }
    }
  } catch (error) {
    check("application: lifecycle threw", false, describeError(error));
  }
}

// --- phase: submitprobe — discover how DRAFT -> UNDER_REVIEW happens ---------
if (phases.includes("submitprobe") && state.applicationId) {
  console.log("\n=== PHASE submitprobe: submission mechanics on", state.applicationId, "===");
  const current = await raw("GET", `/applications/${state.applicationId}`);
  console.log(`GET application -> ${current.status}; keys: ${Object.keys(current.json || {}).join(", ")}`);
  console.log("status:", current.json?.status, "terms_accepted:", current.json?.terms_accepted);
  const base = current.json || {};
  // 1. PUT with status: UNDER_REVIEW
  const putStatus = await raw("PUT", `/applications/${state.applicationId}`, { ...base, status: "UNDER_REVIEW" });
  console.log(`PUT status=UNDER_REVIEW -> ${putStatus.status}; resulting status: ${putStatus.json?.status}`);
  if (putStatus.status >= 400) console.log(putStatus.json);
  // 2. PUT with terms_accepted: true
  const putTerms = await raw("PUT", `/applications/${state.applicationId}`, { ...base, terms_accepted: true });
  console.log(`PUT terms_accepted=true -> ${putTerms.status}; status: ${putTerms.json?.status}; terms_accepted: ${putTerms.json?.terms_accepted}`);
  if (putTerms.status >= 400) console.log(putTerms.json);
  // 3. POST /applications/{id}/link (documented) — what does it return?
  const link = await raw("POST", `/applications/${state.applicationId}/link`, {});
  console.log(`POST /link -> ${link.status}`);
  console.log(link.json);
  const after = await raw("GET", `/applications/${state.applicationId}`);
  console.log("final status:", after.json?.status, "terms_accepted:", after.json?.terms_accepted);
  // 4. Endpoint existence sweep (404 "Missing Authentication Token" = no route).
  for (const [method, path] of [
    ["POST", `/applications/${state.applicationId}/submit`],
    ["PUT", `/applications/${state.applicationId}/submit`],
    ["POST", `/applications/${state.applicationId}/submissions`],
    ["POST", `/applications/${state.applicationId}/submission`],
    ["POST", `/applications/${state.applicationId}/status`],
    ["PATCH", `/applications/${state.applicationId}`]
  ]) {
    const probe = await raw(method, path, method === "PATCH" ? { status: "UNDER_REVIEW" } : {});
    console.log(`${method} ${path.replace(state.applicationId, "{id}")} -> ${probe.status} ${JSON.stringify(probe.json)?.slice(0, 220)}`);
  }
}

// --- phase: payments — only with an approved account -------------------------
if (phases.includes("payments")) {
  console.log("\n=== PHASE payments: charge-side (requires an approved account) ===");
  const { json } = await raw("GET", "/accounts");
  const accounts = Array.isArray(json?.data) ? json.data : [];
  console.log(`accounts visible: ${accounts.length}`);
  const usable = accounts.find((a) => a.processing_enabled === true) || accounts[0];
  if (!usable) {
    console.log("SKIP payments phase: no merchant account exists yet (underwriting pending). Clean skip.");
  } else {
    state.accountId = usable.account_id || usable.id || "";
    console.log("using account:", state.accountId, "processing_enabled:", usable.processing_enabled);
    const payments = createForwardAdapter({ accountId: state.accountId });
    try {
      // PMI with a documented sandbox success card (4242...).
      const pmi = await payments.createPaymentMethodIntent({
        type: "card",
        card: { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123", name: "Testy McTestface", zip: "98101" },
        billing_details: { name: "Testy McTestface", address: { postal_code: "98101", country: "US" } }
      });
      check("payments: PMI created", pmi.id.length > 0, { id: pmi.id, status: pmi.status });
      console.log("pmi raw:", pmi.raw);
      const token = pmi.payment_method_id;
      check("payments: PMI yields payment_method_id", token.length > 0, token);
      if (token) {
        const method = await payments.getPaymentMethod(token);
        check("payments: getPaymentMethod maps brand/last4", method.last4 === "4242", { brand: method.brand, last4: method.last4 });
        const intent = await payments.createPaymentIntent({ amount_cents: 1000, reference_id: `fm_e2e_${Date.now().toString(36)}`, user_fields: { harness: "forward-sandbox-e2e" } });
        check("payments: intent created", intent.id.length > 0 && intent.amount_cents === 1000, { id: intent.id, status: intent.status });
        const charge = await payments.createPayment(intent.id, { payment_method_id: token });
        check("payments: charge captured", ["captured", "settled", "authorized"].includes(charge.status), { id: charge.id, status: charge.status, auth: charge.auth_code });
        console.log("charge raw:", charge.raw);
        const refund = await payments.createRefund(intent.id, { amount_cents: 400 });
        check("payments: partial refund created", refund.id.length > 0, { id: refund.id, status: refund.status, amount: refund.amount_cents });
        console.log("refund raw:", refund.raw);
        // Decline card check.
        try {
          const declinePmi = await payments.createPaymentMethodIntent({
            type: "card",
            card: { number: "4867094332104873", exp_month: 12, exp_year: 2030, cvc: "123", name: "Testy McTestface", zip: "98101" }
          });
          if (declinePmi.payment_method_id) {
            const declineIntent = await payments.createPaymentIntent({ amount_cents: 1500 });
            const declineCharge = await payments.createPayment(declineIntent.id, { payment_method_id: declinePmi.payment_method_id })
              .catch((e) => ({ status: "failed", decline_reason: describeError(e), raw: {} }));
            check("payments: decline card declines", declineCharge.status === "failed" || !!declineCharge.decline_reason, { status: declineCharge.status, decline: declineCharge.decline_reason });
            console.log("decline raw:", declineCharge.raw);
          } else {
            console.log("decline PMI produced no token:", declinePmi.raw);
          }
        } catch (error) {
          console.log("decline-card flow error:", describeError(error));
        }
      }
      const balances = await payments.getBalances().catch((e) => { console.log("balances error:", describeError(e)); return null; });
      if (balances) check("payments: balances listed", Array.isArray(balances), balances);
      const payouts = await payments.listPayouts().catch((e) => { console.log("payouts error:", describeError(e)); return null; });
      if (payouts) check("payments: payouts listed", Array.isArray(payouts), payouts.length);
      const disputes = await payments.listDisputes().catch((e) => { console.log("disputes error:", describeError(e)); return null; });
      if (disputes) check("payments: disputes listed", Array.isArray(disputes), disputes.length);
      const tx = await raw("GET", "/transactions", undefined, state.accountId);
      console.log(`GET /transactions -> ${tx.status}`);
      console.log(tx.json);
    } catch (error) {
      check("payments: phase threw", false, describeError(error));
    }
  }
}

// --- phase: errors — ForwardApiError shapes on 401/403/404 -------------------
if (phases.includes("errors")) {
  console.log("\n=== PHASE errors: error-shape verification ===");
  const noAccount = createForwardAdapter();
  try {
    await noAccount.getPayment("pay_does_not_exist");
    check("errors: payment read without x-account-id should throw", false);
  } catch (error) {
    // LIVE: payments-side reads REQUIRE x-account-id (400 WRONG_ARGUMENTS).
    const ok = error instanceof ForwardApiError && error.status === 400;
    check("errors: payment read without x-account-id throws 400", ok, describeError(error));
  }
  const fakeAccount = createForwardAdapter({ accountId: "acc_fake_for_error_shape" });
  try {
    await fakeAccount.getPayment("pay_does_not_exist");
    check("errors: missing payment should throw", false);
  } catch (error) {
    const ok = error instanceof ForwardApiError && [400, 401, 403, 404].includes(error.status);
    check("errors: missing payment throws ForwardApiError 4xx", ok, describeError(error));
  }
  const bad = createForwardAdapter({ privateKey: "sk_invalid_key_for_error_shape_check", accountId: "acc_fake_for_error_shape" });
  try {
    await bad.getPayment("pay_does_not_exist");
    check("errors: invalid key should throw", false);
  } catch (error) {
    const ok = error instanceof ForwardApiError && [401, 403, 404].includes(error.status);
    check("errors: invalid key throws ForwardApiError auth error", ok, describeError(error));
  }
}

function describeError(error) {
  if (error instanceof ForwardApiError) return { name: "ForwardApiError", status: error.status, body: error.body, message: error.message };
  return { name: error?.name, message: String(error?.message || error).slice(0, 400) };
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log("state:", state);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exitCode = 1; }
