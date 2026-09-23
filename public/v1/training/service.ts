import { badRequest, forbidden } from "../platform/errors.js";
import { SEED_COURSES, SEED_DECKS, SEED_QUIZZES } from "./presets.js";
import {
  getTrainingDatabase,
  countCoursesWithSeedKey,
  createAssignment,
  deleteAssignment,
  listAssignments,
  listAttemptsForUser,
  listCourses,
  listDecks,
  listProgressForCourse,
  listProgressForUser,
  listQuizzes,
  listUnlocksForCourse,
  listUnlocksForUser,
  readCourse,
  readDeck,
  readQuiz,
  recordAttempt,
  recordLessonCompletion,
  saveCourse,
  saveDeck,
  saveQuiz,
  type JsonObject
} from "./storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/* Seeding ------------------------------------------------------------------ */

let seedingOrg = "";

const seededRoleIds = (preset: JsonObject) => asArray(preset.default_role_ids).map(cleanText).filter(Boolean);
const isEmptySchedule = (assignment: JsonObject) => Object.keys(asObject(assignment.schedule)).length === 0;

/* Orgs seeded before decks/quizzes became per-course get their preset
 * materials linked to the right course (and legacy direct assignments for
 * those materials removed) the next time training data is read. This also
 * upgrades the original untouched "everyone" course assignments to the
 * role-based defaults without changing administrator-created assignments. */
async function upgradeSeededMaterials(orgId: string) {
  const courseBySeed = new Map(
    (await listCourses(orgId, { includeArchived: true }))
      .filter((course) => cleanText(course.seed_key))
      .map((course) => [cleanText(course.seed_key), cleanText(course.id)])
  );
  if (!courseBySeed.size) return;
  const seededIds = new Set<string>();
  const upgrade = async (
    presets: JsonObject[],
    rows: JsonObject[],
    save: (orgId: string, input: JsonObject) => Promise<JsonObject>
  ) => {
    for (const row of rows) {
      const seedKey = cleanText(row.seed_key);
      if (!seedKey) continue;
      seededIds.add(cleanText(row.id));
      if (cleanText(row.course_id)) continue;
      const preset = presets.find((entry) => cleanText(entry.seed_key) === seedKey);
      const courseId = preset ? courseBySeed.get(cleanText(preset.course_seed_key)) : "";
      if (!preset || !courseId) continue;
      await save(orgId, { ...row, course_id: courseId, unlock_lesson_id: cleanText(preset.unlock_lesson_id) });
    }
  };
  await upgrade(SEED_DECKS, (await listDecks(orgId, { includeArchived: true })), saveDeck);
  await upgrade(SEED_QUIZZES, (await listQuizzes(orgId, { includeArchived: true })), saveQuiz);
  for (const assignment of (await listAssignments(orgId))) {
    const kind = cleanText(assignment.subject_kind);
    if ((kind === "deck" || kind === "quiz") && seededIds.has(cleanText(assignment.subject_id))) {
      (await deleteAssignment(orgId, cleanText(assignment.id)));
    }
  }
  const courseAssignments = (await listAssignments(orgId, { subjectKind: "course" }));
  for (const preset of SEED_COURSES) {
    const courseId = courseBySeed.get(cleanText(preset.seed_key));
    if (!courseId) continue;
    const assignments = courseAssignments.filter((assignment) => cleanText(assignment.subject_id) === courseId);
    const legacyEveryone = assignments.find((assignment) => (
      cleanText(assignment.target_kind) === "everyone"
      && !cleanText(assignment.target_id)
      && !cleanText(assignment.created_by)
      && isEmptySchedule(assignment)
    ));
    if (!legacyEveryone) continue;
    (await deleteAssignment(orgId, cleanText(legacyEveryone.id)));
    for (const roleId of seededRoleIds(preset)) {
      const alreadyAssigned = assignments.some((assignment) => (
        cleanText(assignment.target_kind) === "role" && cleanText(assignment.target_id) === roleId
      ));
      if (!alreadyAssigned) {
        (await createAssignment(orgId, {
          subject_kind: "course",
          subject_id: courseId,
          target_kind: "role",
          target_id: roleId,
          schedule: {},
          created_by: "training_seed_defaults"
        }));
      }
    }
  }
}

