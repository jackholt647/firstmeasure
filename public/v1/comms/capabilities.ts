import { registerCapabilities } from "../platform/capabilities.js";

/**
 * Project Comms capability nodes. Imported for side effect from comms/api.ts
 * so the registry, settings UI, and presets pick them up before the API boots.
 */
registerCapabilities([
  {
    key: "apps.comms",
    kind: "app",
    category: "Communications",
    label: "Project Comms",
    description: "The per-project communications hub: email, SMS, and portal chat in one tab with search and an AI agent.",
    catalog_stub: "Project email, texts, and portal chat.",
    default: true,
    runtime_app_id: "project.comms"
  },
  {
    key: "comms.email",
    kind: "feature",
    parent: "apps.comms",
    label: "Email Inbox",
    description: "The organization's FirstMate Mail inbox: send and receive customer email on projects.",
    default: true
  },
  {
    key: "comms.sms",
    kind: "feature",
    parent: "apps.comms",
    label: "Text Messages",
    description: "Send and receive customer SMS conversations on projects.",
    default: true
  },
  {
    key: "comms.portal_chat",
    kind: "feature",
    parent: "apps.comms",
    requires: ["apps.live_chat"],
    label: "Portal Chat",
    description: "Customer portal live chat conversations surfaced on the project with inline replies.",
    default: true
  },
  {
    key: "comms.search",
    kind: "feature",
    parent: "apps.comms",
    label: "Comms Search",
    description: "Full-text search across every communication channel.",
    default: true
  },
  {
    key: "comms.agent",
    kind: "feature",
    parent: "apps.comms",
    label: "Comms AI Agent",
    description: "The communications AI: answers questions across all channels and can draft or send replies.",
    default: true
  },
  {
    key: "comms.auto_response",
    kind: "feature",
    parent: "comms.agent",
    label: "AI Auto-Response",
    description: "Let the comms AI automatically draft (or send) replies to inbound customer email and SMS.",
    default: false
  },
  {
    key: "permission.view_comms",
    kind: "permission",
    parent: "apps.comms",
    permission_key: "view_comms",
    access: "read",
    label: "View Comms",
    description: "See the project comms tab and read conversations across channels."
  },
  {
    key: "permission.send_comms",
    kind: "permission",
    parent: "apps.comms",
    permission_key: "send_comms",
    access: "write",
    label: "Send Comms",
    description: "Send customer email and SMS from the project comms tab."
  }
]);
