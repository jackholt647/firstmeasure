import { randomUUID } from "node:crypto";
import path from "node:path";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import { env } from "../src/config/env.js";
import { conflict, notFound } from "../platform/errors.js";

export type JsonObject = Record<string, unknown>;

let database: SqlStore | null = null;
let databasePath = "";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "training.sqlite");
}

export async function closeTrainingDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}

export function getTrainingDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeTrainingDatabase();
  database = openSqlStore({ id: "training", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS training_courses (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published',
      settings_json TEXT NOT NULL DEFAULT '{}',
      lessons_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      seed_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_courses_org ON training_courses (organization_id, status);

    CREATE TABLE IF NOT EXISTS training_decks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      course_id TEXT NOT NULL DEFAULT '',
      unlock_lesson_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published',
      shuffle INTEGER NOT NULL DEFAULT 1,
      cards_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      seed_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_decks_org ON training_decks (organization_id, status);

    CREATE TABLE IF NOT EXISTS training_quizzes (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      course_id TEXT NOT NULL DEFAULT '',
      unlock_lesson_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'published',
      shuffle INTEGER NOT NULL DEFAULT 1,
      pass_percent DOUBLE PRECISION NOT NULL DEFAULT 70,
      questions_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      seed_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_quizzes_org ON training_quizzes (organization_id, status);

    CREATE TABLE IF NOT EXISTS training_assignments (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      schedule_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE (organization_id, subject_kind, subject_id, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_training_assignments_org ON training_assignments (organization_id, subject_kind);

    CREATE TABLE IF NOT EXISTS training_progress (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      score_percent DOUBLE PRECISION NOT NULL DEFAULT 100,
      passed INTEGER NOT NULL DEFAULT 1,
      completed_at TEXT NOT NULL,
      UNIQUE (organization_id, user_id, course_id, lesson_id)
    );
    CREATE INDEX IF NOT EXISTS idx_training_progress_user ON training_progress (organization_id, user_id, course_id);
    CREATE INDEX IF NOT EXISTS idx_training_progress_course ON training_progress (organization_id, course_id);

    CREATE TABLE IF NOT EXISTS training_unlocks (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      lesson_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      unlocked_by TEXT NOT NULL DEFAULT '',
      unlocked_at TEXT NOT NULL,
      UNIQUE (organization_id, course_id, lesson_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_training_unlocks_user ON training_unlocks (organization_id, user_id, course_id);

    CREATE TABLE IF NOT EXISTS training_attempts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      course_id TEXT NOT NULL DEFAULT '',
      lesson_id TEXT NOT NULL DEFAULT '',
      practice INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 1,
      score_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_attempts_user ON training_attempts (organization_id, user_id, subject_kind, subject_id);
  `));
  for (const table of ["training_decks", "training_quizzes"]) {
    await ensureSqlColumn(db, table, "course_id", "TEXT NOT NULL DEFAULT ''");
    await ensureSqlColumn(db, table, "unlock_lesson_id", "TEXT NOT NULL DEFAULT ''");
  }
}

/* Row views --------------------------------------------------------------- */

export function courseView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    title: cleanText(value.title),
    description: cleanText(value.description),
    icon: cleanText(value.icon),
    color: cleanText(value.color),
    status: cleanText(value.status || "published"),
    settings: parseJson(value.settings_json, {}),
    lessons: parseJson(value.lessons_json, []),
    sort_order: Number(value.sort_order || 0),
    revision: Number(value.revision || 1),
    seed_key: cleanText(value.seed_key),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export function deckView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    course_id: cleanText(value.course_id),
    unlock_lesson_id: cleanText(value.unlock_lesson_id),
    title: cleanText(value.title),
    description: cleanText(value.description),
    icon: cleanText(value.icon),
    color: cleanText(value.color),
    status: cleanText(value.status || "published"),
    shuffle: Number(value.shuffle ?? 1) !== 0,
    cards: parseJson(value.cards_json, []),
    revision: Number(value.revision || 1),
    seed_key: cleanText(value.seed_key),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export function quizView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    course_id: cleanText(value.course_id),
    unlock_lesson_id: cleanText(value.unlock_lesson_id),
    title: cleanText(value.title),
    description: cleanText(value.description),
    icon: cleanText(value.icon),
    color: cleanText(value.color),
    status: cleanText(value.status || "published"),
    shuffle: Number(value.shuffle ?? 1) !== 0,
    pass_percent: Number(value.pass_percent ?? 70),
    questions: parseJson(value.questions_json, []),
    revision: Number(value.revision || 1),
    seed_key: cleanText(value.seed_key),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export function assignmentView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    subject_kind: cleanText(value.subject_kind),
    subject_id: cleanText(value.subject_id),
    target_kind: cleanText(value.target_kind),
    target_id: cleanText(value.target_id),
    schedule: parseJson(value.schedule_json, {}),
    created_by: cleanText(value.created_by),
    created_at: cleanText(value.created_at)
  };
}

export function progressView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    user_id: cleanText(value.user_id),
    course_id: cleanText(value.course_id),
    lesson_id: cleanText(value.lesson_id),
    status: cleanText(value.status || "completed"),
    score_percent: Number(value.score_percent ?? 100),
    passed: Number(value.passed ?? 1) !== 0,
    completed_at: cleanText(value.completed_at)
  };
}

export function attemptView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    user_id: cleanText(value.user_id),
    subject_kind: cleanText(value.subject_kind),
    subject_id: cleanText(value.subject_id),
    course_id: cleanText(value.course_id),
    lesson_id: cleanText(value.lesson_id),
    practice: Number(value.practice ?? 0) !== 0,
    passed: Number(value.passed ?? 1) !== 0,
    score_percent: Number(value.score_percent ?? 0),
    correct_count: Number(value.correct_count ?? 0),
    total_count: Number(value.total_count ?? 0),
    detail: parseJson(value.detail_json, {}),
    created_at: cleanText(value.created_at)
  };
}

export function unlockView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    course_id: cleanText(value.course_id),
    lesson_id: cleanText(value.lesson_id),
    user_id: cleanText(value.user_id),
    unlocked_by: cleanText(value.unlocked_by),
    unlocked_at: cleanText(value.unlocked_at)
  };
}

/* Courses ------------------------------------------------------------------ */

export async function listCourses(orgId: string, options: { includeArchived?: boolean } = {}) {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_courses WHERE organization_id = ?
    AND (? = 1 OR status <> 'archived') ORDER BY sort_order ASC, created_at ASC`).all(orgId, options.includeArchived ? 1 : 0));
  return rows.map(courseView);
}

export async function readCourse(orgId: string, courseId: string) {
  const row = (await getTrainingDatabase().prepare("SELECT * FROM training_courses WHERE organization_id = ? AND id = ?").get(orgId, courseId));
  if (!row) throw notFound("training_course_not_found", "Training course was not found.");
  return courseView(row);
}

export async function saveCourse(orgId: string, input: JsonObject) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const now = nowIso();
  const courseId = cleanText(input.id) || newId("course");
  const existing = (await db.prepare("SELECT * FROM training_courses WHERE organization_id = ? AND id = ?").get(orgId, courseId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("training_course_revision_conflict", "The course was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE training_courses SET title=?, description=?, icon=?, color=?, status=?, settings_json=?, lessons_json=?, sort_order=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.title), cleanText(input.description), cleanText(input.icon), cleanText(input.color), cleanText(input.status || "published"),
        JSON.stringify(input.settings ?? {}), JSON.stringify(input.lessons ?? []), Number(input.sort_order || 0), current + 1, now, orgId, courseId));
  } else {
    (await db.prepare(`INSERT INTO training_courses (id, organization_id, title, description, icon, color, status, settings_json, lessons_json, sort_order, revision, seed_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(courseId, orgId, cleanText(input.title), cleanText(input.description), cleanText(input.icon), cleanText(input.color), cleanText(input.status || "published"),
        JSON.stringify(input.settings ?? {}), JSON.stringify(input.lessons ?? []), Number(input.sort_order || 0), cleanText(input.seed_key), now, now));
  }
  return (await readCourse(orgId, courseId));

  }));
}

export async function archiveCourse(orgId: string, courseId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  const result = (await getTrainingDatabase().prepare("UPDATE training_courses SET status='archived', updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), orgId, courseId));
  if (!Number(result.changes || 0)) throw notFound("training_course_not_found", "Training course was not found.");
  return (await readCourse(orgId, courseId));

  }));
}

/* Decks -------------------------------------------------------------------- */

export async function listDecks(orgId: string, options: { includeArchived?: boolean; courseId?: string } = {}) {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_decks WHERE organization_id = ?
    AND (? = 1 OR status <> 'archived') AND (? = '' OR course_id = ?) ORDER BY created_at ASC`)
    .all(orgId, options.includeArchived ? 1 : 0, cleanText(options.courseId), cleanText(options.courseId)));
  return rows.map(deckView);
}

export async function readDeck(orgId: string, deckId: string) {
  const row = (await getTrainingDatabase().prepare("SELECT * FROM training_decks WHERE organization_id = ? AND id = ?").get(orgId, deckId));
  if (!row) throw notFound("training_deck_not_found", "Flashcard deck was not found.");
  return deckView(row);
}

export async function saveDeck(orgId: string, input: JsonObject) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const now = nowIso();
  const deckId = cleanText(input.id) || newId("deck");
  const existing = (await db.prepare("SELECT * FROM training_decks WHERE organization_id = ? AND id = ?").get(orgId, deckId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("training_deck_revision_conflict", "The deck was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE training_decks SET course_id=?, unlock_lesson_id=?, title=?, description=?, icon=?, color=?, status=?, shuffle=?, cards_json=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.course_id), cleanText(input.unlock_lesson_id), cleanText(input.title), cleanText(input.description), cleanText(input.icon), cleanText(input.color), cleanText(input.status || "published"),
        input.shuffle === false ? 0 : 1, JSON.stringify(input.cards ?? []), current + 1, now, orgId, deckId));
  } else {
    (await db.prepare(`INSERT INTO training_decks (id, organization_id, course_id, unlock_lesson_id, title, description, icon, color, status, shuffle, cards_json, revision, seed_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(deckId, orgId, cleanText(input.course_id), cleanText(input.unlock_lesson_id), cleanText(input.title), cleanText(input.description), cleanText(input.icon), cleanText(input.color), cleanText(input.status || "published"),
        input.shuffle === false ? 0 : 1, JSON.stringify(input.cards ?? []), cleanText(input.seed_key), now, now));
  }
  return (await readDeck(orgId, deckId));

  }));
}

export async function archiveDeck(orgId: string, deckId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  const result = (await getTrainingDatabase().prepare("UPDATE training_decks SET status='archived', updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), orgId, deckId));
  if (!Number(result.changes || 0)) throw notFound("training_deck_not_found", "Flashcard deck was not found.");
  return (await readDeck(orgId, deckId));

  }));
}

/* Quizzes ------------------------------------------------------------------ */

export async function listQuizzes(orgId: string, options: { includeArchived?: boolean; courseId?: string } = {}) {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_quizzes WHERE organization_id = ?
    AND (? = 1 OR status <> 'archived') AND (? = '' OR course_id = ?) ORDER BY created_at ASC`)
    .all(orgId, options.includeArchived ? 1 : 0, cleanText(options.courseId), cleanText(options.courseId)));
  return rows.map(quizView);
}

export async function readQuiz(orgId: string, quizId: string) {
  const row = (await getTrainingDatabase().prepare("SELECT * FROM training_quizzes WHERE organization_id = ? AND id = ?").get(orgId, quizId));
  if (!row) throw notFound("training_quiz_not_found", "Practice quiz was not found.");
  return quizView(row);
}

export async function saveQuiz(orgId: string, input: JsonObject) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const now = nowIso();
  const quizId = cleanText(input.id) || newId("quiz");
  const existing = (await db.prepare("SELECT * FROM training_quizzes WHERE organization_id = ? AND id = ?").get(orgId, quizId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("training_quiz_revision_conflict", "The quiz was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE training_quizzes SET course_id=?, unlock_lesson_id=?, title=?, description=?, icon=?, color=?, status=?, shuffle=?, pass_percent=?, questions_json=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.course_id), cleanText(input.unlock_lesson_id), cleanText(input.title), cleanText(input.description), cleanText(input.icon), cleanText(input.color), cleanText(input.status || "published"),
        input.shuffle === false ? 0 : 1, Number(input.pass_percent ?? 70), JSON.stringify(input.questions ?? []), current + 1, now, orgId, quizId));
  } else {
    (await db.prepare(`INSERT INTO training_quizzes (id, organization_id, course_id, unlock_lesson_id, title, description, icon, color, status, shuffle, pass_percent, questions_json, revision, seed_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(quizId, orgId, cleanText(input.course_id), cleanText(input.unlock_lesson_id), cleanText(input.title), cleanText(input.description), cleanText(input.icon), cleanText(input.color), cleanText(input.status || "published"),
        input.shuffle === false ? 0 : 1, Number(input.pass_percent ?? 70), JSON.stringify(input.questions ?? []), cleanText(input.seed_key), now, now));
  }
  return (await readQuiz(orgId, quizId));

  }));
}

export async function archiveQuiz(orgId: string, quizId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  const result = (await getTrainingDatabase().prepare("UPDATE training_quizzes SET status='archived', updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), orgId, quizId));
  if (!Number(result.changes || 0)) throw notFound("training_quiz_not_found", "Practice quiz was not found.");
  return (await readQuiz(orgId, quizId));

  }));
}

/* Assignments --------------------------------------------------------------- */

export async function listAssignments(orgId: string, options: { subjectKind?: string; subjectId?: string } = {}) {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_assignments WHERE organization_id = ?
    AND (? = '' OR subject_kind = ?) AND (? = '' OR subject_id = ?) ORDER BY created_at ASC`)
    .all(orgId, cleanText(options.subjectKind), cleanText(options.subjectKind), cleanText(options.subjectId), cleanText(options.subjectId)));
  return rows.map(assignmentView);
}

export async function createAssignment(orgId: string, input: JsonObject) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const id = newId("assign");
  const now = nowIso();
  (await db.prepare(`INSERT INTO training_assignments (id, organization_id, subject_kind, subject_id, target_kind, target_id, schedule_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id, subject_kind, subject_id, target_kind, target_id)
    DO UPDATE SET schedule_json = excluded.schedule_json`)
    .run(id, orgId, cleanText(input.subject_kind), cleanText(input.subject_id), cleanText(input.target_kind), cleanText(input.target_id),
      JSON.stringify(input.schedule ?? {}), cleanText(input.created_by), now));
  const row = (await db.prepare(`SELECT * FROM training_assignments WHERE organization_id = ? AND subject_kind = ? AND subject_id = ? AND target_kind = ? AND target_id = ?`)
    .get(orgId, cleanText(input.subject_kind), cleanText(input.subject_id), cleanText(input.target_kind), cleanText(input.target_id)));
  return assignmentView(row);

  }));
}

export async function updateAssignment(orgId: string, assignmentId: string, input: JsonObject) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const result = (await db.prepare("UPDATE training_assignments SET schedule_json = ? WHERE organization_id = ? AND id = ?")
    .run(JSON.stringify(input.schedule ?? {}), orgId, assignmentId));
  if (!Number(result.changes || 0)) throw notFound("training_assignment_not_found", "Assignment was not found.");
  return assignmentView((await db.prepare("SELECT * FROM training_assignments WHERE organization_id = ? AND id = ?").get(orgId, assignmentId)));

  }));
}

