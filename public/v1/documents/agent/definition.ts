// The document designer agent ("docs") — the chat copilot embedded in the
// document engine's editing surfaces: the Doc Studio workflow editor, the
// Doc Studio template editor, and project document instances.
//
// Unlike the stats/scope agents it does NOT persist anything server-side.
// The editing surface sends the CURRENT in-editor definition with every
// message (body.input), the agent proposes a complete replacement through a
// validated tool, and the client applies the returned action to the live
// editor state — the user still saves/publishes through the normal buttons.
// That keeps undo, dirty tracking, and optimistic-concurrency exactly where
// they already live (the editor), while validation stays authoritative here.

import { env } from "../../src/config/env.js";
import { hasPermission } from "../../platform/auth.js";
import { registerAgent } from "../../agents/registry.js";
import { normalizeCommonCore } from "../../agents/settings.js";
import type { AgentRun, AgentTool } from "../../agents/types.js";
import {
  asObject,
  cleanText,
  toolError,
  parseJsonArg,
  truncateJson,
  type JsonObject
} from "../../agents/util.js";
import { FMDocModel } from "../schemas.js";
import { workflowDefinitionSchema } from "../workflows/schemas.js";
import { listWorkflowItemKinds } from "../workflows/kinds.js";

const WRITE_PERMISSION = "manage_documents|manage_websites";
const STUDIO_PERMISSION = "manage_documents";

/** Plain-language help per workflow item kind, surfaced to the model. */
const ITEM_KIND_NOTES: Record<string, string> = {
  text: "Free text input.",
  currency: "Money amount in integer cents.",
  number: "Numeric input.",
  select: "Single choice; supply options or options_from.",
  multi_select: "Multiple choice; supply options or options_from.",
  boolean: "Yes/no toggle.",
  date: "Date picker.",
  media_picker: "Photo/file picker.",
  measurements: "Measurement fields (fields or fields_from); params only.",
  piece_picker: "Legacy scope configurator bridge; params only.",
  piece_select: "Scope piece-type selection cards; params only.",
  line_items_review: "Generated line-items review (writes params.scope_items).",
  content_blocks: "Rows of text/media content blocks; params only.",
  line_item_editor: "Direct line-item editing; params only.",
  choice_group: "Customer-facing option group choice; outputs only.",
  review: "Read-only review step (optional live preview); writes nothing.",
  generate_document: "Server mints a document from config {template_id?/document_type?, title?, copy_params?} when the step completes; writes its ref to an outputs.* key.",
  signature: "Signature capture; outputs only.",
  payment: "Payment collection; outputs only (config.source points at the amount)."
};

function mode(run: AgentRun): string {
  const value = cleanText(asObject(run.input).mode).toLowerCase();
  return ["workflow", "template", "document", "website"].includes(value) ? value : "";
}

function currentDefinition(run: AgentRun): JsonObject {
  return asObject(asObject(run.input).definition);
}

function itemKindCatalog(): JsonObject[] {
  return listWorkflowItemKinds().map((kind) => ({
    id: kind.id,
    writes: kind.writes,
    note: ITEM_KIND_NOTES[kind.id] || ""
  }));
}

