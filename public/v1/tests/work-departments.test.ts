import assert from "node:assert/strict";
import test from "node:test";
import { inheritWorkDepartments } from "../work/department-inheritance.js";
import { createWorkPlanSchema, patchWorkNodeSchema } from "../work/schemas.js";
import { planFromRow, nodeFromRow } from "../work/storage.js";

test("scope responsibility inherits through stages without assigning departments to projects", () => {
  const nodes = [{ id:"phase", children:[{ id:"sales", department_ids:["inside_sales", "outside_sales"], children:[{id:"call"}] }, { id:"shared", department_ids:[], children:[{id:"handoff"}] }, {id:"production"}] }];
  const result: any = inheritWorkDepartments(nodes, ["production"]);
  assert.deepEqual(result[0].department_ids, ["production"]);
  assert.deepEqual(result[0].children[0].children[0].department_ids, ["inside_sales", "outside_sales"]);
  assert.deepEqual(result[0].children[1].children[0].department_ids, []);
  assert.deepEqual(result[0].children[2].department_ids, ["production"]);
  assert.equal("department_ids" in nodes[0]!, false, "template remains immutable");
});

test("department classifications survive plan/node storage projection and reject malformed inputs", () => {
  assert.deepEqual(planFromRow({metadata_json:JSON.stringify({department_ids:["sales"]})}).department_ids,["sales"]);
  assert.deepEqual(nodeFromRow({metadata_json:JSON.stringify({department_ids:["production"]})}).department_ids,["production"]);
  assert.deepEqual(nodeFromRow({}).department_ids,[]);
  assert.equal(patchWorkNodeSchema.safeParse({department_ids:[""]}).success,false);
  assert.equal(createWorkPlanSchema.safeParse({title:"Shared workflow",department_ids:[],root_nodes:[{id:"root",title:"Work",department_ids:["sales"]}]}).success,true);
});

import { matchesDepartmentNotificationTarget } from "../platform/notifications/department-targets.js";
test("department notification membership is live and additive with explicit recipients", () => {
  const note={target_department_ids:["production"]};
  assert.equal(matchesDepartmentNotificationTarget(note,"alex",[],["production"]),true);
  assert.equal(matchesDepartmentNotificationTarget(note,"alex",[],["sales"]),false);
  assert.equal(matchesDepartmentNotificationTarget({...note,target_user_ids:["alex"]},"alex",[],[]),true);
  assert.equal(matchesDepartmentNotificationTarget(note,"alex",[],[]),false);
});
