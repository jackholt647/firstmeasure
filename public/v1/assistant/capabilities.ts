import { registerCapabilities } from "../platform/capabilities.js";

/**
 * Global AI assistant capability nodes. Imported for side effect from
 * assistant/api.ts so the registry, settings UI, and presets pick them up
 * before the API boots.
 */
registerCapabilities([
  {
    key: "apps.assistant",
    kind: "app",
    category: "Platform & Appearance",
    label: "AI Assistant",
    description: "The company-wide AI assistant in the top bar: answers questions, looks up projects and customers, runs stats, and takes action across the platform.",
    catalog_stub: "AI answers and actions across FirstMate.",
    default: true,
    runtime_app_id: "assistant"
  },
  {
    key: "assistant.actions",
    kind: "feature",
    parent: "apps.assistant",
    label: "Assistant Actions",
    description: "Let the assistant take action: create and complete to-dos, move pipeline stages, schedule project events, and fire automation events.",
    default: true
  },
  {
    key: "assistant.messaging",
    kind: "feature",
    parent: "apps.assistant",
    label: "Assistant Customer Messaging",
    description: "Let the assistant send SMS and email to customers on your behalf (always confirmed in the conversation first).",
    default: false
  },
  {
    key: "permission.use_assistant",
    kind: "permission",
    parent: "apps.assistant",
    permission_key: "use_assistant",
    access: "read",
    label: "Use AI Assistant",
    description: "Open the assistant and chat with it."
  }
]);
