const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const H=require('../public/measure/internal/editor_scripts/editor_history.js');
test('immutable snapshots share unchanged branches without mutating earlier edits',()=>{
 const previous={points:[{x:1,y:2},{x:3,y:4}],selection:['a']};
 const next=H.share(previous,{points:[{x:1,y:2},{x:9,y:4}],selection:['a']});
 assert.equal(next.points[0],previous.points[0]);assert.equal(next.selection,previous.selection);
 assert.notEqual(next.points,previous.points);assert.equal(previous.points[1].x,3);
 assert.equal(H.share(next,structuredClone(next)),next);
});
test('large history uses multiple complete chunks and retains the previous save on upload failure',async()=>{
 const input={undo:[require('node:crypto').randomBytes(2200000).toString('base64')]},files=new Map();
 const manifest=await H.save('large-history',input,async(project,blob,name)=>files.set(name,await blob.arrayBuffer()));
 assert.ok(manifest.parts.length>=3);
 assert.deepEqual(await H.load('large-history',manifest,async(project,name)=>files.get(name)),input);
 let uploads=0;
 await assert.rejects(H.save('failed-large-history',input,async()=>{if(++uploads===2)throw Error('interrupted');}),/interrupted/);
 assert.equal(uploads,2);
 assert.deepEqual(await H.load('large-history',manifest,async(project,name)=>files.get(name)),input);
});
test('saved history deduplicates unchanged geometry without limiting the number of steps',()=>{
 const points=Array.from({length:100},(_,i)=>({x:i,y:i*2,z:3}));
 const input={version:1,roof:{undo:Array.from({length:1500},(_,i)=>({points:structuredClone(points),selected:i})),redo:[]}};
 const packed=H.pack(input),raw=JSON.stringify(input),encoded=JSON.stringify(packed);
 assert.ok(encoded.length<raw.length/10);assert.deepEqual(H.unpack(JSON.parse(encoded)),input);
 assert.throws(()=>H.unpack({version:1,nodes:[['a',[[0]]]],root:[0]}),/reference/);
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>H.pack(cyclic),/circular/);
});
test('history artifacts roundtrip, reuse identical uploads, and reject corrupted downloads',async()=>{
 const files=new Map(),upload=async(project,blob,name)=>files.set(project+':'+name,await blob.arrayBuffer());
 const input={version:1,roof:{undo:[{p:[{x:1,y:2,z:3}]}],redo:[]},walls:{version:1,undo:[],redo:[]}};
 const manifest=await H.save('history-roundtrip',input,upload);assert.ok(manifest.parts.every(p=>p.size<=1024*1024));
 assert.deepEqual(await H.load('history-roundtrip',manifest,async(project,name)=>files.get(project+':'+name)),input);
 await H.save('history-roundtrip',input,()=>{throw Error('unchanged history must reuse uploaded chunks');});
 await assert.rejects(H.load('history-roundtrip',manifest,async(project,name)=>{const bytes=files.get(project+':'+name).slice(0);new Uint8Array(bytes)[0]^=1;return bytes;}),/integrity/);
 await assert.rejects(H.save('history-failed-upload',input,async()=>{throw Error('upload failed');}),/upload failed/);
});
test('roof history preserves calibrated positions and locked planes across image contexts',()=>{
 const a={width:100,height:80,lat:47,lng:-122,mpp:.2},b={...a,width:500,height:300,mpp:.1};
 const p={x:20,y:30,z:9,_lockedPlanes:[{a:.1,b:.2,c:1}]},q=H.projectPoint(p,a,b),back=H.projectPoint(q,b,a);
 for(const k of ['x','y','z'])assert.ok(Math.abs(back[k]-p[k])<1e-9);
 assert.ok(Math.abs(q._lockedPlanes[0].a*q.x+q._lockedPlanes[0].b*q.y+q._lockedPlanes[0].c-(p._lockedPlanes[0].a*p.x+p._lockedPlanes[0].b*p.y+1))<1e-9);
 assert.deepEqual(H.projectPoint(p,null,b),p);
});
const source=fs.readFileSync('public/measure/internal/editor_scripts/interaction_2d.js','utf8');
function fn(name){const start=source.indexOf('function '+name+'(');assert.ok(start>=0);let i=source.indexOf('{',start),depth=1;for(i++;depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}return source.slice(start,i);}
function roof(){
 const ctx={EditorHistory:H,imageWidth:100,imageHeight:100,mapCenterLat:0,mapCenterLng:0,getMetersPerPx:()=>1,history2D:[],redo2D:[],activeGeometry:{points:[{x:0,y:0,z:0}],connections:[],vents:[],manualFaces:[]},selectedPoints:new Set(),selectedLines:new Set(),selectedVents:new Set(),deletedFaceSignatures:new Set(),selectedFaceSignatures:new Set(),selectionMode:'POINT',document:{getElementById:()=>null},renderGeometry2D(){},renderGeometry3D(){}};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(['roofHistoryContext','capture2DState','save2DState','restore2DState','undo2D','redo2DAction'].map(fn).join('\n')+'\n'+source.split('\n').find(line=>line.startsWith('window.restoreRoofHistory=')),ctx);return ctx;
}
test('loaded empty queues cannot mutate deduplicated empty geometry snapshots',()=>{
 const ctx=roof();ctx.activeGeometry.points=[];ctx.save2DState();ctx.activeGeometry.points.push({x:1,y:2,z:3});
 const decoded=H.unpack(H.pack({undo:ctx.history2D,redo:[]})),original=JSON.stringify(decoded);
 const fresh=roof();fresh.activeGeometry=structuredClone(ctx.activeGeometry);fresh.restoreRoofHistory(decoded);
 fresh.undo2D();assert.equal(fresh.activeGeometry.points.length,0);
 fresh.redo2DAction();assert.equal(fresh.activeGeometry.points.length,1);
 assert.equal(fresh.activeGeometry.points[0].x,1);
 assert.equal(JSON.stringify(decoded),original,'queue operations never mutate the saved graph');
});
test('roof undo exceeds the old limit and restores its saved undo/redo cursor',()=>{
 const ctx=roof();for(let i=0;i<700;i++){ctx.save2DState();ctx.activeGeometry.points[0].x++;}
 for(let i=0;i<100;i++)ctx.undo2D();assert.equal(ctx.activeGeometry.points[0].x,600);
 const history=H.unpack(H.pack({undo:ctx.history2D,redo:ctx.redo2D})),fresh=roof();fresh.activeGeometry=structuredClone(ctx.activeGeometry);fresh.restoreRoofHistory(history);
 fresh.redo2DAction();assert.equal(fresh.activeGeometry.points[0].x,601);
 for(let i=0;i<601;i++)fresh.undo2D();assert.equal(fresh.activeGeometry.points[0].x,0);
 fresh.save2DState();fresh.activeGeometry.points[0].x=8;assert.equal(fresh.redo2D.length,0);
});
test('roof undo and redo preserve manual faces, holes, vents, locks and selection',()=>{
 const ctx=roof(),points=Array.from({length:7},(_,i)=>({x:i,y:i%3,z:2,_lockedPlanes:[{a:0,b:0,c:2}]}));ctx.activeGeometry.points=points;ctx.activeGeometry.manualFaces=[{points:points.slice(0,4),holes:[points.slice(4)],layer:1}];ctx.activeGeometry.vents=[{x:2,y:1,z:2,extra:{label:'vent'}}];ctx.selectedPoints.add(points[2]);ctx.selectedVents.add(ctx.activeGeometry.vents[0]);
 const before=JSON.stringify(ctx.capture2DState());ctx.save2DState();points[2].x=20;const after=JSON.stringify(ctx.capture2DState());ctx.undo2D();assert.equal(JSON.stringify(ctx.capture2DState()),before);ctx.redo2DAction();assert.equal(JSON.stringify(ctx.capture2DState()),after);
});
test('project save commits matching immutable geometry/history and never commits a partial history upload',async()=>{
 const main=fs.readFileSync('public/measure/internal/editor_scripts/main.js','utf8');
 const start=main.indexOf('        // Freeze geometry and both history cursors together before uploading.');
 const end=main.indexOf('        // --- STEP 2: ATTACH IMAGES ---',start);
 const script='(async()=>{'+main.slice(start,end)+'return savedMetadata;})()';
 const metadata={geometry:{vents:[{x:1}]}},history={undo:[{p:[{x:1}]}],redo:[]},files=new Map();let posted;
 const window={currentProjectId:'fixture',EditorHistory:H,serializeRoofHistory:()=>history,
  firstMeasureUploadArtifact:async(project,blob,name)=>{metadata.geometry.vents[0].x=2;history.undo[0].p[0].x=2;files.set(name,await blob.arrayBuffer());},
  firstMeasureFetchJson:async(url,options)=>{posted=JSON.parse(options.body);return {success:true};}};
 const ctx=vm.createContext({window,metadata,historyProjectId:'fixture'});
 await vm.runInContext(script,ctx);
 assert.equal(posted.metadata.geometry.vents[0].x,1);
 const restored=await H.load('fixture',posted.metadata.editorHistory,async(project,name)=>files.get(name));
 assert.equal(restored.roof.undo[0].p[0].x,1);
 posted=null;window.firstMeasureUploadArtifact=async()=>{throw Error('network failure');};
 await assert.rejects(vm.runInContext(script,ctx),/network failure/);assert.equal(posted,null);
 window.firstMeasureUploadArtifact=async()=>{window.currentProjectId='other';};
 await assert.rejects(vm.runInContext(script,ctx),/project changed/);assert.equal(posted,null);
});
