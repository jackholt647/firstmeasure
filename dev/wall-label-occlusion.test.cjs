const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const THREE=require('../public/v1/node_modules/three');
function fixture(perspective=false){
 const ctx={THREE};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const scene=new THREE.Scene(),camera=perspective?new THREE.PerspectiveCamera(45,1,.1,100):new THREE.OrthographicCamera(-2,2,2,-2,.1,100);camera.position.z=10;
 const wall=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));scene.add(wall);
 const label=new THREE.Sprite(new THREE.SpriteMaterial({opacity:.85,depthTest:false,depthWrite:false}));label.userData.wallFeature=true;scene.add(label);
 let callbacks=0;label.onBeforeRender=()=>callbacks++;ctx.wallLabelOcclusion(label,true);
 const renderer={info:{render:{frame:0}}},render=()=>{scene.updateMatrixWorld(true);camera.updateMatrixWorld();renderer.info.render.frame++;label.onBeforeRender(renderer,scene,camera);return label.material.opacity;};
 return {ctx,scene,camera,wall,label,render,callbacks:()=>callbacks};
}
for(const perspective of [false,true])test(`whole labels respect occlusion with ${perspective?'perspective':'orthographic'} cameras`,()=>{
 const f=fixture(perspective);assert.equal(f.render(),.85,'coplanar label stays whole');assert.equal(f.label.material.depthTest,false);
 f.label.position.z=-1;assert.equal(f.render(),0,'opposite sticker hidden');assert.equal(f.label.visible,true,'hidden label remains eligible to recover');
 f.camera.position.z=-10;f.camera.lookAt(0,0,0);assert.equal(f.render(),.85,'orbit reveals opposite sticker');
 assert.equal(f.callbacks(),3,'dimension layout callback preserved');
});
test('label visibility follows surfaces, geometry updates and display mode',()=>{
 const f=fixture();f.label.position.z=-1;assert.equal(f.render(),0);
 let calls=0;const raycast=f.wall.raycast;f.wall.raycast=function(...args){calls++;return raycast.apply(this,args);};assert.equal(f.render(),0);assert.equal(calls,0,'idle view reuses visibility');
 f.wall.position.x=5;assert.equal(f.render(),.85);f.wall.position.x=0;assert.equal(f.render(),0);
 f.wall.visible=false;assert.equal(f.render(),.85);f.wall.visible=true;assert.equal(f.render(),0);
 f.ctx.wallLabelOcclusion(f.label,false);assert.equal(f.render(),.85);f.ctx.wallLabelOcclusion(f.label,true);assert.equal(f.render(),0);
 const position=f.wall.geometry.getAttribute('position');for(let i=0;i<position.count;i++)position.setX(i,position.getX(i)+5);position.needsUpdate=true;f.wall.geometry.computeBoundingSphere();assert.equal(f.render(),.85);
});
