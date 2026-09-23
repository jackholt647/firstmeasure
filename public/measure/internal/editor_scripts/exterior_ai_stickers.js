/* Owner-only development experiment: opaque face matching and optional undoable sticker placement. */
(function(root){'use strict';
 const node=(tag,text,parent)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(parent)parent.appendChild(e);return e;};
 let linkedRunId=null;
 const copy=x=>JSON.parse(JSON.stringify(x));
 let panel,project,photos=[],runs=[],current=null,busy=false,aborter;
 let sortKey='face',sortDirection=1;
 const field=name=>panel.querySelector(`[data-${name}]`);
 const sameProject=()=>String(root.currentProjectId)===project&&root.WallMode?.enabled;
 function check(){if(aborter?.signal.aborted)throw new DOMException('Stopped','AbortError');if(!sameProject())throw Error('Project or exterior mode changed.');}
 function option(select,value,label){const o=node('option',label,select);o.value=value;return o;}
 function labelPhotos(images){
  const settings=copy(root.currentProjectLoadedAppMetadata?.pdfConfig?.exteriorSettings||{});
  root.ExteriorPDF?.initializePhotoSlots(settings,images);
  const names={front:'Front',back:'Back',left:'Left side',right:'Right side','front-left':'Front left','front-right':'Front right','back-left':'Back left','back-right':'Back right',side:'Side'};
  return images.map(p=>{
   const matches=Object.entries(settings.photoSlots||{}).filter(([,s])=>s.image&&((p.key&&s.image.key===p.key)||(p.resourceName&&s.image.resourceName===p.resourceName)||(p.url&&s.image.url===p.url)));
   const manual=matches.filter(([,s])=>s.assignment==='manual'),assigned=(manual.length?manual:matches).map(([slot])=>slot);
   const slots=assigned.length?assigned:[p.slot],directions=slots.map(s=>names[s]).filter(Boolean);
   return {...p,slot:assigned[0]||p.slot,label:`${directions.join(' / ')||'Unassigned'} · ${p.label||p.key}`};
  });
 }
 function select(parent,key,title,values){const label=node('label',title,parent),s=node('select',null,label);s.dataset[key]='';s.setAttribute('aria-label',title);for(const [v,t]of values)option(s,v,t);return s;}
 async function db(){return new Promise((resolve,reject)=>{const q=indexedDB.open('firstmeasure-exterior-stickers',1);q.onupgradeneeded=()=>q.result.createObjectStore('runs',{keyPath:'id'});q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(Error('Cannot open sticker history.'));});}
 async function store(record){const d=await db();try{await new Promise((resolve,reject)=>{const t=d.transaction('runs','readwrite');t.objectStore('runs').put(copy(record));t.oncomplete=resolve;t.onerror=t.onabort=()=>reject(Error('History storage failed; export this run.'));});}finally{d.close();}}
 async function load(){const d=await db();try{return await new Promise((resolve,reject)=>{const q=d.transaction('runs').objectStore('runs').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});}finally{d.close();}}
 function controls(){for(const e of panel.querySelectorAll('select,input'))e.disabled=busy;field('effort').options[0].disabled=field('model').value==='gpt-6-astra';field('run').disabled=busy||root.ExteriorAI?.busy;field('stop').disabled=!busy;}
 function history(){const s=field('history');s.replaceChildren();option(s,'','New run');for(const r of runs)option(s,r.id,`${new Date(r.createdAt).toLocaleTimeString()} · ${r.config.model.replace('gpt-6-','')} · ${r.config.style==='all'?'All':'Each'} · ${r.config.output==='placements'?'Placements':'Counts'} · ${r.status}`);s.value=current?.id||'';}
 function summaryText(response){return (response?.rawResponse?.output||[]).filter(o=>o.type==='reasoning').flatMap(o=>(o.summary||[]).map(s=>s.text||'')).join('\n');}
 function show(){
  if(!panel)return;controls();const body=field('results');body.replaceChildren();if(!current)return;
  node('p',current.status,body);node('small',`${current.config.model.replace('gpt-6-','')} · ${current.config.effort} · ${current.config.style==='all'?'All faces':'Per face'} · ${current.config.output==='placements'?'Placements':'Counts'}`,body);
  for(const error of new Set((current.faces||[]).map(f=>f.error).filter(Boolean))){const e=node('p',error,body);e.setAttribute('role','alert');e.style.color='#ffb9a8';}
  if(current.application)node('p',`${current.application.placed} stickers added · ${current.application.skipped.length} skipped · Ctrl+Z to undo`,body);
  const table=node('table',null,body),head=node('tr',null,node('thead',null,table));
  for(const [key,title,label]of [['face','Face','face number'],['windows','W','windows'],['doors','D','doors'],['garageDoors','G','garage doors']]){
   const th=node('th',null,head),active=sortKey===key;th.scope='col';th.setAttribute('aria-sort',active?(sortDirection===1?'ascending':'descending'):'none');
   const button=node('button',title+(active?(sortDirection===1?' ↑':' ↓'):''),th);button.type='button';button.dataset.sort=key;button.setAttribute('aria-label',`Sort by ${label}`);button.title=`Sort by ${label}`;button.style.cssText='margin:0;padding:2px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer';
   button.onclick=()=>{sortDirection=sortKey===key?-sortDirection:key==='face'?1:-1;sortKey=key;show();panel.querySelector(`[data-sort="${key}"]`).focus();};
  }
  const rows=node('tbody',null,table);table.setAttribute('aria-label','Sticker counts by face');
  const results=new Map((current.rows||[]).map(r=>[r.face,r]));
  const faces=[...(current.faces||[])].sort((a,b)=>{
   const av=sortKey==='face'?a.number:results.get(a.number)?.[sortKey],bv=sortKey==='face'?b.number:results.get(b.number)?.[sortKey];
   const ak=Number.isFinite(av),bk=Number.isFinite(bv);if(ak!==bk)return ak?-1:1;
   return (ak?(av-bv)*sortDirection:0)||a.number-b.number;
  });
  for(const f of faces){const result=results.get(f.number),tr=node('tr',null,rows);tr.tabIndex=0;tr.setAttribute('aria-label',`Select face ${f.number}`);if(current.selected===f.number)tr.dataset.selected='true';
   for(const value of [f.number,...['windows','doors','garageDoors'].map(k=>result?result[k]??'?':f.error?'!':'…')])node('td',String(value),tr);
   tr.title=result?.evidence||f.error||'Click to select this face';tr.onclick=()=>{try{if(!sameProject()||current.project!==project)throw Error('Open this run’s project first.');root.WallMode.selectAIFace(f.id,f.signature);current.selected=f.number;show();}catch(e){field('notice').textContent=e.message;}};tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tr.click();}};
  }
  node('small','W windows · D doors · G garages · ? uncertain · ! failed',body);
  const details=node('details',null,body);node('summary','Inputs & evidence',details);
  for(const [label,src]of [['Photo',current.photo],['Numbered faces',current.image]])if(src){node('small',label,details);const a=node('a',null,details);a.href=src;a.download=`${current.id}-${label}.jpg`;const img=node('img',null,a);img.src=src;img.alt=label;}
  for(const f of current.faces||[]){const r=current.rows?.find(r=>r.face===f.number);node('p',`Face ${f.number}: ${f.error||r?.evidence||'Pending'}`,details);}
  for(const item of current.application?.skipped||[])node('p',`Face ${item.face}${item.opening?' / opening '+item.opening:''}: ${item.message}`,details);
  for(const row of current.rows||[])for(const p of row.placements||[])node('p',`Face ${row.face} ${p.type}: ${p.xAnchor||'left'} ${p.x}%, ${p.yAnchor||'top'} ${p.y}%, width ${p.width}%, ${p.aspectRatio!==undefined?'width:height '+p.aspectRatio+':1':'height '+p.height+'%'}`,details);
  for(const response of current.responses||[]){const text=summaryText(response);if(text)node('p',text,details);}
  const exportLink=node('a','Export run JSON',details);exportLink.href='#';exportLink.onclick=e=>{e.preventDefault();const url=URL.createObjectURL(new Blob([JSON.stringify(current,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download=current.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 }
 async function imageData(src){const img=new Image();img.crossOrigin='anonymous';img.src=src;await img.decode();check();const c=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(img.width,img.height));c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);c.getContext('2d').drawImage(img,0,0,c.width,c.height);return c.toDataURL('image/jpeg',.9);}
 // ID-buffer visibility accounts for occlusion and holes, rather than normal direction alone.
 function captureFaces(source,sourceCamera,width,height,withPlacements=false){
  const T=root.THREE,K=root.ExteriorGeometry,c=sourceCamera.clone();c.position.copy(sourceCamera.getWorldPosition(new T.Vector3()));c.quaternion.copy(sourceCamera.getWorldQuaternion(new T.Quaternion()));c.updateMatrixWorld(true);
  const r=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});r.setSize(width,height,false);r.setPixelRatio(1);r.toneMapping=T.NoToneMapping;
  const s=new T.Scene();s.background=new T.Color(0);const meshes=[],candidates=new Map(source.faces.map((f,i)=>[f.id,{...copy(f),code:i+1}]));
  const target=new T.WebGLRenderTarget(width,height,{depthBuffer:true});const pixels=new Uint8Array(width*height*4);
  try{
   for(const f of source.occluders){if(!f.points?.length)continue;const frame=K.frame(f);if(!frame)continue;const rings=[f.points,...(f.holes||[])],flat=rings.flat(),local=p=>K.local(frame,p);let triangles;try{triangles=K.triangles(rings[0].map(local),rings.slice(1).map(h=>h.map(local))).triangles;}catch(e){throw Error(`Cannot render face ${f.id||'occluder'}: ${e.message}`);}
    const curved=f.curvedSurface?.logical?K.surfaceMesh(f):null;const geometry=new T.BufferGeometry().setFromPoints((curved?curved.positions:flat).map(source.toScene));geometry.setIndex((curved?curved.triangles:triangles).flat());geometry.computeVertexNormals();const code=candidates.get(f.id)?.code||0;
    const material=new T.MeshBasicMaterial({side:T.DoubleSide,toneMapped:false});material.color.setRGB((code&255)/255,((code>>8)&255)/255,0);
    const mesh=new T.Mesh(geometry,material);mesh.userData.faceId=f.id;mesh.userData.code=code;s.add(mesh);meshes.push(mesh);
   }
   r.setRenderTarget(target);r.render(s,c);r.readRenderTargetPixels(target,0,0,width,height,pixels);r.setRenderTarget(null);
   const visible=new Map();for(let i=0;i<width*height;i++){const code=pixels[i*4]+pixels[i*4+1]*256;if(!code)continue;let v=visible.get(code);if(!v){v={count:0,x:0,y:0,indices:[]};visible.set(code,v);}v.count++;v.x+=i%width;v.y+=height-1-Math.floor(i/width);v.indices.push(i);}
   const faces=[...candidates.values()].filter(f=>(visible.get(f.code)?.count||0)>=64).sort((a,b)=>a.id.localeCompare(b.id)).map((f,i)=>{const v=visible.get(f.code),cx=v.x/v.count,cy=v.y/v.count;let best=v.indices[0],dist=Infinity;for(const p of v.indices){const d=(p%width-cx)**2+(height-1-Math.floor(p/width)-cy)**2;if(d<dist){dist=d;best=p;}}return {id:f.id,signature:f.signature,number:i+1,code:f.code,x:best%width,y:height-1-Math.floor(best/width),visiblePixels:v.count};});
   if(withPlacements){
    const originals=new Map(source.faces.map(f=>[f.id,f]));
    const screen=p=>{const q=source.toScene(p).clone().project(c);return {x:(q.x+1)*50,y:(1-q.y)*50};};
    for(const f of faces)try{
     const face=originals.get(f.id),frame=root.WallFeatures.percentageFrame(face,screen),b=frame.bounds,w=b.right-b.left,h=b.top-b.bottom;
     f.placementFrame=frame;
     const local=p=>root.WallSolidGeometry.inFrame(frame,p);
     f.placementHint={face:f.number,supported:true,aspect:w/h,outline:face.points.map(p=>{const q=local(p);return {x:100*(q.x-b.left)/w,y:100*(b.top-q.y)/h};}),cornersInModelImage:[{x:b.left,y:b.top,z:0},{x:b.right,y:b.top,z:0},{x:b.right,y:b.bottom,z:0},{x:b.left,y:b.bottom,z:0}].map(p=>screen(root.WallSolidGeometry.fromFrame(frame,p)))};
    }catch(e){f.placementError=e.message;f.placementHint={face:f.number,supported:false};}
   }
   if(!faces.length)throw Error('No visible wall faces. Aim the camera at the building.');if(faces.length>60)throw Error('More than 60 visible faces. Move closer or choose a narrower view.');
   const byCode=new Map(faces.map(f=>[f.code,f]));
   // Opaque context; only real visible pixels determine labels and inclusion.
   // Offset fills behind their outlines to prevent broken lines from depth fighting.
   for(const mesh of meshes){mesh.material.polygonOffset=true;mesh.material.polygonOffsetFactor=1;mesh.material.polygonOffsetUnits=1;const edge=new T.LineSegments(new T.EdgesGeometry(mesh.geometry,20),new T.LineBasicMaterial({color:0x34414b}));s.add(edge);}
   // Visible face-ID transitions retain even coplanar boundaries, without hidden edges.
   const borders=document.createElement('canvas');borders.width=width;borders.height=height;
   const borderContext=borders.getContext('2d'),borderData=borderContext.createImageData(width,height);
   const codeAt=i=>pixels[i*4]+pixels[i*4+1]*256;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x,code=codeAt(i);
    if((x+1<width&&code!==codeAt(i+1))||(y+1<height&&code!==codeAt(i+width))){
     const j=((height-1-y)*width+x)*4;borderData.data.set([35,49,61,255],j);
    }
   }
   borderContext.putImageData(borderData,0,0);
   function image(highlight=null){
    s.background.set(0xe7edf1);for(const mesh of meshes){const f=byCode.get(mesh.userData.code);mesh.material.color.set(f?(highlight===f.number?0xffbb33:highlight?0xaebcc5:0xc3cfd8):0x7b8794);}
    r.render(s,c);const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.drawImage(r.domElement,0,0);ctx.drawImage(borders,0,0);ctx.font='bold 17px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
    for(const f of faces){if(highlight&&f.number!==highlight)continue;const text=String(f.number),w=ctx.measureText(text).width+10;ctx.fillStyle='#142535';ctx.fillRect(f.x-w/2,f.y-12,w,24);ctx.fillStyle='#fff';ctx.fillText(text,f.x,f.y);}
    return canvas.toDataURL('image/jpeg',.9);
   }
   const imageAll=image();return {faces,image:imageAll,highlights:Object.fromEntries(faces.map(f=>[f.number,image(f.number)])),pose:{position:c.position.toArray(),quaternion:c.quaternion.toArray(),projection:c.projectionMatrix.toArray(),aspect:c.aspect}};
  }finally{s.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});target.dispose();r.dispose();r.forceContextLoss();}
 }
 function validateRows(value,ids,output='counts',sizing='percent-height'){
  if(!Array.isArray(value)||value.length!==ids.length)throw Error('Model returned the wrong face count.');const seen=new Set();
  for(const r of value){if(!ids.includes(r.face)||seen.has(r.face)||typeof r.evidence!=='string')throw Error('Model returned unknown or duplicate faces.');seen.add(r.face);for(const k of ['windows','doors','garageDoors'])if(r[k]!==null&&(!Number.isInteger(r[k])||r[k]<0||r[k]>100))throw Error('Invalid opening count.');}
  if(output==='placements')for(const r of value){
   if(!Array.isArray(r.placements)||r.placements.length>100)throw Error('Invalid placement list.');
   const counts={window:0,door:0,garage:0},anchored=sizing==='width-aspect-anchors';
   for(const p of r.placements){if(!Object.hasOwn(counts,p.type)||!['x','y','width'].every(k=>Number.isFinite(p[k]))||Math.abs(p.x)>100||Math.abs(p.y)>100||p.width<=0||p.width>100||(!anchored&&(p.x<0||p.y<0||p.x+p.width>100.000001))||((sizing==='width-aspect'||anchored)?(!Number.isFinite(p.aspectRatio)||p.aspectRatio<.05||p.aspectRatio>20):(!Number.isFinite(p.height)||p.height<=0||p.y+p.height>100.000001)))throw Error('Invalid placement percentages.');if(anchored&&(!['left','center','right'].includes(p.xAnchor)||!['top','center','bottom'].includes(p.yAnchor)||(p.xAnchor!=='center'&&p.x<0)||(p.yAnchor!=='center'&&p.y<0)))throw Error('Invalid opening anchor.');counts[p.type]++;}
   for(const [type,key]of [['window','windows'],['door','doors'],['garage','garageDoors']])if(counts[type]>(r[key]??0))throw Error('Placements exceed the reported count.');
  }
  return value;
 }
 async function ask(record,faces,image){
  check();const response=await fetch('exterior_ai.php',{method:'POST',headers:{'Content-Type':'application/json'},signal:aborter.signal,body:JSON.stringify({mode:'stickers-v1',project,model:record.config.model,effort:record.config.effort,style:record.config.style,output:record.config.output||'counts',placementSizing:record.config.placementSizing,faceHints:record.config.output==='placements'?faces.map(f=>f.placementHint):undefined,faceIds:faces.map(f=>f.number),images:[record.photo,image]})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'AI request failed.');check();validateRows(data.result?.faces,faces.map(f=>f.number),record.config.output,record.config.placementSizing);console.groupCollapsed(`[Exterior stickers] ${record.id} · ${record.config.model} · faces ${faces.map(f=>f.number)}`);console.log('Full response',copy(data));console.table(data.result.faces);console.groupEnd();return data;
 }
 async function run(){
  if(busy||root.ExteriorAI?.busy)return;busy=true;aborter=new AbortController();controls();field('notice').textContent='Preparing visible faces…';let record;
  try{
   check();const config={model:field('model').value,effort:field('effort').value,style:field('style').value,output:field('output').value,placementSizing:'width-aspect-anchors',photo:field('photo').value,view:field('view').value};
   const rotation=root.ExteriorAI.context();if(config.view!=='current'){const pose=config.view==='rotation'?rotation?.selectedPose:rotation?.steps.find(f=>String(f.index)===config.view);if(!pose)throw Error('Choose a current or saved rotation view.');const status=await root.ExteriorAI.useView({...pose,label:'sticker input'});if(!status?.startsWith('Viewing'))throw Error(status||'Unable to set the selected view.');}
   check();let photo;if(config.photo==='upload'){const file=field('upload').files[0];if(!file)throw Error('Choose a photo file.');const url=URL.createObjectURL(file);try{photo=await imageData(url);}finally{URL.revokeObjectURL(url);}}else if(config.photo==='rotation'){if(!rotation?.front)throw Error('Choose a project photo or run Rotation first.');photo=rotation.front;}else{const p=photos.find(p=>p.key===config.photo);if(!p)throw Error('Choose a photograph.');photo=await imageData(p.url);}
   check();const source=root.WallMode.aiStickerScene(),aspect=renderer.domElement.width/renderer.domElement.height,width=Math.min(1280,renderer.domElement.width),height=Math.round(width/aspect),captured=captureFaces(source,camera,width,height,config.output==='placements');
   record={id:'stickers-'+Date.now(),project,createdAt:new Date().toISOString(),config,photo,...captured,rows:[],responses:[],status:'Running'};current=record;runs.unshift(record);history();show();await store(record);
   const jobs=config.style==='all'?[captured.faces]:captured.faces.map(f=>[f]);let next=0,completed=0,saveQueue=Promise.resolve(),storageError=null;
   await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{for(;;){const index=next++;if(index>=jobs.length)return;const faces=jobs[index];try{check();const result=await ask(record,faces,config.style==='all'?record.image:record.highlights[faces[0].number]);record.responses.push(result);record.rows.push(...result.result.faces);}catch(e){for(const f of faces)f.error=e.name==='AbortError'?'Stopped':e.message;}completed++;record.status=`${completed}/${jobs.length} calls · ${record.rows.length}/${record.faces.length} faces`;if(current===record)show();saveQueue=saveQueue.then(()=>store(record)).catch(e=>{storageError=e;});}}));
   await saveQueue;record.status=record.faces.some(f=>f.error)?'Finished with errors':'Finished';
   if(config.output==='placements'){check();record.application=root.WallMode.applyAIPlacements(record);if(record.application.skipped.length)record.status+=' · some placements skipped';}
   if(storageError)record.status+=' · '+storageError.message;await store(record);field('notice').textContent='';history();
  }catch(e){field('notice').textContent=e.message;if(record){record.status=e.message;try{await store(record);}catch{}}}
  finally{busy=false;show();}
 }
 function refreshRotation(){
  const r=root.ExteriorAI.context();if(!r||r.project!==project)return;
  const v=field('view'),p=field('photo'),oldView=v.value,oldPhoto=p.value;
  v.replaceChildren();option(v,'current','Current camera');if(r.selectedPose)option(v,'rotation','Rotation result');for(const f of r.steps.filter(f=>f.index))option(v,String(f.index),f.label);
  if(r.front&&!Array.from(p.options).some(o=>o.value==='rotation'))option(p,'rotation','Front · rotation photo');
  v.value=oldView;if(!v.value)v.value='current';p.value=oldPhoto;
  if(r.id!==linkedRunId){if(r.selectedPose)v.value='rotation';if(r.front)p.value='rotation';linkedRunId=r.id;}p.onchange();
 }
 async function mount(target){
  if(busy)return;if(panel===target&&project===String(root.currentProjectId)){refreshRotation();controls();return;}panel=target;project=String(root.currentProjectId);current=null;runs=[];panel.replaceChildren();
  const rotation=root.ExteriorAI.context(),linked=rotation?.project===project;linkedRunId=linked?rotation.id:null;
  select(panel,'model','Model',[['gpt-6-luna','Luna'],['gpt-6-sol','Sol'],['gpt-6-astra','Astra']]);
  const effort=select(panel,'effort','Thinking',[['none','None'],['low','Low'],['medium','Medium'],['high','High'],['xhigh','Extra high'],['max','Maximum']]);effort.value='low';field('model').onchange=()=>{effort.options[0].disabled=field('model').value==='gpt-6-astra';if(effort.options[0].disabled&&effort.value==='none')effort.value='low';};
  select(panel,'style','Ask',[['all','All faces · one call'],['each','Each face · parallel']]);
  select(panel,'output','Output',[['counts','Counts only'],['placements','Counts + placements']]);
  const view=select(panel,'view','View',[['current','Current camera']]);if(linked&&rotation.selectedPose)option(view,'rotation','Rotation result');if(linked)for(const f of rotation.steps.filter(f=>f.index))option(view,String(f.index),f.label);if(linked&&rotation.selectedPose)view.value='rotation';
  const photo=select(panel,'photo','Photo',[]);if(linked&&rotation.front)option(photo,'rotation','Front · rotation photo');option(photo,'upload','Upload photo…');
  const upload=node('input',null,panel);upload.type='file';upload.accept='image/*';upload.dataset.upload='';upload.setAttribute('aria-label','Upload sticker reference photo');upload.hidden=photo.value!=='upload';photo.onchange=()=>upload.hidden=photo.value!=='upload';
  const actions=node('div',null,panel);actions.className='sticker-actions';const go=node('button','Run',actions);go.type='button';go.dataset.run='';go.onclick=run;const stop=node('button','Stop',actions);stop.type='button';stop.dataset.stop='';stop.onclick=()=>aborter?.abort();stop.disabled=true;
  const h=select(panel,'history','History',[]);h.onchange=()=>{current=runs.find(r=>r.id===h.value)||null;field('notice').textContent='';show();};const notice=node('p',null,panel);notice.dataset.notice='';notice.setAttribute('role','status');const results=node('div',null,panel);results.dataset.results='';results.setAttribute('aria-live','polite');
  if(!document.getElementById('sticker-ai-style')){const style=node('style',null,document.head);style.id='sticker-ai-style';style.textContent='#ai-stickers label{display:block;font-size:11px;margin:5px 0}#ai-stickers select,#ai-stickers input{width:100%;min-width:0;box-sizing:border-box;font-size:11px}#ai-stickers .sticker-actions{display:flex;gap:4px}#ai-stickers table{width:100%;border-collapse:collapse;font-size:12px}#ai-stickers td,#ai-stickers th{text-align:center;padding:5px 2px;border-bottom:1px solid #ffffff25}#ai-stickers tbody tr{cursor:pointer}#ai-stickers tr[data-selected],#ai-stickers tbody tr:hover{background:#436082}#ai-stickers small{font-size:10px}#ai-stickers details{margin-top:8px;font-size:11px}#ai-stickers img{width:100%}#ai-stickers [hidden]{display:none!important}';}
  controls();const activeProject=project;
  try{const [images,saved]=await Promise.all([root.ProjectResources.reportImages(project),load()]);if(project!==activeProject||String(root.currentProjectId)!==activeProject)return;photos=labelPhotos(images);runs=saved.filter(r=>r.project===project).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));for(const p of photos)option(photo,p.key,p.label);if(!linked||!rotation.front){const front=photos.find(p=>p.slot==='front')||photos[0];if(front)photo.value=front.key;}photo.onchange();history();if(runs.length){current=runs[0];h.value=current.id;}show();}catch(e){notice.textContent=e.message;}
 }
 root.ExteriorAIStickers={mount,captureFaces,validateRows,get busy(){return busy;}};
})(window);
