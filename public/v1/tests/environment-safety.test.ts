import assert from "node:assert/strict";
import test from "node:test";

process.env.FIRSTMEASURE_DATA_ENVIRONMENT = "development";
process.env.DEPLOYMENT_TOPOLOGY = "cluster";
process.env.CLUSTER_NODE_ROLE = "web";
process.env.PLATFORM_SESSION_COOKIE_NAME = "fm_platform_session_development";
process.env.STRIPE_TEST_MODE = "true";
process.env.STRIPE_TEST_SECRET_KEY = "sk_test_example";
delete process.env.STRIPE_LIVE_SECRET_KEY;
process.env.STRIPE_BASE_URL = "https://dev.1m8.ai/portal";
process.env.DEVELOPMENT_EMAIL_MODE = "rewrite";
process.env.DEVELOPMENT_EMAIL_ALLOWED_DOMAINS = "1m8.ai";
process.env.DEVELOPMENT_EMAIL_CATCHALL = "dev-catchall@1m8.ai";
process.env.DEVELOPMENT_SMS_MODE = "allowlist";
process.env.DEVELOPMENT_SMS_ALLOWED_E164 = "+13035550101";

const {
  guardDevelopmentEmail,
  guardDevelopmentSms,
  inspectEnvironmentSafety
} = await import("../src/environment_safety.js");

test("development environment safety accepts an isolated sandbox configuration", () => {
  const report = inspectEnvironmentSafety();
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.enforced, true);
  assert.equal(report.stripe.mode, "test");
  assert.equal(report.checks.isolated_session_cookie, true);
});

test("development email guard preserves internal recipients and rewrites external recipients", () => {
  const internal = guardDevelopmentEmail({ recipients: ["qa@1m8.ai"], subject: "QA result" });
  assert.equal(internal.allowed, true);
  assert.equal(internal.rewritten, false);
  assert.deepEqual(internal.recipients, ["qa@1m8.ai"]);

  const external = guardDevelopmentEmail({ recipients: ["customer@example.com"], subject: "QA result" });
  assert.equal(external.allowed, true);
  assert.equal(external.rewritten, true);
  assert.deepEqual(external.recipients, ["dev-catchall@1m8.ai"]);
  assert.match(external.subject, /customer@example\.com/);
});

test("development SMS guard permits only explicitly allowlisted numbers", () => {
  assert.equal(guardDevelopmentSms("+13035550101").allowed, true);
  assert.equal(guardDevelopmentSms("+13035550102").allowed, false);
});
