const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const SCRIPTS='public/measure/internal/editor_scripts/',R=require('../'+SCRIPTS+'exterior_report_model.js');
const rect=(x0,z0,x1,z1)=>[{x:x0,y:0,z:z0},{x:x1,y:0,z:z0},{x:x1,y:0,z:z1},{x:x0,y:0,z:z1}];
function materials(){const ctx={console};ctx.window=ctx;vm.createContext(ctx);for(const name of ['wall_solid_geometry','wall_features'])vm.runInContext(fs.readFileSync(SCRIPTS+name+'.js','utf8'),ctx);return ctx.ExteriorMaterials;}

// FM-325: concrete walls were marked as stucco because the editor had no concrete finish.
test('concrete is an editor wall material and the report names it Concrete',()=>{
 const M=materials();assert.deepEqual({label:M.concrete?.label,color:M.concrete?.color},{label:'Concrete',color:'#9fa4a6'});
 const m=R.build({faces:[{points:rect(0,0,4,2),material:'concrete'},{points:rect(0,2,4,4),material:'stucco'}]});
 assert.deepEqual(m.walls.map(w=>w.material),['Concrete','Stucco']);
});
test('every material a face can be painted with keeps its own label in the report',()=>{
 // A material missing from the report model's label map is published as Unassigned and lost downstream.
 for(const [id,def] of Object.entries(materials())){if(['default','unassigned','chimney-top'].includes(id))continue;
  assert.deepEqual(R.build({faces:[{points:rect(0,0,4,2),material:id}]}).walls.map(w=>w.material),[def.label],id);}
});
const chromiumPath=(()=>{const {chromium}=require('../public/v1/node_modules/playwright-core');return [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()].find(p=>p&&fs.existsSync(p))||null;})();
test('the wall material picker offers Concrete for faces and as the default texture',{skip:!chromiumPath&&'no Chromium on this host'},async t=>{
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:chromiumPath,args:['--no-sandbox']});t.after(()=>browser.close());
 const page=await browser.newPage();await page.setContent('<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:900px"></div></body>');
 await page.addScriptTag({path:SCRIPTS+'wall_features.js'});
 await page.evaluate(()=>{window.painted=[];window.defaults={material:'siding',color:'#123456',trimColor:'#abcdef'};WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:value=>value?(window.defaults=value):window.defaults,paint:id=>painted.push(id)});});
 await page.getByRole('button',{name:'Wall materials',exact:true}).click();
 await page.getByRole('group',{name:'Face materials'}).getByRole('button',{name:'Concrete',exact:true}).click();assert.deepEqual(await page.evaluate(()=>painted),['concrete']);
 await page.getByRole('button',{name:'Default texture',exact:true}).click();await page.getByRole('menuitemradio',{name:'Concrete',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>defaults),{material:'concrete',color:'#123456',trimColor:'#abcdef'});
});

// FM-528: cedar shake siding is a wall material of its own, with a shake texture the wall colour stains.
test('cedar shake is an editor wall material, named Cedar shake in the report and trimmed like siding',()=>{
 const M=materials();assert.deepEqual({label:M['cedar-shake']?.label,color:M['cedar-shake']?.color},{label:'Cedar shake',color:'#b08a64'});
 assert.deepEqual(R.build({faces:[{points:rect(0,0,4,2),material:'cedar-shake'}]}).walls.map(w=>w.material),['Cedar shake']);
 assert.equal(require('../'+SCRIPTS+'wall_trim.js').defaultMaterial('cedar-shake'),true,'corner trim by default, like siding');
 const ctx={THREE:{}};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync(SCRIPTS+'exterior_finishes.js','utf8'),ctx);const F=ctx.ExteriorFinishes;
 assert.deepEqual([...F.wallTiles['cedar-shake'].size],[1.2192,.7112],'one tile is 4 ft by four 7 in courses');
 assert.deepEqual(JSON.parse(JSON.stringify(F.resolve({material:'cedar-shake'},{material:'siding',color:'#a8784e'}))),{material:'cedar-shake',color:'#a8784e'});
 assert.deepEqual(JSON.parse(JSON.stringify(F.resolve({},{material:'cedar-shake',color:'#123456'}))),{material:'cedar-shake',color:'#123456'},'the default texture');
});
test('the wall material picker offers Cedar shake and both textured modes draw its shake map',{skip:!chromiumPath&&'no Chromium on this host'},async t=>{
 const {chromium}=require('../public/v1/node_modules/playwright-core'),path=require('node:path');
 const browser=await chromium.launch({headless:true,executablePath:chromiumPath,args:['--no-sandbox','--use-angle=swiftshader']});t.after(()=>browser.close());
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://walls.test/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:900px"></div></body>'});await route.fulfill({path:path.resolve('public/measure/internal',u.pathname.slice(1))});});
 await page.goto('http://walls.test/');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
 for(const name of ['vendor/clipper-lib-6.4.2-clipper','exterior_geometry','wall_solid_geometry','wall_features','exterior_finishes','exterior_scene_cache','exterior_rendered'])await page.addScriptTag({url:'http://walls.test/editor_scripts/'+name+'.js'});
 await page.evaluate(()=>{window.painted=[];window.defaults={material:'siding',color:'#123456',trimColor:'#abcdef'};WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:value=>value?(window.defaults=value):window.defaults,paint:id=>painted.push(id)});});
 await page.getByRole('button',{name:'Wall materials',exact:true}).click();
 await page.getByRole('group',{name:'Face materials'}).getByRole('button',{name:'Cedar shake',exact:true}).click();assert.deepEqual(await page.evaluate(()=>painted),['cedar-shake']);
 await page.getByRole('button',{name:'Default texture',exact:true}).click();await page.getByRole('menuitemradio',{name:'Cedar shake',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>defaults),{material:'cedar-shake',color:'#123456',trimColor:'#abcdef'});
 const r=await page.evaluate(()=>{
  const F=ExteriorFinishes,own=F.wallTexture('cedar-shake'),plain=new THREE.MeshBasicMaterial();F.apply({userData:{exteriorFinish:{material:'cedar-shake',finishColor:'#a8784e'}}},plain);
  const rendered=ExteriorRendered.materialFor({material:'cedar-shake',finishColor:'#a8784e'},false),canvas=F.wallCanvas('cedar-shake'),d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  // Keyways: dark runs along one row in the middle of the first course.
  let keyways=0,dark=false;const y=Math.round(canvas.height/8);for(let x=0;x<canvas.width;x++){const now=d[(y*canvas.width+x)*4]<90;if(now&&!dark)keyways++;dark=now;}
  return {plainIsShake:plain.map===own,renderedIsShake:rendered.map===own,normal:!!rendered.normalMap,repeat:own.repeat.toArray(),keyways,seeded:canvas.toDataURL()===F.wallCanvas('cedar-shake').toDataURL()};
 });
 const {keyways,...maps}=r;assert.deepEqual(maps,{plainIsShake:true,renderedIsShake:true,normal:true,repeat:[.5,.6096/.7112],seeded:true});
 assert.ok(keyways>=5&&keyways<=16,'3-10 in shakes: 5-16 keyways per 4 ft course, got '+keyways);
 assert.equal(errors.length,0,errors.join('\n'));
});
