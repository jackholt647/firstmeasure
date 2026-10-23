const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const K=require('../public/measure/internal/editor_scripts/exterior_geometry.js'),W=require('../public/measure/internal/editor_scripts/wall_solid_geometry.js'),WF=require('../public/measure/internal/editor_scripts/wall_features.js'),THREE=require('../public/v1/node_modules/three');
const SCRIPTS='public/measure/internal/editor_scripts/',plain=v=>JSON.parse(JSON.stringify(v));
function context(){const canvasContext=new Proxy({createLinearGradient:()=>({addColorStop(){}})},{get:(o,k)=>o[k]||(()=>{})});const ctx={THREE,ExteriorGeometry:K,WallSolidGeometry:W,WallFeatures:WF,URL,location:{href:'http://test/'},document:{currentScript:null,createElement:()=>({getContext:()=>canvasContext})}};ctx.window=ctx;vm.createContext(ctx);for(const name of ['exterior_finishes','exterior_rendered'])vm.runInContext(fs.readFileSync(SCRIPTS+name+'.js','utf8'),ctx);return ctx;}

test('sticker defaults resolve per piece, seeded from the trim colour and the door finishes',()=>{
 const F=context().ExteriorFinishes,D=F.doorFinishes;
 assert.deepEqual(plain(F.stickerPieces.map(p=>p.id)),['doorTrim','doorMain','windowTrim','garageTrim','garageMain','untypedTrim','untypedMain']);
 assert.ok(!F.stickerPieces.some(p=>p.kind==='window'&&p.part==='main'),'windows have no main colour');
 assert.deepEqual(plain(F.stickerDefaults({})),{doorTrim:'#f5f3ef',doorMain:D.door.color,windowTrim:'#f5f3ef',garageTrim:'#f5f3ef',garageMain:D.garage.color,untypedTrim:'#f5f3ef',untypedMain:'#deddd6'});
 const s={trimColor:'#112233',stickers:{doorMain:'#AA0000',windowTrim:'#00ff00',garageTrim:'bad'}};
 assert.deepEqual(plain(F.stickerDefaults(s)),{doorTrim:'#112233',doorMain:'#aa0000',windowTrim:'#00ff00',garageTrim:'#112233',garageMain:D.garage.color,untypedTrim:'#112233',untypedMain:'#deddd6'});
 assert.equal(F.stickerColor('door','main',s),'#aa0000');assert.equal(F.stickerColor('skylight','trim',s),'#00ff00');assert.equal(F.stickerColor('window','main',s),null);assert.equal(F.stickerColor('vent','trim',s),null);assert.equal(F.stickerColor(undefined,'trim',s),'#112233');assert.equal(F.stickerColor('panel','main',s),'#deddd6','unknown types are untyped');
 // Trim faces: the trim default unless the sticker has its own colour; trims saved with the old fixed white use the default.
 const settings={stickers:{garageTrim:'#123456'}},resolveTrim=face=>F.resolve(F_finish(F,face),settings).color;
 const pts=[{x:0,y:0,z:0},{x:2.4,y:0,z:0},{x:2.4,y:0,z:2.1},{x:0,y:0,z:2.1}];
 const legacy=WF.trimFaces(pts,{type:'garage',axis:{x:1,y:0,z:0},trim:{width:.1,color:'#f5f3ef'}})[0],own=WF.trimFaces(pts,{type:'garage',axis:{x:1,y:0,z:0},trim:{width:.1,color:'#ABCDEF'}})[0],fresh=WF.trimFaces(pts,WF.setTrim({type:'garage',axis:{x:1,y:0,z:0}},4))[0];
 assert.equal(WF.setTrim({type:'door'},2).trim.color,undefined,'placing a trim no longer bakes a colour');assert.equal(WF.setTrim({type:'door'},2,'#abcdef').trim.color,'#abcdef');
 assert.equal(resolveTrim(legacy),'#123456');assert.equal(resolveTrim(fresh),'#123456');assert.equal(resolveTrim(own),'#abcdef');
 assert.equal(F.resolve({material:'opening-trim',trim:true},{trimColor:'#999999'}).color,'#999999','wall opening trim without a sticker keeps the wall trim colour');
});
function F_finish(F,face){const mesh={userData:{},geometry:{setAttribute(){}}};F.prepare(mesh,{...face,openingTrim:true},face.points);return mesh.userData.exteriorFinish;}

