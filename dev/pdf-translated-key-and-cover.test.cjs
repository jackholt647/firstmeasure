// Spanish report labels (FM-518): the colour key under the layer drawing used to space its items by the English
// label's width, so "Borde inclinado del hastial" ran into "Alero" and "Babero de encuentro con paramento" into
// "Babero lateral"; and in the cover's Roof Measurements box "Babero de encuentro con paramento:" ran into its length
// (and on the customer cover, "Borde inclinado del hastial" into its own).
// The key's items, its swatches and the details box must not overlap, and every label stays left of its value.
// Local fixture only; requests are fulfilled from checked-in assets (as dev/pdf-layer-details.test.cjs).
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const path=require('node:path'),root=path.resolve(__dirname,'..');
const SCRIPTS=['public/v1/node_modules/jspdf/dist/jspdf.umd.min.js','public/libraries/report-units.js','public/measure/internal/editor_scripts/pdf.js','public/measure/internal/editor_scripts/vendor/clipper-lib-6.4.2-clipper.js','public/measure/internal/editor_scripts/vendor/earcut-3.2.3-earcut.dev.js','public/measure/internal/editor_scripts/exterior_geometry.js','public/measure/internal/editor_scripts/wall_solid_geometry.js','public/measure/internal/editor_scripts/exterior_report_model.js','public/measure/internal/editor_scripts/exterior_pdf.js','public/measure/internal/editor_scripts/pdf_standalone.js'];
// The production Spanish report wording (es-ES pack).
const SPANISH={Ridge:'Cumbrera',Hip:'Limatesa',Valley:'Limahoya',Rake:'Borde inclinado del hastial',Eave:'Alero','Headwall Flashing':'Babero de encuentro con paramento','Sidewall Flashing':'Babero lateral','Parapet Wall':'Muro de peto',Transition:'Encuentro','Roof Measurements':'Mediciones del tejado',Headwall:'Encuentro con paramento',Sidewall:'Encuentro lateral',Parapet:'Peto'};
const LEGEND=Object.values(SPANISH).slice(0,9),COVER_LINES=['Cumbrera','Limatesa','Limahoya','Borde inclinado del hastial','Alero','Encuentro con paramento','Encuentro lateral','Encuentro','Peto'];
let browser,page;
test.before(async()=>{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 page=await browser.newPage();
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
  const suffix=url.pathname.replace('/v1/firstmeasure/pdf-runtime','');
  if(!/^\/(fonts\/Montserrat-(Regular|Bold)\.ttf|images\/logo_red\.png)$/.test(suffix))return route.abort();
  return route.fulfill({path:path.join(root,'public',suffix)});
 });
 await page.goto('http://127.0.0.1/');
 for(const file of SCRIPTS)await page.addScriptTag({path:path.join(root,file)});
 // Record every text, swatch and box with its page and bounds.
 await page.evaluate(()=>{
  const Pdf=window.jspdf.jsPDF;
  window.__calls=[];
  window.jspdf.jsPDF=function(...args){
   const doc=new Pdf(...args),pageNo=()=>doc.internal.getCurrentPageInfo().pageNumber,size=()=>doc.getFontSize()*0.352778;
   const wrap=(name,fn)=>{const original=doc[name];doc[name]=function(...a){try{fn(a);}catch(e){}return original.apply(this,a);};};
   wrap('text',a=>{const value=String(Array.isArray(a[0])?a[0].join(' '):a[0]),w=doc.getTextWidth(value),align=a[3]&&a[3].align;window.__calls.push({kind:'text',page:pageNo(),value,x:align==='right'?a[1]-w:a[1],y:a[2]-size()*0.75,w,h:size()});});
   wrap('rect',a=>window.__calls.push({kind:'rect',page:pageNo(),x:a[0],y:a[1],w:a[2],h:a[3]}));
   wrap('roundedRect',a=>window.__calls.push({kind:'roundedRect',page:pageNo(),x:a[0],y:a[1],w:a[2],h:a[3],style:a[6]}));
   window.__doc=doc;return doc;
  };
 });
});
test.after(async()=>{await browser?.close();});
// A roof with every line type in the key, rendered in Spanish.
async function render({orientation='portrait',mode='full',layers=false}={}){
 return page.evaluate(async({orientation,mode,layers,SPANISH})=>{
  window.__calls=[];window.projectOrganization=null;
  const metersPerPx=.1,points=[{x:20,y:20,z:0},{x:120,y:20,z:0},{x:120,y:120,z:3},{x:20,y:120,z:3}],types=['eave','rake','ridge','valley','hip','head_wall','side_wall','parapet','trans'];
  const lines=types.map((type,i)=>{const a=points[i%4],b=points[(i+1)%4];return {points:[a,b],layer:1,start:a,end:b,type,length:Math.hypot((a.x-b.x)*metersPerPx,(a.y-b.y)*metersPerPx,a.z-b.z)/.3048};});
  const linear={eave:293.2,rake:16.6,ridge:70.2,valley:75.3,hip:187.3,head_wall:15.3,side_wall:13,parapet:20,trans:12};
  const snapshot={folderId:'fm518-fixture',address:'C. Jorge Manrique, 14, 28150 Valdetorres de Jarama, Madrid',savedAt:'2026-11-16T12:00:00Z',pdfGeneratedAt:'2026-11-16T12:00:00Z',pdfSyncRevision:'fm518-fixture',pdfRenderDateLabel:'16/11/2026',imageMetersPerPx:metersPerPx,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:140,height:140},geometry:{points,connections:lines},facesData:[{points,layer:1}],report:{lines,materials:{squares:{'4/12':10},totalSquares:10,linear}},customLabels:[{id:'face1',faceIndex:0,x:70,y:70,anchorX:70,anchorY:70,areaText:'1124',pitchText:'4/12',text:'4/12',layer:1}],manualWastePct:10,manualTotalFacets:1};
  const manifest={id:'fm518-fixture',project_type:'residential',measurement_system:'metric',report_language:'es-ES',language_snapshot:{locale:'es-ES',report_dictionary:SPANISH}};
  await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(snapshot,{folderId:'fm518-fixture',manifest},{mode,updateStatus:false,pageConfigOverride:{page_top_view:false,page_elevations:false,page_3d:false,page_gutters:false,page_notes:false,page_materials:false,page_ventilation:false,page_pitch:false,page_area:false,page_layers:layers,page_summary:false,report_orientation:orientation}});
  return {calls:window.__calls,W:window.__doc.internal.pageSize.getWidth()};
 },{orientation,mode,layers,SPANISH});
}
const overlaps=(a,b)=>a.x<b.x+b.w-.01&&b.x<a.x+a.w-.01&&a.y<b.y+b.h-.01&&b.y<a.y+a.h-.01;
const legendOf=(calls,pageNo)=>{
 const texts=calls.filter(c=>c.kind==='text'&&c.page===pageNo&&LEGEND.some(l=>c.value===l||l.startsWith(c.value)||l.endsWith(c.value)));
 // A legend swatch is the 4 mm square just left of a label.
 const swatches=calls.filter(c=>c.kind==='rect'&&c.page===pageNo&&Math.abs(c.w-4)<.01&&Math.abs(c.h-4)<.01&&texts.some(t=>Math.abs(t.x-c.x-6)<.6||Math.abs(t.x-c.x-6.5)<.6));
 return {texts,swatches};
};
test('the Spanish colour key under the layer drawing: no label runs into another item, in either orientation',async()=>{
 for(const orientation of ['portrait','landscape']){
  const {calls,W}=await render({orientation,layers:true});
  const heading=calls.find(c=>c.kind==='text'&&/^(LAYER|Layer) 1 /i.test(c.value));
  assert.ok(heading,orientation+': the layer page is drawn');
  const {texts,swatches}=legendOf(calls,heading.page);
  const box=calls.find(b=>b.kind==='roundedRect'&&b.page===heading.page&&b.style==='FD'&&heading.y>b.y&&heading.y-b.y<12);
  for(const label of LEGEND)assert.ok(texts.some(t=>t.value===label||label.startsWith(t.value)),orientation+': "'+label+'" is in the key: '+texts.map(t=>t.value).join(' | '));
  assert.equal(swatches.length,LEGEND.length,orientation+': one swatch per item');
  const items=[...texts,...swatches];
  for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)assert.ok(!overlaps(items[i],items[j]),orientation+': "'+(items[i].value||'swatch')+'" overlaps "'+(items[j].value||'swatch')+'"');
  for(const t of items){
   assert.ok(t.x+t.w<=W-10,orientation+': "'+(t.value||'swatch')+'" stays inside the page');
   assert.ok(!overlaps(t,box),orientation+': "'+(t.value||'swatch')+'" stays out of the details box');
  }
 }
});
test('the Spanish cover Roof Measurements box: each label stays left of its value and inside the box, in either orientation',async()=>{
 for(const orientation of ['portrait','landscape']){
  const {calls}=await render({orientation});
  const title=calls.find(c=>c.kind==='text'&&c.page===1&&c.value==='MEDICIONES DEL TEJADO');
  assert.ok(title,orientation+': the box is drawn');
  const box=calls.find(b=>b.kind==='roundedRect'&&b.page===1&&b.style==='FD'&&title.y>b.y&&title.y-b.y<12&&title.x>=b.x&&title.x<b.x+b.w);
  const inBox=calls.filter(c=>c.kind==='text'&&c.page===1&&c!==title&&c.y>box.y&&c.y<box.y+box.h&&c.x>=box.x-1&&c.x<box.x+box.w);
  const values=inBox.filter(t=>/^\d[\d.,]* m$/.test(t.value)),labels=inBox.filter(t=>!values.includes(t));
  assert.ok(values.length>=6,orientation+': the line lengths are drawn: '+inBox.map(t=>t.value).join(' | '));
  assert.ok(labels.some(t=>/^Babero de encuentro/.test(t.value)),orientation+': the long label is drawn');
  assert.ok(labels.some(t=>t.value==='Muro de peto:'),orientation+': the wrapped line does not push the next rows out of the box');
  for(const t of inBox)assert.ok(t.x>=box.x+8-.01&&t.x+t.w<=box.x+box.w-8+.01&&t.y+t.h<=box.y+box.h,orientation+': "'+t.value+'" stays inside the box');
  for(let i=0;i<inBox.length;i++)for(let j=i+1;j<inBox.length;j++)assert.ok(!overlaps(inBox[i],inBox[j]),orientation+': "'+inBox[i].value+'" overlaps "'+inBox[j].value+'"');
  for(const l of labels)for(const v of values)if(Math.abs(l.y-v.y)<l.h)assert.ok(l.x+l.w<=v.x-2,orientation+': "'+l.value+'" stops short of "'+v.value+'"');
 }
});
test('the Spanish customer cover (summary): its line lengths stay beside the stats, inside the box, each label left of its value',async()=>{
 for(const orientation of ['portrait','landscape']){
  const {calls}=await render({orientation,mode:'summary'});
  const title=calls.find(c=>c.kind==='text'&&c.page===1&&c.value==='MEDICIONES DEL TEJADO');
  assert.ok(title,orientation+': the box is drawn');
  const box=calls.find(b=>b.kind==='roundedRect'&&b.page===1&&b.style==='FD'&&title.y>b.y&&title.y-b.y<12&&title.x>=b.x&&title.x<b.x+b.w);
  const inBox=calls.filter(c=>c.kind==='text'&&c.page===1&&c!==title&&c.y>box.y-1&&c.x>=box.x-1&&c.x<box.x+box.w&&c.y<box.y+box.h+30);
  const values=inBox.filter(t=>/^\d[\d.,]* m$/.test(t.value)),labels=inBox.filter(t=>!values.includes(t));
  assert.equal(values.length,COVER_LINES.length,orientation+': every line length is drawn: '+inBox.map(t=>t.value).join(' | '));
  for(const name of COVER_LINES)assert.ok(labels.some(t=>t.value===name||name.startsWith(t.value)),orientation+': "'+name+'" is drawn');
  for(const t of inBox)assert.ok(t.x>=box.x+8-.01&&t.x+t.w<=box.x+box.w-8+.01&&t.y+t.h<=box.y+box.h,orientation+': "'+t.value+'" stays inside the box');
  for(let i=0;i<inBox.length;i++)for(let j=i+1;j<inBox.length;j++)assert.ok(!overlaps(inBox[i],inBox[j]),orientation+': "'+inBox[i].value+'" overlaps "'+inBox[j].value+'"');
  for(const l of labels)for(const v of values)if(Math.abs(l.y-v.y)<l.h)assert.ok(l.x+l.w<=v.x-2,orientation+': "'+l.value+'" stops short of "'+v.value+'"');
 }
});
