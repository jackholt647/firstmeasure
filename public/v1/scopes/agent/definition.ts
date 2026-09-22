// The scope-manager ("Automations") agent, declared as a framework agent.
// The tool implementations are unchanged from the original service — what
// moved to the shared runtime is the loop, trace, report_result contract,
// thread storage, and the failure epilogue. The baseline/revert machinery
// (pre-run template snapshots, trash-on-revert for created templates) lives
// in run.scratch and definition.revert now.

import { env } from "../../src/config/env.js";
import { listDocuments, readDocument, readOrganization } from "../../platform/storage.js";
import { createWorkDataResolver, registerBuiltinContextProviders } from "../../work/context.js";
import { listWorkEventDefinitions } from "../../work/events.js";
import { hasWorkAutomation } from "../../work/registry.js";
import { registerBuiltinWorkAutomations } from "../../work/automations/builtins.js";
import { createWorkPlanSchema } from "../../work/schemas.js";
import { validateDefinitionIds } from "../../work/service.js";
import { listEventRecords } from "../../work/storage.js";
import { readAutomationRules, saveAutomationRules } from "../../work/rules.js";
import { readIntakeRouting, saveIntakeRouting } from "../router.js";
import { scopeTemplateDefinitionSchema } from "../schemas.js";
import { listScopeTemplates, readScopeTemplate, saveScopeTemplate, setScopeTemplateState } from "../storage.js";
import { applyExplainerPatch, extractAutomationInventory } from "../inventory.js";
import { registerAgent } from "../../agents/registry.js";
import { normalizeCommonCore } from "../../agents/settings.js";
import type { AgentRun, AgentTool } from "../../agents/types.js";
import { asArray, asObject, cleanText, truncateJson, type JsonObject } from "../../agents/util.js";
import { buildPlatformManifest } from "./manifest.js";

// The current auth gate for the Automations settings surface: every write
// tool requires the calling user to hold it, exactly like the HTTP routes.
const WRITE_PERMISSION = "manage_company_settings";

// ── Validation pipeline for template saves ─────────────────────────────────

function collectAutomationIds(definition: JsonObject) {
  const ids: string[] = [];
  const fromBindings = (bindings: unknown) => {
    for (const entries of Object.values(asObject(bindings))) {
      for (const entry of asArray(entries)) ids.push(cleanText(asObject(entry).automation));
    }
  };
  const walk = (nodes: unknown) => {
    for (const value of asArray(nodes)) {
      const node = asObject(value);
      fromBindings(node.automation_bindings);
      walk(node.children);
    }
  };
  const workPlan = asObject(definition.work_plan);
  fromBindings(workPlan.automation_bindings);
  walk(workPlan.root_nodes);
  return ids.filter(Boolean);
}

export function validateScopeTemplateDefinition(definitionValue: JsonObject) {
  const errors: string[] = [];
  let definition: JsonObject | null = null;
  try {
    definition = scopeTemplateDefinitionSchema.parse(definitionValue) as JsonObject;
  } catch (error) {
    errors.push(`Schema validation failed: ${String(asObject(error).message || error).slice(0, 2_000)}`);
    return { ok: false, errors };
  }
  try {
    validateDefinitionIds(asArray(asObject(definition.work_plan).root_nodes) as never);
  } catch (error) {
    errors.push(`Node graph invalid: ${String(asObject(error).message || error)}`);
  }
  registerBuiltinWorkAutomations();
  for (const automationId of collectAutomationIds(definition)) {
    if (!hasWorkAutomation(automationId)) errors.push(`Unknown automation '${automationId}'.`);
  }
  const knownEvents = new Set(listWorkEventDefinitions().map((event) => event.name));
  const warnings: string[] = [];
  const walkTriggers = (nodes: unknown) => {
    for (const value of asArray(nodes)) {
      const node = asObject(value);
      for (const trigger of asArray(node.external_triggers)) {
        const eventName = cleanText(asObject(trigger).event);
        if (eventName && !knownEvents.has(eventName)) warnings.push(`Node '${node.id}' listens for unregistered event '${eventName}'.`);
      }
      walkTriggers(node.children);
    }
  };
  walkTriggers(asObject(definition.work_plan).root_nodes);
  // Dry-run compile: the same parse a real instantiation performs.
  try {
    createWorkPlanSchema.parse({
      organization_id: "dry_run",
      branch_id: "default",
      project_id: "dry_run",
      source_type: "dry_run",
      source_key: "dry_run",
      title: cleanText(definition.name) || "Dry run",
      root_nodes: asObject(definition.work_plan).root_nodes
    });
  } catch (error) {
    errors.push(`Work plan would not compile: ${String(asObject(error).message || error).slice(0, 2_000)}`);
  }
  return { ok: errors.length === 0, errors, warnings, definition };
}

