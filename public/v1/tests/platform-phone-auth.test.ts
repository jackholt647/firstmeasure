import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

const storageRoot = mkdtempSync(path.join(tmpdir(), "firstmeasure-phone-auth-"));
process.env.FIRSTMATE_ENV = "test";
process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
process.env.TELNYX_API_KEY = "test-telnyx-key";
process.env.TELNYX_VERIFY_PROFILE_ID = "test-profile";

test("phone identity login, uniqueness, and legacy duplicate compatibility", async (t) => {
  const originalFetch = globalThis.fetch;
  let smsStartCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const verifying = url.includes("/actions/verify");
    if (!verifying) {
      smsStartCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const data = verifying
      ? { response_code: "accepted" }
      : { id: "verify-test-1", phone_number: "+14155550101", status: "pending", timeout_secs: 300 };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const { registerPlatformApi } = await import("../platform/api.js");
  const app = Fastify({ logger: false });
  await app.register(registerPlatformApi, { prefix: "/v1/platform" });
  await app.ready();
  t.after(async () => {
    await app.close();
    globalThis.fetch = originalFetch;
    rmSync(storageRoot, { recursive: true, force: true });
  });

  async function register(email: string, phone: string) {
    return await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: { email, phone, password: "correct-horse-battery-staple", name: email }
    });
  }

  const missingPhone = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/register",
    payload: { email: "missing-phone@example.com", password: "correct-horse-battery-staple" }
  });
  assert.equal(missingPhone.statusCode, 400, missingPhone.body);
  assert.equal(missingPhone.json().error, "invalid_phone_number");

  const malformedPhone = await register("bad-phone@example.com", "555-0101");
  assert.equal(malformedPhone.statusCode, 400, malformedPhone.body);
  assert.equal(malformedPhone.json().error, "invalid_phone_number");

  const malformedLegacyPhone = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/legacy-action",
    payload: {
      action: "register",
      email: "bad-legacy-phone@example.com",
      password: "correct-horse-battery-staple",
      phone: "555-0101"
    }
  });
  assert.equal(malformedLegacyPhone.statusCode, 400, malformedLegacyPhone.body);
  assert.equal(malformedLegacyPhone.json().error, "Enter a valid ten-digit mobile phone number.");

  const organizationsPath = path.join(storageRoot, "platform", "organizations");
  const organizationsBeforeRace = existsSync(organizationsPath) ? readdirSync(organizationsPath).length : 0;
  const concurrentRegistration = () => register("registration-race@example.com", "415-555-0199");
  const concurrentResults = await Promise.all([concurrentRegistration(), concurrentRegistration()]);
  assert.deepEqual(concurrentResults.map((response) => response.statusCode).sort(), [201, 409]);
  assert.equal(
    readdirSync(organizationsPath).length,
    organizationsBeforeRace + 1,
    "concurrent registration attempts must create exactly one organization"
  );
  const raceIdentity = concurrentResults.find((response) => response.statusCode === 201)?.json().identity;
  assert.equal(raceIdentity.memberships.length, 1);

  const first = await register("phone-one@example.com", "(415) 555-0101");
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().identity.phone, "(415) 555-0101");
  const firstIdentityId = String(first.json().identity.id);
  const firstPath = path.join(storageRoot, "platform", "identities", `${firstIdentityId}.json`);

  const phoneLogin = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/login",
    payload: { identifier: "+1 415 555 0101", password: "correct-horse-battery-staple" }
  });
  assert.equal(phoneLogin.statusCode, 200, phoneLogin.body);
  assert.equal(phoneLogin.json().identity.email, "phone-one@example.com");

  const recoveryRequest = () => app.inject({
      method: "POST",
      url: "/v1/platform/auth/legacy-action",
      payload: { action: "forgot_password", delivery_channel: "phone", identifier: "4155550101" }
    });
  const [recoveryStart, concurrentRecoveryStart] = await Promise.all([recoveryRequest(), recoveryRequest()]);
  assert.equal(recoveryStart.statusCode, 200, recoveryStart.body);
  assert.equal(concurrentRecoveryStart.statusCode, 200, concurrentRecoveryStart.body);
  assert.equal(smsStartCalls, 1, "concurrent reset requests must start only one Telnyx verification");
  assert.equal(concurrentRecoveryStart.json().recovery_token, recoveryStart.json().recovery_token);
  assert.equal(recoveryStart.json().delivery_channel, "sms");
  assert.ok(recoveryStart.json().recovery_token);
  assert.equal(recoveryStart.json().email, undefined);

  const recoveryToken = String(recoveryStart.json().recovery_token);
  const recoveryVerify = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/legacy-action",
    payload: { action: "verify_otp", recovery_token: recoveryToken, otp: "123456" }
  });
  assert.equal(recoveryVerify.statusCode, 200, recoveryVerify.body);
  assert.equal(recoveryVerify.json().require_new_password, true);

  const recoveryReset = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/legacy-action",
    payload: { action: "set_new_password", recovery_token: recoveryToken, new_password: "new-correct-password" }
  });
  assert.equal(recoveryReset.statusCode, 200, recoveryReset.body);

  const resetLogin = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/login",
    payload: { identifier: "4155550101", password: "new-correct-password" }
  });
  assert.equal(resetLogin.statusCode, 200, resetLogin.body);

  const duplicate = await register("duplicate@example.com", "415-555-0101");
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(duplicate.json().error, "identity_phone_exists");

  const second = await register("phone-two@example.com", "415-555-0102");
  assert.equal(second.statusCode, 201, second.body);
  const secondIdentityId = String(second.json().identity.id);
  const secondPath = path.join(storageRoot, "platform", "identities", `${secondIdentityId}.json`);
  const legacyIdentity = JSON.parse(readFileSync(secondPath, "utf8"));
  legacyIdentity.phone = "415-555-0101";
  delete legacyIdentity.phone_normalized;
  writeFileSync(secondPath, `${JSON.stringify(legacyIdentity, null, 2)}\n`);

  const ambiguous = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/login",
    payload: { identifier: "4155550101", password: "correct-horse-battery-staple" }
  });
  assert.equal(ambiguous.statusCode, 409, ambiguous.body);
  assert.equal(ambiguous.json().error, "identity_phone_ambiguous");

  const emailLogin = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/login",
    payload: { identifier: "phone-one@example.com", password: "new-correct-password" }
  });
  assert.equal(emailLogin.statusCode, 200, emailLogin.body);

  const missingPhoneIdentity = JSON.parse(readFileSync(firstPath, "utf8"));
  missingPhoneIdentity.phone = "";
  missingPhoneIdentity.phone_normalized = "";
  writeFileSync(firstPath, `${JSON.stringify(missingPhoneIdentity, null, 2)}\n`);
  const emailLoginWithoutPhone = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/login",
    payload: { identifier: "phone-one@example.com", password: "new-correct-password" }
  });
  assert.equal(emailLoginWithoutPhone.statusCode, 200, emailLoginWithoutPhone.body);
  const legacyEmailLoginWithoutPhone = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/legacy-action",
    payload: {
      action: "login",
      identifier: "phone-one@example.com",
      password: "new-correct-password"
    }
  });
  assert.equal(legacyEmailLoginWithoutPhone.statusCode, 200, legacyEmailLoginWithoutPhone.body);
  assert.equal(legacyEmailLoginWithoutPhone.json().success, true);

  const invalidPhoneIdentity = JSON.parse(readFileSync(firstPath, "utf8"));
  invalidPhoneIdentity.phone = "legacy-invalid-phone";
  delete invalidPhoneIdentity.phone_normalized;
  writeFileSync(firstPath, `${JSON.stringify(invalidPhoneIdentity, null, 2)}\n`);
  const emailLoginWithInvalidStoredPhone = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/login",
    payload: { identifier: "phone-one@example.com", password: "new-correct-password" }
  });
  assert.equal(emailLoginWithInvalidStoredPhone.statusCode, 200, emailLoginWithInvalidStoredPhone.body);
  const legacyEmailLoginWithInvalidStoredPhone = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/legacy-action",
    payload: {
      action: "login",
      identifier: "phone-one@example.com",
      password: "new-correct-password"
    }
  });
  assert.equal(legacyEmailLoginWithInvalidStoredPhone.statusCode, 200, legacyEmailLoginWithInvalidStoredPhone.body);
  assert.equal(legacyEmailLoginWithInvalidStoredPhone.json().success, true);
  const preservedInvalidPhoneIdentity = JSON.parse(readFileSync(firstPath, "utf8"));
  assert.equal(preservedInvalidPhoneIdentity.phone, "legacy-invalid-phone");
});