export async function ensureTrainingSeed(orgId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  if (!orgId || seedingOrg === orgId) return;
  if ((await countCoursesWithSeedKey(orgId)) > 0) {
    seedingOrg = orgId;
    try {
      (await upgradeSeededMaterials(orgId));
    } finally {
      seedingOrg = "";
    }
    return;
  }
  if ((await listCourses(orgId, { includeArchived: true })).length > 0) return;
  seedingOrg = orgId;
  try {
    const seedIdMap = new Map<string, string>();
    for (const deck of SEED_DECKS) {
      const saved = (await saveDeck(orgId, { ...deck, course_id: "" }));
      seedIdMap.set(cleanText(deck.seed_key), cleanText(saved.id));
    }
    for (const quiz of SEED_QUIZZES) {
      const saved = (await saveQuiz(orgId, { ...quiz, course_id: "" }));
      seedIdMap.set(cleanText(quiz.seed_key), cleanText(saved.id));
    }
    const mapIds = (ids: unknown) => asArray(ids).map((id) => seedIdMap.get(cleanText(id)) || cleanText(id)).filter(Boolean);
    for (const course of SEED_COURSES) {
      const lessons = asArray(course.lessons).map((lessonValue) => {
        const lesson = { ...asObject(lessonValue) };
        lesson.reward_deck_ids = mapIds(lesson.reward_deck_ids);
        lesson.reward_quiz_ids = mapIds(lesson.reward_quiz_ids);
        lesson.steps = asArray(lesson.steps).map((stepValue) => {
          const step = { ...asObject(stepValue) };
          const config = { ...asObject(step.config) };
          const seedKey = cleanText(config.deck_seed_key);
          if (seedKey) {
            config.deck_id = seedIdMap.get(seedKey) || "";
            delete config.deck_seed_key;
          }
          step.config = config;
          return step;
        });
        return lesson;
      });
      const saved = (await saveCourse(orgId, { ...course, lessons }));
      seedIdMap.set(cleanText(course.seed_key), cleanText(saved.id));
      for (const roleId of seededRoleIds(course)) {
        (await createAssignment(orgId, {
          subject_kind: "course",
          subject_id: saved.id,
          target_kind: "role",
          target_id: roleId,
          schedule: {},
          created_by: "training_seed_defaults"
        }));
      }
    }
    /* Courses now exist, so link each seeded deck/quiz to its home course. */
    for (const deck of SEED_DECKS) {
      const deckId = seedIdMap.get(cleanText(deck.seed_key));
      const courseId = seedIdMap.get(cleanText(deck.course_seed_key));
      if (deckId && courseId) (await saveDeck(orgId, { ...(await readDeck(orgId, deckId)), course_id: courseId }));
    }
    for (const quiz of SEED_QUIZZES) {
      const quizId = seedIdMap.get(cleanText(quiz.seed_key));
      const courseId = seedIdMap.get(cleanText(quiz.course_seed_key));
      if (quizId && courseId) (await saveQuiz(orgId, { ...(await readQuiz(orgId, quizId)), course_id: courseId }));
    }
  } finally {
    seedingOrg = "";
  }

  }));
}

/* Assignment resolution ------------------------------------------------------ */

export type ViewerIdentity = {
  userId: string;
  roleIds: string[];
};

function assignmentMatches(assignment: JsonObject, viewer: ViewerIdentity) {
  const targetKind = cleanText(assignment.target_kind);
  const targetId = cleanText(assignment.target_id);
  if (targetKind === "everyone") return true;
  if (targetKind === "user") return targetId === viewer.userId;
  if (targetKind === "role") return viewer.roleIds.includes(targetId);
  return false;
}

async function assignedSubjects(orgId: string, viewer: ViewerIdentity, subjectKind: string) {
  const matches = new Map<string, JsonObject[]>();
  for (const assignment of (await listAssignments(orgId, { subjectKind }))) {
    if (!assignmentMatches(assignment, viewer)) continue;
    const subjectId = cleanText(assignment.subject_id);
    const list = matches.get(subjectId) || [];
    list.push(assignment);
    matches.set(subjectId, list);
  }
  return matches;
}

/* Course state --------------------------------------------------------------- */

type LessonState = "completed" | "current" | "unlocked" | "locked";

function mergedScheduleOverrides(assignments: JsonObject[]) {
  const merged: Record<string, string> = {};
  for (const assignment of assignments) {
    for (const [lessonId, date] of Object.entries(asObject(assignment.schedule))) {
      const value = cleanText(date);
      if (value) merged[cleanText(lessonId)] = value;
    }
  }
  return merged;
}

