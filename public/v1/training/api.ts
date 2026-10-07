import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { requirePlatformAuth, hasResourcePermission, hasPermission, assertResourcePermission, type PlatformAuthContext } from "../platform/auth.js";
import { PlatformError, forbidden, notFound } from "../platform/errors.js";
import {
  completeLessonSchema,
  createAssignmentSchema,
  manualUnlockSchema,
  recordAttemptSchema,
  saveCourseSchema,
  saveDeckSchema,
  saveQuizSchema,
  updateAssignmentSchema
} from "./schemas.js";
import {
  completeLesson,
  courseProgressReport,
  ensureTrainingSeed,
  listMyCourses,
  listMyDecks,
  listMyQuizzes,
  readMyCourse,
  readMyDeck,
  readMyQuiz,
  recordStandaloneAttempt,
  type ViewerIdentity
} from "./service.js";
import {
  archiveCourse,
  archiveDeck,
  archiveQuiz,
  createAssignment,
  deleteAssignment,
  grantManualUnlock,
  listAssignments,
  listCourses,
  listDecks,
  listQuizzes,
  newId,
  readCourse,
  readDeck,
  readQuiz,
  revokeManualUnlock,
  saveCourse,
  saveDeck,
  saveQuiz,
  updateAssignment
} from "./storage.js";

const VIEWER_APPLICATIONS = ["management", "field"];
const MANAGE_PERMISSION = "manage_training|manage_company_settings";

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

function viewerFrom(ctx: PlatformAuthContext): ViewerIdentity {
  const roleIds = new Set<string>();
  for (const roleId of ctx.accessProfile?.access_role_ids ?? []) {
    const value = String(roleId ?? "").trim();
    if (value) roleIds.add(value);
  }
  const legacyRole = String(ctx.role ?? "").trim();
  if (legacyRole) roleIds.add(legacyRole);
  return { userId: ctx.userId, roleIds: [...roleIds] };
}

async function requireViewer(request: Parameters<typeof requirePlatformAuth>[0], orgId: string) {
  return requirePlatformAuth(request, { orgId, application: VIEWER_APPLICATIONS, capability: "apps.training" });
}

async function requireManager(request: Parameters<typeof requirePlatformAuth>[0], orgId: string, options: { csrf?: boolean; scoped?: boolean } = {}) {
  return requirePlatformAuth(request, { orgId, permission: MANAGE_PERMISSION, allowScopedPermission:options.scoped === true || options.csrf !== true, csrf: options.csrf === true, capability: "training.studio" });
}
function canManageAssignment(ctx:PlatformAuthContext, assignment:Record<string,unknown>) {
  if(assignment.target_kind==='department')return hasResourcePermission(ctx,MANAGE_PERMISSION,{department_id:assignment.target_id});
  if(assignment.target_kind==='user')return hasResourcePermission(ctx,MANAGE_PERMISSION,{department_ids:ctx.organizationStructure?.users.find(user=>user.id===assignment.target_id)?.department_ids||[]});
  return hasPermission(ctx,MANAGE_PERMISSION);
}
async function assertAssignment(ctx:PlatformAuthContext,id:string){
  const assignment=(await listAssignments(ctx.orgId)).find(entry=>entry.id===id);
  if(!assignment)throw notFound('training_assignment_not_found','Assignment was not found.');
  if(!canManageAssignment(ctx,assignment))throw forbidden('training_department_denied','This assignment is outside your authorized departments.');
}

