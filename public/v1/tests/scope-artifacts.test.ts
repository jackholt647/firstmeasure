import assert from "node:assert/strict";
import test from "node:test";
import { buildScopeArtifactMap, patchScopeArtifact, createScopeArtifact } from "../scopes/artifacts.js";
import { DEFAULT_SCOPE_TEMPLATES } from "../scopes/presets/index.js";
import { registerBuiltinWorkAutomations } from "../work/automations/builtins.js";
import { registerPayrollAutomations } from "../payroll/automations.js";
registerBuiltinWorkAutomations(); registerPayrollAutomations();
const roof = DEFAULT_SCOPE_TEMPLATES.find(t=>t.id === "roof_replacement")!;

test("customer portal includes access settings and only inbound pages targeting this scope", () => {
  const definition={id:"roof",name:"Roof",work_plan:{root_nodes:[]},customer_scheduling:{enabled:true,min_notice_minutes:120},checklists:[{id:"hidden",title:"Crew checks",items:[]},{id:"customer",title:"Customer checks",customer_access:{visible:true,can_complete:true},items:[]}]};
  const pages=[
    {id:"target",website_id:"site",title:"Roof care",enabled:true,published_version:2,audience:{scope_template_ids:["roof"],match:"all",tag_ids:["warranty"]}},
    {id:"draft",website_id:"site",enabled:true,published_version:0,audience:{scope_template_ids:["roof"]}},
    {id:"other",website_id:"site",enabled:true,published_version:1,audience:{scope_template_ids:["kitchen"]}},
    {id:"global",website_id:"site",enabled:true,published_version:1}
  ];
  const map=buildScopeArtifactMap(definition,[],pages);
  const portal=map.artifacts.filter(a=>a.type==="portal");
  assert.equal(portal.length,5);
  assert.equal(portal.find(a=>a.title==="Crew checks")?.enabled,false);
  assert.equal(portal.find(a=>a.title==="Customer checks")?.enabled,true);
  assert.equal(portal.find(a=>a.id==="portal:page:draft")?.enabled,false);
  assert.match(portal.find(a=>a.id==="portal:page:target")!.timing,/every other/);
  assert.ok(portal.find(a=>a.title==="Customer checks")!.related_ids.some(id=>id.startsWith("checklists:")));
  assert.ok(portal.every(a=>a.editable_fields.length===0));
});

test("roofing sales exposes its explicit customer portal handoff and document sources", () => {
  const sales=DEFAULT_SCOPE_TEMPLATES.find(t=>t.id==="roofing_sales_appointment")!;
  const portal=buildScopeArtifactMap(sales).artifacts.filter(a=>a.type==="portal");
  assert.ok(portal.some(a=>a.config.portal_kind==="handoff" && a.title==="Send to customer portal"));
  assert.ok(portal.some(a=>a.config.portal_kind==="document" && a.related_ids.some(id=>id.startsWith("documents:"))));
});

test("roofing artifacts include effective materials, labor, equipment, calendars and generated to-dos without alias duplicates", () => {
  const catalog = buildScopeArtifactMap(roof);
  assert.equal(catalog.artifacts.filter(a=>a.type==="materials").length, 2);
  assert.ok(catalog.artifacts.some(a=>a.type==="resources" && a.config.resource_type==="labor"));
  assert.ok(catalog.artifacts.some(a=>a.type==="resources" && a.config.resource_type==="equipment"));
  assert.ok(catalog.artifacts.some(a=>a.type==="events" && a.config.event_type_default_id==="material_delivery_dry_in"));
  assert.ok(catalog.artifacts.some(a=>a.type==="events" && a.config.event_type_default_id==="material_delivery_shingles"));
  const todos=catalog.artifacts.filter(a=>a.type==="todos" && a.origin==="Created by automation");
  assert.equal(todos.filter(a=>a.title==="Complete the safety checklist").length, 1);
  assert.ok(todos.every(a=>a.rule_ids.length && a.source_path));
  const dryIn=catalog.artifacts.find(a=>a.type==="events" && a.config.event_type_default_id==="material_delivery_dry_in")!;
  assert.ok(!dryIn.triggers.some(t=>(t.conditions as any)?.["payload.event_type_default_id"]==="material_delivery_shingles"));
  const safety=todos.find(a=>a.title==="Complete the safety checklist")!;
  assert.ok(safety.triggers.some(t=>t.event==="material.delivery.completed"));
  for(const artifact of catalog.artifacts) for(const related of artifact.related_ids) assert.ok(catalog.artifacts.some(a=>a.id===related));
});

test("artifact edits update exactly the original automation input while preserving hooks, conditions, IDs and nested parameters", () => {
  const original=JSON.stringify(roof);
  const todo=buildScopeArtifactMap(roof).artifacts.find(a=>a.type==="todos" && a.origin==="Created by automation")!;
  const edited=patchScopeArtifact(roof,todo.id,{title:"Confirm delivery with the foreman"});
  assert.equal(JSON.stringify(roof),original);
  const after=buildScopeArtifactMap(edited);
  const changed=after.artifacts.find(a=>a.id===todo.id)!;
  assert.equal(changed.title,"Confirm delivery with the foreman");
  assert.deepEqual(changed.rule_ids,todo.rule_ids);
  const reset=patchScopeArtifact(edited,todo.id,{title:todo.config.title});
  assert.deepEqual(reset,roof);
  assert.ok(after.events.some(e=>e.connections.some(c=>(c.input as any)?.title===changed.title)));
});

