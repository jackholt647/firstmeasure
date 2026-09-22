// Comms settings: branch-level defaults (the `comms_settings` branch module,
// same idiom as assistant/live-chat settings) plus per-project overrides that
// live in `project.data.comms`. The capability registry decides whether comms
// features exist at all; these settings shape behavior inside them.

import { readBranchModule, saveBranchModule } from "../platform/storage.js";
import { readDocument } from "../platform/storage.js";
import { patchProjectDocument } from "../work/automations/builtins.js";

export type CommsNotificationSettings = {
  enabled: boolean;
  target_role_ids: string[];
  target_user_ids: string[];
};

export type CommsAgentSettings = {
  enabled: boolean;
  agent_name: string;
  custom_instructions: string;
  allow_send: boolean;
  allow_scheduling: boolean;
  allow_availability_read: boolean;
  allow_rescheduling: boolean;
  auto_response: {
    enabled: boolean;
    mode: "draft" | "send";
    channels: { email: boolean; sms: boolean };
  };
};

export type CommsSettings = {
  notifications: CommsNotificationSettings;
  agent: CommsAgentSettings;
  email_forwarding: {
    enabled: boolean;
    fallback_email: string;
  };
  voice: {
    sms: "attachment" | "dictation" | "off";
    email: "attachment" | "dictation" | "off";
  };
};

export type ProjectCommsOverrides = {
  notifications: Partial<CommsNotificationSettings> & { inherit?: boolean };
  agent_instructions: string;
  auto_response: "inherit" | "off" | "draft" | "send";
  email_forwarding: Record<string, unknown>;
};

const COMMS_MODULE_ID = "comms_settings";

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

function asStringArray(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanText).filter(Boolean))].slice(0, max);
}

export function defaultCommsSettings(): CommsSettings {
  return {
    notifications: {
      enabled: true,
      // Empty targets = broadcast (every user sees it) — the safe default
      // until the org narrows routing to specific roles. Note that owners
      // without explicit workforce roles only match broadcast notifications.
      target_role_ids: [],
      target_user_ids: []
    },
    voice: {
      sms: "attachment",
      email: "dictation"
    },
    email_forwarding: {
      enabled: false,
      fallback_email: ""
    },
    agent: {
      enabled: true,
      agent_name: "Comms Agent",
      custom_instructions: "",
      allow_send: true,
      allow_scheduling: true,
      allow_availability_read: false,
      allow_rescheduling: false,
      auto_response: {
        enabled: false,
        mode: "draft",
        channels: { email: true, sms: true }
      }
    }
  };
}

export function normalizeCommsSettings(value: unknown): CommsSettings {
  const defaults = defaultCommsSettings();
  const raw = asObject(value);
  const notifications = asObject(raw.notifications);
  const agent = asObject(raw.agent);
  const voice = asObject(raw.voice);
  const emailForwarding = asObject(raw.email_forwarding);
  const autoResponse = asObject(agent.auto_response);
  const channels = asObject(autoResponse.channels);
  const mode = cleanText(autoResponse.mode) === "send" ? "send" : "draft";
  return {
    notifications: {
      enabled: asBoolean(notifications.enabled, defaults.notifications.enabled),
      target_role_ids: asStringArray(notifications.target_role_ids),
      target_user_ids: asStringArray(notifications.target_user_ids)
    },
    voice: {
      sms: normalizeVoiceMode(voice.sms, defaults.voice.sms),
      email: normalizeVoiceMode(voice.email, defaults.voice.email)
    },
    email_forwarding: {
      enabled: asBoolean(emailForwarding.enabled, defaults.email_forwarding.enabled),
      fallback_email: cleanText(emailForwarding.fallback_email || emailForwarding.email).toLowerCase()
    },
    agent: {
      enabled: asBoolean(agent.enabled, defaults.agent.enabled),
      agent_name: cleanText(agent.agent_name).slice(0, 80) || defaults.agent.agent_name,
      custom_instructions: String(agent.custom_instructions ?? "").slice(0, 8_000),
      allow_send: asBoolean(agent.allow_send, defaults.agent.allow_send),
      allow_scheduling: asBoolean(agent.allow_scheduling, defaults.agent.allow_scheduling),
      allow_availability_read: asBoolean(agent.allow_availability_read, defaults.agent.allow_availability_read),
      allow_rescheduling: asBoolean(agent.allow_rescheduling, defaults.agent.allow_rescheduling),
      auto_response: {
        enabled: asBoolean(autoResponse.enabled, defaults.agent.auto_response.enabled),
        mode,
        channels: {
          email: asBoolean(channels.email, defaults.agent.auto_response.channels.email),
          sms: asBoolean(channels.sms, defaults.agent.auto_response.channels.sms)
        }
      }
    }
  };
}

