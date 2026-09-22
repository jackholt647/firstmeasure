import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const docEditor = await readFile(new URL("../../libraries/doc-editor/firstmate-doc-editor.js", import.meta.url), "utf8");
const workflowEditor = await readFile(new URL("../../libraries/doc-workflow/firstmate-workflow-editor.js", import.meta.url), "utf8");
const webEditor = await readFile(new URL("../../libraries/apps/web-editor/app.js", import.meta.url), "utf8");
const documentStudio = await readFile(new URL("../../libraries/apps/documents/studio.js", import.meta.url), "utf8");
const agentDefinition = await readFile(new URL("../documents/agent/definition.ts", import.meta.url), "utf8");

test("shared preview keeps only the Agent side panel available", () => {
  assert.match(docEditor, /fmde-mode-preview\.fmde-preview-agent/);
  assert.match(docEditor, /state\.mode === "preview" && String\(panel\.id\) !== "agent"/);
  assert.match(docEditor, /const addPreviewAgentGroup = function \(\)/);
  assert.match(docEditor, /Edit with Agent while previewing/);
  assert.match(docEditor, /openDocumentAgent\(""\)/);
  assert.doesNotMatch(workflowEditor, /fmve-kind-workflow \.fmde-mode-preview \.fmde-inspector\{display:none!important\}/);
});

test("document and workflow hosts continue to supply the shared Agent panel", () => {
  assert.match(documentStudio, /id:\s*['"]agent['"]/);
  assert.match(documentStudio, /mountTemplateAgent/);
  assert.match(documentStudio, /mountWorkflowAgent/);
  assert.match(workflowEditor, /sidePanels:\s*\[flowPanel, \.\.\.suppliedPanels\]/);
});

test("website editor supplies an Agent that applies live DocModel updates", () => {
  assert.match(webEditor, /function mountWebAgent\(hostEl\)/);
  assert.match(webEditor, /mode:\s*'website'/);
  assert.match(webEditor, /type\) !== 'document\.set_definition'/);
  assert.match(webEditor, /setDocument\?\.\(document_, \{ source: 'agent' \}\)/);
  assert.match(webEditor, /sidePanels:\s*webAgentEnabled\(\)/);
});

test("document Agent accepts website view definitions", () => {
  assert.match(agentDefinition, /\["workflow", "template", "document", "website"\]\.includes\(value\)/);
  assert.match(agentDefinition, /const WEBSITE_GUIDE/);
  assert.match(agentDefinition, /currentMode === "website" \? WEBSITE_GUIDE/);
  assert.match(agentDefinition, /current === "template" \|\| current === "document" \|\| current === "website"/);
});
