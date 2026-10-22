const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),THREE=require('../public/v1/node_modules/three'),ClipperLib=require('../public/measure/internal/editor_scripts/vendor/clipper-lib-6.4.2-clipper.js');
const SCRIPTS='public/measure/internal/editor_scripts/';
function finishes(){const canvasContext=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>o[k]||(()=>{})});const ctx={THREE,ExteriorGeometry:K,WallSolidGeometry:W,ClipperLib,document:{createElement:()=>({getContext:()=>canvasContext})}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(SCRIPTS+'exterior_finishes.js','utf8'),ctx);return ctx.ExteriorFinishes;}
const segDistance=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l)):0;return Math.hypot(p.x-a.x-dx*t,p.y-a.y-dy*t);};
const edgeDistance=(p,ring)=>Math.min(...ring.map((a,i)=>segDistance(p,a,ring[(i+1)%ring.length])));
const inside=(p,ring)=>{let c=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)c=!c;}return c;};

test('door insets: panels for rectangles, a traced groove for arched and irregular outlines, none for tiny or broken doors',()=>{
 const F=finishes(),m=F.doorFinishes.door.margin,rect=(w,h)=>[{x:0,y:0},{x:w,y:0},{x:w,y:h},{x:0,y:h}];
 const entry=F.doorInset(rect(.914,2.032),'door',true);assert.equal(entry.kind,'panels');assert.ok(entry.grooves.length>=2&&entry.grooves.length<=6,'2 to 6 recessed panels: '+entry.grooves.length);
 for(const g of entry.grooves)for(const p of g)assert.ok(inside(p,rect(.914,2.032))&&edgeDistance(p,rect(.914,2.032))>=m-1e-9);
 const double=F.doorInset(rect(1.83,2.03),'door',true);assert.ok(double.grooves.length>entry.grooves.length&&double.grooves.length<=12,'two leaves');
 const garage=F.doorInset(rect(4.88,2.13),'garage',true);assert.equal(garage.kind,'sections');const seams=garage.grooves.filter(g=>g.length===2);assert.equal(seams.length,3,'horizontal section seams');assert.ok(seams.every(g=>g[0].y===g[1].y));
 // Arched top: a rectangle with a semicircle, as a polyline outline.
 const arch=[{x:0,y:0},{x:1,y:0},{x:1,y:1.9}];for(let i=1;i<24;i++){const a=i/24*Math.PI;arch.push({x:.5+.5*Math.cos(a),y:1.9+.5*Math.sin(a)});}arch.push({x:0,y:1.9});
 for(const [name,outline]of [['arch',arch],['irregular',[{x:0,y:0},{x:1.1,y:0},{x:1.25,y:1.4},{x:.8,y:2.2},{x:-.1,y:1.8}]]]){
  const plan=F.doorInset(outline,'door',false);assert.equal(plan.kind,'traced',name);assert.equal(plan.grooves.length,1,name);
  const groove=plan.grooves[0];assert.ok(groove.length>=outline.length-4,name+' follows the outline');
  for(const p of groove){assert.ok(inside(p,outline),name);const d=edgeDistance(p,outline);assert.ok(d>=m-.002&&d<=m*1.6,name+' groove sits one margin in: '+d);}
 }
 // An arch is recognised by shape, not by name: its traced top stays curved (many points above the springing line).
 assert.ok(F.doorInset(arch,'door',false).grooves[0].filter(p=>p.y>1.9).length>8);
 for(const [name,outline]of [['tiny',rect(.3,.5)],['sliver',rect(2,.2)],['two points',[{x:0,y:0},{x:1,y:2}]],['nan',[{x:0,y:0},{x:NaN,y:1},{x:1,y:1}]],['unknown type',rect(1,2)]])assert.deepEqual(JSON.parse(JSON.stringify(F.doorInset(outline,name==='unknown type'?'window':'door',name==='tiny'))),{kind:'none',grooves:[]},name);
});

// A 10 m x 6 m hipped roof: four eaves, one ridge, four hips.
function hipRoof(){const p=(x,y,z)=>({x,y,z}),A=p(0,0,0),B=p(10,0,0),C=p(10,6,0),D=p(0,6,0),R1=p(3,3,2),R2=p(7,3,2),points=[A,B,C,D,R1,R2],c=(s,e,type)=>({startIdx:s,endIdx:e,type});
 return {points,faces:[{points:[A,B,R2,R1]},{points:[B,C,R2]},{points:[C,D,R1,R2]},{points:[D,A,R1]}],connections:[c(0,1,'eave'),c(1,2,'eave'),c(2,3,'eave'),c(3,0,'eave'),c(4,5,'ridge'),c(0,4,'hip'),c(1,5,'hip'),c(2,5,'hip'),c(3,4,'hip')]};}
