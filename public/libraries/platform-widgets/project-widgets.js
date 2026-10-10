/* First-party widget renderers. Hosts may supply leaf presentation adapters and explicit commands. */
(function(global){
 const W=global.FirstMateWidgets,base=new URL('./',document.currentScript.src);let roofScript;
 const element=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=String(text);return el;};
 function fragment(root,id,context,config){const render=context.fragments?.[id];if(!render)return false;const node=render(config||{});root.append(node);return true;}
 function card(root,title){const card=element('section','fm-widget-card');card.append(element('h3','',title));root.append(card);return card;}
 function liveData(id,selector,render){return (root,options)=>{
   render(root,options);if(options.context.fragments?.[id])return;
   let alive=true,generation=0;return {async refresh({loadData}){const token=++generation,data=await loadData();if(!alive||token!==generation)return;const next=document.createElement('div');render(next,{...options,data});W.reconcile(root,next.innerHTML,selector);},destroy(){alive=false;generation++;}};
 };}
 W.attachRenderer('scope.measurements','1',liveData('scope.measurements','.fm-widget-value',(root,{data,context})=>{
  if(fragment(root,'scope.measurements',context))return;
  const host=card(root,'Measurements'),values=element('div','fm-widget-values');host.append(values);
  for(const row of data?.rows||[]){const field=element('div','fm-widget-value');field.dataset.id=row.key||row.label;field.append(element('span','',row.label),element('strong','',((typeof row.value==='number'||typeof row.value==='string'&&row.value.trim()!=='')&&Number.isFinite(Number(row.value))?Number(row.value).toLocaleString([], {minimumFractionDigits:1,maximumFractionDigits:1}):String(row.value))+(row.unit?' '+row.unit:'')));values.append(field);}
  if(!values.children.length)host.append(element('p','fm-widget-status','No measurements are available yet.'));
 }));
 W.attachRenderer('scope.lists','1',liveData('scope.lists','article',(root,{data,config,context})=>{
  if(fragment(root,'scope.lists',context,config))return;
  const host=card(root,config.resourceType==='labor'?'Labor lists':config.resourceType==='material'?'Material lists':'Lists'),list=element('div','fm-widget-list');host.append(list);
  const rows=(data?.lists||[]).filter(row=>(!config.resourceType||config.resourceType==='all'||config.resourceType===row.resourceType)&&(!config.listId||row.id===config.listId));
  for(const row of rows){const item=element('article');item.dataset.id=row.id;item.append(element('strong','',row.title),element('small','',row.resourceType+' · '+row.status));for(const line of row.items||[])item.append(element('div','',line.title+' · '+line.quantity+' '+line.unit));list.append(item);}
  if(!rows.length)host.append(element('p','fm-widget-status','No lists are available yet.'));
 }));
 W.attachRenderer('reports.photo','1',async(root,{data,config,state})=>{
  const media=(config.mediaKind==='aerial'?(data?.media||[]).filter(m=>m.label==='Aerial view'):data?.media)?.[config.mediaIndex||0];if(!media){root.append(element('div','fm-widget-status','No report image is available yet.'));return;}
  const url=String(media.url||'');if(!/^data:image\/(jpeg|png|webp);base64,/i.test(url)&&new URL(url,location.href).origin!==location.origin)throw Error('This media source is unavailable');
  if(!media.video){const viewer=await import(new URL('../image-viewer/image-viewer.js?v=20261010-interactive',base));return viewer.mount(root,{url,alt:media.label||'Aerial view',initialState:state});}
  const el=element(media.video?'video':'img','fm-widget-photo');el.src=url;el.alt=media.label||'Aerial view';if(media.video){el.controls=true;el.playsInline=true;}el.onerror=()=>{root.replaceChildren(element('div','fm-widget-status','This media could not load.'));};root.append(el);
  return {setVisible(value){if(!value&&media.video)el.pause();},destroy(){if(media.video){el.pause();el.removeAttribute('src');el.load();}el.remove();}};
 });
 W.attachRenderer('reports.roof','1',async(root,{data,state,context})=>{
  if(!global.FirstMeasureRoofViewer){await (roofScript||=(new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=new URL('../apps/measurements/roof-viewer.js?v=20261010-project-roof-key',base);s.onload=resolve;s.onerror=()=>{roofScript=null;reject(Error('The roof viewer could not load'));};document.head.append(s);})) );}
  root.style.height='100%';return global.FirstMeasureRoofViewer.mount(root,{xmlUrl:data?.xmlUrl,edgeTypes:data?.edgeTypes||[],standalone:true,initialState:state,measurements:data?.measurements||{},getMeasurements:context.getMeasurements,onMeasurementChange:context.onMeasurementChange,subscribeMeasurements:context.subscribeMeasurements});
 });
 global.FirstMateProjectWidgets={
  reportItems(media=[]){return [{key:'roof',id:'reports.roof',version:'1',title:'3D roof'},...media.map((m,index)=>({key:'photo-'+index,id:'reports.photo',version:'1',title:m.label||'Reference media',config:{mediaIndex:index}}))];},
  scopeItems(){return [{key:'overview',id:'scope.overview',version:'1',title:'Lists & measurements'},{key:'roof',id:'reports.roof',version:'1',title:'3D roof'},{key:'aerial',id:'reports.photo',version:'1',title:'Aerial view',config:{mediaKind:'aerial'}},{key:'measurements',id:'scope.measurements',version:'1',title:'Measurements'},{key:'lists',id:'scope.lists',version:'1',title:'Lists'},{key:'materials',id:'scope.lists',version:'1',title:'Materials',config:{resourceType:'material'}},{key:'labor',id:'scope.lists',version:'1',title:'Labor',config:{resourceType:'labor'}}];}
 };
})(window);
