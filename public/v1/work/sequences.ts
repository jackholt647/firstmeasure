// Sequences: "do this, wait, then do that" on a work item.
//
// A node definition may declare
//
//   sequence: {
//     start: "ready" | "started",          // default "ready"
//     steps: [
//       { id: "text_now", actions: [ { automation, input } ] },
//       { id: "email_later", wait: { days: 2 }, conditions: {...}, actions: [ ... ] }
//     ]
//   }
//
// Each step runs its actions in order. `wait` is the delay after the previous
// step, so step times accumulate from the moment the work item becomes ready
// (or starts). Completing, skipping or canceling the work item ends the
// sequence — bind an external trigger such as `communication.received` to stop
// a follow-up cadence when the customer replies.
//
// A sequence is authoring sugar. It compiles to the primitives the engine
// already runs: one-shot node timers plus bindings on the timer and lifecycle
// hooks. Compiled entries are marked `compiled_from: "sequence"` so a
// definition can be recompiled any number of times.

import { z } from "zod";

import { allConditions } from "./conditions.js";

type Json = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export const SEQUENCE_MARK = "sequence";

export const workTimerSchema = z.object({
  id: z.string().trim().min(1).max(180),
  anchor: z.enum(["created", "ready", "started", "due"]).optional(),
  offset_minutes: z.number().min(0).max(5_256_000).optional(),
  explainer: z.string().max(2_000).optional()
}).passthrough();

const waitSchema = z.object({
  minutes: z.number().min(0).optional(),
  hours: z.number().min(0).optional(),
  days: z.number().min(0).optional(),
  weeks: z.number().min(0).optional()
}).strict();

export const workSequenceSchema = z.object({
  start: z.enum(["ready", "started"]).optional(),
  enabled: z.boolean().optional(),
  steps: z.array(z.object({
    id: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/, "Step ids use letters, numbers, underscores and hyphens."),
    title: z.string().trim().max(300).optional(),
    explainer: z.string().max(2_000).optional(),
    enabled: z.boolean().optional(),
    wait: waitSchema.optional(),
    conditions: z.object({}).passthrough().optional(),
    // Each action is an automation binding; its shape is checked with the node's bindings.
    actions: z.array(z.object({ automation: z.string().trim().min(1).max(220) }).passthrough()).min(1).max(50)
  }).passthrough()).min(1).max(100)
}).passthrough().superRefine((sequence, context) => {
  const seen = new Set<string>();
  sequence.steps.forEach((step, index) => {
    if (seen.has(step.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "id"], message: "Step ids must be unique within a sequence." });
    seen.add(step.id);
  });
});

export function waitMinutes(value: unknown) {
  const wait = asObject(value);
  return Math.max(0, Number(wait.minutes || 0) + Number(wait.hours || 0) * 60 + Number(wait.days || 0) * 1_440 + Number(wait.weeks || 0) * 10_080);
}

export function sequenceTimerId(stepId: string) {
  return `sequence:${stepId}`;
}

const compiled = (value: unknown) => asObject(value).compiled_from === SEQUENCE_MARK;

/** Expands one node's `sequence` into timers and bindings. Nodes without a sequence are returned unchanged. */
export function compileNodeSequence<T extends Json>(node: T): T {
  const hadCompiled = asArray(node.timers).some(compiled)
    || Object.values(asObject(node.automation_bindings)).some((list) => asArray(list).some(compiled));
  const sequence = asObject(node.sequence);
  const steps = sequence.enabled === false ? [] : asArray(sequence.steps).map(asObject);
  if (!steps.length && !hadCompiled) return node;

  const timers = asArray(node.timers).filter((timer) => !compiled(timer));
  const bindings: Record<string, unknown[]> = Object.fromEntries(Object.entries(asObject(node.automation_bindings))
    .map(([key, list]) => [key, asArray(list).filter((binding) => !compiled(binding))]));
  const anchor = text(sequence.start) === "started" ? "started" : "ready";
  const startHook = anchor === "started" ? "onStarted" : "onReady";
  let offset = 0;
  for (const step of steps) {
    offset += waitMinutes(step.wait);
    if (step.enabled === false) continue;
    const stepId = text(step.id);
    const timerId = sequenceTimerId(stepId);
    const immediate = offset === 0;
    if (!immediate) timers.push({ id: timerId, anchor, offset_minutes: offset, compiled_from: SEQUENCE_MARK, sequence_step: stepId, ...(text(step.explainer) ? { explainer: text(step.explainer) } : {}) });
    const hook = immediate ? startHook : "onTimer";
    asArray(step.actions).map(asObject).forEach((action, index) => {
      (bindings[hook] ||= []).push({
        ...action,
        id: `sequence_${stepId}_${text(action.id) || index + 1}`,
        conditions: allConditions(immediate ? {} : { "payload.timer_id": timerId }, step.conditions, action.conditions),
        ...(text(action.explainer || step.explainer) ? { explainer: text(action.explainer || step.explainer) } : {}),
        compiled_from: SEQUENCE_MARK,
        sequence_step: stepId
      });
    });
  }
  const automation_bindings = Object.fromEntries(Object.entries(bindings).filter(([, list]) => list.length));
  const next: Json = { ...node, automation_bindings };
  if (timers.length) next.timers = timers; else delete next.timers;
  return next as T;
}

/** Compiles every sequence in a list of node definitions, recursively. */
export function compileSequences<T>(nodes: T[]): T[] {
  return nodes.map((value) => {
    const node = asObject(value);
    const next = compileNodeSequence(node);
    return (Array.isArray(next.children) ? { ...next, children: compileSequences(next.children) } : next) as T;
  });
}

/** A scope definition with the sequences of its work plan compiled. */
export function compileDefinitionSequences<T extends Json>(definition: T): T {
  const workPlan = asObject(definition.work_plan);
  if (!Array.isArray(workPlan.root_nodes)) return definition;
  return { ...definition, work_plan: { ...workPlan, root_nodes: compileSequences(workPlan.root_nodes) } };
}

/** The schedule a sequence produces, for explanations and dry runs. */
export function describeSequence(node: Json) {
  const sequence = asObject(node.sequence);
  let offset = 0;
  return asArray(sequence.steps).map(asObject).map((step) => {
    offset += waitMinutes(step.wait);
    return {
      id: text(step.id), title: text(step.title), enabled: sequence.enabled !== false && step.enabled !== false,
      after_minutes: offset, anchor: text(sequence.start) === "started" ? "started" : "ready",
      actions: asArray(step.actions).map((action) => text(asObject(action).automation))
    };
  });
}
