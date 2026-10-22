import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// A 10 m x 8 m gable house in the editor's metric frame (x east, y south, z up), and the same roof exported as
// model_data.xml: feet, centred on the roof, y flipped, z from 2000 at the eaves.
const FT = 3.28084, H = 3, RIDGE = 5, O = .3;
const roofFaces = [
  [[-O,-O,H],[10+O,-O,H],[10+O,4,RIDGE],[-O,4,RIDGE]],
  [[-O,4,RIDGE],[10+O,4,RIDGE],[10+O,8+O,H],[-O,8+O,H]]
];
const all = roofFaces.flat(), mid = i => (Math.min(...all.map(p => p[i])) + Math.max(...all.map(p => p[i]))) / 2, minZ = Math.min(...all.map(p => p[2]));
const toFeet = p => [(p[0]-mid(0))*FT, -(p[1]-mid(1))*FT, 2000+(p[2]-minZ)*FT];
function xml(){
  const ids = new Map(), pts = [], lines = [], key = p => p.join(',');
  const pid = p => {if(!ids.has(key(p))){ids.set(key(p),'P'+(ids.size+1));pts.push(`<POINT id="${ids.get(key(p))}" data="${toFeet(p).map(v=>v.toFixed(4)).join(',')}"/>`);}return ids.get(key(p));};
  const types = ['EAVE','RAKE','RIDGE','RAKE'], seen = new Map();
  const faces = roofFaces.map((face, f) => {const path = face.map((p, i) => {const q = face[(i+1)%4], k = [pid(p),pid(q)].sort().join(',');if(!seen.has(k)){seen.set(k,'L'+(seen.size+1));lines.push(`<LINE id="${seen.get(k)}" path="${pid(p)},${pid(q)}" type="${f?['RIDGE','RAKE','EAVE','RAKE'][i]:types[i]}"/>`);}return seen.get(k);});return `<FACE id="F${f+1}" type="ROOF"><POLYGON path="${path.join(',')}" pitch="5" size="${(10+2*O)*(4+O)*FT*FT*1.077}"/></FACE>`;});
  return `<DATA_EXPORT><STRUCTURES><ROOF id="ROOF1"><FACES>${faces.join('')}</FACES><LINES>${lines.join('')}</LINES><POINTS>${pts.join('')}</POINTS></ROOF></STRUCTURES></DATA_EXPORT>`;
}
const rect = (a, b, z0, z1) => [[...a,z0],[...b,z0],[...b,z1],[...a,z1]];
const walls = [
  {id:'W01', points:rect([0,0],[10,0],0,H), elevation:'North', material:'Horizontal siding', materialKey:'siding', openings:[
    {id:'W01-1', type:'window', label:'Window', points:rect([2,0],[3.2,0],1,2.4), area:18.1, perimeter:17.1, width:3.94, height:4.59},
    {id:'W01-2', type:'door', label:'Door', points:rect([6,0],[7,0],0,2.1), area:22.6, perimeter:20.3, width:3.28, height:6.89}]},
  {id:'W02', points:rect([10,8],[0,8],0,H), elevation:'South', material:'Brick', materialKey:'brick', openings:[]},
  {id:'W03', points:[[0,8,0],[0,0,0],[0,0,H],[0,4,RIDGE],[0,8,H]], elevation:'West', material:'Horizontal siding', materialKey:'siding', openings:[]},
  {id:'W04', points:[[10,0,0],[10,8,0],[10,8,H],[10,4,RIDGE],[10,0,H]], elevation:'East', material:'Horizontal siding', materialKey:'siding', openings:[]}
].map(w => ({...w, holes:[], finishColor:null, chimney:false, curved:false, gross:100, net:100-w.openings.reduce((s,o)=>s+o.area,0), openingArea:w.openings.reduce((s,o)=>s+o.area,0), width:32.8, height:9.8}));
const edge = (a, b, type) => ({a, b, type, length: Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])*FT, walls:['W01']});
const model = {version:1, units:{points:'m',lengths:'ft',areas:'ft2'}, walls,
  edges:[edge([0,0,0],[10,0,0],'Bottom'), edge([10,8,0],[0,8,0],'Bottom'), edge([0,0,H],[10,0,H],'Top'), edge([0,0,0],[0,0,H],'Outside corner'), edge([10,0,0],[10,0,H],'Outside corner')],
  base:[{points:[[0,0,0],[10,0,0],[10,8,0],[0,8,0]], holes:[]}], roof:roofFaces.map(points=>({points,holes:[]})),
  roofTrim:[{points:[[-O,-O,H],[10+O,-O,H],[10+O,-O,H-.2],[-O,-O,H-.2]], holes:[], materialKey:'trim-horizontal', finishColor:null}], reportHasTrim:true, sourceRoof:null, roofTrimSettings:{edges:{}}, caps:[], returns:[],
  roofFinish:{category:'metal', color:'#324b3c'}, defaults:{material:null,color:null,trimColor:null},
  totals:{gross:400, net:359.3, openingArea:40.7, openingPerimeter:37.4, top:32.8, bottom:32.8}};

