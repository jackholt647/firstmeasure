import { badRequest } from "../platform/errors.js";
import { registerAudioStructureProcessor } from "./processor.js";

export type ChecklistAudioContext = {
  mode: "create" | "update";
  requestedTitle?: string;
  checklist?: {
    id: string;
    title: string;
    audience?: string;
    customer_access?: Record<string, unknown>;
    items: Array<{ id: string; title: string; completed: boolean; item_type: string; note?: string; required_attachments?: unknown[] }>;
  };
};

export type ChecklistAudioOperation = {
  action: "add" | "complete" | "add_note" | "set_requirements";
  item_id: string;
  title: string;
  item_type?: "todo" | "rating";
  note?: string;
  requirements?: Array<"media" | "photo" | "video" | "document" | "audio">;
  confidence: number;
  reason: string;
};

export type ChecklistAudioResult = {
  title: string;
  summary: string;
  customer_access: "private" | "view" | "complete" | "edit";
  customer_access_explicit: boolean;
  completion_audience: "everyone" | "supervisor" | "assigned";
  completion_audience_explicit: boolean;
  operations: ChecklistAudioOperation[];
};

type ExistingChecklistItem = {
  id: string;
  title: string;
  completed?: boolean;
  item_type?: string;
};

const CHECKLIST_STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "been", "by", "for", "from", "has", "have",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with"
]);

function checklistStem(value: string) {
  let token = value;
  if (token.length > 4 && token.endsWith("ied")) token = `${token.slice(0, -3)}y`;
  else if (token.length === 4 && token.endsWith("ied")) token = token.slice(0, -1);
  else if (token.length > 5 && token.endsWith("ing")) {
    token = token.slice(0, -3);
    if (/([bcdfghjklmnpqrstvwxyz])\1$/.test(token)) token = token.slice(0, -1);
  } else if (token.length > 4 && token.endsWith("ed")) token = token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) token = token.slice(0, -1);
  return token;
}

export function checklistTitleTokens(value: unknown) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !CHECKLIST_STOP_WORDS.has(token))
    .map(checklistStem);
}

export function checklistTitleSimilarity(leftValue: unknown, rightValue: unknown) {
  const left = new Set(checklistTitleTokens(leftValue));
  const right = new Set(checklistTitleTokens(rightValue));
  if (!left.size || !right.size) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const containment = intersection / Math.min(left.size, right.size);
  const jaccard = intersection / new Set([...left, ...right]).size;
  return Math.max(jaccard, containment * 0.92);
}

