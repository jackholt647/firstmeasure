// Per-branch assistant settings, stored as the `assistant_settings` branch
// module (same idiom as live chat settings). The capability registry decides
// whether the assistant exists at all; these settings shape how it behaves.

import { readBranchModule, saveBranchModule } from "../platform/storage.js";
import { readAssistantOrganizationInstructions, saveAssistantOrganizationInstructions } from "./personalization.js";

export type AssistantSettings = {
  enabled: boolean;
  assistant_name: string;
  custom_instructions: string;
  allow_actions: boolean;
  allow_notes: boolean;
  allow_messaging: boolean;
  data_scope: {
    projects: boolean;
    contacts: boolean;
    stats: boolean;
    documents: boolean;
    schedule: boolean;
    activity: boolean;
  };
};

const ASSISTANT_MODULE_ID = "assistant_settings";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asBoolean(value: unknown, fallback: boolean) {
  if (value === true || value === false) return value;
  return fallback;
}

export function defaultAssistantSettings(): AssistantSettings {
  return {
    enabled: true,
    assistant_name: "FirstMate Assistant",
    custom_instructions: "",
    allow_actions: true,
    allow_notes: true,
    allow_messaging: false,
    data_scope: {
      projects: true,
      contacts: true,
      stats: true,
      documents: true,
      schedule: true,
      activity: true
    }
  };
}

export function normalizeAssistantSettings(value: unknown): AssistantSettings {
  const defaults = defaultAssistantSettings();
  const raw = asObject(value);
  const scope = asObject(raw.data_scope);
  return {
    enabled: asBoolean(raw.enabled, defaults.enabled),
    assistant_name: cleanText(raw.assistant_name).slice(0, 80) || defaults.assistant_name,
    custom_instructions: String(raw.custom_instructions ?? "").slice(0, 4_000),
    allow_actions: asBoolean(raw.allow_actions, defaults.allow_actions),
    allow_notes: asBoolean(raw.allow_notes, defaults.allow_notes),
    allow_messaging: asBoolean(raw.allow_messaging, defaults.allow_messaging),
    data_scope: {
      projects: asBoolean(scope.projects, defaults.data_scope.projects),
      contacts: asBoolean(scope.contacts, defaults.data_scope.contacts),
      stats: asBoolean(scope.stats, defaults.data_scope.stats),
      documents: asBoolean(scope.documents, defaults.data_scope.documents),
      schedule: asBoolean(scope.schedule, defaults.data_scope.schedule),
      activity: asBoolean(scope.activity, defaults.data_scope.activity)
    }
  };
}

export async function loadAssistantSettings(orgId: string, branchId: string): Promise<AssistantSettings> {
  let branchSettings = defaultAssistantSettings();
  try {
    const doc = await readBranchModule(orgId, branchId || "default", ASSISTANT_MODULE_ID);
    branchSettings = normalizeAssistantSettings(asObject(doc).data);
  } catch {}
  const organizationInstructions = await readAssistantOrganizationInstructions(orgId);
  return { ...branchSettings, custom_instructions: organizationInstructions ?? branchSettings.custom_instructions };
}

export async function saveAssistantSettings(orgId: string, branchId: string, value: unknown): Promise<AssistantSettings> {
  const settings = normalizeAssistantSettings(value);
  await saveBranchModule(orgId, branchId || "default", ASSISTANT_MODULE_ID, {
    data: settings,
    metadata: { kind: "assistant_settings", source: "assistant_api" }
  }, { replace: true });
  await saveAssistantOrganizationInstructions(orgId, settings.custom_instructions);
  return settings;
}
