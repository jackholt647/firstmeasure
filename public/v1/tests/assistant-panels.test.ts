import test from "node:test";
import assert from "node:assert/strict";
import { panelsFrom } from "../agents/panels.js";

test("saved chat presentations retain identity and content when read as panels", () => {
  const legacy = {type:"artifact",id:"artifact_saved",key:"daily-profit",kind:"table",title:"Materials",columns:["Material"],rows:[["Shingles"]]};
  const reference = {type:"platform_widget",title:"Lists",widget:{id:"scope.lists",version:"1",target:{scope:"project",organizationId:"org",projectId:"p"}}};
  const panels = panelsFrom([legacy,reference,{type:"appointment_booking"}]);
  assert.equal(panels.length,2);
  assert.equal(panels[0]!.type,"panel");assert.equal(panels[0]!.id,legacy.id);assert.equal(panels[0]!.key,legacy.key);
  assert.deepEqual((panels[0]!.widgets as any[])[0].rows,legacy.rows);
  assert.deepEqual((panels[1]!.widgets as any[])[0].widget,reference.widget);
  assert.equal(legacy.type,"artifact","Reading history must not rewrite stored records");
});
