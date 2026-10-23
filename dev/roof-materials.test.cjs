const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),THREE=require('../public/v1/node_modules/three');
const SCRIPTS='public/measure/internal/editor_scripts/';
function finishes(extra={}){const canvasContext=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>o[k]||(()=>{})});const ctx={THREE,ExteriorGeometry:K,WallSolidGeometry:W,document:{createElement:()=>({getContext:()=>canvasContext})},...extra};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(SCRIPTS+'exterior_finishes.js','utf8'),ctx);return ctx;}
const hex=/^#[0-9a-f]{6}$/;
test('roof presets are data: four categories, colors suited to each, charcoal shingles by default',()=>{
 const F=finishes().ExteriorFinishes,R=F.roofMaterials;
 assert.deepEqual(Object.keys(R),['shingles','shake','slate','metal']);
 assert.deepEqual(Object.values(R).map(r=>r.label),['Shingles','Shake','Slate','Standing seam metal']);
 for(const [id,spec]of Object.entries(R)){
  assert.ok(spec.colors.length>=3,id);assert.equal(new Set(spec.colors.map(c=>c.id)).size,spec.colors.length,id);
  for(const c of spec.colors){assert.match(c.color,hex,id+' '+c.id);assert.ok(c.label,id);}
  assert.ok(spec.tile.every(v=>v>.3&&v<2),id+' tile is metric');assert.ok(Number.isInteger(spec.courses),id);assert.ok(spec.roughness>0&&spec.roughness<=1&&spec.metalness>=0&&spec.metalness<=1,id);
 }
 const labels=id=>R[id].colors.map(c=>c.label);
 for(const [id,names]of [['shingles',['Charcoal','Weathered wood','Driftwood']],['slate',['Slate gray','Black','Purple']],['shake',['Natural cedar','Weathered']],['metal',['Charcoal','Galvalume','Barn red','Forest green']]])for(const name of names)assert.ok(labels(id).includes(name),id+' '+name);
 assert.equal(R.metal.metalness>R.shingles.metalness,true,'metal reads as metal');
 assert.deepEqual({...F.roofDefault},{category:'shingles',color:R.shingles.colors.find(c=>c.id==='charcoal').color});
 // Shingle exposure is the industry 5 5/8 in: four courses per tile.
 assert.ok(Math.abs(R.shingles.tile[1]/R.shingles.courses-.143)<.002);assert.ok(Math.abs(R.metal.tile[0]/2-.4064)<1e-9,'two 16 in panels per tile');
});
test('the roof setting resolves safely and drives the roof surface finish only',()=>{
 const ctx=finishes(),F=ctx.ExteriorFinishes,R=F.roofMaterials,plain=v=>JSON.parse(JSON.stringify(v));
 assert.deepEqual(plain(F.resolveRoof()),plain(F.roofDefault));assert.deepEqual(plain(F.resolveRoof({category:'bogus',color:'red'})),plain(F.roofDefault));
 assert.deepEqual(plain(F.resolveRoof({category:'slate'})),{category:'slate',color:R.slate.colors[0].color},'a category alone takes its own first color');
 assert.deepEqual(plain(F.resolveRoof({category:'metal',color:'#ABCDEF'})),{category:'metal',color:'#abcdef'},'custom colors are kept');
 const d={material:'siding',color:'#123456',trimColor:'#abcdef',roof:{category:'shake',color:'#998877'}};
 assert.deepEqual(plain(F.resolve({material:'shingles'},d)),{material:'shingles',category:'shake',color:'#998877'});
 assert.deepEqual(plain(F.resolve({material:'shingles',finishColor:'#010203'},d)),{material:'shingles',category:'shake',color:'#010203'},'a face color still overrides');
 assert.deepEqual(plain(F.resolve({material:'shingles'},{})),{material:'shingles',category:'shingles',color:F.roofDefault.color});
 assert.deepEqual(plain(F.resolve({},d)),{material:'siding',color:'#123456'},'walls never pick up the roof');
 assert.deepEqual(plain(F.resolve({material:'soffit'},d)),{material:'soffit',color:'#123456'});
});
test('roof meshes take the category map; maps are cached and walls keep their own',()=>{
 const ctx=finishes(),F=ctx.ExteriorFinishes,vector=p=>new THREE.Vector3(p.x,p.z,p.y),p=(x,y)=>({x,y,z:3+y/2}),face={points:[p(0,0),p(4,0),p(4,4),p(0,4)]};
 const maps={};for(const category of Object.keys(F.roofMaterials)){ctx.WallMode={finishDefaults:{roof:{category}}};const [top,under]=F.roofMeshes(face,vector,true),m=new THREE.MeshBasicMaterial(),u=new THREE.MeshBasicMaterial();F.apply(top,m);F.apply(under,u);assert.equal(m.map,F.roofTexture(category),category);assert.equal(m.map.userData.roofCategory,category);assert.equal(m.map.wrapS,THREE.RepeatWrapping);assert.notEqual(u.map,m.map,'the underside stays soffit');maps[category]=m.map;
  const expected=new THREE.Color(F.roofMaterials[category].colors[0].color).convertSRGBToLinear();assert.ok(m.color.r<=expected.r+1e-6&&m.color.r>=expected.r*.78-1e-6,'tinted by the roof color');}
 assert.equal(new Set(Object.values(maps)).size,4);assert.equal(F.roofTexture('slate'),maps.slate,'cached');assert.equal(F.roofTexture('nonsense'),maps.shingles,'unknown categories fall back to the default');
 const wall=new THREE.MeshBasicMaterial();F.apply({userData:{exteriorFinish:{material:'siding'}}},wall);assert.ok(!Object.values(maps).includes(wall.map));
});
// Cover: the textured image is used only on the first cover page and only for the bearing it was rendered at.
function pdfContext(){const context={ExteriorGeometry:K,document:{createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8Array(w*h*4)}),putImageData(){}}),toDataURL:()=>'data:image/png,diagram'})}};context.window=context;vm.createContext(context);vm.runInContext(fs.readFileSync(SCRIPTS+'exterior_pdf.js','utf8'),context);return context;}
function recorder(){const images=[],doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s],addImage:(...args)=>images.push(args)},{get:(o,k)=>k in o?o[k]:()=>{}});return {doc,images};}
function coverModel(bearing){const R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),model=R.build({faces:[{id:'w',points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],openings:[]}]});model.coverRender={image:'data:image/jpeg;base64,COVER',width:1800,height:1200,bearing,view:'front-35',version:1};return model;}
test('the first cover page draws the textured render; the summary and elevations stay line drawings',()=>{
 const ctx=pdfContext(),rect={x:20,y:40,w:170,h:150};
 let {doc,images}=recorder();ctx.drawExteriorCover(doc,coverModel(90),rect,{frontBearing:90});
 assert.equal(images.length,1);assert.equal(images[0][0],'data:image/jpeg;base64,COVER');assert.equal(images[0][1],'JPEG');
 const [, ,x,y,w,h]=images[0];assert.ok(Math.abs(w/h-1.5)<1e-9,'aspect kept');assert.ok(x>=rect.x-1e-9&&x+w<=rect.x+rect.w+1e-9&&y>=rect.y-1e-9&&y+h<=rect.y+rect.h-28+1e-9,'inside the drawing area above the orientation key');
 ({doc,images}=recorder());ctx.drawExteriorCover(doc,coverModel(90),rect,{frontBearing:180});assert.deepEqual(images.map(i=>i[0]),['data:image/png,diagram'],'a render for another front is never used');
 ({doc,images}=recorder());const plain=coverModel(0);delete plain.coverRender;ctx.drawExteriorCover(doc,plain,rect,{});assert.deepEqual(images.map(i=>i[0]),['data:image/png,diagram']);
 ({doc,images}=recorder());ctx.ExteriorPDF.drawExteriorSummaryPage(doc,coverModel(0),{},()=>{},{});assert.ok(images.length>0);assert.ok(images.every(i=>i[0]!=='data:image/jpeg;base64,COVER'),'Exterior Summary keeps its line drawing');
 ({doc,images}=recorder());ctx.drawExteriorReportPages(doc,coverModel(0),{},()=>{},{});assert.ok(images.length>=4,'every elevation draws a diagram');assert.ok(images.every(i=>i[0]!=='data:image/jpeg;base64,COVER'),'elevations keep their line drawings');
});
// Real canvas and WebGL: seeded maps tile seamlessly; the offscreen cover renders roof and walls with their textures.
test('procedural roof maps and the offscreen textured cover render in a real browser',async()=>{
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--use-angle=swiftshader']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<body></body>');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
  for(const name of ['vendor/clipper-lib-6.4.2-clipper','vendor/earcut-3.2.3-earcut.dev','exterior_geometry','wall_solid_geometry','wall_features','exterior_finishes','exterior_pdf','exterior_cover'])await page.addScriptTag({path:SCRIPTS+name+'.js'});
  const maps=await page.evaluate(()=>{
   const F=ExteriorFinishes,out={};
   for(const category of Object.keys(F.roofMaterials)){
    const a=F.roofCanvas(category),b=F.roofCanvas(category),c=a.getContext('2d'),W=a.width,H=a.height,data=c.getImageData(0,0,W,H).data,lum=(x,y)=>{const i=(y*W+x)*4;return (data[i]+data[i+1]+data[i+2])/3;};
    let edge=0,inner=0,sum=0;for(let y=0;y<H;y++){edge+=Math.abs(lum(W-1,y)-lum(0,y));inner+=Math.abs(lum(W/2,y)-lum(W/2-1,y));}for(let y=0;y<H;y++)for(let x=0;x<W;x++)sum+=lum(x,y);
    const normal=F.roofNormalMap(category);
    out[category]={same:a.toDataURL()===b.toDataURL(),ratio:H/W,tile:F.roofMaterials[category].tile[1]/F.roofMaterials[category].tile[0],edge:edge/H,inner:inner/H,mean:sum/W/H/255,normal:!!normal&&normal.image.width===W,gray:data[0]===data[1]&&data[1]===data[2]};
   }
   return out;
  });
  for(const [category,m]of Object.entries(maps)){assert.equal(m.same,true,category+' is seeded');assert.ok(Math.abs(m.ratio-m.tile)<.01,category+' keeps metric proportions');assert.ok(m.edge<=m.inner*2.5+4,category+' tiles across the eave seam: '+m.edge+' vs '+m.inner);assert.ok(m.mean>.45&&m.mean<.95,category+' neutral mean '+m.mean);assert.equal(m.normal,true);assert.equal(m.gray,true,category+' is neutral so the color tints it');}
  const cover=await page.evaluate(()=>{
   const vector=p=>new THREE.Vector3(p.x,p.z,-p.y),group=new THREE.Group(),p=(x,y,z)=>({x,y,z});
   const wall=(points,material)=>{const frame=WallSolidGeometry.faceFrame({points}),flat=points,tri=ExteriorGeometry.triangles(points.map(q=>WallSolidGeometry.inFrame(frame,q)),[]).triangles.flat().map(i=>flat[i]),g=new THREE.BufferGeometry().setFromPoints(tri.map(vector)),m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));m.userData.pickLayer='walls';ExteriorFinishes.prepare(m,{points,material},tri);group.add(m);};
   wall([p(0,0,0),p(8,0,0),p(8,0,3),p(0,0,3)],'siding');wall([p(8,0,0),p(8,6,0),p(8,6,3),p(8,3,4.5),p(8,0,3)],'siding');wall([p(8,6,0),p(0,6,0),p(0,6,3),p(8,6,3)],'siding');wall([p(0,6,0),p(0,0,0),p(0,0,3),p(0,3,4.5),p(0,6,3)],'siding');
   const roof={faces:[{points:[p(-.3,-.3,2.85),p(8.3,-.3,2.85),p(8.3,3,4.5),p(-.3,3,4.5)]},{points:[p(-.3,3,4.5),p(8.3,3,4.5),p(8.3,6.3,2.85),p(-.3,6.3,2.85)]}],points:[],connections:[]};
   window.WallMode={finishDefaults:{material:'siding',color:'#e8e4da',roof:{category:'shingles',color:ExteriorFinishes.roofDefault.color}},coverParts:()=>({group,roof,vector})};
   const stats=url=>new Promise(resolve=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data;let ink=0,sum=0,dark=0;for(let i=0;i<d.length;i+=4){const l=(d[i]+d[i+1]+d[i+2])/3;sum+=l;if(l<245)ink++;if(l<90)dark++;}resolve({w:img.width,h:img.height,ink:ink/(d.length/4),mean:sum/(d.length/4),dark:dark/(d.length/4)});};img.src=url;});
   const shingles=ExteriorCover.render({frontBearing:180});WallMode.finishDefaults.roof={category:'metal',color:'#b6babd'};const metal=ExteriorCover.render({frontBearing:180});
   delete WallMode.finishDefaults;const none=(()=>{const saved=WallMode.coverParts;WallMode.coverParts=()=>null;const r=ExteriorCover.render({});WallMode.coverParts=saved;return r;})();
   return Promise.all([stats(shingles.image),stats(metal.image)]).then(([a,b])=>({shingles:{...shingles,image:shingles.image.slice(0,23),length:shingles.image.length},a,b,none}));
  });
  assert.equal(cover.none,null,'no editor scene, no textured cover');
  assert.equal(cover.shingles.image,'data:image/jpeg;base64,');assert.equal(cover.shingles.bearing,180);assert.equal(Math.max(cover.shingles.width,cover.shingles.height),1400);assert.equal(cover.a.w,cover.shingles.width);
  assert.ok(cover.a.ink>.25,'the house fills the frame: '+cover.a.ink);assert.ok(cover.a.dark>.05,'charcoal roof reads dark: '+cover.a.dark);
  assert.ok(cover.b.mean>cover.a.mean+8,'galvalume metal is clearly lighter than charcoal shingles');assert.ok(cover.shingles.length<350000,'cover JPEG stays small: '+cover.shingles.length);
  assert.equal(errors.length,0,errors.join('\n'));
 }finally{await browser.close();}
});
test('the Wall materials picker sets the roof category, a preset color for it, or a custom color',async()=>{
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setContent('<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:900px"></div></body>');
  await page.addScriptTag({content:'window.THREE={}'});for(const name of ['wall_features','exterior_finishes'])await page.addScriptTag({path:SCRIPTS+name+'.js'});
  await page.evaluate(()=>{window.roof={...ExteriorFinishes.roofDefault};window.calls=0;WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:v=>v||{material:'siding',color:'#123456',trimColor:'#abcdef'},roof:v=>{if(v){calls++;window.roof={...v};}return window.roof;}});});
  await page.getByRole('button',{name:'Wall materials',exact:true}).click();await page.getByRole('button',{name:/^Roof/}).click();
  const group=page.getByRole('group',{name:'Roof material type',exact:true}),colors=page.getByRole('group',{name:'Roof colors',exact:true});
  assert.deepEqual(await group.getByRole('button').allTextContents(),['Shingles','Shake','Slate','Standing seam metal']);
  assert.equal(await group.getByRole('button',{name:'Shingles'}).getAttribute('aria-pressed'),'true');assert.equal(await colors.getByRole('button',{name:'Charcoal'}).getAttribute('aria-pressed'),'true');
  await group.getByRole('button',{name:'Slate'}).click();assert.deepEqual(await page.evaluate(()=>roof),{category:'slate',color:'#626970'});
  assert.deepEqual(await colors.getByRole('button').evaluateAll(b=>b.map(x=>x.getAttribute('aria-label'))),['Slate gray','Black','Purple','Green'],'colors follow the category');
  await colors.getByRole('button',{name:'Purple'}).click();assert.deepEqual(await page.evaluate(()=>roof),{category:'slate',color:'#5e4f5d'});assert.equal(await colors.getByRole('button',{name:'Purple'}).getAttribute('aria-pressed'),'true');
  await page.getByLabel('Custom roof color',{exact:true}).fill('#445566');assert.deepEqual(await page.evaluate(()=>roof),{category:'slate',color:'#445566'});assert.equal(await colors.locator('[aria-pressed=true]').count(),0,'a custom color selects no preset');
  await group.getByRole('button',{name:'Standing seam metal'}).click();assert.equal(await page.evaluate(()=>roof.category),'metal');assert.ok((await colors.getByRole('button').allInnerTexts()).length>=4);
  assert.equal(await page.getByLabel('Default color',{exact:true}).isVisible(),true,'wall defaults remain');
 }finally{await browser.close();}
});