test('ridge and hip caps: only on ridge and hip lines, within their width and lift, none for metal',()=>{
 const F=finishes(),roof=hipRoof();
 for(const category of ['shingles','shake','slate']){
  const data=F.roofCapGeometry(roof,category),spec=F.roofCapSpecs[category];assert.ok(data,category);
  assert.deepEqual(JSON.parse(JSON.stringify(data.lines.map(l=>l.type).sort())),['hip','hip','hip','hip','ridge'],category+': caps on ridge and hips only');
  for(const l of data.lines.filter(l=>l.type==='hip'))assert.ok(l.a.z<l.b.z,'hip caps lap up the line');
  const planes=roof.faces.map(f=>W.faceFrame(f)),lines=data.lines;
  for(let i=0;i<data.positions.length;i+=3){
   const q={x:data.positions[i],y:data.positions[i+1],z:data.positions[i+2]},lifts=planes.map(fr=>{const n=fr.n.z<0?{x:-fr.n.x,y:-fr.n.y,z:-fr.n.z}:fr.n;return q.z-(fr.origin.z-(n.x*(q.x-fr.origin.x)+n.y*(q.y-fr.origin.y))/n.z);}),lift=Math.min(...lifts.filter(v=>v>-1e-6));
   assert.ok(lift>=.015-1e-6&&lift<=.03,category+' lift '+lift);
   const onPlane={...q,z:q.z-lift},d=Math.min(...lines.map(l=>{const ab={x:l.b.x-l.a.x,y:l.b.y-l.a.y,z:l.b.z-l.a.z},t=Math.max(0,Math.min(1,((onPlane.x-l.a.x)*ab.x+(onPlane.y-l.a.y)*ab.y+(onPlane.z-l.a.z)*ab.z)/(ab.x**2+ab.y**2+ab.z**2)));return Math.hypot(onPlane.x-l.a.x-ab.x*t,onPlane.y-l.a.y-ab.y*t,onPlane.z-l.a.z-ab.z*t);}));
   assert.ok(d<=spec.width+.02,category+' within width: '+d);
  }
  for(let i=0;i<data.uv.length;i+=2)assert.ok(data.uv[i+1]>=-1e-9&&data.uv[i+1]<=1+1e-9);
  assert.ok(data.index.length%3===0&&Math.max(...data.index)<data.positions.length/3);
 }
 assert.equal(F.roofCapGeometry(roof,'metal'),null,'no textured cap on standing seam metal');
 const relabel=type=>({...roof,connections:roof.connections.map(c=>c.type==='hip'?{...c,type}:c)});
 assert.deepEqual(JSON.parse(JSON.stringify(F.roofCapGeometry(relabel('valley'),'shingles').lines.map(l=>l.type))),['ridge'],'valleys: the faces just meet');
 for(const type of ['eave','rake'])assert.deepEqual(F.roofCapGeometry({...relabel(type),connections:relabel(type).connections.filter(c=>c.type!=='ridge')},'shingles'),null,type);
 const mesh=F.roofCaps(roof,p=>new THREE.Vector3(p.x,p.z,-p.y),'slate');assert.equal(mesh.userData.exteriorFinish.roofCap,true);assert.equal(mesh.userData.pickLayer,'roof');assert.ok(mesh.geometry.attributes.uv);
 const one=new THREE.MeshBasicMaterial();F.apply(mesh,one);assert.equal(one.map,F.roofCapTexture('slate'),'textured modes draw the cap map');
});

