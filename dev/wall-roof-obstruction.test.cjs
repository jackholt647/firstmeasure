const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const ctx={WallGeometry:require('../public/measure/internal/editor_scripts/wall_geometry.js')};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
const p=(x,y,z)=>({x,y,z}),wall={bottom:[p(0,0,0),p(4,0,0)],top:[p(0,0,3),p(4,0,3)]};
const face=(z,x0=0,x1=4)=>({points:[p(x0,.5,z),p(x1,.5,z),p(x1,1.5,z),p(x0,1.5,z)]});
const roof=()=>({points:[p(0,1,6),p(4,1,6)],connections:[{startIdx:0,endIdx:1}],faces:[face(6),face(3)]});
test('roof snap rejects upper eave when an intermediate roof cuts the resulting wall',()=>{assert.equal(ctx.findWallRoofSnap(wall,.98,roof(),.1),null);});
test('roof snap checks narrow interior overlaps and respects actual roof holes',()=>{const r=roof();r.faces[1]=face(3,.7,.72);assert.equal(ctx.findWallRoofSnap(wall,1,r,.1),null);r.faces[1]=face(3);r.faces[1].holes=[[p(-1,.8,3),p(5,.8,3),p(5,1.2,3),p(-1,1.2,3)]];assert.ok(ctx.findWallRoofSnap(wall,1,r,.1));});
test('wall may start on lower roof and may snap to the lower eave instead',()=>{const r=roof();assert.ok(ctx.findWallRoofSnap({...wall,bottom:[p(0,0,3),p(4,0,3)]},1,r,.1));r.points.push(p(0,1,3),p(4,1,3));r.connections.push({startIdx:2,endIdx:3});assert.equal(ctx.findWallRoofSnap(wall,1,r,.1).edge[0].z,3);});
test('final adjusted endpoints are validated before the height preview mutates any wall',()=>{const r=roof(),w={id:'w',bottom:[p(0,1,0),p(4,1,0)],top:[p(0,1,2),p(4,1,2)]},before=JSON.stringify(w);assert.equal(ctx.fitWallTopToRoof([w],['w'],{edge:r.points},r),false);assert.equal(JSON.stringify(w),before);});
