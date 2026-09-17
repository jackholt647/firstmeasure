/* Metric texture coordinates and shared neutral maps, tinted by the finish color. */
(function(root){'use strict';
const cache=new Map();
const defaults={material:'unassigned',color:'#80868b',trimColor:'#f5f3ef'};
function resolve(face={},settings=root.WallMode?.finishDefaults||{}){
 const normal=face.normal||(face.points&&root.WallSolidGeometry?.faceFrame(face)?.n),d={...defaults,...settings},source=face.material||(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':normal?.z<-.5?'soffit':'default'),type=source==='default'?d.material:source;
 return {material:type==='default'?'unassigned':type,color:face.finishColor||face.color||((face.trim||type.startsWith('trim-'))?d.trimColor:source==='chimney-top'?'#d4d0c8':source==='shingles'?'#74777a':d.color)};
}
function texture(type){
 if(cache.has(type))return cache.get(type);
 const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const c=canvas.getContext('2d');
 c.fillStyle='#eee';c.fillRect(0,0,256,256);
 const vertical=type.includes('vertical'),trim=type.startsWith('trim'),siding=type==='siding'||type.startsWith('siding-');
 if(vertical){c.translate(256,0);c.rotate(Math.PI/2);}
 if(siding){const grad=c.createLinearGradient(0,0,0,64);grad.addColorStop(0,'#aaa');grad.addColorStop(.09,'#dedede');grad.addColorStop(.16,'#f5f5f5');grad.addColorStop(1,'#e1e1e1');for(let y=0;y<256;y+=64){c.save();c.translate(0,y);c.fillStyle=grad;c.fillRect(0,0,256,64);c.fillStyle='#888';c.fillRect(0,0,256,2);c.restore();}}
 if(siding||trim){c.strokeStyle=trim?'#d6d6d6':'#d0d0d0';c.lineWidth=.5;for(let y=5;y<256;y+=7){c.beginPath();c.moveTo(0,y);c.bezierCurveTo(80,y+2,180,y-2,256,y);c.stroke();}}
 if(type==='soffit'){for(let x=0;x<256;x+=32){c.fillStyle='#9ca0a2';c.fillRect(x,0,2,256);c.fillStyle='#fafafa';c.fillRect(x+2,0,2,256);for(let y=8;y<256;y+=12){c.fillStyle='#9ca0a2';c.fillRect(x+13,y,2,2);c.fillRect(x+19,y,2,2);}}}
 if(type==='shingles'){c.fillStyle='#d3d3d3';c.fillRect(0,0,256,256);for(let row=0;row<4;row++){const y=row*64;for(let col=-1;col<4;col++){const x=col*85+(row%2?42:0);c.fillStyle=['#c6c6c6','#dedede','#cecece'][(col+row+3)%3];c.fillRect(x,y,84,63);c.fillStyle='#777';c.fillRect(x,y+61,85,3);c.fillStyle='#a0a0a0';c.fillRect(x,y,1,61);}}for(let i=0;i<8000;i++){c.fillStyle=i%2?'#ffffff18':'#00000018';c.fillRect((i*73)%256,(i*139+Math.floor(i/256)*31)%256,1,1);}}
 if(type==='brick'||type==='masonry'){c.strokeStyle='#a0a0a0';c.lineWidth=3;for(let y=0;y<256;y+=32){c.beginPath();c.moveTo(0,y);c.lineTo(256,y);for(let x=(y%64?32:0);x<=256;x+=64){c.moveTo(x,y);c.lineTo(x,y+32);}c.stroke();}}
 if(['stucco','stone','other'].includes(type)){for(let i=0;i<1800;i++){const x=(i*137)%256,y=(i*73+Math.floor(i/256)*17)%256;c.fillStyle=i%2?'#dadada':'#f8f8f8';c.fillRect(x,y,type==='stone'?7:1,type==='stone'?5:1);}}
 const t=new THREE.CanvasTexture(canvas);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;if(THREE.SRGBColorSpace)t.colorSpace=THREE.SRGBColorSpace;else if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;cache.set(type,t);return t;
}
function prepare(mesh,face,points,parameters){
 if(!mesh.geometry?.setAttribute||!points?.length)return;
 const W=root.WallSolidGeometry,frame=W.faceFrame({points:face.points||points});let u=frame?.u||{x:1,y:0,z:0};
 if(frame&&Math.abs(frame.n.z)<.999){const length=Math.hypot(frame.n.x,frame.n.y);u={x:-frame.n.y/length,y:frame.n.x/length,z:0};}
 // Curved walls use arc length rather than a flattened projection, so boards
 // keep their width around the bend. Sampling here belongs only to rendering.
 let arcAt=null;const curve=face.curvedSurface?.start||face.curvedSurface?.curve;if(curve&&parameters){const K=root.ExteriorGeometry,lengths=[0];let previous=K.curvePoint(curve,0);for(let i=1;i<=128;i++){const p=K.curvePoint(curve,i/128);lengths.push(lengths.at(-1)+Math.hypot(p.x-previous.x,p.y-previous.y,p.z-previous.z));previous=p;}arcAt=t=>{const q=Math.max(0,Math.min(128,t*128)),i=Math.min(127,Math.floor(q));return lengths[i]+(lengths[i+1]-lengths[i])*(q-i);};}
 let axes=face.textureAxes;if(['shingles','soffit'].includes(face.material)&&frame){const n=frame.n.z<0?{x:-frame.n.x,y:-frame.n.y,z:-frame.n.z}:frame.n,l=Math.hypot(n.x,n.y),a=l>1e-8?{x:-n.y/l,y:n.x/l,z:0}:{x:1,y:0,z:0};axes={u:a,v:{x:n.y*a.z-n.z*a.y,y:n.z*a.x-n.x*a.z,z:n.x*a.y-n.y*a.x}};}const dot=(p,a)=>p.x*a.x+p.y*a.y+p.z*a.z;
 const horizontal=Math.abs(frame?.n.z||0)>.999,uv=points.flatMap((p,i)=>[(axes?dot(p,axes.u):arcAt?arcAt(parameters[i].x):p.x*u.x+p.y*u.y+p.z*u.z)/(face.material==='shingles'?.9144:.6096),(axes?dot(p,axes.v):horizontal?p.x*(frame?.v.x||0)+p.y*(frame?.v.y||1):p.z)/.6096]);
 mesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));mesh.userData.exteriorFinish={material:face.material||(face.chimney?.cap&&!face.chimney.derived&&!face.trim?'chimney-top':frame?.n.z<-.5?'soffit':'default'),color:face.finishColor||null,feature:!!face.feature,trim:!!face.trim,normal:frame?.n};
}
function roofMeshes(face,vector,textured){
 const rings=[face.points,...(face.holes||[])],points=rings.flat(),positions=points.map(vector),projected=rings.map(r=>r.map(p=>new THREE.Vector2(p.x,p.y)));
 const triangles=THREE.ShapeUtils.triangulateShape(projected[0],projected.slice(1)).map(ids=>{const [a,b,c]=ids.map(i=>positions[i]),rise=vector({...points[ids[0]],z:points[ids[0]].z+1}),u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z},v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z},dot=(u.y*v.z-u.z*v.y)*(rise.x-a.x)+(u.z*v.x-u.x*v.z)*(rise.y-a.y)+(u.x*v.y-u.y*v.x)*(rise.z-a.z);return dot<0?[ids[0],ids[2],ids[1]]:ids;});
 return (textured?[false,true]:[false]).map(underside=>{
  const geometry=new THREE.BufferGeometry().setFromPoints(positions);geometry.setIndex(triangles.flat());
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:'#54cf86',side:textured?(underside?THREE.BackSide:THREE.FrontSide):THREE.DoubleSide,transparent:true,opacity:.1,depthWrite:false}));mesh.userData.pickLayer='roof';mesh.userData.roofUnderside=underside;
  prepare(mesh,{...face,material:underside?(face.soffitMaterial||'soffit'):'shingles',finishColor:underside?face.soffitColor:face.finishColor,textureAxes:face.textureAxes},points);return mesh;
 });
}
// r128 leaves CSS colors in sRGB, while tile visibility changes renderer output.
// Finish maps and tints use linear light internally and always emit display sRGB.
// A uniform restores the normal renderer policy when leaving textured mode.
function colorManagedFinish(material){
 material.userData||={};
 let enabled=material.userData.exteriorFinishColorManaged;
 if(!enabled){
  enabled=material.userData.exteriorFinishColorManaged={value:0};
  const compile=material.onBeforeCompile,key=material.customProgramCacheKey;
  material.onBeforeCompile=function(shader,renderer){
   compile?.call(this,shader,renderer);
   shader.uniforms.exteriorFinishColorManaged=enabled;
   shader.fragmentShader='uniform float exteriorFinishColorManaged;\n'+shader.fragmentShader.replace('#include <encodings_fragment>', 'if (exteriorFinishColorManaged > 0.5) { gl_FragColor = LinearTosRGB(gl_FragColor); } else {\n#include <encodings_fragment>\n}');
  };
  material.customProgramCacheKey=function(){return (key?.call(this)||'')+':exterior-finish-srgb-v1';};
  material.needsUpdate=true;
 }
 enabled.value=1;
}
function reset(material){const enabled=material.userData?.exteriorFinishColorManaged;if(enabled)enabled.value=0;}
function apply(mesh,material){
 const finish=mesh.userData.exteriorFinish||((mesh.userData.pickLayer==='walls'||mesh.userData.pickLayer==='base'||mesh.userData.baseId!==undefined)?{material:'default'}:null);
 if(!finish||finish.feature)return;
 // The construction base has its own neutral default, independent of cladding.
 const base=(mesh.userData.baseId!==undefined||mesh.userData.pickLayer==='base')&&!finish.trim&&['default','unassigned',undefined].includes(finish.material);
 const resolved=base?{material:'unassigned',color:finish.color||'#b3afa7'}:resolve(finish);
 colorManagedFinish(material);
 material.color.set(resolved.color);material.color.convertSRGBToLinear?.();
 const n=finish.normal;if(n)material.color.multiplyScalar(.78+.22*Math.abs(n.x*.37+n.y*.53+n.z*.76));
 material.map=['unassigned','chimney-top'].includes(resolved.material)?null:texture(resolved.material);
}
root.ExteriorFinishes={prepare,apply,reset,resolve,defaults,roofMeshes};
})(window);
