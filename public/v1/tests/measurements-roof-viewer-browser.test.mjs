import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {writeArrayBuffer} from 'geotiff';

const xml='<ROOT><ROOF><POINT id="a" data="0,0,0"/><POINT id="b" data="30,0,0"/><POINT id="c" data="30,15,9"/><POINT id="d" data="0,15,9"/><LINE id="ab" path="b,a" type="EAVE"/><LINE id="bc" path="b,c" type="RAKE"/><LINE id="cd" path="d,c" type="RIDGE"/><LINE id="da" path="d,a" type="RAKE"/><FACE><POLYGON path="ab,bc,cd,da"/></FACE></ROOF></ROOT>';
test('read-only roof viewer draws saved geometry, switches modes and media, and adapts to pane width',async()=>{
  const portal=await readFile(new URL('../../portal/index.php',import.meta.url),'utf8');
  const viewerScript=portal.indexOf('<script src="../libraries/apps/measurements/roof-viewer.js');
  assert.ok(viewerScript>=0 && viewerScript<portal.indexOf('<script src="../libraries/apps/measurements/project.js'),'Portal must preload the renderer before registering Measurements');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:720}}),errors=[],writes=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()!=='GET')writes.push(r.url());});
    const solar=Buffer.from(writeArrayBuffer([[[120,130],[140,150]],[[90,100],[110,120]],[[60,70],[80,90]]],{width:2,height:2,PhotometricInterpretation:2}));
    await page.route('http://roof.test/**',r=>r.request().url().endsWith('.tif')?r.fulfill({contentType:'image/tiff',body:solar}):r.fulfill({contentType:r.request().url().endsWith('.xml')?'application/xml':'text/html',body:r.request().url().endsWith('.xml')?xml:'<style>body{margin:0;font-family:Arial}#viewer{height:700px}</style><div id="viewer"></div>'}));
    await page.goto('http://roof.test/');
    await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/measurements/roof-viewer.js',import.meta.url),'utf8')});
    await page.evaluate(()=>{window.viewer=FirstMeasureRoofViewer.mount(document.querySelector('#viewer'),{xmlUrl:'/model.xml',media:[{label:'Aerial view',url:'/rgb.tif',solar:true},{label:'Reference photo',url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="tan"/></svg>')}]});});
    await page.waitForFunction(()=>document.querySelector('.fm-roof-canvas canvas') && document.querySelector('.fm-roof-message').hidden,{},{timeout:45000});
    await page.waitForFunction(()=>document.querySelector('[data-id=media-0] img'));
    await page.getByRole('button',{name:'Aerial view',exact:true}).click();assert.equal(await page.locator('.fm-roof-media').getAttribute('src').then(x=>x.startsWith('blob:')),true);
    await page.getByRole('button',{name:'3D roof model',exact:true}).click();
    assert.equal(await page.locator('.fm-roof-gallery').evaluate(e=>e.classList.contains('is-compact')),false);
    assert.equal(await page.locator('.fm-roof-key').isVisible(),true);
    await page.getByRole('button',{name:'Texture',exact:true}).click();
    assert.equal(await page.locator('[data-texture]').getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('[data-lines]').getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('.fm-roof-key').innerText(),/Eave/);assert.match(await page.locator('.fm-roof-key').innerText(),/Ridge/);
    await mkdir(new URL('../../../output/measurements-viewer/',import.meta.url),{recursive:true});
    await page.screenshot({path:new URL('../../../output/measurements-viewer/geometry-wide.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
    await page.setViewportSize({width:420,height:720});
    await page.waitForFunction(()=>document.querySelector('.fm-roof-gallery').classList.contains('is-compact'));
    await page.getByRole('button',{name:'Reference photo',exact:true}).click();assert.equal(await page.locator('.fm-roof-tools').isVisible(),false);
    await page.getByRole('button',{name:'3D roof model',exact:true}).click();assert.equal(await page.locator('.fm-roof-tools').isVisible(),true);
    await page.getByRole('button',{name:'Colored lines',exact:true}).click();
    assert.equal(await page.locator('[data-lines]').getAttribute('aria-pressed'),'false');
    await page.getByRole('button',{name:'Texture',exact:true}).click();
    assert.equal(await page.locator('[data-texture]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-lines]').getAttribute('aria-pressed'),'false');
    await page.getByRole('button',{name:'Colored lines',exact:true}).click();
    assert.equal(await page.locator('.fm-roof-key').isVisible(),true);
    await page.screenshot({path:new URL('../../../output/measurements-viewer/textured-compact.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    assert.equal(await page.evaluate(xml=>FirstMeasureRoofViewer.parseModel(xml)[0].faces[0].length,xml),4);
    const uvs=await page.evaluate(()=>{
      const f=[[0,0,0],[12,0,0],[12,12,9],[0,12,9]];
      const rotate=([x,y,z])=>[(x-y)/Math.sqrt(2),(x+y)/Math.sqrt(2),z];
      return [FirstMeasureRoofViewer.faceTextureUVs(f),FirstMeasureRoofViewer.faceTextureUVs(f.map(rotate))];
    });
    for(const uv of uvs){assert.ok(Math.abs(uv[2][0]-uv[1][0])<1e-8);assert.ok(Math.abs(Math.abs(uv[2][1]-uv[1][1])-1.25)<1e-8);}
    await page.evaluate(()=>viewer.destroy());assert.equal(await page.locator('canvas').count(),0);
  }finally{await browser.close();}
});

test('media uses only the frozen report aerial and retains reference photos',async()=>{
  const source=await readFile(new URL('../../libraries/apps/measurements/project.js',import.meta.url),'utf8');
  const start=source.indexOf('        media: terminalWithoutReport ? [] : [')+'        media: '.length;
  const end=source.indexOf('        hasCheckedArtifacts:',start);
  const media= new Function('data','files','terminalWithoutReport','projectId','fmUrl','return '+source.slice(start,end).trim().replace(/,$/,''));
  const image='data:image/jpeg;base64,YWJj';
  const files=['rgb.tif','apple.jpg','google.png','azure.png','customer-reference-1.jpg'].map(name=>({name}));
  const result=media({project:{pdf_state:{solarImg:image}}},files,false,'report',x=>x);
  assert.equal(result.length,2);assert.deepEqual(result[0],{url:image,label:'Aerial view'});
  assert.equal(media({project:{}},files,false,'report',x=>x).length,1);
  assert.deepEqual(media({project:{pdf_state:{solarImg:image}}},files,true,'report',x=>x),[]);
});