function zodIssueList(issues: Array<{ path: Array<string | number>; message: string }>): string[] {
  return issues.slice(0, 12).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

const TOOLS: AgentTool[] = [
  {
    name: "get_current_definition",
    description: "Read the FULL definition currently open in the editor (the workflow definition or DocModel document). Use this whenever you need detail the conversation summary does not include — the editor state is the source of truth, not earlier messages.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute(run) {
      const definition = currentDefinition(run);
      if (!Object.keys(definition).length) return toolError("The editor did not send a definition with this message.");
      return { mode: mode(run), definition };
    }
  },
  {
    name: "list_workflow_item_kinds",
    description: "List every registered workflow item kind with its allowed write target (params/outputs/any/none) and a usage note. Call before inventing item kinds.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    gate(run) {
      return mode(run) === "workflow" ? true : "Item kinds only apply when a workflow is open.";
    },
    execute() {
      return { item_kinds: itemKindCatalog() };
    }
  },
  {
    name: "update_workflow_definition",
    description: "Validate and stage a COMPLETE replacement workflow definition. The editor applies it immediately (the user still publishes). Always start from the current definition and submit the whole thing, never a fragment. Returns {ok:false, errors:[...]} on validation failure — fix and retry.",
    parameters: {
      type: "object",
      properties: {
        definition: { type: "string", description: "The full workflow definition as a JSON string: { schema_version, name, contract:{params,outputs}, steps:[{..., sections?:[{id,title,when?,items:[...]}], items?:[...]}], audiences? }. Steps are pages; sections are conditional field sections." },
        change_note: { type: "string", description: "One plain-language sentence describing the change." }
      },
      required: ["definition"],
      additionalProperties: false
    },
    permission: STUDIO_PERMISSION,
    gate(run) {
      return mode(run) === "workflow" ? true : "No workflow is open in the editor right now.";
    },
    execute(run, args) {
      const definition = parseJsonArg(args.definition, "definition");
      const parsed = workflowDefinitionSchema.safeParse(definition);
      if (!parsed.success) {
        return { ok: false, errors: zodIssueList(parsed.error.issues as never) };
      }
      run.actions.push({ type: "workflow.set_definition", definition });
      run.changeLog.push(cleanText(args.change_note) || "Updated the workflow definition.");
      return { ok: true, steps: (definition.steps as unknown[] | undefined)?.length ?? 0 };
    }
  },
  {
    name: "update_document",
    description: "Validate and stage a COMPLETE replacement DocModel document for the open template or document. The editor applies it immediately (the user still saves/publishes). Always start from the current definition and submit the whole document, never a fragment. Preserve existing node ids wherever content survives. Returns {ok:false, errors:[...]} on validation failure — fix and retry.",
    parameters: {
      type: "object",
      properties: {
        document: { type: "string", description: "The full DocModel document as a JSON string." },
        change_note: { type: "string", description: "One plain-language sentence describing the change." }
      },
      required: ["document"],
      additionalProperties: false
    },
    permission: WRITE_PERMISSION,
    gate(run) {
      const current = mode(run);
      if (current === "website") return run.ctx && hasPermission(run.ctx, "manage_websites") ? true : "Website editing is unavailable to this user.";
      if (current === "template" || current === "document") return run.ctx && hasPermission(run.ctx, "manage_documents") ? true : "Document editing is unavailable to this user.";
      return "No document, template, or website page is open in the editor right now.";
    },
    execute(run, args) {
      const document = parseJsonArg(args.document, "document");
      const validation = FMDocModel.validateDocument(document);
      if (!validation.ok) {
        return { ok: false, errors: validation.errors.slice(0, 12).map((e) => `${e.path || "(root)"}: ${e.message}`) };
      }
      run.actions.push({ type: "document.set_definition", document });
      run.changeLog.push(cleanText(args.change_note) || "Updated the document.");
      return { ok: true, pages: (document.pages as unknown[] | undefined)?.length ?? 0 };
    }
  }
];

