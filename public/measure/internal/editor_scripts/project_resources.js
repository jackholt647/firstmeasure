/* Internal reference viewer. Storage is independent of geometry and report state. */
(() => {
 'use strict';
 const roleName = role => ({qa:'QA',tech:'Tech',customer:'Customer'}[role] || 'Tech');
 const currentRole = () => {const p=new URLSearchParams(window.location.search);return p.has('qa_embed')||p.has('qa_feedback_editor')?'qa':'tech';};
 function referenceCatalog(bundle={},artifactUrl){
  const manifest=bundle.manifest||{},meta=bundle.app_metadata||{},result=[],seen=new Set();
  const add=(role,key,notes,images=[])=>{
   if(notes){const name='reference-note-'+key;if(!seen.has(name)){seen.add(name);result.push({name,original_name:roleName(role)+' notes',role,notes:String(notes),reference:true,size:0});}}
   for(const [i,value]of (Array.isArray(images)?images:[]).entries()){
    const item=typeof value==='string'?{url:value}:value;if(!item)continue;
    const raw=String(item.dataUrl||item.url||item.file_name||item.name||'');if(!raw)continue;
    const src=/^(https?:|data:image\/|\/)/i.test(raw)?raw:!/[\\/]/.test(raw)?artifactUrl(raw):'';if(!src||seen.has(role+src))continue;seen.add(role+src);
    result.push({name:'reference-'+key+'-'+i,original_name:item.original_name||item.name||item.file_name||raw.split('/').pop()||'Reference',role,src,resource_name:item.resource_name,slot:item.elevation_view||item.slot,reference:true,size:item.size||0});
   }
  };
  add('customer','order',manifest.tech_notes);
  const elevationPhotos=manifest.elevation_photos||meta.elevation_photos||{};
  add('customer','elevations','',Array.isArray(elevationPhotos)?elevationPhotos:Object.entries(elevationPhotos).map(([slot,image])=>({...typeof image==='string'?{url:image}:image,elevation_view:slot})));
  for(const [i,r]of (manifest.resubmissions||[]).entries())add('customer','resubmission-'+i,r.notes,r.images);
  const sources=meta.submission_sources||manifest.submission_sources||bundle.pdf_state?.finalizeSources||meta.pdfConfig?.finalizeSources||{};
  add('tech','submission',sources.notes,sources.images);
  for(const scope of ['qa','manager']){
   const threads=new Map();for(const t of [...(manifest[scope+'_threads']||[]),...(meta.qa_thread_drafts?.[scope]?.threads||[])])threads.set(t.id,t);
   for(const [id,t]of threads)for(const [i,m]of (t.history||[]).entries())add(m.role==='drafter'||m.role==='tech'?'tech':'qa',scope+'-'+id+'-'+i,m.text,m.images);
  }
  return result;
 }
 const coreSlots=[['back-left','Back left'],['back','Back'],['back-right','Back right'],['left','Left'],[null,'House'],['right','Right'],['front-left','Front left'],['front','Front'],['front-right','Front right']];
 function coreViews(files){return coreSlots.map(([slot,title])=>({slot,title,file:slot?files.find(f=>(f.elevation_view||f.slot)===slot&&!f.notes):null}));}
 if(typeof module!=='undefined'&&module.exports){module.exports={referenceCatalog,coreViews};return;}
 function boot() {
  const host = document.getElementById('google-earth-wrapper'), tabs = host?.querySelector('.map-view-tabs');
  if (!host || !tabs) return;
  const css = document.createElement('link'); css.rel = 'stylesheet';
  css.href = 'editor_scripts/project_resources.css?' + (document.querySelector('script[src*="project_resources.js"]')?.src.split('?')[1] || ''); document.head.append(css);
  const tab = document.createElement('button'); tab.className = 'map-tab'; tab.id = 'tabResources'; tab.textContent = 'Resources'; tabs.append(tab);
  const icon = name => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+({
   files:'<path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3"/>',upload:'<path d="M12 16V3m-4 4 4-4 4 4M4 15v6h16v-6"/>',
   markup:'<path d="m4 16 12-12 4 4L8 20H4zm9-9 4 4"/>',notes:'<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
   frames:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4"/>',
   overlay:'<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M8 17v4h13V8h-4M5 13l4-4 6 6"/>',
   qa:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zm-4 9 3 3 5-6"/>',
   tech:'<path d="M14 6a5 5 0 0 0-6 6L3 17l4 4 5-5a5 5 0 0 0 6-6l-3 3-4-4z"/>',
   customer:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-3a8 8 0 0 1 16 0v3"/>',
   expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'
  }[name]||'')+'</svg>';
  const panel = document.createElement('section'); panel.id = 'project-resources'; panel.hidden = true; panel.setAttribute('aria-label', 'Internal project resources');
  panel.innerHTML = `
   <div class="resource-toolbar" role="toolbar" aria-label="Resource viewer">
    <button data-action="files" aria-expanded="true" aria-controls="resource-library" title="Project files">${icon('files')} <span class="resource-action-label">Files</span><span class="resource-count"></span></button>
    <button data-action="upload" aria-label="Add files" title="Add files">${icon('upload')}</button>
    <span class="resource-filename">Project resources</span>
    <button data-action="overlay" disabled title="Use this still image behind the 3D model" aria-label="Use image as 3D background">${icon('overlay')}<span>Overlay</span></button>
    <button data-action="markup" aria-expanded="false" aria-controls="resource-inspector" title="Open markup tools">${icon('markup')} <span class="resource-action-label">Markup</span></button>
    <button data-action="favorites" aria-expanded="false" title="Saved video frames">${icon('frames')} <span class="resource-action-label">Frames</span></button>
    <button data-action="notes" aria-expanded="false" aria-controls="resource-inspector" title="Reference notes">${icon('notes')} <span class="resource-action-label">Notes</span><span class="resource-notes-dot" hidden>•</span></button>
    <button data-action="save" class="resource-save" hidden>Save</button>
    <button data-action="more" aria-expanded="false" aria-label="More resource actions" title="More actions">···</button>
    <button data-action="expand" aria-label="Expand resources" title="Expand resources">${icon('expand')}</button>
   </div>
   <input class="resource-files" type="file" multiple hidden>
   <div class="resource-more" hidden><button data-action="download">Download original</button><button data-action="refresh">Refresh project files</button></div>
   <div class="resource-body">
    <aside id="resource-library" class="resource-library" aria-label="Project files">
     <div class="resource-tray-heading"><strong>Project files <small>INTERNAL</small></strong><button data-action="files" aria-label="Close files">×</button></div>
     <button data-action="coreViews" class="resource-core-button" aria-pressed="false">&#9638; Core views</button><div class="resource-file-list"></div>
    </aside>
    <main class="resource-content">
     <div class="resource-stage" tabindex="0" aria-label="Media viewer. Wheel to zoom, drag to pan, double-click to fit.">
      <div class="resource-empty"><strong>Project references</strong><span>Open a saved project to add photos and walkthrough videos.</span></div>
      <canvas hidden></canvas><div class="resource-player" hidden></div><div class="resource-core-grid" aria-label="Core house views" hidden></div>
      <form class="resource-favorite-entry" hidden><label>Favorite this frame<input maxlength="160" aria-label="Favorite frame label" placeholder="Back of house…" autocomplete="off"></label><span>Enter to save · Esc to cancel</span><button type="submit">Save frame</button></form>
      <button data-action="returnVideo" class="resource-jump-frame" hidden>Jump to video frame</button>
      <div class="resource-view-controls" role="toolbar" aria-label="Media zoom" hidden>
       <button data-action="zoomOut" aria-label="Zoom out" title="Zoom out">−</button><button data-action="fit" class="resource-zoom-level" title="Zoom relative to fit; click to reset">100%</button><button data-action="zoomIn" aria-label="Zoom in" title="Zoom in">＋</button>
       <i></i><button data-action="fit" title="Fit the entire image or video">Fit</button><button data-action="fill" title="Fill the viewer, cropping the edges">Fill</button>
      </div>
     </div>
     <div class="resource-transport" role="group" aria-label="Playback controls" hidden>
      <button data-action="play" aria-label="Play" title="Play / pause (Space)">▶</button>
      <button data-action="favorite" aria-label="Add frame note (N)" aria-keyshortcuts="N" title="Add a frame note (N)">☆ Note</button>
      <input class="resource-seek" type="range" min="0" max="100" step="0.01" value="0" aria-label="Seek video">
      <span class="resource-time">0:00 / 0:00</span>
      <button data-action="mute" aria-label="Mute" title="Mute audio">♪</button>
      <select class="resource-rate" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
     </div>
    </main>
    <aside id="resource-inspector" class="resource-inspector" aria-label="Resource tools" hidden>
     <div class="resource-tray-heading"><strong class="resource-inspector-title">Markup</strong><button data-action="closeInspector" aria-label="Close tools">×</button></div>
     <div class="resource-favorites-pane" hidden><p class="resource-help">Click ☆ Note or press N within Resources, type a label, then press Enter. Select a frame to mark it up, or its timestamp to jump to the video.</p><div class="resource-favorites-list"></div></div>
     <div class="resource-markup-pane">
      <div class="resource-frame-help" hidden><span>Draw on a still frame. The source video stays unchanged.</span><button data-action="frame">Mark this frame</button></div>
      <div class="resource-tools" role="toolbar" aria-label="Markup tools">
       <button data-tool="select">↖ Select</button><button data-tool="pen">✎ Pen</button><button data-tool="circle">○ Circle</button><button data-tool="arrow">↗ Arrow</button><button data-tool="line">╱ Line</button><button data-tool="rect">□ Box</button><button data-tool="note">T Text</button>
      </div>
      <div class="resource-stroke"><label>Color <input type="color" class="resource-color" value="#ffcc33" aria-label="Markup color"></label><div class="resource-width" role="group" aria-label="Stroke width"><button data-width="2" aria-label="Thin stroke" title="Thin stroke" aria-pressed="false"><span style="--dot:6px"></span></button><button data-width="4" aria-label="Medium stroke" title="Medium stroke" aria-pressed="true"><span style="--dot:12px"></span></button><button data-width="8" aria-label="Thick stroke" title="Thick stroke" aria-pressed="false"><span style="--dot:18px"></span></button></div></div>
      <div class="resource-note" hidden><label>Text label<input placeholder="Type a label, then click to place it" aria-label="Text to place on image" maxlength="1000"></label><button data-action="applyText" hidden>Update selected text</button></div>
      <div class="resource-edit-actions"><button data-action="undo" title="Undo">↶ Undo</button><button data-action="redo" title="Redo">↷ Redo</button><button data-action="delete">Delete mark</button></div>
      <p class="resource-help">Click the selected tool again to pan. Closing Markup also returns to pan.<br>Wheel to zoom. Middle-drag pans while drawing.</p>
     </div>
     <div class="resource-notes-pane" hidden><label>Notes for technicians<textarea class="resource-description" placeholder="Add a reference note…" aria-label="Reference notes" maxlength="20000"></textarea></label><p class="resource-help">Saved with this file. Internal use only.</p></div>
    </aside>
   </div>
   <footer role="status" aria-live="polite"></footer>`;
  host.append(panel);
  const $ = selector => panel.querySelector(selector);
  const markupKeys={c:'circle',a:'arrow',p:'pen',l:'line',b:'rect',t:'note',s:'select'};
  for(const [key,name]of Object.entries(markupKeys)){const button=$('[data-tool="'+name+'"]');button.title=button.textContent.trim()+' ('+key.toUpperCase()+')';button.setAttribute('aria-keyshortcuts',key.toUpperCase());}
  $('[data-action="delete"]').setAttribute('aria-keyshortcuts','Delete');
  $('[data-action="upload"]').title='Upload to '+roleName(currentRole())+' references (You)';
  const stage = $('.resource-stage'), canvas = $('canvas'), ctx = canvas.getContext('2d');
  const player = $('.resource-player'), list = $('.resource-file-list'), status = $('footer'), empty = $('.resource-empty');
  let project = '', files = [], current = null, marks = [], redo = [], history = [], selected = -1;
  let image = null, media = null, tool = 'pan', dirty = false, busy = false, epoch = 0, active = false;
  let scale = 1, ox = 0, oy = 0, gesture = null, frameTime = null, fitMode = 'contain';
  let stageWidth = 0, stageHeight = 0, frameSource = null, filesOpen = true, inspector = '', spaceDown = false, messageTimer = 0;
  let favorites = [], favoriteDraft = null, strokeWidth = 4, markupOpen = false, keyboardOwner = false;
  const favoritePrefix = 'internal-markup-favorite-';
  let frameLinks=new Map();
  const frameLink=file=>{const link=frameLinks.get(file?.name);return link&&files.some(f=>f.name===link.source)?link:null;};
  async function jumpToFrame(file){const link=frameLink(file);if(link)await open(files.find(f=>f.name===link.source),{time:link.time});}
  function savedFrameAtPlayhead(){const time=scrub?.target??media?.currentTime;return media?.videoWidth&&files.find(f=>{const link=frameLink(f);return link?.source===current?.name&&Math.abs(link.time-time)<.02;});}
  function updateFrameAction(){const button=$('[data-action="returnVideo"]'),video=!!media?.videoWidth,saved=video&&savedFrameAtPlayhead();button.hidden=!frameSource&&!video;button.textContent=video?(saved?'Saved Frame':'Save Frame'):'Jump to video frame';button.classList.toggle('is-saved',!!saved);button.disabled=busy||!!favoriteDraft;button.title=saved?'Open the saved frame':video?'Save this frame without a title':'Open the source video at this frame';}
  const uuid = () => crypto.randomUUID(), prefix = 'internal-resource-', markupPrefix = 'internal-markup-';
  const url = (id, name = '') => 'project_resources.php?' + new URLSearchParams({ project: id, ...(name ? { name } : {}) });
  const fileId = name => name.replace(/^internal-resource-(?:v2-)?/, '').slice(0, 36);
  const label = name => files.find(file => file.name === name)?.original_name || name.replace(/^internal-resource-(?:v2-)?/, '').slice(37);
  const sourceUrl = file => file.src || url(project,file.name);
  const viewKey = id => 'firstmeasure:resources:view:'+id;
  let restoring=false,collapsedGroups={},coreActive=false;
  function savedView(id){try{return JSON.parse(localStorage.getItem(viewKey(id)))||{};}catch{return {};}}
  function remember(){if(!project||restoring)return;try{localStorage.setItem(viewKey(project),JSON.stringify({active,coreActive,name:current?.name,collapsedGroups,filesOpen,inspector,expanded:panel.classList.contains('expanded'),time:media?.currentTime||0,scale,ox,oy,stageWidth:stage.clientWidth,stageHeight:stage.clientHeight}));}catch{}}
  async function restoreView(saved=savedView(project)){restoring=true;try{const file=files.find(f=>f.name===saved.name);if(file&&!saved.coreActive)await open(file,{time:saved.time});else await showCoreViews();filesOpen=saved.filesOpen!==false;inspector=['notes','markup','favorites'].includes(saved.inspector)?saved.inspector:'';panel.classList.toggle('expanded',!!saved.expanded);updateDrawers();if(file&&image&&saved.scale>0&&saved.stageWidth===stage.clientWidth&&saved.stageHeight===stage.clientHeight){scale=saved.scale;ox=saved.ox;oy=saved.oy;draw();}}finally{restoring=false;}}
  async function feedback(id){for(const action of ['project_feedback','project_bundle']){const response=await fetch(window.location.pathname+'?'+new URLSearchParams({action,folder:id}),{cache:'no-store'});if(response.ok&&response.headers.get('content-type')?.includes('application/json'))return response.json();if(response.status===401||response.status===403)break;}throw Error('Reference notes could not be loaded. Refresh Files to retry.');}
  async function uploadFile(id,name,file){
   if(!file.size)throw Error('The file is empty.');
   const chunkSize=8*1024*1024,parts=Math.ceil(file.size/chunkSize),resourceId=fileId(name),sha256=[];
   for(let part=0;part<parts;part++){
    const chunk=file.slice(part*chunkSize,Math.min(file.size,(part+1)*chunkSize));
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await chunk.arrayBuffer()))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    sha256.push(digest);
    for(let attempt=0;;attempt++){
     message(`Uploading ${label(name)} — ${Math.floor(part*chunkSize/file.size*100)}% (${part+1}/${parts})${attempt?' · retrying':''}`);
     try{const result=await (await request(id,'internal-markup-part-'+resourceId+'-'+String(part).padStart(8,'0')+'.bin',chunk,{'X-Resource-SHA256':digest})).json();if(result.sha256!==digest)throw Error('Stored upload could not be verified.');break;}
     catch(e){if(attempt>=2)throw e;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
    }
   }
   // The index makes the completed file visible only after all parts are stored.
   return request(id,name,JSON.stringify({format:'firstmeasure-resource-chunks-v1',id:resourceId,size:file.size,chunkSize,parts,sha256,original_name:file.name||label(name),content_type:file.type||'application/octet-stream'}));
  }
  async function request(id,name='',body,headers={}){const response=await fetch(url(id,name),body===undefined?{cache:'no-store'}:{method:'POST',headers:{'X-Resource-Request':'1','X-Resource-Role':currentRole(),'Content-Type':'application/octet-stream',...headers},body});if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||`Resource request failed (${response.status}).`);}return response;}
  function message(text, error = false) {
   status.textContent = text; status.classList.toggle('error', error); status.classList.add('visible'); clearTimeout(messageTimer);
   if (!error) messageTimer = setTimeout(() => { if (!busy) status.classList.remove('visible'); }, 3500);
  }
  function dimensions() { return image ? { w: image.width, h: image.height } : { w: media?.videoWidth || 0, h: media?.videoHeight || 0 }; }
  function controls() {
   for (const action of ['upload', 'refresh']) $(`[data-action="${action}"]`).disabled = busy || !project;
   const saveButton = $('[data-action="save"]'); saveButton.hidden = !dirty; saveButton.disabled = busy || !current || !dirty; saveButton.textContent = busy && dirty ? 'Saving…' : 'Save';
   $('.resource-description').disabled = !current || !!current.reference;
   $('[data-action="favorite"]').disabled = busy || !media?.videoWidth || !!favoriteDraft;
   $('[data-action="overlay"]').setAttribute('aria-pressed',String(!!current&&window.Resource3DOverlay?.imageName===current.name));
   $('[data-action="overlay"]').setAttribute('aria-label',current&&window.Resource3DOverlay?.imageName===current.name?'Remove image from 3D background':'Use image as 3D background');
   $('[data-action="overlay"]').disabled = busy || !image || !!media || !!current?.reference || !window.Resource3DOverlay;
   $('.resource-favorite-entry input').disabled = busy;
   $('.resource-favorite-entry button').disabled = busy;
   $('[data-action="markup"]').disabled = !current || busy || !!current.reference || (!image && !media?.videoWidth);
   $('[data-action="notes"]').disabled = !current; $('[data-action="download"]').disabled = !current;
   $('.resource-notes-dot').hidden = !$('.resource-description').value.trim();
   $('.resource-filename').textContent = current ? roleName(current.role)+' · '+label(current.name) : 'Project resources'; $('.resource-filename').title = current ? label(current.name) : 'Internal project references';
   updateFrameAction(); $('.resource-frame-help').hidden = !media?.videoWidth;
   $('.resource-view-controls').hidden = !dimensions().w;
   $('.resource-note').hidden = tool !== 'note' && marks[selected]?.type !== 'note'; $('[data-action="applyText"]').hidden = marks[selected]?.type !== 'note';
   $('[data-action="undo"]').disabled = !history.length; $('[data-action="redo"]').disabled = !redo.length; $('[data-action="delete"]').disabled = selected < 0;
   panel.classList.toggle('is-busy', busy);
  }
  function changed() { dirty = true; controls(); }
  function snapshot() { history.push(JSON.stringify(marks)); if (history.length > 100) history.shift(); redo = []; changed(); }
  function updateDrawers() {
   const opening=inspector==='markup';if(opening!==markupOpen){markupOpen=opening;gesture=null;setTool(opening?'pen':'pan');}
   panel.classList.toggle('files-open', filesOpen); panel.classList.toggle('inspector-open', !!inspector);
   $('#resource-library').hidden = !filesOpen; $('#resource-inspector').hidden = !inspector;
   $('[data-action="files"]').setAttribute('aria-expanded', String(filesOpen));
   for (const kind of ['markup', 'notes', 'favorites']) $('[data-action="' + kind + '"]').setAttribute('aria-expanded', String(inspector === kind));
   $('.resource-inspector-title').textContent = inspector === 'favorites' ? 'Favorite frames' : inspector === 'notes' ? 'Reference notes' : 'Markup';
   $('.resource-favorites-pane').hidden = inspector !== 'favorites';
   $('.resource-markup-pane').hidden = inspector !== 'markup'; $('.resource-notes-pane').hidden = inspector !== 'notes';
  }
  async function showInspector(kind) {
   inspector = inspector === kind ? '' : kind;
   if (inspector && panel.clientWidth < 760) filesOpen = false;
   if (inspector === 'markup') media?.pause(); updateDrawers(); controls();
   if(inspector==='markup'&&media?.videoWidth&&!await captureFrame())setTool('pan');
   if (inspector === 'notes') $('.resource-description').focus();
  }
  function setTool(next) {
   tool = next; selected = -1; panel.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
   stage.style.cursor = next === 'pan' ? 'grab' : 'crosshair'; controls(); draw();
  }
  function reset() {
   coreActive=false;$('.resource-core-grid').hidden=true;$('[data-action="coreViews"]').setAttribute('aria-pressed','false');
   favoriteDraft = null; $('.resource-favorite-entry').hidden = true;
   scrub = null; cancelAnimationFrame(seekFrame); seekFrame = 0;
   if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
   media = null; player.replaceChildren(); image = null; marks = []; history = []; redo = []; selected = -1;
   frameTime = null; frameSource = null; current = null; dirty = false; gesture = null; fitMode = 'contain';
   canvas.hidden = true; player.hidden = true; empty.hidden = false; $('.resource-transport').hidden = true;
   $('.resource-description').value = ''; $('.resource-note input').value = ''; panel.classList.remove('has-video'); setTool('pan'); controls(); draw();
  }
  async function syncProject() {
   const next = String(window.currentProjectId || ''); if (project === next || busy) return; if (dirty) await save();
   remember(); const priorView=savedView(next);restoring=true; epoch++; project = next; collapsedGroups=priorView.collapsedGroups||{}; reset(); files = []; favorites = []; renderFavorites(); list.replaceChildren(); filesOpen = true; inspector = ''; updateDrawers();
   empty.innerHTML = '<strong>Project references</strong><span></span>';
   empty.querySelector('span').textContent = project ? 'Choose a file, or drop photos and walkthrough videos here.' : 'Open a saved project to add reference files.';
   if (project) {await refresh();await restoreView(priorView);}else restoring=false;
  }
  async function refresh() {
   const id = project, ticket = epoch; if (!id) return; message('Loading project files…');
   try { const [data,notes] = await Promise.all([(await request(id)).json(),feedback(id).then(value=>({value}),error=>({error}))]); if (ticket !== epoch) return; files = [...(data.files || []),...referenceCatalog(notes.value||{manifest:window.currentProjectManifest,app_metadata:window.currentProjectLoadedAppMetadata},name=>window.firstMeasureBuildUrl('/projects/'+encodeURIComponent(id)+'/artifacts/'+encodeURIComponent(name))).filter(r=>!r.resource_name||!(data.files||[]).some(f=>f.name===r.resource_name))]; await loadFavorites(id, ticket); if (ticket !== epoch) return; renderList(); message(notes.error?notes.error.message:'Project files updated.',!!notes.error); }
   catch (error) { if (ticket === epoch) message(error.message, true); } controls();
  }
  function renderCoreViews(){
   const grid=$('.resource-core-grid');grid.replaceChildren();
   for(const {slot,title,file}of coreViews(files)){
    const cell=document.createElement(slot?'button':'div');cell.className='resource-core-cell';
    if(!slot){cell.classList.add('resource-core-house');cell.innerHTML='<svg viewBox="0 0 120 110" role="img" aria-label="House viewed from above; front entrance at bottom"><rect x="20" y="12" width="80" height="76" rx="5" fill="#7194a6"/><path d="M20 12L60 40L100 12M20 88L60 62L100 88M60 40V62" fill="none" stroke="#d8e8f0" stroke-width="3"/><rect x="49" y="82" width="22" height="14" rx="2" fill="#1e5269"/><path d="M60 100v8m-5-5l5 5 5-5" stroke="#1e5269" stroke-width="2" fill="none"/></svg><span>Front entrance &#8595;</span>';}
    else {cell.type='button';cell.setAttribute('aria-label',file?'Open '+title+' view':title+' - no photo');
     if(file){const img=document.createElement('img');img.src=sourceUrl(file);img.alt=title;img.loading='lazy';cell.append(img);cell.onclick=()=>open(file).catch(error=>message(error.message,true));}
     else {cell.disabled=true;const missing=document.createElement('span');missing.className='resource-core-missing';missing.textContent='No photo';cell.append(missing);}
     const caption=document.createElement('strong');caption.textContent=title;cell.append(caption);
    }grid.append(cell);
   }
  }
  async function showCoreViews(){
   if(busy)return;if(dirty)await save();epoch++;reset();inspector='';updateDrawers();coreActive=true;empty.hidden=true;
   $('.resource-core-grid').hidden=false;$('[data-action="coreViews"]').setAttribute('aria-pressed','true');$('.resource-filename').textContent='Core views';renderList();remember();
  }
  function renderList() {
   if(coreActive)renderCoreViews();
   list.replaceChildren(); const resources = files.filter(file => file.reference||file.name.startsWith(prefix)).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
   $('.resource-count').textContent = resources.length || '';
   for(const role of ['qa','tech','customer']){
   const bucket=resources.filter(f=>(f.role||'tech')===role),section=document.createElement('details');section.className='resource-section';section.dataset.role=role;section.open=collapsedGroups[role]===undefined?bucket.length>0:!collapsedGroups[role];
   const heading=document.createElement('summary');heading.className='resource-section-heading';heading.innerHTML=icon(role);
   const title=document.createElement('span');title.textContent=roleName(role)+(role===currentRole()?' (You)':'');const count=document.createElement('span');count.className='resource-section-count';count.textContent=bucket.length;heading.append(title,count);section.append(heading);list.append(section);
   section.addEventListener('toggle',()=>{if(!section.isConnected)return;collapsedGroups[role]=!section.open;remember();});
   if(!bucket.length){const empty=document.createElement('div');empty.className='resource-section-empty';empty.textContent='No files yet';section.append(empty);}
   for (const file of bucket) {
    const button = document.createElement('button'); button.className = 'resource-item'; button.classList.toggle('active', current?.name === file.name);
    const name = document.createElement('span'); name.textContent = (file.elevation_view ? ({front:'Front',back:'Back',left:'Left',right:'Right','front-left':'Front Left','front-right':'Front Right','back-left':'Back Left','back-right':'Back Right'}[file.elevation_view]||file.elevation_view)+' · ' : '') + label(file.name); button.append(name);
    button.title = name.textContent+' · '+roleName(role)+(file.uploaded_at ? '\n' + new Date(file.uploaded_at).toLocaleString() : '');
    button.onclick = () => open(file).catch(error => message(error.message, true));
    const card=document.createElement('div');card.className='resource-file-card';card.append(button);
    const link=frameLink(file);if(link){const jump=document.createElement('button');jump.className='resource-frame-shortcut';jump.innerHTML=icon('frames');jump.title='Video frame · '+timeLabel(link.time)+' · Jump to video';jump.setAttribute('aria-label','Jump to video frame for '+label(file.name));jump.onclick=()=>jumpToFrame(file).catch(error=>message(error.message,true));card.append(jump);}
    if (!file.reference&&/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.name)) {const overlay=document.createElement('button');overlay.className='resource-overlay-shortcut';overlay.innerHTML=icon('overlay');overlay.title=window.Resource3DOverlay?.imageName===file.name?'Remove from 3D background':'Show behind 3D model';overlay.setAttribute('aria-label',(window.Resource3DOverlay?.imageName===file.name?'Remove ':'Use ')+label(file.name)+(window.Resource3DOverlay?.imageName===file.name?' from 3D background':' as 3D background'));overlay.setAttribute('aria-pressed',String(window.Resource3DOverlay?.imageName===file.name));overlay.onclick=()=>sendBackground(file).catch(error=>message(error.message,true));card.append(overlay);}
    section.append(card);
   }
   }
  }
  let overlayRequest=0;
  async function sendBackground(file){
   const id=project,requestId=++overlayRequest;if(!id||!window.Resource3DOverlay)return;
   if(window.Resource3DOverlay.imageName===file.name){window.Resource3DOverlay.remove();message('3D background removed.');return;}
   const img=new Image();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Background image could not be loaded.'));img.src=url(id,file.name);});
   if(project!==id||requestId!==overlayRequest)return;
   await window.Resource3DOverlay.show({image:img,label:label(file.name),project:id,name:file.name});
   panel.classList.remove('expanded');$('[data-action="expand"]').setAttribute('aria-label','Expand resources');renderList();message('3D background ready. Alignment is saved per image.');
  }
  window.addEventListener('resource-3d-overlay-change',()=>{if(project){renderList();controls();}});
  async function latestMarkup(file) {
   if(file.reference)return null;
   const revisions = files.filter(f => f.name.startsWith(markupPrefix + fileId(file.name) + '-')).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || b.name.localeCompare(a.name));
   if (!revisions.length) return null; return (await request(project, revisions[0].name)).json();
  }
  async function loadImage(src, ticket) {
   const img = new Image(); await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(Error('Image could not be previewed. Download the original from More actions.')); img.src = src; });
   if (ticket !== epoch) return; image = img; canvas.hidden = false; player.hidden = true; empty.hidden = true; fit(); controls();
  }
  function timeLabel(seconds) {
   if (!Number.isFinite(seconds)) return '0:00'; const n = Math.max(0, Math.floor(seconds)), h = Math.floor(n / 3600), m = Math.floor(n / 60) % 60;
   return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(n % 60).padStart(2, '0');
  }
  // Let each seek decode and paint before requesting the latest drag position.
  // Repeated currentTime assignments can otherwise starve long-video previews.
  let scrub = null, seekFrame = 0;
  function queueScrub() {
   if (seekFrame || !scrub) return;
   seekFrame = requestAnimationFrame(() => {
    seekFrame = 0; const state = scrub;
    if (!state || state.element !== media) return;
    if (media.seeking) return; // seeked schedules the next preview.
    if (state.pending) { state.pending = false; media.currentTime = state.target; return; }
    if (!state.dragging) {
     scrub = null; updateTransport();
     if (state.resume && active) media.play().catch(error => message(error.message, true));
    }
   });
  }
  function beginScrub(dragging) {
   if (!media || !Number.isFinite(media.duration)) return;
   if (!scrub || scrub.element !== media) scrub = { element: media, target: media.currentTime, resume: !media.paused, pending: false, dragging };
   else scrub.dragging = dragging;
   media.pause();
  }
  function finishScrub() { if (scrub) { scrub.dragging = false; queueScrub(); } }
  function updateTransport() {
   updateFrameAction();
   if (!media) return; const duration = Number.isFinite(media.duration) ? media.duration : 0;
   const time = scrub?.element === media ? scrub.target : media.currentTime;
   $('.resource-seek').max = duration || 1; $('.resource-seek').value = time || 0; $('.resource-seek').disabled = !duration || !!favoriteDraft;
   $('.resource-time').textContent = timeLabel(time) + ' / ' + timeLabel(duration);
   $('[data-action="play"]').textContent = media.paused ? '▶' : 'Ⅱ'; $('[data-action="play"]').setAttribute('aria-label', media.paused ? 'Play' : 'Pause');
   $('[data-action="mute"]').textContent = media.muted ? '×♪' : '♪'; $('[data-action="mute"]').setAttribute('aria-label', media.muted ? 'Unmute' : 'Mute');
  }
  async function open(file, options = {}) {
   if (busy || !file) return; if (dirty) await save(); const ticket = ++epoch; reset(); current = file; renderList();
   if (!options.keepInspector) inspector = ''; updateDrawers();
   empty.textContent = 'Loading reference…'; const src = sourceUrl(file), ext = (file.original_name||file.name).split('.').pop().toLowerCase();
   try {
    const saved = await latestMarkup(file); if (ticket !== epoch) return;
    const favorite = favorites.find(item => item.frame === file.name);
    if (favorite) frameSource = { file: files.find(item => item.name === favorite.source), time: favorite.time };
    if (saved?.sourceVideo && !frameSource) frameSource = { file: files.find(item => item.name === saved.sourceVideo.name), time: saved.sourceVideo.time };
    if (frameSource && !frameSource.file) frameSource = null;
    if(frameSource){frameLinks.set(file.name,{source:frameSource.file.name,time:frameSource.time});renderList();}
    if (saved) { marks = Array.isArray(saved.marks) ? saved.marks : []; $('.resource-description').value = saved.notes || ''; frameTime = saved.frameTime ?? null; }
    if(file.notes){empty.textContent=file.notes;$('.resource-description').value=file.notes;}
    else if(/^(txt|md|csv)$/.test(ext)){const response=await fetch(src);if(!response.ok)throw Error('Reference could not be loaded.');const text=await response.text();if(ticket===epoch)empty.textContent=text;}
    else if (/^(png|jpe?g|gif|webp|avif|bmp)$/.test(ext)||src.startsWith('data:image/')) await loadImage(src, ticket);
    else if (/^(mp4|webm|mov|mp3|wav|ogg|m4a)$/.test(ext)) {
     const isVideo = /^(mp4|webm|mov)$/.test(ext); media = document.createElement(isVideo ? 'video' : 'audio'); const element = media;
     element.controls = false; element.preload = 'metadata'; element.playsInline = true;
     element.onerror = () => { if (ticket === epoch) message('This format cannot play in this browser. Download the original from More actions.', true); };
     element.addEventListener('loadedmetadata', () => { if (ticket !== epoch) return; if (options.time != null) element.currentTime = Math.min(options.time, Number.isFinite(element.duration) ? element.duration : options.time); fit(); controls(); updateTransport(); });
     for (const event of ['timeupdate', 'durationchange', 'play', 'pause', 'ended', 'volumechange']) element.addEventListener(event, () => { if (ticket === epoch) updateTransport(); });
     element.addEventListener('seeked', () => { if (ticket === epoch) queueScrub(); });
     player.append(element); player.hidden = !isVideo; empty.hidden = isVideo; element.src = src; if (!isVideo) empty.textContent = 'Audio reference';
     $('.resource-transport').hidden = false; panel.classList.toggle('has-video', isVideo); $('.resource-rate').value = '1';
    } else if(ext==='pdf'){const frame=document.createElement('iframe');frame.title=label(file.name);frame.src=src;frame.style.cssText='width:100%;height:100%;border:0';player.append(frame);player.hidden=false;empty.hidden=true;}
    else empty.textContent = 'Preview is unavailable for this file. Use More actions → Download original to open it.';
    if (ticket !== epoch) return; renderFavorites(); if (favorites.some(item => item.source === file.name)) { inspector = 'favorites'; updateDrawers(); } message('Wheel to zoom · Drag to pan · Double-click to fit'); draw();
   } catch (error) { if (ticket === epoch) { empty.textContent = 'Unable to load reference.'; message(error.message, true); } } controls();remember();
  }
  async function save() {
   if (!current || current.reference || !project || !dirty) return;
   if (busy) throw Error('Wait for the current upload to finish.');
   const id = project, file = current, ticket = epoch;
   busy = true; controls();
   try {
    const signature = JSON.stringify({ marks, notes: $('.resource-description').value, frameTime });
    const record = { version: 1, media: file.name, marks, notes: $('.resource-description').value, frameTime, sourceVideo: frameSource ? { name: frameSource.file.name, time: frameSource.time } : null, author: window.FIRSTMEASURE_ACTOR?.name || '', savedAt: new Date().toISOString() };
    const name = markupPrefix + fileId(file.name) + '-' + Date.now() + '-' + uuid().slice(0, 12) + '.json';
    await request(id, name, JSON.stringify(record));
    // Use storage timestamps for revision ordering, including repeated saves in this session.
    const inventory = await (await request(id)).json();
    if (ticket === epoch) {
     files = inventory.files || []; renderList();
     dirty = signature !== JSON.stringify({ marks, notes: $('.resource-description').value, frameTime });
     message('Markup saved to the project.');
    }
   } finally { busy = false; controls(); }
  }
  async function upload(incoming){if(busy)return;if(!project){message('Open a saved project before uploading.',true);return;}if(dirty)await save();const id=project,ticket=epoch;busy=true;controls();let count=0,failed=[];try{for(const file of incoming){message('Uploading '+file.name+'…');const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-42)||'file';try{await uploadFile(id,prefix+'v2-'+uuid()+'-'+safe,file);count++;}catch(e){failed.push(file.name+': '+e.message);}}if(ticket===epoch){await refresh();message(`${count} file(s) saved to project.${failed.length?' '+failed.join('; '):''}`,!!failed.length);}}finally{busy=false;$('.resource-files').value='';controls();}}
  function fit(mode = 'contain') {
   const { w, h } = dimensions(); if (!w || !h || !stage.clientWidth || !stage.clientHeight) return;
   fitMode = mode; const x = stage.clientWidth / w, y = stage.clientHeight / h;
   scale = mode === 'cover' ? Math.max(x, y) : Math.min(x, y);
   ox = (stage.clientWidth - w * scale) / 2; oy = (stage.clientHeight - h * scale) / 2;
   panel.dataset.aspect = h > w ? 'portrait' : 'landscape'; draw();
  }
  function resize() {
   const w = stage.clientWidth, h = stage.clientHeight, dpr = window.devicePixelRatio || 1;
   canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
   if (fitMode) fit(fitMode); else { ox += (w - stageWidth) / 2; oy += (h - stageHeight) / 2; draw(); }
   stageWidth = w; stageHeight = h;
  }
  function zoom(factor, x = stage.clientWidth / 2, y = stage.clientHeight / 2) {
   const { w, h } = dimensions(); if (!w || !h) return; const base = Math.min(stage.clientWidth / w, stage.clientHeight / h);
   const next = Math.min(base * 32, Math.max(base * .25, scale * factor));
   ox = x - (x - ox) * next / scale; oy = y - (y - oy) * next / scale; scale = next; fitMode = null; draw();
  }
  function pathMark(m){const a=m.points[0],b=m.points[m.points.length-1];ctx.strokeStyle=m.color;ctx.fillStyle=m.color;ctx.lineWidth=m.width;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();if(m.type==='circle'){ctx.ellipse((a.x+b.x)/2,(a.y+b.y)/2,Math.max(.1,Math.abs(b.x-a.x)/2),Math.max(.1,Math.abs(b.y-a.y)/2),0,0,Math.PI*2);}else if(m.type==='rect'){ctx.rect(a.x,a.y,b.x-a.x,b.y-a.y);}else if(m.type==='note'){ctx.font=`${m.fontSize||24}px sans-serif`;String(m.text).split('\n').forEach((line,i)=>ctx.fillText(line,a.x,a.y+i*(m.fontSize||24)*1.3));}else{ctx.moveTo(a.x,a.y);for(const p of m.points.slice(1))ctx.lineTo(p.x,p.y);}ctx.stroke();if(m.type==='arrow'){const angle=Math.atan2(b.y-a.y,b.x-a.x),n=Math.max(12,m.width*4);ctx.beginPath();ctx.moveTo(b.x-n*Math.cos(angle-.5),b.y-n*Math.sin(angle-.5));ctx.lineTo(b.x,b.y);ctx.lineTo(b.x-n*Math.cos(angle+.5),b.y-n*Math.sin(angle+.5));ctx.stroke();}}
  function bounds(m){const xs=m.points.map(p=>p.x),ys=m.points.map(p=>p.y);let x=Math.min(...xs),y=Math.min(...ys),w=Math.max(...xs)-x,h=Math.max(...ys)-y;if(m.type==='note'){const size=m.fontSize||24;w=String(m.text).length*size*.65;h=size*1.4;y-=size;}return{x,y,w,h};}
  function draw() {
   const dpr = window.devicePixelRatio || 1;
   ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
   const { w, h } = dimensions();
   if (w && h) $('.resource-zoom-level').textContent = Math.round(scale / Math.min(stage.clientWidth / w, stage.clientHeight / h) * 100) + '%';
   if (media?.videoWidth) { media.style.width = media.videoWidth + 'px'; media.style.height = media.videoHeight + 'px'; media.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`; }
   if (!image) return;
   ctx.save(); ctx.translate(ox, oy); ctx.scale(scale, scale); ctx.drawImage(image, 0, 0); marks.forEach(pathMark);
   if (gesture?.mark) pathMark(gesture.mark);
   if (marks[selected]) { const b = bounds(marks[selected]); ctx.strokeStyle = '#69b9ff'; ctx.lineWidth = 1 / scale; ctx.setLineDash([4 / scale, 4 / scale]); ctx.strokeRect(b.x - 5 / scale, b.y - 5 / scale, b.w + 10 / scale, b.h + 10 / scale); }
   ctx.restore();
  }
  const pos = event => { const r = stage.getBoundingClientRect(); return { x: (event.clientX - r.left - ox) / scale, y: (event.clientY - r.top - oy) / scale }; };
  const isControl = target => !!target.closest('button,input,select,textarea,a');
  stage.addEventListener('pointerdown', event => {
   if (isControl(event.target) || !dimensions().w || busy || ![0, 1, 2].includes(event.button)) return;
   event.preventDefault(); stage.focus({ preventScroll: true }); stage.setPointerCapture(event.pointerId);
   const p = pos(event), pan = inspector!=='markup' || !image || tool === 'pan' || event.button !== 0 || spaceDown;
   gesture = { id: event.pointerId, start: p, x: event.clientX, y: event.clientY, ox, oy, pan };
   if (pan) { fitMode = null; stage.style.cursor = 'grabbing'; return; }
   if (tool === 'select') {
    selected = marks.findLastIndex(mark => { const b = bounds(mark), pad = 10 / scale; return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad; });
    if (selected >= 0) { snapshot(); gesture.original = structuredClone(marks[selected]); if (marks[selected].type === 'note') $('.resource-note input').value = marks[selected].text; }
    controls(); draw(); return;
   }
   if (tool === 'note' && !$('.resource-note input').value.trim()) { message('Type a label in the markup tray, then click to place it.', true); gesture = null; return; }
   gesture.mark = { type: tool, points: [p, p], color: $('.resource-color').value, width: strokeWidth / scale, fontSize: 20 / scale, text: $('.resource-note input').value }; draw();
  });
  stage.addEventListener('pointermove', event => {
   if (!gesture || gesture.id !== event.pointerId) return; const p = pos(event);
   if (gesture.pan) { ox = gesture.ox + event.clientX - gesture.x; oy = gesture.oy + event.clientY - gesture.y; }
   else if (gesture.original) marks[selected].points = gesture.original.points.map(q => ({ x: q.x + p.x - gesture.start.x, y: q.y + p.y - gesture.start.y }));
   else if (gesture.mark) { if (tool === 'pen') gesture.mark.points.push(p); else gesture.mark.points[1] = p; } draw();
  });
  function finish(event) {
   if (!gesture || gesture.id !== event.pointerId) return;
   if (event.type === 'pointerup' && gesture.mark) { snapshot(); marks.push(gesture.mark); }
   else if (event.type !== 'pointerup' && gesture.original) marks[selected] = gesture.original;
   gesture = null; stage.style.cursor = !image || tool === 'pan' ? 'grab' : 'crosshair'; controls(); draw();
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(event, finish);
  stage.addEventListener('contextmenu', event => { if (!isControl(event.target)) event.preventDefault(); });
  stage.addEventListener('dblclick', event => { if (!isControl(event.target) && (!image || tool === 'pan')) { event.preventDefault(); fit(); } });
  stage.addEventListener('wheel', event => { if (!dimensions().w || isControl(event.target)) return; event.preventDefault(); const r = stage.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .0015), event.clientX - r.left, event.clientY - r.top); }, { passive: false });
  async function loadFavorites(id, ticket) {
   const records = await Promise.all(files.filter(file => file.name.startsWith(favoritePrefix)).map(async file => ({...(await (await request(id, file.name)).json()),recordName:file.name})));
   const captures=await Promise.all(files.filter(f=>f.name.startsWith(prefix)).map(async file=>({file,saved:await latestMarkup(file)})));
   if (ticket !== epoch) return;
   favorites = records.filter(item => item.version === 1 && typeof item.label === 'string' && Number.isFinite(item.time) && files.some(file => file.name === item.frame) && files.some(file => file.name === item.source));
   frameLinks=new Map();for(const {file,saved}of captures)if(saved?.sourceVideo&&Number.isFinite(saved.sourceVideo.time))frameLinks.set(file.name,{source:saved.sourceVideo.name,time:saved.sourceVideo.time});for(const item of favorites)frameLinks.set(item.frame,{source:item.source,time:item.time});
   renderFavorites();
  }
  function renderFavorites() {
   const list = $('.resource-favorites-list'); list.replaceChildren();
   const source = frameSource?.file.name || current?.name;
   const created=item=>Date.parse(item.createdAt||files.find(f=>f.name===item.frame)?.uploaded_at||files.find(f=>f.name===item.frame)?.updated_at||'')||0;
   const visible = favorites.filter(item => item.source === source).sort((a, b) => created(b)-created(a));
   for (const item of visible) {
    const card = document.createElement('div'); card.className = 'resource-favorite-card';
    const preview = document.createElement('button'); preview.className = 'resource-favorite-preview'; preview.title = 'Open frame for markup';
    const thumb = document.createElement('img'); thumb.src = url(project, item.frame); thumb.alt = ''; thumb.loading = 'lazy';
    preview.append(thumb);preview.setAttribute('aria-label','Open saved frame '+(item.label||timeLabel(item.time)));
    const title=document.createElement('input');title.className='resource-favorite-title';title.dataset.frame=item.frame;title.value=item.label;title.placeholder='Add title';title.setAttribute('aria-label','Frame title at '+timeLabel(item.time));title.maxLength=160;
    title.onchange=async()=>{const label=title.value.trim(),id=project;if(label===item.label)return true;title.readOnly=true;try{const {recordName,...record}=item;await request(id,recordName,JSON.stringify({...record,label}));item.label=label;title.value=label;preview.setAttribute('aria-label','Open saved frame '+(label||timeLabel(item.time)));message('Frame title saved.');return true;}catch(error){title.value=item.label;message(error.message,true);return false;}finally{title.readOnly=false;}};
    title.onkeydown=async e=>{if(e.key==='Enter'||e.code==='Space'&&!title.value.trim()){e.preventDefault();if(title.readOnly)return;const video=media;if(!await title.onchange())return;title.blur();stage.focus();if(video&&video===media&&active)video.play().catch(error=>message(error.message,true));}else if(e.key==='Escape'){e.preventDefault();title.value=item.label;title.blur();stage.focus();}};
    preview.onclick = () => open(files.find(file => file.name === item.frame)).then(() => { inspector = 'markup'; updateDrawers(); }).catch(error => message(error.message, true));
    const jump = document.createElement('button'); jump.className = 'resource-favorite-jump'; jump.textContent = '▶ ' + timeLabel(item.time) + ' · Jump to video';
    jump.onclick = () => open(files.find(file => file.name === item.source), { time: item.time }).catch(error => message(error.message, true));
    const caption=document.createElement('div');caption.className='resource-favorite-caption';caption.append(title,jump);card.append(preview,caption); list.append(card);
   }
   if (!visible.length) { const hint = document.createElement('p'); hint.className = 'resource-help'; hint.textContent = 'No favorite frames for this video yet.'; list.append(hint); }
  }
  async function freezeFavorite(draft) {
   const video = draft.video;
   // Freeze the requested scrub position, then capture only after decoding settles.
   if (video.seeking || Math.abs(video.currentTime - draft.time) > .001) {
    await new Promise((resolve, reject) => {
     const timer = setTimeout(() => done(Error('Frame is still loading. Try again.')), 15000);
     function done(error) { clearTimeout(timer); video.removeEventListener('seeked', settled); video.removeEventListener('error', failed); error ? reject(error) : resolve(); }
     function settled() { done(); } function failed() { done(Error('Could not decode this frame.')); }
     video.addEventListener('seeked', settled); video.addEventListener('error', failed); video.currentTime = draft.time;
    });
   }
   if (draft.ticket !== epoch || draft !== favoriteDraft) throw Error('Frame selection cancelled.');
   const frame = document.createElement('canvas'); frame.width = video.videoWidth; frame.height = video.videoHeight; frame.getContext('2d').drawImage(video, 0, 0);
   const blob = await new Promise(resolve => frame.toBlob(resolve, 'image/png'));
   if (!blob) throw Error('Could not capture this frame.'); return blob;
  }
  function startFavorite(quick=false) {
   if (busy || favoriteDraft || !media?.videoWidth) return;
   const draft = { video: media, source: current.name, time: scrub?.target ?? media.currentTime, resume: scrub?.resume ?? !media.paused, ticket: epoch, id: project, name: prefix + 'v2-' + uuid() + '-favorite.png', record: favoritePrefix + uuid() + '.json' };
   scrub = null; cancelAnimationFrame(seekFrame); seekFrame = 0; media.pause(); favoriteDraft = draft;
   draft.capture = freezeFavorite(draft); draft.capture.catch(() => {});
   if(quick)draft.resume=false;$('.resource-favorite-entry').hidden = quick; const input = $('.resource-favorite-entry input'); input.value = ''; if(!quick)input.focus(); controls(); updateTransport();
  }
  function closeFavorite(resume) {
   const draft = favoriteDraft; favoriteDraft = null; $('.resource-favorite-entry').hidden = true; controls(); updateTransport(); stage.focus();
   if (resume && draft?.resume && draft.video === media && active) media.play().catch(error => message(error.message, true));
  }
  $('.resource-favorite-entry').addEventListener('keydown', event => {
   event.stopPropagation(); if (event.key === 'Escape' && !busy) { event.preventDefault(); closeFavorite(true); }
  });
  async function saveFavorite(title,quick=false){
   const draft = favoriteDraft;if (!draft || busy) return;
   busy = true; controls();
   try {
    let blob;
    try { blob = await (draft.capture || (draft.capture = freezeFavorite(draft))); }
    catch (error) { draft.capture = null; throw error; }
    const record = { version: 1, label: title, source: draft.source, time: draft.time, frame: draft.name, createdAt: new Date().toISOString() };
    await uploadFile(draft.id, draft.name, new File([blob], (title||'Frame '+timeLabel(draft.time).replaceAll(':','-')) + '.png', { type: 'image/png' }));
    await request(draft.id, draft.record, JSON.stringify(record));
    if (draft.ticket !== epoch) return;
    await refresh(); inspector = 'favorites'; updateDrawers(); closeFavorite(true); message('Favorite frame saved to the project.');
    if(quick){const input=[...panel.querySelectorAll('.resource-favorite-title')].find(input=>input.dataset.frame===draft.name);input?.focus();input?.scrollIntoView({block:'nearest'});}
   } catch (error) {if(quick)closeFavorite(false);message('Frame was not saved: ' + error.message, true); }
   finally { busy = false; controls(); if (!quick&&favoriteDraft === draft) $('.resource-favorite-entry input').focus(); }
  }
  $('.resource-favorite-entry').addEventListener('submit',event=>{event.preventDefault();saveFavorite($('.resource-favorite-entry input').value.trim());});
  async function captureFrame() {
   if (busy) return false;
   const video = media;
   if (!video?.videoWidth || video.readyState < 2) { message('Wait for the video frame to load.', true); return false; }
   video.pause(); if (dirty) await save();
   const id = project, ticket = epoch, source = current, time = video.currentTime;
   const view = { scale, ox, oy, height: stage.clientHeight, width: stage.clientWidth };
   const frame = document.createElement('canvas'); frame.width = video.videoWidth; frame.height = video.videoHeight; frame.getContext('2d').drawImage(video, 0, 0);
   const blob = await new Promise(resolve => frame.toBlob(resolve, 'image/png')); if (!blob) throw Error('Could not capture this frame.');
   const name = prefix + 'v2-' + uuid() + '-' + label(source.name).replace(/\.[^.]+$/, '').slice(0, 20) + '-frame-' + time.toFixed(2) + 's.png';
   busy = true; controls();
   try { await uploadFile(id, name, blob); if (ticket === epoch) await refresh(); } finally { busy = false; controls(); }
   if (ticket !== epoch) return false;
   await open(files.find(file => file.name === name), { keepInspector: true }); if(inspector==='markup')setTool('pen'); frameSource = { file: source, time };frameLinks.set(name,{source:source.name,time});renderList();
   $('.resource-description').value = 'Frame at ' + time.toFixed(2) + ' seconds from ' + label(source.name); changed();
   scale = view.scale; ox = view.ox + (stage.clientWidth - view.width) / 2; oy = view.oy + (stage.clientHeight - view.height) / 2; fitMode = null; draw(); controls();
   message('Frame ready for markup. Use ↩ Video to return to the walkthrough.'); return true;
  }
  async function chooseTool(next,toggle=true) {
   if (busy) return;
   if(inspector!=='markup')return;next=toggle&&tool===next?'pan':next;
   if (media?.videoWidth && !['pan', 'select'].includes(next)) { if (!await captureFrame()) return; }
   setTool(next);
   if (next === 'note') $('.resource-note input').focus();
  }
  const actions = {
   files: () => { filesOpen = !filesOpen; if (filesOpen && panel.clientWidth < 760) inspector = ''; updateDrawers(); },
   coreViews:showCoreViews,
   upload: () => $('.resource-files').click(), refresh,
   markup: () => showInspector('markup'), notes: () => showInspector('notes'), closeInspector: () => { inspector = ''; updateDrawers(); },
   more: () => { $('.resource-more').hidden = !$('.resource-more').hidden; $('[data-action="more"]').setAttribute('aria-expanded', String(!$('.resource-more').hidden)); },
   save,
   overlay: async () => { if (!image || media || busy || !current) return; await sendBackground(current); },
   expand: () => { panel.classList.toggle('expanded'); $('[data-action="expand"]').setAttribute('aria-label', panel.classList.contains('expanded') ? 'Collapse resources' : 'Expand resources'); },
   fit: () => fit(), fill: () => fit('cover'), zoomIn: () => zoom(1.25), zoomOut: () => zoom(.8),
   play: () => { if (media && !favoriteDraft) return media.paused ? media.play() : media.pause(); }, mute: () => { if (media) media.muted = !media.muted; },
   undo: () => { if (history.length) { redo.push(JSON.stringify(marks)); marks = JSON.parse(history.pop()); selected = -1; changed(); draw(); } },
   redo: () => { if (redo.length) { history.push(JSON.stringify(marks)); marks = JSON.parse(redo.pop()); selected = -1; changed(); draw(); } },
   delete: () => { if (selected >= 0) { snapshot(); marks.splice(selected, 1); selected = -1; controls(); draw(); } },
   frame: captureFrame, favorites: () => { renderFavorites(); showInspector('favorites'); }, favorite: () => startFavorite(),
   returnVideo: async () => {if(media?.videoWidth){const saved=savedFrameAtPlayhead();if(saved)await open(saved);else{startFavorite(true);await saveFavorite('',true);}}else if (frameSource) { const source = frameSource; await open(source.file, { time: source.time }); } },
   download: () => { if (current&&!current.notes) { const link = document.createElement('a'); link.href = sourceUrl(current); link.download = label(current.name); link.click(); } },
   applyText: () => { if (marks[selected]?.type === 'note') { snapshot(); marks[selected].text = $('.resource-note input').value; draw(); } }
  };
  panel.addEventListener('click', event => {
   const button = event.target.closest('button'); if (!button) return;
   if (button.dataset.action !== 'more') { $('.resource-more').hidden = true; $('[data-action="more"]').setAttribute('aria-expanded', 'false'); }
   Promise.resolve().then(() => button.dataset.tool ? chooseTool(button.dataset.tool) : actions[button.dataset.action]?.()).catch(error => message(error.message, true));
  });
  $('.resource-seek').addEventListener('pointerdown', event => {
   if (event.button !== 0 || favoriteDraft) return; beginScrub(true);
   event.target.setPointerCapture(event.pointerId);
  });
  $('.resource-seek').addEventListener('input', event => {
   if (favoriteDraft) return; const target = Number(event.target.value); if (!scrub) beginScrub(false); if (!scrub) return;
   scrub.target = Math.max(0, Math.min(media.duration, target)); scrub.pending = true; updateTransport(); queueScrub();
  });
  for (const event of ['change', 'pointerup', 'pointercancel', 'lostpointercapture', 'blur']) $('.resource-seek').addEventListener(event, finishScrub);
  $('.resource-rate').addEventListener('change', event => { if (media) media.playbackRate = Number(event.target.value); });
  for (const event of ['keydown', 'keyup', 'pointerdown', 'mousedown', 'dblclick', 'wheel']) panel.addEventListener(event, e => e.stopPropagation());
  document.addEventListener('keydown', event => {
   if (!active || !media?.videoWidth || busy || favoriteDraft || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat || event.key.toLowerCase() !== 'n') return;
   if (!panel.contains(event.target) || event.target.isContentEditable || event.target.closest('textarea,select,input:not(.resource-seek)')) return;
   event.preventDefault(); event.stopImmediatePropagation(); startFavorite();
  }, true);
  panel.addEventListener('keydown', event => {
   if (isControl(event.target) && !event.target.matches('button')) return;
   if (event.key === 'Escape') { inspector = ''; filesOpen = false; $('.resource-more').hidden = true; updateDrawers(); setTool('pan'); return; }
   if (event.target !== stage) return;
   if (event.code === 'Space') { event.preventDefault(); if (media && !event.repeat) Promise.resolve(actions.play()).catch(e => message(e.message, true)); else spaceDown = true; }
   if (event.key === '+' || event.key === '=') zoom(1.25); if (event.key === '-') zoom(.8); if (event.key === '0') fit();
   if (media && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); media.currentTime = Math.max(0, Math.min(Number.isFinite(media.duration) ? media.duration : Infinity, media.currentTime + (event.key === 'ArrowLeft' ? -5 : 5))); }
  });
  panel.addEventListener('keyup', event => { if (event.code === 'Space') spaceDown = false; }); stage.addEventListener('blur', () => { spaceDown = false; });
  $('.resource-description').addEventListener('input', changed);
  $('.resource-color').addEventListener('change', () => { if (selected >= 0) { snapshot(); marks[selected].color = $('.resource-color').value; draw(); } });
  $('.resource-width').addEventListener('click', event => {const button=event.target.closest('[data-width]');if(!button)return;strokeWidth=Number(button.dataset.width);panel.querySelectorAll('[data-width]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));if(selected>=0){snapshot();marks[selected].width=strokeWidth/scale;draw();}});
  $('.resource-files').onchange = event => upload([...event.target.files]).catch(error => message(error.message, true));
  panel.addEventListener('dragover', event => { event.preventDefault(); panel.classList.add('drop-target'); }); panel.addEventListener('dragleave', () => panel.classList.remove('drop-target'));
  panel.addEventListener('drop', event => { event.preventDefault(); panel.classList.remove('drop-target'); upload([...event.dataTransfer.files]).catch(error => message(error.message, true)); });
  const previous = window.switchMapLayer; let mapTabClick = false;
  for(const event of ['pointerdown','focusin'])window.addEventListener(event,e=>{keyboardOwner=panel.contains(e.target)||tab.contains(e.target);},true);
  function handleKey(event){
   if(!active||!keyboardOwner)return false;
   if(!event.isComposing&&event.target.matches?.('.resource-favorite-title')&&(['Enter','Escape'].includes(event.key)||event.code==='Space'&&!event.target.value.trim())){event.stopImmediatePropagation();event.target.onkeydown?.(event);return true;}
   // Text fields retain native text undo, while model handlers must still stop.
   if(event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')||event.isComposing){event.stopImmediatePropagation();return true;}
   const key=event.key.toLowerCase(),historyKey=(event.ctrlKey||event.metaKey)&&!event.altKey&&['z','y'].includes(key),markupKey=inspector==='markup'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&(markupKeys[key]||key==='delete');
   if(!historyKey&&!markupKey)return false;
   event.stopImmediatePropagation();event.preventDefault();if(busy||gesture)return true;
   if(historyKey)actions[key==='y'||event.shiftKey?'redo':'undo']();
   else if(!event.repeat){if(key==='delete')actions.delete();else chooseTool(markupKeys[key],false).catch(error=>message(error.message,true));}return true;
  }
  window.addEventListener('keydown',handleKey,true);
  tabs.addEventListener('click', () => { mapTabClick = true; setTimeout(() => mapTabClick = false, 0); }, true);
  window.switchMapLayer = function(layer) {
   if (active && layer !== 'resources' && !mapTabClick) return;
   active = layer === 'resources'; keyboardOwner=active; panel.hidden = !active; tab.classList.toggle('active', active);remember();
   if (active) {
    previous.call(this, 'resources'); host.querySelectorAll('#google-map-container,#google-js-map').forEach(element => element.style.display = 'none');
    tabs.querySelectorAll('.map-tab').forEach(element => element.classList.toggle('active', element === tab)); syncProject().catch(error => message(error.message, true)); resize();
   } else { panel.classList.remove('expanded'); media?.pause(); previous.call(this, layer); }
  };
  tab.onclick = () => window.switchMapLayer('resources'); new ResizeObserver(resize).observe(stage);
  let restoreProject='';setInterval(() => {const id=String(window.currentProjectId||'');if(id&&restoreProject!==id){restoreProject=id;if(savedView(id).active)window.switchMapLayer('resources');}if(active)syncProject().catch(error=>message(error.message,true));remember();},700);
  window.addEventListener('pagehide',remember);
  window.ProjectResources={handleKey,open:()=>window.switchMapLayer('resources'),async mergeSubmission(state){
   const id=String(state.folderId||window.currentProjectId||'');if(!id||currentRole()==='qa')return;
   const data=await(await request(id)).json(),resources=(data.files||[]).filter(f=>f.name.startsWith(prefix)&&(f.role||'tech')==='tech');
   state.finalizeSources||={images:[],notes:''};const images=state.finalizeSources.images||=[];
   for(const f of resources){if(!images.some(i=>i.resource_name===f.name))images.push({resource_name:f.name,url:new URL(url(id,f.name),location.href).href,dataUrl:new URL(url(id,f.name),location.href).href,name:f.original_name||f.name,role:'tech'});
    const revisions=(data.files||[]).filter(r=>r.name.startsWith(markupPrefix+fileId(f.name)+'-')).sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))||b.name.localeCompare(a.name));
    if(revisions.length){const markup=await(await request(id,revisions[0].name)).json();const note=String(markup.notes||'').trim();if(note&&!String(state.finalizeSources.notes||'').includes(note))state.finalizeSources.notes=(state.finalizeSources.notes?state.finalizeSources.notes+'\n\n':'')+(f.original_name||f.name)+':\n'+note;}
   }
  }};
  for(const event of ['pointerdown','dblclick','wheel'])$('.resource-core-grid').addEventListener(event,e=>e.stopPropagation());
  if(window.WallMode?.enabled)window.switchMapLayer('resources');
  window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } }); updateDrawers(); controls();
 }
 if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
