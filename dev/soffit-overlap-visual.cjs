// Render private generated fixtures. Never load or save the user's live project.
const fs=require('fs'),path=require('path'),Module=require('module'),{chromium}=require('../public/v1/node_modules/playwright-core');
const root=path.resolve('public/measure/internal/editor_scripts');
function compile(file,edit){const name=path.resolve(file),m=new Module(name,module);m.filename=name;m.paths=Module._nodeModulePaths(path.dirname(name));m._compile(edit(fs.readFileSync(name,'utf8')),name);return m.exports;}
const G=require(root+'/wall_geometry'),R=require(root+'/wall_rake_cleanup');
const build=compile('dev/wall-soffit-overlap.test.cjs',s=>s.replace("const test=require('node:test')","const test=()=>{}")+'\nmodule.exports=build;');
const after=build(),currentG=G.buildSources,currentR=R.cleanup;
const oldG=process.env.SOFFIT_BEFORE_GEOMETRY?compile(process.env.SOFFIT_BEFORE_GEOMETRY,s=>s):compile(root+'/wall_geometry.js',s=>s.replace('if(Number.isFinite(Number(options.soffit))){','if(false){'));
const oldR=compile(root+'/wall_rake_cleanup.js',s=>{const a=s.indexOf(' // A larger explicit setback'),b=s.indexOf(' // Every accepted pass',a);return s.slice(0,a)+s.slice(b);});
G.buildSources=oldG.buildSources;R.cleanup=process.env.SOFFIT_BEFORE_GEOMETRY?currentR:oldR.cleanup;const before=build();G.buildSources=currentG;R.cleanup=currentR;
(async()=>{const out=path.resolve(process.argv[2]||path.join(process.env.TEMP,'soffit-overlap')),browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--use-angle=swiftshader']});fs.mkdirSync(out,{recursive:true});try{
 const page=await browser.newPage({viewport:{width:1000,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setContent('<style>body{margin:0;background:#111;color:white;font:18px system-ui}h3{position:absolute;left:20px;top:0}</style><h3></h3><canvas></canvas>');
 await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});await page.addScriptTag({path:root+'/wall_editor.js'});
 await page.evaluate(()=>{const renderer=new THREE.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true,preserveDrawingBuffer:true});renderer.setSize(1000,850);renderer.setClearColor('#111');window.draw=(data,corner,title)=>{
  document.querySelector('h3').textContent=title;const scene=new THREE.Scene(),group=new THREE.Group();scene.add(group);const vector=p=>new THREE.Vector3(p.x,p.z,-p.y),camera=new THREE.PerspectiveCamera(40,1000/850,.01,1000);
  const center=corner==='front'?{x:4,y:3,z:161.5}:corner==='chimney'?{x:8.7,y:-1.8,z:160.4}:{x:4.1,y:3.8,z:160.5},eye=corner==='front'?{x:9,y:7.6,z:181.5}:corner==='chimney'?{x:15,y:-5,z:166}:{x:11,y:10,z:166};camera.position.copy(vector(eye));camera.lookAt(vector(center));camera.updateMatrixWorld();
  const polygon=(points,holes,color,roof=false)=>{const origin=vector(points[0]),normal=new THREE.Vector3().subVectors(vector(points[1]),origin).cross(new THREE.Vector3().subVectors(vector(points[2]),origin)).normalize(),u=new THREE.Vector3().subVectors(vector(points[1]),origin).normalize(),v=new THREE.Vector3().crossVectors(normal,u),local=p=>{const q=vector(p).sub(origin);return new THREE.Vector2(q.dot(u),q.dot(v));},rings=[points,...holes],geometry=new THREE.BufferGeometry().setFromPoints(rings.flat().map(vector));geometry.setIndex(THREE.ShapeUtils.triangulateShape(points.map(local),holes.map(r=>r.map(local))).flat());group.add(new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide})));for(const ring of rings)group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...ring,ring[0]].map(vector)),new THREE.LineBasicMaterial({color:roof?'#65dc98':'#ffd16a'})));};
  for(const w of data.composed)polygon([w.bottom[0],w.bottom[1],w.top[1],w.top[0]],[],w.chimney?'#967c6d':'#ae974d');for(const f of data.state.roof.faces)polygon(f.points,f.holes||[],'#608c73',true);
  for(const c of data.state.chimneys.items||[])polygon(c.points,[],'#9e9b91');exteriorSurfaceDisplay(group,'opaque');renderer.render(scene,camera);renderer.render(scene,camera);
 };});
 for(const corner of ['chimney','overlap','front'])for(const [name,data]of [['before',before],['after',after]]){await page.evaluate(({data,corner,name})=>draw(data,corner,name+' — '+corner+' / 18-inch soffit'),{data,corner,name});await page.screenshot({path:path.join(out,corner+'-'+name+'.png')});}
 if(errors.length)throw Error(errors.join('\n'));console.log(out);
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