export const registerTrainingApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({ ok: true, api: "training" }));

  /* Viewer ("me") surface — management and field users. */

  app.get("/organizations/:orgId/me/courses", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    const courses = (await listMyCourses(orgId, viewerFrom(ctx)));
    return { ok: true, courses, count: courses.length };
  });

  app.get("/organizations/:orgId/me/courses/:courseId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    return { ok: true, course: (await readMyCourse(orgId, viewerFrom(ctx), getParam(request.params, "courseId"))) };
  });

  app.post("/organizations/:orgId/me/courses/:courseId/lessons/:lessonId/complete", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: VIEWER_APPLICATIONS, csrf: true });
    const body = completeLessonSchema.parse({ ...(request.body as object ?? {}), course_id: getParam(request.params, "courseId") });
    return { ok: true, ...(await completeLesson(orgId, viewerFrom(ctx), body.course_id, getParam(request.params, "lessonId"), body)) };
  });

  app.get("/organizations/:orgId/me/decks", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    const decks = (await listMyDecks(orgId, viewerFrom(ctx)));
    return { ok: true, decks, count: decks.length };
  });

  app.get("/organizations/:orgId/me/decks/:deckId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    return { ok: true, deck: (await readMyDeck(orgId, viewerFrom(ctx), getParam(request.params, "deckId"))) };
  });

  app.get("/organizations/:orgId/me/quizzes", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    const quizzes = (await listMyQuizzes(orgId, viewerFrom(ctx)));
    return { ok: true, quizzes, count: quizzes.length };
  });

  app.get("/organizations/:orgId/me/quizzes/:quizId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireViewer(request, orgId);
    return { ok: true, quiz: (await readMyQuiz(orgId, viewerFrom(ctx), getParam(request.params, "quizId"))) };
  });

  app.post("/organizations/:orgId/me/attempts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: VIEWER_APPLICATIONS, csrf: true });
    const body = recordAttemptSchema.parse(request.body ?? {});
    return { ok: true, attempt: (await recordStandaloneAttempt(orgId, viewerFrom(ctx), body)) };
  });

  /* Studio (management) surface. */

  app.get("/organizations/:orgId/manage/courses", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId);
    (await ensureTrainingSeed(orgId));
    const courses = (await listCourses(orgId, { includeArchived: getParam(request.query, "include_archived") === "1" }));
    return { ok: true, courses, count: courses.length };
  });

  app.get("/organizations/:orgId/manage/courses/:courseId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId);
    return { ok: true, course: (await readCourse(orgId, getParam(request.params, "courseId"))) };
  });

  app.put("/organizations/:orgId/manage/courses/:courseId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    const body = saveCourseSchema.parse({ ...(request.body as object ?? {}), id: getParam(request.params, "courseId") });
    const lessons = body.lessons.map((lesson) => ({
      ...lesson,
      id: lesson.id || newId("lesson"),
      steps: lesson.steps.map((step) => ({ ...step, id: step.id || newId("step") }))
    }));
    return { ok: true, course: (await saveCourse(orgId, { ...body, lessons })) };
  });

  app.post("/organizations/:orgId/manage/courses", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    const body = saveCourseSchema.parse(request.body ?? {});
    const lessons = body.lessons.map((lesson) => ({
      ...lesson,
      id: lesson.id || newId("lesson"),
      steps: lesson.steps.map((step) => ({ ...step, id: step.id || newId("step") }))
    }));
    return { ok: true, course: (await saveCourse(orgId, { ...body, id: "", lessons })) };
  });

  app.delete("/organizations/:orgId/manage/courses/:courseId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    return { ok: true, course: (await archiveCourse(orgId, getParam(request.params, "courseId"))) };
  });

  app.get("/organizations/:orgId/manage/decks", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId);
    (await ensureTrainingSeed(orgId));
    const decks = (await listDecks(orgId, { includeArchived: getParam(request.query, "include_archived") === "1", courseId: getParam(request.query, "course_id") }));
    return { ok: true, decks, count: decks.length };
  });

  app.get("/organizations/:orgId/manage/decks/:deckId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId);
    return { ok: true, deck: (await readDeck(orgId, getParam(request.params, "deckId"))) };
  });

  app.put("/organizations/:orgId/manage/decks/:deckId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    const body = saveDeckSchema.parse({ ...(request.body as object ?? {}), id: getParam(request.params, "deckId") });
    const cards = body.cards.map((card) => ({ ...card, id: card.id || newId("card") }));
    return { ok: true, deck: (await saveDeck(orgId, { ...body, cards })) };
  });

  app.post("/organizations/:orgId/manage/decks", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    const body = saveDeckSchema.parse(request.body ?? {});
    const cards = body.cards.map((card) => ({ ...card, id: card.id || newId("card") }));
    return { ok: true, deck: (await saveDeck(orgId, { ...body, id: "", cards })) };
  });

  app.delete("/organizations/:orgId/manage/decks/:deckId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    return { ok: true, deck: (await archiveDeck(orgId, getParam(request.params, "deckId"))) };
  });

  app.get("/organizations/:orgId/manage/quizzes", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId);
    (await ensureTrainingSeed(orgId));
    const quizzes = (await listQuizzes(orgId, { includeArchived: getParam(request.query, "include_archived") === "1", courseId: getParam(request.query, "course_id") }));
    return { ok: true, quizzes, count: quizzes.length };
  });

  app.get("/organizations/:orgId/manage/quizzes/:quizId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId);
    return { ok: true, quiz: (await readQuiz(orgId, getParam(request.params, "quizId"))) };
  });

  app.put("/organizations/:orgId/manage/quizzes/:quizId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    const body = saveQuizSchema.parse({ ...(request.body as object ?? {}), id: getParam(request.params, "quizId") });
    const questions = body.questions.map((question) => ({ ...question, id: question.id || newId("question") }));
    return { ok: true, quiz: (await saveQuiz(orgId, { ...body, questions })) };
  });

  app.post("/organizations/:orgId/manage/quizzes", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    const body = saveQuizSchema.parse(request.body ?? {});
    const questions = body.questions.map((question) => ({ ...question, id: question.id || newId("question") }));
    return { ok: true, quiz: (await saveQuiz(orgId, { ...body, id: "", questions })) };
  });

  app.delete("/organizations/:orgId/manage/quizzes/:quizId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireManager(request, orgId, { csrf: true });
    return { ok: true, quiz: (await archiveQuiz(orgId, getParam(request.params, "quizId"))) };
  });

  /* Assignments. */

  app.get("/organizations/:orgId/manage/assignments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requireManager(request, orgId);
    const assignments = (await listAssignments(orgId, {
      subjectKind: getParam(request.query, "subject_kind"),
      subjectId: getParam(request.query, "subject_id")
    })).filter(assignment=>canManageAssignment(ctx,assignment));
    const departments=ctx.organizationStructure?.catalog.departments.filter(entry=>entry.status!=='archived'&&hasResourcePermission(ctx,MANAGE_PERMISSION,{department_id:entry.id})).map(({id,label})=>({id,label}))||[];
    return { ok: true, assignments, count: assignments.length, departments, department_label:ctx.organizationStructure?.catalog.terminology?.department?.singular || 'Department', organization_wide:hasPermission(ctx,MANAGE_PERMISSION) };
  });

  app.post("/organizations/:orgId/manage/assignments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId, { csrf: true, scoped:true });
    const body = createAssignmentSchema.parse(request.body ?? {});
    if(!canManageAssignment(ctx,body))throw forbidden('training_department_denied','This assignment is outside your authorized departments.');
    return { ok: true, assignment: (await createAssignment(orgId, { ...body, created_by: ctx.userId })) };
  });

  app.patch("/organizations/:orgId/manage/assignments/:assignmentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requireManager(request, orgId, { csrf: true, scoped:true });
    await assertAssignment(ctx,getParam(request.params,'assignmentId'));
    const body = updateAssignmentSchema.parse(request.body ?? {});
    return { ok: true, assignment: (await updateAssignment(orgId, getParam(request.params, "assignmentId"), body)) };
  });

  app.delete("/organizations/:orgId/manage/assignments/:assignmentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requireManager(request, orgId, { csrf: true, scoped:true });
    await assertAssignment(ctx,getParam(request.params,'assignmentId'));
    return { ok: true, ...(await deleteAssignment(orgId, getParam(request.params, "assignmentId"))) };
  });

  /* Progress + manual unlocks. */

  app.get("/organizations/:orgId/manage/courses/:courseId/progress", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requireManager(request, orgId);
    return { ok: true, report: (await courseProgressReport(orgId, getParam(request.params, "courseId"),ctx)) };
  });

  app.post("/organizations/:orgId/manage/courses/:courseId/lessons/:lessonId/unlock", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireManager(request, orgId, { csrf: true, scoped:true });
    const body = manualUnlockSchema.parse(request.body ?? {});
    assertResourcePermission(ctx,MANAGE_PERMISSION,{department_ids:ctx.organizationStructure?.users.find(user=>user.id===body.user_id)?.department_ids||[]});
    (await grantManualUnlock(orgId, getParam(request.params, "courseId"), getParam(request.params, "lessonId"), body.user_id, ctx.userId));
    return { ok: true, report: (await courseProgressReport(orgId, getParam(request.params, "courseId"),ctx)) };
  });

  app.delete("/organizations/:orgId/manage/courses/:courseId/lessons/:lessonId/unlock/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requireManager(request, orgId, { csrf: true, scoped:true });
    assertResourcePermission(ctx,MANAGE_PERMISSION,{department_ids:ctx.organizationStructure?.users.find(user=>user.id===getParam(request.params,'userId'))?.department_ids||[]});
    (await revokeManualUnlock(orgId, getParam(request.params, "courseId"), getParam(request.params, "lessonId"), getParam(request.params, "userId")));
    return { ok: true, report: (await courseProgressReport(orgId, getParam(request.params, "courseId"),ctx)) };
  });
};
