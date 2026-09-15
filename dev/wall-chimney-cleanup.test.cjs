const test=require('node:test'),assert=require('node:assert/strict');
const path='../public/measure/internal/editor_scripts/';
const A=require(path+'wall_chimney_cleanup.js'),R=require(path+'wall_rake_cleanup.js'),G=require(path+'wall_geometry.js');
const C=require(path+'wall_chimneys.js'),D=require(path+'wall_gaps.js'),B=require(path+'base_geometry.js');
const p=(x,y,z=0)=>({x,y,z}),copy=v=>structuredClone(v),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function example(offset=.1){
 const ring=[p(0,0),p(8,0),p(8,5),p(0,5)];
 const walls=ring.map((a,i)=>({id:'w'+i,sourceId:'s'+i,kind:'perimeter',bottom:[a,ring[(i+1)%4]],top:[a,ring[(i+1)%4]].map(p=>({...p,z:4}))}));
 const sources=walls.map(w=>{const [a,b]=w.bottom,len=Math.hypot(b.x-a.x,b.y-a.y),n={x:-(b.y-a.y)/len,y:(b.x-a.x)/len};return {id:w.sourceId,a,b,setback:.4572,originalA:{...a,x:a.x-n.x*.4572,y:a.y-n.y*.4572},originalB:{...b,x:b.x-n.x*.4572,y:b.y-n.y*.4572},sourcePlane:{dx:0,dy:0,k:4}};});
 const chimneys=[{id:'c',points:[p(2,offset,4),p(3,offset,4),p(3,1,4),p(2,1,4)]}];
 return {walls,sources,chimneys,ground:0,base:{faces:[{id:'base',points:ring}]}};
}
test('six-inch cleanup moves the complete wall, keeps connected corners and foundation, and is stable',()=>{
 const s=example(6*.0254),before=copy(s),r=A.cleanup(s.walls,s.sources,s.chimneys,0);
 assert.equal(r.report.alignments.length,1);assert.deepEqual(s,before);
 r.walls.find(w=>w.id==='w0').bottom.forEach(p=>near(p.y,6*.0254));
 assert.equal(D.detect(r.walls,0).length,0);assert.deepEqual(A.cleanup(r.walls,s.sources,s.chimneys,0).walls,r.walls);
 const base=A.foundation(s.base,r.report);near(Math.min(...base.faces[0].points.map(p=>p.y)),6*.0254);
});
test('large offsets, projecting chimneys, opposite sides, separate runs, conflicts and edits are preserved',()=>{
 for(const scenario of ['large','outward','opposite','separate','conflicting','wall edit','neighbor edit']){
  const s=example(scenario==='large'?.153:scenario==='outward'?-.1:.1);let excluded=[];
  if(scenario==='opposite')s.chimneys[0].points=[p(2,.1,4),p(2,-1,4),p(3,-1,4),p(3,.1,4)];
  if(scenario==='separate')s.chimneys[0].points.forEach(p=>p.x+=20);
  if(scenario==='conflicting'){const c=copy(s.chimneys[0]);c.id='other';c.points.forEach(p=>p.y+=.02);s.chimneys.push(c);}
  if(scenario==='wall edit')excluded=['w0'];if(scenario==='neighbor edit')excluded=['w3'];
  const r=A.cleanup(s.walls,s.sources,s.chimneys,0,excluded);assert.deepEqual(r.walls,s.walls,scenario);assert.equal(r.report.alignments.length,0,scenario);
 }
});
test('slightly angled chimney planes align geometrically, but drift over six inches is rejected',()=>{
 const s=example();s.chimneys[0].points[1].y+=.002;s.chimneys[0].points[2].y+=.002;
 const r=A.cleanup(s.walls,s.sources,s.chimneys,0);assert.equal(r.report.alignments.length,1);
 r.walls.find(w=>w.id==='w0').bottom.forEach(p=>near(p.y,.1+(p.x-2)*.002));assert.equal(D.detect(r.walls,0).length,0);
 s.chimneys[0].points[1].y+=.02;s.chimneys[0].points[2].y+=.02;
 assert.equal(A.cleanup(s.walls,s.sources,s.chimneys,0).report.alignments.length,0);
});
test('oblique walls retain sloped ground and roof heights',()=>{
 const s=example(),rotate=p=>({x:p.x*.8-p.y*.6,y:p.x*.6+p.y*.8,z:p.z});
 for(const w of s.walls){w.bottom=w.bottom.map(rotate);w.top=w.top.map(rotate);}
 for(const s0 of s.sources)for(const key of ['a','b','originalA','originalB'])s0[key]=rotate(s0[key]);
 for(const c of s.chimneys)c.points=c.points.map(rotate);
 const ground={points:[p(-20,-20,-2),p(20,-20,2),p(20,20,2),p(-20,20,-2)],faces:[[0,1,2,3]]};
 for(const w of s.walls)w.bottom.forEach(p=>p.z=p.x*.1);
 const r=A.cleanup(s.walls,s.sources,s.chimneys,ground);assert.equal(r.report.alignments.length,1);for(const w of r.walls)w.bottom.forEach(p=>near(p.z,p.x*.1));
 assert.equal(D.detect(r.walls,ground).length,0);
});
test('captured gable aligns to chimney without changing roof or deliberate chimney projection',()=>{
 const s=copy(require('./fixtures/complex-roof-corner.json')),roof=copy(s.roof),sources=G.buildSources(s.roof,s.options).sources;
 const run=ground=>G.mergeCoplanar(D.repair(G.deduplicate(G.extrude(s.roof,sources,ground).walls,s.options.tolerance).walls,ground).walls).walls;
 s.base=B.fromRoof(s.roof,s.ground,run(s.ground));s.wallEdits={};s.chimneys=C.detect(s.roof);C.syncFoundation(s);C.syncVolumes(s);
 const six=R.cleanup(run(B.terrain(s.base)),sources,B.terrain(s.base));s.base=R.foundation(s.base,six.report);
 const chimney=copy(C.definitions(s)),r=A.cleanup(six.walls,sources,chimney,B.terrain(s.base));s.base=A.foundation(s.base,r.report);
 assert.equal(r.report.alignments.length,1);const a=r.report.alignments[0];assert.equal(a.side,3);near(a.maxShift,.00818013257017);
 const [c,d]=[chimney[0].points[3],chimney[0].points[0]],len=Math.hypot(d.x-c.x,d.y-c.y);
 for(const w of r.walls.filter(w=>a.wallIds.includes(w.id)))for(const p of w.bottom)near(((p.x-c.x)*(d.y-c.y)-(p.y-c.y)*(d.x-c.x))/len,0);
 const composed=C.compose(r.walls,s),merged=A.compose(composed,r.report);
 // Previously retained wall strips ran diagonally through the upper shaft,
 // because clipping stopped at roof contact instead of the chimney cap.
 for(const w of composed.filter(w=>!w.chimney))assert.equal(C.intervals(...w.top,[{points:chimney[0].points}],true).length,0,'ordinary wall top ends at the chimney boundary');
 assert.equal(G.topology(merged).faces.length,9);assert.equal(D.detect(merged,s.ground).length,0);
 assert.deepEqual(s.roof,roof);assert.deepEqual(C.definitions(s),chimney);
 const side=composed.find(w=>w.chimney?.side===3);side.material='brick';
 const materialSplit=A.compose(composed,r.report);assert.notEqual(materialSplit.find(w=>w.id===side.id).mergeGroup,materialSplit.find(w=>w.sourceId==='R17.1').mergeGroup);
 assert.deepEqual(A.compose(composed,r.report,composed.map(w=>w.id)),composed);
});
