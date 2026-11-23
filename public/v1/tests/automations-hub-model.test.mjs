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

// GP-119: nothing under a name is printed all the time; what explains it is a tooltip (an (i), or the box's own).
test("the chart's explanations are tooltips, not small print under the names", () => {
  for (const rule of [".fmah-lead small", ".fmah-sink small", ".fmah-lane-label small"]) assert.equal(source.includes(`${rule}{`), false, `${rule} is gone`);
  assert.match(source, /\$\{info\(routingNote\)\}/, "New leads explains itself in a tooltip");
  assert.match(source, /lane\.id === SALES \? info\(/, "so does the Sales lane");
  assert.match(source, /\$\{summary \? ` title="\$\{esc\(summary\)\}"` : ''\}/, "a lead box's summary (\"Any new lead\": click to split) is its tooltip");
  assert.match(source, /data-sink="unscoped" title=/, "and No board yet's");
});

// GP-119: the setup asks how the company runs, and skips what an answer already says.
test("the setup asks business questions, never where leads go", async () => {
  const setup = await import(new URL("../../libraries/guided-experiences/automations-setup.js", import.meta.url));
  assert.deepEqual(setup.pagesFor({}), ["job_known", "first_call", "visit", "handoff", "done"]);
  assert.deepEqual(setup.pagesFor({ job_known: "no" }), ["job_known", "visit", "handoff", "done"], "someone who finds out on the phone calls first");
  const text = await readFile(new URL("../../libraries/guided-experiences/automations-setup.js", import.meta.url), "utf8");
  assert.equal(/Where do (your )?new leads go/i.test(text), false);
});

// Flows (docs/architecture/flows.md): a flow is drawn between what starts it and where each of its outcomes leads.
const newLeadCall = {
  id: "new_lead_call", latest_version: 3, published_version: 3,
  definition: { name: "New lead call", kind: "call", icon: "fa-phone-volume", color: "#2563eb", start: "dial",
    outcomes: [
      { id: "ready", label: "Ready for an appointment", color: "#16a34a", effects: [{ automation: "scopes.activateTemplate.v1", input: { template_id: "sales_pipeline", instance_key: "new_lead_flow" } }] },
      { id: "call_back", label: "Call back later", effects: [] },
      { id: "no_answer", label: "No answer", effects: [] },
      { id: "not_interested", label: "Not interested", effects: [{ automation: "sales.markLost.v1", input: { reason: "not_interested" } }] }
    ],
    steps: [
      { id: "dial", title: "Call the lead", blocks: [{ id: "n", kind: "note", text: "Call {{contact.name}}." },
        { id: "answered", kind: "choice", key: "answered", label: "Did they answer?", options: [{ id: "yes", label: "They answered", to: "greet" }, { id: "no", label: "No answer", to: "no_answer" }, { id: "wrong", label: "Wrong number", outcome: "not_interested" }] }], next: null },
      { id: "no_answer", title: "No answer", blocks: [{ id: "retry", kind: "action", label: "Try the lead again", automation: "work.createTodo.v1", input: {} }, { id: "end", kind: "outcome", outcome: "no_answer" }], next: null },
      { id: "greet", title: "They answered", blocks: [{ id: "hi", kind: "say", text: "Hi, is this {{contact.first_name}}?" },
        { id: "q", kind: "ask", key: "need", label: "What do you need done?", input: "select", options: [{ id: "a", label: "A replacement" }, { id: "b", label: "A repair" }] }], next: "next" },
      { id: "next", title: "What's next?", blocks: [{ id: "result", kind: "choice", key: "result", label: "How did it go?", options: [{ id: "ready", label: "They want an appointment", outcome: "ready" }, { id: "later", label: "Call them back later", outcome: "call_back" }] }], next: null },
      { id: "orphan", title: "Nothing reaches this", blocks: [], next: null }
    ],
    entry: { new_menu: { enabled: false, label: "Lead" } } }
};
const manualLead = { id: "new_lead", latest_version: 1, published_version: 1, definition: { name: "New lead", start: "who", outcomes: [], steps: [{ id: "who", title: "Who is it?", blocks: [], next: null }], entry: { new_menu: { enabled: true, label: "Lead" } } } };
const unused = { id: "tshirts", latest_version: 1, published_version: 1, definition: { name: "T-shirt order", start: "a", outcomes: [], steps: [{ id: "a", blocks: [], next: null }], entry: {} } };
const rules = [
  { id: "start_new_lead_call", enabled: true, event: "lead.received", automation: "flows.start.v1", input: { flow_id: "new_lead_call" }, title: "Call each new lead" },
  { id: "old", enabled: false, event: "lead.received", automation: "flows.start.v1", input: { flow_id: "tshirts" } }
];

test("a flow is drawn when a rule or the New menu starts it, with each outcome's destination read from its effects", () => {
  const flows = model.flowsOf([newLeadCall, manualLead, unused], rules);
  assert.deepEqual(flows.map((flow) => [flow.id, flow.starts.map((start) => start.kind === "rule" ? `${start.event}:${start.rule_id}` : start.kind)]),
    [["new_lead_call", ["lead.received:start_new_lead_call"]], ["new_lead", ["new_menu"]]], "a rule that is off starts nothing; a flow nothing starts is not drawn");
  assert.deepEqual(flows[0].outcomes.map((outcome) => [outcome.id, outcome.kind, outcome.to, outcome.follow_up === true]), [
    ["ready", "board", "sales_pipeline", false],
    ["call_back", "stay", "", false],
    ["no_answer", "stay", "", true],
    ["not_interested", "lost", "lost", false]
  ], "no answer stays a new lead with the follow-up its step leaves");
  assert.equal(flows[0].version, 3);
});

test("dropping an outcome's dot on a board makes that outcome start the board; on lost it marks the lead lost", () => {
  const definition = newLeadCall.definition;
  const toRoof = model.withOutcomeTarget(definition, "ready", "roof_replacement", "new_lead_call");
  assert.deepEqual(toRoof.outcomes[0].effects.map((effect) => [effect.automation, effect.input.template_id, effect.input.instance_key]),
    [["scopes.activateTemplate.v1", "roof_replacement", "new_lead_flow"]], "the board it started before keeps its instance key");
  const callBack = model.withOutcomeTarget(definition, "call_back", "sales_pipeline", "new_lead_call").outcomes[1];
  assert.deepEqual(callBack.effects.map((effect) => [effect.automation, effect.input.template_id, effect.input.instance_key]), [["scopes.activateTemplate.v1", "sales_pipeline", "flow_new_lead_call"]]);
  const lostToBoard = model.withOutcomeTarget(definition, "not_interested", "sales_pipeline").outcomes[3];
  assert.deepEqual(lostToBoard.effects.map((effect) => effect.automation), ["scopes.activateTemplate.v1"], "an outcome that goes to a board is no longer lost");
  const readyLost = model.withOutcomeTarget(definition, "ready", "lost").outcomes[0];
  assert.deepEqual(readyLost.effects.map((effect) => effect.automation), ["sales.markLost.v1"]);
  assert.deepEqual(model.withOutcomeTarget(definition, "ready", "unscoped").outcomes[0].effects, [], "no board yet: it stays where it is");
  assert.equal(model.outcomeTarget(toRoof.outcomes[0], toRoof).to, "roof_replacement");
  assert.equal(definition.outcomes[0].effects[0].input.template_id, "sales_pipeline", "the original is not changed");
  assert.equal(model.withOutcomeTarget(definition, "missing", "x"), null);
});

test("the whole flow: steps from the start in the order they are reached, with where each answer goes", () => {
  const outline = model.outlineOf(newLeadCall.definition);
  assert.deepEqual(outline.map((step) => step.id), ["dial", "greet", "next", "no_answer", "orphan"], "reached depth first from the start, then anything nothing reaches");
  assert.deepEqual(outline[0].exits.map((exit) => [exit.label, exit.step_title || exit.outcome_label]),
    [["They answered", "They answered"], ["No answer", "No answer"], ["Wrong number", "Not interested"]]);
  assert.deepEqual(outline[1].lines.map((line) => [line.kind, line.text, line.options]), [["say", "Hi, is this {{contact.first_name}}?", []], ["ask", "What do you need done?", ["A replacement", "A repair"]]]);
  assert.deepEqual(outline[1].exits.map((exit) => exit.to), ["next"]);
  assert.deepEqual(outline[3].exits.map((exit) => exit.outcome_label), ["No answer"]);
});