function matchingChecklistItem(title: string, items: ExistingChecklistItem[]) {
  let best: ExistingChecklistItem | null = null;
  let bestScore = 0;
  for (const item of items) {
    const score = checklistTitleSimilarity(title, item.title);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best && bestScore >= 0.74 ? { item: best, score: bestScore } : null;
}

function reasonDescribesCompletion(value: unknown) {
  return /\b(already|complete[ds]?|completed|done|finished|performed|carried out|has been|have been|was done|were done)\b/i.test(clean(value));
}

export function reconcileChecklistAudioOperations(
  operationsValue: ChecklistAudioOperation[],
  itemsValue: ExistingChecklistItem[]
) {
  const items = Array.isArray(itemsValue) ? itemsValue : [];
  const itemsById = new Map(items.map((item) => [clean(item.id), item]));
  const operations: ChecklistAudioOperation[] = [];
  const suppressed: Array<ChecklistAudioOperation & { matched_item_id?: string; suppression_reason: string }> = [];
  const completedIds = new Set<string>();
  const addedTitles: string[] = [];
  for (const original of Array.isArray(operationsValue) ? operationsValue : []) {
    let operation = { ...original };
    if (operation.action === "complete") {
      const direct = itemsById.get(clean(operation.item_id));
      const match = direct ? { item: direct, score: 1 } : matchingChecklistItem(operation.title, items);
      if (!match) {
        suppressed.push({ ...operation, suppression_reason: "existing_item_not_found" });
        continue;
      }
      operation = { ...operation, item_id: match.item.id, title: match.item.title };
      if (match.item.completed || completedIds.has(match.item.id)) {
        suppressed.push({ ...operation, matched_item_id: match.item.id, suppression_reason: "already_completed" });
        continue;
      }
      completedIds.add(match.item.id);
      operations.push(operation);
      continue;
    }
    if (operation.action === "add_note" || operation.action === "set_requirements") {
      const direct = itemsById.get(clean(operation.item_id));
      const match = direct ? { item: direct, score: 1 } : matchingChecklistItem(operation.title, items);
      if (!match) {
        suppressed.push({ ...operation, suppression_reason: "existing_item_not_found" });
        continue;
      }
      operations.push({ ...operation, item_id: match.item.id, title: match.item.title });
      continue;
    }
    const match = matchingChecklistItem(operation.title, items);
    if (match) {
      if (!match.item.completed && !completedIds.has(match.item.id) && reasonDescribesCompletion(operation.reason)) {
        completedIds.add(match.item.id);
        operations.push({
          ...operation,
          action: "complete",
          item_id: match.item.id,
          title: match.item.title,
          reason: `${operation.reason} Matched an existing checklist item; duplicate creation prevented.`
        });
      } else {
        suppressed.push({
          ...operation,
          matched_item_id: match.item.id,
          suppression_reason: "duplicate_existing_item"
        });
      }
      continue;
    }
    if (addedTitles.some((title) => checklistTitleSimilarity(title, operation.title) >= 0.74)) {
      suppressed.push({ ...operation, suppression_reason: "duplicate_new_item" });
      continue;
    }
    addedTitles.push(operation.title);
    operations.push(operation);
  }
  return { operations, suppressed };
}

const schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "A short checklist title. Preserve the existing title when editing." },
    summary: { type: "string", description: "One short sentence describing the changes." },
    customer_access: { type: "string", enum: ["private", "view", "complete", "edit"], description: "Customer access requested by the speaker. Private is the default; edit includes completion." },
    customer_access_explicit: { type: "boolean", description: "True only when the speaker explicitly mentioned customer visibility or completion." },
    completion_audience: { type: "string", enum: ["everyone", "supervisor", "assigned"], description: "Who may complete the internal checklist. Assigned to the creator is the default." },
    completion_audience_explicit: { type: "boolean", description: "True only when the speaker explicitly restricted completion to supervisors or required a specific assignee." },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "complete", "add_note", "set_requirements"] },
          item_id: { type: "string", description: "Existing item id for complete; empty string for add." },
          title: { type: "string", description: "Concise checklist item title." },
          item_type: { type: "string", enum: ["todo", "rating"], description: "todo is a task to check off; rating is evaluated Good, Okay, or Needs work." },
          note: { type: "string", description: "Note text for add_note or a note attached while adding an item; otherwise empty." },
          requirements: { type: "array", items: { type: "string", enum: ["media", "photo", "video", "document", "audio"] }, description: "Complete replacement list of required evidence types for set_requirements or a new item; empty means no requirements." },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" }
        },
        required: ["action", "item_id", "title", "item_type", "note", "requirements", "confidence", "reason"]
      }
    }
  },
  required: ["title", "summary", "customer_access", "customer_access_explicit", "completion_audience", "completion_audience_explicit", "operations"]
} as const;

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function validate(value: unknown): ChecklistAudioResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("checklist_audio_invalid", "The audio model returned an invalid checklist.");
  }
  const input = value as Record<string, unknown>;
  const operations = Array.isArray(input.operations) ? input.operations : [];
  if (operations.length > 100) throw badRequest("checklist_audio_too_many_items", "A voice update can change at most 100 items.");
  return {
    title: clean(input.title).slice(0, 160) || "Voice checklist",
    summary: clean(input.summary).slice(0, 500),
    customer_access: ["view", "complete", "edit"].includes(clean(input.customer_access))
      ? clean(input.customer_access) as "view" | "complete" | "edit"
      : "private",
    customer_access_explicit: input.customer_access_explicit === true,
    completion_audience: ["everyone", "supervisor"].includes(clean(input.completion_audience))
      ? clean(input.completion_audience) as "everyone" | "supervisor"
      : "assigned",
    completion_audience_explicit: input.completion_audience_explicit === true,
    operations: operations.map((entry) => {
      const operation = entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {};
      const action = clean(operation.action);
      const title = clean(operation.title).slice(0, 500);
      if (!(["add", "complete", "add_note", "set_requirements"] as string[]).includes(action) || !title) {
        throw badRequest("checklist_audio_invalid", "The audio model returned an invalid checklist operation.");
      }
      return {
        action: action as ChecklistAudioOperation["action"],
        item_id: clean(operation.item_id),
        title,
        item_type: clean(operation.item_type) === "rating" ? "rating" : "todo",
        note: clean(operation.note).slice(0, 4000),
        requirements: [...new Set((Array.isArray(operation.requirements) ? operation.requirements : [])
          .map(clean)
          .filter((kind): kind is "media" | "photo" | "video" | "document" | "audio" => ["media", "photo", "video", "document", "audio"].includes(kind)))],
        confidence: Math.max(0, Math.min(1, Number(operation.confidence) || 0)),
        reason: clean(operation.reason).slice(0, 500)
      } as ChecklistAudioOperation;
    })
  };
}

