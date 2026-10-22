const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const SCRIPTS='public/measure/internal/editor_scripts/';
async function browser(t){const {chromium}=require('../public/v1/node_modules/playwright-core');const b=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--use-angle=swiftshader']});t.after(()=>b.close());return b;}

test('brick, stone and masonry resolve to distinct maps at real-world scale, in Textured and plain textured modes',async t=>{
 const page=await (await browser(t)).newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://walls.test/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<body></body>'});await route.fulfill({path:path.resolve('public/measure/internal',u.pathname.slice(1))});});
 await page.goto('http://walls.test/');await page.addScriptTag({path:'public/v1/node_modules/three/build/three.min.js'});
 for(const name of ['vendor/clipper-lib-6.4.2-clipper','exterior_geometry','wall_solid_geometry','wall_features','exterior_finishes','exterior_scene_cache','exterior_rendered'])await page.addScriptTag({url:'http://walls.test/editor_scripts/'+name+'.js'});
 const r=await page.evaluate(()=>{
  const F=ExteriorFinishes,R=ExteriorRendered,types=['brick','stone','masonry'],stats=canvas=>{const d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let n=0,s=[0,0,0],q=0;for(let i=0;i<d.length;i+=16){for(let k=0;k<3;k++)s[k]+=d[i+k];q+=d[i]*d[i];n++;}const mean=s.map(v=>v/n);return {mean,sd:Math.sqrt(q/n-mean[0]*mean[0])};};
  const pbr=Object.fromEntries(types.map(type=>{const m=R.materialFor({material:type},false);return [type,{map:m.map,normal:m.normalMap,repeat:m.map?.repeat?.toArray()}];}));
  const plain=Object.fromEntries(types.map(type=>{const m=new THREE.MeshBasicMaterial();F.apply({userData:{exteriorFinish:{material:type}}},m);return [type,m.map];}));
  // CMU joints: count vertical mortar joints along one course; 4 ft of tile at 16 in per block gives 3.
  const cmu=F.wallCanvas('masonry'),d=cmu.getContext('2d').getImageData(0,Math.round(cmu.height/6),cmu.width,1).data;let joints=0,inJoint=false;for(let x=0;x<cmu.width;x++){const dark=d[x*4]<=130&&d[x*4+4]<=130;if(dark&&!inJoint)joints++;inJoint=dark;}
  const means=Object.fromEntries(types.map(type=>[type,R.averageFinishColor({material:type}).toArray()]));
  return {distinctPbr:new Set(types.map(t=>pbr[t].map)).size,distinctPlain:new Set(types.map(t=>plain[t])).size,brickIsPhoto:!!pbr.brick.map&&!pbr.brick.map.isCanvasTexture&&pbr.brick.map!==F.wallTexture('stone'),stone:{...pbr.stone,map:!!pbr.stone.map,normal:!!pbr.stone.normal},masonry:{...pbr.masonry,map:!!pbr.masonry.map,normal:!!pbr.masonry.normal},stoneStats:stats(F.wallCanvas('stone')),masonryStats:stats(cmu),joints,size:{stone:[F.wallCanvas('stone').width,F.wallCanvas('stone').height],masonry:[cmu.width,cmu.height]},same:F.wallCanvas('stone').toDataURL()===F.wallCanvas('stone').toDataURL(),means,meanCheck:F.wallTextureMean('stone').linear};
 });
 assert.equal(r.distinctPbr,3,'Textured: three different maps');assert.equal(r.distinctPlain,3,'plain textured: three different maps');assert.equal(r.brickIsPhoto,true,'brick keeps its photo');
 assert.deepEqual(r.stone.repeat,[.5,.5],'stone tile is 4 x 4 ft');assert.deepEqual(r.masonry.repeat,[.5,1],'masonry tile is 4 x 2 ft');assert.equal(r.stone.normal&&r.masonry.normal,true);
 assert.equal(r.joints,3,'16 in CMU blocks: three per 4 ft course');assert.ok(Math.abs(r.size.masonry[0]/r.size.masonry[1]-2)<.01);assert.equal(r.same,true,'seeded');
 assert.ok(r.stoneStats.sd>r.masonryStats.sd,'fieldstone varies more than block');
 assert.ok(Math.abs(r.means.stone[0]-r.means.brick[0])>.02&&Math.abs(r.means.masonry[0]-r.means.brick[0])>.02&&Math.abs(r.means.masonry[0]-r.means.stone[0])>.02,'chimney caps average to three different colours: '+JSON.stringify(r.means));
 r.means.stone.forEach((v,k)=>assert.ok(Math.abs(v-r.meanCheck[k])<1e-6,'stone cap = its map mean'));
 assert.equal(errors.length,0,errors.join('\n'));
});

test('the Wall materials picker reports open and every close route, and stays open for painting in the 3D view',async t=>{
 const page=await (await browser(t)).newPage();
 await page.setContent('<body class="wall-mode-active"><button id="btnToggleTypes">Types</button><button id="elsewhere">Toolbar</button><div id="three-view-wrapper" style="position:relative;height:900px;width:1200px"><canvas id="view" width="600" height="400"></canvas></div></body>');
 await page.addScriptTag({path:SCRIPTS+'wall_features.js'});
 await page.evaluate(()=>{window.events=[];WallFeatures.mountUI(()=>{},()=>null,()=>false,{defaults:v=>v||{material:'siding',color:'#123456',trimColor:'#abcdef'},pickerOpened:()=>events.push('open'),pickerClosed:()=>events.push('close')});});
 const open=()=>page.getByRole('button',{name:'Wall materials',exact:true}).click(),events=()=>page.evaluate(()=>events.splice(0));
 await open();await page.getByRole('button',{name:'Close wall materials'}).click();assert.deepEqual(await events(),['open','close'],'× button');
 await open();await page.keyboard.press('Escape');assert.deepEqual(await events(),['open','close'],'Escape');
 await open();await page.locator('#view').click({position:{x:50,y:50}});assert.deepEqual(await events(),['open'],'painting in the 3D view keeps it open');
 await page.locator('#elsewhere').click();assert.deepEqual(await events(),['close'],'an outside click');
 await open();await page.evaluate(()=>document.querySelector('.exterior-sticker-bar .ss-tile').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true})));assert.deepEqual((await events()).slice(0,2),['open','close'],'another tool (the sticker strip)');
 await open();await page.getByRole('button',{name:'Wall materials',exact:true}).click();assert.deepEqual(await events(),['open','close'],'toggling the trigger');
 await page.evaluate(()=>WallFeatures.closeUI());assert.deepEqual(await events(),[],'closing an already closed picker restores nothing');
});
