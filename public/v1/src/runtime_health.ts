import { hostname } from "node:os";

import { env } from "./config/env.js";
import { isFirstMeasurePostgresEnabled, queryPostgres } from "./database/postgres.js";
import {
  checkProjectArtifactStorage,
  isSpacesArtifactStorageEnabled,
  validateArtifactStorageConfiguration
} from "./storage/project_artifacts.js";
import { assertRuntimeEnvironmentSafety, inspectEnvironmentSafety } from "./environment_safety.js";

const startedAt = new Date().toISOString();
let draining = false;
let readinessCache: { expiresAt: number; value: RuntimeReadiness } | null = null;
let inspecting: Promise<RuntimeReadiness> | null = null;
let lastReadiness: RuntimeReadiness | null = null;
// A failed check is kept only briefly, so a node the load balancer took out comes back as soon as it can.
const FAILED_READINESS_CACHE_MS = 5_000;

/**
 * Artifact storage (DigitalOcean Spaces) sometimes leaves one list request in several hanging (FM-500). One hung
 * request made a node not ready, so the load balancer took dev's only web node out for minutes, and a worker's
 * start preflight failed. The check is tried again, and a server that reached storage within `graceMs` stays ready
 * (with a warning) while a retry fails; storage that stays unreachable still fails, and a server that never reached
 * it (a start preflight) fails after its attempts.
 */
export function createArtifactStorageProbe(
  check: () => Promise<unknown>,
  { attempts = 3, graceMs = 120_000, now = Date.now }: { attempts?: number; graceMs?: number; now?: () => number } = {}
) {
  let reachedAt = 0;
  return async (): Promise<{ ok: boolean; error?: string; warning?: string }> => {
    let error = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await check();
        reachedAt = now();
        return attempt > 1 ? { ok: true, warning: `Artifact storage answered on attempt ${attempt} of ${attempts}.` } : { ok: true };
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    if (reachedAt && now() - reachedAt < graceMs) {
      return { ok: true, warning: `Artifact storage did not answer (${error}); it last answered ${Math.round((now() - reachedAt) / 1000)} s ago.` };
    }
    return { ok: false, error };
  };
}

const probeArtifactStorage = createArtifactStorageProbe(() => checkProjectArtifactStorage(env.readinessDependencyTimeoutMs));

export type RuntimeReadiness = {
  ok: boolean;
  state: "ready" | "draining" | "not_ready";
  instance_id: string;
  release_id: string;
  topology: "single" | "cluster";
  database: "sqlite" | "postgres";
  data_environment: "development" | "production" | "test";
  started_at: string;
  checked_at: string;
  checks: {
    accepting_traffic: boolean;
    database: boolean;
    data_environment: boolean;
    artifact_storage: boolean;
    cluster_database: boolean;
    cluster_artifact_storage: boolean;
    legacy_state: boolean;
    cluster_legacy_state: boolean;
    environment_safety: boolean;
  };
  outbound_safety: ReturnType<typeof inspectEnvironmentSafety>;
  error?: string;
  warnings?: string[];
};

export function runtimeIdentity() {
  return {
    instance_id: env.instanceId || hostname(),
    release_id: env.releaseId,
    topology: env.deploymentTopology,
    database: env.firstmeasureDatabaseMode,
    data_environment: env.dataEnvironment,
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
  if (!options.fresh && readinessCache && readinessCache.expiresAt > Date.now()) return readinessCache.value;
  // A check is already running (a dependency is slow): answer with the last one rather than pile up behind it, so a
  // load balancer's health check is not timed out by a slow storage call.
  if (!options.fresh && !draining && inspecting) return lastReadiness ?? inspecting;
  const running = inspect();
  if (!options.fresh) inspecting = running;
  try {
    return await running;
  } finally {
    if (inspecting === running) inspecting = null;
  }
}

async function inspect(): Promise<RuntimeReadiness> {
  const now = Date.now();
  const identity = runtimeIdentity();
  const clusterDatabase = env.deploymentTopology !== "cluster" || isFirstMeasurePostgresEnabled();
  const clusterArtifactStorage = env.deploymentTopology !== "cluster" || isSpacesArtifactStorageEnabled();
  const clusterLegacyState = env.deploymentTopology !== "cluster"
    || env.clusterNodeRole !== "web"
    || Boolean(env.legacyServiceUrl && env.legacyProxySecret);
  let database = true;
  let dataEnvironment = true;
  let artifactStorage = true;
  let error = "";
  let legacyState = true;
  const warnings: string[] = [];
  const outboundSafety = inspectEnvironmentSafety();

  if (isFirstMeasurePostgresEnabled()) {
    try {
      await withTimeout(queryPostgres("SELECT 1 AS ready"), env.readinessDependencyTimeoutMs, "PostgreSQL readiness timed out.");
      if (env.requireDataEnvironmentMarker) {
        const marker = await withTimeout(
          queryPostgres<{ environment: string }>("SELECT environment FROM firstmeasure_data_environment WHERE singleton = true"),
          env.readinessDependencyTimeoutMs,
          "PostgreSQL data-environment verification timed out."
        );
        const actual = String(marker.rows[0]?.environment ?? "");
        if (actual !== env.dataEnvironment) {
          dataEnvironment = false;
          throw new Error(`PostgreSQL is marked '${actual || "unmarked"}', expected '${env.dataEnvironment}'.`);
        }
      }
    } catch (cause) {
      database = false;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const storage = await probeArtifactStorage();
  if (!storage.ok) {
    artifactStorage = false;
    if (!error) error = storage.error ?? "Artifact storage did not answer.";
  }
  if (storage.warning) warnings.push(storage.warning);

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
  const ok = !draining && database && dataEnvironment && artifactStorage && clusterDatabase && clusterArtifactStorage && clusterLegacyState && outboundSafety.ok;
  const value: RuntimeReadiness = {
    ok,
    state: draining ? "draining" : (ok ? "ready" : "not_ready"),
    ...identity,
    checked_at: new Date().toISOString(),
    checks: {
      accepting_traffic: !draining,
      database,
      data_environment: dataEnvironment,
      artifact_storage: artifactStorage,
      cluster_database: clusterDatabase,
      cluster_artifact_storage: clusterArtifactStorage,
      legacy_state: legacyState,
      cluster_legacy_state: clusterLegacyState,
      environment_safety: outboundSafety.ok
    },
    outbound_safety: outboundSafety,
    ...(error ? { error } : {}),
    ...(warnings.length ? { warnings } : {})
  };
  readinessCache = {
    expiresAt: now + (ok || draining ? env.readinessCacheMs : Math.min(env.readinessCacheMs, FAILED_READINESS_CACHE_MS)),
    value
  };
  lastReadiness = value;
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
  assertRuntimeEnvironmentSafety();
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
