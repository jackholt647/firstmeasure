const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('length labels apply constant pixel size on the first frame and outline only the letters',()=>{
 const paint=[],canvasContext={strokeText(text){paint.push(['outline',text,this.strokeStyle]);},fillText(text){paint.push(['fill',text,this.fillStyle]);}},sprites=[];
 class Sprite{constructor(material){this.material=material;this.userData={};this.position={copy(){}};this.center={set(){}};this.scale={set:(x,y)=>{this.sx=x;this.sy=y;}};}updateMatrixWorld(){this.worldY=this.sy;}}
 const ctx={document:{createElement:()=>({getContext:()=>canvasContext})},THREE:{Sprite,CanvasTexture:class{},SpriteMaterial:class{constructor(o){Object.assign(this,o);}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const vector=p=>({...p,clone(){return vector(this);},project(){return this;}}),edge={a:{x:0,y:0,z:0},b:{x:1,y:1,z:0},length:.9144};
 for(const height of [600,1000])for(const projection of [1,2,4]){
  ctx.wallLengthMarker({add:s=>sprites.push(s)},vector,edge);const s=sprites.at(-1);s.updateMatrixWorld();
  const render=()=>s.onBeforeRender({domElement:{getBoundingClientRect:()=>({width:1200,height})}},null,{projectionMatrix:{elements:[0,0,0,0,0,projection]}});
  render();const pixels=s.worldY*projection*height/2*40/64;assert.ok(Math.abs(pixels-14)<1e-9,'new label must be 14 pixels on its first frame');const first=s.worldY;render();assert.equal(s.worldY,first,'subsequent frame must not jump in size');assert.ok(s.material.rotation>0);
 }
 assert.deepEqual(paint[0],['outline','3.0\u2032','#000']);assert.deepEqual(paint[1],['fill','3.0\u2032','#fff']);
});
test('selected line highlight matches projected endpoints at unequal depths',()=>{
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}clone(){return new V(this.x,this.y,this.z);}set(x,y,z){Object.assign(this,{x,y,z});return this;}copy(v){return this.set(v.x,v.y,v.z);}project(){this.x/=this.z;this.y/=this.z;return this;}unproject(){this.x*=this.z;this.y*=this.z;return this;}}
 class Sprite{constructor(material){this.material=material;this.userData={};this.position=new V();this.modelViewMatrix={multiplyMatrices:()=>{this.drawPosition=this.position.clone();}};this.scale={set:(x,y)=>{this.sx=x;this.sy=y;}};}updateMatrixWorld(){}}
 const ctx={THREE:{Sprite,SpriteMaterial:class{constructor(o){Object.assign(this,o);}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const pair=[{x:-1,y:.3,z:2},{x:2,y:-.7,z:6}],vector=p=>new V(p.x,p.y,p.z);let s;ctx.wallSelectedLine({add:o=>s=o},vector,pair);
 for(const width of [800,1400]){const height=600;s.onBeforeRender({domElement:{getBoundingClientRect:()=>({width,height})}},null,{projectionMatrix:{elements:[0,0,0,0,0,1]}});const center=s.drawPosition.clone().project(),dx=Math.cos(s.material.rotation)*s.sx*height/4,dy=Math.sin(s.material.rotation)*s.sx*height/4;for(const [i,sign] of [[0,-1],[1,1]]){const q=vector(pair[i]).project();assert.ok(Math.abs(center.x*width/2+sign*dx-q.x*width/2)<1e-9);assert.ok(Math.abs(center.y*height/2+sign*dy-q.y*height/2)<1e-9);}assert.equal(s.sy*height/2,3);}
});

test('chamfer readouts avoid padded projected edges and other readouts across orbit angles',()=>{
 const ctx={};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const viewport={left:0,top:0,right:1000,bottom:800},anchor={x:500,y:400},width=154,height=120;
 for(const angle of [0,.4,1,1.7,2.8]){const rotate=(x,y)=>({x:500+x*Math.cos(angle)-y*Math.sin(angle),y:400+x*Math.sin(angle)+y*Math.cos(angle)}),segments=[[-360,0,360,0],[0,-290,0,290],[-280,-220,280,220]].map(([x,y,u,v])=>[rotate(x,y),rotate(u,v)]),placed=[];
  for(let n=0;n<2;n++){const at=ctx.wallChamferLabelPosition(anchor,width,height,viewport,segments,placed);assert.ok(at.x>=10&&at.x+width<=990&&at.y>=10&&at.y+height<=790);
   for(const [a,b]of segments)for(let i=0;i<=1000;i++){const x=a.x+(b.x-a.x)*i/1000,y=a.y+(b.y-a.y)*i/1000;assert.ok(x<at.x-24||x>at.x+width+24||y<at.y-24||y>at.y+height+24,'line must clear the label padding');}
   for(const r of placed)assert.ok(at.x>=r.x+r.width+12||at.x+width+12<=r.x||at.y>=r.y+r.height+12||at.y+height+12<=r.y);placed.push({...at,width,height});
  }
 }
});

test('selected sticker dimensions are bold, larger and remain visible in textured mode',()=>{
 const paint={strokeText(){},fillText(){}},sprites=[];
 class Sprite{constructor(material){this.material=material;this.userData={};this.position={copy(){}};this.scale={set:(x,y)=>this.height=y};}updateMatrixWorld(){}}
 const ctx={document:{createElement:()=>({getContext:()=>paint})},THREE:{Sprite,CanvasTexture:class{},SpriteMaterial:class{constructor(o){Object.assign(this,o);}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const vector=p=>({...p,clone(){return vector(this);},project(){return this;}});
 ctx.wallLengthMarker({add:s=>sprites.push(s)},vector,{a:{x:0,y:0,z:0},b:{x:1,y:0,z:0},text:'3 x 4',selected:true});
 const s=sprites[0];assert.match(paint.font,/bold/);assert.equal(paint.lineWidth,8);assert.equal(s.userData.exteriorSelection,true);
 s.onBeforeRender({domElement:{getBoundingClientRect:()=>({width:1000,height:600})}},null,{projectionMatrix:{elements:[0,0,0,0,0,1]}});assert.ok(Math.abs(s.height*600/2*40/64-18)<1e-9);
});

test('dimension labels share textures but retain independent materials and release unused entries',()=>{
 let paints=0,disposed=0;const ctx={document:{createElement:()=>({getContext:()=>({strokeText(){},fillText(){paints++;}})})},THREE:{CanvasTexture:class{dispose(){disposed++;}},SpriteMaterial:class{constructor(o){Object.assign(this,o);}dispose(){}},Sprite:class{constructor(m){this.material=m;this.userData={};this.position={copy(){}};this.scale={set(){}};}}}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/wall_editor.js','utf8'),ctx);
 const make=(text,selected=false)=>{let sprite;ctx.wallLengthMarker({add:s=>sprite=s},p=>p,{text,selected,a:{x:0,y:0,z:0},b:{x:1,y:0,z:0}});return sprite;};
 const a=make('shared'),b=make('shared');assert.equal(paints,1);assert.equal(a.material.map,b.material.map);assert.notEqual(a.material,b.material);
 a.material.dispose();assert.equal(disposed,0);const selected=make('shared',true);assert.notEqual(selected.material.map,b.material.map);
 for(let i=0;i<300;i++)make('label-'+i).material.dispose();assert.ok(disposed>0);assert.equal(make('shared').material.map,b.material.map,'a live label cannot be evicted');
});
