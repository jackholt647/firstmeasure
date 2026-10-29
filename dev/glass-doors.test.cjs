const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),WF=require('../public/measure/internal/editor_scripts/wall_features.js'),R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),THREE=require('../public/v1/node_modules/three');
const SCRIPTS='public/measure/internal/editor_scripts/';
function context(){const canvasContext=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>o[k]||(()=>{})});const ctx={THREE,ExteriorGeometry:K,WallSolidGeometry:W,WallFeatures:WF,URL,location:{href:'http://test/'},document:{currentScript:null,createElement:()=>({getContext:()=>canvasContext})}};ctx.window=ctx;vm.createContext(ctx);for(const name of ['exterior_finishes','exterior_rendered'])vm.runInContext(fs.readFileSync(SCRIPTS+name+'.js','utf8'),ctx);return ctx;}
const door=[{x:1,y:0,z:0},{x:1.9,y:0,z:0},{x:1.9,y:0,z:2.03},{x:1,y:0,z:2.03}],axis={x:1,y:0,z:0};
function mesh(points,feature){const fr=W.faceFrame({points}),g=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(p.x,p.z,-p.y)));g.setIndex(K.triangles(points.map(p=>W.inFrame(fr,p)),[]).triangles.flat());const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial());m.userData.exteriorFeature=true;return m;}

test('glass is an opt-in material for doors and garage doors only; windows have no choice',()=>{
 assert.deepEqual(WF.glassTypes,['door','garage']);
 for(const type of ['door','garage']){const f={type,axis};assert.equal(WF.isGlass(f),false,'off by default');const on=WF.setGlass(f,true);assert.equal(on.glass,true);assert.equal(WF.isGlass(on),true);assert.equal(f.glass,undefined,'setGlass does not mutate');const off=WF.setGlass(on,false);assert.equal('glass' in off,false,'off is stored as absent');}
 for(const type of ['window','vent',undefined]){const f={type};assert.equal(WF.setGlass(f,true),f,'no glass option for '+type);assert.equal(WF.isGlass({type,glass:true}),false);}
 assert.equal(WF.isGlass(null),false);
 // A glass flag survives copy and transform with the rest of the sticker metadata.
 const clip=W.copyGeometry([{id:'d',points:door,feature:WF.setGlass({type:'door',axis},true)}],door),moved=W.transformGeometry(clip,0,{angle:Math.PI/3});assert.equal(moved.faces[0].feature.glass,true);
});

test('textured mode paints a glass door with its own opening map; the default door is unchanged',()=>{
 const ctx=context(),F=ctx.ExteriorFinishes;
 for(const type of ['door','garage']){
  const plain=mesh(door),glass=mesh(door);F.prepare(plain,{points:door,feature:{type,axis}},door);F.prepare(glass,{points:door,feature:{type,axis,glass:true}},door);
  assert.equal(plain.userData.exteriorFinish.glass,undefined);assert.equal(glass.userData.exteriorFinish.glass,true);
  const a=new THREE.MeshBasicMaterial(),b=new THREE.MeshBasicMaterial(),c=new THREE.MeshBasicMaterial();F.apply(plain,a);F.apply(glass,b);F.apply(plain,c);
  assert.ok(a.map&&b.map);assert.notEqual(a.map,b.map,type+': glass has its own map');assert.equal(a.map,c.map,type+': the default map is shared as before');
 }
 // A window flagged glass by a type change keeps the plain window map.
 const win=mesh(door),flagged=mesh(door);F.prepare(win,{points:door,feature:{type:'window',axis}},door);F.prepare(flagged,{points:door,feature:{type:'window',axis,glass:true}},door);const m1=new THREE.MeshBasicMaterial(),m2=new THREE.MeshBasicMaterial();F.apply(win,m1);F.apply(flagged,m2);assert.equal(m1.map,m2.map);
});

test('rendered mode draws a glass door as glass and a default door in the door material',()=>{
 const ctx=context(),F=ctx.ExteriorFinishes,Rd=ctx.ExteriorRendered,render={vector:p=>new THREE.Vector3(p.x,p.z,-p.y),center:new THREE.Vector3(1.5,1,5)};
 for(const type of ['door','garage']){
  const plain=mesh(door),glass=mesh(door);F.prepare(plain,{points:door,feature:{type,axis}},door);F.prepare(glass,{points:door,feature:{type,axis,glass:true}},door);plain.updateMatrixWorld(true);glass.updateMatrixWorld(true);
  const p=Rd.presentationCopy(plain,render,new THREE.Scene()),g=Rd.presentationCopy(glass,render,new THREE.Scene());
  assert.equal(p.material.type,'MeshStandardMaterial',type+' default material');assert.equal(p.material.transparent,false);
  assert.equal(g.material.type,'MeshPhysicalMaterial',type+' glass');assert.ok(g.material.transparent&&g.material.opacity<1&&g.material.transmission>0);assert.equal(g.material.normalMap,null,'no door panel grooves on glass');
 }
});

