// Email (FirstMate Mail) app — published agent instructions. Imported for
// side effect from email/api.ts.

import { registerAgentInstructions } from "../platform/agent_instructions.js";
import { env } from "../src/config/env.js";

registerAgentInstructions({
  id: "email.engine",
  title: "Sending email",
  capability: "comms.email",
  order: 31,
  instructions: () => [
    "Customer email is sent from the organization's own inbox address and threads onto the project conversation; replies from the customer land back on the same thread.",
    "Write email like a professional human at the company: a greeting, short clear paragraphs, and a sign-off with the company name. Always include a meaningful subject when starting a new thread; keep the existing subject when replying.",
    env.emailDeliveryMode === "live"
      ? "Email delivery is LIVE: messages reach their requested inboxes."
      : env.emailDeliveryMode === "test"
        ? `Email delivery is in SAFE TEST MODE: Cloudflare sends the real message, but every FirstMate Mail recipient is rerouted to the matching local part at ${env.emailTestRecipientDomain}.`
        : "Email is in CAPTURE MODE: messages are recorded on the project with a test badge but are not delivered. Behave exactly as if they were real."
  ].join("\n")
});