// ── Baseline / revert machinery (run.scratch) ──────────────────────────────

type TemplateBaseline = { definition: JsonObject; version: number; enabled: boolean; trashed: boolean };

function baselines(run: AgentRun): Record<string, TemplateBaseline> {
  if (!run.scratch.baselines || typeof run.scratch.baselines !== "object") run.scratch.baselines = {};
  return run.scratch.baselines as Record<string, TemplateBaseline>;
}

function savedTemplateIds(run: AgentRun): string[] {
  if (!Array.isArray(run.scratch.savedTemplateIds)) run.scratch.savedTemplateIds = [];
  return run.scratch.savedTemplateIds as string[];
}

function markSaved(run: AgentRun, templateId: string) {
  const ids = savedTemplateIds(run);
  if (!ids.includes(templateId)) ids.push(templateId);
}

// First-save baselines per template, for revert on failure.
async function recordBaseline(run: AgentRun, templateId: string) {
  const store = baselines(run);
  if (store[templateId]) return;
  try {
    const current = (await readScopeTemplate(run.orgId, run.branchId, templateId));
    store[templateId] = {
      definition: JSON.parse(JSON.stringify(current.definition)) as JsonObject,
      version: Number(current.version || 1),
      enabled: current.enabled !== false,
      trashed: cleanText(asObject(current).status) === "archived"
    };
  } catch {
    // New template: baseline is "did not exist" — revert will archive it.
    store[templateId] = { definition: {}, version: 0, enabled: true, trashed: true };
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────

function focusTemplateId(run: AgentRun) {
  return run.subjectId;
}

const TOOLS: AgentTool[] = [
  {
    name: "list_scope_templates",
    description: "List every scope template (board/automation set) in the organization, including the one currently being edited.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      return {
        templates: (await listScopeTemplates(run.orgId, run.branchId, { include_disabled: true, include_archived: true })).map((template) => ({
          id: template.id,
          name: template.name,
          kind: asObject(template.definition as JsonObject).kind || "production",
          description: template.description,
          color: template.color,
          icon: template.icon,
          enabled: template.enabled !== false,
          trashed: cleanText(template.status) === "archived",
          version: template.version,
          is_current_focus: cleanText(template.id as string) === focusTemplateId(run)
        }))
      };
    }
  },
  {
    name: "read_scope_template",
    description: "Read a scope template's full JSON definition and current version.",
    parameters: { type: "object", properties: { template_id: { type: "string", description: "Template id; defaults to the template in focus." } }, additionalProperties: false },
    async execute(run, args) {
      const template = asObject((await readScopeTemplate(run.orgId, run.branchId, cleanText(args.template_id) || focusTemplateId(run))));
      return { id: template.id, version: template.version, definition: template.definition };
    }
  },
  {
    name: "save_scope_template",
    description: "Validate and save a complete template definition as a new version. Returns {ok:false, errors:[...]} on validation failure — fix and retry. Always read the current definition first and submit the WHOLE definition, not a fragment.",
    parameters: { type: "object", properties: { template_id: { type: "string" }, definition: { type: "string", description: "The full definition as a JSON string." }, change_note: { type: "string", description: "One plain-language sentence describing the change." } }, required: ["definition"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const templateId = cleanText(args.template_id) || focusTemplateId(run);
      let definition: JsonObject;
      try {
        definition = typeof args.definition === "string" ? JSON.parse(args.definition) : asObject(args.definition);
      } catch (error) {
        return { ok: false, errors: [`definition is not valid JSON: ${String(error)}`] };
      }
      definition = { ...definition, id: templateId };
      const validation = validateScopeTemplateDefinition(definition);
      if (!validation.ok) return { ok: false, errors: validation.errors, warnings: validation.warnings || [] };
      (await recordBaseline(run, templateId));
      let expectedVersion = 0;
      try {
        expectedVersion = Number((await readScopeTemplate(run.orgId, run.branchId, templateId)).version || 0);
      } catch {
        expectedVersion = 0;
      }
      const saved = (await saveScopeTemplate(run.orgId, run.branchId, {
        ...(validation.definition as JsonObject),
        ...(expectedVersion ? { expected_version: expectedVersion } : {})
      }));
      markSaved(run, templateId);
      run.changeLog.push(cleanText(args.change_note) || `Updated template ${templateId}.`);
      return { ok: true, template_id: templateId, version: saved.version, warnings: validation.warnings || [] };
    }
  },
  {
    name: "update_template_appearance",
    description: "Quickly update the template's customer-facing name, color (hex or css), icon (font-awesome class), or description without touching automations.",
    parameters: { type: "object", properties: { template_id: { type: "string" }, name: { type: "string" }, color: { type: "string" }, icon: { type: "string" }, description: { type: "string" } }, additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const templateId = cleanText(args.template_id) || focusTemplateId(run);
      const template = (await readScopeTemplate(run.orgId, run.branchId, templateId));
      (await recordBaseline(run, templateId));
      const definition = {
        ...asObject(template.definition as JsonObject),
        ...(cleanText(args.name) ? { name: cleanText(args.name) } : {}),
        ...(cleanText(args.color) ? { color: cleanText(args.color) } : {}),
        ...(cleanText(args.icon) ? { icon: cleanText(args.icon) } : {}),
        ...(args.description !== undefined ? { description: cleanText(args.description) } : {})
      };
      const saved = asObject((await saveScopeTemplate(run.orgId, run.branchId, { ...definition, expected_version: template.version })));
      markSaved(run, templateId);
      run.changeLog.push(`Updated appearance of ${templateId}.`);
      return { ok: true, version: saved.version, name: saved.name, color: saved.color, icon: saved.icon };
    }
  },
  {
    name: "manage_scope_template",
    description: "Enable, disable, move to trash, or restore a board. Trash is always a reversible soft delete and never destroys versions or project history.",
    parameters: { type: "object", properties: { template_id: { type: "string", description: "Template id; defaults to the board in focus." }, action: { type: "string", enum: ["enable", "disable", "trash", "restore"] } }, required: ["action"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const templateId = cleanText(args.template_id) || focusTemplateId(run);
      const action = cleanText(args.action).toLowerCase();
      const statePatch: JsonObject = action === "enable"
        ? { enabled: true }
        : action === "disable"
          ? { enabled: false }
          : action === "trash"
            ? { trashed: true }
            : action === "restore"
              ? { trashed: false }
              : {};
      if (!Object.keys(statePatch).length) {
        return { ok: false, errors: ["Choose enable, disable, trash, or restore."] };
      }
      (await recordBaseline(run, templateId));
      const result = (await setScopeTemplateState(run.orgId, run.branchId, templateId, statePatch));
      markSaved(run, templateId);
      run.changeLog.push(action === "trash"
        ? `Moved ${templateId} to the trash.`
        : `${action.charAt(0).toUpperCase() + action.slice(1)}d ${templateId}.`);
      return { ok: true, template_id: templateId, ...result.state };
    }
  },
  {
    name: "get_automation_inventory",
    description: "List the automation inventory (triggers, bindings, timers) of a template with keys, explainers, and visibility — including hidden entries.",
    parameters: { type: "object", properties: { template_id: { type: "string" }, include_hidden: { type: "boolean" } }, additionalProperties: false },
    async execute(run, args) {
      const template = (await readScopeTemplate(run.orgId, run.branchId, cleanText(args.template_id) || focusTemplateId(run)));
      return {
        entries: extractAutomationInventory(template.definition as JsonObject, { include_hidden: args.include_hidden !== false })
      };
    }
  },
  {
    name: "set_automation_explainer",
    description: "Set or clear the natural-language explainer and/or customer visibility of one inventory entry by key.",
    parameters: { type: "object", properties: { template_id: { type: "string" }, key: { type: "string" }, explainer: { type: "string" }, customer_visible: { type: "boolean" } }, required: ["key"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const templateId = cleanText(args.template_id) || focusTemplateId(run);
      const template = (await readScopeTemplate(run.orgId, run.branchId, templateId));
      (await recordBaseline(run, templateId));
      const patched = applyExplainerPatch(template.definition as JsonObject, cleanText(args.key), {
        ...(args.explainer !== undefined ? { explainer: cleanText(args.explainer) } : {}),
        ...(args.customer_visible !== undefined ? { customer_visible: args.customer_visible === true } : {})
      });
      const saved = (await saveScopeTemplate(run.orgId, run.branchId, { ...patched, expected_version: template.version }));
      markSaved(run, templateId);
      run.changeLog.push(`Updated automation description in ${templateId}.`);
      return { ok: true, version: saved.version };
    }
  },
  {
    name: "get_org_automation_rules",
    description: "Read the organization-wide automation rules (the always-on layer above scope templates).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      return await readAutomationRules(run.orgId, run.branchId);
    }
  },
  {
    name: "save_org_automation_rules",
    description: "Replace the organization automation rules. Submit the complete rules array.",
    parameters: { type: "object", properties: { rules: { type: "string", description: "JSON array of rules." } }, required: ["rules"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      let rules: unknown;
      try {
        rules = typeof args.rules === "string" ? JSON.parse(args.rules) : args.rules;
      } catch (error) {
        return { ok: false, errors: [`rules is not valid JSON: ${String(error)}`] };
      }
      const errors: string[] = [];
      registerBuiltinWorkAutomations();
      for (const rule of asArray(rules)) {
        const automationId = cleanText(asObject(rule).automation);
        if (automationId && !hasWorkAutomation(automationId)) errors.push(`Unknown automation '${automationId}'.`);
      }
      if (errors.length) return { ok: false, errors };
      const saved = await saveAutomationRules(run.orgId, run.branchId, { rules });
      run.changeLog.push("Updated organization automation rules.");
      return { ok: true, revision: saved.revision, rules: saved.rules };
    }
  },
  {
    name: "get_intake_routing",
    description: "Read project-scope groups, the default entry scope, and optional new-project field routing rules.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      return await readIntakeRouting(run.orgId, run.branchId);
    }
  },
  {
    name: "save_intake_routing",
    description: "Replace project-scope grouping and intake routing ({buckets, default_template_id, routing_mode, rules:[{formula, template_id}]}).",
    parameters: { type: "object", properties: { routing: { type: "object", additionalProperties: true } }, required: ["routing"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const saved = await saveIntakeRouting(run.orgId, run.branchId, { data: asObject(args.routing) });
      run.changeLog.push("Updated intake routing.");
      return { ok: true, ...saved };
    }
  },
  {
    name: "read_data",
    description: "Read any platform data by dot path: organization.*, users.*, pricebook.*, scopes.*, branch.<moduleId>.*, money.* (with project_id), work.* (with project_id).",
    parameters: { type: "object", properties: { path: { type: "string" }, project_id: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(run, args) {
      registerBuiltinContextProviders();
      const path = cleanText(args.path);
      if (!path) return { error: "A dot path is required, e.g. organization.name or users.list." };
      const resolver = createWorkDataResolver({
        organization_id: run.orgId,
        branch_id: run.branchId,
        project_id: cleanText(args.project_id),
        event: {},
        plan: {},
        node: {}
      });
      const value = await resolver.resolve(path.split("."));
      return { path, value: JSON.parse(truncateJson(value)) };
    }
  },
  {
    name: "list_projects",
    description: "List the organization's projects with lifecycle and active scope instances.",
    parameters: { type: "object", properties: { search: { type: "string" }, limit: { type: "number" } }, additionalProperties: false },
    async execute(run, args) {
      const documents = await listDocuments(run.orgId, "projects");
      const search = cleanText(args.search).toLowerCase();
      const projects = documents
        .map((document): JsonObject => ({ ...asObject(document.data), id: cleanText(document.id as string) }))
        .filter((project) => !search
          || cleanText(project.title).toLowerCase().includes(search)
          || cleanText(project.address).toLowerCase().includes(search))
        .slice(0, Math.min(100, Math.max(1, Number(args.limit || 25))))
        .map((project) => ({
          id: project.id,
          title: project.title,
          address: project.address,
          lifecycle: asObject(project.lifecycle),
          instances: asArray(asObject(project.work_projection).active_instances).map((instance) => ({
            template_id: asObject(instance).template_id,
            stage_title: asObject(instance).stage_title
          }))
        }));
      return { projects, count: projects.length };
    }
  },
  {
    name: "read_project",
    description: "Read one project document in full.",
    parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    async execute(run, args) {
      const document = await readDocument(run.orgId, "projects", cleanText(args.project_id));
      return { project: JSON.parse(truncateJson({ id: document.id, ...asObject(document.data) })) };
    }
  },
  {
    name: "list_activity",
    description: "List recent activity events (org-wide or for one project).",
    parameters: { type: "object", properties: { project_id: { type: "string" }, limit: { type: "number" }, include_system: { type: "boolean" } }, additionalProperties: false },
    async execute(run, args) {
      const events = (await listEventRecords(run.orgId, {
        project_id: cleanText(args.project_id),
        visibility: args.include_system === true ? "" : "activity",
        limit: Math.min(200, Math.max(1, Number(args.limit || 50)))
      })).map((event) => ({ type: event.type, project_id: event.project_id, payload: event.payload, created_at: event.created_at }));
      return { events };
    }
  },
  {
    name: "get_call_lists",
    description: "List the organization's call queues (fully data-driven: key, title, kind, icon, tone, assignment, per-list workflow settings, pending counts).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      const { listCallLists } = await import("../../internal/crm/call_lists.js");
      const result = await listCallLists(run.orgId);
      return { call_lists: result.call_lists };
    }
  },
  {
    name: "save_call_list",
    description: "Create or update a call queue. Fields: key (required), title, description, kind, icon, tone, sort_order, status ('archived' hides it), assigned_user_ids, assigned_role_ids, and settings (per-list workflow config: dispositions, outcomes, retry policy overrides). Entries are added to lists by automations (crm.callLists.add.v1), never hardcoded.",
    parameters: { type: "object", properties: { list: { type: "string", description: "The list definition as a JSON string." } }, required: ["list"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const { ensureCallList } = await import("../../internal/crm/call_lists.js");
      let definition: JsonObject;
      try {
        definition = typeof args.list === "string" ? JSON.parse(args.list) : asObject(args.list);
      } catch (error) {
        return { ok: false, errors: [`list is not valid JSON: ${String(error)}`] };
      }
      const saved = await ensureCallList(run.orgId, definition);
      run.changeLog.push(`Updated call list '${cleanText(asObject(saved).key)}'.`);
      return { ok: true, call_list: saved };
    }
  }
];

// ── Registration ───────────────────────────────────────────────────────────

export const SCOPE_AGENT_ID = "scope";

registerAgent({
  id: SCOPE_AGENT_ID,
  title: "Automations Agent",
  description: "The automations manager in the Automations settings tab: configures boards (scope templates), automation explainers, organization automation rules, intake routing, and call queues by chat.",
  capability: "crm.automations",
  usePermission: "manage_company_settings",
  threadScope: "org",
  model: () => ({
    model: env.openaiScopeAgentModel,
    effort: env.openaiScopeAgentEffort,
    timeoutMs: env.openaiScopeAgentTimeoutMs
  }),
  loop: { maxRounds: 16 },
  settings: {
    defaults: () => normalizeCommonCore({}, { enabled: true, display_name: "Automations Agent", custom_instructions: "" }) as unknown as JsonObject,
    normalize: (raw) => normalizeCommonCore(raw, { enabled: true, display_name: "Automations Agent", custom_instructions: "" }) as unknown as JsonObject
  },
  async systemPrompt(run) {
    let orgName = "";
    try {
      const record = asObject(await readOrganization(run.orgId));
      orgName = cleanText(asObject(record.data).name || record.name);
    } catch {}
    let inventorySummary = "";
    try {
      const template = (await readScopeTemplate(run.orgId, run.branchId, focusTemplateId(run)));
      inventorySummary = extractAutomationInventory(template.definition as JsonObject)
        .map((entry) => `- [${entry.key}] ${entry.explainer}`)
        .join("\n");
    } catch {}
    const customInstructions = cleanText(run.settings.custom_instructions);
    return `You are the automations manager for "${orgName || "this company"}" on the FirstMate platform — the expert who configures how their projects, sales pipelines, and automations behave. You are talking to a business owner, not a developer.

${buildPlatformManifest()}

## Current focus
You are editing the template "${focusTemplateId(run)}" (branch ${run.branchId}). Its current customer-visible automations:
${inventorySummary || "(none visible yet)"}

## Working rules
- Understand the request, read whatever you need (templates, data, activity), make the edits with the tools, and verify saves succeed.
- If the customer has not supplied enough business detail to make a safe automation decision, ask one focused plain-language question instead of guessing. A no-change clarification turn is a successful result.
- Boards can be enabled, disabled, moved to trash, and restored with manage_scope_template. Trash is reversible; never describe it as permanent deletion.
- When you add or change an automation, ALWAYS give it a clear customer-facing explainer (and keep internal machinery hidden by leaving explainers off or setting customer_visible false).
- Validation errors from save_scope_template tell you exactly what to fix — iterate until the save succeeds. If you cannot succeed after a few attempts, call report_result with status "failed" (your saves will be reverted) and explain simply.
- ALWAYS finish by calling report_result, then give the customer a short, friendly reply in plain language: what you changed or found, no jargon, no JSON, no event or node names.
- Answer questions about how their automations and apps behave using the manifest and live data — you can read everything.
- NEVER invent phone numbers, email addresses, or any contact details. Look them up (read_data users.list / users.by_id include phone and email); if the needed detail is missing from the data, ASK the customer for it instead of guessing or using a placeholder.
- When a request applies beyond this board (an organization automation rule), say so plainly in your reply ("this applies to every board, not just this one") — and give every org rule you write a clear customer-facing "explainer" field so it appears in their automations list.
- Text messages send through the company's SMS service; if their texting setup may not be live yet, mention the message will start delivering once texting is active.${customInstructions ? `\n\n## Company instructions\n${customInstructions}` : ""}`;
  },
  tools: TOOLS,
  // Failed runs revert every saved template to its pre-run version (or trash
  // templates the run created). Returns the reverted template ids.
  async revert(run) {
    const reverted: string[] = [];
    const store = baselines(run);
    for (const templateId of savedTemplateIds(run)) {
      const baseline = store[templateId];
      if (!baseline) continue;
      try {
        if (baseline.version > 0) {
          const current = (await readScopeTemplate(run.orgId, run.branchId, templateId));
          (await saveScopeTemplate(run.orgId, run.branchId, {
            ...baseline.definition,
            expected_version: Number(current.version || 0)
          }));
          (await setScopeTemplateState(run.orgId, run.branchId, templateId, {
            enabled: baseline.enabled,
            trashed: baseline.trashed
          }));
          reverted.push(templateId);
        } else {
          (await setScopeTemplateState(run.orgId, run.branchId, templateId, { trashed: true }));
          reverted.push(templateId);
        }
      } catch {
        // Best effort — leave whatever state exists and report.
      }
    }
    return reverted;
  }
});