export async function deleteAssignment(orgId: string, assignmentId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  const result = (await getTrainingDatabase().prepare("DELETE FROM training_assignments WHERE organization_id = ? AND id = ?").run(orgId, assignmentId));
  if (!Number(result.changes || 0)) throw notFound("training_assignment_not_found", "Assignment was not found.");
  return { id: assignmentId, deleted: true };

  }));
}

/* Progress / unlocks / attempts --------------------------------------------- */

export async function listProgressForUser(orgId: string, userId: string, courseId = "") {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_progress WHERE organization_id = ? AND user_id = ?
    AND (? = '' OR course_id = ?)`).all(orgId, userId, cleanText(courseId), cleanText(courseId)));
  return rows.map(progressView);
}

export async function listProgressForCourse(orgId: string, courseId: string) {
  const rows = (await getTrainingDatabase().prepare("SELECT * FROM training_progress WHERE organization_id = ? AND course_id = ?").all(orgId, courseId));
  return rows.map(progressView);
}

export async function recordLessonCompletion(orgId: string, userId: string, courseId: string, lessonId: string, scorePercent: number, passed: boolean) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const now = nowIso();
  (await db.prepare(`INSERT INTO training_progress (id, organization_id, user_id, course_id, lesson_id, status, score_percent, passed, completed_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)
    ON CONFLICT (organization_id, user_id, course_id, lesson_id)
    DO UPDATE SET score_percent = excluded.score_percent, passed = excluded.passed, completed_at = excluded.completed_at`)
    .run(newId("prog"), orgId, userId, courseId, lessonId, scorePercent, passed ? 1 : 0, now));

  }));
}

export async function resetLessonCompletion(orgId: string, userId: string, courseId: string, lessonId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  (await getTrainingDatabase().prepare("DELETE FROM training_progress WHERE organization_id=? AND user_id=? AND course_id=? AND lesson_id=?")
    .run(orgId, userId, courseId, lessonId));

  }));
}

export async function listUnlocksForUser(orgId: string, userId: string, courseId = "") {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_unlocks WHERE organization_id = ? AND user_id = ?
    AND (? = '' OR course_id = ?)`).all(orgId, userId, cleanText(courseId), cleanText(courseId)));
  return rows.map(unlockView);
}