test('full-house viewer draws walls, openings, base and fascia with editor finishes, and measures',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:760}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://house.test/**',route=>{const url=route.request().url();
      if(url.endsWith('/model.xml'))return route.fulfill({contentType:'application/xml',body:xml()});
      if(url.endsWith('/exterior-model'))return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,model})});
      // The viewer loads the editor's own kernel, finishes, rendered presentation and its assets.
      if(url.includes('/measure/internal/')){const path=new URL(url).pathname.split('/measure/internal/')[1];return readFile(new URL('../../measure/internal/'+path,import.meta.url)).then(body=>route.fulfill({contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.jpg')?'image/jpeg':'application/octet-stream',body}),()=>route.fulfill({status:404,body:''}));}
      return route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font-family:Arial}#viewer{height:740px}</style><div id="viewer"></div>'});});
    await page.goto('http://house.test/');
    await page.addScriptTag({url:'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
    await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/measurements/roof-viewer.js',import.meta.url),'utf8')});
    await page.evaluate(()=>{const Renderer=THREE.WebGLRenderer;THREE.WebGLRenderer=function(options){const renderer=new Renderer(options),render=renderer.render;renderer.render=function(scene,camera){window.drawnScene=scene;window.drawnCamera=camera;return render.call(renderer,scene,camera);};return renderer;};});
    await page.evaluate(()=>{window.viewer=FirstMeasureRoofViewer.mount(document.querySelector('#viewer'),{xmlUrl:'/model.xml',exteriorUrl:'/exterior-model',standalone:true,measurements:{wallTopLf:{value:120}}});});
    await page.waitForFunction(()=>document.querySelector('.fm-roof-canvas canvas')&&document.querySelector('.fm-roof-message').hidden&&window.drawnScene,{},{timeout:45000});

    // The metric model and the exported XML land in one frame.
    const fitted=await page.evaluate(({model,text})=>{const frame=FirstMeasureRoofViewer.exteriorFrame(model,FirstMeasureRoofViewer.parseModel(text));return {matches:frame.matchesXml,back:frame.toMetres(frame.toFeet([3,2,1]))};},{model,text:xml()});
    assert.equal(fitted.matches,true);assert.ok(fitted.back.every((v,i)=>Math.abs(v-[3,2,1][i])<1e-9));

    // Wide standalone: every panel in a left column beside the model.
    assert.equal(await page.locator('.fm-roof-gallery').evaluate(e=>e.classList.contains('is-side')),true);
    const legendBox=await page.locator('.fm-roof-legend').boundingBox(),stageBox=await page.locator('.fm-roof-stage').boundingBox();
    assert.ok(legendBox.x+legendBox.width<=stageBox.x+1&&legendBox.height>600,'measurements column sits left of a full-height model');
    for(const title of ['Roof lines','Walls','Openings','Pitches','Summary'])assert.equal(await page.locator('.fm-roof-section-title',{hasText:title}).first().isVisible(),true,title);

    const scene=()=>page.evaluate(()=>{const out=[];drawnScene.traverse(o=>{if(!o.isMesh||!o.userData.item)return;let visible=true;for(let p=o;p;p=p.parent)visible&&=p.visible;out.push({kind:o.userData.item.kind,category:o.userData.item.category,visible,map:o.material.map?.image?.width||0,basic:o.material.isMeshBasicMaterial,lit:!!o.userData.baseColor&&!o.material.color.equals(o.userData.baseColor)});});return out;});
    let meshes=await scene();
    const kinds=k=>meshes.filter(m=>m.kind===k);
    assert.equal(kinds('wall').length,4);assert.equal(kinds('opening').length,2);assert.equal(kinds('base').length,1);assert.equal(kinds('trim').length,1);assert.equal(kinds('roofFace').length,4,'each roof face is the editor covering plus its soffit underside');
    assert.ok(meshes.every(m=>m.basic),'unlit, as the editor Textured view');
    assert.ok(kinds('wall').every(m=>m.map>0),'walls carry the editor finish maps');assert.ok(kinds('opening').every(m=>m.map===512),'windows and doors carry opening maps');assert.ok(kinds('roofFace').every(m=>m.map>0),'the roof carries the editor covering');
    assert.equal(kinds('base')[0].map,0,'the base stays a neutral slab');

    // Layers.
    await page.getByRole('button',{name:'Walls',exact:true}).first().click();
    meshes=await scene();assert.ok(kinds('wall').every(m=>!m.visible)&&kinds('opening').every(m=>!m.visible));assert.ok(kinds('roofFace').every(m=>m.visible));
    await page.locator('[data-layer="walls"]').click();await page.locator('[data-layer="roof"]').click();
    meshes=await scene();assert.ok(kinds('roofFace').every(m=>!m.visible)&&kinds('trim').every(m=>!m.visible)&&kinds('wall').every(m=>m.visible));
    await page.locator('[data-layer="roof"]').click();

    // Texture off: flat finish colors, no maps.
    await page.getByRole('button',{name:'Texture',exact:true}).click();meshes=await scene();assert.ok(meshes.every(m=>m.map===0));
    await page.getByRole('button',{name:'Texture',exact:true}).click();meshes=await scene();assert.ok(kinds('wall').every(m=>m.map>0));

    // Categories: surfaces by material, edges with their measurement key, openings by type.
    await page.getByRole('button',{name:'Highlight Brick',exact:true}).click();meshes=await scene();
    assert.ok(meshes.filter(m=>m.category==='material:brick').every(m=>m.lit)&&meshes.filter(m=>m.category==='material:siding').every(m=>!m.lit));
    await page.getByRole('button',{name:'Highlight Windows',exact:true}).click();meshes=await scene();assert.ok(kinds('opening').filter(m=>m.category==='opening:window').every(m=>m.lit));
    await page.getByRole('button',{name:'Highlight Windows',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Top of walls length',exact:true}).inputValue(),'120','saved wall measurements fill the edge rows');
    assert.match(await page.locator('[data-key-panel="openings"]').innerText(),/Windows[\s\S]*Doors/);
    assert.match(await page.locator('[data-key-panel="summary"]').innerText(),/Net wall area[\s\S]*359 sq ft/);

    // Click a wall: the card reports it.
    const screen=(p)=>page.evaluate(p=>{const v=new THREE.Vector3(...p).project(drawnCamera),box=document.querySelector('.fm-roof-canvas canvas').getBoundingClientRect();return {x:box.left+(v.x+1)/2*box.width,y:box.top+(1-v.y)/2*box.height};},p);
    const scenePoint=metres=>page.evaluate(({metres,text,model})=>{const roofs=FirstMeasureRoofViewer.parseModel(text),frame=FirstMeasureRoofViewer.exteriorFrame(model,roofs),all=[...roofs.flatMap(r=>[...r.points.values()]),...[...model.walls.flatMap(w=>w.points),...model.base.flatMap(f=>f.points)].map(frame.toFeet)],min=[0,1,2].map(i=>Math.min(...all.map(p=>p[i]))),max=[0,1,2].map(i=>Math.max(...all.map(p=>p[i]))),scale=100/Math.max(...max.map((v,i)=>v-min[i])),q=frame.toFeet(metres);return [(q[0]-(min[0]+max[0])/2)*scale,(q[2]-(min[2]+max[2])/2)*scale,-(q[1]-(min[1]+max[1])/2)*scale];},{metres,text:xml(),model});
    // The default camera looks from the south-east: the brick south wall faces it.
    const brick=await screen(await scenePoint([5,8,1.5]));await page.mouse.click(brick.x,brick.y);
    assert.match(await page.locator('[data-card] strong').textContent(),/W02 · Brick/);assert.match(await page.locator('[data-card]').innerText(),/South/);
    await page.keyboard.press('Escape');assert.equal(await page.locator('[data-card]').isHidden(),true);
    await page.mouse.move(brick.x,brick.y);await page.waitForTimeout(150);
    meshes=await scene();assert.ok(meshes.filter(m=>m.category==='material:brick').some(m=>m.lit),'hovering a face washes it faintly');
    assert.equal(await page.locator('[data-card]').isHidden(),true,'hover never opens the card');
    await page.mouse.move(5,5);

    // Line lengths.
    await page.getByRole('button',{name:'Line lengths',exact:true}).click();
    assert.ok(await page.evaluate(()=>{let n=0;drawnScene.traverse(o=>{if(o.isSprite&&o.visible&&o.userData.canvas&&!('pitch' in o.userData)&&!o.userData.item){let v=true;for(let p=o;p;p=p.parent)v&&=p.visible;if(v)n++;}});return n>=8;}),'roof lines and wall edges show their lengths');

    // Measure two snapped corners of the south wall's base: 10 m.
    await page.getByRole('button',{name:'Measure',exact:true}).click();
    // Clicks land just inside the wall and snap to its corners.
    const a=await screen(await scenePoint([9.85,8,.12])),b=await screen(await scenePoint([.15,8,.12]));
    await page.mouse.click(a.x,a.y);await page.mouse.move(b.x,b.y);await page.mouse.click(b.x,b.y);
    assert.match(await page.locator('[data-key-panel="measures"]').innerText(),/32′ 10″ \(32\.81 ft\)/);
    assert.equal(await page.locator('[data-measure-clear]').isVisible(),true);
    await mkdir(new URL('../../../output/measurements-viewer/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../../../output/measurements-viewer/full-house-wide.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
    await page.locator('[data-measure-clear]').click();assert.equal(await page.locator('[data-key-panel="measures"]').evaluate(e=>e.hasAttribute('data-empty')),true);
    await page.getByRole('button',{name:'Done',exact:true}).click();

    // Narrow: the tray returns under the model with tabs.
    await page.setViewportSize({width:560,height:760});
    await page.waitForFunction(()=>!document.querySelector('.fm-roof-gallery').classList.contains('is-side'));
    assert.equal(await page.getByRole('tab',{name:'Walls',exact:true}).isVisible(),true);
    const narrowLegend=await page.locator('.fm-roof-legend').boundingBox(),narrowCanvas=await page.locator('.fm-roof-canvas').boundingBox();assert.ok(narrowLegend.y>=narrowCanvas.y+narrowCanvas.height-1);
    await page.getByRole('tab',{name:'Walls',exact:true}).click();
    await page.screenshot({path:new URL('../../../output/measurements-viewer/full-house-narrow.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
    const state=await page.evaluate(()=>viewer.serialize());assert.equal(state.lengths,true);assert.deepEqual(state.layers,{roof:true,walls:true,base:true});
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>viewer.destroy());
  }finally{await browser.close();}
});

test('the exterior model projection keeps geometry and finishes and drops editor state',async()=>{
  const {exteriorModelProjection}=await import('../firstmeasure/exterior_model.ts');
  const report={walls:[{id:'W01',points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:0,z:1},{x:0,y:0,z:1}],holes:[],material:'Brick',finishColor:'#A65D4B',elevation:'North',chimney:false,gross:10.76,net:10.76,openingArea:0,width:3.28,height:3.28,openings:[{id:'W01-1',type:'window',points:[{x:.2,y:0,z:.2},{x:.4,y:0,z:.2},{x:.4,y:0,z:.6},{x:.2,y:0,z:.6}],area:1,perimeter:2,width:1,height:1,trimFaces:[{points:[]}]}],key:'k'}],
    edges:[{a:{x:0,y:0,z:0},b:{x:1,y:0,z:0},type:'Bottom',length:3.28,walls:['W01']},{a:{x:0,y:0,z:0},b:{x:0,y:0,z:1},type:'Nonsense',length:1,walls:[]}],
    base:[{points:[{x:0,y:0,z:0},{x:1,y:0,z:0},{x:1,y:1,z:0}],holes:[]}],roof:[],roofTrim:[{points:[{x:0,y:0,z:1},{x:1,y:0,z:1},{x:1,y:0,z:.9}],material:'Roof trim',materialKey:'trim-horizontal'}],caps:[],returns:[],
    totals:{gross:10.76,net:10.76},coverRender:'data:image/jpeg;base64,AAAA',construction:[{secret:true}]};
  report.walls.push({...report.walls[0],id:'W02',material:'Horizontal siding',finishColor:'#80868B',openings:[]});
  const model=exteriorModelProjection(report,{exteriorsWalls:{finishDefaults:{roof:{category:'slate',color:'#626970'},color:'#80868b',stickers:{doorMain:'#564437',bad:'red'}},wallEdits:{private:true}},qa:{reviewer:'x'}});
  assert.equal(model.walls[1].finishColor,null,'a color equal to the default it resolved from is not a choice');
  assert.deepEqual(model.finishDefaults,{color:'#80868b',roof:{category:'slate',color:'#626970'},stickers:{doorMain:'#564437'}});
  assert.equal(model.walls[0].materialKey,'brick');assert.equal(model.walls[0].finishColor,'#a65d4b');assert.deepEqual(model.walls[0].points[2],[1,0,1]);
  assert.equal(model.walls[0].openings.length,1);assert.deepEqual(model.walls[0].openings[0].trimFaces,[],'a trim face without points is dropped');
  assert.deepEqual(model.edges.map(e=>e.type),['Bottom']);assert.equal(model.roofTrim[0].materialKey,'trim-horizontal');
  assert.deepEqual(model.roofFinish,{category:'slate',color:'#626970'});assert.equal(model.defaults.color,'#80868b');
  assert.equal(JSON.stringify(model).includes('coverRender'),false);assert.equal(JSON.stringify(model).includes('secret'),false);assert.equal(JSON.stringify(model).includes('reviewer'),false);
  assert.equal(exteriorModelProjection({walls:[]}),null);
});
