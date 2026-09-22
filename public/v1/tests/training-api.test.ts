import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type Json = Record<string, any>;
type TestClient = ReturnType<typeof createSessionClient>;

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    let data: any = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-training-api-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeTrainingDatabase } = await import("../training/storage.js");
  (await closeTrainingDatabase());
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    email: `training-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Training Test Owner",
    phone: nextTestPhone(),
    company: "Training API Test Org",
    organization_id: `org_training_${suffix}`
  });
  // Operator rollout is explicit in this platform fixture; customer owners cannot enable it.
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(String(registered.organization.id), { "platform.expanded_access": true });
  return { orgId: String(registered.organization.id), suffix, userId: String(registered.user.id) };
}

async function createCrewUser(owner: TestClient, orgId: string, suffix: string) {
  const email = `training-crew-${suffix}@example.test`;
  const password = "crew training password";
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: "Morgan Member", status: "active", role: "viewer", send_invite: false }
  });
  const userId = String(created.document.id);
  await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    access_role_ids: ["crew_member"],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: "crew_member", permissions: {} }
    }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client };
}

async function createSalesUser(owner: TestClient, orgId: string, suffix: string) {
  const email = `training-sales-${suffix}@example.test`;
  const password = "sales training password";
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: "Sam Salesperson", status: "active", role: "salesperson", send_invite: false }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId: String(created.document.id), client };
}

function passingResultFor(lesson: Json) {
  const required = (lesson.steps || []).filter((step: Json) => step?.config?.required === true);
  return required.map((step: Json) => ({
    step_id: String(step.id),
    kind: String(step.kind),
    practice: false,
    passed: true,
    score_percent: 100,
    correct_count: 3,
    total_count: 3
  }));
}

test("training: seeding, viewer flow, gating, rewards, assignments, manual unlocks", async () => {
  const owner = createSessionClient();
  const { orgId, suffix, userId: ownerId } = await registerOwner(owner);
  const crew = await createCrewUser(owner, orgId, suffix);
  const sales = await createSalesUser(owner, orgId, suffix);

  /* Seeded studio library */
  const managed = await owner.request("GET", `/v1/training/organizations/${orgId}/manage/courses`);
  assert.equal(managed.courses.length, 2);
  const titles = managed.courses.map((course: Json) => course.title);
  assert.ok(titles.includes("Roof Installation 101"));
  assert.ok(titles.includes("Sales 101"));
  const decks = await owner.request("GET", `/v1/training/organizations/${orgId}/manage/decks`);
  assert.equal(decks.decks.length, 2);
  assert.ok(decks.decks.every((deck: Json) => String(deck.course_id || "").length > 0), "seeded decks belong to a course");
  const quizzes = await owner.request("GET", `/v1/training/organizations/${orgId}/manage/quizzes`);
  assert.equal(quizzes.quizzes.length, 2);
  assert.ok(quizzes.quizzes.every((quiz: Json) => String(quiz.course_id || "").length > 0), "seeded quizzes belong to a course");
  const assignments = await owner.request("GET", `/v1/training/organizations/${orgId}/manage/assignments`);
  const assignmentFor = (courseTitle: string, roleId: string) => {
    const course = managed.courses.find((entry: Json) => entry.title === courseTitle);
    return assignments.assignments.some((assignment: Json) => (
      assignment.subject_kind === "course"
      && assignment.subject_id === course.id
      && assignment.target_kind === "role"
      && assignment.target_id === roleId
    ));
  };
  assert.ok(assignmentFor("Roof Installation 101", "crew_member"));
  assert.ok(assignmentFor("Roof Installation 101", "crew_foreman"));
  assert.ok(assignmentFor("Sales 101", "salesperson"));
  assert.ok(assignmentFor("Sales 101", "sales_manager"));
  assert.ok(!assignments.assignments.some((assignment: Json) => assignment.subject_kind === "course" && assignment.target_kind === "everyone"));
  const roofDeckList = await owner.request("GET", `/v1/training/organizations/${orgId}/manage/decks?course_id=${decks.decks.find((deck: Json) => deck.title === "Roofing Tools & Terms").course_id}`);
  assert.equal(roofDeckList.decks.length, 1, "course_id filter narrows manage list");

  /* Crew cannot touch manage endpoints */
  const forbidden = await crew.client.raw("GET", `/v1/training/organizations/${orgId}/manage/courses`);
  assert.equal(forbidden.statusCode, 403);

  /* Viewer: seeded courses follow the person's role. */
  const myCourses = await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses`);
  assert.deepEqual(myCourses.courses.map((course: Json) => course.title), ["Roof Installation 101"]);
  const salesCourses = await sales.client.request("GET", `/v1/training/organizations/${orgId}/me/courses`);
  assert.deepEqual(salesCourses.courses.map((course: Json) => course.title), ["Sales 101"]);
  const roofSummary = myCourses.courses.find((course: Json) => course.title === "Roof Installation 101");
  assert.equal(roofSummary.percent_complete, 0);
  assert.equal(roofSummary.lessons[0].state, "current");
  assert.equal(roofSummary.lessons[1].state, "locked");

  const roof = (await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses/${roofSummary.id}`)).course;
  assert.ok(Array.isArray(roof.lessons[0].steps), "unlocked lesson includes step content");
  assert.equal(roof.lessons[2].steps, undefined, "locked lessons hide content");

  /* Locked lesson cannot be completed */
  const lockedAttempt = await crew.client.raw("POST", `/v1/training/organizations/${orgId}/me/courses/${roof.id}/lessons/${roof.lessons[1].id}/complete`, { results: [] });
  assert.equal(lockedAttempt.statusCode, 403);

  /* Required test must be passed */
  const missingTest = await crew.client.raw("POST", `/v1/training/organizations/${orgId}/me/courses/${roof.id}/lessons/${roof.lessons[0].id}/complete`, { results: [] });
  assert.equal(missingTest.statusCode, 400);

  /* Per-course decks/quizzes: visible with course grouping; locked until
   * their unlock lesson is completed. */
  const myDecksBefore = await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/decks`);
  assert.equal(myDecksBefore.decks.length, 1, "only decks from the assigned roofing course are listed");
  const roofDeck = myDecksBefore.decks.find((deck: Json) => deck.title === "Roofing Tools & Terms");
  assert.equal(roofDeck.locked, false, "immediate deck is unlocked");
  assert.ok(String(roofDeck.course_title).includes("Roof"), "deck carries its course title");
  const salesDecksBefore = await sales.client.request("GET", `/v1/training/organizations/${orgId}/me/decks`);
  const objectionDeckBefore = salesDecksBefore.decks.find((deck: Json) => deck.title === "Objection Handling");
  assert.equal(objectionDeckBefore.locked, true, "lesson-gated deck starts locked");
  assert.ok(String(objectionDeckBefore.unlock_hint).includes("Objection Handling") || String(objectionDeckBefore.unlock_hint).includes("Finish"), "locked deck explains how to unlock");
  const lockedDeckFetch = await sales.client.raw("GET", `/v1/training/organizations/${orgId}/me/decks/${objectionDeckBefore.id}`);
  assert.equal(lockedDeckFetch.statusCode, 403, "locked deck cannot be opened standalone");

  const myQuizzesBefore = await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/quizzes`);
  assert.equal(myQuizzesBefore.quizzes.length, 1);
  assert.ok(myQuizzesBefore.quizzes.every((quiz: Json) => quiz.locked === true), "both quizzes gated behind lessons at the start");

  /* Complete lesson 1 properly → progress + next unlock + safety quiz unlocks */
  const completed = await crew.client.request("POST", `/v1/training/organizations/${orgId}/me/courses/${roof.id}/lessons/${roof.lessons[0].id}/complete`, {
    results: passingResultFor(roof.lessons[0])
  });
  assert.equal(completed.course.completed_count, 1);
  assert.equal(completed.course.lessons[0].state, "completed");
  assert.equal(completed.course.lessons[1].state, "current");
  const quizzesAfterLesson = await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/quizzes`);
  const safetyQuiz = quizzesAfterLesson.quizzes.find((quiz: Json) => quiz.title === "Roofing Safety Refresher");
  assert.equal(safetyQuiz.locked, false, "safety quiz unlocks after its lesson");

  const salesSummary = salesCourses.courses.find((course: Json) => course.title === "Sales 101");
  let salesCourse = (await sales.client.request("GET", `/v1/training/organizations/${orgId}/me/courses/${salesSummary.id}`)).course;
  for (let i = 0; i < 3; i++) {
    const lesson = salesCourse.lessons[i];
    const response = await sales.client.request("POST", `/v1/training/organizations/${orgId}/me/courses/${salesCourse.id}/lessons/${lesson.id}/complete`, {
      results: passingResultFor(lesson)
    });
    salesCourse = response.course;
  }
  const myDecksAfter = await sales.client.request("GET", `/v1/training/organizations/${orgId}/me/decks`);
  const objectionDeckAfter = myDecksAfter.decks.find((deck: Json) => deck.title === "Objection Handling");
  assert.equal(objectionDeckAfter.locked, false, "deck unlocks once its lesson is done");

  /* Standalone attempts are recorded and surface best score */
  const quizId = safetyQuiz.id;
  await crew.client.request("POST", `/v1/training/organizations/${orgId}/me/attempts`, {
    subject_kind: "quiz", subject_id: quizId, practice: false, passed: true, score_percent: 83, correct_count: 5, total_count: 6
  });
  const refreshedQuizzes = await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/quizzes`);
  assert.equal(refreshedQuizzes.quizzes.find((quiz: Json) => quiz.id === quizId).best_score_percent, 83);

  /* Role-scoped assignment: crew_member course invisible to the owner */
  const roleCourse = (await owner.request("POST", `/v1/training/organizations/${orgId}/manage/courses`, {
    title: "Crew Only Safety Drill",
    description: "Role-scoped",
    status: "published",
    settings: { progression: "sequential" },
    lessons: [{ title: "Drill", summary: "", unlock: { mode: "previous", available_on: "" }, steps: [{ kind: "content", title: "Drill", config: { blocks: [{ type: "text", body: "Drill." }] } }], reward_deck_ids: [], reward_quiz_ids: [] }]
  })).course;
  await owner.request("POST", `/v1/training/organizations/${orgId}/manage/assignments`, {
    subject_kind: "course", subject_id: roleCourse.id, target_kind: "role", target_id: "crew_member", schedule: {}
  });
  const crewCourses = await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses`);
  assert.ok(crewCourses.courses.some((course: Json) => course.id === roleCourse.id), "crew member sees role-assigned course");
  const ownerCourses = await owner.request("GET", `/v1/training/organizations/${orgId}/me/courses`);
  assert.ok(!ownerCourses.courses.some((course: Json) => course.id === roleCourse.id), "owner does not get crew-role course");

  /* Manual unlock flow */
  const manualCourse = (await owner.request("POST", `/v1/training/organizations/${orgId}/manage/courses`, {
    title: "Manual Unlock Course",
    description: "",
    status: "published",
    settings: { progression: "sequential" },
    lessons: [
      { title: "Intro", summary: "", unlock: { mode: "previous", available_on: "" }, steps: [{ kind: "content", title: "Intro", config: { blocks: [] } }], reward_deck_ids: [], reward_quiz_ids: [] },
      { title: "Held Back", summary: "", unlock: { mode: "manual", available_on: "" }, steps: [{ kind: "content", title: "Held", config: { blocks: [] } }], reward_deck_ids: [], reward_quiz_ids: [] }
    ]
  })).course;
  await owner.request("POST", `/v1/training/organizations/${orgId}/manage/assignments`, {
    subject_kind: "course", subject_id: manualCourse.id, target_kind: "user", target_id: crew.userId, schedule: {}
  });
  let manual = (await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses/${manualCourse.id}`)).course;
  await crew.client.request("POST", `/v1/training/organizations/${orgId}/me/courses/${manual.id}/lessons/${manual.lessons[0].id}/complete`, { results: [] });
  manual = (await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses/${manualCourse.id}`)).course;
  assert.equal(manual.lessons[1].state, "locked", "manual lesson stays locked after previous completes");
  await owner.request("POST", `/v1/training/organizations/${orgId}/manage/courses/${manual.id}/lessons/${manual.lessons[1].id}/unlock`, { user_id: crew.userId });
  manual = (await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses/${manualCourse.id}`)).course;
  assert.equal(manual.lessons[1].state, "current", "manual unlock opens the lesson");

  /* Date-gated lesson stays locked until the date */
  const futureCourse = (await owner.request("POST", `/v1/training/organizations/${orgId}/manage/courses`, {
    title: "Scheduled Course",
    description: "",
    status: "published",
    settings: { progression: "free" },
    lessons: [
      { title: "Future", summary: "", unlock: { mode: "date", available_on: "2099-01-01" }, steps: [], reward_deck_ids: [], reward_quiz_ids: [] },
      { title: "Past", summary: "", unlock: { mode: "date", available_on: "2020-01-01" }, steps: [], reward_deck_ids: [], reward_quiz_ids: [] }
    ]
  })).course;
  await owner.request("POST", `/v1/training/organizations/${orgId}/manage/assignments`, {
    subject_kind: "course", subject_id: futureCourse.id, target_kind: "everyone", target_id: "", schedule: {}
  });
  const scheduled = (await crew.client.request("GET", `/v1/training/organizations/${orgId}/me/courses/${futureCourse.id}`)).course;
  assert.equal(scheduled.lessons[0].state, "locked");
  assert.ok(String(scheduled.lessons[0].lock_reason).includes("2099-01-01"));
  assert.equal(scheduled.lessons[1].state, "current");

  /* Progress report reflects crew completions */
  const report = (await owner.request("GET", `/v1/training/organizations/${orgId}/manage/courses/${roof.id}/progress`)).report;
  const crewRow = report.users.find((row: Json) => row.user_id === crew.userId);
  assert.equal(crewRow.completed_count, 1);

  /* Existing organizations: untouched legacy seed assignments migrate, while
   * an administrator-created everyone assignment remains intact. */
  const roofManaged = managed.courses.find((course: Json) => course.title === "Roof Installation 101");
  const salesManaged = managed.courses.find((course: Json) => course.title === "Sales 101");
  const beforeMigration = (await owner.request("GET", `/v1/training/organizations/${orgId}/manage/assignments`)).assignments;
  for (const assignment of beforeMigration.filter((entry: Json) => entry.subject_id === roofManaged.id)) {
    await owner.request("DELETE", `/v1/training/organizations/${orgId}/manage/assignments/${assignment.id}`);
  }
  const { createAssignment, listAssignments } = await import("../training/storage.js");
  const { ensureTrainingSeed } = await import("../training/service.js");
  (await createAssignment(orgId, {
    subject_kind: "course", subject_id: roofManaged.id, target_kind: "everyone", target_id: "", schedule: {}, created_by: ""
  }));
  await owner.request("POST", `/v1/training/organizations/${orgId}/manage/assignments`, {
    subject_kind: "course", subject_id: salesManaged.id, target_kind: "everyone", target_id: "", schedule: {}
  });
  (await ensureTrainingSeed(orgId));
  const migrated = (await listAssignments(orgId, { subjectKind: "course" }));
  const roofAssignments = migrated.filter((entry: Json) => entry.subject_id === roofManaged.id);
  assert.ok(!roofAssignments.some((entry: Json) => entry.target_kind === "everyone"), "untouched seeded everyone assignment is removed");
  assert.ok(roofAssignments.some((entry: Json) => entry.target_kind === "role" && entry.target_id === "crew_member"));
  assert.ok(roofAssignments.some((entry: Json) => entry.target_kind === "role" && entry.target_id === "crew_foreman"));
  assert.ok(migrated.some((entry: Json) => (
    entry.subject_id === salesManaged.id && entry.target_kind === "everyone" && entry.created_by === ownerId
  )), "administrator-created everyone assignment is preserved");
  assert.ok(ownerId);
});