function normalizeVoiceMode(value: unknown, fallback: "attachment" | "dictation" | "off") {
  const mode = cleanText(value);
  return mode === "attachment" || mode === "dictation" || mode === "off" ? mode : fallback;
}

export async function loadCommsSettings(orgId: string, branchId: string): Promise<CommsSettings> {
  try {
    const doc = await readBranchModule(orgId, branchId || "default", COMMS_MODULE_ID);
    return normalizeCommsSettings(asObject(doc).data);
  } catch {
    return defaultCommsSettings();
  }
}

export async function saveCommsSettings(orgId: string, branchId: string, value: unknown): Promise<CommsSettings> {
  const settings = normalizeCommsSettings(value);
  await saveBranchModule(orgId, branchId || "default", COMMS_MODULE_ID, {
    data: settings,
    metadata: { kind: "comms_settings", source: "comms_api" }
  }, { replace: true });
  return settings;
}

export function normalizeProjectCommsOverrides(value: unknown): ProjectCommsOverrides {
  const raw = asObject(value);
  const notifications = asObject(raw.notifications);
  const autoResponse = cleanText(raw.auto_response);
  const emailForwarding = asObject(raw.email_forwarding);
  return {
    notifications: {
      inherit: asBoolean(notifications.inherit, true),
      ...(notifications.enabled === true || notifications.enabled === false ? { enabled: notifications.enabled } : {}),
      ...(asStringArray(notifications.target_role_ids).length ? { target_role_ids: asStringArray(notifications.target_role_ids) } : {}),
      ...(asStringArray(notifications.target_user_ids).length ? { target_user_ids: asStringArray(notifications.target_user_ids) } : {})
    },
    agent_instructions: String(raw.agent_instructions ?? "").slice(0, 8_000),
    email_forwarding: { ...emailForwarding },
    auto_response: (["inherit", "off", "draft", "send"] as const).includes(autoResponse as never)
      ? (autoResponse as ProjectCommsOverrides["auto_response"])
      : "inherit"
  };
}

export async function loadProjectCommsOverrides(orgId: string, projectId: string): Promise<ProjectCommsOverrides> {
  try {
    const document = await readDocument(orgId, "projects", projectId);
    return normalizeProjectCommsOverrides(asObject(asObject(document.data).comms));
  } catch {
    return normalizeProjectCommsOverrides({});
  }
}

export async function saveProjectCommsOverrides(orgId: string, projectId: string, value: unknown) {
  const overrides = normalizeProjectCommsOverrides(value);
  await patchProjectDocument(orgId, projectId, { comms: overrides });
  return overrides;
}

/**
 * The settings that actually apply on a given project: project overrides win
 * where set, branch settings fill the rest.
 */
export async function resolveProjectCommsSettings(orgId: string, branchId: string, projectId: string) {
  const [settings, overrides] = await Promise.all([
    loadCommsSettings(orgId, branchId),
    loadProjectCommsOverrides(orgId, projectId)
  ]);
  const notifications: CommsNotificationSettings = overrides.notifications.inherit === false
    ? {
      enabled: overrides.notifications.enabled ?? settings.notifications.enabled,
      target_role_ids: overrides.notifications.target_role_ids ?? settings.notifications.target_role_ids,
      target_user_ids: overrides.notifications.target_user_ids ?? settings.notifications.target_user_ids
    }
    : settings.notifications;
  const autoResponse = overrides.auto_response === "inherit"
    ? settings.agent.auto_response
    : overrides.auto_response === "off"
      ? { ...settings.agent.auto_response, enabled: false }
      : { ...settings.agent.auto_response, enabled: true, mode: overrides.auto_response };
  return {
    settings,
    overrides,
    notifications,
    agent: { ...settings.agent, auto_response: autoResponse }
  };
}
