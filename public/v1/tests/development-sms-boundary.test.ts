import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.FIRSTMEASURE_DATA_ENVIRONMENT = "development";
process.env.DEVELOPMENT_SMS_MODE = "allowlist";
process.env.DEVELOPMENT_SMS_ALLOWED_E164 = "+14259700671,+12068590917,+15099600721";
process.env.COMMUNICATIONS_DELIVERY_MODE = "live";
process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
process.env.WORK_SCHEDULER_DISABLED = "1";
process.env.CUSTOMER_CALL_WORKER_DISABLED = "1";

const { guardDevelopmentSms } = await import("../src/environment_safety.js");
const { sendCommunication } = await import("../messaging/communications_service.js");

test("only the three approved development numbers pass the SMS delivery guard", () => {
  for (const phone of ["+14259700671", "+12068590917", "+15099600721"]) {
    assert.equal(guardDevelopmentSms(phone).allowed, true);
  }
  assert.equal(guardDevelopmentSms("+12065550123").allowed, false);
});

test("a mixed-recipient live SMS is rejected before sender resolution or writes", async () => {
  await assert.rejects(
    sendCommunication("org_dev_sms_safety", {
      channel: "sms",
      recipients: [{ address: "2068590917" }, { address: "+12065550123" }],
      content: { text: "Development SMS safety test" }
    }),
    { code: "development_sms_recipient_blocked", statusCode: 403 }
  );
});