export async function listUnlocksForCourse(orgId: string, courseId: string) {
  const rows = (await getTrainingDatabase().prepare("SELECT * FROM training_unlocks WHERE organization_id = ? AND course_id = ?").all(orgId, courseId));
  return rows.map(unlockView);
}

export async function grantManualUnlock(orgId: string, courseId: string, lessonId: string, userId: string, unlockedBy: string) {
  return (await getTrainingDatabase().transaction(async () => {
  (await getTrainingDatabase().prepare(`INSERT INTO training_unlocks (id, organization_id, course_id, lesson_id, user_id, unlocked_by, unlocked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id, course_id, lesson_id, user_id) DO NOTHING`)
    .run(newId("unlock"), orgId, courseId, lessonId, userId, unlockedBy, nowIso()));

  }));
}

export async function revokeManualUnlock(orgId: string, courseId: string, lessonId: string, userId: string) {
  return (await getTrainingDatabase().transaction(async () => {
  (await getTrainingDatabase().prepare("DELETE FROM training_unlocks WHERE organization_id=? AND course_id=? AND lesson_id=? AND user_id=?")
    .run(orgId, courseId, lessonId, userId));

  }));
}

export async function recordAttempt(orgId: string, userId: string, input: JsonObject) {
  return (await getTrainingDatabase().transaction(async () => {
  const db = getTrainingDatabase();
  const id = newId("attempt");
  (await db.prepare(`INSERT INTO training_attempts (id, organization_id, user_id, subject_kind, subject_id, course_id, lesson_id, practice, passed, score_percent, correct_count, total_count, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, userId, cleanText(input.subject_kind), cleanText(input.subject_id), cleanText(input.course_id), cleanText(input.lesson_id),
      input.practice === true ? 1 : 0, input.passed === false ? 0 : 1, Number(input.score_percent || 0), Number(input.correct_count || 0),
      Number(input.total_count || 0), JSON.stringify(input.detail ?? {}), nowIso()));
  return attemptView((await db.prepare("SELECT * FROM training_attempts WHERE id = ?").get(id)));

  }));
}

export async function listAttemptsForUser(orgId: string, userId: string, options: { subjectKind?: string; subjectId?: string; limit?: number } = {}) {
  const rows = (await getTrainingDatabase().prepare(`SELECT * FROM training_attempts WHERE organization_id = ? AND user_id = ?
    AND (? = '' OR subject_kind = ?) AND (? = '' OR subject_id = ?) ORDER BY created_at DESC LIMIT ?`)
    .all(orgId, userId, cleanText(options.subjectKind), cleanText(options.subjectKind), cleanText(options.subjectId), cleanText(options.subjectId),
      Math.max(1, Math.min(500, Number(options.limit || 50)))));
  return rows.map(attemptView);
}

export async function countCoursesWithSeedKey(orgId: string) {
  const row = asObject((await getTrainingDatabase().prepare("SELECT COUNT(*) AS count FROM training_courses WHERE organization_id = ? AND seed_key <> ''").get(orgId)));
  return Number(row.count || 0);
}
