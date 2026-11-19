import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The Automations Hub flowchart (GP-110, docs/architecture/automations-hub.md): what it draws from the scope templates,
// scope categories and intake routing, and what a drag writes back.
const source = await readFile(new URL("../../libraries/apps/automations-hub/app.js", import.meta.url), "utf8");
const window = {};
new Function("window", "globalThis", source)(window, window);
const model = window.FirstMateAutomationsHub.model;

const stage = (id, title, todos = 1, bindings) => ({ id, title, children: Array.from({ length: todos }, (_, i) => ({ id: `${id}_todo_${i}`, title: `To-do ${i}`, actionable: true })), ...(bindings ? { automation_bindings: bindings } : {}) });
const template = (id, categories, stages, extra = {}) => ({ id, name: id.replace(/_/g, " "), enabled: true, status: "active", version: 3,
  definition: { id, category_ids: categories, work_plan: { root_nodes: [{ id: `${id}_phase`, title: id, children: stages }] }, ...extra } });

const sales = template("sales_pipeline", ["sales"], [
  stage("new_lead", "New Lead"),
  stage("closing", "Pending Deposit", 2, { onCompleted: [{ id: "won", automation: "sales.markWon.v1", input: {} }, { id: "to_roof", automation: "scopes.activateTemplate.v1", input: { template_id: "roof_replacement" } }] })
]);
const roof = template("roof_replacement", ["production"], [stage("scheduled", "Scheduled", 3), stage("installed", "Installed")]);
const both = template("roofing_job", ["sales", "production", "storm"], [stage("inspect", "Inspect")]);
const intake = template("call_first", ["intake"], [stage("call", "Call")]);
const off = { ...template("old_board", ["production"], [stage("x", "X")]), enabled: false };
const loose = template("warranty", ["warranty"], [stage("claim", "Claim")]);
const categories = [
  { id: "sales", label: "Sales", enabled: true, builtin: true }, { id: "intake", label: "Intake", enabled: true, builtin: true },
  { id: "production", label: "Production", enabled: true }, { id: "warranty", label: "Warranty", enabled: false }
];

test("lanes are the enabled categories except intake; boards sit in the lanes of their categories", () => {
  const lanes = model.lanesOf(categories);
  assert.deepEqual(lanes.map((lane) => lane.id), ["sales", "production"]);
  const boards = model.boardsOf([sales, roof, both, intake, off, loose], lanes);
  assert.deepEqual(boards.map((board) => [board.id, board.rows]), [["sales_pipeline", [0]], ["roof_replacement", [1]], ["roofing_job", [0, 1]], ["warranty", []]],
    "intake scopes and boards that are off are not drawn; a board in a disabled category is in no lane");
  assert.deepEqual(model.stagesOf(roof.definition).map((s) => [s.title, s.todos]), [["Scheduled", 3], ["Installed", 1]]);
});

test("links are the bindings that start another scope, from the stage they are in", () => {
  const links = model.linksOf(sales);
  assert.equal(links.length, 1);
  assert.deepEqual([links[0].from, links[0].to, links[0].stage_title, links[0].proposal], ["sales_pipeline", "roof_replacement", "Pending Deposit", false]);
  const proposal = template("p", ["sales"], [stage("sign", "Sign", 1, { onCompleted: [{ id: "signed", automation: "scopes.activateFromProposal.v1", input: {} }] })]);
  assert.deepEqual(model.linksOf(proposal).map((link) => [link.to, link.proposal]), [["proposal", true]]);
});

test("a board dropped on a lane is in it; on the line between two lanes it is in both; other categories stay", () => {
  const lanes = model.lanesOf(categories);
  const boxes = [{ top: 0, bottom: 200 }, { top: 200, bottom: 400 }];
  assert.deepEqual(model.dropRows(100, boxes), [0]);
  assert.deepEqual(model.dropRows(210, boxes), [0, 1], "within the edge of the line");
  assert.deepEqual(model.dropRows(300, boxes), [1]);
  assert.deepEqual(model.dropRows(-50, boxes), [0]);
  assert.deepEqual(model.dropCategories(["production", "storm"], lanes, [0, 1]), ["sales", "production", "storm"]);
  assert.deepEqual(model.dropCategories(["sales", "production", "storm"], lanes, [1]), ["production", "storm"]);
});

test("columns: entry boards first, a board beside the board that starts it, spans never overlap", () => {
  const lanes = model.lanesOf(categories);
  const boards = model.boardsOf([sales, roof, both], lanes);
  const links = boards.flatMap((board) => model.linksOf(board.template));
  const place = model.placeBoards(boards, links, ["sales_pipeline"]);
  assert.deepEqual(place, { sales_pipeline: 0, roof_replacement: 0, roofing_job: 1 });
});

test("the lead row is the routing rules in order, then every other lead; a split adds rules to the condition contract", () => {
  const routing = { routing_mode: "formula", default_entry: "scope", default_template_id: "sales_pipeline", rules: [
    { id: "missed", enabled: true, title: "Missed calls", entry: "unscoped", template_id: "", formula: { match: "all", conditions: [{ field: "lead_source.kind", operator: "in", value: "missed_call" }] } }
  ] };
  const leads = model.leadsOf(routing);
  assert.deepEqual(leads.map((lead) => [lead.id, lead.to, lead.fallback === true]), [["rule:missed", "", false], ["default", "sales_pipeline", true]]);
  assert.equal(leads[0].summary, "Where it came from is any of Missed calls");
  assert.deepEqual(model.leadsOf({ ...routing, routing_mode: "default" }).map((lead) => lead.id), ["default"], "rules routing ignores are not drawn");
  const time = model.splitRule("time", { to: "roof_replacement" });
  assert.deepEqual([time.entry, time.template_id, time.formula.match, time.formula.conditions.map((c) => c.field)],
    ["scope", "roof_replacement", "any", ["lead_source.received_local.hour", "lead_source.received_local.hour", "lead_source.received_local.weekday"]]);
  assert.equal(model.splitRule("source", { source: "web_form" }).entry, "unscoped", "no destination yet means it stays a new lead");
});

test("connecting two boards adds one activateTemplate binding to the last stage; removing it takes only that one", () => {
  const next = model.withLink(roof.definition, "installed", "warranty");
  const installed = next.work_plan.root_nodes[0].children[1];
  assert.deepEqual(installed.automation_bindings.onCompleted.map((b) => [b.automation, b.input.template_id]), [["scopes.activateTemplate.v1", "warranty"]]);
  assert.equal(model.withLink(next, "installed", "warranty").work_plan.root_nodes[0].children[1].automation_bindings.onCompleted.length, 1, "connecting twice adds nothing");
  assert.equal(roof.definition.work_plan.root_nodes[0].children[1].automation_bindings, undefined, "the original is not changed");
  const link = model.linksOf({ id: "roof_replacement", definition: next }).find((item) => item.to === "warranty");
  const removed = model.withoutLink(sales.definition, model.linksOf(sales)[0]);
  assert.deepEqual(removed.work_plan.root_nodes[0].children[1].automation_bindings.onCompleted.map((b) => b.id), ["won"], "the sale is still marked won");
  assert.equal(model.linksOf({ id: "roof_replacement", definition: model.withoutLink(next, link) }).length, 0);
});
