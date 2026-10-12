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
function measurementValue(value,key,row={}) {const digits=measurementInfo(key,row).digits;return typeof value==='number'&&Number.isFinite(value)?Number(value.toFixed(digits)).toLocaleString('en-US',{useGrouping:false,maximumFractionDigits:digits}):'';}
const compactNames={roofSquares:'Roof squares',ventilationSquares:'Ventilated area',headWallLf:'Head wall',sideWallLf:'Side wall',parapetLf:'Parapets',protrusionLf:'Protrusions',chimneyBackLf:'Back pan',chimneyStepLf:'Chimney',chimneyApronLf:'Chimney',unknownLf:'Unclassified'};
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
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');const font=el=>{const style=getComputedStyle(el);return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;};
 for(const grid of panel.querySelectorAll('.sw-measure-grid')) {
  const fields=[...grid.children];if(!fields.length||!grid.clientWidth)continue;
  fields.forEach((field,index)=>field.dataset.measureOrder ??= String(index));fields.sort((a,b)=>Number(a.dataset.measureOrder)-Number(b.dataset.measureOrder));
  const widths=new Map();
  for(const field of fields){const name=field.querySelector('.sw-measure-name'),unit=field.querySelector('small'),input=field.querySelector('input');ctx.font=font(input);const text=input.value||'—',digitWidth=Math.max(...'0123456789'.split('').map(digit=>ctx.measureText(digit).width)),textWidth=[...text].reduce((sum,char)=>sum+( /[0-9]/.test(char)?digitWidth:ctx.measureText(char).width),0),style=getComputedStyle(input),inset=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth);const inputWidth=Math.max(32,Math.min(72,Math.ceil(textWidth+inset+2)));field.style.setProperty('--sw-value-width',inputWidth+'px');ctx.font=font(name);const labelWidth=ctx.measureText(name.textContent).width;ctx.font=font(unit);widths.set(field,Math.ceil(labelWidth+Math.max(12,ctx.measureText(unit.textContent).width)+inputWidth+10));}
  let columns=1,score=fields.length,wide=[];
  for(let count=2;count<=Math.min(3,fields.length);count++){const available=(grid.clientWidth-12*(count-1))/count,overflow=fields.filter(field=>widths.get(field)>available),normal=fields.length-overflow.length;if(normal<count)continue;const cost=Math.ceil(normal/count)+overflow.length+overflow.length*.15;if(cost<score){columns=count;score=cost;wide=overflow;}}
  grid.style.setProperty('--sw-measure-columns',columns);
  for(const field of fields)field.classList.toggle('is-wide',wide.includes(field));
  const ordered=[...fields.filter(field=>!wide.includes(field)),...wide],current=[...grid.children];
  if(ordered.some((field,index)=>field!==current[index])){const focused=document.activeElement;ordered.forEach(field=>grid.append(field));if(grid.contains(focused))focused.focus({preventScroll:true});}
 }
}
function measurementFields(doc,showZero=false) {
 const values=doc.value?.measurements || {},keys=Object.keys(values),roof=keys.some(k=>k==='roofArea'||k==='roofSquares'),groups=new Map();
 // Show the full roof edge/flashing checklist, without inventing absent quantities.
 if(roof)for(const [key,definition] of Object.entries(measurementDefinitions))if(['Roof edges','Flashing & openings'].includes(definition[2])&&!keys.includes(key))keys.push(key);
 if(keys.some(k=>/^pitch\d+(?:\.\d+)?Squares$/.test(k)))for(let i=keys.length-1;i>=0;i--)if(/^pitch\d+to|^pitch13Plus|^flatRoofSquares$/.test(keys[i]))keys.splice(i,1);
 const order=['Area','Roof edges','Flashing & openings','Pitch breakdown','Counts','Drainage','Exterior','Other measurements'];
 keys.sort((a,b)=>{const ia=measurementInfo(a,values[a]),ib=measurementInfo(b,values[b]);return order.indexOf(ia.group)-order.indexOf(ib.group)||(ia.group==='Pitch breakdown' ? Number(a.match(/\d+/)?.[0]||0)-Number(b.match(/\d+/)?.[0]||0):0);});
 for(const key of keys){const row=values[key] || {};if(!showZero&&!(Number(row.value)>0))continue;const info=measurementInfo(key,row),tip=measurementTip(key,info,row.value==null);if(!groups.has(info.group))groups.set(info.group,[]);groups.get(info.group).push(info.group==='Pitch breakdown'?`<th scope="col" title="${esc(tip)}">${esc((compactNames[key] || info.name).replace(/ pitch$/, ''))}</th>\n<td title="${esc(tip)}"><input type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]*)?|[.][0-9]+" data-scope-measure="${esc(key)}" value="${esc(measurementValue(row.value,key,row))}" placeholder="—" aria-label="${esc(info.name)}" aria-description="${esc(tip)}"></td>`:`<label class="sw-measure-field" title="${esc(tip)}"><span class="sw-measure-name">${esc(compactNames[key] || info.name)}</span><span><input type="text" inputmode="decimal" pattern="[0-9]+([.][0-9]*)?|[.][0-9]+" data-scope-measure="${esc(key)}" value="${esc(measurementValue(row.value,key,row))}" placeholder="—" aria-label="${esc(info.name)}" aria-description="${esc(tip)}"><small title="${esc(tip)}">${esc(info.unit)}</small></span></label>`);}
 return [...groups].map(([group,fields])=>`<section class="sw-measure-group"><h4>${esc(group)}</h4>${group==='Pitch breakdown'?`<div class="sw-pitch-scroll"><table class="sw-pitch-table"><tbody><tr><th scope="row">Pitch</th>${fields.map(field=>field.split('\n')[0]).join('')}</tr><tr><th scope="row" title="1 roofing square = 100 square feet">Squares</th>${fields.map(field=>field.split('\n')[1]).join('')}</tr></tbody></table></div>`:`<div class="sw-measure-grid">${fields.join('')}</div>`}</section>`).join('');
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
function measurementSection(documents=[],showZero=false) {
  const measures=documents.filter(d=>d.source==='measurement');
  return `<section aria-label="Measurements"><div class="sw-measure-heading"><h3>Measurements</h3><label title="Include zero and unavailable measurements"><input type="checkbox" data-show-zero ${showZero?'checked':''}>Show zero measurements</label></div>${measures.map(doc=>`<div class="sw-measurements" data-measurement-source="${esc(doc.id)}">${measurementFields(doc,showZero)}</div>`).join('') || '<p class="sw-empty">No published measurements yet.</p>'}</section>`;
}
// One selectable entry per accepted document, like the Photos thumbnail row.
export function renderDocumentStrip(documents=[],selectedId='') {
  return documents.filter(d=>d.source==='document').map(doc=>{const count=doc.sets?.reduce((n,s)=>n+s.lines.length,0) || 0;return `<button type="button" class="sw-doc-thumb" data-scope-document="${esc(doc.id)}" aria-pressed="${doc.id===selectedId}" title="${esc(doc.title)}"><i class="fas fa-file-signature" aria-hidden="true"></i><span><strong>${esc(doc.title)}</strong><small>${esc([doc.total,'Accepted '+label(doc.document_type).toLowerCase(),count?`${count} material${count===1?'':'s'}`:''].filter(Boolean).join(' · '))}</small></span></button>`;}).join('');
}
export function renderDocuments(documents=[],error='',showZero=false) {
  return `<div class="sw-home"><section aria-label="Accepted documents"><h3>Documents</h3><div class="sw-doc-strip">${renderDocumentStrip(documents) || '<p class="sw-empty">No accepted documents have published scope artifacts yet.</p>'}</div></section>${measurementSection(documents,showZero)}${error?`<p role="status" class="sw-empty">${esc(error)}</p>`:''}</div>`;
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
const VIEWS=[['roof','fa-ruler-combined','Measurements'],['documents','fa-file-signature','Documents'],['aerial','fa-images','Photos']];
export function mountSidebar(root,documents,error,contextKey,options={}) {
  let state=sidebars.get(root);
  if(!state || state.contextKey!==contextKey){
    disposeSidebar(root);
    state={contextKey,selected:null,handle:null,view:'roof',widgets:{},visible:true,generation:0};sidebars.set(root,state);
    root.innerHTML=`<div class="sw-viewport"><div class="sw-panel" data-scope-panel="roof"><div class="sw-measure-view"><div class="sw-roof-stage"></div><details class="sw-all-measures"><summary>All measurements</summary><div class="sw-home" data-scope-measure-list></div></details></div></div><div class="sw-panel" data-scope-panel="documents" hidden></div><div class="sw-panel" data-scope-panel="aerial" hidden></div></div><nav class="sw-tabs" role="tablist" aria-label="Project views">${VIEWS.map(([key,icon,title])=>`<button type="button" role="tab" aria-label="${title}" aria-selected="${state.view===key}" tabindex="${state.view===key?0:-1}" data-scope-view="${key}" title="${title}"><i class="fas ${icon}" aria-hidden="true"></i><span>${title}</span></button>`).join('')}</nav>`;
    const tabs=[...root.querySelectorAll('[data-scope-view]')];
    tabs.forEach((tab,index)=>{
      tab.onclick=()=>{state.view=tab.dataset.scopeView;showViews(root,state);tab.focus();};
      tab.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();tabs[event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowRight'?1:2))%3].click();}};
    });
    root.querySelectorAll('[data-scope-panel]').forEach(panel=>panel.setAttribute('role','tabpanel'));
    root.querySelector('.sw-all-measures').addEventListener('toggle',event=>{if(event.target.open)fitMeasurementColumns(event.target);window.dispatchEvent(new Event('resize'));});
    state.measurementViewers=new Set();
    // Mount both report views once, before the user selects them. Their DOM,
    // network results and viewer state survive all local tab changes.
    for(const key of ['roof','aerial']){
      const stage=key==='roof'?root.querySelector('.sw-roof-stage'):root.querySelector('[data-scope-panel="aerial"]');
      if(key==='aerial'){
        let handle,disposed=false,visible=false;
        state.widgets[key]={setVisible(value){visible=value;handle?.setVisible?.(value);},destroy(){disposed=true;handle?.destroy?.();},serialize(){return handle?.serialize?.();}};
        stage.textContent='Loading photos…';
        import('/libraries/image-viewer/photo-gallery.js?v=20261010-project-photos').then(module=>{if(disposed)return;handle=module.mount(stage,{context:options.widgetContext||{}});handle.setVisible(visible);}).catch(()=>{if(!disposed)stage.textContent='The photo viewer could not load.';});
      }else if(window.FirstMateWidgets)state.widgets[key]=window.FirstMateWidgets.mount(stage,{id:'reports.roof',version:'1',config:{}},{...options.widgetContext,getMeasurements:()=>Object.assign({},...(state.documents||[]).filter(d=>d.source==='measurement').map(d=>d.value?.measurements||{}),Object.fromEntries(Object.entries(state.options.measurementOverrides||{}).map(([key,value])=>[key,{value}]))),onMeasurementChange:(key,value)=>state.editMeasurement?.(key,value),subscribeMeasurements:listener=>{state.measurementViewers.add(listener);return ()=>state.measurementViewers.delete(listener);},read:options.widgetContext?.read||((source,target)=>window.PlatformAPI.publication.read(target.organizationId,{...source,target}))});
      else stage.textContent='The report viewer could not load.';
    }
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
    panel.innerHTML=`<div class="sw-docs"><div class="sw-detail sw-doc-viewer">${selected?detail(selected):`<p class="sw-empty">No accepted documents yet. Signed proposals and contracts for this project appear here.</p>`}${state.error?`<p role="status" class="sw-empty">${esc(state.error)}</p>`:''}</div>${accepted.length?`<div class="sw-doc-strip" aria-label="Accepted documents">${renderDocumentStrip(accepted,selected.id)}</div>`:''}</div>`;
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
  const draw=()=>{
    state.observer?.disconnect();
    const panel=root.querySelector('[data-scope-measure-list]');
    const displayed=state.documents.map(doc=>doc.source==='measurement'?{...doc,value:{...doc.value,measurements:{...doc.value?.measurements,...Object.fromEntries(Object.entries(state.options.measurementOverrides||{}).map(([key,value])=>[key,{...doc.value?.measurements?.[key],value}]))}}}:doc);
    panel.innerHTML=measurementSection(displayed,state.showZero===true);
    for(const listener of state.measurementViewers||[])listener();
    panel.querySelector('[data-show-zero]')?.addEventListener('change',event=>{state.showZero=event.target.checked;draw();});
    fitMeasurementColumns(panel);state.observer=new ResizeObserver(()=>fitMeasurementColumns(panel));state.observer.observe(panel);document.fonts?.ready.then(()=>{if(panel.isConnected)fitMeasurementColumns(panel);});
    panel.querySelectorAll('[data-scope-measure]').forEach(input=>{
      const key=input.dataset.scopeMeasure;
      if(Object.hasOwn(state.options.measurementOverrides || {},key))input.value=measurementValue(state.options.measurementOverrides[key],key);
      let valid=input.value;
      input.oninput=()=>{if(!/^\d*(?:\.\d*)?$/.test(input.value))input.value=valid;else valid=input.value;};
      input.onkeydown=event=>{if(['e','E','+','-'].includes(event.key))event.preventDefault();};
      input.onchange=()=>{if(input.value!==''&&input.checkValidity()&&Number.isFinite(Number(input.value))){const value=Number(input.value);state.editMeasurement(key,value);input.value=measurementValue(value,key);valid=input.value;fitMeasurementColumns(panel);}else input.value=valid;};
    });
    drawDocuments();
  };
  state.editMeasurement=(key,value)=>{state.options={...state.options,measurementOverrides:{...state.options.measurementOverrides,[key]:value}};state.options.onMeasurementChange?.(key,value);draw();};
  draw();
}
function showViews(root,state){
  root.querySelectorAll('[data-scope-panel]').forEach(panel=>{panel.hidden=panel.dataset.scopePanel!==state.view;});
  root.querySelectorAll('[data-scope-view]').forEach(tab=>{const active=tab.dataset.scopeView===state.view;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});
  for(const [key,widget] of Object.entries(state.widgets))widget?.setVisible?.(state.visible&&state.view===key);
  window.dispatchEvent(new Event('resize'));
}
export function disposeSidebar(root){const state=sidebars.get(root);state?.observer?.disconnect();state?.stageObserver?.disconnect();state?.handle?.destroy?.();if(state)for(const widget of Object.values(state.widgets))widget?.destroy?.();sidebars.delete(root);}
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
