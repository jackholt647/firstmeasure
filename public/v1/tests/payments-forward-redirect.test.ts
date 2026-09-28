import assert from "node:assert/strict";
import test from "node:test";

import { createForwardBoardingAdapter } from "../payments/providers/forward.js";

test("Forward application redirect is sent under partner_data and survives full-replace updates", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const current = {
    application_id: "appl_test",
    status: "DRAFT",
    business_id: "biz_test",
    name: "Test merchant",
    company: { legal_name: "Test LLC" },
    partner_processing_plan_id: "plan_test",
    partner_data: { paid_subscription: true, redirect_url: "https://old.example.test/" }
  };
  globalThis.fetch = async (input, init) => {
    const request = { method: init?.method || "GET", path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : {} };
    requests.push(request);
    if (request.method === "GET") return Response.json(current);
    if (request.path.endsWith("/link")) return Response.json({ link_id: "aapplink_test", uri: "https://application.sandbox.getfwd.com/aapplink_test", expiration_date: "2026-10-01T00:00:00Z" });
    return Response.json({ ...current, ...request.body });
  };
  try {
    const adapter = createForwardBoardingAdapter({ apiBase: "https://api.example.test", privateKey: "test-key" });
    const redirectUrl = "https://app.example.test/portal/payments-setup-complete.html";
    await adapter.createApplication({ business_id: "biz_test", name: "Test merchant", partner_data: { redirect_url: redirectUrl } });
    assert.deepEqual(requests[0]?.body.partner_data, { redirect_url: redirectUrl });

    await adapter.updateApplication("appl_test", { partner_data: { redirect_url: redirectUrl } });
    const update = requests.find((request) => request.method === "PUT");
    assert.deepEqual(update?.body.partner_data, { paid_subscription: true, redirect_url: redirectUrl });
    assert.deepEqual(update?.body.company, current.company);
    assert.equal(update?.body.processing_plan_id, "plan_test");

    await adapter.generateApplicationLink("appl_test");
    assert.deepEqual(requests.at(-1)?.body, {}, "the link call does not carry the redirect");

    current.status = "NEW_POST_SUBMISSION_STATUS";
    assert.equal((await adapter.getApplication("appl_test")).status, "UNDER_REVIEW", "unknown statuses cannot become editable drafts");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
