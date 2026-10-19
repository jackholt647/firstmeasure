// Resources media viewer: reliable opening, compact library with a resizable
// divider, videos leading their category, keyboard transport, muted audio and
// background server-side frame saving. Runs the real script against mocked storage.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const VIDEO=fs.readFileSync('dev/fixtures/resources-landscape.webm'); // 640x360, 10 fps, 4 s
const id=n=>`internal-resource-v2-${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
test('media viewer opens reliably, steps frames by keyboard and saves frames on the server in the background',async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 try{
  const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const files=[
   {name:id(1)+'-Walkthrough.webm',original_name:'Walkthrough.webm',role:'tech',updated_at:'2026-01-01'},
   {name:id(2)+'-Front.png',original_name:'Front.png',role:'tech',updated_at:'2026-03-03'},
   {name:id(3)+'-Side.png',original_name:'Side.png',role:'tech',updated_at:'2026-02-02'},
   {name:id(4)+'-QA.png',original_name:'QA.png',role:'qa',updated_at:'2026-02-02'},
   {name:id(5)+'-Order.png',original_name:'Order.png',role:'customer',updated_at:'2026-05-05'},
   {name:id(6)+'-Drive_by.webm',original_name:'Drive by.webm',role:'customer',updated_at:'2026-01-01'},
  ];
  const records={},frameRequests=[],posted=[];let failNextFrame=false,uploadGate=null,jobDelay=1200;
  const script=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.js','utf8'),css=fs.readFileSync('public/measure/internal/editor_scripts/project_resources.css','utf8');
  const html=`<meta charset="utf-8"><style>#google-earth-wrapper{position:relative;width:1250px;height:850px}${css}</style><div id="google-earth-wrapper"><div class="map-view-tabs"></div></div><script>window.currentProjectId='fullhouse_viewer';window.switchMapLayer=()=>{};window.firstMeasureBuildUrl=p=>p;</script><script>${script}</script>`;
  await page.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url()),name=u.searchParams.get('name');
   if(!u.pathname.endsWith('project_resources.php'))return u.searchParams.has('action')?route.fulfill({json:{manifest:{}}}):route.fulfill({contentType:'text/html',body:html});
   if(request.method()==='POST'){
    if(u.searchParams.get('action')==='frame'){
     // Emulates the PHP bridge: accept, answer at once, then publish the frame.
     const body=JSON.parse(request.postData()),job='internal-markup-framejob-'+name.slice(21,57)+'.json',fail=failNextFrame;failNextFrame=false;
     frameRequests.push({name,...body});records[job]={status:'running'};
     setTimeout(()=>{if(fail){records[job]={status:'failed',error:'The video frame could not be decoded.'};return;}files.push({name,original_name:body.original_name,role:'tech',updated_at:new Date().toISOString()});if(body.favorite){records[body.favorite.record]={version:1,label:body.favorite.label,source:body.source,time:body.time,frame:name,createdAt:new Date().toISOString()};files.push({name:body.favorite.record});}records[job]={status:'done',frame:name};},jobDelay);
     return route.fulfill({status:202,json:{ok:true,job,frame:name}});
    }
    posted.push(name);if(name.startsWith('internal-markup-part-')&&uploadGate)await uploadGate;
    if(/^internal-resource-v2-/.test(name)){const index=JSON.parse(request.postData());files.push({name,original_name:index.original_name,role:'tech',updated_at:new Date().toISOString()});}
    else if(name.startsWith('internal-markup-')&&!name.startsWith('internal-markup-part-')){records[name]=JSON.parse(request.postData());if(!files.some(f=>f.name===name))files.push({name,updated_at:new Date().toISOString()});}
    return route.fulfill({json:{ok:true,sha256:request.headers()['x-resource-sha256']}});
   }
   if(!name)return route.fulfill({json:{files}});
   if(records[name])return route.fulfill({json:records[name]});
   if(name.startsWith('internal-markup-'))return route.fulfill({status:404,json:{error:'Not found.'}});
   if(name.endsWith('.webm')){const range=request.headers().range?.match(/bytes=(\d+)-(\d*)/),start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),VIDEO.length-1):VIDEO.length-1;return route.fulfill({status:range?206:200,contentType:'video/webm',headers:{'Accept-Ranges':'bytes',...(range?{'Content-Range':'bytes '+start+'-'+end+'/'+VIDEO.length}:{})},body:VIDEO.subarray(start,end+1)});}
   return route.fulfill({contentType:'image/png',body:PNG});
  });
  const filename=()=>page.locator('.resource-filename').textContent();
  const tile=name=>page.getByRole('button',{name,exact:true});
  const video=()=>page.locator('.resource-player video');
  const frameIndex=()=>video().evaluate(v=>Math.floor(v.currentTime*10+1e-6));
  const ready=()=>page.waitForFunction(()=>{const v=document.querySelector('.resource-player video');return v?.readyState>=2&&!v.seeking;});
  await page.goto('https://viewer.test/editor.php');await page.getByRole('button',{name:'Resources',exact:true}).click();await tile('Front.png').waitFor();

  // 3. Categories are QA, Tech and Customer; each one's videos lead it.
  assert.deepEqual(await page.locator('.resource-section').evaluateAll(es=>es.map(e=>e.dataset.role)),['qa','tech','customer']);
  for(const role of ['tech','customer'])assert.deepEqual(await page.locator(`.resource-section[data-role=${role}] .resource-item`).evaluateAll(es=>es.map(e=>e.getAttribute('aria-label'))),role==='tech'?['Walkthrough.webm','Front.png','Side.png']:['Drive by.webm','Order.png']);

  // 2. Photo tiles are compact thumbnails with no title row; the divider resizes the library and is remembered.
  const photoBox=await tile('Front.png').boundingBox();assert.ok(photoBox.height<100,'photo tile height '+photoBox.height);assert.equal(await page.locator('.resource-section[data-role=tech] .resource-item-name').nth(1).isVisible(),false);
  assert.equal(await page.locator('.resource-video-tile .resource-item-name').first().isVisible(),true,'videos keep a one-line name');
  const library=page.locator('.resource-library'),splitter=page.getByRole('separator',{name:'Resize file library'});
  const before=(await library.boundingBox()).width,handle=await splitter.boundingBox();
  await page.mouse.move(handle.x+handle.width/2,handle.y+200);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2-110,handle.y+200,{steps:5});await page.mouse.up();
  const narrowed=(await library.boundingBox()).width;assert.ok(Math.abs(before-110-narrowed)<=3,`library ${before} -> ${narrowed}`);
  await splitter.focus();await page.keyboard.press('ArrowRight');assert.ok(Math.abs((await library.boundingBox()).width-narrowed-24)<=1,'arrow keys on the divider resize');
  await page.waitForTimeout(800);await page.reload();await tile('Front.png').waitFor();assert.ok(Math.abs((await library.boundingBox()).width-narrowed-24)<=1,'width persists per project');
  await splitter.dblclick();assert.equal(Math.round((await library.boundingBox()).width),336);

  // 1. Opening is never blocked by an upload, and clicks are not lost to list redraws.
  let releaseUpload;uploadGate=new Promise(resolve=>releaseUpload=resolve);
  await page.locator('.resource-files').setInputFiles({name:'Décor façade.png',mimeType:'image/png',buffer:PNG});
  await page.waitForFunction(()=>document.querySelector('#project-resources').classList.contains('is-busy'));
  const front=await tile('Front.png').elementHandle();
  await tile('Side.png').click();await page.waitForFunction(()=>document.querySelector('.resource-filename').textContent.includes('Side.png'));
  await tile('Front.png').click();await tile('QA.png').click();await page.waitForFunction(()=>document.querySelector('.resource-filename').textContent.includes('QA.png'));
  assert.equal(await front.evaluate(e=>e.isConnected),true,'opening a file keeps the list nodes');
  releaseUpload();uploadGate=null;await tile('Décor façade.png').waitFor();assert.match(files.find(f=>f.original_name==='Décor façade.png').name,/^internal-resource-v2-[0-9a-f-]{36}-Decor_facade\.png$/,'accented names upload with a sanitized resource name');

  // 4. Photos: Left/Right walk the photos, wherever focus is in the panel.
  await tile('Front.png').click();await page.waitForFunction(()=>document.querySelector('.resource-filename').textContent.includes('Front.png'));
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.resource-filename').textContent.includes('Side.png'));
  await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('.resource-filename').textContent.includes('Front.png'));

  // 5. Videos open muted.
  await tile('Walkthrough.webm').click();await ready();
  assert.equal(await video().evaluate(v=>v.muted),true);assert.equal(await page.locator('[data-action=mute]').getAttribute('aria-label'),'Unmute');

  // 4. Videos: Left/Right step exactly one frame; J/L skip; K and Space play/pause.
  await video().evaluate(v=>{v.pause();v.currentTime=1.05;});await ready();await page.waitForTimeout(100);
  await tile('Walkthrough.webm').focus(); // focus left on a library tile must not swallow keys
  assert.equal(await frameIndex(),10);
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>Math.floor(document.querySelector('.resource-player video').currentTime*10+1e-6)===11);
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>Math.floor(document.querySelector('.resource-player video').currentTime*10+1e-6)===12);
  await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>Math.floor(document.querySelector('.resource-player video').currentTime*10+1e-6)===11);
  assert.equal(await video().evaluate(v=>v.paused),true);
  await page.keyboard.press('l');await page.waitForFunction(()=>document.querySelector('.resource-player video').currentTime>3.9);
  await page.keyboard.press('j');await page.waitForFunction(()=>document.querySelector('.resource-player video').currentTime<.01);
  await page.keyboard.press('k');await page.waitForFunction(()=>!document.querySelector('.resource-player video').paused);
  await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('.resource-player video').paused);
  await page.locator('[data-action=play]').click();await page.waitForFunction(()=>!document.querySelector('.resource-player video').paused);
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('.resource-player video').paused);
  // Space after dragging the scrubber plays and pauses; focus does not stay on the slider.
  const seek=await page.locator('.resource-seek').boundingBox();
  await page.mouse.move(seek.x+seek.width*.2,seek.y+seek.height/2);await page.mouse.down();await page.mouse.move(seek.x+seek.width*.5,seek.y+seek.height/2,{steps:6});
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('.resource-player video').paused);
  await page.mouse.up();await ready();
  assert.equal(await page.evaluate(()=>document.activeElement?.matches('.resource-seek')),false,'the scrubber returns focus to the viewer');
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('.resource-player video').paused);
  await page.keyboard.press('Space');await page.waitForFunction(()=>!document.querySelector('.resource-player video').paused);
  await page.keyboard.press('k');await page.waitForFunction(()=>document.querySelector('.resource-player video').paused);
  // Shortcuts never fire while typing.
  await page.locator('[data-action=notes]').click();const notes=page.locator('.resource-description');await notes.waitFor();
  const at=await video().evaluate(v=>v.currentTime);await notes.click();await page.keyboard.type('j k l ');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Space');
  assert.equal(await notes.inputValue(),'j k l  ');assert.equal(await video().evaluate(v=>v.paused),true);assert.equal(await video().evaluate(v=>v.currentTime),at);
  await page.locator('[data-action=notes]').click();

  // 6. Save Frame sends only the video name and the time; the server extracts it in the background.
  const uploadedParts=()=>posted.filter(n=>n.startsWith('internal-markup-part-')).length,partsBefore=uploadedParts();
  await video().evaluate(v=>{v.pause();v.currentTime=2.05;});await ready();await page.waitForTimeout(100);
  await page.getByRole('button',{name:'Save Frame',exact:true}).click();
  await page.getByRole('button',{name:'Saving 1 frame…',exact:true}).waitFor();
  assert.equal(frameRequests.length,1);assert.equal(frameRequests[0].source,files[0].name);assert.ok(Math.abs(frameRequests[0].time-2)<.001,'the frame on screen: '+frameRequests[0].time);
  assert.match(frameRequests[0].name,/^internal-resource-v2-[0-9a-f-]{36}-Walkthrough-frame-2\.00s\.png$/);
  // While it runs: keep stepping, save another frame, and open other files.
  await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>Math.floor(document.querySelector('.resource-player video').currentTime*10+1e-6)===21);
  await page.getByRole('button',{name:'Save Frame',exact:true}).click();await page.getByRole('button',{name:'Saving 2 frames…',exact:true}).waitFor();
  await tile('Side.png').click();await page.waitForFunction(()=>document.querySelector('.resource-filename').textContent.includes('Side.png'));
  await page.getByRole('button',{name:'✓ Frame saved',exact:true}).waitFor();
  assert.equal(uploadedParts(),partsBefore,'no frame image is uploaded by the browser');
  assert.equal(await page.locator('.resource-section[data-role=tech] .resource-tile-time').count(),2,'saved frames show their video time');
  await tile('Walkthrough.webm').click();await ready();await video().evaluate(v=>{v.pause();v.currentTime=2.05;});await ready();await page.waitForTimeout(100);
  await page.getByRole('button',{name:'Saved Frame',exact:true}).waitFor();

  // A failed extraction is reported and can be retried.
  failNextFrame=true;await video().evaluate(v=>{v.currentTime=3.05;});await ready();await page.waitForTimeout(100);
  await page.getByRole('button',{name:'Save Frame',exact:true}).click();await page.getByRole('button',{name:'1 frame not saved · Retry',exact:true}).waitFor();
  assert.match(await page.locator('#project-resources footer').textContent(),/could not be decoded/);
  await page.getByRole('button',{name:'1 frame not saved · Retry',exact:true}).click();await page.getByRole('button',{name:'✓ Frame saved',exact:true}).waitFor();
  assert.equal(frameRequests.at(-1).name,frameRequests.at(-2).name,'retry reuses the frame name');

  // Drawing on a video frame starts at once on a local still while the server saves the frame.
  jobDelay=1500;await video().evaluate(v=>{v.currentTime=.55;});await ready();await page.waitForTimeout(100);
  await page.locator('[data-action=markup]').click();await page.locator('[data-tool=pen]').click();
  await page.locator('#project-resources canvas').waitFor({state:'visible'});
  const capture=frameRequests.at(-1);assert.ok(Math.abs(capture.time-.5)<.001);assert.match(await filename(),/Walkthrough frame 0:00\.png/);
  await page.locator('.resource-tile-state',{hasText:'Saving…'}).waitFor();
  const stage=await page.locator('.resource-stage').boundingBox();await page.mouse.move(stage.x+200,stage.y+200);await page.mouse.down();await page.mouse.move(stage.x+260,stage.y+240,{steps:4});await page.mouse.up();
  await page.locator('[data-action=save]').click();await page.locator('[data-action=save]').waitFor({state:'hidden'});
  const markup=Object.entries(records).find(([key])=>key.startsWith('internal-markup-'+capture.name.slice(21,57)));assert.ok(markup,'markup is saved against the frame name');assert.equal(markup[1].sourceVideo.name,files[0].name);
  await page.locator('.resource-tile-state').waitFor({state:'detached'});
  assert.equal(uploadedParts(),partsBefore);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
