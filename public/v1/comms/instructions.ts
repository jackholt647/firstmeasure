// Comms app — published agent instructions. Imported for side effect from
// comms/api.ts.

import { registerAgentInstructions } from "../platform/agent_instructions.js";

registerAgentInstructions({
  id: "comms.hub",
  title: "Project communications",
  capability: "apps.comms",
  order: 10,
  instructions: [
    "Every customer communication (email, SMS, portal live chat) is recorded on the project's comms feed. Search it before answering questions about what was said or promised — the feed is the source of truth, not memory.",
    "Messages marked test_mode were captured in test mode: treat their content as real conversation history, but be aware no external delivery happened.",
    "Inbound customer messages notify the routed team members automatically; you do not need to notify anyone about a message they were already notified of."
  ].join("\n")
});
