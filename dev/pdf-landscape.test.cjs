// Landscape PDFs: every page type stays inside the page and above the footer; elevations put the
// drawing on the left and the table on the right; the orientation comes from a render override, the
// report's exterior settings or the organization default. Local fixture only; requests are fulfilled
// from checked-in assets (as dev/report-localization.browser.cjs does).
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
 // Record every drawing call with its page, so bounds can be checked without rasterizing.
 await page.evaluate(()=>{
  const Pdf=window.jspdf.jsPDF;
  window.__calls=[];
  window.jspdf.jsPDF=function(...args){
   const doc=new Pdf(...args),pageNo=()=>doc.internal.getCurrentPageInfo().pageNumber,size=()=>doc.getFontSize()*0.352778;
   const wrap=(name,fn)=>{const original=doc[name];doc[name]=function(...a){try{fn(a);}catch(e){}return original.apply(this,a);};};
   wrap('text',a=>{const lines=Array.isArray(a[0])?a[0]:[String(a[0])],opts=a[3]&&typeof a[3]==='object'?a[3]:{};const width=Math.max(0,...lines.map(l=>doc.getTextWidth(String(l))));let x0=a[1];if(opts.align==='right')x0-=width;else if(opts.align==='center')x0-=width/2;
    window.__calls.push({kind:'text',page:pageNo(),value:lines.join(' '),x:x0,y:a[2]-size()*0.75,w:width,h:size()*(1+(lines.length-1)*1.15)});});
   wrap('addImage',a=>{if(typeof a[2]==='number')window.__calls.push({kind:'image',page:pageNo(),x:a[2],y:a[3],w:a[4],h:a[5]});});
   for(const name of ['rect','roundedRect'])wrap(name,a=>window.__calls.push({kind:name,page:pageNo(),x:a[0],y:a[1],w:a[2],h:a[3],style:name==='roundedRect'?a[6]:a[4]}));
   window.__doc=doc;return doc;
  };
 });
});
test.after(async()=>{await browser?.close();});
// A box house with a hip roof, its exterior model and every roof page turned on.
async function render({mode='full',override={},exteriorSettings={include:true,frontBearing:180},organization=null,exterior=true}={}){
 return page.evaluate(async({mode,override,exteriorSettings,organization,exterior})=>{
  window.__calls=[];window.projectOrganization=organization;
  const points=[{x:20,y:20,z:0},{x:120,y:20,z:0},{x:120,y:120,z:3},{x:20,y:120,z:3}];
  const lines=points.map((p,i)=>({points:[p,points[(i+1)%4]],layer:1,start:p,end:points[(i+1)%4],type:i%2?'rake':'eave',length:Math.hypot((p.x-points[(i+1)%4].x)*.1,(p.y-points[(i+1)%4].y)*.1,p.z-points[(i+1)%4].z)/.3048}));
  const snapshot={folderId:'landscape-fixture',address:'10 Test Road',savedAt:'2026-09-21T12:00:00Z',pdfGeneratedAt:'2026-09-21T12:00:00Z',pdfSyncRevision:'landscape-fixture',pdfRenderDateLabel:'9/21/2026',imageMetersPerPx:.1,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:140,height:140},geometry:{points,connections:lines},facesData:[{points,layer:1}],report:{lines,materials:{squares:{'4/12':10},totalSquares:10,linear:{eave:65.6168,rake:68.5}}},customLabels:[{id:'face1',faceIndex:0,x:70,y:70,anchorX:70,anchorY:70,areaText:'1124',pitchText:'4/12',text:'4/12',layer:1}],manualWastePct:10,manualTotalFacets:1,pdfConfig:{full:{page_top_view:false,page_elevations:false,page_3d:false,page_gutters:false,page_notes:false},summary:{page_top_view:false,page_elevations:false,page_3d:false,page_gutters:false,page_notes:false}}};
  const box=(x0,y0,x1,y1,h)=>({points:[{x:x0,y:y0,z:0},{x:x1,y:y1,z:0},{x:x1,y:y1,z:h},{x:x0,y:y0,z:h}],material:'brick'});
  const walls=[box(0,0,12,0,3),box(12,0,12,8,3),box(12,8,0,8,3),box(0,8,0,0,3)];
  // Many small faces on the front so the elevation table is long.
  for(let i=0;i<14;i++)walls.push({...box(i*.8,-.6,i*.8+.6,-.6,2),material:i%2?'siding':'stucco'});
  const roof={faces:[{points:[{x:-.3,y:-.3,z:3},{x:12.3,y:-.3,z:3},{x:6,y:4,z:6}]},{points:[{x:12.3,y:-.3,z:3},{x:12.3,y:8.3,z:3},{x:6,y:4,z:6}]},{points:[{x:12.3,y:8.3,z:3},{x:-.3,y:8.3,z:3},{x:6,y:4,z:6}]},{points:[{x:-.3,y:8.3,z:3},{x:-.3,y:-.3,z:3},{x:6,y:4,z:6}]}]};
  if(exterior)snapshot.exteriorReport=ExteriorReportModel.build({faces:walls,roof,base:{faces:[{points:[{x:0,y:0,z:0},{x:12,y:0,z:0},{x:12,y:8,z:0},{x:0,y:8,z:0}]}]}});
  if(exterior)snapshot.exteriorReport.openings.push({id:'W01-1',label:'Window',wall:'W01',width:3,height:4,area:12,perimeter:14});
  snapshot.exteriorSettings=exteriorSettings;
  const manifest={id:'landscape-fixture',project_type:'residential'};
  await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(snapshot,{folderId:'landscape-fixture',manifest,organization},{mode,updateStatus:false,pageConfigOverride:{page_materials:true,page_ventilation:true,page_pitch:true,page_area:true,page_layers:true,page_summary:true,...override}});
  const doc=window.__doc,W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight(),pages=doc.getNumberOfPages(),titles={};
  for(const c of window.__calls)if(c.kind==='text'&&c.y<22&&c.x>W/2&&!titles[c.page])titles[c.page]=c.value;
  return {W,H,pages,titles,calls:window.__calls};
 },{mode,override,exteriorSettings,organization,exterior});
}
// Content stays inside the page and above the footer (address and page number at H - 16).
function overflow(r){
 const out=[],footer=r.H-16;
 for(const c of r.calls){
  const isFooter=c.kind==='text'&&Math.abs(c.y+c.h*.75-footer)<.6,sidebar=c.x<10&&c.h>r.H-1;
  if(isFooter||sidebar)continue;
  const right=c.x+c.w,bottom=c.y+c.h,limit=c.kind==='text'?footer-1.5:footer-.5;
  if(c.x<-.01||c.y<-.01||right>r.W+.01||bottom>limit+(c.kind==='text'?0:1.6))out.push({page:c.page,title:r.titles[c.page],...c,value:c.value?.slice(0,40)});
 }
 return out;
}
test('every page of a full and a summary landscape PDF is landscape and stays inside the page, above the footer',async()=>{
 for(const mode of ['full','summary']){
  const r=await render({mode,override:{report_orientation:'landscape'}});
  assert.ok(r.W>r.H&&Math.abs(r.W-279.4)<.1,'landscape letter');
  const bad=overflow(r);assert.deepEqual(bad,[],mode+' content past the page or the footer');
  const titles=Object.values(r.titles).join(' | ');
  for(const title of mode==='full'?['Roof Summary','Roof Materials','Roof Pitch Diagram','Roof Area Diagram','Roof Layer 1 Measurements','Exterior Summary','Front Elevation','Wall Dimensions','Opening Schedule','Exterior Quantities','Material Allowances']:['Roof Summary'])assert.ok(titles.includes(title),mode+' has '+title+': '+titles);
 }
});
test('a landscape elevation draws the house on the left and its table on the right',async()=>{
 const r=await render({override:{report_orientation:'landscape'}});
 const pages=Object.entries(r.titles).filter(([,t])=>/ Elevation$/.test(t)).map(([p])=>Number(p));assert.equal(pages.length,4);
 let checked=0;
 for(const p of pages){
  const drawing=r.calls.filter(c=>c.page===p&&c.kind==='image').sort((a,b)=>b.w*b.h-a.w*a.h)[0],header=r.calls.find(c=>c.page===p&&c.kind==='text'&&c.value==='Wall');
  if(!header)continue;checked++;
  assert.ok(drawing.x<r.W*.2&&drawing.x+drawing.w<=header.x,'drawing left of the table on page '+p);
  assert.ok(drawing.w>(r.W-40)*.55,'the drawing takes most of the width');assert.ok(drawing.y+drawing.h>r.H*.8,'the drawing uses the full height');
 }
 assert.ok(checked>=2,'elevations with faces were checked');
});
test('orientation: a render override, then the report setting, then the organization default, else portrait',async()=>{
 const org=v=>({report_settings:{general:{report_orientation:v}}});
 const size=async o=>{const r=await render(o);return r.W>r.H?'landscape':'portrait';};
 assert.equal(await size({}),'portrait','default');
 assert.equal(await size({organization:org('landscape')}),'landscape','organization default');
 assert.equal(await size({organization:org('landscape'),exteriorSettings:{include:true,orientation:'portrait'}}),'portrait','report override');
 assert.equal(await size({exteriorSettings:{include:true,orientation:'landscape'}}),'landscape','report setting');
 assert.equal(await size({organization:org('portrait'),exteriorSettings:{include:true,orientation:'portrait'},override:{report_orientation:'landscape'}}),'landscape','render override');
 const resolved=await page.evaluate(()=>[ExteriorPDF.reportOrientation({}),ExteriorPDF.reportOrientation({orientation:'landscape'})]);assert.deepEqual(resolved,['portrait','landscape']);
});
test('portrait output does not depend on the new setting: explicit portrait equals the default byte for byte',async()=>{
 const pdf=async o=>{await render(o);return page.evaluate(()=>Array.from(new Uint8Array(window.__doc.output('arraybuffer'))));};
 const a=await pdf({}),b=await pdf({override:{report_orientation:'portrait'}});assert.equal(a.length,b.length);assert.deepEqual(a,b);
 const r=await render({});assert.deepEqual(overflow(r),[],'portrait stays inside the page too');
});
test('a single-page portrait elevation ends its tables as far above the footer address as the address is above the page edge',async()=>{
 const r=await render({});
 const p=Number(Object.entries(r.titles).find(([,t])=>t==='Back Elevation')[0]),boxes=r.calls.filter(c=>c.page===p&&c.kind==='roundedRect'&&c.style==='FD'&&c.x>20);// the boxes, not their shadows
 const lowest=Math.max(...boxes.map(b=>b.y+b.h)),address=r.H-16-2.2;
 assert.ok(Math.abs((address-lowest)-16)<.6,'gap above the address equals the gap below it: '+(address-lowest));
});
test('a roof-only landscape PDF keeps the original roof titles and order and stays inside its pages',async()=>{
 for(const mode of ['full','summary']){
  const r=await render({mode,exterior:false,exteriorSettings:{},override:{report_orientation:'landscape'}});
  assert.ok(r.W>r.H);assert.deepEqual(overflow(r),[],mode+' roof-only content past the page or the footer');
  const titles=Object.values(r.titles);
  if(mode==='full'){assert.ok(titles.includes('Pitch Diagram')&&titles.includes('Project Summary'),titles.join(' | '));assert.ok(titles.indexOf('Pitch Diagram')<titles.indexOf('Project Summary'),'diagrams before the summary');assert.ok(!titles.some(t=>/^Roof (Elevations|Pitch|Summary)/.test(t)),'no roof-prefixed titles');}
 }
});
