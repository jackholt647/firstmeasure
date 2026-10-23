const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dividers = new WeakMap(), sidebars = new WeakMap();
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined,{maximumFractionDigits:2}) : 'Unavailable';
const label = value => String(value || '').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_.-]/g,' ').replace(/^./,c=>c.toUpperCase());
const money = (value,currency='USD') => {try{return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(value);}catch{return `${number(value)} ${currency}`;}};

// Membership comes from persisted publications, never a document type or module draft.
export async function loadDocuments(orgId, projectId) {
  const api = window.PlatformAPI, base = api.baseUrl().replace(/\/platform\/?$/, '');
  const org = encodeURIComponent(orgId), project = encodeURIComponent(projectId);
  const target = {scope:'project',organizationId:orgId,projectId};
  const source = {provider:'datasets',export:'value',target};
  const results = await Promise.allSettled([
    api.request(`${base}/materials/organizations/${org}/projects/${project}/calculus`),
    api.request(`${base}/documents/organizations/${org}/projects/${project}/documents`),
    (async()=>{const rows=[];let cursor;do {const page=await api.publication.list(orgId,source,{limit:200,...(cursor?{cursor}:{})});rows.push(...page.items);cursor=page.nextCursor;}while(cursor);return rows;})()
  ]);
  const documents = [], failures = results.filter(r=>r.status==='rejected');
  const ledger = results[0].status==='fulfilled' ? results[0].value.ledger : null;
  const docs = results[1].status==='fulfilled' ? results[1].value.documents || [] : [];
  const groups = new Map();
  for (const set of ledger?.sets || []) {
    const origin=set.origin || {};
    if(origin.type!=='document' || !origin.document_id || !origin.snapshot_id)continue;
    const doc=docs.find(d=>d.id===origin.document_id);
    if(!doc || !['completed','signed'].includes(doc.status))continue;
    const key=`${doc.id}:${origin.snapshot_id}`;
    if(!groups.has(key))groups.set(key,{...doc,id:key,documentId:doc.id,source:'document',snapshotId:origin.snapshot_id,acceptedAt:origin.at,sets:[]});
    groups.get(key).sets.push(set);
  }
  await Promise.all([...groups.values()].map(async doc=>{
    try {
      const result=await api.request(`${base}/documents/organizations/${org}/documents/${encodeURIComponent(doc.documentId)}/snapshots`);
      const snapshot=result.snapshots?.find(s=>s.id===doc.snapshotId);
      if(!snapshot)throw Error('Accepted snapshot unavailable');
      doc.snapshot=snapshot;doc.title=snapshot.title || doc.title;
      const computed=snapshot.resolved_definition?.computed_values || {};
      for(const key of ['total_cents','contract_total_cents'])if(typeof computed[key]==='number'){doc.total=money(computed[key]/100,snapshot.params?.pricing?.currency || 'USD');break;}
      const mediaId=doc.preview_media_ref?.media_id || doc.pdf?.latest_media_id;
      if(mediaId)doc.thumbnail=api.media?.thumbnailUrl?.(orgId,mediaId,320);
      documents.push(doc);
    } catch(error){failures.push(error);}
  }));
  if(results[2].status==='fulfilled')await Promise.all(results[2].value.filter(d=>d.type==='measurements').map(async dataset=>{
    try {
      const result=await api.publication.read(orgId,{...source,target:{...target,id:dataset.id},revision:dataset.revision});
      if(result.status!=='ready'){if(result.status!=='missing')failures.push(result);return;}
      if(!Object.keys(result.value?.measurements || {}).length)return;
      documents.push({...dataset,title:dataset.name,source:'measurement',value:result.value,provenance:result.provenance,revision:dataset.revision});
    }catch(error){failures.push(error);}
  }));
  let completedReport;
  try {
    const report=completedReport=await api.publication.read(orgId,{provider:'project-widgets',export:'report',target});
    if(report.status==='ready'&&report.value?.reportId&&Object.keys(report.value?.measurements || {}).length){
      const same=documents.find(doc=>doc.source==='measurement'&&(doc.provenance?.reportId===report.value.reportId||doc.value?.artifacts?.some(a=>a.id===report.value.reportId)));
      if(same)same.value={...same.value,measurements:{...report.value.measurements,...same.value.measurements}};
      else if(!documents.some(doc=>doc.source==='measurement'))documents.push({id:`report:${report.value.reportId}`,source:'measurement',title:'Measurements',value:{measurements:report.value.measurements,artifacts:[{id:report.value.reportId,kind:'firstmeasure.report'}]}});
    }
  }catch(error){failures.push(error);}
  documents.sort((a,b)=>a.source.localeCompare(b.source)||String(a.title).localeCompare(String(b.title))||a.id.localeCompare(b.id));
  // Older completed reports can predate dataset publication. Reuse the
  // authorized read-only contracts rather than creating an import.
  if(!documents.some(doc=>doc.source==='measurement'))try {
    const report=completedReport || await api.publication.read(orgId,{provider:'project-widgets',export:'report',target});
    if(report.status==='ready'){
      const quantities=await api.publication.read(orgId,{provider:'project-widgets',export:'measurements',target});
      if(quantities.status==='ready'){
        const measurements=Object.fromEntries((quantities.value.rows || []).filter(row=>typeof row.value==='number'&&Number.isFinite(row.value)).map(row=>[row.key,{value:row.value,unit:row.unit}]));
        if(Object.keys(measurements).length)documents.push({id:`report:${report.value.reportId}`,title:'Completed measurement report',source:'measurement',value:{measurements,artifacts:[{id:report.value.reportId,kind:'firstmeasure.report'}]}});
      }else if(quantities.status!=='missing')failures.push(quantities);
    }else if(report.status!=='missing')failures.push(report);
  }catch(error){failures.push(error);}
  return {documents,error:failures.length?'Some published scope data could not load.':''};
}