const WORKFLOW_GUIDE = `## Workflow definition format (contract §8)
A workflow is the guided stepper reps/customers walk through to fill a document. Shape:
{ "schema_version": 1, "name": "...", "contract": { "params": {...}, "outputs": {...} },
  "steps": [ { "id": "st_x", "title": "...", "when"?: "{{expr}}", "audience"?: ["internal"|"customer"|"field"],
    "sections"?: [ { "id": "sec_x", "title"?: "...", "when"?: "{{expr}}", "style"?: {"background"?:"#fff"}, "transition"?: {"type":"grow"|"fade"|"slide"|"none","duration_ms"?:220},
      "items": [ { "kind": "...", "writes": "params.x" | "outputs.y", "label"?, "when"?, "required"?, "options"?, "options_from"?, "prefill"?, "config"?, "presentation"? } ] } ],
    "items"?: [ ...legacy unsectioned items... ] } ],
  "audiences"?: { "customer": { "hide_steps": [...] } } }
Rules:
- Step ids must be unique (prefix "st_"). Every item's kind must be registered (list_workflow_item_kinds).
- writes paths are params.* or outputs.* — signature/payment/choice_group write outputs only; measurements/piece/line-item/content kinds write params only; review writes nothing.
- When contract.params/outputs declare keys, every writes root key must be declared there.
- "when" uses {{...}} expressions over params/outputs (e.g. "{{count(params.x) > 0}}").
- Treat steps as workflow pages. Prefer sections for new work; sections and fields may each have independent visibility and entrance transitions. Choice fields default to presentation.style "tiles" and may be switched to "radio" or "dropdown".
- audience defaults to internal. Customer steps should only contain customer-appropriate items (review, choice_group, signature, payment, simple inputs).`;

export const DOCMODEL_GUIDE = `## DocModel document format
A document is { schema_version, kind:"document", settings:{paper:{size,orientation}, base_font_pt, locale}, theme_ref, params, computed, outputs, edit_policy, metadata, pages:[...] }.
Each page: { id:"pg_*", role ("cover"|"body"|...), name, master_ref, children:[nodes] }.
Each node: { id:"nd_*", type, name, frame:{x,y,w,h,z,layout:"absolute"|"flow"}, style, props, visible, locks? }. Coordinates are points on a 612x792 letter page.
Node types include: text (props.blocks: [{type:"heading"|"paragraph", level?, align?, runs:[{text, font:{family,size_pt,weight,color}, binding?}]}]), shape (props.shape:"rect"|"ellipse"|"polygon", style.fill/stroke/radius), image (props.media_ref), widget (props.widget_id + config — pricing tables, signature blocks, etc.), group, repeater.
- Text can bind data with {{...}} interpolation over params.*, customer.*, project.*, org.*; keep bindings intact when rewording.
- Colors/fonts should use theme tokens (var(--fm-primary), var(--fm-accent), var(--fm-text), var(--fm-font-display), var(--fm-font-body)) so themes restyle the document.
- Preserve node ids for content that survives your edit; generate new ids (nd_ + 7 random chars) only for new nodes, unique document-wide.
- When adding a page, use role "body" unless the user explicitly asks for a cover, and copy the existing document's header/body/footer scaffold and typography instead of inventing new region coordinates or font scales. Page-master chrome has a protected content inset; body content must begin inside that safe area.
- Children in a flow frame are positioned by flow, not by x/y coordinates. Keep new flow children at x:0,y:0 with layout:"flow"; use h:"auto" for text. Never use a fixed text height that can separate, clip, or overlap its rendered glyphs.
- Never remove params/outputs/edit_policy/metadata unless asked — they carry the template contract.`;

const WEBSITE_GUIDE = `## DocModel website-page format
A website page uses the same visual engine with { schema_version, kind:"view", settings, theme_ref, metadata, root:{ type:"frame", frame:{x:0,y:0,w,h,layout:"flow"}, children:[sections...] } }.
Each root child is a visual section frame. Sections contain normal visual nodes (text, image, shape, widget, frame, table) with point-based frames relative to that section.
- Preserve kind:"view", the root node, existing node ids, responsive position metadata, section_width settings, theme bindings, and all content the user did not ask to change.
- Keep top-level sections in root.children and preserve their order. New sections should use frame.layout:"absolute", square or intentionally styled corners, and props.section_width consistent with neighboring sections.
- Prefer theme tokens (var(--fm-primary), var(--fm-accent), var(--fm-text), var(--fm-font-display), var(--fm-font-body)) so brand changes continue to work.
- Preserve desktop/mobile variant relationships and responsive frame.position data. Do not convert the page into a paged kind:"document" definition.
- Do not add document pages, headers, footers, signatures, or print-only scaffolds to a website view.`;