function requiredSteps(lesson: JsonObject) {
  return asArray(lesson.steps).map(asObject).filter((step) => asObject(step.config).required === true);
}

export async function computeCourseState(
  orgId: string,
  course: JsonObject,
  viewer: ViewerIdentity,
  assignments: JsonObject[],
  options: { includeContent?: boolean } = {}
) {
  const today = localDateKey();
  const progress = new Map((await listProgressForUser(orgId, viewer.userId, cleanText(course.id))).map((row) => [cleanText(row.lesson_id), row]));
  const manualUnlocks = new Set((await listUnlocksForUser(orgId, viewer.userId, cleanText(course.id))).map((row) => cleanText(row.lesson_id)));
  const overrides = mergedScheduleOverrides(assignments);
  const settings = asObject(course.settings);
  const sequential = cleanText(settings.progression || "sequential") !== "free";

  let previousCompleted = true;
  let currentAssigned = false;
  const lessons = asArray(course.lessons).map(asObject);
  const states = lessons.map((lesson) => {
    const lessonId = cleanText(lesson.id);
    const unlock = asObject(lesson.unlock);
    const mode = cleanText(unlock.mode || "previous");
    const availableOn = cleanText(overrides[lessonId] || unlock.available_on);
    const completedRow = progress.get(lessonId);

    let conditionMet = true;
    let lockReason = "";
    if (mode === "date") {
      conditionMet = !!availableOn && availableOn <= today;
      if (!conditionMet) lockReason = availableOn ? `Unlocks ${availableOn}` : "Unlock date not set yet";
    } else if (mode === "manual") {
      conditionMet = manualUnlocks.has(lessonId);
      if (!conditionMet) lockReason = "Your trainer unlocks this one";
    }
    const orderMet = !sequential || previousCompleted;
    if (!orderMet && !lockReason) lockReason = "Finish the previous lesson first";

    let state: LessonState;
    if (completedRow) state = "completed";
    else if (conditionMet && orderMet) {
      state = currentAssigned ? "unlocked" : "current";
      currentAssigned = true;
    } else state = "locked";

    previousCompleted = previousCompleted && !!completedRow;

    const summary: JsonObject = {
      id: lessonId,
      title: cleanText(lesson.title),
      summary: cleanText(lesson.summary),
      icon: cleanText(lesson.icon),
      minutes: Number(lesson.minutes || 0),
      unlock: { mode, available_on: availableOn },
      state,
      lock_reason: state === "locked" ? lockReason : "",
      step_count: asArray(lesson.steps).length,
      has_required_test: requiredSteps(lesson).length > 0,
      score_percent: completedRow ? Number(completedRow.score_percent) : null,
      completed_at: completedRow ? cleanText(completedRow.completed_at) : "",
      reward_deck_ids: asArray(lesson.reward_deck_ids).map(cleanText).filter(Boolean),
      reward_quiz_ids: asArray(lesson.reward_quiz_ids).map(cleanText).filter(Boolean)
    };
    if (options.includeContent && state !== "locked") summary.steps = asArray(lesson.steps);
    return summary;
  });

  const completedCount = states.filter((lesson) => lesson.state === "completed").length;
  const nextLesson = states.find((lesson) => lesson.state === "current") || null;
  return {
    id: cleanText(course.id),
    title: cleanText(course.title),
    description: cleanText(course.description),
    icon: cleanText(course.icon),
    color: cleanText(course.color),
    status: cleanText(course.status),
    settings,
    lesson_count: states.length,
    completed_count: completedCount,
    percent_complete: states.length ? Math.round((completedCount / states.length) * 100) : 0,
    next_lesson_id: nextLesson ? cleanText(nextLesson.id) : "",
    next_lesson_title: nextLesson ? cleanText(nextLesson.title) : "",
    lessons: states
  };
}

export async function listMyCourses(orgId: string, viewer: ViewerIdentity, options: { initialize?: boolean } = {}) {
  if (options.initialize !== false) (await ensureTrainingSeed(orgId));
  const assignmentsBySubject = (await assignedSubjects(orgId, viewer, "course"));
  const courses: JsonObject[] = [];
  for (const course of (await listCourses(orgId))) {
    if (cleanText(course.status) !== "published") continue;
    const assignments = assignmentsBySubject.get(cleanText(course.id));
    if (!assignments) continue;
    courses.push((await computeCourseState(orgId, course, viewer, assignments)));
  }
  return courses;
}

