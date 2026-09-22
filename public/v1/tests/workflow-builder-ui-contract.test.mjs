import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const studio = await readFile(new URL("../../libraries/apps/documents/studio.js", import.meta.url), "utf8");
const workflowEditor = await readFile(new URL("../../libraries/doc-workflow/firstmate-workflow-editor.js", import.meta.url), "utf8");
const visualEditor = await readFile(new URL("../../libraries/visual-editor/firstmate-visual-editor.js", import.meta.url), "utf8");
const runtime = await readFile(new URL("../../libraries/doc-workflow/firstmate-doc-workflow.js", import.meta.url), "utf8");
const renderer = await readFile(new URL("../../libraries/doc-renderer/firstmate-doc-renderer.js", import.meta.url), "utf8");
const widgets = await readFile(new URL("../../libraries/doc-widgets/firstmate-doc-widgets.js", import.meta.url), "utf8");
const docEditor = await readFile(new URL("../../libraries/doc-editor/firstmate-doc-editor.js", import.meta.url), "utf8");

test("workflow builder is a thin wrapper around the shared visual editor", () => {
  assert.match(studio, /FMWorkflowEditor\.mount/);
  assert.match(workflowEditor, /FMVisualEditor\.mount/);
  assert.match(workflowEditor, /contentKind: 'workflow'/);
  assert.match(workflowEditor, /customTabs: \[fieldsTab/);
  assert.match(workflowEditor, /const flowPanel = \{ id: 'flow'/);
  assert.match(workflowEditor, /pages,/);
  assert.doesNotMatch(studio, /fmdx-wf-page-canvas/);
  assert.doesNotMatch(studio, /application\/x-firstmate-workflow-kind/);
  assert.match(visualEditor, /customTabs/);
});

test("workflow preview owns fixed pagination and does not persist preview answers", () => {
  assert.match(workflowEditor, /preview answers reset when you return to the builder/);
  assert.match(workflowEditor, /interactivePreview: true/);
  assert.match(workflowEditor, /Previous/);
  assert.match(workflowEditor, /Submit/);
  assert.match(runtime, /data-fmdw-back><i[^>]*><\/i> Previous/);
  assert.match(runtime, /'Submit'/);
});

test("workflow pages contain normal visual sections plus workflow field widgets", () => {
  assert.match(workflowEditor, /M\.createDocument\(\{ kind: 'view'/);
  assert.match(workflowEditor, /doc\.workflow_field@1/);
  assert.match(workflowEditor, /api\.insertSections/);
  assert.match(workflowEditor, /api\.insertNode/);
  assert.match(workflowEditor, /Element flow/);
  assert.match(workflowEditor, /props\.workflow_visibility/);
});

test("new workflow fields stack full-width and grow square-cornered sections", () => {
  assert.match(workflowEditor, /const FIELD_MARGIN_PT = 28/);
  assert.match(workflowEditor, /const FIELD_GUTTER_PT = 12/);
  assert.match(workflowEditor, /previousBottom \+ FIELD_GUTTER_PT/);
  assert.match(workflowEditor, /w: width/);
  assert.match(workflowEditor, /prop: 'frame\.h', value: neededHeight/);
  assert.match(workflowEditor, /radius: 0/);
  assert.match(workflowEditor, /corner_radius: 0/);
  assert.match(workflowEditor, /onClick: \(\) => insertWorkflowField\(build\(\)\)/);
});

test("workflow insertion defaults do not override later manual placement", () => {
  assert.match(workflowEditor, /function useManualWorkflowPlacement\(node, parentWidthPt\)/);
  assert.match(workflowEditor, /mode: 'manual'/);
  assert.match(workflowEditor, /viewResponsiveDefault: 'manual'/);
  assert.match(docEditor, /default_responsive_mode: opts\.viewResponsiveDefault/);
  assert.match(docEditor, /return Number\(rootW\) > 0 \? Number\(rootW\) : paper\.w_pt/);
  assert.match(visualEditor, /\.fmve-kind-workflow \.fmwe-ch-pagecard \.thumb \{ width: 68px; height: 68px; max-width: 68px; aspect-ratio: 1 \/ 1; \}/);
  assert.match(visualEditor, /contentKind === 'workflow' && isViewDefinition\(definition\)/);
});

test("workflow pages use a fixed 600px maximum without changing website widths", () => {
  assert.match(workflowEditor, /const WORKFLOW_MAX_WIDTH_PX = 600/);
  assert.match(workflowEditor, /const WORKFLOW_WIDTH_PT = WORKFLOW_MAX_WIDTH_PX \* 72 \/ 96/);
  assert.match(workflowEditor, /designWidthPt: WORKFLOW_WIDTH_PT/);
  assert.match(workflowEditor, /sectionMaxWidthPx: WORKFLOW_MAX_WIDTH_PX/);
  assert.match(workflowEditor, /sectionWidthLocked: true/);
  assert.match(workflowEditor, /workflow_max_width_px: WORKFLOW_MAX_WIDTH_PX/);
  assert.match(workflowEditor, /root\.frame = \{ \.\.\.objectValue\(root\.frame\), w: WORKFLOW_WIDTH_PT \}/);
  assert.match(workflowEditor, /root\.style = \{ \.\.\.objectValue\(root\.style\), fill: null \}/);
  assert.match(workflowEditor, /section\.frame = \{ \.\.\.objectValue\(section\.frame\), x: 0, w: 'auto' \}/);
  assert.match(workflowEditor, /width_percent: 100/);
  assert.match(visualEditor, /const sectionMaxWidthPx = \(\) =>/);
  assert.match(visualEditor, /chromeOpts\.sectionWidthLocked === true/);
  assert.match(visualEditor, /max_enabled: true, max_width_px: Math\.min\(maximum, sizing\.max_width_px\)/);
  assert.doesNotMatch(studio, /sectionMaxWidthPx/);
});

test("workflow field actions are real shared-editor controls", () => {
  assert.doesNotMatch(widgets, /workflow-field-tools/);
  assert.doesNotMatch(widgets, /\["⋮", "↳", "⚙"\]/);
  assert.match(workflowEditor, /className = 'fmwfe-field-actions'/);
  assert.match(workflowEditor, /Duplicate below/);
  assert.match(workflowEditor, /Edit display condition/);
  assert.match(workflowEditor, /Field settings/);
  assert.match(docEditor, /opts\.elementContextItems/);
  assert.match(workflowEditor, /elementContextItems\(context\)/);
});

test("workflow field editing is compact, direct, and structured", () => {
  assert.match(visualEditor, /panel\.dataset\.activeTab = panelOpen \? state\.chromeTab : ''/);
  assert.match(workflowEditor, /data-active-tab="fields"\]\{flex-basis:270px;max-width:270px\}/);
  assert.match(workflowEditor, /fmwe-ch-panel-body\{width:270px;flex-basis:270px;padding:0\}/);
  assert.match(workflowEditor, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(workflowEditor, /font-size:7\.5px/);
  assert.match(workflowEditor, /overflow-wrap:anywhere/);
  assert.match(workflowEditor, /replace\(\/\\bbio\\b\/gi, 'BIO'\)/);
  assert.match(workflowEditor, /ghostClass: 'fmwfe-field-drag-ghost'/);
  assert.match(workflowEditor, /function fieldDragPreview\(kind\)/);
  assert.match(visualEditor, /options\.ghostClass/);
  assert.match(docEditor, /isWorkflowField \? "Field Settings"/);
  assert.match(docEditor, /fmde-widget-controls-field-settings/);
  assert.match(widgets, /itemLabel: "Choice"/);
  assert.match(widgets, /itemFields: \[/);
  assert.match(workflowEditor, /data-fmwfe-choice-add/);
  assert.match(workflowEditor, /data-fmwfe-choice-remove/);
  assert.doesNotMatch(workflowEditor, /data-fmwfe-options/);
});

test("workflow fields support descriptive and type-specific presentation", () => {
  assert.match(widgets, /fmdoc-workflow-field-description/);
  assert.match(widgets, /border-left: 3pt solid var\(--fmdoc-primary/);
  assert.match(widgets, /width: min\(100%,260pt\)/);
  assert.match(widgets, /fmdoc-workflow-input-shell/);
  assert.match(widgets, /kind === "currency" \? "0\.00"/);
  assert.match(widgets, /Collect payment/);
  assert.match(widgets, /key: "description", label: "Description"/);
  assert.match(docEditor, /case "textarea": control = textareaField/);
  assert.match(workflowEditor, /description: firstText\(source\.description, source\.help_text\)/);
  assert.match(workflowEditor, /data-fmwfe-description/);
  assert.match(workflowEditor, /base\.description = firstText\(config\.description/);
});

test("runtime renders conditional workflow sections with entrance transitions", () => {
  assert.match(runtime, /function stepSections/);
  assert.match(runtime, /whenPasses\(section\.when/);
  assert.match(runtime, /fmdw-enter-grow/);
  assert.match(runtime, /presentation\.style/);
});

test("disabled template elements remain visible and non-interactive", () => {
  assert.match(runtime, /fmdw-capability-disabled/);
  assert.match(runtime, /item\.disabled === true/);
  assert.match(renderer, /fmdoc-capability-disabled/);
  assert.match(renderer, /documents\.payments/);
  assert.match(renderer, /aria-disabled/);
});
