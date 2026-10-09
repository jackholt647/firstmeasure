const test=require('node:test'),assert=require('node:assert/strict'),P='../public/measure/internal/editor_scripts/',R=require(P+'wall_resoffit'),K=require(P+'exterior_geometry');
const p=(x,y,z=0)=>({x,y,z}),wall=(id,a,b,lo=0,hi=3)=>({id,points:[p(...a,lo),p(...b,lo),p(...b,hi),p(...a,hi)]}),roofFace=(id,z)=>({id,points:[p(-5,-5,z),p(10,-5,z),p(10,10,z),p(-5,10,z)]});
function setup(faces,selected,roof={faces:[roofFace('canopy',3)]}){const sources=selected.map(id=>{const f=faces.find(f=>f.id===id),[a,b]=f.points.slice(2).reverse();return {id:'source-'+id,parentId:'canopy',kind:'perimeter',type:'eave',originalA:a,originalB:b,a,b,setback:0,sourcePlane:{dx:0,dy:0,k:3}};});return {faces,roof,sources,pairs:selected.map(id=>faces.find(f=>f.id===id).points.slice(2))};}
const base={id:'base',baseId:'base',points:[p(-5,-5),p(10,-5),p(10,10),p(-5,10)]};
function run(f){const before=JSON.stringify(f),r=R.wallless(f.faces,f.pairs,f.roof,f.sources);assert.equal(JSON.stringify(f),before);for(const s of r.faces.filter(f=>!f.deleted))K.validateFace(s);return r;}
test('wallless layered canopy keeps the roof and extends the upper wall to the base',()=>{
 const f=setup([wall('canopy-wall',[0,0],[4,0]),wall('upper',[0,2],[4,2],3,6),base],['canopy-wall'],{faces:[roofFace('canopy',3),roofFace('upper-roof',6)]}),r=run(f);
 assert.equal(r.faces.find(f=>f.id==='canopy-wall').deleted,true);const upper=r.faces.find(f=>f.id==='upper');assert.equal(Math.min(...upper.points.map(p=>p.z)),0);assert.equal(Math.max(...upper.points.map(p=>p.z)),6);assert.equal(r.extended,1);assert.deepEqual(r.walllessRoofIds,['canopy']);assert.deepEqual(r.faces.find(f=>f.baseId),base);
});
test('wallless does not consume a coplanar wall above the selected canopy wall',()=>{
 const f=setup([wall('lower',[0,0],[4,0]),wall('upper',[0,0],[4,0],3,6),base],['lower'],{faces:[roofFace('canopy',3),roofFace('upper-roof',6)]}),r=run(f);assert.equal(r.faces.find(f=>f.id==='upper').deleted,undefined);assert.equal(Math.min(...r.faces.find(f=>f.id==='upper').points.map(p=>p.z)),0);
});
test('wallless continues to a real lower roof instead of cutting through it',()=>{
 const f=setup([wall('canopy-wall',[0,0],[4,0],1),wall('upper',[0,2],[4,2],3,6),base],['canopy-wall'],{faces:[roofFace('canopy',3),roofFace('lower-roof',1),roofFace('upper-roof',6)]}),r=run(f);assert.equal(Math.min(...r.faces.find(f=>f.id==='upper').points.map(p=>p.z)),1);
});
test('wallless connects surviving perpendicular walls beyond a removed bevel',()=>{
 const f=setup([wall('bevel',[0,2],[2,0]),wall('left',[0,4],[0,2]),wall('front',[2,0],[4,0]),base],['bevel']),r=run(f);assert.equal(r.reconnected,1);for(const id of ['left','front'])assert.ok(r.faces.find(f=>f.id===id).points.some(p=>Math.abs(p.x)<1e-6&&Math.abs(p.y)<1e-6));
});
test('wallless reconnects the house line across a removed canopy projection',()=>{
 const f=setup([wall('left',[0,0],[2,0]),wall('return-a',[2,0],[2,-2]),wall('front',[2,-2],[4,-2]),wall('return-b',[4,-2],[4,0]),wall('right',[4,0],[6,0]),base],['return-a','front','return-b']),r=run(f);assert.equal(r.reconnected,1);for(const id of ['return-a','front','return-b'])assert.equal(r.faces.find(f=>f.id===id).deleted,true);assert.ok(r.faces.find(f=>f.id==='left').points.some(p=>p.x===4&&p.y===0));assert.deepEqual(r.faces.find(f=>f.id==='right'),f.faces.find(f=>f.id==='right'));
});
test('wallless leaves an unsupported end open and preserves unrelated geometry',()=>{
 const unrelated=wall('unrelated',[8,0],[8,4],0,7),f=setup([wall('front',[0,0],[4,0]),wall('left',[0,0],[0,4]),unrelated,base],['front']),r=run(f);assert.equal(r.reconnected,0);assert.deepEqual(r.faces.find(f=>f.id==='left'),f.faces[1]);assert.deepEqual(r.faces.find(f=>f.id==='unrelated'),unrelated);
});
test('wallless extends only the portion of a longer wall supported by the canopy',()=>{
 const canopy={id:'canopy',points:[p(0,0,3),p(2,0,3),p(2,4,3),p(0,4,3)]},f=setup([wall('front',[0,0],[2,0]),wall('upper',[-2,2],[4,2],3,6),base],['front'],{faces:[canopy,roofFace('roof',6)]}),r=run(f),upper=r.faces.find(f=>f.id==='upper');
 assert.ok(upper.points.some(p=>p.z===0&&p.x===0));assert.ok(upper.points.some(p=>p.z===0&&p.x===2));assert.ok(upper.points.filter(p=>p.x<0||p.x>2).every(p=>p.z>=3));
});
test('wallless does not duplicate an existing coplanar wall or fill its opening',()=>{
 const lower=wall('existing',[0,2],[4,2],0,2);lower.holes=[[p(1,2,.5),p(2,2,.5),p(2,2,1.5),p(1,2,1.5)]];
 const f=setup([wall('front',[0,0],[4,0]),wall('upper',[0,2],[4,2],3,6),lower,base],['front'],{faces:[roofFace('canopy',3),roofFace('roof',6)]}),r=run(f),upper=r.faces.find(f=>f.id==='upper');assert.equal(Math.min(...upper.points.map(p=>p.z)),2);assert.deepEqual(r.faces.find(f=>f.id==='existing'),lower);
});
test('wallless continuation meets a pitched base without moving its XY footprint',()=>{
 const pitched={...base,points:base.points.map(p=>({...p,z:.1*p.x+.05*p.y+2}))},f=setup([wall('front',[0,0],[4,0],2),wall('upper',[0,2],[4,2],3,6),pitched],['front'],{faces:[roofFace('canopy',3),roofFace('roof',6)]}),r=run(f),upper=r.faces.find(f=>f.id==='upper');
 assert.ok(upper.points.every(p=>Math.abs(p.y-2)<1e-8));assert.ok(upper.points.filter(p=>p.z<3).every(p=>Math.abs(p.z-(.1*p.x+.05*p.y+2))<1e-6));assert.deepEqual(r.faces.find(f=>f.baseId),pitched);
});
test('wallless fails atomically when a required continuation has no base coverage',()=>{
 const small={...base,points:[p(0,-1),p(4,-1),p(4,1),p(0,1)]},f=setup([wall('front',[0,0],[4,0]),wall('upper',[0,2],[4,2],3,6),small],['front'],{faces:[roofFace('canopy',3),roofFace('roof',6)]}),before=JSON.stringify(f);assert.throws(()=>R.wallless(f.faces,f.pairs,f.roof,f.sources),/base must cover/);assert.equal(JSON.stringify(f),before);
});
