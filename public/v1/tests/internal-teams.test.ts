import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let root = "";

async function request(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
  expectedStatus = 200,
  internalUserEmail = "admin@example.test"
) {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: { "x-internal-user-email": internalUserEmail }
  });
  assert.equal(response.statusCode, expectedStatus, response.body);
  return response.json();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-team-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.MEASURE_INTERNAL_ROOT = path.join(root, "measure", "internal");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(root, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  // The FirstMeasure SQLite WAL can remain briefly locked on Windows after Fastify closes.
  // Clean the stores owned by this test and leave that OS-temporary directory for normal cleanup.
  if (root) {
    for (const directory of ["platform", "internal", "measure", "pricebook"]) {
      await rm(path.join(root, directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

test("internal teams persist names, managers, stats, and tracked assignments", async () => {
  const missingEmail = await request("POST", "/v1/internal/users", {
    name: "Should Not Persist",
    role: "technician"
  }, 400);
  assert.equal(missingEmail.error, "missing_email");
  const invalidEmail = await request("POST", "/v1/internal/users", {
    email: "not-an-email",
    name: "Also Should Not Persist",
    role: "technician"
  }, 400);
  assert.equal(invalidEmail.error, "invalid_email");
  const emptyUsers = await request("GET", "/v1/internal/users");
  assert.equal(emptyUsers.count, 0);

  const manager = await request("POST", "/v1/internal/users", {
    email: "manager@example.test",
    name: "Morgan Manager",
    role: "manager",
    team_id: "default",
    training_complete: true
  }, 201);
  assert.equal(manager.user.team_id, "");

  const qa = await request("POST", "/v1/internal/users", {
    email: "qa@example.test",
    name: "Quinn QA",
    role: "qa",
    training_complete: true
  }, 201);
  const technician = await request("POST", "/v1/internal/users", {
    email: "tech@example.test",
    name: "Taylor Tech",
    role: "technician",
    training_complete: true
  }, 201);

  const created = await request("POST", "/v1/internal/teams", {
    name: "Morgan's Team",
    manager_user_ids: [manager.user.id]
  }, 201);
  assert.equal(created.team.name, "Morgan's Team");
  assert.deepEqual(created.team.manager_user_ids, [manager.user.id]);

  const managerAfter = await request("GET", `/v1/internal/users/${manager.user.id}`);
  assert.equal(managerAfter.user.team_id, created.team.id);
  assert.equal(managerAfter.user.team_assignment_history.at(-1).to_team_id, created.team.id);
  assert.equal(managerAfter.user.team_assignment_history.at(-1).changed_by, "admin@example.test");

  const assignedQa = await request("PATCH", `/v1/internal/users/${qa.user.id}`, { team_id: created.team.id });
  assert.equal(assignedQa.user.team_id, created.team.id);
  assert.equal(assignedQa.user.team_assignment_history.at(-1).from_team_id, null);

  const renamed = await request("PUT", `/v1/internal/teams/${created.team.id}`, {
    name: "North Production",
    manager_user_ids: [manager.user.id]
  });
  assert.equal(renamed.team.id, created.team.id);
  assert.equal(renamed.team.name, "North Production");

  const teams = await request("GET", "/v1/internal/teams");
  assert.equal(teams.count, 1);
  assert.equal(teams.teams[0].name, "North Production");
  assert.deepEqual(teams.teams[0].stats, { members: 2, managers: 1, qas: 1, technicians: 0 });
  assert.deepEqual(teams.unassigned_stats, { members: 1, managers: 0, qas: 0, technicians: 1 });

  await request("PATCH", `/v1/internal/users/${technician.user.id}`, { team_id: created.team.id });
  const otherTeam = await request("POST", "/v1/internal/teams", { name: "South Production" }, 201);

  await request("POST", "/v1/firstmeasure/projects", {
    id: "team-leaderboard-project",
    address: "123 Team Test Way",
    complexity: 3,
    team_ref: { id: created.team.id },
    workflow: {
      assigned_to: { email: "tech@example.test", name: "Taylor Tech" }
    }
  }, 201);
  await request("PATCH", "/v1/firstmeasure/projects/team-leaderboard-project", {
    assigned_to_email: "tech@example.test",
    assigned_to_name: "Taylor Tech"
  });
  await request("POST", "/v1/firstmeasure/projects/team-leaderboard-project/status", { status: "in_progress" });
  const activeProjects = await request("POST", "/v1/internal/legacy-action", {
    action: "my_active_projects",
    actor: { email: "tech@example.test", name: "Taylor Tech" }
  }, 200, "tech@example.test");
  assert.equal(activeProjects.count, 1);
  assert.equal(activeProjects.projects[0].id, "team-leaderboard-project");

  const resumedProject = await request("POST", "/v1/internal/legacy-action", {
    action: "claim_next_for_me",
    actor: { email: "tech@example.test", name: "Taylor Tech" }
  }, 200, "tech@example.test");
  assert.equal(resumedProject.resumed, true);
  assert.equal(resumedProject.folder, "team-leaderboard-project");
  await request("POST", "/v1/firstmeasure/projects/team-leaderboard-project/status", { status: "completed" });

  await request("POST", "/v1/firstmeasure/projects", {
    id: "team-qa-stats-project",
    address: "456 QA Stats Way",
    complexity: 2,
    team_ref: { id: created.team.id }
  }, 201);
  await request("PATCH", "/v1/firstmeasure/projects/team-qa-stats-project", {
    qa_approved_by: "qa@example.test",
    qa_approved_by_name: "Quinn QA",
    qa_approved_at: new Date().toISOString()
  });
  await request("POST", "/v1/firstmeasure/projects/team-qa-stats-project/status", { status: "awaiting_manager_review" });

  const qaShiftDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const qaShiftLeaderboard = await request("POST", "/v1/firstmeasure/qa/leaderboard", {
    actor: { email: "qa@example.test", name: "Quinn QA", roles: ["qa"] },
    team_id: created.team.id,
    date: qaShiftDate,
    force: true
  }, 200, "qa@example.test");
  assert.equal(qaShiftLeaderboard.timezone, "America/Los_Angeles");
  assert.equal(qaShiftLeaderboard.leaderboard[0].email, "qa@example.test");
  assert.equal(qaShiftLeaderboard.leaderboard[0].points, 3);
  assert.equal(qaShiftLeaderboard.leaderboard[0].shift_count, 1);

  const teamLeaderboard = await request("POST", "/v1/internal/legacy-action", {
    action: "technician_leaderboard",
    team: created.team.id
  });
  assert.equal(teamLeaderboard.source, "project_index");
  assert.equal(teamLeaderboard.cached, false);
  assert.equal(teamLeaderboard.timezone, "America/Los_Angeles");
  assert.equal(teamLeaderboard.leaderboard.length, 1);
  assert.equal(teamLeaderboard.leaderboard[0].email, "tech@example.test");
  assert.equal(teamLeaderboard.leaderboard[0].points, 4);
  assert.equal(teamLeaderboard.qa_stats.length, 1);
  assert.equal(teamLeaderboard.qa_stats[0].email, "qa@example.test");
  assert.equal(teamLeaderboard.qa_stats[0].approved_count, 1);
  assert.equal(teamLeaderboard.qa_stats[0].points, 3);

  const cachedLeaderboard = await request("POST", "/v1/internal/legacy-action", {
    action: "technician_leaderboard",
    team: created.team.id
  });
  assert.equal(cachedLeaderboard.cached, true);

  const isolatedLeaderboard = await request("POST", "/v1/internal/legacy-action", {
    action: "technician_leaderboard",
    team: otherTeam.team.id
  });
  assert.deepEqual(isolatedLeaderboard.leaderboard, []);

  const allLeaderboard = await request("POST", "/v1/internal/legacy-action", {
    action: "technician_leaderboard",
    team: "all"
  });
  assert.equal(allLeaderboard.leaderboard.some((row: { email: string }) => row.email === "tech@example.test"), true);

  // Team leaderboards follow the employee's current roster assignment, not
  // the historical team retained by projects they already completed.
  await request("PATCH", `/v1/internal/users/${technician.user.id}`, { team_id: otherTeam.team.id });
  const previousTeamAfterMove = await request("POST", "/v1/internal/legacy-action", {
    action: "technician_leaderboard",
    team: created.team.id,
    force: true
  });
  assert.equal(previousTeamAfterMove.leaderboard.some((row: { email: string }) => row.email === "tech@example.test"), false);
  const currentTeamAfterMove = await request("POST", "/v1/internal/legacy-action", {
    action: "technician_leaderboard",
    team: otherTeam.team.id,
    force: true
  });
  assert.equal(currentTeamAfterMove.leaderboard.some((row: { email: string }) => row.email === "tech@example.test"), true);
  await request("PATCH", `/v1/internal/users/${technician.user.id}`, { team_id: created.team.id });

  const queueTeams = await request("GET", "/v1/internal/queue/admin-teams");
  assert.deepEqual(queueTeams.teams, [
    { id: created.team.id, label: "North Production" },
    { id: otherTeam.team.id, label: "South Production" }
  ]);

  const invalidTeam = await request("PATCH", `/v1/internal/users/${qa.user.id}`, { team_id: "missing-team" }, 400);
  assert.equal(invalidTeam.error, "internal_team_not_found");

  const storage = await import("../internal/storage.js");
  const legacyUser = await storage.saveInternalUser({
    email: "legacy-team@example.test",
    name: "Legacy Team User",
    role: "technician",
    team_id: "Legacy West Team"
  });
  const migratedTeams = await request("GET", "/v1/internal/teams");
  assert.equal(migratedTeams.teams.some((team: { id: string; name: string }) => team.id === "legacy-west-team" && team.name === "Legacy West Team"), true);
  const migratedUser = await request("GET", `/v1/internal/users/${legacyUser.id}`);
  assert.equal(migratedUser.user.team_id, "legacy-west-team");
  assert.equal(migratedUser.user.team_assignment_history.at(-1).changed_by, "system:team-migration");
});
