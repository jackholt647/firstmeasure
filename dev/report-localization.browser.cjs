// Local fixture only; requests are intercepted and fulfilled from checked-in assets.
const {chromium}=require('../public/v1/node_modules/playwright-core');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'output/report-localization');
async function main(){
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage();
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'});
   const suffix=url.pathname.replace('/v1/firstmeasure/pdf-runtime','');
   if(!/^\/(fonts\/Montserrat-(Regular|Bold)\.ttf|images\/logo_red\.png)$/.test(suffix))return route.abort();
   return route.fulfill({path:path.join(root,'public',suffix)});
  });
  await page.goto('http://127.0.0.1/');
  for(const file of ['public/v1/node_modules/jspdf/dist/jspdf.umd.min.js','public/libraries/report-units.js','public/measure/internal/editor_scripts/pdf.js','public/measure/internal/editor_scripts/vendor/clipper-lib-6.4.2-clipper.js','public/measure/internal/editor_scripts/vendor/earcut-3.2.3-earcut.dev.js','public/measure/internal/editor_scripts/exterior_geometry.js','public/measure/internal/editor_scripts/wall_solid_geometry.js','public/measure/internal/editor_scripts/exterior_report_model.js','public/measure/internal/editor_scripts/exterior_pdf.js','public/measure/internal/editor_scripts/pdf_standalone.js'])await page.addScriptTag({path:path.join(root,file)});
  const results=await page.evaluate(async()=>{
   const points=[{x:20,y:20,z:0},{x:120,y:20,z:0},{x:120,y:120,z:3},{x:20,y:120,z:3}];
   const lines=points.map((p,i)=>({points:[p,points[(i+1)%4]],layer:1,start:p,end:points[(i+1)%4],type:i%2?'rake':'eave',length:Math.hypot((p.x-points[(i+1)%4].x)*.1,(p.y-points[(i+1)%4].y)*.1,p.z-points[(i+1)%4].z)/.3048}));
   const snapshot={folderId:'local-fixture',address:'10 Test Road',savedAt:'2026-09-21T12:00:00Z',pdfGeneratedAt:'2026-09-21T12:00:00Z',pdfSyncRevision:'localization-fixture',pdfRenderDateLabel:'9/21/2026',imageMetersPerPx:.1,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:140,height:140},geometry:{points,connections:lines},facesData:[{points,layer:1}],report:{lines,materials:{squares:{'4/12':10},totalSquares:10,linear:{eave:65.6168,rake:68.5}}},customLabels:[{id:'face1',faceIndex:0,x:70,y:70,anchorX:70,anchorY:70,areaText:'1124',pitchText:'4/12',text:'4/12',layer:1}],manualWastePct:10,manualTotalFacets:1,pdfConfig:{full:{page_top_view:false,page_elevations:false,page_3d:false,page_layers:false,page_gutters:false,page_ventilation:true,page_notes:false},summary:{page_top_view:false,page_elevations:false,page_3d:false,page_layers:false,page_gutters:false,page_ventilation:true,page_notes:false}}};
   const result={};
   for(const [name,prefs,exterior]of [['roof-default',{},false],['roof-us',{measurement_system:'imperial',report_language:'en-US'},false],['roof-metric-gb',{measurement_system:'metric',report_language:'en-GB'},false],['exterior-us',{},true],['exterior-metric-gb',{measurement_system:'metric',report_language:'en-GB'},true]]){
    const s=JSON.parse(JSON.stringify(snapshot));
    if(exterior){s.exteriorReport=ExteriorReportModel.build({faces:[{points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}],material:'brick'}]});s.exteriorSettings={include:true};}
    const manifest={id:'local-fixture',project_type:'residential',...prefs};
    const rendered=await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(s,{folderId:'local-fixture',manifest},{mode:'full',updateStatus:false});
    const blob=rendered.result.blob;result[name]=Array.from(new Uint8Array(await blob.arrayBuffer()));
   }
   return result;
  });
  fs.mkdirSync(out,{recursive:true});for(const[name,bytes]of Object.entries(results))fs.writeFileSync(path.join(out,name+'.pdf'),Buffer.from(bytes));
  assert.deepEqual(results['roof-default'],results['roof-us'],'default and explicit US PDFs must be byte-identical');
  console.log('Rendered five local fixture PDFs; default and explicit US output is byte-identical.');
 } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});


