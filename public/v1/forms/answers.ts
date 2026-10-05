import type { JsonObject } from "../platform/storage.js";
import { conditionsMatch, type FormDefinition, type FormItem } from "./contracts.js";

export type AnswerIssue = { item_id: string; param: string; message: string };

const str = (value: unknown, max = 4000) => String(value ?? "").trim().slice(0, max);
const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalize(item: FormItem, raw: unknown): { value?: unknown; error?: string } {
  switch (item.kind) {
    case "contact": {
      const input = obj(raw);
      const value: JsonObject = {};
      for (const key of ["name", "email", "phone"] as const) {
        const field = item.fields[key];
        if (!field.enabled) continue;
        const entry = str(input[key], key === "email" ? 320 : key === "phone" ? 40 : 120);
        if (!entry) {
          if (field.required) return { error: `Enter your ${key === "name" ? "name" : key === "email" ? "email address" : "phone number"}.` };
          continue;
        }
        if (key === "email" && !EMAIL.test(entry)) return { error: "Enter a valid email address." };
        if (key === "phone" && entry.replace(/\D/g, "").length < 7) return { error: "Enter a valid phone number." };
        value[key] = key === "email" ? entry.toLowerCase() : entry;
      }
      return Object.keys(value).length ? { value } : {};
    }
    case "number": {
      if (raw === "" || raw === null || raw === undefined) return {};
      const value = Number(raw);
      if (!Number.isFinite(value)) return { error: "Enter a number." };
      if (item.min !== undefined && value < item.min) return { error: `Enter ${item.min} or more.` };
      if (item.max !== undefined && value > item.max) return { error: `Enter ${item.max} or less.` };
      return { value };
    }
    case "select": {
      const value = str(raw, 80);
      if (!value) return {};
      return item.options.some((option) => option.value === value) ? { value } : { error: "Choose one of the listed options." };
    }
    case "multi_select": {
      const allowed = new Set(item.options.map((option) => option.value));
      const value = [...new Set((Array.isArray(raw) ? raw : raw ? [raw] : []).map((entry) => str(entry, 80)).filter((entry) => allowed.has(entry)))];
      return value.length ? { value } : {};
    }
    case "boolean": {
      // "No" is an answer; only an untouched question is empty.
      if (raw === true || ["true", "1", "yes", "on"].includes(str(raw).toLowerCase())) return { value: true };
      if (raw === false || ["false", "0", "no", "off"].includes(str(raw).toLowerCase())) return { value: false };
      return {};
    }
    case "consent": {
      const value = raw === true || ["true", "1", "yes", "on"].includes(str(raw).toLowerCase());
      return value ? { value } : {};
    }
    case "date": {
      const value = str(raw, 10);
      if (!value) return {};
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(new Date(`${value}T12:00:00Z`).getTime()) ? { value } : { error: "Enter a valid date." };
    }
    case "appointment": {
      const start = str(obj(raw).start_at || (typeof raw === "string" ? raw : ""), 40);
      if (!start) return {};
      const date = new Date(start);
      return Number.isFinite(date.getTime()) ? { value: { start_at: date.toISOString() } } : { error: "Choose an appointment time." };
    }
    case "text": {
      const value = str(raw, 300);
      return value ? { value } : {};
    }
    default: {
      const value = str(raw);
      return value ? { value } : {};
    }
  }
}

function requiredMessage(item: FormItem) {
  if (item.kind === "consent") return "Please check this box to continue.";
  if (item.kind === "appointment") return "Choose an appointment time.";
  if (item.kind === "select" || item.kind === "multi_select") return "Choose an option.";
  return "This field is required.";
}

/**
 * Validates raw answers against the definition in step order, applying the
 * same visibility rules as the embed. Answers to hidden blocks are dropped.
 * `provided` seeds server-owned values (measurements) that conditions may read.
 */
export function collectAnswers(definition: FormDefinition, raw: unknown, provided: JsonObject = {}) {
  const input = obj(raw);
  const answers: JsonObject = { ...provided };
  const issues: AnswerIssue[] = [];
  for (const step of definition.steps) {
    if (!conditionsMatch(step.visible_when, answers)) continue;
    for (const item of step.items) {
      if (!item.param || item.kind === "property_measurement") continue;
      if (!conditionsMatch(item.visible_when, answers)) continue;
      const result = normalize(item, input[item.param]);
      if (result.error) issues.push({ item_id: item.id, param: item.param, message: result.error });
      else if (result.value !== undefined) answers[item.param] = result.value;
      else if (item.required || item.kind === "consent") issues.push({ item_id: item.id, param: item.param, message: requiredMessage(item) });
    }
  }
  return { answers, issues };
}

/** Labelled answers for staff views and notification emails. */
export function summarizeAnswers(definition: FormDefinition, answers: JsonObject) {
  const rows: Array<{ label: string; value: string }> = [];
  for (const step of definition.steps) for (const item of step.items) {
    if (!item.param || !Object.hasOwn(answers, item.param)) continue;
    const value = answers[item.param];
    const label = item.label || step.title || item.param;
    if (item.kind === "contact" || item.kind === "property_measurement" || item.kind === "consent") continue;
    if (item.kind === "appointment") continue;
    if (item.kind === "select") rows.push({ label, value: item.options.find((option) => option.value === value)?.label || str(value) });
    else if (item.kind === "multi_select") rows.push({ label, value: (Array.isArray(value) ? value : []).map((entry) => item.options.find((option) => option.value === entry)?.label || str(entry)).join(", ") });
    else if (item.kind === "boolean") rows.push({ label, value: value ? "Yes" : "No" });
    else if (item.kind === "number") rows.push({ label, value: `${value}${item.unit ? ` ${item.unit}` : ""}` });
    else rows.push({ label, value: str(value) });
  }
  return rows;
}
