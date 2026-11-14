import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-375: a two-story house, its main gable roof's eaves at 10 ft, with a shed porch roof on the south side whose eave
// is at 0 ft. The report's Holiday Lights page (pdf.js, dev/holiday-lights-sides.test.cjs) checks the same house to
// the same groups and lengths: keep the two in step.
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
  ['north','Upper',40],['east','Lower',porchRake],['east','Upper',2*rake],['south','Lower',20],['south','Upper',40],['west','Lower',porchRake],['west','Upper',2*rake]
];
const colors={north:'#1a73e8',east:'#f29900',south:'#9334e6',west:'#12b5cb',peak:'#e52592'};

test('holiday lights count by side and roofline, in side colours, with the length of every stretch on the roof',async()=>{
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
    await page.waitForFunction(()=>document.querySelector('.fm-hl-canvas canvas')&&document.querySelector('.fm-hl-message').hidden&&document.querySelector('.fm-hl-group'),{},{timeout:45000});
    // One row per roofline of a side (or the side itself when it has one): [side, roofline, length, colour, side name].
    const rows=()=>page.evaluate(()=>[...document.querySelectorAll('.fm-hl-group, .fm-hl-side:not(:has(.fm-hl-group)) .fm-hl-side-head')].map(row=>{
      const side=row.closest('[data-hl-side]'),hex=c=>'#'+c.match(/\d+/g).slice(0,3).map(n=>(+n).toString(16).padStart(2,'0')).join('');
      return [side.dataset.hlSide,row.classList.contains('fm-hl-group')?row.querySelector('span').firstChild.textContent:'',row.querySelector('b').textContent,hex(getComputedStyle(row.querySelector('.fm-hl-swatch')).backgroundColor),side.querySelector('.fm-hl-side-head span').firstChild.textContent];
    }));
    const listed=await rows();
    assert.deepEqual(listed.map(([side,level])=>[side,level]),expected.map(([side,level])=>[side,level]),'Sides in compass order, rooflines lower to upper');
    listed.forEach(([side,level,length,color],i)=>{assert.equal(length,`${Math.round(expected[i][2])} ft`,side+level);assert.equal(color,colors[side]);});
    assert.deepEqual([...new Set(listed.map(row=>row[4]))],['North','East','South','West']);
    const total=expected.reduce((sum,[,,length])=>sum+length,0);
    assert.equal(await page.textContent('[data-hl-total]'),`${Math.round(total)} ft`);
    assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('.fm-hl-group span')].slice(0,3).map(el=>el.firstChild.textContent)),['Upper','Lower','Upper']);
    // Every stretch shows its length on the roof in its side's colour (here every group is one unbroken stretch), and
    // N, E, S and W stand on the ground.
    const sprites=await page.evaluate(()=>{const labels=[];let letters=0;drawnScene.traverse(o=>{if(o.isSprite)o.parent===drawnScene?letters++:labels.push([o.userData.label,o.userData.color]);});return {labels,letters};});
    assert.equal(sprites.letters,4);
    assert.deepEqual(sprites.labels.sort(),expected.map(([side,,length])=>[`${Math.round(length)} ft`,colors[side]]).sort());
    // A side switches off like an edge kind: its lights, labels, length in the total and bulbs go; it stays listed.
    const bulbs12=()=>page.evaluate(()=>+[...document.querySelectorAll('[data-hl-spacing] button')].find(b=>b.textContent.startsWith('12'))?.children[1].textContent.replace(/\D/g,''));
    const bulbsAll=await bulbs12();
    await page.evaluate(()=>document.querySelector('[data-hl-side="south"] .fm-hl-side-head input').click());
    assert.equal(await page.textContent('[data-hl-total]'),`${Math.round(total-60)} ft`);
    assert.ok(await page.evaluate(()=>document.querySelector('[data-hl-side="south"]').classList.contains('is-off')&&!document.querySelector('[data-hl-side="south"] input').checked));
    assert.equal(await bulbs12(),bulbsAll-60,'one bulb a foot at 12 in: the south side\'s 60 ft are gone');
    const southOff=await page.evaluate(()=>{const labels=[];drawnScene.traverse(o=>{if(o.isSprite&&o.userData.label)labels.push(o.userData.color);});return labels;});
    assert.equal(southOff.length,expected.length-2);
    assert.ok(!southOff.includes(colors.south));
    await page.evaluate(()=>document.querySelector('[data-hl-side="south"] .fm-hl-side-head input').click());
    assert.equal(await page.textContent('[data-hl-total]'),`${Math.round(total)} ft`);
    // Ridges go in their own group, on the roofline of the faces beside them; switching them on moves nothing else.
    await page.evaluate(()=>[...document.querySelectorAll('.fm-hl-edge')].find(row=>row.textContent.startsWith('Ridges')).querySelector('input').click());
    const withRidges=await rows();
    assert.deepEqual(withRidges.map(([side,level])=>[side,level]),[...expected.map(([side,level])=>[side,level]),['peak','Upper']]);
    assert.equal(withRidges.at(-1)[2],'40 ft');
    assert.equal(withRidges.at(-1)[4],'Ridges and hips');
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

