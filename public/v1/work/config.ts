import { PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { WORK_SCHEMA_VERSION, workConfigurationSchema, type WorkConfiguration } from "./schemas.js";

export const WORK_CONFIGURATION_MODULE_ID = "work_configuration";

export const DEFAULT_FOLLOW_UP_CONFIGURATION = {
  tag: "follow_up" as const,
  label: "Follow-up",
  default_title: "Follow-up call",
  default_time: "",
  quick_options: [
    { id: "one_day", label: "1 day", amount: 1, unit: "days" as const },
    { id: "two_days", label: "2 days", amount: 2, unit: "days" as const },
    { id: "one_week", label: "1 week", amount: 1, unit: "weeks" as const },
    { id: "one_month", label: "1 month", amount: 1, unit: "months" as const }
  ],
  retry_policy: {
    enabled: true,
    triggers: ["voicemail" as const, "no_answer" as const, "manual_follow_up" as const],
    after_last: "repeat_last" as const,
    steps: [
      { id: "day_1", label: "Day 1", amount: 1, unit: "days" as const },
      { id: "day_2", label: "Day 2", amount: 1, unit: "days" as const },
      { id: "day_3", label: "Day 3", amount: 1, unit: "days" as const },
      { id: "day_5", label: "Day 5", amount: 2, unit: "days" as const },
      { id: "weekly", label: "Then weekly", amount: 1, unit: "weeks" as const }
    ]
  },
  outcomes: [
    { id: "follow_up", label: "Follow up again", action: "reschedule" as const, color: "#2e90fa" },
    { id: "scheduled", label: "Appointment scheduled", action: "scheduled" as const, color: "#12b76a", stage_id: "appointment_scheduled" },
    { id: "lost", label: "Lost", action: "lost" as const, color: "#f04438", stage_id: "lost" }
  ]
};

export const DEFAULT_WORK_CONFIGURATION: WorkConfiguration = {
  schema_version: WORK_SCHEMA_VERSION,
  terminology: {
    phase: "Phase",
    stage: "Stage",
    task: "To-do",
    board: "Board"
  },
  follow_ups: DEFAULT_FOLLOW_UP_CONFIGURATION
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function normalizeWorkConfiguration(value: unknown) {
  const input = asObject(value);
  return workConfigurationSchema.parse({
    ...DEFAULT_WORK_CONFIGURATION,
    ...input,
    terminology: {
      ...DEFAULT_WORK_CONFIGURATION.terminology,
      ...asObject(input.terminology)
    },
    follow_ups: {
      ...DEFAULT_FOLLOW_UP_CONFIGURATION,
      ...asObject(input.follow_ups),
      quick_options: Array.isArray(asObject(input.follow_ups).quick_options)
        ? asObject(input.follow_ups).quick_options
        : DEFAULT_FOLLOW_UP_CONFIGURATION.quick_options,
      outcomes: Array.isArray(asObject(input.follow_ups).outcomes)
        ? asObject(input.follow_ups).outcomes
        : DEFAULT_FOLLOW_UP_CONFIGURATION.outcomes,
      retry_policy: {
        ...DEFAULT_FOLLOW_UP_CONFIGURATION.retry_policy,
        ...asObject(asObject(input.follow_ups).retry_policy),
        triggers: Array.isArray(asObject(asObject(input.follow_ups).retry_policy).triggers)
          ? asObject(asObject(input.follow_ups).retry_policy).triggers
          : DEFAULT_FOLLOW_UP_CONFIGURATION.retry_policy.triggers,
        steps: Array.isArray(asObject(asObject(input.follow_ups).retry_policy).steps)
          ? asObject(asObject(input.follow_ups).retry_policy).steps
          : DEFAULT_FOLLOW_UP_CONFIGURATION.retry_policy.steps
      }
    }
  });
}

export async function readWorkConfiguration(orgId: string, branchId = "default") {
  try {
    const document = await readBranchModule(orgId, branchId || "default", WORK_CONFIGURATION_MODULE_ID);
    return {
      ...normalizeWorkConfiguration(document.data),
      revision: Number(document.revision || 0),
      updated_at: document.updated_at
    };
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode === 404) {
      return { ...DEFAULT_WORK_CONFIGURATION, revision: 0, updated_at: "" };
    }
    throw error;
  }
}

export async function saveWorkConfiguration(orgId: string, branchId: string, value: unknown) {
  const input = asObject(value);
  const patch = asObject(input.data || input);
  const current = await readWorkConfiguration(orgId, branchId || "default");
  const currentData = asObject(current);
  delete currentData.revision;
  delete currentData.updated_at;
  const configuration = normalizeWorkConfiguration({
    ...currentData,
    ...patch,
    terminology: {
      ...asObject(current.terminology),
      ...asObject(patch.terminology)
    },
    follow_ups: patch.follow_ups || current.follow_ups
  });
  const document = await saveBranchModule(orgId, branchId || "default", WORK_CONFIGURATION_MODULE_ID, {
    expected_revision: input.expected_revision,
    data: configuration,
    metadata: { kind: "branch_work_configuration" }
  }, { replace: true });
  return {
    ...normalizeWorkConfiguration(document.data),
    revision: Number(document.revision || 0),
    updated_at: document.updated_at
  };
}
