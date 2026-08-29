import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.PLATFORM_SESSION_COOKIE_NAME = "fm_platform_session_test";
process.env.PLATFORM_SESSION_SECRET = "shared-cookie-test-secret-at-least-32-characters";

const { platformSessionIdFromRequest } = await import("../platform/auth.js");

function signedSession(sessionId: string) {
  const signature = createHmac("sha256", process.env.PLATFORM_SESSION_SECRET!)
    .update(sessionId)
    .digest("base64url");
  return `${sessionId}.${signature}`;
}

function requestWithCookie(cookie: string) {
  return { headers: { cookie } } as Parameters<typeof platformSessionIdFromRequest>[0];
}

test("platform auth accepts a valid host cookie before an invalid duplicate", () => {
  const valid = signedSession("development-session");
  const request = requestWithCookie(`fm_platform_session_test=${valid}; fm_platform_session_test=stale.invalid`);
  assert.equal(platformSessionIdFromRequest(request), "development-session");
});

test("platform auth accepts a valid host cookie after an invalid duplicate", () => {
  const valid = signedSession("development-session");
  const request = requestWithCookie(`fm_platform_session_test=stale.invalid; fm_platform_session_test=${valid}`);
  assert.equal(platformSessionIdFromRequest(request), "development-session");
});

test("platform auth rejects duplicate cookies when none has a valid signature", () => {
  const request = requestWithCookie("fm_platform_session_test=first.invalid; fm_platform_session_test=second.invalid");
  assert.equal(platformSessionIdFromRequest(request), null);
});
