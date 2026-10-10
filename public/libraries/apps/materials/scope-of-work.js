const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dividers = new WeakMap(), sidebars = new WeakMap();
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined,{maximumFractionDigits:2}) : 'Unavailable';
const label = value => String(value || '').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_.-]/g,' ').replace(/^./,c=>c.toUpperCase());
// Presentation precision never changes the published source quantities.
const measurementDefinitions = {
 roofArea:['Roof area','ft²','Area'],ventilationSquares:['Ventilated roof area','sq','Area'],roofSquares:['Roofing squares','sq','Area'],shingleSquares:['Shingle area','sq','Area'],flatRoofSquares:['Low slope · up to 2/12','sq','Pitch breakdown'],
 ridgesLf:['Ridges','ft','Roof edges'],hipsLf:['Hips','ft','Roof edges'],valleyLf:['Valleys','ft','Roof edges'],eavesLf:['Eaves','ft','Roof edges'],rakesLf:['Rakes','ft','Roof edges'],
 headWallLf:['Headwall flashing','ft','Flashing & openings'],sideWallLf:['Sidewall / step flashing','ft','Flashing & openings'],transitionsLf:['Transitions','ft','Flashing & openings'],parapetLf:['Parapet walls','ft','Flashing & openings'],protrusionLf:['Protrusion edges','ft','Flashing & openings'],chimneyBackLf:['Chimney back pan','ft','Flashing & openings'],chimneyStepLf:['Chimney step flashing','ft','Flashing & openings'],chimneyApronLf:['Chimney apron','ft','Flashing & openings'],skylightLf:['Skylight perimeter','ft','Flashing & openings'],unknownLf:['Unclassified edges','ft','Roof edges'],
 chimneysEa:['Chimneys','each','Counts'],skylightsEa:['Skylights','each','Counts'],pipeBootsEa:['Pipe boots','each','Counts'],structureCount:['Structures','each','Counts'],gutterLf:['Gutters','ft','Drainage'],downspoutLf:['Downspouts','ft','Drainage'],
 pitch2to4Squares:['Over 2/12–4/12','sq','Pitch breakdown'],pitch4to6Squares:['Over 4/12–6/12','sq','Pitch breakdown'],pitch6to8Squares:['Over 6/12–8/12','sq','Pitch breakdown'],pitch9to12Squares:['Over 8/12–12/12','sq','Pitch breakdown'],pitch13PlusSquares:['Over 12/12','sq','Pitch breakdown'],
 wallGrossArea:['Gross wall area','ft²','Exterior'],wallNetArea:['Net wall area','ft²','Exterior'],wallOpeningArea:['Wall openings','ft²','Exterior'],wallOpeningPerimeter:['Opening perimeter','ft','Exterior'],wallTopLf:['Wall top edges','ft','Exterior'],wallBottomLf:['Wall bottom edges','ft','Exterior'],wallTransitionsLf:['Wall transitions','ft','Exterior'],wallTerminationsLf:['Wall terminations','ft','Exterior'],insideCornersLf:['Inside corners','ft','Exterior'],outsideCornersLf:['Outside corners','ft','Exterior'],wallReturnsArea:['Wall returns','ft²','Exterior']
};
const friendlyUnits={ft2:'ft²',sqft:'ft²',roofing_square:'sq',ft:'ft',m2:'m²',ea:'each',count:'each',percent:'%',degree:'°'};
function measurementInfo(key,row={}) {
 const known=measurementDefinitions[key],pitch=key.match(/^pitch(\d+(?:\.\d+)?)Squares$/);
 const unit=row.unit?(friendlyUnits[row.unit] || label(row.unit)):known?.[1] || '';
 return {name:known?.[0] || (pitch?`${pitch[1]}/12 pitch`:label(key).replace(/\bLf$/,'').replace(/\bEa$/,'')),unit,group:known?.[2] || (pitch?'Pitch breakdown':'Other measurements'),digits:unit==='ft²'||unit==='m²'||unit==='each'?0:unit==='ft'||unit==='m'?1:2};
}
function measurementValue(value,key,row={}) {const digits=measurementInfo(key,row).digits;return typeof value==='number'&&Number.isFinite(value)?String(Number(value.toFixed(digits))):'';}
const compactNames={roofSquares:'Roof squares',ventilationSquares:'Ventilated area',headWallLf:'Headwall',sideWallLf:'Sidewall / step',parapetLf:'Parapets',protrusionLf:'Protrusions',chimneyBackLf:'Chimney back pan',chimneyStepLf:'Chimney step',unknownLf:'Unclassified'};
function measurementTip(key,info,missing) {
 const notes=[info.name];
 if(info.group==='Pitch breakdown')notes.push('Pitch is rise per 12 inches of horizontal run. This value is the roof area at this pitch, in roofing squares.');
 if(info.unit==='sq')notes.push('1 roofing square = 100 square feet; roofing squares = roof area in square feet ÷ 100.');
 if(missing)notes.push('The source did not supply this measurement. Enter a value to use a project override.');
 return notes.join(' ');
}
// Each section measures its own labels; long flashing names must not force
// short edge/pitch sections to use fewer columns. Recompute on rail resizing.
export function fitMeasurementColumns(panel) {
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
 for(const grid of panel.querySelectorAll('.sw-measure-grid')) {
  const fields=[...grid.children];if(!fields.length||!grid.clientWidth)continue;
  let needed=150;
  for(const field of fields){const name=field.querySelector('.sw-measure-name'),unit=field.querySelector('small');ctx.font=getComputedStyle(name).font;const labelWidth=ctx.measureText(name.textContent).width;ctx.font=getComputedStyle(unit).font;needed=Math.max(needed,Math.ceil(labelWidth+ctx.measureText(unit.textContent).width+64+12));}
  const columns=Math.min(3,fields.length,Math.max(1,Math.floor((grid.clientWidth+12)/(needed+12))));
  grid.style.setProperty('--sw-measure-columns',columns);
 }
}
function measurementFields(doc) {
 const values=doc.value?.measurements || {},keys=Object.keys(values),roof=keys.some(k=>k==='roofArea'||k==='roofSquares'),groups=new Map();
 // Show the full roof edge/flashing checklist, without inventing absent quantities.
 if(roof)for(const [key,definition] of Object.entries(measurementDefinitions))if(['Roof edges','Flashing & openings'].includes(definition[2])&&!keys.includes(key))keys.push(key);
 if(keys.some(k=>/^pitch\d+(?:\.\d+)?Squares$/.test(k)))for(let i=keys.length-1;i>=0;i--)if(/^pitch\d+to|^pitch13Plus|^flatRoofSquares$/.test(keys[i]))keys.splice(i,1);
 const order=['Area','Roof edges','Flashing & openings','Pitch breakdown','Counts','Drainage','Exterior','Other measurements'];
 keys.sort((a,b)=>{const ia=measurementInfo(a,values[a]),ib=measurementInfo(b,values[b]);return order.indexOf(ia.group)-order.indexOf(ib.group)||(ia.group==='Pitch breakdown' ? Number(a.match(/\d+/)?.[0]||0)-Number(b.match(/\d+/)?.[0]||0):0);});
 for(const key of keys){const row=values[key] || {},info=measurementInfo(key,row),tip=measurementTip(key,info,row.value==null);if(!groups.has(info.group))groups.set(info.group,[]);groups.get(info.group).push(`<label class="sw-measure-field" title="${esc(tip)}"><span class="sw-measure-name">${esc(compactNames[key] || info.name)}</span><span><input type="number" min="0" step="${10**-info.digits}" data-scope-measure="${esc(key)}" value="${esc(measurementValue(row.value,key,row))}" placeholder="—" aria-label="${esc(info.name)}" aria-description="${esc(tip)}"><small title="${esc(tip)}">${esc(info.unit)}</small></span></label>`);}
 return [...groups].map(([group,fields])=>`<section class="sw-measure-group"><h4>${esc(group)}</h4><div class="sw-measure-grid">${fields.join('')}</div></section>`).join('');
}
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

