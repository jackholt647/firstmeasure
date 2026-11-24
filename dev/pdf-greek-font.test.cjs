// Greek report PDFs (FM-632): the report embedded only Montserrat, which has no Greek letters, and jsPDF prints
// nothing for a letter its font lacks, so the colour key, page titles and most labels came out blank. A Greek report
// (or one whose address is in Greek) is set in Noto Sans (public/fonts/NotoSans-*.ttf, served by the PDF runtime);
// every other report keeps Montserrat. Box titles are capitalised in the report language (Greek capitals drop accents).
// Local fixture only; requests are fulfilled from checked-in assets (as dev/pdf-translated-key-and-cover.test.cjs).
const test=require('node:test'),assert=require('node:assert/strict');
const {chromium}=require('../public/v1/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'..');
const SCRIPTS=['public/v1/node_modules/jspdf/dist/jspdf.umd.min.js','public/libraries/report-units.js','public/measure/internal/editor_scripts/pdf.js','public/measure/internal/editor_scripts/pdf_standalone.js'];
// Noto Sans ships on the platform lane; before this tree has it, its requests get Montserrat's bytes.
const NOTO=fs.existsSync(path.join(root,'public/fonts/NotoSans-Regular.ttf'));
const GREEK={Ridge:'Κορυφογραμμή',Hip:'Ισχίο',Valley:'Κοιλάδα',Rake:'Κεκλιμένη ακμή',Eave:'Γείσο','Roof Summary':'Σύνοψη στέγης','Roof Measurements':'Μετρήσεις στέγης'};
let browser,page,fonts=[],refuseNoto=false;
test.before(async()=>{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 page=await browser.newPage();
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
  const suffix=url.pathname.replace('/v1/firstmeasure/pdf-runtime','');
  const font=suffix.match(/^\/fonts\/((?:Montserrat|NotoSans)-(?:Regular|Bold))\.ttf$/);
  if(font){
   fonts.push(font[1]);
   if(font[1].startsWith('NotoSans')&&refuseNoto)return route.fulfill({status:404,body:''});
   const file=font[1].startsWith('NotoSans')&&!NOTO?font[1].replace('NotoSans','Montserrat'):font[1];
   return route.fulfill({path:path.join(root,'public/fonts',file+'.ttf')});
  }
  if(suffix==='/images/logo_red.png')return route.fulfill({path:path.join(root,'public',suffix)});
  return route.abort();
 });
 await page.goto('http://127.0.0.1/');
 await page.evaluate(()=>{window.__pdfAssetBaseUrl='/v1/firstmeasure/pdf-runtime';});
 for(const file of SCRIPTS)await page.addScriptTag({path:path.join(root,file)});
 await page.evaluate(()=>{
  const Pdf=window.jspdf.jsPDF;
  window.jspdf.jsPDF=function(...args){
   const doc=new Pdf(...args),text=doc.text;
   doc.text=function(...a){try{const value=String(Array.isArray(a[0])?a[0].join(' '):a[0]);window.__texts.push({value,w:doc.getTextWidth(value),font:doc.getFont().fontName});}catch(e){}return text.apply(this,a);};
   return doc;
  };
 });
});
test.after(async()=>{await browser?.close();});
async function render({locale,address='Kon/nou Paleologou 36, Kifisia 145 63, Greece',dictionary={}}){
 fonts=[];
 const texts=await page.evaluate(async({locale,address,dictionary})=>{
  window.__texts=[];window.projectOrganization=null;
  const metersPerPx=.1,points=[{x:20,y:20,z:0},{x:120,y:20,z:0},{x:120,y:120,z:3},{x:20,y:120,z:3}],types=['eave','rake','ridge','valley','hip'];
  const lines=types.map((type,i)=>{const a=points[i%4],b=points[(i+1)%4];return {points:[a,b],layer:1,start:a,end:b,type,length:Math.hypot((a.x-b.x)*metersPerPx,(a.y-b.y)*metersPerPx,a.z-b.z)/.3048};});
  const linear={eave:293.2,rake:16.6,ridge:70.2,valley:75.3,hip:187.3};
  const snapshot={folderId:'fm632-fixture',address,savedAt:'2026-11-24T12:00:00Z',pdfGeneratedAt:'2026-11-24T12:00:00Z',pdfSyncRevision:'fm632-fixture',pdfRenderDateLabel:'24/11/2026',imageMetersPerPx:metersPerPx,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:140,height:140},geometry:{points,connections:lines},facesData:[{points,layer:1}],report:{lines,materials:{squares:{'4/12':10},totalSquares:10,linear}},customLabels:[{id:'face1',faceIndex:0,x:70,y:70,anchorX:70,anchorY:70,areaText:'1124',pitchText:'4/12',text:'4/12',layer:1}],manualWastePct:10,manualTotalFacets:1};
  const manifest={id:'fm632-fixture',project_type:'residential',measurement_system:'metric',report_language:locale,language_snapshot:{locale,report_dictionary:dictionary}};
  await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(snapshot,{folderId:'fm632-fixture',manifest},{mode:'full',updateStatus:false,pageConfigOverride:{page_top_view:false,page_elevations:false,page_3d:false,page_gutters:false,page_notes:false,page_materials:false,page_ventilation:false,page_pitch:false,page_area:false,page_layers:true,page_summary:false}});
  return window.__texts;
 },{locale,address,dictionary});
 return {texts,fonts:[...new Set(fonts)].sort()};
}
test('a Greek report is set in Noto Sans and draws its Greek words',async()=>{
 const {texts,fonts}=await render({locale:'el-GR',dictionary:GREEK});
 assert.deepEqual(fonts,['NotoSans-Bold','NotoSans-Regular']);
 for(const word of ['Κορυφογραμμή','Ισχίο','Κοιλάδα','Γείσο']){
  const drawn=texts.find(t=>t.value.startsWith(word));
  assert.ok(drawn,`${word} is drawn`);
  // With Montserrat every Greek letter but π and μ had no glyph and no width.
  if(NOTO)assert.ok(drawn.w>word.length*1.2,`${word} is ${drawn.w.toFixed(1)} mm wide`);
 }
 // The cover's box titles in Greek capitals, without accents.
 assert.ok(texts.some(t=>t.value==='ΣΥΝΟΨΗ ΣΤΕΓΗΣ'),texts.filter(t=>/^[Α-Ω]/.test(t.value)).map(t=>t.value).join(' | '));
 assert.ok(texts.some(t=>t.value==='ΜΕΤΡΗΣΕΙΣ ΣΤΕΓΗΣ'));
});
test('other reports keep Montserrat; a Greek address switches to Noto Sans',async()=>{
 assert.deepEqual((await render({locale:'lt-LT',address:'J. Kolaso g. 7, Vilnius'})).fonts,['Montserrat-Bold','Montserrat-Regular']);
 assert.deepEqual((await render({locale:'en-US',address:'J. Kolaso g. 7, Vilnius'})).fonts,['Montserrat-Bold','Montserrat-Regular']);
 assert.deepEqual((await render({locale:'en-US',address:'Κωνσταντίνου Παλαιολόγου 36, Κηφισιά'})).fonts,['NotoSans-Bold','NotoSans-Regular']);
});
test('a host that cannot serve Noto Sans still renders the Greek report in Montserrat',async()=>{
 refuseNoto=true;
 try{
  const {texts,fonts}=await render({locale:'el-GR',dictionary:GREEK});
  assert.deepEqual(fonts,['Montserrat-Bold','Montserrat-Regular','NotoSans-Bold','NotoSans-Regular']);
  assert.ok(texts.length>20);
 }finally{refuseNoto=false;}
});
