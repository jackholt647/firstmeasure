// Layer N Details box (FM-378): the three totals (facets, area without and with waste) never overlap
// and stay inside the box, whatever the language and units; a French metric report used to draw
// "Surface (m²) sans marge de perte" over "Surface (m²) avec marge de perte". US reports keep their
// columns. Local fixture only; requests are fulfilled from checked-in assets (as dev/pdf-landscape.test.cjs).
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const path=require('node:path'),root=path.resolve(__dirname,'..');
const SCRIPTS=['public/v1/node_modules/jspdf/dist/jspdf.umd.min.js','public/libraries/report-units.js','public/measure/internal/editor_scripts/pdf.js','public/measure/internal/editor_scripts/vendor/clipper-lib-6.4.2-clipper.js','public/measure/internal/editor_scripts/vendor/earcut-3.2.3-earcut.dev.js','public/measure/internal/editor_scripts/exterior_geometry.js','public/measure/internal/editor_scripts/wall_solid_geometry.js','public/measure/internal/editor_scripts/exterior_report_model.js','public/measure/internal/editor_scripts/exterior_pdf.js','public/measure/internal/editor_scripts/pdf_standalone.js'];
// The production French report wording for these totals (fr-FR pack).
const FRENCH={'Facets: {value1}':'Facettes : {value1}','Area (m²) Without Waste':'Surface (m²) sans marge de perte','Area (m²) With Waste':'Surface (m²) avec marge de perte','Squares Without Waste':'Carrés sans marge de perte','Squares With Waste':'Carrés avec marge de perte'};
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
 // Record every text and box with its page and bounds.
 await page.evaluate(()=>{
  const Pdf=window.jspdf.jsPDF;
  window.__calls=[];
  window.jspdf.jsPDF=function(...args){
   const doc=new Pdf(...args),pageNo=()=>doc.internal.getCurrentPageInfo().pageNumber,size=()=>doc.getFontSize()*0.352778;
   const wrap=(name,fn)=>{const original=doc[name];doc[name]=function(...a){try{fn(a);}catch(e){}return original.apply(this,a);};};
   wrap('text',a=>{const value=String(Array.isArray(a[0])?a[0].join(' '):a[0]);window.__calls.push({kind:'text',page:pageNo(),value,x:a[1],y:a[2]-size()*0.75,w:doc.getTextWidth(value),h:size()});});
   wrap('roundedRect',a=>window.__calls.push({kind:'roundedRect',page:pageNo(),x:a[0],y:a[1],w:a[2],h:a[3],style:a[6]}));
   window.__doc=doc;return doc;
  };
 });
});
test.after(async()=>{await browser?.close();});
// A hip roof with every line type in the key, so the line lengths wrap to two rows.
async function layerPage({orientation='portrait',manifest={},metersPerPx=.1}={}){
 return page.evaluate(async({orientation,manifest,metersPerPx})=>{
  window.__calls=[];window.projectOrganization=null;
  const points=[{x:20,y:20,z:0},{x:120,y:20,z:0},{x:120,y:120,z:3},{x:20,y:120,z:3}],types=['eave','rake','ridge','valley','hip','headwall_flashing','sidewall_flashing'];
  const lines=types.map((type,i)=>{const a=points[i%4],b=points[(i+1)%4];return {points:[a,b],layer:1,start:a,end:b,type,length:Math.hypot((a.x-b.x)*metersPerPx,(a.y-b.y)*metersPerPx,a.z-b.z)/.3048};});
  const snapshot={folderId:'layer-details-fixture',address:'25 Rue Eugène Givors',savedAt:'2026-11-10T12:00:00Z',pdfGeneratedAt:'2026-11-10T12:00:00Z',pdfSyncRevision:'layer-details-fixture',pdfRenderDateLabel:'11/10/2026',imageMetersPerPx:metersPerPx,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:140,height:140},geometry:{points,connections:lines},facesData:[{points,layer:1}],report:{lines,materials:{squares:{'4/12':10},totalSquares:10,linear:{eave:65.6168,rake:68.5}}},customLabels:[{id:'face1',faceIndex:0,x:70,y:70,anchorX:70,anchorY:70,areaText:'1124',pitchText:'4/12',text:'4/12',layer:1}],manualWastePct:10,manualTotalFacets:1};
  await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(snapshot,{folderId:'layer-details-fixture',manifest:{id:'layer-details-fixture',project_type:'residential',...manifest}},{mode:'full',updateStatus:false,pageConfigOverride:{page_top_view:false,page_elevations:false,page_3d:false,page_gutters:false,page_notes:false,page_materials:false,page_ventilation:false,page_pitch:false,page_area:false,page_layers:true,page_summary:false,report_orientation:orientation}});
  const calls=window.__calls,heading=calls.find(c=>c.kind==='text'&&/^(LAYER|Layer) 1 /i.test(c.value)&&calls.some(b=>b.kind==='roundedRect'&&b.page===c.page&&b.style==='FD'&&c.y>b.y&&c.y-b.y<12));
  const box=calls.find(b=>b.kind==='roundedRect'&&b.page===heading.page&&b.style==='FD'&&heading.y>b.y&&heading.y-b.y<12);
  const inBox=calls.filter(c=>c.kind==='text'&&c.page===box.page&&c!==heading&&c.y>box.y&&c.y<box.y+box.h&&c.x>=box.x-1&&c.x<box.x+box.w);
  return {box,texts:inBox,W:window.__doc.internal.pageSize.getWidth()};
 },{orientation,manifest,metersPerPx});
}
const overlaps=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
function checkBox(r,label){
 const pad=8,{box,texts}=r;
 for(const t of texts){
  assert.ok(t.x>=box.x+pad-.01&&t.x+t.w<=box.x+box.w-pad+.01,label+': "'+t.value+'" stays between the box sides');
  assert.ok(t.y+t.h<=box.y+box.h-2,label+': "'+t.value+'" stays above the box bottom ('+(t.y+t.h).toFixed(1)+' vs '+(box.y+box.h).toFixed(1)+')');
 }
 for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++)assert.ok(!overlaps(texts[i],texts[j]),label+': "'+texts[i].value+'" overlaps "'+texts[j].value+'"');
}
const FR={measurement_system:'metric',report_language:'fr-FR',language_snapshot:{locale:'fr-FR',report_dictionary:FRENCH}};
test('French metric totals in the Layer Details box do not overlap and stay inside it, portrait and landscape',async()=>{
 for(const orientation of ['portrait','landscape'])for(const metersPerPx of [.1,.5]){
  const r=await layerPage({orientation,manifest:FR,metersPerPx}),label=orientation+' at '+metersPerPx+' m/px';
  const without=r.texts.find(t=>/^Surface \(m²\) sans marge de perte/.test(t.value)),withWaste=r.texts.find(t=>/^Surface \(m²\) avec marge de perte/.test(t.value));
  assert.ok(r.texts.some(t=>/^Facettes : 1$/.test(t.value))&&without&&withWaste,label+': all three totals are drawn: '+r.texts.map(t=>t.value).join(' | '));
  checkBox(r,label);
 }
});
test('US totals keep their columns in portrait: Facets, then the areas 34 and 90 to the right',async()=>{
 const r=await layerPage({}),left=r.box.x+8,at=re=>r.texts.find(t=>re.test(t.value));
 assert.ok(Math.abs(at(/^Facets: 1$/).x-left)<.01);assert.ok(Math.abs(at(/^Squares Without Waste: /).x-left-34)<.01);assert.ok(Math.abs(at(/^Squares With Waste: /).x-left-90)<.01);
 assert.equal(new Set(r.texts.filter(t=>/^(Facets|Squares)/.test(t.value)).map(t=>t.y.toFixed(3))).size,1,'on one line');
 assert.equal(r.box.h,50,'the usual box height');
 checkBox(r,'US portrait');
});
