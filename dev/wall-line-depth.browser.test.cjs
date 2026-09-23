const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
test('WebGL grade stays below a coplanar base and opaque markers obey anchor visibility',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:400,height:400}});await page.setContent('<style>body{margin:0}</style><canvas></canvas>');
  await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});await page.addScriptTag({path:'public/measure/internal/editor_scripts/wall_editor.js'});
  const result=await page.evaluate(()=>{
   const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:false,preserveDrawingBuffer:true});renderer.setSize(400,400);
   const scene=new THREE.Scene(),group=new THREE.Group();scene.add(group);const camera=new THREE.OrthographicCamera(-2,2,2,-2,.1,100);camera.position.z=10;camera.updateMatrixWorld();
   const base=new THREE.Mesh(new THREE.PlaneGeometry(2,2),new THREE.MeshBasicMaterial({color:'white',side:THREE.DoubleSide}));base.userData.baseId='base';
   const grade=new THREE.Mesh(new THREE.PlaneGeometry(5,5),new THREE.MeshBasicMaterial({color:'blue',side:THREE.DoubleSide}));grade.userData.pickLayer='grade';
   group.add(base,grade);exteriorSurfaceDisplay(group,'opaque');
   const pixel=(x,y)=>{const data=new Uint8Array(4);renderer.getContext().readPixels(x,y,1,1,renderer.getContext().RGBA,renderer.getContext().UNSIGNED_BYTE,data);return Array.from(data);};
   const checks=[];for(const z of [0,.2])for(const reverse of [false,true]){grade.position.z=z;group.remove(base,grade);group.add(...(reverse?[grade,base]:[base,grade]));renderer.render(scene,camera);const c=pixel(200,200);checks.push(z===0?Math.abs(c[0]-c[2])<2&&c[0]>100:c[2]>c[0]+20);}
   grade.visible=false;
   const points=new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(.995,.5,-1),new THREE.Vector3(1.005,-.5,-1)]),new THREE.PointsMaterial({color:'#ffff00',size:9,sizeAttenuation:false}));group.add(points);exteriorSurfaceDisplay(group,'opaque');renderer.render(scene,camera);
   const yellow=(x,y)=>{const c=pixel(x,y);return c[0]>230&&c[1]>230&&c[2]<20;};
   checks.push(yellow(200,200),!yellow(300,250),!yellow(303,250),yellow(300,150),yellow(297,150));
   base.position.z=1;base.scale.set(4,4,1);renderer.render(scene,camera);checks.push(points.geometry.drawRange.count===0);
   base.visible=false;renderer.render(scene,camera);checks.push(points.geometry.drawRange.count===3,yellow(200,200));
   return checks;
  });
  assert.ok(result.every(Boolean),JSON.stringify(result));
  const out=path.join(process.env.TEMP||require('os').tmpdir(),'exterior-line-depth');fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'point-visibility.png')});
 }finally{await browser.close();}
});
test('WebGL exterior wire and highlights clear their surface but stay behind nearer walls',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:700,height:700}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.setContent('<style>body{margin:0}</style><canvas></canvas>');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});await page.addScriptTag({path:'public/measure/internal/editor_scripts/wall_editor.js'});
  await page.evaluate(()=>{
   const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:false,preserveDrawingBuffer:true});renderer.setSize(700,700);renderer.setClearColor('#111111');
   window.checkWire=({perspective,highlight,soffit,occluded,mode='opaque',zoom=1,eye=[5,4,8]})=>{
    const scene=new THREE.Scene(),group=new THREE.Group();scene.add(group);
    const camera=perspective?new THREE.PerspectiveCamera(45,1,.1,100):new THREE.OrthographicCamera(-4,4,4,-4,.1,100);camera.position.set(...eye);camera.lookAt(0,0,0);camera.zoom=zoom;camera.updateProjectionMatrix();camera.updateMatrixWorld();
    const material=new THREE.MeshBasicMaterial({color:'#887744',side:THREE.DoubleSide});
    for(const points of [[[-3,-2,0],[0,-2,0],[0,2,0],[-3,2,0]],[[0,-2,0],[0,-2,-3],[0,2,-3],[0,2,0]]]){const geo=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p)));geo.setIndex([0,1,2,0,2,3]);group.add(new THREE.Mesh(geo,material.clone()));}
    // A tiny rounding error puts the corner line just inside both surface planes.
    const pair=[new THREE.Vector3(-.00001,-1.8,-.00001),new THREE.Vector3(-.00001,1.8,-.00001)];
    if(soffit)wallSoffitLine(group,p=>new THREE.Vector3(p.x,p.y,p.z),pair);else if(highlight)wallSelectedLine(group,p=>new THREE.Vector3(p.x,p.y,p.z),pair);else group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pair),new THREE.LineBasicMaterial({color:'#ffff00'})));
    if(occluded){const mesh=new THREE.Mesh(new THREE.PlaneGeometry(5,5),material.clone());mesh.position.copy(camera.position).multiplyScalar(.2);mesh.quaternion.copy(camera.quaternion);group.add(mesh);}
    exteriorSurfaceDisplay(group,mode);renderer.render(scene,camera);renderer.render(scene,camera);
    const gl=renderer.getContext(),pixels=new Uint8Array(700*700*4);gl.readPixels(0,0,700,700,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    const screen=pair.map(p=>p.clone().project(camera)),samples=[];
    for(let i=1;i<20;i++){const t=i/20,x=Math.round((screen[0].x*(1-t)+screen[1].x*t+1)*350),y=Math.round((screen[0].y*(1-t)+screen[1].y*t+1)*350);let visible=false;
     for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){const k=((y+dy)*700+x+dx)*4;if(soffit?pixels[k]>220&&pixels[k+1]>60&&pixels[k+1]<160&&pixels[k+2]<100:pixels[k]>220&&pixels[k+1]>220&&(highlight?pixels[k+2]>220:pixels[k+2]<40))visible=true;}
     samples.push(visible);
    }
    scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});return samples;
   };
  });
  for(const perspective of [false,true])for(const kind of ['wire','highlight','soffit'])for(const zoom of [.65,1,1.4])for(const eye of [[5,4,8],[8,7,.5],[.5,7,8]]){
   const options={perspective,highlight:kind==='highlight',soffit:kind==='soffit',zoom,eye};const visible=await page.evaluate(o=>checkWire(o),options);assert.ok(visible.every(Boolean),JSON.stringify({...options,visible}));
   const hidden=await page.evaluate(o=>checkWire({...o,occluded:true}),options);assert.ok(hidden.every(v=>!v),'nearer wall must hide the line '+JSON.stringify({...options,hidden}));
  }
  const through=await page.evaluate(()=>checkWire({perspective:true,soffit:true,occluded:true,mode:'translucent'}));assert.ok(through.every(Boolean),'translucent soffits remain visible through surfaces');
  const output=path.join(process.env.TEMP||require('os').tmpdir(),'exterior-line-depth');fs.mkdirSync(output,{recursive:true});
  for(const highlight of [false,true]){await page.evaluate(o=>checkWire(o),{perspective:true,highlight});await page.screenshot({path:path.join(output,highlight?'highlight.png':'wire.png')});}
  assert.deepEqual(errors,[]);console.log('WebGL screenshots: '+output);
 }finally{await browser.close();}
});