export const DOCS_AGENT_ID = "docs";

registerAgent({
  id: DOCS_AGENT_ID,
  title: "Document Designer",
  description: "The document engine copilot: builds and edits workflows, templates, and documents conversationally right inside the editor.",
  capability: "documents.agent",
  usePermission: "view_documents|view_websites",
  threadScope: "user",
  model: () => ({
    model: env.openaiDocsAgentModel,
    effort: env.openaiDocsAgentEffort,
    timeoutMs: env.openaiDocsAgentTimeoutMs
  }),
  loop: { maxRounds: 12, maxOutputTokens: 24_000 },
  settings: {
    defaults: () => ({ enabled: true, display_name: "Document Designer", custom_instructions: "" }),
    normalize: (raw) => ({ ...normalizeCommonCore(raw, { display_name: "Document Designer" }) })
  },
  systemPrompt(run) {
    const input = asObject(run.input);
    const currentMode = mode(run);
    const subject = asObject(input.subject);
    const definition = currentDefinition(run);
    const definitionJson = Object.keys(definition).length
      ? truncateJson(definition, 60_000)
      : "(the editor did not send one — ask the user to reopen the editor)";
    const customInstructions = cleanText(asObject(run.settings).custom_instructions);

    const modeLine = currentMode === "workflow"
      ? `You are editing the WORKFLOW "${cleanText(subject.name) || "Untitled"}" (id ${cleanText(subject.id) || "unknown"}, v${Number(subject.current_version || 0)}).`
      : currentMode === "template"
        ? `You are editing the document TEMPLATE "${cleanText(subject.name) || "Untitled"}" (id ${cleanText(subject.id) || "unknown"}, type ${cleanText(subject.document_type) || "generic"}).`
        : currentMode === "website"
          ? `You are editing the WEBSITE PAGE "${cleanText(subject.name) || "Untitled"}" (id ${cleanText(subject.id) || "unknown"}, site ${cleanText(subject.site_name) || cleanText(subject.site_id) || "unknown"}).`
        : currentMode === "document"
          ? `You are editing the DOCUMENT "${cleanText(subject.name) || "Untitled"}" (id ${cleanText(subject.id) || "unknown"}, status ${cleanText(subject.status) || "draft"}).`
          : "No editor context was provided with this message.";

    const guide = currentMode === "workflow" ? WORKFLOW_GUIDE : currentMode === "website" ? WEBSITE_GUIDE : DOCMODEL_GUIDE;
    const applyTool = currentMode === "workflow" ? "update_workflow_definition" : "update_document";

    return `You are the document designer for this company on the FirstMate platform — a copilot embedded beside the document editor. You are talking to a business user, not a developer: they describe what they want in plain language and you make the edit for them.

## Current focus
${modeLine}

${guide}

## The definition currently open in the editor
${definitionJson}

## Working rules
- Your edits go through ${applyTool}: build the COMPLETE new definition (starting from the current one above, or get_current_definition when you need to re-read it) and submit the whole thing. The editor applies it live in front of the user; they still Save/Publish themselves.
- Make the change the user asked for and keep everything else intact — never drop steps, pages, nodes, params, or settings they didn't ask you to touch.
- Validation errors from the tool tell you exactly what to fix — iterate until the update succeeds. If you cannot succeed after a few attempts, call report_result with status "failed" and explain simply.
- When a request is ambiguous (which step, which page, what wording), make the most reasonable interpretation, do it, and say what you assumed — don't interrogate the user.
- ALWAYS finish by calling report_result, then reply in short plain language describing what changed on the canvas. No JSON, no field names, no jargon.${customInstructions ? `\n\n## Company instructions\n${customInstructions}` : ""}`;
  },
  tools: TOOLS
});
