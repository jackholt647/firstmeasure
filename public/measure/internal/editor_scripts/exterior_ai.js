/* Development-only eight-view experiment. Captures stay in browser IndexedDB. */
(function(root){'use strict';
 const EYE=1.8288, VIEWS=8, FOV=45, MARGIN=.90;
 let panel,run,controller,busy=false;
 const node=(tag,text,parent)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(parent)parent.appendChild(e);return e;};
 const corners=g=>[g.min.x,g.max.x].flatMap(x=>[g.min.y,g.max.y].flatMap(y=>[g.min.z,g.max.z].map(z=>({x,y,z}))));
 const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
 const minus=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
 const normalize=p=>{const n=Math.hypot(p.x,p.y,p.z);if(!(n>0))throw Error('Invalid camera direction.');return {x:p.x/n,y:p.y/n,z:p.z/n};};
 function orbitPosition(g,radius,index){
  const angle=index*Math.PI*2/VIEWS;
  const p={x:g.center.x+Math.sin(angle)*radius,y:g.center.y+Math.cos(angle)*radius};
  const ground=g.groundAt(p);if(!Number.isFinite(ground))throw Error('No grade elevation at an orbit position.');
  return {...p,z:ground+EYE};
 }
 // Fit the whole building box, including depth and terrain-induced camera tilt.
 function fits(g,position,aspect,fov=FOV,margin=MARGIN){
  const forward=normalize(minus(g.center,position));
  const right=normalize({x:forward.y,y:-forward.x,z:0});
  const up={x:right.y*forward.z,y:-right.x*forward.z,z:right.x*forward.y-right.y*forward.x};
  const vertical=Math.tan(fov*Math.PI/360)*margin,horizontal=vertical*aspect;
  return corners(g).every(p=>{const v=minus(p,position),depth=dot(v,forward);return depth>.01&&Math.abs(dot(v,right))<=depth*horizontal&&Math.abs(dot(v,up))<=depth*vertical;});
 }
 function orbit(g,aspect){
  if(!(aspect>0)||!Number.isFinite(aspect)||corners(g).some(p=>![p.x,p.y,p.z].every(Number.isFinite)))throw Error('Invalid model bounds or viewport.');
  const width=Math.hypot(g.max.x-g.min.x,g.max.y-g.min.y);
  let low=Math.max(.5,width/2+.1),high=low;
  const allFit=radius=>Array.from({length:VIEWS},(_,i)=>orbitPosition(g,radius,i)).every(p=>fits(g,p,aspect));
  for(let i=0;!allFit(high);i++){if(i===50)throw Error('Unable to frame the model from the current grade.');high*=1.25;}
  if(high>low)for(let i=0;i<32;i++){const mid=(low+high)/2;if(allFit(mid))high=mid;else low=mid;}
  const radius=high*1.002;
  return {radius,width,positions:Array.from({length:VIEWS},(_,i)=>orbitPosition(g,radius,i))};
 }
 function choiceIndex(result){
  const a=result.view-1,b=result.betweenView;
  if(b==null)return a;
  return (a+((b-result.view+8)%8===1?.5:-.5)+8)%8;
 }
 const choiceLabel=result=>result.betweenView==null?`View ${result.view}`:`halfway between Views ${result.view} and ${result.betweenView}`;
 function validateChoice(result){
  if(!result||!Number.isInteger(result.view)||result.view<1||result.view>VIEWS||!Number.isFinite(result.confidence)||result.confidence<0||result.confidence>1||typeof result.explanation!=='string')throw Error('Luna returned an invalid view selection.');
  if(result.betweenView!=null&&(!Number.isInteger(result.betweenView)||result.betweenView<1||result.betweenView>8||![1,7].includes(Math.abs(result.betweenView-result.view))))throw Error('Luna returned non-adjacent views.');
  return result;
 }
 async function database(){return new Promise((resolve,reject)=>{const r=indexedDB.open('firstmeasure-exterior-ai',1);r.onupgradeneeded=()=>r.result.createObjectStore('runs',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Cannot open screenshot storage.'));});}
 async function save(){
  const db=await database();try{await new Promise((resolve,reject)=>{const t=db.transaction('runs','readwrite');t.objectStore('runs').put(run);t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(Error('Screenshot storage failed. Export this run before leaving.'));});}finally{db.close();}
 }
 function download(data,name,type){const url=URL.createObjectURL(new Blob([data],{type})),a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 function reusable(){return !!(run?.front&&run.geometry&&run.radius&&run.steps.filter(s=>s.index&&s.image).length===8);}
 function logResponse(response){
  console.groupCollapsed(`[Exterior AI] ${response.provider||'Luna'} · ${run.id} · call ${(run.attempts||[]).length}`);
  console.log('Full model response',JSON.parse(JSON.stringify(response.rawResponse||response)));
  console.log('Decision',JSON.parse(JSON.stringify(response.result)));
  if(response.distribution)console.table(response.distribution);
  console.groupEnd();
 }
 function distribution(attempts){
  const counts=new Map();
  for(const a of attempts){if(!a.result)continue;const index=choiceIndex(validateChoice(a.result));counts.set(index,(counts.get(index)||0)+1);}
  return [...counts].map(([index,count])=>({index,label:choiceLabel({view:Math.floor(index)+1,betweenView:Number.isInteger(index)?null:(Math.floor(index)+1)%8+1}),count})).sort((a,b)=>b.count-a.count||a.index-b.index);
 }
 function draw(){
  if(!panel)return;
  panel.querySelector('[data-start]').disabled=busy;panel.querySelector('[data-stop]').disabled=!busy;panel.querySelector('[data-export]').disabled=!run;
  panel.querySelector('[data-luna]').disabled=busy||!reusable();panel.querySelector('[data-batch]').disabled=busy||!reusable();
  const log=panel.querySelector('[data-log]');log.replaceChildren();if(!run)return;
  node('p',run.status,log);
  for(const batch of run.batches||[]){const summary=node('section',null,log);summary.dataset.batch=batch.id;node('strong',`Luna sample · ${batch.attempts.length}/${batch.size} completed`,summary);for(const d of distribution(batch.attempts))node('p',`${d.label}: ${d.count}/${batch.size} (${Math.round(d.count/batch.size*100)}%)`,summary);const failures=batch.attempts.filter(a=>a.error).length;if(failures)node('p',`${failures} failed or stopped · excluded from choices`,summary);}
  if(run.response){node('strong',`${run.response.provider||'Luna'} chose ${choiceLabel(run.response.result)}`,log);node('p',run.response.result.explanation,log);node('small',`Confidence: ${Math.round(run.response.result.confidence*100)}% · closest candidate, not an exact match`,log);}
  if(run.attempts?.length){const history=node('details',null,log);node('summary',`${run.attempts.length} AI calls on these captures`,history);for(const a of run.attempts)node('p',`${a.createdAt} · ${a.provider||'Luna'} · ${a.error||choiceLabel(a.result)}`,history);}
  for(const s of run.steps){
   const card=node('section',null,log);if(s.index===run.selectedView&&s.index)card.dataset.selected='true';
   const heading=node('div',null,card);heading.className='ai-view-heading';
   node('strong',s.label+(s.index===run.selectedView&&s.index?' · selected':''),heading);
   if(s.position){const button=node('button','↻',heading);button.type='button';button.title=`Rotate to ${s.label}`;button.setAttribute('aria-label',button.title);button.disabled=busy;button.onclick=()=>rotateTo(s);}
   if(s.position)node('p',run.radius?`${s.angle}° · ${run.radius.toFixed(2)} m radius · ground + 6 ft`:`x ${s.position.x.toFixed(2)}, y ${s.position.y.toFixed(2)} m`,card);
   if(s.image){const a=node('a',null,card);a.href=s.image;a.download=`${run.id}-${s.index ?? 'reference'}.jpg`;const img=node('img',null,a);img.src=s.image;img.alt=s.label;img.style.width='100%';}
   // Earlier coordinate experiments remain inspectable after this upgrade.
   if(s.response)node('p',s.response.result.explanation,card);
  }
 }
 async function checkpoint(status){run.status=status;draw();await save();}
 function check(){
  if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');
  if(!root.WallMode?.enabled||String(root.currentProjectId)!==run.project)throw Error('Project or exterior mode changed; run stopped.');
 }
 async function imageData(src){
  const img=new Image();img.crossOrigin='anonymous';img.src=src;await img.decode();check();
  const c=document.createElement('canvas'),s=Math.min(1,1280/Math.max(img.width,img.height));c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.86);
 }
 function renderTextured(){
  if(!root.ExteriorRendered?.render(renderer,scene,camera))throw Error('Textured rendering is unavailable. No wireframe images were sent.');
 }
 async function waitForTextures(){
  const began=performance.now();
  for(;;){
   check();renderTextured();const status=root.ExteriorRendered.captureStatus;
   if(!status?.active)throw Error('Textured rendering is unavailable.');
   if(status.errors.length)throw Error('A texture failed to load. Reload the editor and retry the capture.');
   if(!status.pending)return;
   if(performance.now()-began>45000)throw Error('Textures are still loading. Retry when they finish.');
   await new Promise(resolve=>setTimeout(resolve,75));
  }
 }
 async function place(g,p,aspect=run.aspect){
  check();const eye=g.toScene(p),target=g.toScene(g.center);
  if(![eye.x,eye.y,eye.z,target.x,target.y,target.z].every(Number.isFinite))throw Error('Camera coordinate conversion failed.');
  if(Math.abs(renderer.domElement.width/renderer.domElement.height-aspect)>.005)throw Error('Viewport resized during capture. Restart to keep all eight views consistent.');
  camera.fov=FOV;camera.zoom=1;camera.aspect=aspect;camera.near=.01;camera.far=Math.max(2000,Math.hypot(eye.x-target.x,eye.y-target.y,eye.z-target.z)*10);camera.up?.set(0,1,0);camera.updateProjectionMatrix();
  const start=camera.position.clone(),startTarget=controls.target.clone(),began=performance.now();
  controls.update();
  await new Promise((resolve,reject)=>{
   function step(now){try{check();const t=Math.min(1,(now-began)/450),u=t*t*(3-2*t);camera.position.lerpVectors(start,eye,u);controls.target.lerpVectors(startTarget,target,u);camera.lookAt(controls.target);camera.updateMatrixWorld();renderTextured();if(t<1)requestAnimationFrame(step);else resolve();}catch(e){reject(e);}}
   requestAnimationFrame(step);
  });
  camera.position.copy(eye);controls.target.copy(target);camera.lookAt(target);camera.updateMatrixWorld();renderTextured();
  return {position:{...p},scenePosition:{x:eye.x,y:eye.y,z:eye.z},target:{x:target.x,y:target.y,z:target.z},fov:FOV,aspect};
 }
 function capture(index){
  renderTextured();const c=document.createElement('canvas'),src=renderer.domElement,s=Math.min(1,1280/Math.max(src.width,src.height));
  c.width=Math.round(src.width*s);c.height=Math.round(src.height*s)+32;
  const ctx=c.getContext('2d');ctx.fillStyle='#182531';ctx.fillRect(0,0,c.width,32);ctx.fillStyle='#fff';ctx.font='bold 20px sans-serif';ctx.fillText(`VIEW ${index}`,12,24);ctx.drawImage(src,0,32,c.width,c.height-32);
  return c.toDataURL('image/jpeg',.87);
 }
 async function ask(provider='Luna'){
  check();const context={task:'Choose one front view or the halfway angle between two adjacent views by visual comparison only.',candidates:VIEWS,heightAboveGroundFeet:6,equalOrbitRadius:true,fieldOfViewDegrees:FOV,aspect:run.aspect,rendering:'textured',imageOrder:['Target front photo',...Array.from({length:VIEWS},(_,i)=>`View ${i+1}`)]};
  const request={provider,mode:'orbit-front-v2',project:run.project,context,images:[run.front,...run.steps.filter(s=>s.index).map(s=>s.image)]};
  const response=await fetch('exterior_ai.php',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:controller.signal});
  let data;try{data=await response.json();}catch(e){throw Error(`AI endpoint returned HTTP ${response.status}.`);}
  if(!response.ok)throw Error(data.error||'AI request failed.');check();validateChoice(data.result);return {context,provider,createdAt:new Date().toISOString(),...data};
 }
 async function start(){
  if(busy)return;busy=true;controller=new AbortController();
  run={id:'orbit-'+Date.now(),project:String(root.currentProjectId),createdAt:new Date().toISOString(),mode:'orbit-front-v2',model:'gpt-6-luna',reasoning:'low',steps:[],attempts:[],status:'Loading front photo…'};draw();
  let orbitControls=null,oldEnabled,oldDamping;
  try{
   const g=root.WallMode.aiGeometry();check();
   if(typeof camera==='undefined'||!camera||!renderer||!controls)throw Error('Open the 3D view first.');
   if(camera.isOrthographicCamera)root.toggleProjection?.();
   if(camera.isOrthographicCamera)throw Error('Switch the 3D view to Perspective before running AI.');
   const settings=JSON.parse(JSON.stringify(root.currentProjectLoadedAppMetadata?.pdfConfig?.exteriorSettings||{})),files=await root.ProjectResources.reportImages(run.project);check();
   root.ExteriorPDF.initializePhotoSlots(settings,files);const front=settings.photoSlots.front.image;
   if(!front)throw Error('Assign a Front photo in report Elevation photos, then try again.');
   run.front=await imageData(front.dataUrl||front.url||('project_resources.php?'+new URLSearchParams({project:run.project,name:front.resourceName})));
   run.steps.push({label:'Front reference',image:run.front});
   run.aspect=renderer.domElement.width/renderer.domElement.height;
   const views=orbit(g,run.aspect);run.radius=views.radius;run.optionPositions=Array.from({length:16},(_,i)=>orbitPosition(g,run.radius,i/2));run.geometry={min:g.min,max:g.max,center:g.center,width:views.width};
   await checkpoint('Preparing textured views…');root.WallMode.prepareAICapture();await waitForTextures();
   orbitControls=controls;oldEnabled=controls.enabled;oldDamping=controls.enableDamping;controls.enabled=false;controls.enableDamping=false;controls.update();
   for(let i=0;i<VIEWS;i++){
    await checkpoint(`Capturing View ${i+1} of 8…`);
    const pose=await place(g,views.positions[i]);await waitForTextures();
    run.steps.push({label:`View ${i+1}`,index:i+1,angle:i*45,...pose,image:capture(i+1)});
    await checkpoint(`View ${i+1} of 8 saved.`);
   }
   await checkpoint('All eight textured views saved. Choose Ask Luna to run or rerun AI.');
  }catch(e){run.status=e.name==='AbortError'?'Stopped. Completed screenshots retained.':e.message;try{await save();}catch(storage){run.status+=' '+storage.message;}}
  finally{if(orbitControls){orbitControls.enabled=oldEnabled;orbitControls.enableDamping=oldDamping;}busy=false;draw();}
 }
 async function sample(){
  if(busy||!reusable())return;busy=true;controller=new AbortController();
  const batch={id:'sample-'+Date.now(),createdAt:new Date().toISOString(),size:10,attempts:[]};
  run.batches||=[];run.batches.push(batch);run.attempts||=[];
  let persistence=Promise.resolve(),storageError=null;
  try{
   check();await checkpoint('Asking Luna 10 times in parallel using the same saved captures…');
   await Promise.all(Array.from({length:10},async(_,i)=>{
    let attempt;const startedAt=new Date().toISOString();
    try{attempt={...await ask('Luna'),batchId:batch.id,sample:i+1,startedAt};}
    catch(e){attempt={provider:'Luna',batchId:batch.id,sample:i+1,startedAt,createdAt:new Date().toISOString(),error:e.name==='AbortError'?'Stopped':e.message};}
    batch.attempts.push(attempt);run.attempts.push(attempt);
    if(attempt.result)logResponse(attempt);
    run.status=`Luna sample: ${batch.attempts.length}/10 completed.`;draw();
    persistence=persistence.then(()=>save()).catch(e=>{storageError=e;});
   }));
   await persistence;batch.completedAt=new Date().toISOString();batch.distribution=distribution(batch.attempts);
   console.groupCollapsed(`[Exterior AI] ${batch.id} · 10-call distribution`);console.table(batch.distribution);console.log('All attempts',JSON.parse(JSON.stringify(batch.attempts)));console.groupEnd();
   await checkpoint(`Sample complete: ${batch.attempts.filter(a=>a.result).length}/10 successful. Camera unchanged.${storageError?' '+storageError.message:''}`);
  }catch(e){run.status=e.message;}
  finally{busy=false;draw();}
 }
 async function infer(provider='Luna'){
  if(busy||!reusable())return;busy=true;controller=new AbortController();draw();
  let orbitControls,oldEnabled,oldDamping;
  try{
   check();await checkpoint(`Asking ${provider} using saved captures…`);
   const response=await ask(provider);run.attempts||=[];run.attempts.push(response);run.response=response;logResponse(response);await save();
   check();const g=root.WallMode.aiGeometry();
   const bounds={min:g.min,max:g.max,center:g.center};
   if(JSON.stringify(bounds)!==JSON.stringify({min:run.geometry.min,max:run.geometry.max,center:run.geometry.center}))throw Error('Model bounds changed. Response saved; capture again before moving to its result.');
   if(camera.isOrthographicCamera)root.toggleProjection?.();
   if(camera.isOrthographicCamera)throw Error('Switch to Perspective first.');
   root.WallMode.prepareAICapture();await waitForTextures();
   orbitControls=controls;oldEnabled=controls.enabled;oldDamping=controls.enableDamping;controls.enabled=false;controls.enableDamping=false;
   run.selectedView=response.result.betweenView==null?response.result.view:null;
   const chosen=choiceLabel(response.result),index=choiceIndex(response.result);
   const position=run.optionPositions?.[index*2]||orbitPosition(g,run.radius,index);
   run.selectedPose=await place(g,position,renderer.domElement.width/renderer.domElement.height);
   await checkpoint(`Finished: ${chosen} selected${response.result.confidence<.65?' with low confidence':''}. Compare with the front photo.`);
  }catch(e){run.status=e.name==='AbortError'?'Stopped. Captures retained.':e.message;try{await save();}catch(storage){run.status+=' '+storage.message;}}
  finally{if(orbitControls){orbitControls.enabled=oldEnabled;orbitControls.enableDamping=oldDamping;}busy=false;draw();}
 }
 async function rotateTo(step){
  if(busy)return;busy=true;controller=new AbortController();draw();
  let oldEnabled,oldDamping,orbitControls;
  try{
   check();const g=root.WallMode.aiGeometry();
   if(camera.isOrthographicCamera)root.toggleProjection?.();
   if(camera.isOrthographicCamera)throw Error('Switch to Perspective first.');
   root.WallMode.prepareAICapture();await waitForTextures();
   orbitControls=controls;oldEnabled=controls.enabled;oldDamping=controls.enableDamping;controls.enabled=false;controls.enableDamping=false;
   await place({...g,center:run.geometry?.center||g.center},step.position,renderer.domElement.width/renderer.domElement.height);
   await checkpoint(`Viewing ${step.label}.`);
  }catch(e){run.status=e.message;}
  finally{if(orbitControls){orbitControls.enabled=oldEnabled;orbitControls.enableDamping=oldDamping;}busy=false;draw();}
 }
 async function previous(){
  if(busy)return;try{const db=await database();const records=await new Promise((resolve,reject)=>{const r=db.transaction('runs').objectStore('runs').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();run=records.filter(r=>r.project===String(root.currentProjectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]||null;draw();if(!run)panel.querySelector('[data-log]').textContent='No saved run for this project in this browser.';}catch(e){panel.querySelector('[data-log]').textContent=e.message;}
 }
 function mount(target){
  panel=target;panel.innerHTML='<p>Experimental · GPT-6 Luna · low reasoning</p><button type="button" data-start>Capture 8 views</button><button type="button" data-luna disabled>Ask Luna</button><button type="button" data-batch disabled>Ask Luna ×10</button><button type="button" data-stop disabled>Stop</button><button type="button" data-previous>Last saved run</button><button type="button" data-export disabled>Export run</button><p>8 textured views · 45° apart · one fitted distance · 6 ft above grade. Luna chooses a view or the midpoint between neighboring views. Capture once, then rerun AI on the same images. Full responses log in the console and save with this run. Click an image to download.</p><div data-log aria-live="polite"></div>';
  panel.querySelector('[data-start]').onclick=start;panel.querySelector('[data-luna]').onclick=()=>infer('Luna');panel.querySelector('[data-batch]').onclick=sample;panel.querySelector('[data-stop]').onclick=()=>controller?.abort();panel.querySelector('[data-previous]').onclick=previous;panel.querySelector('[data-export]').onclick=()=>run&&download(JSON.stringify(run,null,2),run.id+'.json','application/json');
  const style=node('style',null,document.head);style.textContent='#exterior-debug-ai{overflow-wrap:anywhere}#exterior-debug-ai button{width:100%;margin:3px 0}#exterior-debug-ai .ai-view-heading{display:flex;align-items:center;justify-content:space-between;gap:4px}#exterior-debug-ai .ai-view-heading button{width:26px;flex:0 0 26px;margin:0}#exterior-debug-ai section{border-top:1px solid #53606a;margin-top:10px;padding-top:8px}#exterior-debug-ai section[data-selected]{border:2px solid #64d9a3;padding:5px}#exterior-debug-ai p{font-size:11px;line-height:1.45}';
 }
 root.ExteriorAI={available:root.FIRSTMEASURE_EXTERIOR_AI===true,mount,orbit,orbitPosition,fits,validateChoice,choiceIndex,distribution};
})(window);