// Real browser: Textured mode's pipeline (photo maps, HDR) for the cover, chimney cap colors and the fallback.
async function page(t,{failBrick=false}={}){
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--use-angle=swiftshader']});
 t.after(()=>browser.close());
 const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('http://cover.test/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><body></body>'});if(failBrick&&/brick-albedo/.test(url.pathname))return route.fulfill({status:404,body:''});const file=path.resolve('public/measure/internal',url.pathname.slice(1));assert.ok(file.startsWith(path.resolve('public/measure/internal')+path.sep));await route.fulfill({path:file});});
 await p.goto('http://cover.test/');await p.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
 for(const name of ['vendor/clipper-lib-6.4.2-clipper','vendor/earcut-3.2.3-earcut.dev','exterior_geometry','wall_solid_geometry','wall_features','exterior_finishes','exterior_scene_cache','exterior_rendered','exterior_pdf','exterior_cover'])await p.addScriptTag({url:'http://cover.test/editor_scripts/'+name+'.js'});
 // A brick box house with a hipped roof, a brick chimney and an arched door, prepared like the editor's own meshes.
 await p.evaluate(()=>{
  const vector=q=>new THREE.Vector3(q.x,q.z,-q.y),group=new THREE.Group(),pt=(x,y,z)=>({x,y,z});
  const face=(points,extra={})=>{const frame=WallSolidGeometry.faceFrame({points}),tri=ExteriorGeometry.triangles(points.map(q=>WallSolidGeometry.inFrame(frame,q)),[]).triangles.flat().map(i=>points[i]),g=new THREE.BufferGeometry().setFromPoints(tri.map(vector)),m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));m.userData.pickLayer='walls';ExteriorFinishes.prepare(m,{points,...extra},tri);group.add(m);return m;};
  face([pt(0,0,0),pt(10,0,0),pt(10,0,3),pt(0,0,3)]);face([pt(10,0,0),pt(10,6,0),pt(10,6,3),pt(10,0,3)]);face([pt(10,6,0),pt(0,6,0),pt(0,6,3),pt(10,6,3)]);face([pt(0,6,0),pt(0,0,0),pt(0,0,3),pt(0,6,3)]);
  const arch=[pt(4.5,-.002,0),pt(5.5,-.002,0),pt(5.5,-.002,1.9)];for(let i=1;i<24;i++){const a=i/24*Math.PI;arch.push(pt(5+.5*Math.cos(a),-.002,1.9+.5*Math.sin(a)));}arch.push(pt(4.5,-.002,1.9));
  window.door=face(arch,{feature:{type:'door',axis:{x:1,y:0,z:0}}});door.userData.exteriorFeature=true;
  const ch={id:'c1'};for(const [a,b]of [[pt(8,2,1),pt(9,2,1)],[pt(9,2,1),pt(9,3,1)],[pt(9,3,1),pt(8,3,1)],[pt(8,3,1),pt(8,2,1)]])face([a,b,{...b,z:4},{...a,z:4}],{chimney:{...ch,side:0}});
  window.cap=face([pt(8,2,4),pt(9,2,4),pt(9,3,4),pt(8,3,4)],{chimney:{...ch,volume:true,cap:true}});
  const R1=pt(3,3,5),R2=pt(7,3,5),A=pt(-.3,-.3,3),B=pt(10.3,-.3,3),C=pt(10.3,6.3,3),D=pt(-.3,6.3,3),c=(s,e,type)=>({startIdx:s,endIdx:e,type});
  const roof={points:[A,B,C,D,R1,R2],faces:[{points:[A,B,R2,R1]},{points:[B,C,R2]},{points:[C,D,R1,R2]},{points:[D,A,R1]}],connections:[c(0,1,'eave'),c(1,2,'eave'),c(2,3,'eave'),c(3,0,'eave'),c(4,5,'ridge'),c(0,4,'hip'),c(1,5,'hip'),c(2,5,'hip'),c(3,4,'hip')]};
  window.WallMode={finishDefaults:{material:'brick',color:'#80868b',trimColor:'#f5f3ef',roof:{category:'shingles'}},coverParts:()=>({group,roof,vector})};window.coverGroup=group;
  window.stats=url=>new Promise(resolve=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let n=0,r=0,g=0,b=0;const from=Math.floor(c.height*(window.statsFrom||0))*c.width*4;for(let i=from;i<d.length;i+=4){if(d[i]+d[i+1]+d[i+2]>720)continue;n++;r+=d[i];g+=d[i+1];b+=d[i+2];}resolve({w:img.width,h:img.height,r:r/n,g:g/n,b:b/n,ink:n/(d.length/4)});};img.src=url;});
 });
 return {p,errors};
}
test('the cover is drawn through Textured mode: brick walls show as brick, with HDR light and the door and caps',async t=>{
 const {p,errors}=await page(t);
 const result=await p.evaluate(async()=>{
  const state={exteriorReport:{walls:[{id:'W1'}]},exteriorSettings:{frontBearing:0}},steps=[];
  const cover=await ExteriorCover.attach(state,{status:s=>steps.push(s)});window.statsFrom=.72;const textured=await stats(cover.image);
  const basic=await stats(ExteriorCover.render({frontBearing:0}).image);
  const again=await ExteriorCover.attach(state);
  return {pipeline:cover.pipeline,fallback:!!cover.fallback,steps,textured,basic,cached:again===cover,key:!!cover.key,image:cover.image,basicImage:ExteriorCover.render({frontBearing:0}).image};
 });
 if(process.env.COVER_DUMP)for(const [name,url]of [['textured',result.image],['basic',result.basicImage]])fs.writeFileSync(path.join(process.env.COVER_DUMP,'fixture-cover-'+name+'.jpg'),Buffer.from(url.split(',')[1],'base64'));
 assert.equal(result.pipeline,'textured');assert.equal(result.fallback,false);assert.deepEqual(result.steps,['Loading textured materials…','Rendering textured cover…']);assert.equal(result.cached,true,'an unchanged model reuses its cover');
 assert.ok(result.textured.r>result.textured.b*1.15,'brick reads red-brown: '+JSON.stringify(result.textured));
 assert.ok(Math.abs(result.basic.r-result.basic.b)<result.textured.r-result.textured.b,'the old procedural cover was the gray one');
 assert.equal(errors.length,0,errors.join('\n'));
});
test('when a texture fails to load the cover falls back to the basic render instead of blocking',async t=>{
 const {p,errors}=await page(t,{failBrick:true});
 const result=await p.evaluate(async()=>{const state={exteriorReport:{walls:[{id:'W1'}]},exteriorSettings:{}};const started=performance.now(),cover=await ExteriorCover.attach(state);return {fallback:cover?.fallback,image:cover?.image.slice(0,23),ms:performance.now()-started,direct:await ExteriorCover.capture({})};});
 assert.equal(result.fallback,true);assert.equal(result.image,'data:image/jpeg;base64,');assert.equal(result.direct,null,'capture reports the failure');assert.ok(result.ms<20000);
 assert.equal(errors.length,0,errors.join('\n'));
});
test('chimney caps are plain in the average color of their sides; arched doors get the door material and a traced groove',async t=>{
 const {p}=await page(t);
 const r=await p.evaluate(async()=>{
  const R=ExteriorRendered,lin=c=>[c.r,c.g,c.b];
  // The precomputed photo-map means match the albedo images (linear light).
  const measured={};for(const name of Object.keys(R.PACK_MEANS)){const img=new Image();img.src='/rendered_assets/'+name+'-albedo.jpg';await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data,s=[0,0,0];for(let i=0;i<d.length;i+=4)for(let k=0;k<3;k++){const v=d[i+k]/255;s[k]+=v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}measured[name]=s.map(v=>v/(d.length/4));}
  const sides=[...coverGroup.children].filter(o=>o.userData.exteriorFinish?.chimney&&!o.userData.exteriorFinish.chimneyCap),capOf=()=>lin(R.chimneyCapColors(coverGroup.children).get('c1'));
  const brick=capOf();
  const setSides=finish=>sides.forEach(o=>Object.assign(o.userData.exteriorFinish,finish));
  setSides({material:'siding',color:'#ffffff'});const white=capOf();
  setSides({material:'siding',color:'#336699'});const tinted=capOf(),tint=lin(new THREE.Color('#336699').convertSRGBToLinear());
  sides.slice(0,3).forEach(o=>Object.assign(o.userData.exteriorFinish,{material:'brick',color:null}));const dominant=capOf();
  const scene=new THREE.Scene(),context={vector:q=>new THREE.Vector3(q.x,q.z,-q.y),center:new THREE.Vector3(5,1.5,-3),capColors:R.chimneyCapColors(coverGroup.children)};
  const capCopy=R.presentationCopy(cap,context,scene),doorCopy=R.presentationCopy(door,context,scene);
  return {measured,means:R.PACK_MEANS,brick,white,tinted,tint,grain:R.PACK_MEANS.siding.grain,dominant,capMap:!!capCopy.material.map,capColor:lin(capCopy.material.color),door:{color:lin(doorCopy.material.color),expected:lin(new THREE.Color(ExteriorFinishes.doorFinishes.door.color).convertSRGBToLinear()),inset:doorCopy.material.normalMap?.userData?.doorInset,map:!!doorCopy.material.map}};
 });
 for(const [name,mean]of Object.entries(r.means))mean.linear.forEach((v,k)=>assert.ok(Math.abs(v-r.measured[name][k])<.015,name+' mean '+v+' vs '+r.measured[name][k]));
 r.brick.forEach((v,k)=>assert.ok(Math.abs(v-r.means.brick.linear[k])<1e-6));assert.ok(r.brick[0]>r.brick[2]*2,'brick cap is reddish');
 assert.ok(r.white.every(v=>v>.75),'white siding gives a near-white cap: '+r.white);
 r.tinted.forEach((v,k)=>assert.ok(Math.abs(v-r.tint[k]*r.grain*.97)<1e-6,'cap = mean x tint'));
 assert.deepEqual(r.dominant,r.brick,'the dominant side finish by area wins');
 assert.equal(r.capMap,false,'the cap is plain');assert.ok(r.capColor[0]>r.capColor[2]*1.5,'cap copy is reddish');
 r.door.color.forEach((v,k)=>assert.ok(Math.abs(v-r.door.expected[k])<1e-6,'arched door uses the door material, not the wall'));assert.equal(r.door.inset,'traced');assert.equal(r.door.map,false);
});
