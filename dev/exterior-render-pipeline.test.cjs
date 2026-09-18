const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const THREE=require('../public/v1/node_modules/three');globalThis.THREE=THREE;
const Cache=require('../public/measure/internal/editor_scripts/exterior_scene_cache.js');
test('persistent parts preserve identities, rebuild changed parts, and return stolen parts on failure',()=>{
 const cache=new Cache(),a=new THREE.Group();let builds=0;
 const build=group=>{builds++;const mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());group.add(mesh);return mesh;};
 cache.begin('opaque');const first=cache.part('one',{x:1},a,build),other=cache.part('two',{x:1},a,build);cache.commit();const old=first.parent;
 const b=new THREE.Group();cache.begin('opaque');assert.equal(cache.part('one',{x:1},b,build),first);const changed=cache.part('two',{x:2},b,build);assert.notEqual(changed,other);assert.deepEqual(cache.commit(),{built:1,reused:1});assert.equal(builds,3);assert.equal(first.parent,old);assert.equal(old.parent,b);assert.equal(other.parent.parent,a);
 const c=new THREE.Group();cache.begin('opaque');cache.part('one',{x:1},c,build);assert.throws(()=>cache.part('broken',{},c,()=>{throw Error('triangulation');}),/triangulation/);cache.rollback();assert.equal(old.parent,b);assert.equal(cache.entries.size,2);
 cache.begin('textured');assert.notEqual(cache.part('one',{x:1},c,build),first);cache.commit();assert.equal(cache.entries.size,1);cache.clear();assert.equal(cache.entries.size,0);
});
test('frame pipeline uses latest input, runs input then redraw in one frame, and cancels stale jobs',()=>{
 const callbacks=new Map();let next=0;const ctx={window:null,requestAnimationFrame:fn=>{callbacks.set(++next,fn);return next;},cancelAnimationFrame:id=>callbacks.delete(id)};ctx.window=ctx;vm.runInNewContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_frame_pipeline.js','utf8'),ctx);const p=ctx.ExteriorFramePipeline,seen=[];
 p.enqueue('view',()=>seen.push('old view'),20);p.enqueue('input',()=>{seen.push('old input');},10);p.enqueue('input',()=>{seen.push('latest input');p.enqueue('view',()=>seen.push('latest view'),20);},10);
 p.flush();assert.deepEqual(seen,['latest input','latest view']);assert.equal(callbacks.size,0);
 p.enqueue('cancelled',()=>{throw Error('stale');});p.cancel('cancelled');p.flush();assert.equal(callbacks.size,0);
 p.enqueue('failure',()=>{p.enqueue('recovery',()=>seen.push('recovered'));throw Error('failed');});assert.throws(()=>p.flush(),/failed/);p.flush();assert.equal(seen.at(-1),'recovered');
});
test('queued movement draws immediately inside the idle interval',()=>{
 const source=fs.readFileSync('public/measure/internal/editor_scripts/scene_3d.js','utf8');
 const loop=source.slice(source.indexOf('function _animate3D()'),source.indexOf('// =========================================================',source.indexOf('function _animate3D()')));
 let time=16,draws=0;const ctx={window:null,performance:{now:()=>time},requestAnimationFrame:()=>1,cancelAnimationFrame(){},enable3D:true,controls:{update:()=>false},renderer:{render(){draws++;},info:{}},scene:{},camera:{},_updateAxisWidget(){},renderGeometry3D(){},_sceneDirty3D:false,_geomDirty3D:false,_lastGeomRebuild:0,_lastSceneRender3D:0,GEOM_REBUILD_INTERVAL_MS:100,IDLE_SCENE_RENDER_INTERVAL_MS:100};ctx.window=ctx;
 vm.runInNewContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_frame_pipeline.js','utf8'),ctx);
 const invalidate=source.match(/window\.invalidateScene3D=\(\)=>\{_sceneDirty3D=true;\};/)[0];vm.runInNewContext(invalidate+loop,ctx);
 ctx._animate3D();assert.equal(draws,0);
 ctx.ExteriorFramePipeline.enqueue('input',()=>ctx.ExteriorFramePipeline.enqueue('view',()=>ctx.invalidateScene3D(),20),10);
 ctx._animate3D();assert.equal(draws,1);assert.equal(ctx._sceneDirty3D,false);
 time=32;ctx.ExteriorFramePipeline.enqueue('view',()=>ctx.invalidateScene3D());ctx._animate3D();assert.equal(draws,2);
});
