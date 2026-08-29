import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

process.env.PLATFORM_SESSION_COOKIE_NAME = "fm_platform_session_test";
process.env.PLATFORM_SESSION_SECRET = "shared-cookie-test-secret-at-least-32-characters";

const {
  platformSessionIdFromRequest,
  platformSessionIdsFromRequest,
  selectNewestPlatformSessionCandidate
} = await import("../platform/auth.js");

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

test("platform auth preserves every distinct correctly signed duplicate", () => {
  const older = signedSession("production-session");
  const newer = signedSession("development-session");
  const request = requestWithCookie(`fm_platform_session_test=${older}; fm_platform_session_test=${newer}`);
  assert.deepEqual(platformSessionIdsFromRequest(request), ["production-session", "development-session"]);
});

test("platform auth selects the newest active duplicate by creation time", () => {
  const selected = selectNewestPlatformSessionCandidate([
    { sessionId: "production-session", session: { created_at: "2026-08-01T00:00:00.000Z" } },
    { sessionId: "development-session", session: { created_at: "2026-08-29T20:00:00.000Z" } }
  ]);
  assert.equal(selected?.sessionId, "development-session");
});
