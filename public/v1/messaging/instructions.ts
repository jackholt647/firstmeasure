// Messaging (SMS) app — published agent instructions. Imported for side
// effect from messaging/api.ts.

import { registerAgentInstructions } from "../platform/agent_instructions.js";
import { env } from "../src/config/env.js";

registerAgentInstructions({
  id: "messaging.sms",
  title: "Sending SMS",
  capability: "comms.sms",
  order: 30,
  instructions: () => [
    "Customer SMS is sent from the organization's registered business number and recorded on the project conversation.",
    "Keep SMS short (under 320 characters when possible), plain text, and conversational. Never send marketing content in a customer-care reply.",
    "Customers can reply STOP to opt out; if a customer has opted out, do not attempt to text them — use email instead and say why.",
    env.communicationsDeliveryMode === "live"
      ? "SMS delivery is LIVE: messages reach real phones."
      : "SMS is in TEST MODE: messages are recorded on the project as if sent (with a test badge) but do not reach real phones. Behave exactly as if they were real."
  ].join("\n")
});