// One selectable entry per accepted document, like the Photos thumbnail row.
export function renderDocumentStrip(documents=[],selectedId='') {
  return documents.filter(d=>d.source==='document').map(doc=>{const count=doc.sets?.reduce((n,s)=>n+s.lines.length,0) || 0;return `<button type="button" class="sw-doc-thumb" data-scope-document="${esc(doc.id)}" aria-pressed="${doc.id===selectedId}" title="${esc(doc.title)}"><i class="fas fa-file-signature" aria-hidden="true"></i><span><strong>${esc(doc.title)}</strong><small>${esc([doc.total,'Accepted '+label(doc.document_type).toLowerCase(),count?`${count} material${count===1?'':'s'}`:''].filter(Boolean).join(' · '))}</small></span></button>`;}).join('');
}
function detail(doc) {
  const materials=(doc.sets || []).map(set=>`<section><h3>${esc(set.title)}</h3>${set.lines.length?`<div class="sw-table-wrap"><table><thead><tr><th>Material</th><th>Required</th><th>Order quantity</th><th>Unit cost</th></tr></thead><tbody>${set.lines.map(line=>`<tr><td><strong>${esc(line.name)}</strong>${line.variant?`<small>${esc(line.variant)}</small>`:''}${line.explanation?`<small>${esc(line.explanation)}</small>`:''}${line.group||line.structure?`<small>${esc([line.group,line.structure].filter(Boolean).join(' · '))}</small>`:''}</td><td>${esc(number(line.quantity))} ${esc(line.unit)}</td><td>${esc(number(line.order_quantity))} ${esc(line.order_unit)}</td><td>${line.unit_cost==null?'—':esc(money(line.unit_cost,line.currency))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="sw-empty">This accepted document published a material calculation. Quantities have not been generated yet.</p>'}${set.evaluations?.find(e=>e.id===set.applied_evaluation)?.warnings?.map(w=>`<p class="sw-empty">${esc(w)}</p>`).join('') || ''}</section>`).join('');
  return `<header><small>Accepted ${esc(label(doc.document_type).toLowerCase())}${doc.acceptedAt?` · ${esc(new Date(doc.acceptedAt).toLocaleDateString())}`:''}</small><h2 tabindex="-1">${esc(doc.title)}</h2>${doc.total?`<strong class="sw-total">${esc(doc.total)}</strong>`:''}</header><div class="sw-document-stage" data-scope-stage></div>${materials}`;
}
let rendererReady;
async function renderer() {
  if(window.FMDocRenderer?.render && window.FMDocModel && window.FMDocWidgets)return;
  rendererReady ||= (async()=>{
    for(const [global,url] of [['FMDocModel','/libraries/doc-model/firstmate-doc-model.js'],['FMDocWidgets','/libraries/doc-widgets/firstmate-doc-widgets.js'],['FMDocRenderer','/libraries/doc-renderer/firstmate-doc-renderer.js']]){
      if(window[global])continue;
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=resolve;script.onerror=()=>reject(Error('The accepted document preview could not load.'));document.head.append(script);});
    }
  })().catch(error=>{rendererReady=null;throw error;});
  await rendererReady;
}
const VIEWS=[['roof','fa-ruler-combined','Measurements'],['documents','fa-file-signature','Documents'],['aerial','fa-images','Photos'],['schedule','fa-calendar-days','Schedule']];
export function mountSidebar(root,documents,error,contextKey,options={}) {
  let state=sidebars.get(root);
  // An organization with scheduling off has no Schedule view here at all.
  const scheduling=options.scheduling!==false;
  if(!state || state.contextKey!==contextKey || state.scheduling!==scheduling){
    disposeSidebar(root);
    state={contextKey,scheduling,views:VIEWS.filter(([key])=>scheduling||key!=='schedule'),selected:null,handle:null,view:'roof',widgets:{},visible:true,generation:0};sidebars.set(root,state);
    root.innerHTML=`<div class="sw-viewport"><div class="sw-panel" data-scope-panel="roof"></div><div class="sw-panel" data-scope-panel="documents" hidden></div><div class="sw-panel" data-scope-panel="aerial" hidden></div>${scheduling?'<div class="sw-panel sw-schedule" data-scope-panel="schedule" hidden></div>':''}</div><nav class="sw-tabs" role="tablist" aria-label="Project views">${state.views.map(([key,icon,title])=>`<button type="button" role="tab" aria-label="${title}" aria-selected="${state.view===key}" tabindex="${state.view===key?0:-1}" data-scope-view="${key}" title="${title}"><i class="fas ${icon}" aria-hidden="true"></i><span>${title}</span></button>`).join('')}</nav>`;
    const tabs=[...root.querySelectorAll('[data-scope-view]')];
    tabs.forEach((tab,index)=>{
      tab.onclick=()=>{state.view=tab.dataset.scopeView;showViews(root,state);tab.focus();};
      tab.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();tabs[event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length].click();}};
    });
    root.querySelectorAll('[data-scope-panel]').forEach(panel=>panel.setAttribute('role','tabpanel'));
    state.measurementViewers=new Set();
    // Mount both report views once, before the user selects them. Their DOM,
    // network results and viewer state survive all local tab changes.
    for(const key of ['roof','aerial']){
      const stage=root.querySelector(`[data-scope-panel="${key}"]`);
      if(key==='aerial'){
        let handle,disposed=false,visible=false;
        state.widgets[key]={setVisible(value){visible=value;handle?.setVisible?.(value);},destroy(){disposed=true;handle?.destroy?.();},serialize(){return handle?.serialize?.();}};
        stage.textContent='Loading photos…';
        import('/libraries/image-viewer/photo-gallery.js?v=20261010-project-photos').then(module=>{if(disposed)return;handle=module.mount(stage,{context:options.widgetContext||{}});handle.setVisible(visible);}).catch(()=>{if(!disposed)stage.textContent='The photo viewer could not load.';});
      }else if(window.FirstMateWidgets)state.widgets[key]=window.FirstMateWidgets.mount(stage,{id:'reports.roof',version:'1',config:{}},{...options.widgetContext,getMeasurements:()=>Object.assign({},...(state.documents||[]).filter(d=>d.source==='measurement').map(d=>d.value?.measurements||{}),Object.fromEntries(Object.entries(state.options.measurementOverrides||{}).map(([key,value])=>[key,{value}]))),onMeasurementChange:(key,value)=>state.editMeasurement?.(key,value),subscribeMeasurements:listener=>{state.measurementViewers.add(listener);return ()=>state.measurementViewers.delete(listener);},read:options.widgetContext?.read||((source,target)=>window.PlatformAPI.publication.read(target.organizationId,{...source,target}))});
      else stage.textContent='The report viewer could not load.';
    }
    // Schedule is the project's own schedule panel in its widget form. There is one panel, so it is borrowed while
    // this view is showing and handed back when the view, the tab or the window goes away.
    const scheduleStage=root.querySelector('[data-scope-panel="schedule"]');
    if(scheduleStage)state.widgets.schedule={setVisible(value){const app=window.Portal?.ProjectScheduleApp;if(!app?.mountWidget){if(value)scheduleStage.innerHTML='<div class="sw-doc-empty" role="status"><i class="fas fa-calendar-days" aria-hidden="true"></i><strong>Schedule unavailable</strong><span>The schedule could not load here.</span></div>';return;}if(value)app.mountWidget(scheduleStage,state.options?.scheduleContext||null);else app.releaseWidget(scheduleStage);},destroy(){window.Portal?.ProjectScheduleApp?.releaseWidget?.(scheduleStage);}};
    showViews(root,state);
  }
  state.options=options;
  const fingerprint=JSON.stringify([documents,error,options.measurementOverrides]);
  if(state.fingerprint===fingerprint)return;
  state.fingerprint=fingerprint;state.documents=documents;state.error=error;
  // Documents: the selected accepted document fills the viewer and every accepted document sits in the strip beneath it.
  const drawDocuments=()=>{
    const panel=root.querySelector('[data-scope-panel="documents"]'),accepted=state.documents.filter(d=>d.source==='document');
    const selected=accepted.find(d=>d.id===state.selected)||accepted[0]||null,key=JSON.stringify([accepted,selected?.id,state.error]);
    if(state.documentsKey===key)return;
    state.documentsKey=key;state.selected=selected?.id||null;state.stageObserver?.disconnect();state.handle?.destroy?.();state.handle=null;const generation=++state.generation;
    panel.innerHTML=`<div class="sw-docs"><div class="sw-detail sw-doc-viewer">${selected?detail(selected):`<div class="sw-doc-empty" role="status"><i class="fas fa-file-lines" aria-hidden="true"></i><strong>No document selected</strong><span>${esc(state.error || 'Signed proposals and contracts for this project open here.')}</span></div>`}</div><div class="sw-doc-strip" aria-label="Accepted documents">${accepted.length?renderDocumentStrip(accepted,selected.id):'<span class="sw-doc-strip-empty">No documents yet</span>'}</div></div>`;
    panel.querySelectorAll('[data-scope-document]').forEach(button=>button.onclick=()=>{state.selected=button.dataset.scopeDocument;drawDocuments();[...panel.querySelectorAll('[data-scope-document]')].find(b=>b.dataset.scopeDocument===state.selected)?.focus();});
    const stage=panel.querySelector('[data-scope-stage]');
    if(stage){stage.textContent='Loading accepted document…';renderer().then(()=>{
      if(!stage.isConnected || state.generation!==generation)return;
      const snapshot=selected.snapshot,definition=snapshot.resolved_definition;
      const dims=window.FMDocModel?.paperDimensions?.(definition) || {w_pt:612};
      let width=0;const paint=()=>{if(!stage.clientWidth||stage.clientWidth===width)return;width=stage.clientWidth;state.handle?.destroy?.();stage.innerHTML='';state.handle=window.FMDocRenderer.render(stage,{document:definition,mode:'static',readonly:true,widgetData:snapshot.widget_data || {},widgetContext:{params:snapshot.params || {},outputs:snapshot.outputs || {}},theme:snapshot.theme,themeContext:{overrides:snapshot.theme_vars || {}},scale:Math.min(1,Math.max(0.1,width/(dims.w_pt*96/72)))});};
      // The panel is hidden until its tab is chosen; paint when it first has a width and again on resize.
      paint();state.stageObserver=new ResizeObserver(()=>{if(stage.isConnected)paint();});state.stageObserver.observe(stage);
    }).catch(e=>{if(stage.isConnected)stage.textContent=e.message;});}
  };
  // Measurement edits come from the roof key; its open viewers re-read the merged values.
  const draw=()=>{for(const listener of state.measurementViewers||[])listener();drawDocuments();};
  state.editMeasurement=(key,value)=>{state.options={...state.options,measurementOverrides:{...state.options.measurementOverrides,[key]:value}};state.options.onMeasurementChange?.(key,value);draw();};
  draw();
}
function showViews(root,state){
  // A view that replaces another slides in from the side its tab sits on. The first view shown does not move.
  const order=VIEWS.map(([key])=>key),forward=order.indexOf(state.view)>order.indexOf(state.shown),moving=!!state.shown&&state.shown!==state.view;
  root.querySelectorAll('[data-scope-panel]').forEach(panel=>{const active=panel.dataset.scopePanel===state.view;panel.hidden=!active;panel.classList.remove('sw-enter-forward','sw-enter-back');if(active&&moving){void panel.offsetWidth;panel.classList.add(forward?'sw-enter-forward':'sw-enter-back');}});
  state.shown=state.view;
  root.querySelectorAll('[data-scope-view]').forEach(tab=>{const active=tab.dataset.scopeView===state.view;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
  for(const [key,widget] of Object.entries(state.widgets))widget?.setVisible?.(state.visible&&state.view===key);
  window.dispatchEvent(new Event('resize'));
}
export function disposeSidebar(root){const state=sidebars.get(root);state?.observer?.disconnect();state?.stageObserver?.disconnect();state?.handle?.destroy?.();if(state)for(const widget of Object.values(state.widgets))widget?.destroy?.();sidebars.delete(root);}
/** Shows one of the rail's views, as if its tab had been chosen. */
export function showSidebarView(root,view){const state=sidebars.get(root);if(!state||!(state.views||VIEWS).some(([key])=>key===view))return false;if(state.view!==view){state.view=view;showViews(root,state);}return true;}
export function setSidebarVisible(root,visible){const state=sidebars.get(root);if(state){state.visible=visible;showViews(root,state);}}

export function installDivider(sidebar) {
  const parent = sidebar?.parentElement;
  if (!parent || dividers.has(sidebar)) return;
  const divider = document.createElement('button');
  divider.className = 'mt-scope-divider';
  divider.type = 'button';
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', 'Resize project widgets and scope of work');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-valuemin', '20');
  divider.setAttribute('aria-valuemax', '65');
  let ratio = 100 / 3;
  try { ratio = Number(localStorage.getItem('firstmate.scope.widgetWidth')) || ratio; } catch {}
  const set = value => {
    ratio = Math.min(65, Math.max(20, value));
    sidebar.style.setProperty('--scope-sidebar-width', `${ratio}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(ratio)));
  };
  const save = () => { try { localStorage.setItem('firstmate.scope.widgetWidth', String(ratio)); } catch {} };
  set(ratio);
  let dragging = false;
  divider.addEventListener('pointerdown', event => { dragging = true; divider.setPointerCapture(event.pointerId); event.preventDefault(); });
  divider.addEventListener('pointermove', event => {
    if (!dragging) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width) set((event.clientX - rect.left) / rect.width * 100);
  });
  const stop = () => { if (dragging) { dragging = false; save(); window.dispatchEvent(new Event('resize')); } };
  divider.addEventListener('pointerup', stop);
  divider.addEventListener('pointercancel', stop);
  divider.addEventListener('lostpointercapture', stop);
  divider.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    set(event.key === 'Home' ? 20 : event.key === 'End' ? 65 : ratio + (event.key === 'ArrowRight' ? 2 : -2));
    save(); window.dispatchEvent(new Event('resize'));
  });
  sidebar.after(divider);
  divider.__setRatio = set;
  divider.__ratio = () => ratio;
  dividers.set(sidebar, divider);
}

// Gives the left side at least `percent` of the width, sliding there, for one task (placing on the schedule). It is not
// saved as the person's own width: dragging the divider still does that.
export function widenSidebar(sidebar, percent) {
  const divider = dividers.get(sidebar);
  if (!divider?.__setRatio || divider.__ratio() >= percent) return false;
  sidebar.classList.add('sw-width-animating');
  divider.__setRatio(percent);
  setTimeout(() => { sidebar.classList.remove('sw-width-animating'); window.dispatchEvent(new Event('resize')); }, 420);
  return true;
}

export function removeDivider(sidebar) {
  dividers.get(sidebar)?.remove();
  if (sidebar) dividers.delete(sidebar);
}
