import { registerDataProvider } from "../platform/publication/providers.js";
import type { AccessPolicy, JsonSchema } from "../platform/publication/contracts.js";
import { forbidden } from "../platform/errors.js";
import { describeSetupSteps, listSetupSteps, stepSatisfied } from "./setup-steps.js";
import { ensureGuidedDefinitions } from "./service.js";

/**
 * The setup step catalog on the publication layer (docs/architecture/setup-steps.md). `catalog` lists every step:
 * what it asks, what it requires, what writes its answer and what reads it. `status` says, for the reader's
 * organization, which steps are answered; each answer itself is read from the provider its step names
 * (company.type and company.services: `company-profile.profile`).
 */
const copy: JsonSchema = { type: "object", properties: { key: { type: "string" }, text: { type: "string" } }, required: ["key", "text"], additionalProperties: false };
const catalogItem: JsonSchema = { type: "object", additionalProperties: false, required: ["id", "version", "scope", "title", "description", "requires", "satisfied", "writes", "ui", "experience"], properties: {
  id: { type: "string" }, version: { type: "integer" }, scope: { type: "string", enum: ["organization", "person"] }, title: copy, description: copy,
  requires: { type: "array", items: { type: "string" } },
  satisfied: { type: "object", additionalProperties: false, required: ["provider", "export"], properties: { provider: { type: "string" }, export: { type: "string" }, path: { type: "string" } } },
  writes: { type: "object", additionalProperties: false, required: ["action", "target"], properties: { action: { type: "string" }, target: { type: "string" } } },
  ui: { type: "object", additionalProperties: false, required: ["widget"], properties: { widget: { type: "string" }, module: { type: "string" } } },
  experience: { type: "string" }
} };
const statusItem: JsonSchema = { type: "object", additionalProperties: false, required: ["id", "answered"], properties: { id: { type: "string" }, answered: { type: "boolean" } } };
const access: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], systemKinds: ["module", "agent"] };

let registered = false;
export function registerSetupStepPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "setup-steps", version: "1", apps: ["onboarding"], exports: {
    catalog: { description: "Every setup step: what it asks, the steps it requires, the action that saves its answer and the published read that says it is answered.",
      schema: { type: "array", items: catalogItem }, schemaVersion: "1", access,
      read: async () => { ensureGuidedDefinitions(); return { value: describeSetupSteps() }; } },
    status: { description: "Which setup steps this organization (or, for a person's step, the reader) has answered, read through each step's own published source.",
      schema: { type: "array", items: statusItem }, schemaVersion: "1", access,
      read: async (ctx) => {
        if (!ctx.auth) throw forbidden("setup_steps_person", "Setup step status is read as a person.");
        ensureGuidedDefinitions();
        const value = [];
        for (const step of listSetupSteps()) value.push({ id: step.id, answered: await stepSatisfied(ctx.auth, step) });
        return { value };
      } }
  } });
}
