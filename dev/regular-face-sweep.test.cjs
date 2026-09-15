const test=require('node:test'),assert=require('node:assert/strict');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),M=require('../public/measure/internal/editor_scripts/exterior_model.js');
// Saved wall face: the third point is a legitimate shared anchor on the bottom
// edge. Survey-coordinate rounding places it a few trillionths off that edge.
const source={id:'saved-wall',points:[
 {x:-0.9242430146643916,y:8.649229523296379,z:159.8236},
 {x:-0.924243014664393,y:8.64922952329638,z:157.69},
 {x:3.8963000199867315,y:3.4462561862244643,z:157.68999999999997},
 {x:4.207028465174783,y:3.1108765819429616,z:157.69},
 {x:4.2070284651747825,y:3.1108765819429633,z:159.8236}
],holes:[]};
const roof=z=>({faces:[{points:[{x:-20,y:-20,z},{x:20,y:-20,z},{x:20,y:20,z},{x:-20,y:20,z}]}]});
test('saved regular wall with a near-collinear bottom anchor has usable sweep triangles',()=>{
 const before=JSON.stringify(source),frame=K.frame(source),mesh=K.triangles(source.points.map(p=>K.local(frame,p)));
 assert.equal(mesh.points.length,5,'triangulation retains the intentional anchor');
 assert.ok(mesh.triangles.every(t=>K.normal(t.map(i=>K.world(frame,mesh.points[i])))),'no degenerate triangle may enter a sweep');
 const area=mesh.triangles.reduce((sum,t)=>sum+K.area({points:t.map(i=>mesh.points[i])}),0);assert.ok(Math.abs(area-16.1087930808)<1e-9);assert.equal(JSON.stringify(source),before);
});
test('the saved regular wall extrudes both ways with roof bounds and keeps its anchors',()=>{
 const before=JSON.stringify(source),engine=M.createExtrusion({face:source,scene:[],roof:roof(170)});
 for(const amount of [-1,-.1,.1,1]){const r=engine.preview(amount);assert.equal(r.cap.points.length,5);assert.ok(r.cap.retainedPoints.length>=5);K.validateFace(r.cap);}
 assert.equal(JSON.stringify(source),before);
});
test('discarding a numerical triangle still clips regular wall extrusions to the roof',()=>{
 const engine=M.createExtrusion({face:source,scene:[],roof:roof(159.5)});
 for(const amount of [-.3,.3]){const r=engine.preview(amount);assert.ok(!r.cap.deleted);assert.ok(r.cap.points.every(p=>p.z<=159.5+K.CONTACT));K.validateFace(r.cap);}
});
