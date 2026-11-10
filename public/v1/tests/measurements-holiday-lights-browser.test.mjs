import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-375: a two-story house, its main gable roof's eaves at 10 ft, with a shed porch roof on the south side whose eave
// is at 0 ft. The report's Holiday Lights page (pdf.js, dev/holiday-lights-sides.test.cjs) checks the same house to
// the same tags and lengths: keep the two in step.
const point=(id,x,y,z)=>`<POINT id="${id}" data="${x},${y},${z}"/>`;
const line=(id,a,b,type)=>`<LINE id="${id}" path="${a},${b}" type="${type}"/>`;
const face=(id,path)=>`<FACE id="${id}" type="ROOF"><POLYGON path="${path}" pitch="6"/></FACE>`;
const xml='<DATA_EXPORT><STRUCTURES><ROOF id="ROOF1">'
  +point('m1',0,0,10)+point('m2',40,0,10)+point('m3',40,30,10)+point('m4',0,30,10)+point('r1',0,15,18)+point('r2',40,15,18)
  +point('p1',10,-8,0)+point('p2',30,-8,0)+point('p3',30,0,4)+point('p4',10,0,4)
  +line('se','m1','m2','EAVE')+line('ne','m3','m4','EAVE')+line('ridge','r1','r2','RIDGE')
  +line('ser','m2','r2','RAKE')+line('ner','r2','m3','RAKE')+line('swr','r1','m1','RAKE')+line('nwr','m4','r1','RAKE')
  +line('pe','p1','p2','EAVE')+line('per','p2','p3','RAKE')+line('pw','p3','p4','FLASHING')+line('pwr','p4','p1','RAKE')
  +face('south','se,ser,ridge,swr')+face('north','ne,nwr,ridge,ner')+face('porch','pe,per,pw,pwr')
  +'</ROOF></STRUCTURES></DATA_EXPORT>';
const rake=Math.hypot(15,8),porchRake=Math.hypot(8,4);
const expected=[
  ['NU',40],['EL',porchRake],['EU',2*rake],['SL',20],['SU',40],['WL',porchRake],['WU',2*rake]
];

test('holiday lights count by side and roofline, tagged on the roof as in the list',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:760}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(url=>url.host==='lights.test',r=>r.fulfill(r.request().url().endsWith('.xml')?{contentType:'application/xml',body:xml}:{contentType:'text/html',body:'<style>body{margin:0;font-family:Arial}#lights{height:740px}</style><div id="lights"></div>'}));
    await page.goto('http://lights.test/');
    await page.addScriptTag({url:'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
    await page.addScriptTag({url:'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js'});
    await page.evaluate(()=>{const Renderer=THREE.WebGLRenderer;THREE.WebGLRenderer=function(options){const renderer=new Renderer(options),render=renderer.render;renderer.render=function(scene,camera){window.drawnScene=scene;return render.call(renderer,scene,camera);};return renderer;};});
    for(const file of ['roof-viewer.js','holiday-lights.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/measurements/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>{window.lights=FirstMeasureHolidayLights.mount(document.querySelector('#lights'),{xmlUrl:'/model.xml'});});
    await page.waitForFunction(()=>document.querySelector('.fm-hl-canvas canvas')&&document.querySelector('.fm-hl-message').hidden&&document.querySelector('.fm-hl-tag'),{},{timeout:45000});
    const rows=()=>page.evaluate(()=>[...document.querySelectorAll('.fm-hl-tag')].map(tag=>[tag.textContent,tag.closest('div').querySelector('b').textContent,tag.closest('[data-hl-side]').querySelector('.fm-hl-side-head span').firstChild.textContent]));
    const listed=await rows();
    assert.deepEqual(listed.map(([tag])=>tag),expected.map(([tag])=>tag),'Sides in compass order, rooflines lower to upper');
    listed.forEach(([tag,length],i)=>assert.equal(length,`${Math.round(expected[i][1])} ft`,tag));
    assert.deepEqual([...new Set(listed.map(row=>row[2]))],['North','East','South','West']);
    const total=expected.reduce((sum,[,length])=>sum+length,0);
    assert.equal(await page.textContent('[data-hl-total]'),`${Math.round(total)} ft`);
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.fm-hl-group span')].slice(0,3).map(el=>el.firstChild.textContent)),['Upper','Lower','Upper']);
    // The roof carries every tag in the list, in the side's colour.
    const sprites=await page.evaluate(()=>{let tags=0,letters=0;drawnScene.traverse(o=>{if(o.isSprite)o.parent===drawnScene?letters++:tags++;});return {tags,letters};});
    assert.deepEqual(sprites,{tags:expected.length,letters:4},'One tag per group here (every group is one unbroken stretch), and N, E, S, W on the ground');
    // Ridges go in their own group, on the roofline of the faces beside them; switching them on moves nothing else.
    await page.evaluate(()=>[...document.querySelectorAll('.fm-hl-edge')].find(row=>row.textContent.startsWith('Ridges')).querySelector('input').click());
    const withRidges=await rows();
    assert.deepEqual(withRidges.map(([tag])=>tag),[...expected.map(([tag])=>tag),'RU']);
    assert.equal(withRidges.at(-1)[1],'40 ft');
    assert.deepEqual(errors,[]);
    const layout=await page.evaluate(()=>{
      const p=(x,y,z)=>[x,y,z],edge=(type,a,b,keys)=>({type,roof:0,a,b,length:Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]),keys});
      // A one-story box turned 30 degrees: its sides square to the walls, named by the nearest compass point.
      const c=Math.cos(Math.PI/6),s=Math.sin(Math.PI/6),turn=(x,y)=>p(x*c-y*s,x*s+y*c,0);
      const corners=[turn(0,0),turn(30,0),turn(30,20),turn(0,20)];
      const edges=corners.map((a,i)=>edge('EAVE',a,corners[(i+1)%4],[`k${i}`,`k${(i+1)%4}`]));
      const result=FirstMeasureHolidayLights.groupHolidayLights(edges,[{roof:0,ring:corners}],{EAVE:true});
      return {levels:result.levels,groups:result.groups.map(g=>[g.side,g.levelKey,Math.round(g.length)])};
    });
    assert.deepEqual(layout,{levels:1,groups:[['north','',30],['east','',20],['south','',30],['west','',20]]});
    await page.evaluate(()=>window.lights.destroy());
  }finally{await browser.close();}
});
