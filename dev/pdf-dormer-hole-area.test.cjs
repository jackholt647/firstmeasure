// Dormer area deduction (FM-520): a facet with a hole cut under a dormer (or chimney, skylight) is
// reported without the hole. The roof report printed the facet's whole outline, so the facet under a
// dormer read the same as its bare twin and the dormer's footprint was counted twice in the totals.
// Loads the PDF runtime's own scripts (as dev/pdf-layer-details.test.cjs) and checks the facet labels,
// the total squares and the Layer 1 page.
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const path=require('node:path'),root=path.resolve(__dirname,'..');
const SCRIPTS=['public/v1/node_modules/jspdf/dist/jspdf.umd.min.js','public/libraries/report-units.js','public/measure/internal/editor_scripts/pdf.js','public/measure/internal/editor_scripts/vendor/clipper-lib-6.4.2-clipper.js','public/measure/internal/editor_scripts/vendor/earcut-3.2.3-earcut.dev.js','public/measure/internal/editor_scripts/exterior_geometry.js','public/measure/internal/editor_scripts/wall_solid_geometry.js','public/measure/internal/editor_scripts/exterior_report_model.js','public/measure/internal/editor_scripts/exterior_pdf.js','public/measure/internal/editor_scripts/pdf_standalone.js'];
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
 await page.evaluate(()=>{
  const Pdf=window.jspdf.jsPDF;
  window.__texts=[];
  window.jspdf.jsPDF=function(...args){
   const doc=new Pdf(...args),original=doc.text;
   doc.text=function(...a){try{window.__texts.push(String(Array.isArray(a[0])?a[0].join(' '):a[0]));}catch(e){}return original.apply(this,a);};
   return doc;
  };
 });
});
test.after(async()=>{await browser?.close();});
// Two 6/12 gable facets of 100 x 200 px at 0.1 m/px (200 m² flat each). The left one has a 20 x 40 px
// hole (8 m² flat) under a dormer on layer 2; `reverse` winds the hole the other way round.
function fixture({reverse=false}={}){
 const mpp=.1,rise=.5*mpp,z=(x)=>x<=100?x*rise:(200-x)*rise,p=(x,y,layer=1)=>({x,y,z:z(x),layer});
 const left=[p(0,0),p(100,0),p(100,200),p(0,200)],right=[p(100,0),p(200,0),p(200,200),p(100,200)];
 let hole=[p(20,80),p(40,80),p(40,120),p(20,120)];if(reverse)hole=hole.slice().reverse();
 const top=40*rise+1,d=(x,y,zz)=>({x,y,z:zz,layer:2});
 const dormer=[[d(20,80,top-1),d(40,100,top),d(20,100,top-1)],[d(20,100,top-1),d(40,100,top),d(20,120,top-1)]];
 return {mpp,faces:[{points:left,holes:[hole],layer:1},{points:right,layer:1},...dormer.map(points=>({points,layer:2}))]};
}
const SQFT=10.7639,SLOPE=Math.sqrt(1+.25);
test('the facet under a dormer is reported without the hole cut in it, whichever way the hole winds',async()=>{
 for(const reverse of [false,true]){
  const {mpp,faces}=fixture({reverse});
  const r=await page.evaluate(({faces,mpp})=>{
   const state={imageMetersPerPx:mpp,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:200,height:200},facesData:faces,report:{lines:[],materials:{squares:{},totalSquares:0,linear:{}}},customLabels:[]};
   const calc=window.recalculateReportMaterials(state);
   const labels=buildDefaultDiagramLabelsInternal({report:state.report,facesData:faces,cropRegion:state.cropRegion,dims:state.dims,radiusMeters:state.radiusMeters});
   return {calc,labels:labels.map(l=>({layer:l.layer,areaSqFt:l.areaSqFt})),net:window.getPdfFaceNetAreaPx(faces[0]),whole:window.getPdfFaceNetAreaPx(faces[1])};
  },{faces,mpp});
  const label='hole '+(reverse?'reversed':'same winding');
  assert.equal(r.whole,20000,label+': the bare facet keeps its outline');
  assert.equal(r.net,20000-800,label+': outline less the hole');
  const facet=Math.round(200*SQFT*SLOPE),under=Math.round(192*SQFT*SLOPE);
  const layer1=r.labels.filter(l=>l.layer===1).map(l=>l.areaSqFt).sort((a,b)=>a-b);
  assert.deepEqual(layer1,[under,facet],label+': the PDF labels read '+under+' under the dormer and '+facet+' beside it');
  const dormerSqFt=r.labels.filter(l=>l.layer===2).reduce((s,l)=>s+l.areaSqFt,0);
  assert.ok(dormerSqFt>0,label+': the dormer facets are labelled');
  const expectedSquares=((192+200)*SQFT*SLOPE)/100;
  const layer1Squares=r.calc.totalSquares-(dormerSqFt/100);
  assert.ok(Math.abs(layer1Squares-expectedSquares)<.02,label+': total squares count the hole once, as the dormer ('+layer1Squares.toFixed(3)+' vs '+expectedSquares.toFixed(3)+')');
  assert.ok(Math.abs(r.calc.totalFootprintSqFt-((392*SQFT)+(400*mpp*mpp*SQFT)))<1,label+': the footprint leaves the hole out too');
 }
});
test('a hole listed twice is taken off once, and a hole never makes an area negative',async()=>{
 const r=await page.evaluate(()=>{
  const sq=[{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}],big=[{x:-5,y:-5},{x:20,y:-5},{x:20,y:20},{x:-5,y:20}],h=[{x:2,y:2},{x:4,y:2},{x:4,y:4},{x:2,y:4}];
  return [window.getPdfFaceNetAreaPx({points:sq,holes:[h,h.slice().reverse()]}),window.getPdfFaceNetAreaPx({points:sq,holes:[big]}),window.getPdfFaceNetAreaPx({points:sq})];
 });
 assert.deepEqual(r,[96,0,100]);
});
test('the printed report totals leave the hole out',async()=>{
 const {mpp,faces}=fixture(),roof=faces.filter(f=>f.layer===1);
 const texts=await page.evaluate(async({faces,mpp})=>{
  window.__texts=[];window.projectOrganization=null;
  const snapshot={folderId:'dormer-hole-fixture',address:'1 Dormer Lane',savedAt:'2026-11-16T12:00:00Z',pdfGeneratedAt:'2026-11-16T12:00:00Z',pdfSyncRevision:'dormer-hole-fixture',pdfRenderDateLabel:'11/16/2026',imageMetersPerPx:mpp,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:200,height:200},geometry:{points:faces.flatMap(f=>f.points),connections:[]},facesData:faces,report:{lines:[],materials:{squares:{},totalSquares:0,linear:{}}},customLabels:[],manualWastePct:0};
  await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(snapshot,{folderId:'dormer-hole-fixture',manifest:{id:'dormer-hole-fixture',project_type:'residential'}},{mode:'full',updateStatus:false,pageConfigOverride:{page_top_view:false,page_elevations:false,page_3d:false,page_gutters:false,page_notes:false,page_materials:false,page_ventilation:false,page_pitch:false,page_area:false,page_layers:false,page_summary:false}});
  return window.__texts;
 },{faces:roof,mpp});
 const row=texts.find(t=>/^Total Squares \(Net\): /.test(t));
 assert.ok(row,'the total is printed: '+texts.join(' | '));
 assert.equal(row,'Total Squares (Net): '+(((192+200)*SQFT*SLOPE)/100).toFixed(2),'not '+(((200+200)*SQFT*SLOPE)/100).toFixed(2)+', the outlines alone');
});