export const checklistAudioProcessor = registerAudioStructureProcessor<ChecklistAudioContext, ChecklistAudioResult>({
  id: "checklist.operations.v1",
  instructions: [
    "Convert a spoken checklist narration into conservative checklist operations.",
    "First classify every spoken clause as COMPLETED WORK, FUTURE/PENDING WORK, or MENTION ONLY.",
    "COMPLETED WORK must match and complete an existing item by meaning. Past-tense phrases such as 'I already walked the area', 'we set the ladders', and 'the painting is done' are completed work.",
    "Use add only for explicitly future, needed, missing, newly discovered, or not-yet-done work that does not match any existing item.",
    "Never use add for something the speaker says they already did, even when their wording is shorter or uses a different tense than the existing item.",
    "Never complete an item merely because it was mentioned.",
    "Match existing items by meaning, object, and action, not exact wording or word order. 'Set the ladders' matches 'Ladders set, tied off, and inspected'.",
    "Before every add, compare it against every existing item. Prefer the closest existing item whenever the object and core action overlap.",
    "In each reason, explicitly state whether the speaker described the work as already completed or still pending.",
    "Do not add duplicates. Do not invent work. If uncertain, omit the operation.",
    "Every container is the same kind of checklist. There is no separate to-do-list or quality-list container.",
    "Classify each added item independently: use item_type todo for a task someone checks off, and item_type rating for an inspection, quality, condition, workmanship, or review item that should be rated Good, Okay, or Needs work. A single checklist may freely mix both item types.",
    "Use add_note when the speaker explicitly asks to add or replace a note on an existing item. Put the full note in note and match the existing item by id or meaning.",
    "Use set_requirements when the speaker explicitly adds, changes, or removes required evidence for an existing item. requirements is the complete replacement list: media, photo, video, document, or audio. An empty list removes all requirements.",
    "An add operation may include its initial note and requirements. Never infer evidence requirements merely because evidence would be useful.",
    "Defaults are strict: the checklist is private from the customer and assigned to its creator. Never infer customer visibility or broader completion access from the subject matter, project type, or checklist kind.",
    "Change those defaults only when the speaker is explicit. Set customer_access_explicit only for an explicit customer instruction. Set completion_audience_explicit only when the speaker explicitly says everyone, supervisors/foremen, or a specific assignee should complete it.",
    "Return the result only by calling submit_structured_audio_result."
  ].join(" "),
  schema,
  prompt(context) {
    if (context.mode === "create") {
      return [
        "Create a new checklist from the attached raw audio.",
        `Preferred title if supplied: ${clean(context.requestedTitle) || "(none)"}.`,
        "Every clear task becomes an add operation. Include explicitly requested notes and evidence requirements on that item. Ignore filler and conversation.",
        "Generate a useful short title when no preferred title was supplied.",
        "Use one ordinary checklist that may mix task and rating items. Keep private customer access and creator assignment unless the speaker explicitly requests a different setting."
      ].join("\n");
    }
    const checklist = context.checklist;
    return [
      "Update this existing checklist from the attached raw audio.",
      `Checklist title: ${clean(checklist?.title)}.`,
      `Checklist completion audience: ${clean(checklist?.audience) || "crew/everyone"}.`,
      `Checklist customer access: ${JSON.stringify(checklist?.customer_access ?? {})}.`,
      "Keep the checklist container kind unchanged. Classify each newly added item independently as todo or rating. Preserve access settings unless the speaker explicitly requests a change.",
      clean(checklist?.title).toLowerCase() === "untitled checklist"
        ? "This is a new untitled checklist: generate a useful short title from the spoken contents."
        : "Preserve the existing title unless the speaker explicitly asks to rename it.",
      "Existing items (IDs are authoritative):",
      JSON.stringify(checklist?.items ?? []),
      "Decision order for each spoken clause:",
      "1. Decide whether the speaker says it is already done or still pending.",
      "2. Search every existing item for the same real-world action, including paraphrases and shorter wording.",
      "3. If already done and a semantic match exists, return complete with that existing item ID.",
      "4. If pending and a semantic match exists, return no operation because the item already exists.",
      "5. Return add only when the work is pending/new and no semantic match exists.",
      "For explicit note or evidence-requirement changes, match the existing item and return add_note or set_requirements independently of its completion status.",
      "Example: audio 'I already walked the area and set the ladders' with items 'Work area walked and hazards identified' and 'Ladders set, tied off, and inspected' produces two complete operations and zero add operations.",
      "Complete only existing pending items. Add only genuinely new future/pending work."
    ].join("\n");
  },
  validate
});