function measurements(doc,limit=Infinity) {
  return Object.entries(doc.value?.measurements || {}).slice(0,limit).map(([key,row])=>`<div class="sw-measure"><span>${esc(label(key))}</span><strong>${esc(number(row.value))} <small>${esc(row.unit)}</small></strong></div>`).join('');
}
function summary(doc) {
  if(doc.source==='measurement')return measurements(doc,3);
  const count=doc.sets?.reduce((n,s)=>n+s.lines.length,0) || 0;
  return `<div class="sw-summary"><strong>${esc(doc.total || 'Accepted document')}</strong><span>${doc.sets?.length || 0} published material artifact${doc.sets?.length===1?'':'s'} · ${count} material${count===1?'':'s'}</span></div>`;
}
function tile(doc,index) {
  return `<button type="button" class="sw-tile ${doc.source==='measurement'?'sw-tile-measurement':''}" data-scope-document="${esc(doc.id)}" aria-describedby="sw-preview-${index}">
    <span class="sw-tile-heading"><i class="fas ${doc.source==='measurement'?'fa-ruler-combined':'fa-file-signature'}" aria-hidden="true"></i><strong>${esc(doc.title)}</strong></span>
    ${summary(doc)}<span class="sw-tile-footer">${doc.source==='measurement'?'Published measurements':'Accepted · '+esc(label(doc.document_type))}<span aria-hidden="true">↗</span></span>
    <span class="sw-hover" role="tooltip" id="sw-preview-${index}"><strong>${esc(doc.title)}</strong>${doc.source==='measurement'?measurements(doc,8):doc.sets.map(set=>`<span>${esc(set.title)}</span>${set.lines.slice(0,4).map(line=>`<span>${esc(line.name)} · ${esc(number(line.quantity))} ${esc(line.unit)}</span>`).join('') || '<span>Published calculation · awaiting generated quantities</span>'}`).join('')}<span>Open to see all published data</span></span></button>`;
}
export function renderDocuments(documents=[],error='') {
  const docs=documents.filter(d=>d.source==='document'), measures=documents.filter(d=>d.source==='measurement');
  return `<div class="sw-home"><section aria-label="Published scope documents"><h3>Scope documents</h3><div class="sw-tiles">${docs.map((d,i)=>tile(d,i)).join('') || '<p class="sw-empty">No accepted documents have published scope artifacts yet.</p>'}</div></section><section aria-label="Measurements"><h3>Measurements</h3>${measures.map(doc=>`<div class="sw-measurements" data-measurement-source="${esc(doc.id)}">${measurementFields(doc)}</div>`).join('') || '<p class="sw-empty">No published measurements yet.</p>'}</section>${error?`<p role="status" class="sw-empty">${esc(error)}</p>`:''}</div>`;
}
function detail(doc) {
  const materials=(doc.sets || []).map(set=>`<section><h3>${esc(set.title)}</h3>${set.lines.length?`<div class="sw-table-wrap"><table><thead><tr><th>Material</th><th>Required</th><th>Order quantity</th><th>Unit cost</th></tr></thead><tbody>${set.lines.map(line=>`<tr><td><strong>${esc(line.name)}</strong>${line.variant?`<small>${esc(line.variant)}</small>`:''}${line.explanation?`<small>${esc(line.explanation)}</small>`:''}${line.group||line.structure?`<small>${esc([line.group,line.structure].filter(Boolean).join(' · '))}</small>`:''}</td><td>${esc(number(line.quantity))} ${esc(line.unit)}</td><td>${esc(number(line.order_quantity))} ${esc(line.order_unit)}</td><td>${line.unit_cost==null?'—':esc(money(line.unit_cost,line.currency))}</td></tr>`).join('')}</tbody></table></div>`:'<p class="sw-empty">This accepted document published a material calculation. Quantities have not been generated yet.</p>'}${set.evaluations?.find(e=>e.id===set.applied_evaluation)?.warnings?.map(w=>`<p class="sw-empty">${esc(w)}</p>`).join('') || ''}</section>`).join('');
  return `<div class="sw-detail"><button type="button" class="sw-back" data-scope-back>← Back</button><header><small>${doc.source==='measurement'?'Published measurements':'Accepted scope document'}</small><h2 tabindex="-1">${esc(doc.title)}</h2>${doc.total?`<strong class="sw-total">${esc(doc.total)}</strong>`:''}${doc.acceptedAt?`<p>Accepted ${esc(new Date(doc.acceptedAt).toLocaleDateString())}</p>`:''}</header>${doc.source==='measurement'?`<section>${measurements(doc)}<h3>Source artifacts</h3>${(doc.value.artifacts || []).map(a=>`<p>${esc(label(a.kind))}<small class="sw-source-id">${esc(a.id)}</small></p>`).join('')}</section>`:materials+'<section><h3>Accepted document</h3><div class="sw-document-stage" data-scope-stage></div></section>'}</div>`;
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
export function mountSidebar(root,documents,error,contextKey,options={}) {
  let state=sidebars.get(root);
  if(!state || state.contextKey!==contextKey){
    disposeSidebar(root);
    state={contextKey,selected:null,handle:null,view:'scope',widgets:{},visible:true,generation:0};sidebars.set(root,state);
    root.innerHTML=`<div class="sw-viewport"><div class="sw-panel" data-scope-panel="scope"></div><div class="sw-panel" data-scope-panel="roof" hidden></div><div class="sw-panel" data-scope-panel="aerial" hidden></div></div><nav class="sw-tabs" role="tablist" aria-label="Project views">${[['scope','fa-file-contract','Scope of Work'],['roof','fa-cube','3D Roof'],['aerial','fa-map','Aerial View']].map(([key,icon,title])=>`<button type="button" role="tab" aria-label="${title}" aria-selected="${state.view===key}" tabindex="${state.view===key?0:-1}" data-scope-view="${key}" title="${title}"><i class="fas ${icon}" aria-hidden="true"></i><span>${title}</span></button>`).join('')}</nav>`;
    const tabs=[...root.querySelectorAll('[data-scope-view]')];
    tabs.forEach((tab,index)=>{
      tab.onclick=()=>{state.view=tab.dataset.scopeView;showViews(root,state);tab.focus();};
      tab.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();tabs[event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3].click();}};
    });
    // Mount both report views once, before the user selects them. Their DOM,
    // network results and viewer state survive all local tab changes.
    for(const key of ['roof','aerial']){
      const stage=root.querySelector(`[data-scope-panel="${key}"]`);stage.setAttribute('role','tabpanel');
      if(window.FirstMateWidgets)state.widgets[key]=window.FirstMateWidgets.mount(stage,{id:key==='roof'?'reports.roof':'reports.photo',version:'1',config:key==='aerial'?{mediaKind:'aerial'}:{}},{...options.widgetContext,read:(source,target)=>window.PlatformAPI.publication.read(target.organizationId,{...source,target})});
      else stage.textContent='The report viewer could not load.';
    }
    showViews(root,state);
  }
  state.options=options;
  const fingerprint=JSON.stringify([documents,error,options.measurementOverrides]);
  if(state.fingerprint===fingerprint)return;
  state.fingerprint=fingerprint;state.documents=documents;state.error=error;
  const draw=()=>{
    state.observer?.disconnect();state.handle?.destroy?.();state.handle=null;state.generation++;
    const selected=state.documents.find(d=>d.id===state.selected);
    const panel=root.querySelector('[data-scope-panel="scope"]');
    panel.innerHTML=selected?detail(selected):renderDocuments(state.documents,state.error);
    if(selected){
      panel.querySelector('[data-scope-back]').onclick=()=>{const id=state.selected;state.selected=null;draw();[...panel.querySelectorAll('[data-scope-document]')].find(b=>b.dataset.scopeDocument===id)?.focus();};
      panel.querySelector('h2')?.focus({preventScroll:true});
      const stage=panel.querySelector('[data-scope-stage]'),generation=state.generation;
      if(stage){stage.textContent='Loading accepted document…';renderer().then(()=>{
        if(!stage.isConnected || state.generation!==generation)return;
        const snapshot=selected.snapshot,definition=snapshot.resolved_definition;
        const dims=window.FMDocModel?.paperDimensions?.(definition) || {w_pt:612};
        const paint=()=>{state.handle?.destroy?.();stage.innerHTML='';state.handle=window.FMDocRenderer.render(stage,{document:definition,mode:'static',readonly:true,widgetData:snapshot.widget_data || {},widgetContext:{params:snapshot.params || {},outputs:snapshot.outputs || {}},theme:snapshot.theme,themeContext:{overrides:snapshot.theme_vars || {}},scale:Math.min(1,Math.max(0.1,stage.clientWidth/(dims.w_pt*96/72)))});};
        paint();state.observer=new ResizeObserver(()=>{if(stage.isConnected&&stage.clientWidth)paint();});state.observer.observe(stage);
      }).catch(e=>{if(stage.isConnected)stage.textContent=e.message;});}
    }else {
      fitMeasurementColumns(panel);state.observer=new ResizeObserver(()=>fitMeasurementColumns(panel));state.observer.observe(panel);document.fonts?.ready.then(()=>{if(panel.isConnected)fitMeasurementColumns(panel);});
      panel.querySelectorAll('[data-scope-document]').forEach(button=>button.onclick=()=>{state.selected=button.dataset.scopeDocument;draw();});
      panel.querySelectorAll('[data-scope-measure]').forEach(input=>{
        const key=input.dataset.scopeMeasure;
        if(Object.hasOwn(state.options.measurementOverrides || {},key))input.value=measurementValue(state.options.measurementOverrides[key],key);
        input.onchange=()=>{if(input.value!==''&&input.checkValidity())state.options.onMeasurementChange?.(key,Number(input.value));};
      });
    }
  };
  draw();
}
function showViews(root,state){
  root.querySelectorAll('[data-scope-panel]').forEach(panel=>{panel.hidden=panel.dataset.scopePanel!==state.view;});
  root.querySelectorAll('[data-scope-view]').forEach(tab=>{const active=tab.dataset.scopeView===state.view;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
  for(const [key,widget] of Object.entries(state.widgets))widget?.setVisible?.(state.visible&&state.view===key);
  window.dispatchEvent(new Event('resize'));
}
export function disposeSidebar(root){const state=sidebars.get(root);state?.observer?.disconnect();state?.handle?.destroy?.();if(state)for(const widget of Object.values(state.widgets))widget?.destroy?.();sidebars.delete(root);}
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
  dividers.set(sidebar, divider);
}

export function removeDivider(sidebar) {
  dividers.get(sidebar)?.remove();
  if (sidebar) dividers.delete(sidebar);
}
