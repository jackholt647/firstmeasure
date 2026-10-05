import { backgroundAuthContext } from "../platform/auth.js";
import {
  runPlatformTask,
  withPlatformTaskLease,
} from "../platform/worker_tasks.js";
import { platformBackgroundAllowed } from "../platform/runtime.js";
import { createBindingSession } from "../platform/publication/bindings.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { moduleBindingSchema } from "../documents/modules/schemas.js";
import { runModuleCode } from "../documents/modules/runtime.js";
import { z } from "zod";
import { instantiateBindings } from "../platform/publication/instantiate.js";
import { contentHash } from "../platform/publication/validation.js";
import { badRequest, conflict } from "../platform/errors.js";
import { connection, definition, execute, manage } from "./service.js";
import {
  db,
  read,
  save,
  list,
  id,
  now,
  claimRun,
  finishRun,
  immutable,
} from "./storage.js";
import {
  automationSchema,
  at,
  object,
  validateValue,
  type Obj,
} from "./contracts.js";
import type { PlatformAuthContext } from "../platform/auth.js";

export async function syncResource(
  ctx: PlatformAuthContext,
  key: string,
  resourceId: string,
) {
  manage(ctx);
  return runPlatformTask(
    `integration-sync:${ctx.orgId}:${key}:${resourceId}`,
    0,
    async (assertLease) => {
      const c = await connection(ctx, key),
        d = await definition(ctx.orgId, c),
        r = d.resources.find((r) => r.id === resourceId);
      if (!r || r.mode !== "sync")
        throw badRequest("connection_sync", "Choose a synchronized resource.");
      await connection(ctx, key, r.operation);
      const stateId = `${key}:${r.id}`,
        head = await read(ctx.orgId, "resource", stateId);
      let staging = await read(ctx.orgId, "sync", stateId);
      if (!staging || staging.version !== c.activeVersion) {
        await withPlatformTaskLease(() =>
          db().transaction(async () => {
            staging = await save(ctx.orgId, "sync", stateId, {
              generation: id("snapshot"),
              version: c.activeVersion,
              cursor: null,
              checkpoint:
                r.syncMode === "incremental" &&
                head?.version === c.activeVersion
                  ? (head?.checkpoint ?? null)
                  : null,
              nextCheckpoint: null,
              count: 0,
              startedAt: now(),
            });
            if (
              r.syncMode === "incremental" &&
              head &&
              head.version === c.activeVersion
            )
              await db()
                .prepare(
                  "INSERT INTO integration_rows(organization_id,connection_id,resource,generation,record_id,value_json) SELECT organization_id,connection_id,resource,?,record_id,value_json FROM integration_rows WHERE organization_id=? AND connection_id=? AND resource=? AND generation=?",
                )
                .run(staging.generation, ctx.orgId, key, r.id, head.generation);
          }),
        );
      }
      if (!staging) throw new Error("Sync staging was not initialized.");
      for (let page = 0; page < 5; page++) {
        await assertLease();
        const payload = await execute(ctx, key, r.operation, {
          ...(staging.cursor !== null
            ? { [r.cursorInput]: staging.cursor }
            : {}),
          ...(staging.checkpoint !== null
            ? { [r.checkpointInput]: staging.checkpoint }
            : {}),
        });
        const rows = at(payload, r.itemsPath);
        if (!Array.isArray(rows) || rows.length > 5000)
          throw badRequest(
            "connection_sync_shape",
            "The configured items path must contain an array of at most 5,000 records per page.",
          );
        let next = r.cursorPath ? at(payload, r.cursorPath) : null;
        if (
          next !== null &&
          next !== undefined &&
          typeof next !== "string" &&
          typeof next !== "number"
        )
          throw badRequest(
            "connection_cursor",
            "The remote cursor must be a string or number.",
          );
        next =
          next !== null && next !== undefined && next !== ""
            ? String(next)
            : null;
        const checkpoint = r.checkpointPath
          ? at(payload, r.checkpointPath)
          : null;
        if (
          checkpoint !== null &&
          checkpoint !== undefined &&
          !["string", "number"].includes(typeof checkpoint)
        )
          throw badRequest(
            "connection_checkpoint",
            "The checkpoint must be a string or number.",
          );
        if (next && next === staging.cursor)
          throw badRequest(
            "connection_cursor_cycle",
            "The remote API repeated its cursor.",
          );
        await withPlatformTaskLease(() =>
          db().transaction(async () => {
            for (const row of rows) {
              const recordId = at(row, r.idPath);
              if (
                !["string", "number"].includes(typeof recordId) ||
                String(recordId).length > 300 ||
                String(recordId) === ""
              )
                throw badRequest(
                  "connection_record_id",
                  "A record has no stable ID. Configure its ID path.",
                );
              if (r.deletedPath && at(row, r.deletedPath) === true)
                await db()
                  .prepare(
                    "DELETE FROM integration_rows WHERE organization_id=? AND connection_id=? AND resource=? AND generation=? AND record_id=?",
                  )
                  .run(
                    ctx.orgId,
                    key,
                    r.id,
                    staging!.generation,
                    String(recordId),
                  );
              else {
                validateValue(r.schema, row);
                await db()
                  .prepare(
                    "INSERT INTO integration_rows(organization_id,connection_id,resource,generation,record_id,value_json) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id,connection_id,resource,generation,record_id) DO UPDATE SET value_json=excluded.value_json",
                  )
                  .run(
                    ctx.orgId,
                    key,
                    r.id,
                    staging!.generation,
                    String(recordId),
                    JSON.stringify(row),
                  );
              }
            }
            staging = await save(ctx.orgId, "sync", stateId, {
              ...staging,
              cursor: next,
              nextCheckpoint: checkpoint ?? staging!.nextCheckpoint,
              count: staging!.count + rows.length,
            });
          }),
        );
        if (staging.count > 1_000_000)
          throw badRequest(
            "connection_sync_budget",
            "This import exceeded the record budget.",
          );
        if (!next) {
          await assertLease();
          const current = await connection(ctx, key, r.operation);
          if (current.activeVersion !== staging.version)
            throw conflict(
              "connection_changed",
              "The connector changed during synchronization.",
            );
          await withPlatformTaskLease(() =>
            db().transaction(async () => {
              const total = await db()
                .prepare(
                  "SELECT COUNT(*) AS total FROM integration_rows WHERE organization_id=? AND connection_id=? AND resource=? AND generation=?",
                )
                .get(ctx.orgId, key, r.id, staging!.generation);
              const snapshot = {
                generation: staging!.generation,
                observedAt: now(),
                count: Number(total!.total),
                version: staging!.version,
                checkpoint: staging!.nextCheckpoint ?? staging!.checkpoint,
              };
              await save(
                ctx.orgId,
                "snapshot",
                `${stateId}:${staging!.generation}`,
                snapshot,
                0,
              );
              await save(ctx.orgId, "resource", stateId, snapshot);
              await db()
                .prepare(
                  "INSERT INTO integration_changes(id,organization_id,connection_id,resource,value_json,created_at) VALUES(?,?,?,?,?,?)",
                )
                .run(
                  id("change"),
                  ctx.orgId,
                  key,
                  r.id,
                  JSON.stringify({
                    previous: head?.generation || null,
                    revision: staging!.generation,
                  }),
                  now(),
                );
              await db()
                .prepare(
                  "DELETE FROM integration_objects WHERE organization_id=? AND kind=? AND id=?",
                )
                .run(ctx.orgId, "sync", stateId);
            }),
          );
          await db()
            .prepare(
              "DELETE FROM integration_objects WHERE organization_id=? AND kind=? AND id=?",
            )
            .run(ctx.orgId, "health", stateId);
          // The committed change record is an outbox; a crash cannot lose invalidation.
          await dispatchConnectionChanges().catch(() => undefined);
          return {
            complete: true,
            revision: staging.generation,
            count: staging.count,
          };
        }
      }
      return { complete: false, count: staging.count };
    },
  );
}
export function bindingConnections(bindings: Obj) {
  return [
    ...new Set(
      Object.values(bindings)
        .map((raw) => {
          const b = object(raw);
          return String(
            b.kind === "data"
              ? object(b.source).provider
              : object(b.action).action,
          ).match(/^external\.(conn_[a-f0-9]+)(?:\.|$)/)?.[1];
        })
        .filter(Boolean),
    ),
  ] as string[];
}
export async function saveAutomation(ctx: PlatformAuthContext, raw: unknown) {
  manage(ctx);
  const input = automationSchema.parse(raw),
    bindings = z.record(moduleBindingSchema).parse(input.bindings);
  const connections = bindingConnections(bindings);
  if (!connections.length)
    throw badRequest(
      "automation_connection",
      "Declare at least one connection binding.",
    );
  for (const key of connections) await connection(ctx, key);
  if (!input.events.length && !input.intervalSeconds)
    throw badRequest("automation_trigger", "Choose an event or schedule.");
  const key = input.id || id("automation"),
    prior = await read(ctx.orgId, "automation", key);
  if (prior && input.expectedRevision !== prior.revision)
    throw conflict("integration_revision", "Automation changed; reload it.");
  const value = {
    ...input,
    bindings,
    connections,
    author: ctx.userId,
    version: contentHash({
      source: input.source,
      bindings,
      settings: input.settings,
    }),
    updatedAt: now(),
  };
  await immutable(
    ctx.orgId,
    "automation-version",
    `${key}:${contentHash(value)}`,
    value,
  );
  return save(ctx.orgId, "automation", key, value, prior?.revision || 0);
}
export async function enqueueConnectionEvent(event: Obj) {
  const org = String(event.organization_id || "");
  if (!org || !event.id) return;
  for (const rule of await list(org, "automation")) {
    if (
      !rule.enabled ||
      !rule.events.some(
        (type: string) =>
          type === event.type ||
          (type === "proposal.signed" &&
            event.type === "document.signed" &&
            object(event.payload).document_source === "proposals"),
      ) ||
      (rule.projectId && rule.projectId !== event.project_id)
    )
      continue;
    if (
      Object.entries(object(rule.conditions)).some(
        ([path, value]) =>
          JSON.stringify(at(event, path)) !== JSON.stringify(value),
      )
    )
      continue;
    const key = `job_${contentHash({ org, rule: rule.id, version: rule.revision, event: event.id })}`;
    await db()
      .prepare(
        "INSERT INTO integration_objects(organization_id,kind,id,revision,value_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id,kind,id) DO NOTHING",
      )
      .run(
        org,
        "job",
        key,
        1,
        JSON.stringify({
          ruleId: rule.id,
          ruleRevision: rule.revision,
          event,
          state: "queued",
        }),
        now(),
      );
  }
}
export async function runAutomation(
  ctx: PlatformAuthContext,
  rule: Obj,
  event: Obj,
  jobId: string,
) {
  return runPlatformTask(
    `integration-automation:${ctx.orgId}:${rule.id}`,
    0,
    () => executeAutomation(ctx, rule, event, jobId),
  );
}
async function executeAutomation(
  ctx: PlatformAuthContext,
  rule: Obj,
  event: Obj,
  jobId: string,
) {
  manage(ctx);
  for (const key of rule.connections) await connection(ctx, key);
  const claimed = await claimRun(
    ctx.orgId,
    rule.connections[0],
    "automation",
    jobId,
    { title: rule.title, ruleId: rule.id, connections: rule.connections },
  );
  if (!claimed) return;
  try {
    const publication = userPublicationContext(ctx, {
      executionKind: "work",
      mode: "command",
      ...(event.project_id ? { projectId: String(event.project_id) } : {}),
      invocationId: jobId,
    });
    const bindings = instantiateBindings(rule.bindings, {
      organizationId: ctx.orgId,
      projectId: String(event.project_id || ""),
      branchId: ctx.branchId || "default",
    });
    const session = createBindingSession(
      publication,
      `integration-automation:${rule.id}:${jobId}`,
      bindings,
    );
    const state = await read(ctx.orgId, "automation-state", rule.id);
    const result = await runModuleCode(
      {
        source: rule.source,
        inputs: { event, settings: rule.settings },
        state: state?.value || {},
        mode: "command",
        now: now(),
      },
      {
        read: (name) => session.read(name),
        invoke: (name, input) => session.invoke(name, input),
      },
    );
    if (result.privateState)
      await save(ctx.orgId, "automation-state", rule.id, {
        value: result.privateState,
      });
    await finishRun(jobId, "succeeded", {
      title: rule.title,
      ruleId: rule.id,
      connections: rule.connections,
      outputKeys: Object.keys(result.outputs),
    });
  } catch {
    await finishRun(jobId, "uncertain", {
      title: rule.title,
      ruleId: rule.id,
      connections: rule.connections,
      message:
        "Execution failed. Inspect action receipts before retrying; no automatic replay.",
    });
  }
}
export async function dispatchConnectionChanges() {
  const changes = await db()
    .prepare(
      "SELECT * FROM integration_changes WHERE delivered_at='' ORDER BY created_at,id LIMIT 100",
    )
    .all();
  for (const change of changes) {
    const value = JSON.parse(String(change.value_json));
    await (
      await import("../work/engine.js")
    ).emitWorkEvent({
      organization_id: String(change.organization_id),
      branch_id: "default",
      type: "connection.resource.updated",
      idempotency_key: `connection-change:${change.id}`,
      payload: {
        connection_id: change.connection_id,
        resource: change.resource,
        revision: value.revision,
        previous_revision: value.previous,
      },
    });
    await db()
      .prepare(
        "UPDATE integration_changes SET delivered_at=? WHERE id=? AND delivered_at=''",
      )
      .run(now(), String(change.id));
  }
}
/** Keep slow provider I/O off the event/action lane and rotate fairly through due resources. */
export async function integrationSyncTick() {
  const rows = await db()
    .prepare(
      "SELECT organization_id,value_json,id FROM integration_objects WHERE kind='connection' ORDER BY organization_id,id",
    )
    .all();
  const candidates: Array<{
    org: string;
    connection: Obj;
    resource: ReturnType<
      typeof import("./contracts.js").parseConnector
    >["resources"][number];
    key: string;
  }> = [];
  for (const row of rows) {
    const c = { ...JSON.parse(String(row.value_json)), id: String(row.id) },
      org = String(row.organization_id);
    if (!c.enabled) continue;
    try {
      for (const resource of (await definition(org, c)).resources)
        if (resource.mode === "sync")
          candidates.push({
            org,
            connection: c,
            resource,
            key: `${org}:${c.id}:${resource.id}`,
          });
    } catch {}
  }
  candidates.sort((a, b) => a.key.localeCompare(b.key));
  const cursor = await read("__system__", "scheduler", "connection-sync");
  const index = candidates.findIndex(
    (item) => item.key > (cursor?.after || ""),
  );
  const ordered =
    index < 0
      ? candidates
      : [...candidates.slice(index), ...candidates.slice(0, index)];
  const pending: Promise<unknown>[] = [];
  let last = "";
  for (const item of ordered) {
    const { org, connection: c, resource } = item;
    last = item.key;
    const health = await read(org, "health", `${c.id}:${resource.id}`);
    if (health?.retryAt > Date.now()) continue;
    const state = await read(org, "resource", `${c.id}:${resource.id}`),
      staging = await read(org, "sync", `${c.id}:${resource.id}`);
    if (
      !staging && state &&
      state.version === c.activeVersion &&
      Date.now() - Date.parse(state.observedAt) <=
        resource.intervalSeconds * 1000
    )
      continue;
    pending.push(
      (async () => {
        try {
          const ctx = await backgroundAuthContext(org, c.owner);
          await syncResource(ctx, c.id, resource.id);
        } catch {
          await save(org, "health", `${c.id}:${resource.id}`, {
            state: "failed",
            message:
              "Synchronization failed. Check credentials and resource mapping.",
            attempts: (health?.attempts || 0) + 1,
            retryAt:
              Date.now() +
              Math.min(
                3600000,
                30000 * 2 ** Math.min(7, health?.attempts || 0),
              ),
            at: now(),
          });
        }
      })(),
    );
    if (pending.length >= 3) break;
  }
  await Promise.allSettled(pending);
  if (last)
    await save("__system__", "scheduler", "connection-sync", { after: last });
}
export async function integrationTick() {
  await dispatchConnectionChanges();
  const rules = await db()
    .prepare(
      "SELECT organization_id,id,value_json FROM integration_objects WHERE kind='automation'",
    )
    .all();
  for (const row of rules) {
    const rule = JSON.parse(String(row.value_json));
    if (!rule.enabled || !rule.intervalSeconds) continue;
    const org = String(row.organization_id),
      bucket = Math.floor(Date.now() / (rule.intervalSeconds * 1000));
    await enqueueScheduled(org, String(row.id), bucket, rule);
  }
  const jobs = await db()
    .prepare(
      "SELECT organization_id,id,value_json FROM integration_objects WHERE kind='job' ORDER BY updated_at LIMIT 100",
    )
    .all();
  for (const row of jobs) {
    const org = String(row.organization_id),
      job = JSON.parse(String(row.value_json));
    if (job.state !== "queued") continue;
    const rule = await read(org, "automation", job.ruleId);
    try {
      if (rule?.enabled && rule.revision === job.ruleRevision) {
        const ctx = await backgroundAuthContext(org, rule.author);
        if (ctx) {
          const result = await runAutomation(
            ctx,
            rule,
            job.event,
            String(row.id),
          );
          if (!result.ran) continue;
        }
      }
    } catch {
      await claimRun(
        org,
        rule?.connections?.[0] || "",
        "automation",
        String(row.id),
        { ruleId: job.ruleId },
      );
      await finishRun(String(row.id), "denied", {
        ruleId: job.ruleId,
        message:
          "Automation author or connection access is no longer available.",
      });
    }
    await db()
      .prepare(
        "DELETE FROM integration_objects WHERE organization_id=? AND kind=? AND id=?",
      )
      .run(org, "job", String(row.id));
  }
}
async function enqueueScheduled(
  org: string,
  ruleId: string,
  bucket: number,
  rule: Obj,
) {
  const current = await read(org, "automation", ruleId);
  const key = `scheduled_${contentHash({ org, ruleId, bucket })}`;
  await db()
    .prepare(
      "INSERT INTO integration_objects(organization_id,kind,id,revision,value_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id,kind,id) DO NOTHING",
    )
    .run(
      org,
      "job",
      key,
      1,
      JSON.stringify({
        ruleId,
        ruleRevision: current!.revision,
        event: {
          id: key,
          type: "time.schedule",
          organization_id: org,
          project_id: rule.projectId || "",
          payload: {},
        },
        state: "queued",
      }),
      now(),
    );
}
export function startIntegrationScheduler() {
  if (
    !platformBackgroundAllowed() ||
    process.env.NODE_ENV === "test" ||
    process.env.PLATFORM_HEARTBEAT_DISABLED === "1"
  )
    return () => {};
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runPlatformTask("integrations", 5000, () => integrationTick())
      .catch(() => undefined)
      .finally(() => (running = false));
  }, 5000);
  timer.unref();
  let syncing = false;
  const syncTimer = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void runPlatformTask("integration-sync", 5000, () => integrationSyncTick())
      .catch(() => undefined)
      .finally(() => (syncing = false));
  }, 5000);
  syncTimer.unref();
  let summarizing = false;
  const summaries = setInterval(() => {
    if (summarizing) return;
    summarizing = true;
    void runPlatformTask("integration-descriptions", 60000, async () =>
      (await import("./summaries.js")).summaryTick(),
    )
      .catch(() => undefined)
      .finally(() => (summarizing = false));
  }, 60000);
  summaries.unref();
  return () => {
    clearInterval(timer);
    clearInterval(summaries);
    clearInterval(syncTimer);
  };
}