test('sticker trim stands proud of the wall as a slab, and takes a painted sheen in its default colour',()=>{
 const ctx=context(),F=ctx.ExteriorFinishes,R=ctx.ExteriorRendered,vector=p=>new THREE.Vector3(p.x,p.z,-p.y);
 ctx.WallMode={finishDefaults:{stickers:{doorTrim:'#334455'}}};
 // An arched door on the wall plane y=0, with trim.
 const arch=[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:0,z:1.9}];for(let i=1;i<16;i++){const a=i/16*Math.PI;arch.push({x:.5+.5*Math.cos(a),y:0,z:1.9+.5*Math.sin(a)});}arch.push({x:0,y:0,z:1.9});
 const faces=WF.trimFaces(arch,WF.setTrim({type:'door',axis:{x:1,y:0,z:0}},4));assert.ok(faces.length>10);
 const scene=new THREE.Scene(),renderContext={vector,center:new THREE.Vector3(.5,1,5)};
 for(const f of faces){
  const fr=W.faceFrame(f),g=new THREE.BufferGeometry().setFromPoints(f.points.map(vector));g.setIndex(K.triangles(f.points.map(p=>W.inFrame(fr,p)),[]).triangles.flat());
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));F.prepare(mesh,{...f,openingTrim:true},f.points);mesh.updateMatrixWorld(true);
  const copy=R.presentationCopy(mesh,renderContext,scene),pos=copy.geometry.attributes.position;let lo=Infinity,hi=-Infinity;for(let i=0;i<pos.count;i++){const y=-pos.getZ(i);lo=Math.min(lo,y);hi=Math.max(hi,y);}
  assert.ok(hi>=R.TRIM_PROUD-1e-9&&lo<=-R.TRIM_PROUD+1e-9,'trim face stands '+R.TRIM_PROUD+' m off the wall on either side: '+lo+'..'+hi);assert.ok(hi<=.03&&lo>=-.03);
  assert.equal(copy.material.type,'MeshPhysicalMaterial');assert.ok(copy.material.clearcoat>0&&copy.material.roughness<.6,'satin sheen, not flat');assert.equal(copy.material.color.getHexString(),new THREE.Color('#334455').convertSRGBToLinear().getHexString());
  assert.equal(copy.material.polygonOffset,true);
 }
 const slab=R.trimSlab(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(1,0,0),new THREE.Vector3(1,1,0)]),.02),z=[...slab.attributes.position.array].filter((_,i)=>i%3===2);
 assert.ok(Math.abs(Math.min(...z)+.02)<1e-6&&Math.abs(Math.max(...z)-.02)<1e-6);assert.equal(slab.attributes.position.count,6+3*6,'two faces and three side walls');
});

test('the Window trim default colours window frames and window trims that have no colour of their own',()=>{
 const ctx=context(),F=ctx.ExteriorFinishes,R=ctx.ExteriorRendered,vector=p=>new THREE.Vector3(p.x,p.z,-p.y),brown='#6b4a2f',linear=c=>new THREE.Color(c).convertSRGBToLinear().getHexString();
 ctx.WallMode={finishDefaults:{trimColor:'#ffffff',stickers:{windowTrim:brown}}};
 const win=[{x:1,y:0,z:1},{x:2,y:0,z:1},{x:2,y:0,z:2.2},{x:1,y:0,z:2.2}],feature={type:'window',axis:{x:1,y:0,z:0}};
 const frame=W.faceFrame({points:win}),g=new THREE.BufferGeometry().setFromPoints(win.map(vector));g.setIndex(K.triangles(win.map(p=>W.inFrame(frame,p)),[]).triangles.flat());
 const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial());mesh.userData.exteriorFeature=true;F.prepare(mesh,{points:win,feature},win);mesh.updateMatrixWorld(true);
 // Textured: the window unit's frame and sill.
 const scene=new THREE.Scene();R.presentationCopy(mesh,{vector,center:new THREE.Vector3(1.5,1.5,5)},scene);const colours=new Set();scene.traverse(o=>{if(o.isMesh&&o.geometry.type==='ExtrudeGeometry')colours.add(o.material.color.getHexString());});
 assert.ok(colours.has(linear(brown)),'window frame takes Window trim: '+[...colours]);
 // A window with its own colour keeps it.
 const own=mesh.clone();own.userData={...mesh.userData,renderedOpening:{...mesh.userData.renderedOpening,color:'#225588'}};const s2=new THREE.Scene();R.presentationCopy(own,{vector,center:new THREE.Vector3(1.5,1.5,5)},s2);const c2=new Set();s2.traverse(o=>{if(o.isMesh&&o.geometry.type==='ExtrudeGeometry')c2.add(o.material.color.getHexString());});assert.ok(c2.has(linear('#225588'))&&!c2.has(linear(brown)));
 // Match textured: the opening map is painted with the Window trim default.
 const m1=new THREE.MeshBasicMaterial();F.apply(mesh,m1);ctx.WallMode.finishDefaults={...ctx.WallMode.finishDefaults,stickers:{windowTrim:'#123456'}};const m2=new THREE.MeshBasicMaterial();F.apply(mesh,m2);assert.notEqual(m1.map,m2.map,'the plain-texture window map follows Window trim');
 // Trims placed while the wall trim colour was #ffffff carry it; they still follow Window trim.
 ctx.WallMode.finishDefaults={trimColor:'#ffffff',stickers:{windowTrim:brown}};ctx.WallFeatures=WF;
 globalThis.WallMode=ctx.WallMode;let baked;try{baked=WF.trimFaces(win,{...feature,trim:{width:.05,color:'#ffffff'}});}finally{delete globalThis.WallMode;}assert.equal(baked[0].trimOwnColor,null);assert.equal(F.resolve(F_finish(F,baked[0]),ctx.WallMode.finishDefaults).color,brown);
 assert.equal(F.stickerTrimOwnColor({color:'#FFFFFF'}),null);assert.equal(F.stickerTrimOwnColor({color:'#abcdef'}),'#abcdef');
});