export async function readMyCourse(orgId: string, viewer: ViewerIdentity, courseId: string) {
  (await ensureTrainingSeed(orgId));
  const course = (await readCourse(orgId, courseId));
  const assignments = ((await assignedSubjects(orgId, viewer, "course")).get(cleanText(course.id))) || [];
  if (!assignments.length) throw forbidden("training_course_not_assigned", "This course is not assigned to you.");
  return (await computeCourseState(orgId, course, viewer, assignments, { includeContent: true }));
}

/* Rewards: decks/quizzes unlocked by completing lessons ----------------------- */

async function rewardIdsFromCompletedLessons(orgId: string, viewer: ViewerIdentity, key: "reward_deck_ids" | "reward_quiz_ids") {
  const unlocked = new Set<string>();
  const progressLessonIds = new Map<string, Set<string>>();
  for (const row of (await listProgressForUser(orgId, viewer.userId))) {
    const courseId = cleanText(row.course_id);
    const set = progressLessonIds.get(courseId) || new Set<string>();
    set.add(cleanText(row.lesson_id));
    progressLessonIds.set(courseId, set);
  }
  if (!progressLessonIds.size) return unlocked;
  for (const course of (await listCourses(orgId, { includeArchived: true }))) {
    const completed = progressLessonIds.get(cleanText(course.id));
    if (!completed) continue;
    for (const lessonValue of asArray(course.lessons)) {
      const lesson = asObject(lessonValue);
      if (!completed.has(cleanText(lesson.id))) continue;
      for (const id of asArray(lesson[key])) {
        const value = cleanText(id);
        if (value) unlocked.add(value);
      }
    }
  }
  return unlocked;
}

async function attemptStats(orgId: string, viewer: ViewerIdentity, subjectKind: string, subjectId: string) {
  const attempts = (await listAttemptsForUser(orgId, viewer.userId, { subjectKind, subjectId, limit: 25 }));
  const best = attempts.reduce((max, attempt) => Math.max(max, Number(attempt.score_percent || 0)), 0);
  const last = attempts[0] || null;
  return {
    attempt_count: attempts.length,
    best_score_percent: attempts.length ? Math.round(best) : null,
    last_score_percent: last ? Math.round(Number(last.score_percent || 0)) : null,
    last_attempt_at: last ? cleanText(last.created_at) : ""
  };
}

/* Per-course practice materials: a deck/quiz that belongs to a course is
 * visible to anyone assigned that course, and unlocks either immediately or
 * once its unlock lesson is completed. Course-less items keep the legacy
 * direct-assignment / lesson-reward behavior. */
async function practiceContext(orgId: string, viewer: ViewerIdentity, subjectKind: "deck" | "quiz") {
  const rewardKey = subjectKind === "deck" ? "reward_deck_ids" as const : "reward_quiz_ids" as const;
  const myCourses = new Map<string, JsonObject>();
  for (const course of (await listMyCourses(orgId, viewer))) myCourses.set(cleanText(course.id), course);
  const completedByCourse = new Map<string, Set<string>>();
  for (const row of (await listProgressForUser(orgId, viewer.userId))) {
    const set = completedByCourse.get(cleanText(row.course_id)) || new Set<string>();
    set.add(cleanText(row.lesson_id));
    completedByCourse.set(cleanText(row.course_id), set);
  }
  return {
    assigned: (await assignedSubjects(orgId, viewer, subjectKind)),
    rewarded: (await rewardIdsFromCompletedLessons(orgId, viewer, rewardKey)),
    myCourses,
    completedByCourse
  };
}

