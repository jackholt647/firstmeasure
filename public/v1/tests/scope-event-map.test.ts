import assert from "node:assert/strict";
import test from "node:test";
import { buildScopeEventMap } from "../scopes/event-map.js";
import { registerBuiltinWorkAutomations } from "../work/automations/builtins.js";
import { DEFAULT_SCOPE_TEMPLATES } from "../scopes/presets/index.js";

registerBuiltinWorkAutomations();

test("scope map preserves unused events, hidden bindings, nested triggers and function inputs", () => {
  const definition = { name:"Roof", work_plan:{ title:"Roof", root_nodes:[{ id:"install", title:"Install", children:[{
    id:"deposit", title:"Deposit", external_triggers:[{ event:"payment.received", transition:"active", conditions:{ "payload.payment_kind":["deposit", "deposit_partial"] } }],
    automation_bindings:{ onStarted:[{ id:"custom", automation:"custom.handler.v1", customer_visible:false, input:{ code:"return context.project.id", amount:"{{money.balance}}" } }] }
  }] }] } };
  const before = JSON.stringify(definition);
  const map = buildScopeEventMap(definition);
  assert.equal(JSON.stringify(definition), before);
  assert.equal(map.events.find((e) => e.name === "proposal.viewed")!.connections.length, 0);
  const trigger = map.events.find((e) => e.name === "payment.received")!.connections[0]!;
  assert.equal(trigger.next_event, "work.node.started");
  assert.equal(trigger.location, "Roof / Install / Deposit");
  assert.deepEqual(trigger.conditions, { "payload.payment_kind":["deposit", "deposit_partial"] });
  const action = map.events.find((e) => e.name === "work.node.started")!.connections[0]!;
  assert.equal(action.automation, "custom.handler.v1");
  assert.deepEqual(action.input, { code:"return context.project.id", amount:"{{money.balance}}" });
});

test("automatic setup uses runtime defaults and explicit IDs override without duplicate actions", () => {
  const map = buildScopeEventMap({ checklists:[{ id:"safety" }], materials:{ lists:[{ id:"roof" }] }, work_plan:{ automation_bindings:{ onStarted:[{
    id:"default_initialize_scope_checklists", automation:"checklists.initializeFromScope.v1", enabled:false
  }] } } });
  const connections = map.events.find((e) => e.name === "work.plan.started")!.connections;
  assert.equal(connections.filter((c) => c.automation === "checklists.initializeFromScope.v1").length, 1);
  assert.equal(connections.find((c) => c.automation === "checklists.initializeFromScope.v1")!.enabled, false);
  assert.equal(connections.find((c) => c.automation === "materials.initializeFromScope.v1")!.source, "Automatic setup");
});

test("commission hooks, timers and organization policies retain their provenance", () => {
  const map = buildScopeEventMap({ commissions:{ rules:[{ id:"sales", trigger:{ node_id:"finish", hook:"onCompleted" }, installments:[] }] }, work_plan:{ root_nodes:[{ id:"finish", title:"Finish", timers:[{ id:"remind", anchor:"ready", offset_minutes:30 }] }] } }, [{ id:"notify", event:"work.node.completed", automation:"notification.create.v1", conditions:{ "project.lifecycle.status":"open" }, enabled:false }]);
  const completed = map.events.find((e) => e.name === "work.node.completed")!.connections;
  assert.equal(completed.find((c) => c.source === "Commission rule")!.automation, "payroll.commission.rule.v1");
  assert.equal(completed.find((c) => c.source === "Organization rule")!.enabled, false);
  assert.equal(map.events.find((e) => e.name === "work.node.timer")!.connections[0]!.kind, "timer");
  assert.ok(map.actions.some((a) => a.id === "notification.create.v1" && a.description));
});

test("every bundled scope is inspectable and configured custom events stay visible", () => {
  for (const definition of DEFAULT_SCOPE_TEMPLATES) {
    const map = buildScopeEventMap(definition);
    assert.ok(map.events.length > 80);
    assert.ok(map.actions.length > 10);
  }
  const map = buildScopeEventMap({ work_plan:{ automation_bindings:{ "custom.arrived":[{ automation:"custom.v1" }] } } });
  assert.equal(map.events.find((e) => e.name === "custom.arrived")!.connections.length, 1);
});

test("a raw lifecycle event key and its hook are the same event and both run", () => {
  const map = buildScopeEventMap({ work_plan:{ automation_bindings:{ onStarted:[], "work.plan.started":[{ automation:"notification.create.v1" }] } } });
  const entry = map.events.find((e) => e.name === "work.plan.started")!.connections[0]!;
  assert.equal(entry.enabled, true);
});

test("a lifecycle hook is not listed on another domain's event that shares its suffix", () => {
  const map = buildScopeEventMap({ work_plan:{ root_nodes:[{ id:"followup", title:"Follow up", automation_bindings:{ onCompleted:[{ automation:"notification.create.v1" }] } }] } });
  assert.equal(map.events.find((e) => e.name === "call.completed")!.connections.length, 0);
  assert.equal(map.events.find((e) => e.name === "work.node.completed")!.connections.length, 1);
});

test("a sequence appears as its compiled timers and read-only actions", () => {
  const map = buildScopeEventMap({ work_plan:{ root_nodes:[{ id:"cadence", title:"Cadence", sequence:{ steps:[
    { id:"now", actions:[{ automation:"communications.sendSms.v1", input:{ text:"hi" } }] },
    { id:"later", wait:{ days:1 }, actions:[{ automation:"communications.sendEmail.v1", input:{ subject:"s" } }] }
  ] } }] } });
  const timerEvent = map.events.find((e) => e.name === "work.node.timer")!;
  assert.ok(timerEvent.connections.some((c) => c.kind === "timer"));
  const action = timerEvent.connections.find((c) => c.kind === "action")!;
  assert.equal(action.source_path, null);
  assert.match(String(action.note), /sequence/);
  assert.equal(map.events.find((e) => e.name === "work.node.ready")!.connections.length, 1);
});