test("document catalog groups issuance and signatures without pulling in unrelated global policy documents", () => {
  const definition={name:"Contract",work_plan:{root_nodes:[{id:"approval",title:"Approve",actionable:true,
    automation_bindings:{onReady:[{id:"issue",automation:"documents.issue.v1",input:{template_id:"tpl_contract",title:"Roof contract",params:{deposit:100}}}]},
    external_triggers:[{event:"document.signed",conditions:{"payload.template_id":"tpl_contract"},transition:"completed"}]
  }]}};
  const map=buildScopeArtifactMap(definition,[{id:"global",event:"project.created",automation:"documents.issue.v1",input:{template_id:"tpl_unrelated"}}]);
  const documents=map.artifacts.filter(a=>a.type==="documents");
  assert.equal(documents.length,1);
  assert.equal(documents[0]!.rule_ids.length,2);
  assert.ok(documents[0]!.related_ids.some(id=>id.startsWith("todos:")));
  assert.ok(map.events.find(e=>e.name==="document.signed")!.connections.some(c=>(c.artifacts as any[]).some(a=>a.type==="documents")));
});

test("new to-dos become executable bindings and checklist edits preserve existing item properties", () => {
  const definition={id:"test",name:"Test",work_plan:{root_nodes:[{id:"work",title:"Work",actionable:true}]},checklists:[{id:"safety",title:"Safety",items:[{id:"a",title:"Harness",required:true}]}]};
  const created=createScopeArtifact(definition,"todos",{title:"Sign the contract",message:"Review first"},{node_id:"work",hook:"onCompleted",conditions:{"project.ready":true}});
  const item=buildScopeArtifactMap(created).artifacts.find(a=>a.title==="Sign the contract")!;
  assert.equal(item.origin,"Created by automation");
  assert.ok(item.triggers.some(t=>(t.conditions as any)["project.ready"]===true));
  const checklist=buildScopeArtifactMap(created).artifacts.find(a=>a.type==="checklists")!;
  const changed=patchScopeArtifact(created,checklist.id,{title:"Site safety"});
  assert.deepEqual((changed.checklists as any[])[0].items,definition.checklists[0]!.items);
  assert.throws(()=>patchScopeArtifact(created,item.id,{automation:"other.v1"}),/editable fields/);
  assert.throws(()=>createScopeArtifact(definition,"todos",{title:"Task"},{node_id:"missing",hook:"onReady"}),/no longer exists/);
  assert.throws(()=>createScopeArtifact(definition,"todos",{title:"Task"},{hook:"onReady"}),/scope start or completion/);
});

test("multiple uses of one document retain their own parameters and editable sources",()=>{
  const definition={name:"Repeated contract",work_plan:{root_nodes:[{id:"start",title:"Start",automation_bindings:{onReady:[{id:"first",automation:"documents.issue.v1",input:{template_id:"tpl_contract",params:{amount:10}}}]}},{id:"finish",title:"Finish",automation_bindings:{onReady:[{id:"second",automation:"documents.issue.v1",input:{template_id:"tpl_contract",params:{amount:20}}}]}}]}};
  const doc=buildScopeArtifactMap(definition).artifacts.find(a=>a.type==="documents")!;
  assert.equal(doc.edit_targets?.length,2);
  const second=doc.edit_targets!.find(t=>t.location.includes("Finish"))!;
  const changed=patchScopeArtifact(definition,doc.id,{params:{amount:30}},second.id);
  const targets=buildScopeArtifactMap(changed).artifacts.find(a=>a.type==="documents")!.edit_targets!;
  assert.equal((targets.find(t=>t.location.includes("Start"))!.config.params as any).amount,10);
  assert.equal((targets.find(t=>t.location.includes("Finish"))!.config.params as any).amount,30);
});

test("disabled setup remains visible, arbitrary functions are disclosed, and field-visit messages are included", () => {
  const definition={checklists:[{title:"Test"}],work_plan:{automation_bindings:{onStarted:[{id:"default_initialize_scope_checklists",automation:"checklists.initializeFromScope.v1",enabled:false},{id:"unknown",automation:"custom.script.v1",input:{code:"return unknownOutput()"}}]}}};
  const catalog=buildScopeArtifactMap(definition);
  assert.equal(catalog.artifacts.find(a=>a.type==="checklists")!.enabled,false);
  assert.ok(catalog.artifacts.some(a=>a.type==="other" && a.config.code));
  const sales=DEFAULT_SCOPE_TEMPLATES.find(t=>t.id==="roofing_sales_appointment")!;
  const visit=buildScopeArtifactMap(sales);
  assert.ok(visit.artifacts.some(a=>a.type==="workflows"));
  assert.ok(visit.artifacts.some(a=>a.type==="communications" && a.origin==="Visit step"));
});

test("every preset projects without mutating its definition",()=>{
  for(const definition of DEFAULT_SCOPE_TEMPLATES){
    const before=JSON.stringify(definition);const map=buildScopeArtifactMap(definition);
    assert.equal(JSON.stringify(definition),before);assert.equal(new Set(map.artifacts.map(a=>a.id)).size,map.artifacts.length);
  }
});