async function practiceEntry(orgId: string, viewer: ViewerIdentity, item: JsonObject, subjectKind: "deck" | "quiz", ctx: Awaited<ReturnType<typeof practiceContext>>) {
  const itemId = cleanText(item.id);
  const courseId = cleanText(item.course_id);
  if (!courseId) {
    if (!ctx.assigned.has(itemId) && !ctx.rewarded.has(itemId)) return null;
    return {
      ...item,
      locked: false,
      unlock_hint: "",
      course_title: "",
      source: ctx.assigned.has(itemId) ? "assigned" : "reward",
      ...(await attemptStats(orgId, viewer, subjectKind, itemId))
    };
  }
  const course = ctx.myCourses.get(courseId);
  if (!course) return null;
  const unlockLessonId = cleanText(item.unlock_lesson_id);
  const completed = ctx.completedByCourse.get(courseId) || new Set<string>();
  const unlocked = !unlockLessonId || completed.has(unlockLessonId) || ctx.rewarded.has(itemId) || ctx.assigned.has(itemId);
  let unlockHint = "";
  if (!unlocked) {
    const lesson = asArray(course.lessons).map(asObject).find((entry) => cleanText(entry.id) === unlockLessonId);
    unlockHint = lesson ? `Finish "${cleanText(lesson.title)}" to unlock` : "Keep going in the course to unlock";
  }
  return {
    ...item,
    locked: !unlocked,
    unlock_hint: unlockHint,
    course_title: cleanText(course.title),
    source: "course",
    ...(unlocked ? (await attemptStats(orgId, viewer, subjectKind, itemId)) : { attempt_count: 0, best_score_percent: null, last_score_percent: null, last_attempt_at: "" })
  };
}

