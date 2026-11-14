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
