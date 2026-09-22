import { z } from "zod";

/* Shared primitives ------------------------------------------------------ */

const trimmed = z.string().transform((value) => value.trim());
const id = trimmed.pipe(z.string().min(1));
const optionalText = z.string().optional().transform((value) => String(value ?? "").trim());

/* Questions power lesson quizzes, practice quizzes, and flashcard checks.
 * kind:
 *  - multiple_choice: pick one of `choices`; correct when choice id is in correct_choice_ids
 *  - text_input: free text matched against `answers` (case-insensitive unless case_sensitive)
 */
export const trainingQuestionSchema = z.object({
  id: optionalText,
  kind: z.enum(["multiple_choice", "text_input"]).default("multiple_choice"),
  prompt: optionalText,
  image: optionalText,
  explanation: optionalText,
  choices: z.array(z.object({
    id: optionalText,
    text: optionalText,
    image: optionalText
  })).default([]),
  correct_choice_ids: z.array(z.string()).default([]),
  answers: z.array(z.string()).default([]),
  case_sensitive: z.boolean().default(false)
}).passthrough();

/* Flashcards: front shows text/image; the answer side is either a flip
 * reveal, a multiple-choice pick, or a typed answer. */
export const trainingCardSchema = z.object({
  id: optionalText,
  kind: z.enum(["flip", "multiple_choice", "text_input"]).default("flip"),
  front_text: optionalText,
  front_image: optionalText,
  back_text: optionalText,
  back_image: optionalText,
  choices: z.array(z.object({
    id: optionalText,
    text: optionalText,
    image: optionalText
  })).default([]),
  correct_choice_ids: z.array(z.string()).default([]),
  answers: z.array(z.string()).default([]),
  case_sensitive: z.boolean().default(false)
}).passthrough();

/* Every lesson page ("step") is a typed, fungible unit. The frontend keeps a
 * renderer registry keyed by `kind`; unknown kinds fall back to a friendly
 * placeholder so new step apps can ship without touching this backend. */
export const trainingStepSchema = z.object({
  id: optionalText,
  kind: trimmed.pipe(z.string().min(1)),
  title: optionalText,
  config: z.record(z.unknown()).default({})
}).passthrough();

export const lessonUnlockSchema = z.object({
  mode: z.enum(["previous", "date", "manual"]).default("previous"),
  available_on: optionalText
}).default({ mode: "previous", available_on: "" });

export const trainingLessonSchema = z.object({
  id: optionalText,
  title: trimmed.pipe(z.string().min(1)),
  summary: optionalText,
  icon: optionalText,
  minutes: z.number().int().min(0).default(0),
  unlock: lessonUnlockSchema,
  steps: z.array(trainingStepSchema).default([]),
  reward_deck_ids: z.array(z.string()).default([]),
  reward_quiz_ids: z.array(z.string()).default([])
}).passthrough();

export const courseSettingsSchema = z.object({
  progression: z.enum(["sequential", "free"]).default("sequential")
}).default({ progression: "sequential" });

export const saveCourseSchema = z.object({
  id: optionalText,
  title: trimmed.pipe(z.string().min(1)),
  description: optionalText,
  icon: optionalText,
  color: optionalText,
  status: z.enum(["draft", "published", "archived"]).default("published"),
  settings: courseSettingsSchema,
  lessons: z.array(trainingLessonSchema).default([]),
  sort_order: z.number().int().default(0),
  expected_revision: z.number().int().optional()
});

export const saveDeckSchema = z.object({
  id: optionalText,
  course_id: optionalText,
  unlock_lesson_id: optionalText,
  title: trimmed.pipe(z.string().min(1)),
  description: optionalText,
  icon: optionalText,
  color: optionalText,
  status: z.enum(["draft", "published", "archived"]).default("published"),
  shuffle: z.boolean().default(true),
  cards: z.array(trainingCardSchema).default([]),
  expected_revision: z.number().int().optional()
});

export const saveQuizSchema = z.object({
  id: optionalText,
  course_id: optionalText,
  unlock_lesson_id: optionalText,
  title: trimmed.pipe(z.string().min(1)),
  description: optionalText,
  icon: optionalText,
  color: optionalText,
  status: z.enum(["draft", "published", "archived"]).default("published"),
  shuffle: z.boolean().default(true),
  pass_percent: z.number().min(0).max(100).default(70),
  questions: z.array(trainingQuestionSchema).default([]),
  expected_revision: z.number().int().optional()
});

export const createAssignmentSchema = z.object({
  subject_kind: z.enum(["course", "deck", "quiz"]),
  subject_id: id,
  target_kind: z.enum(["user", "role", "everyone"]),
  target_id: optionalText,
  /* Optional per-lesson unlock date overrides: { [lesson_id]: "YYYY-MM-DD" } */
  schedule: z.record(z.string()).default({})
});

export const updateAssignmentSchema = z.object({
  schedule: z.record(z.string()).default({})
});

export const completeLessonSchema = z.object({
  course_id: id,
  results: z.array(z.object({
    step_id: optionalText,
    kind: optionalText,
    practice: z.boolean().default(false),
    passed: z.boolean().default(true),
    score_percent: z.number().min(0).max(100).default(100),
    correct_count: z.number().int().min(0).default(0),
    total_count: z.number().int().min(0).default(0)
  }).passthrough()).default([])
});

export const recordAttemptSchema = z.object({
  subject_kind: z.enum(["quiz", "deck", "lesson_step"]),
  subject_id: id,
  course_id: optionalText,
  lesson_id: optionalText,
  practice: z.boolean().default(false),
  passed: z.boolean().default(true),
  score_percent: z.number().min(0).max(100).default(0),
  correct_count: z.number().int().min(0).default(0),
  total_count: z.number().int().min(0).default(0),
  detail: z.record(z.unknown()).default({})
});

export const manualUnlockSchema = z.object({
  user_id: id
});

export type SaveCourseInput = z.infer<typeof saveCourseSchema>;
export type SaveDeckInput = z.infer<typeof saveDeckSchema>;
export type SaveQuizInput = z.infer<typeof saveQuizSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type CompleteLessonInput = z.infer<typeof completeLessonSchema>;
export type RecordAttemptInput = z.infer<typeof recordAttemptSchema>;