export async function listMyDecks(orgId: string, viewer: ViewerIdentity) {
  (await ensureTrainingSeed(orgId));
  const ctx = (await practiceContext(orgId, viewer, "deck"));
  return (await Promise.all((await listDecks(orgId))
    .filter((deck) => cleanText(deck.status) === "published")
    .map((deck) => practiceEntry(orgId, viewer, deck, "deck", ctx))))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function listMyQuizzes(orgId: string, viewer: ViewerIdentity) {
  (await ensureTrainingSeed(orgId));
  const ctx = (await practiceContext(orgId, viewer, "quiz"));
  return (await Promise.all((await listQuizzes(orgId))
    .filter((quiz) => cleanText(quiz.status) === "published")
    .map((quiz) => practiceEntry(orgId, viewer, quiz, "quiz", ctx))))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export async function readMyDeck(orgId: string, viewer: ViewerIdentity, deckId: string) {
  const deck = (await readDeck(orgId, deckId));
  const ctx = (await practiceContext(orgId, viewer, "deck"));
  const entry = (await practiceEntry(orgId, viewer, deck, "deck", ctx));
  if (entry && entry.locked !== true) return entry;
  /* Decks embedded in an assigned course's lesson steps stay playable inside
   * that lesson even before they unlock as standalone practice — but only
   * once the lesson that embeds them is reachable. */
  for (const [courseId, courseState] of ctx.myCourses) {
    const reachable = new Set(asArray(courseState.lessons).map(asObject)
      .filter((lesson) => cleanText(lesson.state as string) !== "locked")
      .map((lesson) => cleanText(lesson.id)));
    const full = (await readCourse(orgId, courseId));
    for (const lessonValue of asArray(full.lessons)) {
      const lesson = asObject(lessonValue);
      if (!reachable.has(cleanText(lesson.id))) continue;
      for (const stepValue of asArray(lesson.steps)) {
        if (cleanText(asObject(asObject(stepValue).config).deck_id) === deckId) {
          return { ...deck, locked: false, unlock_hint: "", ...(await attemptStats(orgId, viewer, "deck", deckId)) };
        }
      }
    }
  }
  throw forbidden("training_deck_locked", "This flashcard deck is not unlocked for you yet.");
}

export async function readMyQuiz(orgId: string, viewer: ViewerIdentity, quizId: string) {
  const quiz = (await readQuiz(orgId, quizId));
  const ctx = (await practiceContext(orgId, viewer, "quiz"));
  const entry = (await practiceEntry(orgId, viewer, quiz, "quiz", ctx));
  if (!entry || entry.locked === true) {
    throw forbidden("training_quiz_locked", "This practice quiz is not unlocked for you yet.");
  }
  return entry;
}

/* Lesson completion ------------------------------------------------------------ */

export async function completeLesson(orgId: string, viewer: ViewerIdentity, courseId: string, lessonId: string, input: JsonObject) {
  const course = (await readCourse(orgId, courseId));
  const assignments = ((await assignedSubjects(orgId, viewer, "course")).get(cleanText(course.id))) || [];
  if (!assignments.length) throw forbidden("training_course_not_assigned", "This course is not assigned to you.");

  const state = (await computeCourseState(orgId, course, viewer, assignments));
  const lessonState = asArray(state.lessons).map(asObject).find((lesson) => cleanText(lesson.id) === lessonId);
  if (!lessonState) throw badRequest("training_lesson_not_found", "This lesson does not exist in the course.");
  if (lessonState.state === "locked") throw forbidden("training_lesson_locked", "This lesson is still locked.");

  const lesson = asArray(course.lessons).map(asObject).find((item) => cleanText(item.id) === lessonId) || {};
  const results = asArray(input.results).map(asObject);
  const graded = results.filter((result) => result.practice !== true);

  /* Every required test step needs a passing, non-practice result. */
  for (const step of requiredSteps(lesson)) {
    const stepId = cleanText(step.id);
    const result = graded.find((item) => cleanText(item.step_id) === stepId);
    if (!result || result.passed === false) {
      throw badRequest("training_test_not_passed", `The "${cleanText(step.title) || "test"}" step must be passed to finish this lesson.`, { step_id: stepId });
    }
  }

  for (const result of results) {
    (await recordAttempt(orgId, viewer.userId, {
      subject_kind: "lesson_step",
      subject_id: cleanText(result.step_id) || lessonId,
      course_id: courseId,
      lesson_id: lessonId,
      practice: result.practice === true,
      passed: result.passed !== false,
      score_percent: Number(result.score_percent || 0),
      correct_count: Number(result.correct_count || 0),
      total_count: Number(result.total_count || 0),
      detail: { kind: cleanText(result.kind) }
    }));
  }

  const scores = graded.map((result) => Number(result.score_percent)).filter((value) => Number.isFinite(value));
  const score = scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : 100;
  (await recordLessonCompletion(orgId, viewer.userId, courseId, lessonId, score, true));

  const refreshed = (await readMyCourse(orgId, viewer, courseId));
  return {
    course: refreshed,
    completed_lesson_id: lessonId,
    unlocked_deck_ids: asArray(asObject(lesson).reward_deck_ids).map(cleanText).filter(Boolean),
    unlocked_quiz_ids: asArray(asObject(lesson).reward_quiz_ids).map(cleanText).filter(Boolean),
    course_completed: Number(refreshed.completed_count) === Number(refreshed.lesson_count) && Number(refreshed.lesson_count) > 0
  };
}

export async function recordStandaloneAttempt(orgId: string, viewer: ViewerIdentity, input: JsonObject) {
  return (await recordAttempt(orgId, viewer.userId, input));
}

/* Manager reporting ------------------------------------------------------------ */

export async function courseProgressReport(orgId: string, courseId: string) {
  const course = (await readCourse(orgId, courseId));
  const lessons = asArray(course.lessons).map(asObject);
  const lessonIds = lessons.map((lesson) => cleanText(lesson.id));
  const progressRows = (await listProgressForCourse(orgId, courseId));
  const unlockRows = (await listUnlocksForCourse(orgId, courseId));
  const byUser = new Map<string, JsonObject[]>();
  for (const row of progressRows) {
    const list = byUser.get(cleanText(row.user_id)) || [];
    list.push(row);
    byUser.set(cleanText(row.user_id), list);
  }
  const unlocksByUser = new Map<string, string[]>();
  for (const row of unlockRows) {
    const list = unlocksByUser.get(cleanText(row.user_id)) || [];
    list.push(cleanText(row.lesson_id));
    unlocksByUser.set(cleanText(row.user_id), list);
  }
  const users = new Set<string>([...byUser.keys(), ...unlocksByUser.keys()]);
  return {
    course_id: courseId,
    course_title: cleanText(course.title),
    lesson_ids: lessonIds,
    lessons: lessons.map((lesson) => ({ id: cleanText(lesson.id), title: cleanText(lesson.title), unlock: asObject(lesson.unlock) })),
    users: [...users].map((userId) => {
      const rows = (byUser.get(userId) || []).filter((row) => lessonIds.includes(cleanText(row.lesson_id)));
      return {
        user_id: userId,
        completed_lesson_ids: rows.map((row) => cleanText(row.lesson_id)),
        completed_count: rows.length,
        percent_complete: lessonIds.length ? Math.round((rows.length / lessonIds.length) * 100) : 0,
        average_score_percent: rows.length ? Math.round(rows.reduce((sum, row) => sum + Number(row.score_percent || 0), 0) / rows.length) : null,
        manual_unlock_lesson_ids: unlocksByUser.get(userId) || [],
        last_completed_at: rows.map((row) => cleanText(row.completed_at)).sort().pop() || ""
      };
    })
  };
}
