// FM-455: model_data.xml carries only the export's coarser line types (a protrusion is written EAVE, older XML adds an
// orphan SKYLIGHT edge per protrusion), so the project window's 3D model showed other line types and totals than the
// report's PDF. The viewer reads the report's own line types and line totals from linesUrl
// (GET /v1/firstmeasure/projects/:id/roof-lines) and draws only the report's lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const hole=(p,x,y)=>`<POINT id="${p}1" data="${x},${y},${y*.6}"/><POINT id="${p}2" data="${x+4},${y},${y*.6}"/><POINT id="${p}3" data="${x+4},${y+4},${(y+4)*.6}"/><POINT id="${p}4" data="${x},${y+4},${(y+4)*.6}"/>`
  +`<LINE id="${p}a" path="${p}1,${p}2" type="EAVE"/><LINE id="${p}b" path="${p}2,${p}3" type="EAVE"/><LINE id="${p}c" path="${p}3,${p}4" type="EAVE"/><LINE id="${p}d" path="${p}4,${p}1" type="EAVE"/>`
  +`<FACE id="${p}" type="WALLPENETRATION"><POLYGON path="${p}a,${p}b,${p}c,${p}d" pitch="Infinity"/></FACE>`;
const xml='<DATA_EXPORT><STRUCTURES><ROOF id="ROOF1"><POINT id="a" data="0,0,0"/><POINT id="b" data="30,0,0"/><POINT id="c" data="30,15,9"/><POINT id="d" data="0,15,9"/>'
  +'<LINE id="ab" path="b,a" type="EAVE"/><LINE id="bc" path="b,c" type="RAKE"/><LINE id="cd" path="d,c" type="RIDGE"/><LINE id="da" path="d,a" type="RAKE"/>'
  +'<FACE id="roof" type="ROOF" children="p,q"><POLYGON path="ab,bc,cd,da" pitch="7"/></FACE>'+hole('p',4,4)+hole('q',20,6)
  +'<LINE id="orphan" path="p1,p3" type="SKYLIGHT"/></ROOF></STRUCTURES></DATA_EXPORT>';
const edgeTypes=[{path:'a,b',type:'EAVE'},{path:'b,c',type:'RAKE'},{path:'c,d',type:'RIDGE'},{path:'a,d',type:'RAKE'},
  ...['p','q'].flatMap(p=>[[1,2],[2,3],[3,4],[1,4]].map(([i,j])=>({path:`${p}${i},${p}${j}`,type:'PROTRUSION'})))];
const ft=value=>({value,unit:'ft',source:'firstmeasure'});
const roofLines={ok:true,edgeTypes,measurements:{eavesLf:ft(30),rakesLf:ft(35),ridgesLf:ft(30),protrusionLf:ft(32.4)}};

test('the 3D model draws the report\'s line types and prints its line totals',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:720}}),errors=[];let linesStatus=200;
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(url=>url.host==='roof.test'&&url.pathname.startsWith('/measure/internal/'),r=>readFile(new URL('../../measure/internal/'+new URL(r.request().url()).pathname.split('/measure/internal/')[1],import.meta.url)).then(body=>r.fulfill({contentType:'text/javascript',body}),()=>r.fulfill({status:404,body:''})));
    await page.route(url=>url.host==='roof.test'&&!url.pathname.startsWith('/measure/internal/'),r=>{const path=new URL(r.request().url()).pathname;
      if(path==='/model.xml')return r.fulfill({contentType:'application/xml',body:xml});
      if(path==='/roof-lines')return r.fulfill({status:linesStatus,contentType:'application/json',body:JSON.stringify(linesStatus===200?roofLines:{ok:false})});
      return r.fulfill({contentType:'text/html',body:'<style>body{margin:0;font-family:Arial}#viewer{height:700px}</style><div id="viewer"></div>'});});
    await page.goto('http://roof.test/');
    await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/measurements/roof-viewer.js',import.meta.url),'utf8')});
    await page.addScriptTag({url:'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
    await page.evaluate(()=>{const Renderer=THREE.WebGLRenderer;THREE.WebGLRenderer=function(options){const renderer=new Renderer(options),render=renderer.render;renderer.render=function(scene,camera){window.drawnScene=scene;return render.call(renderer,scene,camera);};return renderer;};});
    const open=async()=>{
      await page.evaluate(()=>{window.roofView?.destroy();window.drawnScene=null;window.roofView=FirstMeasureRoofViewer.mount(document.querySelector('#viewer'),{xmlUrl:'/model.xml',linesUrl:'/roof-lines',standalone:true});});
      await page.waitForFunction(()=>window.drawnScene&&document.querySelector('.fm-roof-message').hidden,{},{timeout:45000});
      return page.evaluate(()=>{const drawn={};drawnScene.traverse(o=>{if(o.isLine&&o.userData.type)drawn[o.userData.type]=(drawn[o.userData.type]||0)+1;});
        const value=name=>document.querySelector(`input[aria-label="${name} length"]`)?.value;
        return {drawn,protrusion:value('Protrusion'),skylight:value('Skylight'),eave:value('Eave')};});
    };
    const report=await open();
    assert.deepEqual(report.drawn,{EAVE:1,RAKE:2,RIDGE:1,PROTRUSION:8},'every protrusion edge as a protrusion; the orphan SKYLIGHT edge is no line of the report');
    assert.equal(report.protrusion,'32','the PDF\'s protrusion total, not the drawn length');
    assert.equal(report.skylight,'');assert.equal(report.eave,'30');
    // Without the report's types (the request fails), the model still opens with the XML's own types.
    linesStatus=500;
    const fallback=await open();
    assert.deepEqual(fallback.drawn,{EAVE:9,RAKE:2,RIDGE:1,SKYLIGHT:1});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('types that name too few of the model\'s lines belong to another model: the XML\'s types stay',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();await page.setContent('<html></html>');
    await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/measurements/roof-viewer.js',import.meta.url),'utf8')});
    const lines=await page.evaluate(([xml,types])=>Object.fromEntries(window.FirstMeasureRoofViewer.parseModel(xml,types).flatMap(roof=>[...roof.lines].map(([id,line])=>[id,line.unlisted?'unlisted':line.type]))),[xml,edgeTypes.slice(0,6)]);
    assert.equal(lines.orphan,'SKYLIGHT');assert.equal(lines.pa,'PROTRUSION');assert.equal(lines.qa,'EAVE');
  }finally{await browser.close();}
});
