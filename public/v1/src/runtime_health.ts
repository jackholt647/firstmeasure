import { hostname } from "node:os";

import { env } from "./config/env.js";
import { isFirstMeasurePostgresEnabled, queryPostgres } from "./database/postgres.js";
import {
  checkProjectArtifactStorage,
  isSpacesArtifactStorageEnabled,
  validateArtifactStorageConfiguration
} from "./storage/project_artifacts.js";

const startedAt = new Date().toISOString();
let draining = false;
let readinessCache: { expiresAt: number; value: RuntimeReadiness } | null = null;

export type RuntimeReadiness = {
  ok: boolean;
  state: "ready" | "draining" | "not_ready";
  instance_id: string;
  release_id: string;
  topology: "single" | "cluster";
  database: "sqlite" | "postgres";
  started_at: string;
  checked_at: string;
  checks: {
    accepting_traffic: boolean;
    database: boolean;
    artifact_storage: boolean;
    cluster_database: boolean;
    cluster_artifact_storage: boolean;
    legacy_state: boolean;
    cluster_legacy_state: boolean;
  };
  error?: string;
  warnings?: string[];
};

export function runtimeIdentity() {
  return {
    instance_id: env.instanceId || hostname(),
    release_id: env.releaseId,
    topology: env.deploymentTopology,
    database: env.firstmeasureDatabaseMode,
    started_at: startedAt
  } as const;
}

export function beginRuntimeDrain() {
  draining = true;
  readinessCache = null;
}

export function isRuntimeDraining() {
  return draining;
}

export async function inspectRuntimeReadiness(options: { fresh?: boolean } = {}): Promise<RuntimeReadiness> {
  const now = Date.now();
  if (!options.fresh && readinessCache && readinessCache.expiresAt > now) return readinessCache.value;

  const identity = runtimeIdentity();
  const clusterDatabase = env.deploymentTopology !== "cluster" || isFirstMeasurePostgresEnabled();
  const clusterArtifactStorage = env.deploymentTopology !== "cluster" || isSpacesArtifactStorageEnabled();
  const clusterLegacyState = env.deploymentTopology !== "cluster"
    || env.clusterNodeRole !== "web"
    || Boolean(env.legacyServiceUrl && env.legacyProxySecret);
  let database = true;
  let artifactStorage = true;
  let error = "";
  let legacyState = true;
  const warnings: string[] = [];

  if (isFirstMeasurePostgresEnabled()) {
    try {
      await withTimeout(queryPostgres("SELECT 1 AS ready"), env.readinessDependencyTimeoutMs, "PostgreSQL readiness timed out.");
    } catch (cause) {
      database = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  try {
    await checkProjectArtifactStorage(env.readinessDependencyTimeoutMs);
  } catch (cause) {
    artifactStorage = false;
    if (!error) error = cause instanceof Error ? cause.message : String(cause);
  }

  if (env.deploymentTopology === "cluster" && env.clusterNodeRole === "web" && env.legacyServiceUrl) {
    try {
      const response = await fetch(`${env.legacyServiceUrl}/v1/health/ready`, {
        headers: { "x-firstmeasure-legacy-proxy": env.legacyProxySecret },
        signal: AbortSignal.timeout(Math.max(250, env.readinessDependencyTimeoutMs))
      });
      legacyState = response.ok;
      if (!response.ok) warnings.push(`Legacy state service returned HTTP ${response.status}.`);
    } catch (cause) {
      legacyState = false;
      warnings.push(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // The fixed legacy node serves CRM, communications, and older internal
  // tools. Its outage is degraded functionality, but must not remove every
  // otherwise healthy QA/customer web node from the load balancer.
  const ok = !draining && database && artifactStorage && clusterDatabase && clusterArtifactStorage && clusterLegacyState;
  const value: RuntimeReadiness = {
    ok,
    state: draining ? "draining" : (ok ? "ready" : "not_ready"),
    ...identity,
    checked_at: new Date().toISOString(),
    checks: {
      accepting_traffic: !draining,
      database,
      artifact_storage: artifactStorage,
      cluster_database: clusterDatabase,
      cluster_artifact_storage: clusterArtifactStorage,
      legacy_state: legacyState,
      cluster_legacy_state: clusterLegacyState
    },
    ...(error ? { error } : {}),
    ...(warnings.length ? { warnings } : {})
  };
  readinessCache = {
    expiresAt: now + env.readinessCacheMs,
    value
  };
  return value;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(250, timeoutMs));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function validateRuntimeTopology() {
  validateArtifactStorageConfiguration();
  if (env.deploymentTopology === "cluster" && !isFirstMeasurePostgresEnabled()) {
    throw new Error(
      "DEPLOYMENT_TOPOLOGY=cluster requires FIRSTMEASURE_DATABASE_MODE=postgres. " +
      "SQLite cannot coordinate writes across Droplets."
    );
  }
  if (env.deploymentTopology === "cluster" && !isSpacesArtifactStorageEnabled()) {
    throw new Error(
      "DEPLOYMENT_TOPOLOGY=cluster requires FIRSTMEASURE_ARTIFACT_STORAGE=spaces. " +
      "Project files on a Droplet's local disk are not visible to other Droplets."
    );
  }
  if (env.deploymentTopology === "cluster" && env.clusterNodeRole === "web" && (!env.legacyServiceUrl || !env.legacyProxySecret)) {
    throw new Error(
      "Cluster web nodes require LEGACY_SERVICE_URL and LEGACY_PROXY_SECRET until the CRM SQLite and tutorial/PHP stores are retired."
    );
  }
}
