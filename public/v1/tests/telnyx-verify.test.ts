import assert from "node:assert/strict";
import test from "node:test";

import { maskPhoneNumber, normalizeE164Phone, TelnyxVerifyClient } from "../sms/telnyx_verify.js";

test("normalizes supported phone formats without guessing ambiguous numbers", () => {
  assert.equal(normalizeE164Phone("(303) 555-1212"), "+13035551212");
  assert.equal(normalizeE164Phone("1-303-555-1212"), "+13035551212");
  assert.equal(normalizeE164Phone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizeE164Phone("555-1212"), "");
  assert.equal(maskPhoneNumber("+1 303 555 1212"), "phone ending in 1212");
});

test("starts and checks a Telnyx SMS verification without exposing credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/verifications/sms")) {
      return new Response(JSON.stringify({
        data: { id: "verify-1", phone_number: "+13035551212", status: "pending", timeout_secs: 300 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { response_code: "accepted" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const client = new TelnyxVerifyClient({
    apiKey: "test-key",
    profileId: "profile-1",
    baseUrl: "https://example.test/v2/",
    fetchImpl: fetchImpl as typeof fetch
  });

  const started = await client.startSms("303-555-1212");
  assert.equal(started.status, "pending");
  assert.equal(await client.verifySms("303-555-1212", "123456"), "accepted");
  assert.equal(requests[0]?.url, "https://example.test/v2/verifications/sms");
  assert.equal(requests[1]?.url, "https://example.test/v2/verifications/by_phone_number/%2B13035551212/actions/verify");
  assert.equal(new Headers(requests[0]?.init?.headers).get("Authorization"), "Bearer test-key");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    phone_number: "+13035551212",
    verify_profile_id: "profile-1"
  });
});

test("rejects malformed OTPs locally", async () => {
  const client = new TelnyxVerifyClient({
    apiKey: "test-key",
    profileId: "profile-1",
    fetchImpl: (() => { throw new Error("fetch should not run"); }) as typeof fetch
  });
  assert.equal(await client.verifySms("303-555-1212", "abc"), "rejected");
});
