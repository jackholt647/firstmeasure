const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const THREE=require('../public/v1/node_modules/three/build/three.js');
const source=fs.readFileSync('public/measure/internal/editor_scripts/scene_3d.js','utf8');
test('FOV preserves target framing and heading, hides in TRI and survives toggles',()=>{
 const elements={ 'perspective-fov-controls':{style:{}},perspectiveFovRange:{value:'45',dataset:{}},perspectiveFovValue:{textContent:''},three:{clientWidth:600,clientHeight:400}};
 const camera=new THREE.PerspectiveCamera(45,1.5,.01,2000);camera.position.set(5,6,10);const target=new THREE.Vector3(2,1,-3);camera.lookAt(target);camera.updateMatrixWorld();
 const ctx={THREE,camera,scene:{},controls:{target,minDistance:.1,maxDistance:1000,update(){}},_enh:{isOrthographic:false,perspectiveFov:45},_sceneDirty3D:false,document:{getElementById:id=>elements[id==='three-container'?'three':id]}};ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('function sync3DPerspectiveFovUI()'),source.indexOf('// §20  CAMERA PRESETS')),ctx);
 const position=camera.position.clone(),heading=camera.quaternion.toArray(),before=camera.projectionMatrix.toArray();
 const point=target.clone().add(new THREE.Vector3(1,0,0).applyQuaternion(camera.quaternion));const screen=point.clone().project(camera);
 ctx.set3DPerspectiveFov(75);assert.equal(camera.fov,75);assert.notDeepEqual(camera.projectionMatrix.toArray(),before);assert.ok(camera.position.distanceTo(position)>1);const projected=point.clone().project(camera);assert.ok(Math.hypot(projected.x-screen.x,projected.y-screen.y)<1e-10);assert.deepEqual(camera.quaternion.toArray(),heading);assert.equal(elements.perspectiveFovValue.textContent,'75°');assert.equal(ctx._sceneDirty3D,true);
 for(let i=0;i<20;i++){ctx.set3DPerspectiveFov(15);ctx.set3DPerspectiveFov(100);ctx.set3DPerspectiveFov(45);}assert.ok(camera.position.distanceTo(position)<1e-10);assert.ok(Math.abs(ctx.controls.minDistance-.1)<1e-10);assert.ok(Math.abs(ctx.controls.maxDistance-1000)<1e-8);
 ctx.set3DPerspectiveFov(75);
 ctx.toggleProjection();assert.equal(elements['perspective-fov-controls'].style.display,'none');ctx.set3DPerspectiveFov(20);ctx.toggleProjection();assert.equal(ctx.camera.fov,75);assert.equal(elements['perspective-fov-controls'].style.display,'');
 ctx.set3DPerspectiveFov(999);assert.equal(ctx.camera.fov,100);ctx.set3DPerspectiveFov(0);assert.equal(ctx.camera.fov,15);ctx.set3DPerspectiveFov('bad');assert.equal(ctx.camera.fov,15);
 ctx.camera.fov=45;ctx.sync3DPerspectiveFovUI();assert.equal(elements.perspectiveFovRange.value,'45');
});

