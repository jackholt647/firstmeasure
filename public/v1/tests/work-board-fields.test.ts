import assert from "node:assert/strict";
import test from "node:test";
import { boardFieldCatalog } from "../work/board-fields.js";

test("board choices come from configuration, including nested fields and assignments", () => {
  const catalog = boardFieldCatalog({ custom_fields:{fields:[
    {path:"assignments.salesperson",label:"Salesperson",type:"organization_user"},
    {path:"inventory",label:"Inventory",type:"object",schema:{properties:{weight:{type:"number",title:"Weight"}}}},
    {path:"secret",private:true}, {path:"disabled",enabled:false}, {path:"restricted",read_permission:"manage_company_settings"}
  ]}, fields:[{id:"section_name",label:"Section name"}] });
  assert.deepEqual(catalog.map(f => f.key),["custom:assignments.salesperson","custom:inventory","custom:inventory.weight","scope:section_name"]);
  assert.equal(catalog.find(f => f.key === "custom:inventory.weight")?.type,"number");
  assert.equal(catalog.some(f => f.source === "measurement"),false);
});

test("measurement report fields require an explicit workflow integration", () => {
  assert.equal(boardFieldCatalog({name:"Roof replacement", rule:{ref:"project.measurements.roofSquares"}}).length,0);
  assert.equal(boardFieldCatalog({work_plan:{automation_bindings:{"measurement.report.ordered":[{automation:"notifications.send.v1"}]}}}).length,2);
  assert.deepEqual(boardFieldCatalog({integration:{app:"firstmeasure"}}).map(f => f.label),["Measurement report status","Measurement report submitted date"]);
  assert.equal(boardFieldCatalog({integration:{app:"firstmeasure",enabled:false}}).length,0);
});
