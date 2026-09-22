import { registerCapabilities } from "../platform/capabilities.js";

/**
 * Live chat capability nodes. Imported for side effect from chat/api.ts so the
 * registry, settings UI, and presets pick them up before the API boots.
 */
registerCapabilities([
  {
    key: "apps.live_chat",
    kind: "app",
    category: "Sales & Customers",
    label: "Live Chat",
    description: "Embeddable website live chat, the team chat inbox, and the customer portal chat.",
    catalog_stub: "Website chat and customer conversations.",
    default: false,
    runtime_app_id: "chat"
  },
  {
    key: "live_chat.ai_agent",
    kind: "feature",
    parent: "apps.live_chat",
    label: "Chat AI Agent",
    description: "The AI assistant that can front live chat conversations, capture leads, and hand off to the team.",
    default: false
  },
  {
    key: "live_chat.suggested_responses",
    kind: "feature",
    parent: "live_chat.ai_agent",
    label: "Suggested Responses",
    description: "AI-drafted reply suggestions and composer cleanup inside the team chat inbox.",
    default: true
  },
  {
    key: "permission.view_live_chat",
    kind: "permission",
    parent: "apps.live_chat",
    permission_key: "view_live_chat",
    access: "read",
    label: "View Live Chat",
    description: "See the chat inbox and read conversations."
  },
  {
    key: "permission.send_live_chat",
    kind: "permission",
    parent: "apps.live_chat",
    permission_key: "send_live_chat",
    access: "write",
    label: "Send Live Chat",
    description: "Reply to visitors, claim conversations, and close chats."
  }
]);
