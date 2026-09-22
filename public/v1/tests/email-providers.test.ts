import assert from "node:assert/strict";
import test from "node:test";

process.env.FIRSTMATE_ENV = "test";
process.env.CLOUDFLARE_EMAIL_WORKER_URL = "https://email-worker.example/outbound";
process.env.CLOUDFLARE_EMAIL_WORKER_TOKEN = "email-token";
process.env.FIRSTMATE_MAIL_DOMAIN = "firstmatemail.com";
process.env.EMAIL_DELIVERY_MODE = "test";
process.env.EMAIL_TEST_RECIPIENT_REWRITE = "false";
process.env.EMAIL_TEST_RECIPIENT_DOMAIN = "1m8.ai";

test("Cloudflare provider sends threaded mail with attachments and tenant context", async () => {
  const { createCloudflareEmailProvider } = await import("../email/providers.js");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createCloudflareEmailProvider(async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ success: true, messageId: "cf-message-1" });
  });
  const result = await provider.send({
    organization_id: "org-1",
    branch_id: "default",
    message_id: "message-1",
    rfc_message_id: "<message-1@firstmatemail.com>",
    in_reply_to: "<prior@example.com>",
    references: ["<root@example.com>", "<prior@example.com>"],
    from: { address: "info@example.com", name: "Example Company", reply_to: "support@example.com" },
    to: [{ address: "customer@example.net", type: "to" }, { address: "office@example.net", type: "cc" }],
    subject: "Project update",
    text: "The project was updated.",
    attachments: [{ name: "invoice.pdf", content_type: "application/pdf", content: Buffer.from("pdf fixture") }],
    tenant_id: "fm_org_1"
  });
  assert.equal(result.accepted, true);
  assert.equal(result.provider, "cloudflare_email");
  assert.equal(result.provider_message_id, "cf-message-1");
  assert.equal(result.recipient_rewritten, true);
  assert.equal(requests[0]?.url, "https://email-worker.example/outbound");
  assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, "Bearer email-token");
  const body = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(body.from, { email: "info@example.com", name: "Example Company" });
  assert.deepEqual(body.to, ["customer@1m8.ai"]);
  assert.deepEqual(body.cc, ["office@1m8.ai"]);
  assert.equal(body.reply_to, "support@example.com");
  assert.equal(body.headers["In-Reply-To"], "<prior@example.com>");
  assert.equal(body.headers.References, "<root@example.com> <prior@example.com>");
  assert.equal(Buffer.from(body.attachments[0].content, "base64").toString("utf8"), "pdf fixture");
});

test("Cloudflare provider fails closed when tenant context is missing", async () => {
  const { createCloudflareEmailProvider } = await import("../email/providers.js");
  const provider = createCloudflareEmailProvider(async () => { throw new Error("must not call Cloudflare"); });
  const result = await provider.send({
    organization_id: "org-1", branch_id: "default", message_id: "message-1",
    rfc_message_id: "<message-1@firstmatemail.com>", from: { address: "team@firstmatemail.com" },
    to: [{ address: "customer@1m8.ai" }], subject: "Blocked"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.error, "email_tenant_required");
});

test("platform transactional mail rejects organization sender domains before Postmark", async () => {
  const { sendPlatformTransactionalEmail } = await import("../email/outbound.js");
  const result = await sendPlatformTransactionalEmail({
    to: "account-owner@example.com",
    from: "billing@customer-domain.example",
    subject: "Account update",
    textBody: "This must not enter the platform mail lane."
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "platform_sender_domain_required");
});