// FM-400: the 3D model's lights are a toggle beside Expand, not a key tab with a "Show holiday lights" button. Small (the
// project details tray) it shows only the roof, the total and a way to Reports › Holiday Lights; side by side the counts
// take the left column. How lengths are measured is a tooltip by the title, not a paragraph.
test('the 3D model toggles holiday lights: compact in the tray, counts in the left column side by side',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader']});
  try{
    const page=await browser.newPage({viewport:{width:1400,height:820}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(url=>url.host==='lights.test',r=>r.fulfill(/\.xml$/.test(new URL(r.request().url()).pathname)?{contentType:'application/xml',body:xml}:/\.js$/.test(new URL(r.request().url()).pathname)?{contentType:'text/javascript',body:''}:{contentType:'text/html',body:'<style>body{margin:0;font-family:Arial}#w{width:380px;height:380px;position:relative}</style><div id="w"></div>'}));
    await page.goto('http://lights.test/');
    await page.addScriptTag({url:'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'});
    await page.addScriptTag({url:'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js'});
    for(const file of ['roof-viewer.js','holiday-lights.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/measurements/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>{window.opened=[];document.addEventListener('fm:open-report-view',event=>{window.opened.push(event.detail.view);if(window.handleOpen)event.preventDefault();});
      window.viewer=FirstMeasureRoofViewer.mount(document.querySelector('#w'),{xmlUrl:'/model.xml',standalone:true,holidayLights:true});});
    const toggle=page.locator('[data-hl-toggle]');
    await toggle.waitFor();
    assert.equal(await page.locator('[data-key-tab="lights"], .fm-roof-hl-switch').count(),0);
    assert.equal(await toggle.getAttribute('aria-pressed'),'false');
    assert.equal(await toggle.getAttribute('aria-label'),'Holiday lights');
    await toggle.click();
    await page.waitForFunction(()=>document.querySelector('.fm-roof-lights .fm-hl-canvas canvas')&&document.querySelector('.fm-hl-message').hidden,{},{timeout:45000});
    const total=Math.round(40+2*rake+porchRake+20+40+porchRake+2*rake)+' ft';
    await page.waitForFunction(text=>document.querySelector('.fm-roof-hl-mini strong')?.textContent===text,total);
    const small=await page.evaluate(()=>{const visible=el=>!!el&&getComputedStyle(el).display!=='none'&&el.getClientRects().length>0,box=el=>el.getBoundingClientRect();
      const w=box(document.querySelector('#w')),canvas=box(document.querySelector('.fm-roof-lights .fm-hl-canvas')),mini=document.querySelector('.fm-roof-hl-mini');
      return {pressed:document.querySelector('[data-hl-toggle]').getAttribute('aria-pressed'),model:visible(document.querySelector('.fm-roof-canvas')),panel:visible(document.querySelector('.fm-hl-panel')),key:visible(document.querySelector('.fm-roof-legend')),
        mini:visible(mini)&&box(mini).bottom<=w.bottom,fills:Math.round(canvas.width)===Math.round(w.width)&&Math.round(canvas.height)===Math.round(w.height),scrolls:document.querySelector('.fm-roof-lights').scrollHeight>document.querySelector('.fm-roof-lights').clientHeight+1};});
    assert.deepEqual(small,{pressed:'true',model:false,panel:false,key:false,mini:true,fills:true,scrolls:false});
    // Open Holiday Lights asks the host for Reports › Holiday Lights; a host that answers keeps the tray as it is.
    await page.evaluate(()=>{window.handleOpen=true;});
    await page.click('[data-hl-open]');
    assert.deepEqual(await page.evaluate(()=>window.opened),['lights']);
    assert.equal(await page.locator('.fm-roof-expanded').count(),0);
    // With no host to answer, it expands instead: side by side, the counts are in the left column, with the tooltip.
    await page.evaluate(()=>{window.handleOpen=false;});
    await page.click('[data-hl-open]');
    await page.waitForFunction(()=>document.querySelector('.fm-roof-gallery.is-side [data-key-panel="lights"] .fm-hl-panel [data-hl-total]'));
    const side=await page.evaluate(()=>{const panel=document.querySelector('[data-key-panel="lights"] .fm-hl-panel'),info=panel.querySelector('.fm-hl-info button'),tip=document.getElementById(info.getAttribute('aria-describedby'));
      return {total:panel.querySelector('[data-hl-total]').textContent,mini:getComputedStyle(document.querySelector('.fm-roof-hl-mini')).display,note:!!document.querySelector('.fm-hl-note'),tip:tip.textContent.startsWith('Lengths are measured along each roof edge'),tipHidden:getComputedStyle(tip).visibility,lines:getComputedStyle(document.querySelector('[data-key-panel="lines"]')).display};});
    assert.deepEqual(side,{total,mini:'none',note:false,tip:true,tipHidden:'hidden',lines:'none'});
    await page.hover('[data-key-panel="lights"] .fm-hl-info button');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-key-panel="lights"] .fm-hl-tip')).opacity==='1');
    // Toggling off brings back the model and its key; the state remembers the choice.
    assert.equal(await page.evaluate(()=>window.viewer.serialize().lights),true);
    await page.click('[data-hl-toggle]');
    assert.deepEqual(await page.evaluate(()=>[document.querySelector('[data-hl-toggle]').getAttribute('aria-pressed'),getComputedStyle(document.querySelector('.fm-roof-canvas')).display!=='none',document.querySelectorAll('.fm-roof-lights .fm-hl').length,getComputedStyle(document.querySelector('[data-key-panel="lines"]')).display!=='none',window.viewer.serialize().lights]),['false',true,0,true,false]);
    assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.viewer.destroy());
  }finally{await browser.close();}
});
