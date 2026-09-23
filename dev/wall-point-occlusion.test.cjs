const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const THREE=require('../public/v1/node_modules/three');
function fixture(){
 const ctx={THREE};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-2,2,2,-2,.1,100);camera.position.z=10;camera.updateMatrixWorld();
 const wall=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));scene.add(wall);
 const points=new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(0,0,-1),new THREE.Vector3(1.005,0,-1),new THREE.Vector3(.995,0,-1)]),new THREE.PointsMaterial({size:10,sizeAttenuation:false}));scene.add(points);scene.updateMatrixWorld(true);
 const renderer={info:{render:{frame:0}},getSize:v=>v.set(400,400)};
 ctx.wallPointOcclusion(points,true);
 const render=()=>{scene.updateMatrixWorld(true);camera.updateMatrixWorld();renderer.info.render.frame++;points.onBeforeRender(renderer,scene,camera);return Array.from(points.geometry.index.array.slice(0,points.geometry.drawRange.count));};
 return {ctx,scene,camera,wall,points,render};
}
test('surface and exposed anchors retain whole markers; hidden anchors cannot peek around edges',()=>{
 const f=fixture();assert.deepEqual(f.render(),[0,2]);
 let calls=0;const original=f.wall.raycast;f.wall.raycast=function(...a){calls++;return original.apply(this,a);};
 assert.deepEqual(f.render(),[0,2]);assert.equal(calls,0,'unchanged views reuse visibility');
 f.wall.visible=false;assert.deepEqual(f.render(),[0,1,2,3]);
 f.wall.visible=true;assert.deepEqual(f.render(),[0,2]);
 f.camera.position.z=-10;f.camera.lookAt(0,0,0);assert.deepEqual(f.render(),[0,1,2,3]);
});
test('translucent mode restores all markers and opaque mode recomputes occlusion',()=>{
 const f=fixture();f.render();f.ctx.wallPointOcclusion(f.points,false);f.points.onBeforeRender({},{},{});assert.equal(f.points.geometry.index,null);assert.equal(f.points.geometry.drawRange.count,Infinity);
 f.ctx.wallPointOcclusion(f.points,true);assert.deepEqual(f.render(),[0,2]);
});

test('all-hidden batches recover after a surface moves, and invisible surfaces do not occlude',()=>{
 const f=fixture();f.wall.scale.set(4,4,1);f.wall.position.z=1;assert.deepEqual(f.render(),[]);
 f.wall.position.x=20;assert.deepEqual(f.render(),[0,1,2,3]);
 f.wall.position.x=0;f.wall.material.visible=false;assert.deepEqual(f.render(),[0,1,2,3]);
});
test('perspective cameras also retain surface markers and reject points behind the wall',()=>{
 const f=fixture(),camera=new THREE.PerspectiveCamera(45,1,.1,100);camera.position.z=10;camera.updateMatrixWorld();f.scene.updateMatrixWorld(true);
 f.points.onBeforeRender({info:{render:{frame:1}},getSize:v=>v.set(400,400)},f.scene,camera);
 const indices=Array.from(f.points.geometry.index.array.slice(0,f.points.geometry.drawRange.count));assert.ok(indices.includes(0));assert.ok(!indices.includes(1));
});

for(const nested of [false,true])test(`opaque markers exclude ${nested?'nested tile':'DSM'} imagery while retaining wall occlusion`,()=>{
 const f=fixture(),image=new THREE.Mesh(new THREE.PlaneGeometry(8,8,128,128),new THREE.MeshBasicMaterial({side:THREE.DoubleSide})),root=nested?new THREE.Group():image;
 root.userData.exteriorReferenceImagery=true;if(nested)root.add(image);image.position.z=2;f.scene.add(root);let calls=0;image.raycast=()=>{calls++;};
 assert.deepEqual(f.render(),[0,2]);assert.equal(calls,0,'dense image is never raycast for point visibility');
 f.ctx.wallPointOcclusion(f.points,false);f.points.onBeforeRender({},{},{});f.ctx.wallPointOcclusion(f.points,true);f.camera.position.x=.01;assert.deepEqual(f.render(),[0,2]);assert.equal(calls,0,'mode switches and camera motion do not raycast imagery');
 f.wall.visible=false;assert.deepEqual(f.render(),[0,1,2,3],'imagery does not hide drafting markers');image.geometry.dispose();
});

for(const perspective of [false,true])for(const zoom of [.65,1,1.4])for(const selected of [false,true])test(`near-surface markers survive grazing angles: perspective=${perspective}, zoom=${zoom}, selected=${selected}`,()=>{
 const f=fixture(),camera=perspective?new THREE.PerspectiveCamera(45,1,.1,100):new THREE.OrthographicCamera(-4,4,4,-4,.1,100);
 f.points.geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,-.001],3));f.points.material.size=selected?9:5;
 f.wall.scale.set(20,20,1);camera.zoom=zoom;camera.updateProjectionMatrix();
 for(const eye of [[0,0,8],[8,7,.5],[-8,7,.5]]){
  camera.position.set(...eye);camera.lookAt(0,0,0);camera.updateMatrixWorld();f.scene.updateMatrixWorld(true);
  f.points.onBeforeRender({info:{render:{frame:Math.random()}},getSize:v=>v.set(400,400)},f.scene,camera);
  assert.equal(f.points.geometry.drawRange.count,1,'contact point must stay visible');
 }
 // A genuinely nearer surface still hides the whole marker.
 f.wall.position.z=.1;f.scene.updateMatrixWorld(true);
 f.points.onBeforeRender({info:{render:{frame:Math.random()}},getSize:v=>v.set(400,400)},f.scene,camera);
 assert.equal(f.points.geometry.drawRange.count,0);
});

test('a rectangle shares one pick-scene traversal and releases it after the query',()=>{
 const f=fixture();f.ctx.camera=f.camera;f.ctx.renderer={domElement:{getBoundingClientRect:()=>({left:0,top:0,width:400,height:400})}};f.wall.userData.pickLayer='walls';let traversals=0;const group={traverse(fn){traversals++;f.scene.traverse(fn);}};
 f.ctx.wallSelectionPicking(group,()=>{for(let i=0;i<100;i++){assert.equal(f.ctx.wallPointPickVisible(group,new THREE.Vector3(0,0,0)),true);assert.equal(f.ctx.wallPointPickVisible(group,new THREE.Vector3(0,0,-1)),false);}});
 assert.equal(traversals,1);f.wall.visible=false;assert.equal(f.ctx.wallPointPickVisible(group,new THREE.Vector3(0,0,-1)),true);assert.equal(traversals,2);
});
