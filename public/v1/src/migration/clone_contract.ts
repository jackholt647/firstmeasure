import type { DataEnvironment } from "../config/env.js";

export const PRODUCTION_CLONE_CONFIRMATION = "COPY_PRODUCTION_SNAPSHOT_TO_PRODUCTION";

export function parseDataEnvironment(value: string): DataEnvironment {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "development" || normalized === "production" || normalized === "test") return normalized;
  throw new Error("Data environment must be development, production, or test.");
}

export function assertCloneTargetContract(input: {
  targetEnvironment: DataEnvironment;
  configuredEnvironment: DataEnvironment;
  configuredEnvironmentExplicit: boolean;
  spacesPrefix: string;
  productionConfirmation?: string;
  writeOperation?: boolean;
}) {
  if (!input.configuredEnvironmentExplicit) {
    throw new Error("FIRSTMEASURE_DATA_ENVIRONMENT must be set explicitly for a clone operation.");
  }
  if (input.configuredEnvironment !== input.targetEnvironment) {
    throw new Error(
      `Clone target '${input.targetEnvironment}' does not match FIRSTMEASURE_DATA_ENVIRONMENT='${input.configuredEnvironment}'.`
    );
  }
  const prefixEnvironment = String(input.spacesPrefix).split("/").filter(Boolean)[0] ?? "";
  if (prefixEnvironment !== input.targetEnvironment) {
    throw new Error(
      `SPACES_PREFIX must begin with '${input.targetEnvironment}/' (or equal '${input.targetEnvironment}') for this clone target.`
    );
  }
  if (
    input.targetEnvironment === "production"
    && input.writeOperation !== false
    && input.productionConfirmation !== PRODUCTION_CLONE_CONFIRMATION
  ) {
    throw new Error(
      `Production clone writes require --confirm-production ${PRODUCTION_CLONE_CONFIRMATION}.`
    );
  }
}

export function developmentCloneExclusions() {
  return {
    sessions: true,
    apiKeySecrets: true,
    apiKeyDeliveries: true,
    communications: true,
    appleProviderState: true
  } as const;
}
