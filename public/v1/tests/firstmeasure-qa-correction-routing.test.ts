import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectManifest } from "../firstmeasure/storage.js";

test("technician corrections return to the original QA within their priority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-qa-return-test-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = root;
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "projects-index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");

  const originalQa = { email: "original-qa@example.test", name: "Original QA" };
  const otherQa = { email: "other-qa@example.test", name: "Other QA" };

  try {
    const storage = await import("../firstmeasure/storage.js");
    const index = await import("../firstmeasure/project_index.js");
    const internalStorage = await import("../internal/storage.js");
    const { buildApp } = await import("../src/app.js");
    await index.ensureFirstMeasureProjectIndexReady();

    const saveProject = async (id: string, status: string, priorityLevel: number, extra: Record<string, unknown> = {}) => {
      const now = new Date().toISOString();
      await storage.saveManifest(id, {
        id,
        schema_version: 2,
        status,
        address: `${id} Test Way`,
        priority_level: priorityLevel,
        workflow: { assigned_to: null, reserved_to: null, correction_to: null, qa_claim: null, history: [] },
        timestamps: { created_at: now, queued_at: now, updated_at: now },
        ...extra
      } as unknown as ProjectManifest);
    };

    await saveProject("fresh-p1", "awaiting_review", 1);
    await saveProject("fresh-p2", "awaiting_review", 2);
    await saveProject("fresh-p3", "awaiting_review", 3);
    await saveProject("returned-p2", "correction_needed", 2, {
      correction_requested_by: originalQa.email,
      qa_return_to_email: originalQa.email,
      qa_return_to_name: originalQa.name
    });
    await saveProject("returned-p3", "awaiting_review", 3, {
      assigned_to_email: "tech@example.test",
      assigned_to_name: "Tech",
      qa_claimed_by_email: originalQa.email,
      qa_claimed_by_name: originalQa.name,
      qa_claimed_at: new Date().toISOString(),
      workflow: {
        assigned_to: { email: "tech@example.test", name: "Tech" },
        reserved_to: null,
        correction_to: null,
        qa_claim: { email: originalQa.email, name: originalQa.name, claimed_at: new Date().toISOString() },
        history: []
      }
    });

    const app = await buildApp();
    await app.ready();
    try {
      const rosterTeamBootstrap = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/bootstrap",
        payload: {
          actor: { ...otherQa, team_id: "night-shift", roles: ["qa"] },
          can_do_qa: true
        }
      });
      assert.equal(rosterTeamBootstrap.statusCode, 200, rosterTeamBootstrap.body);
      assert.equal(rosterTeamBootstrap.json().stats.has_available_next, true,
        "a QA user's staff team must not implicitly hide the shared project queue");

      const explicitlyScopedBootstrap = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/bootstrap",
        payload: {
          actor: { ...otherQa, team_id: "night-shift", roles: ["qa"] },
          can_do_qa: true,
          team_id: "night-shift"
        }
      });
      assert.equal(explicitlyScopedBootstrap.statusCode, 200, explicitlyScopedBootstrap.body);
      assert.equal(explicitlyScopedBootstrap.json().stats.has_available_next, false,
        "an explicitly requested project-team scope must still be honored");

      const rejection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/returned-p3/qa/decision",
        payload: { actor: originalQa, status: "rejected", failures: [{ code: "test_failure" }], threads: [] }
      });
      assert.equal(rejection.statusCode, 200, rejection.body);
      assert.equal(rejection.json().manifest.qa_return_to_email, originalQa.email);
      assert.equal(rejection.json().manifest.qa_return_to_name, originalQa.name);
      assert.equal(rejection.json().delivery_mode, "unreserved_queue");
      assert.equal(rejection.json().worker_online, false);
      assert.equal(rejection.json().manifest.status, "queued");
      assert.equal(Boolean(rejection.json().manifest.reserved_to_email), false);

      const onlineTech = { email: "online-tech@example.test", name: "Online Tech" };
      await internalStorage.saveInternalUser({
        id: onlineTech.email,
        email: onlineTech.email,
        name: onlineTech.name,
        role: "technician",
        last_activity_at: new Date().toISOString()
      });
      await saveProject("online-tech-return", "awaiting_review", 2, {
        assigned_to_email: onlineTech.email,
        assigned_to_name: onlineTech.name,
        qa_claimed_by_email: originalQa.email,
        qa_claimed_by_name: originalQa.name,
        qa_claimed_at: new Date().toISOString(),
        workflow: {
          assigned_to: onlineTech,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: originalQa.email, name: originalQa.name, claimed_at: new Date().toISOString() },
          history: []
        }
      });
      const onlineRejection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/online-tech-return/qa/decision",
        payload: { actor: originalQa, status: "rejected", failures: [], threads: [] }
      });
      assert.equal(onlineRejection.statusCode, 200, onlineRejection.body);
      assert.equal(onlineRejection.json().delivery_mode, "reserved_queue");
      assert.equal(onlineRejection.json().worker_online, true);
      assert.equal(onlineRejection.json().manifest.status, "queued");
      assert.equal(onlineRejection.json().manifest.reserved_to_email, onlineTech.email);

      const explicitlyOfflineTech = { email: "offline-tech@example.test", name: "Offline Tech" };
      await internalStorage.saveInternalUser({
        id: explicitlyOfflineTech.email,
        email: explicitlyOfflineTech.email,
        name: explicitlyOfflineTech.name,
        role: "technician",
        is_offline: true,
        last_activity_at: new Date().toISOString()
      });
      await saveProject("explicitly-offline-return", "awaiting_review", 2, {
        assigned_to_email: explicitlyOfflineTech.email,
        assigned_to_name: explicitlyOfflineTech.name,
        qa_claimed_by_email: originalQa.email,
        qa_claimed_by_name: originalQa.name,
        qa_claimed_at: new Date().toISOString(),
        workflow: {
          assigned_to: explicitlyOfflineTech,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: originalQa.email, name: originalQa.name, claimed_at: new Date().toISOString() },
          history: []
        }
      });
      const offlineRejection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/explicitly-offline-return/qa/decision",
        payload: { actor: originalQa, status: "rejected", failures: [], threads: [] }
      });
      assert.equal(offlineRejection.statusCode, 200, offlineRejection.body);
      assert.equal(offlineRejection.json().delivery_mode, "unreserved_queue");
      assert.equal(offlineRejection.json().worker_online, false);
      assert.equal(offlineRejection.json().manifest.status, "queued");
      assert.equal(Boolean(offlineRejection.json().manifest.reserved_to_email), false);

      const p2Correction = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/returned-p2/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(p2Correction.statusCode, 200, p2Correction.body);

      const correctionResponse = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/returned-p3/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(correctionResponse.statusCode, 200, correctionResponse.body);
      const corrected = correctionResponse.json().manifest;
      assert.equal(corrected.status, "awaiting_review");
      assert.equal(corrected.qa_claimed_by_email, originalQa.email);
      assert.equal(corrected.qa_available, false);
      assert.equal(corrected.hidden_from_queue, true);
      assert.equal(corrected.workflow.qa_claim.claim_reason, "correction_return");
      assert.ok(Date.parse(corrected.qa_return_hold_expires_at) > Date.now());

      const blockedClaim = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/returned-p3/qa/claim",
        payload: { actor: otherQa }
      });
      assert.equal(blockedClaim.statusCode, 200, blockedClaim.body);
      assert.equal(blockedClaim.json().success, false);
      assert.equal(blockedClaim.json().error, "item_claimed_by_other_user");

      // Simulate a legacy contradictory record. Queue output must derive
      // availability from the owner instead of trusting stale hint fields.
      await storage.patchManifest("returned-p3", {
        qa_available: true,
        qa_availability_reason: null,
        hidden_from_queue: false
      });

      const peek = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/queue/peek",
        payload: { actor: originalQa, limit: 10 }
      });
      assert.equal(peek.statusCode, 200, peek.body);
      assert.deepEqual(
        peek.json().projects.map((project: Record<string, unknown>) => project.id),
        ["fresh-p1", "returned-p2", "fresh-p2", "returned-p3", "fresh-p3"]
      );
      const returnedQueueRow = peek.json().projects.find((project: Record<string, unknown>) => project.id === "returned-p3");
      assert.equal(returnedQueueRow.qa_claimed_by_email, originalQa.email);
      assert.equal(returnedQueueRow.qa_available, false);
      assert.equal(returnedQueueRow.hidden_from_queue, true);

      const pull = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/queue/pull",
        payload: { actor: originalQa, count: 4 }
      });
      assert.equal(pull.statusCode, 200, pull.body);
      assert.deepEqual(
        pull.json().projects.map((project: Record<string, unknown>) => project.id),
        ["fresh-p1", "returned-p2", "fresh-p2", "returned-p3"]
      );

      const claimedReturn = await storage.readManifest("returned-p3");
      assert.equal((claimedReturn as Record<string, unknown>).qa_return_hold_expires_at, null);

      await saveProject("expired-return", "correction_needed", 2, {
        correction_requested_by: originalQa.email,
        qa_return_to_email: originalQa.email,
        qa_return_to_name: originalQa.name
      });
      const secondCorrection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/expired-return/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(secondCorrection.statusCode, 200, secondCorrection.body);
      await storage.patchManifest("expired-return", {
        qa_return_hold_expires_at: new Date(Date.now() - 1_000).toISOString()
      });

      const takeover = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/expired-return/qa/claim",
        payload: { actor: otherQa }
      });
      assert.equal(takeover.statusCode, 200, takeover.body);
      assert.equal(takeover.json().success, true);
      assert.equal(takeover.json().claimed_by, otherQa.email);

      const repeatRejection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/expired-return/qa/decision",
        payload: { actor: otherQa, status: "rejected", failures: [], threads: [] }
      });
      assert.equal(repeatRejection.statusCode, 200, repeatRejection.body);
      assert.equal(repeatRejection.json().manifest.qa_return_to_email, otherQa.email);
      const repeatCorrection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/expired-return/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(repeatCorrection.statusCode, 200, repeatCorrection.body);
      assert.equal(repeatCorrection.json().manifest.qa_claimed_by_email, otherQa.email);

      await saveProject("history-return", "correction_needed", 3, {
        qa_history: [{ decision: "rejected", qa_email: originalQa.email, qa_name: originalQa.name }]
      });
      const historyFallback = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/history-return/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(historyFallback.statusCode, 200, historyFallback.body);
      assert.equal(historyFallback.json().manifest.qa_claimed_by_email, originalQa.email);

      await saveProject("ownerless-return", "correction_needed", 3);
      const ownerless = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/ownerless-return/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(ownerless.statusCode, 200, ownerless.body);
      assert.equal(Boolean(ownerless.json().manifest.qa_claimed_by_email), false);

      await saveProject("manager-return", "correction_needed", 2, {
        is_vip: true,
        qa_reviewed_at: new Date().toISOString(),
        manager_threads: [{ status: "open" }]
      });
      const managerCorrection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/manager-return/drafter/qa-response",
        payload: {
          actor: { email: "tech@example.test", name: "Tech" },
          thread_scope: "manager",
          threads: [{ status: "fixed" }]
        }
      });
      assert.equal(managerCorrection.statusCode, 200, managerCorrection.body);
      assert.equal(managerCorrection.json().next_status, "awaiting_manager_review");
      assert.equal(Boolean(managerCorrection.json().manifest.qa_claimed_by_email), false);

      await saveProject("concurrent-return", "correction_needed", 2, {
        correction_requested_by: originalQa.email
      });
      const concurrentCorrection = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/concurrent-return/drafter/qa-response",
        payload: { actor: { email: "tech@example.test", name: "Tech" }, threads: [] }
      });
      assert.equal(concurrentCorrection.statusCode, 200, concurrentCorrection.body);
      await storage.patchManifest("concurrent-return", {
        qa_return_hold_expires_at: new Date(Date.now() - 1_000).toISOString()
      });
      const concurrentClaims = await Promise.all([
        app.inject({
          method: "POST",
          url: "/v1/firstmeasure/projects/concurrent-return/qa/claim",
          payload: { actor: { email: "race-a@example.test", name: "Race A" } }
        }),
        app.inject({
          method: "POST",
          url: "/v1/firstmeasure/projects/concurrent-return/qa/claim",
          payload: { actor: { email: "race-b@example.test", name: "Race B" } }
        })
      ]);
      const concurrentBodies = concurrentClaims.map((response) => response.json());
      assert.equal(concurrentBodies.filter((body) => body.success === true).length, 1);
      assert.equal(concurrentBodies.filter((body) => body.error === "item_claimed_by_other_user").length, 1);

      await saveProject("force-release-claimed", "awaiting_review", 3, {
        qa_claimed_by_email: originalQa.email,
        qa_claimed_by_name: originalQa.name,
        qa_claimed_at: new Date().toISOString(),
        qa_available: true,
        hidden_from_queue: false,
        workflow: {
          assigned_to: null,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: originalQa.email, name: originalQa.name, claimed_at: new Date().toISOString() },
          history: []
        }
      });
      const forceRelease = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/force-release-claimed/qa/release-claim",
        payload: {
          actor: { email: "manager@example.test", name: "Manager", roles: ["manager"] },
          force: true
        }
      });
      assert.equal(forceRelease.statusCode, 200, forceRelease.body);
      assert.equal(forceRelease.json().success, true);
      const forceReleasedManifest = await storage.readManifest("force-release-claimed");
      assert.equal(Boolean((forceReleasedManifest as Record<string, unknown>).qa_claimed_by_email), false);
      assert.equal((forceReleasedManifest as Record<string, unknown>).qa_available, true);
      assert.equal((forceReleasedManifest as Record<string, unknown>).hidden_from_queue, false);

      const stableClaimedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      await saveProject("stable-qa-timer", "awaiting_review", 2, {
        qa_claimed_by_email: originalQa.email,
        qa_claimed_by_name: originalQa.name,
        qa_claimed_at: stableClaimedAt,
        workflow: {
          assigned_to: null,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: originalQa.email, name: originalQa.name, claimed_at: stableClaimedAt },
          history: []
        },
        work_history: [{ ts: stableClaimedAt, event: "qa_claimed", qa_email: originalQa.email }]
      });

      const repeatClaim = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/stable-qa-timer/qa/claim",
        payload: { actor: originalQa }
      });
      assert.equal(repeatClaim.statusCode, 200, repeatClaim.body);
      assert.equal(repeatClaim.json().success, true);

      const heartbeat = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/session/heartbeat",
        payload: { actor: originalQa, current_folder: "stable-qa-timer", active: true }
      });
      assert.equal(heartbeat.statusCode, 200, heartbeat.body);
      assert.equal(heartbeat.json().renewed_claim, true);

      const stableClaim = await storage.readManifest("stable-qa-timer");
      const stableWorkflow = (stableClaim.workflow ?? {}) as Record<string, unknown>;
      const stableWorkflowClaim = (stableWorkflow.qa_claim ?? {}) as Record<string, unknown>;
      assert.equal((stableClaim as Record<string, unknown>).qa_claimed_at, stableClaimedAt);
      assert.equal(stableWorkflowClaim.claimed_at, stableClaimedAt);
      assert.equal(
        ((stableClaim as Record<string, unknown>).work_history as Array<Record<string, unknown>>)
          .filter((event) => event.event === "qa_claimed").length,
        1
      );

      const expiredSessionAt = new Date(Date.now() - 20 * 60_000).toISOString();
      const staleOwner = { email: "stale-owner@example.test", name: "Stale Owner" };
      await internalStorage.saveInternalUser({
        id: staleOwner.email,
        email: staleOwner.email,
        name: staleOwner.name,
        role: "qa",
        last_qa_activity_at: expiredSessionAt,
        // This used to keep the unrelated QA claim alive indefinitely.
        last_activity_at: new Date().toISOString()
      });
      await saveProject("general-activity-ghost", "awaiting_review", 2, {
        qa_claimed_by_email: staleOwner.email,
        qa_claimed_by_name: staleOwner.name,
        qa_claimed_at: expiredSessionAt,
        workflow: {
          assigned_to: null,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: staleOwner.email, name: staleOwner.name, claimed_at: expiredSessionAt },
          history: []
        }
      });

      const staleTakeover = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/general-activity-ghost/qa/claim",
        payload: { actor: otherQa }
      });
      assert.equal(staleTakeover.statusCode, 200, staleTakeover.body);
      assert.equal(staleTakeover.json().success, true,
        "general portal activity must not preserve an expired QA session claim");
      assert.equal(staleTakeover.json().claimed_by, otherQa.email);

      const bootstrapStaleOwner = { email: "bootstrap-stale@example.test", name: "Bootstrap Stale" };
      await internalStorage.saveInternalUser({
        id: bootstrapStaleOwner.email,
        email: bootstrapStaleOwner.email,
        name: bootstrapStaleOwner.name,
        role: "qa",
        last_qa_activity_at: expiredSessionAt,
        last_activity_at: new Date().toISOString()
      });
      await saveProject("bootstrap-stale-ghost", "awaiting_review", 2, {
        qa_claimed_by_email: bootstrapStaleOwner.email,
        qa_claimed_by_name: bootstrapStaleOwner.name,
        qa_claimed_at: expiredSessionAt,
        workflow: {
          assigned_to: null,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: bootstrapStaleOwner.email, name: bootstrapStaleOwner.name, claimed_at: expiredSessionAt },
          history: []
        }
      });
      const cleanupBootstrap = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/bootstrap",
        payload: { actor: otherQa, can_do_qa: true, release_stale: true }
      });
      assert.equal(cleanupBootstrap.statusCode, 200, cleanupBootstrap.body);
      const bootstrapCleaned = await storage.readManifest("bootstrap-stale-ghost");
      assert.equal(Boolean((bootstrapCleaned as Record<string, unknown>).qa_claimed_by_email), false,
        "QA bootstrap must honor its stale-claim cleanup request");

      const indexOwner = { email: "index-owner@example.test", name: "Index Owner" };
      const currentClaimedAt = new Date().toISOString();
      await internalStorage.saveInternalUser({
        id: indexOwner.email,
        email: indexOwner.email,
        name: indexOwner.name,
        role: "qa",
        last_qa_activity_at: currentClaimedAt,
        last_activity_at: currentClaimedAt
      });
      await saveProject("split-claim-index", "awaiting_review", 2, {
        qa_claimed_by_email: indexOwner.email,
        qa_claimed_by_name: indexOwner.name,
        qa_claimed_at: currentClaimedAt,
        workflow: {
          assigned_to: null,
          reserved_to: null,
          correction_to: null,
          qa_claim: { email: indexOwner.email, name: indexOwner.name, claimed_at: currentClaimedAt },
          history: []
        }
      });

      // Simulate the exact split state: the manifest lock survived, while the
      // dashboard/index snapshot says the project is unclaimed.
      const db = index.getFirstMeasureProjectIndexDb();
      const staleIndexRow = db.prepare("SELECT manifest_json FROM projects WHERE id = ?").get("split-claim-index") as { manifest_json: string };
      const staleIndexManifest = JSON.parse(staleIndexRow.manifest_json) as Record<string, unknown>;
      staleIndexManifest.qa_claimed_by_email = null;
      staleIndexManifest.qa_claimed_by_name = null;
      staleIndexManifest.qa_claimed_at = null;
      staleIndexManifest.qa_available = true;
      staleIndexManifest.hidden_from_queue = false;
      staleIndexManifest.workflow = { ...(staleIndexManifest.workflow as Record<string, unknown>), qa_claim: null };
      db.prepare(`
        UPDATE projects
        SET qa_claimed_by_email = '', qa_claimed_by_name = '', manifest_json = ?
        WHERE id = ?
      `).run(JSON.stringify(staleIndexManifest), "split-claim-index");

      const indexedConflict = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/split-claim-index/qa/claim",
        payload: { actor: otherQa }
      });
      assert.equal(indexedConflict.statusCode, 200, indexedConflict.body);
      assert.equal(indexedConflict.json().error, "item_claimed_by_other_user");
      const repairedIndex = db.prepare("SELECT qa_claimed_by_email FROM projects WHERE id = ?").get("split-claim-index") as { qa_claimed_by_email: string };
      assert.equal(repairedIndex.qa_claimed_by_email, indexOwner.email,
        "a valid manifest claim must repair the dashboard index before returning a conflict");

      await saveProject("claim-cache-refresh", "awaiting_review", 2);
      const overviewPayload = { view: "card", include: ["qa"], bucket_limit: 500 };
      const overviewBeforeClaim = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/queue/admin/overview/compat",
        payload: overviewPayload
      });
      assert.equal(overviewBeforeClaim.statusCode, 200, overviewBeforeClaim.body);
      const beforeClaimRow = overviewBeforeClaim.json().qa.find((row: Record<string, unknown>) => row.id === "claim-cache-refresh");
      assert.equal(String(beforeClaimRow?.qa_claimed_by_email ?? ""), "");

      const cacheRefreshClaim = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/claim-cache-refresh/qa/claim",
        payload: { actor: originalQa }
      });
      assert.equal(cacheRefreshClaim.statusCode, 200, cacheRefreshClaim.body);
      assert.equal(cacheRefreshClaim.json().success, true);

      const overviewAfterClaim = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/queue/admin/overview/compat",
        payload: overviewPayload
      });
      const afterClaimRow = overviewAfterClaim.json().qa.find((row: Record<string, unknown>) => row.id === "claim-cache-refresh");
      assert.equal(afterClaimRow?.qa_claimed_by_email, originalQa.email,
        "claiming a project must invalidate the cached queue snapshot immediately");

      const cacheRefreshRelease = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/projects/claim-cache-refresh/qa/release-claim",
        payload: { actor: originalQa, reason: "test_release" }
      });
      assert.equal(cacheRefreshRelease.statusCode, 200, cacheRefreshRelease.body);
      const overviewAfterRelease = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/queue/admin/overview/compat",
        payload: overviewPayload
      });
      const afterReleaseRow = overviewAfterRelease.json().qa.find((row: Record<string, unknown>) => row.id === "claim-cache-refresh");
      assert.equal(String(afterReleaseRow?.qa_claimed_by_email ?? ""), "",
        "releasing a project must invalidate the cached queue snapshot immediately");

      await saveProject("scoped-release-current", "awaiting_review", 2);
      await saveProject("scoped-release-other-tab", "awaiting_review", 2);
      for (const projectId of ["scoped-release-current", "scoped-release-other-tab"]) {
        const claim = await app.inject({
          method: "POST",
          url: `/v1/firstmeasure/projects/${projectId}/qa/claim`,
          payload: { actor: originalQa }
        });
        assert.equal(claim.statusCode, 200, claim.body);
        assert.equal(claim.json().success, true);
      }
      const scopedRelease = await app.inject({
        method: "POST",
        url: "/v1/firstmeasure/qa/session/release",
        payload: {
          actor: originalQa,
          reason: "left_qa_view",
          project_ids: ["scoped-release-current"]
        }
      });
      assert.equal(scopedRelease.statusCode, 200, scopedRelease.body);
      assert.equal(scopedRelease.json().released, 1);
      assert.equal(qaClaimOwner(await storage.readManifest("scoped-release-current")), "");
      assert.equal(qaClaimOwner(await storage.readManifest("scoped-release-other-tab")), originalQa.email,
        "leaving QA in one tab must not release a project owned by another tab");

      const activityUser = "concurrent-activity@example.test";
      await internalStorage.saveInternalUser({
        id: activityUser,
        email: activityUser,
        name: "Concurrent Activity",
        role: "qa"
      });
      await Promise.all(Array.from({ length: 20 }, (_, indexValue) => (
        internalStorage.patchInternalUser(activityUser, { [`activity_marker_${indexValue}`]: true })
      )));
      const patchedActivityUser = await internalStorage.readInternalUser(activityUser) as Record<string, unknown>;
      for (let indexValue = 0; indexValue < 20; indexValue += 1) {
        assert.equal(patchedActivityUser[`activity_marker_${indexValue}`], true,
          "concurrent activity patches must not erase fields written by another heartbeat");
      }
    } finally {
      await app.close();
      await index.closeFirstMeasureProjectIndex();
    }
  } finally {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("firstmeasure-qa-return-test-")) {
      throw new Error(`Refusing to remove unexpected test path '${resolved}'.`);
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

function qaClaimOwner(manifest: ProjectManifest) {
  const raw = manifest as Record<string, unknown>;
  const workflow = raw.workflow && typeof raw.workflow === "object"
    ? raw.workflow as Record<string, unknown>
    : {};
  const claim = workflow.qa_claim && typeof workflow.qa_claim === "object"
    ? workflow.qa_claim as Record<string, unknown>
    : {};
  return String(raw.qa_claimed_by_email ?? claim.email ?? "").trim().toLowerCase();
}