test('the report model and opening schedule carry glass doors; other openings are unchanged',()=>{
 const p=(x,z)=>({x,y:0,z}),wall={points:[p(-1,-1),p(6,-1),p(6,4),p(-1,4)]},rect=(l,r,t)=>[p(l,-1),p(r,-1),p(r,t),p(l,t)];
 const model=R.build({faces:[wall,{points:rect(0,1,1.03),feature:{type:'door',axis,glass:true}},{points:rect(1.5,2.5,1.03),feature:{type:'door',axis}},{points:rect(3,5.4,1.13),feature:{type:'garage',axis,glass:true}},{points:[p(5.5,1),p(5.9,1),p(5.9,2),p(5.5,2)],feature:{type:'window',axis,glass:true}}],base:{faces:[]}});
 const byLeft=[...model.openings].sort((a,b)=>Math.min(...a.points.map(q=>q.x))-Math.min(...b.points.map(q=>q.x)));
 assert.deepEqual(byLeft.map(o=>[o.type,o.label,o.glass===true]),[['door','Door',true],['door','Door',false],['garage','Garage door',true],['window','Window',false]]);
 assert.equal('glass' in byLeft[1],false,'a default door has no glass key');
 const pdf=fs.readFileSync(SCRIPTS+'exterior_pdf.js','utf8');assert.match(pdf,/reportText\(o\.label\)\+\(o\.glass\?', '\+reportText\('glass'\):''\)/,'the opening schedule names glass doors');
});

test('Face type panel: a Glass switch for a selected door or garage door only, off until turned on',async()=>{
 // Off Windows the regression server links the Chrome path above to its own Chromium.
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'].find(p=>fs.existsSync(p))||chromium.executablePath(),args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setContent('<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:900px"></div></body>');
  for(const name of ['exterior_geometry','wall_solid_geometry'])await page.addScriptTag({path:SCRIPTS+name+'.js'});await page.addScriptTag({path:SCRIPTS+'wall_features.js'});
  await page.evaluate(()=>{const points=[{x:0,y:0,z:0},{x:.9,y:0,z:0},{x:.9,y:0,z:2},{x:0,y:0,z:2}];window.current={points,feature:{type:'window',axis:{x:1,y:0,z:0}}};window.calls=[];
   WallFeatures.mountUI(()=>{},()=>window.current,()=>false,{glass(on){calls.push(on);if(window.refuse)return false;current={...current,feature:WallFeatures.setGlass(current.feature,on)};return true;}});});
  await page.getByRole('button',{name:'Face type',exact:true}).click();
  const glass=page.getByRole('checkbox',{name:'Glass door'});
  assert.equal(await glass.isVisible(),false,'windows are always glass: no switch');
  await page.evaluate(()=>{current={...current,feature:{type:'door',axis:{x:1,y:0,z:0}}};WallFeatures.refreshUI();});
  assert.equal(await glass.isVisible(),true);assert.equal(await glass.isChecked(),false,'off by default');
  await glass.check();assert.deepEqual(await page.evaluate(()=>calls),[true]);assert.equal(await page.evaluate(()=>current.feature.glass),true);
  assert.match(await page.locator('#wall-face-options p').textContent(),/^Door · Glass · /);
  await glass.uncheck();assert.deepEqual(await page.evaluate(()=>calls),[true,false]);assert.equal(await page.evaluate(()=>'glass' in current.feature),false);
  await page.evaluate(()=>{current={...current,feature:{type:'garage',axis:{x:1,y:0,z:0},glass:true}};WallFeatures.refreshUI();});assert.equal(await glass.isChecked(),true,'reflects a saved glass garage door');
  // A refused change (busy editor, failed transaction) leaves the switch as the door is.
  await page.evaluate(()=>{window.refuse=true;current={...current,feature:{type:'door',axis:{x:1,y:0,z:0}}};WallFeatures.refreshUI();});
  await glass.click();assert.equal(await glass.isChecked(),false);assert.equal(await page.evaluate(()=>'glass' in current.feature),false);
 }finally{await browser.close();}
});
