const test=require('node:test'),assert=require('node:assert/strict'),B=require('../public/measure/internal/editor_scripts/base_geometry'),M=require('../public/measure/internal/editor_scripts/exterior_model'),G=require('../public/measure/internal/editor_scripts/wall_geometry'),K=require('../public/measure/internal/editor_scripts/exterior_geometry'),fixture=require('./fixtures/saved-wall-contact-drafts.json');
test('saved generated drafts repair on their actual visible plane without regeneration or lost edits',()=>{
 const s=structuredClone(fixture),before=structuredClone(s),roof=s.roof.faces.find(f=>f.id===21),a=roof.points[3],b=roof.points[2];
 assert.equal(B.repairStoredRoofContacts(s),true);
 const faces=M.collect(s,s.alignedWalls).filter(f=>f.draftKey?.includes('upper-contact')&&f.points.every(p=>p.z>40));assert.ok(faces.length>=2);
 for(const f of faces){K.validateFace(f);for(const p of f.points)assert.ok(G.onEdge(p,a,b,.00001));}
 for(const key of ['roof','sources','base','ground'])assert.deepEqual(s[key],before[key]);
 for(const [key,d]of Object.entries(s.wallEdits.$drafts))if(!key.includes('upper-contact-2')&&!key.includes('upper-contact-3'))assert.deepEqual(d,before.wallEdits.$drafts[key]);
 assert.deepEqual(s.wallEdits.$surfaces,before.wallEdits.$surfaces);assert.deepEqual(s.wallEdits.$walllessRoofIds,before.wallEdits.$walllessRoofIds);
 for(const k of ['deduplicated','gapRepaired','mergedWalls','cleanedWalls','alignedWalls'])assert.deepEqual(s[k].map(w=>w.id),before[k].map(w=>w.id));
 const once=JSON.stringify(s);assert.equal(B.repairStoredRoofContacts(s),false);assert.equal(JSON.stringify(s),once);
 const reloaded=JSON.parse(once);assert.equal(B.repairStoredRoofContacts(reloaded),false);assert.deepEqual(M.collect(reloaded,reloaded.alignedWalls),M.collect(s,s.alignedWalls));
});
for(const kind of ['moved','sketch','deleted','replacement'])test(`stored contact repair preserves ${kind} user geometry`,()=>{
 const s=structuredClone(fixture),key=Object.keys(s.wallEdits.$drafts).find(k=>k.includes('upper-contact-2')),d=s.wallEdits.$drafts[key];
 if(kind==='moved')d.origin.x+=.1;if(kind==='sketch')d.sketch.nodes[0].fixed=false;if(kind==='deleted')d.deletedFaces=['user'];if(kind==='replacement')s.wallEdits.$surfaces.push({id:'custom',draftKey:key,deleted:true});
 const before=structuredClone(d),walls=s.alignedWalls.filter(w=>d.members.includes(w.id)).map(w=>structuredClone(w));B.repairStoredRoofContacts(s);assert.deepEqual(s.wallEdits.$drafts[key],before);assert.deepEqual(s.alignedWalls.filter(w=>d.members.includes(w.id)),walls);
});