test('Stickers defaults: collapsed Trim and Main fan out, pieces expand, and mixed shows when pieces differ',async()=>{
 const {chromium}=require('../public/v1/node_modules/playwright-core');
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.setContent('<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><div id="three-view-wrapper" style="position:relative;height:1100px"></div></body>');
  await page.addScriptTag({content:'window.THREE={}'});for(const name of ['wall_features','exterior_finishes'])await page.addScriptTag({path:SCRIPTS+name+'.js'});
  await page.evaluate(()=>{window.saved={};window.calls=[];WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:v=>v||{material:'siding',color:'#123456',trimColor:'#abcdef'},roof:v=>v||{...ExteriorFinishes.roofDefault},stickers:v=>{if(v){calls.push(v);Object.assign(saved,v);}return ExteriorFinishes.stickerDefaults({trimColor:'#abcdef',stickers:saved});}});});
  await page.getByRole('button',{name:'Wall materials',exact:true}).click();await page.getByRole('button',{name:/^Stickers/}).click();
  const panel=page.getByRole('group',{name:'Sticker defaults',exact:true}),trim=panel.getByLabel('Sticker trim',{exact:true}),main=panel.getByLabel('Sticker main',{exact:true}),expand=panel.getByRole('button',{name:/Each piece/});
  assert.equal(await trim.inputValue(),'#abcdef','trim seeds from the trim colour');assert.equal(await panel.locator('[data-mixed="main"]').isVisible(),true,'door and garage seeds differ, so main is mixed');
  assert.equal(await page.getByRole('group',{name:'Sticker pieces'}).isVisible(),false);
  await trim.fill('#224466');assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{doorTrim:'#224466',windowTrim:'#224466',garageTrim:'#224466',untypedTrim:'#224466'},'collapsed Trim sets every sticker trim');
  await main.fill('#663322');assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{doorMain:'#663322',garageMain:'#663322',untypedMain:'#663322'},'collapsed Main sets every main, windows have none');
  assert.equal(await panel.locator('[data-mixed="main"]').isVisible(),false);
  await expand.click();assert.equal(await expand.getAttribute('aria-expanded'),'true');const pieces=page.getByRole('group',{name:'Sticker pieces'});
  assert.deepEqual(await pieces.locator('input').evaluateAll(list=>list.map(i=>i.getAttribute('aria-label'))),['Door trim','Door colour','Window trim','Garage door trim','Garage door colour','Untyped trim','Untyped main']);
  assert.equal(await pieces.getByLabel('Garage door colour',{exact:true}).inputValue(),'#663322');
  await pieces.getByLabel('Window trim',{exact:true}).fill('#ffffff');assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{windowTrim:'#ffffff'});
  assert.equal(await panel.locator('[data-mixed="trim"]').isVisible(),true,'one trim differs: mixed');assert.equal(await panel.locator('[data-mixed="main"]').isVisible(),false);
  await trim.fill('#101010');assert.equal(await panel.locator('[data-mixed="trim"]').isVisible(),false,'collapsed Trim overwrites every trim piece');assert.equal(await pieces.getByLabel('Window trim',{exact:true}).inputValue(),'#101010');
  if(process.env.STICKER_UI_SHOTS){await expand.click();await page.locator('#wall-material-picker').screenshot({path:process.env.STICKER_UI_SHOTS+'/stickers-collapsed.png'});await expand.click();await page.locator('#wall-material-picker').screenshot({path:process.env.STICKER_UI_SHOTS+'/stickers-expanded.png'});}
 }finally{await browser.close();}
});
