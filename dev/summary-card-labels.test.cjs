// Summary page totals card (1M8-256, FM-305): a long line-type label (Headwall Flashing, Sidewall Flashing, longer
// in other languages) never runs into its right-aligned value. Renders the real summary page in a local fixture and
// checks every label/value row of the card; requests are fulfilled from checked-in assets (as dev/pdf-landscape.test.cjs).
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
 // Record every text call with its box (left edge from the alignment), font size and page.
 await page.evaluate(()=>{
  const Pdf=window.jspdf.jsPDF;
  window.__calls=[];
  window.jspdf.jsPDF=function(...args){
   const doc=new Pdf(...args),text=doc.text;
   doc.text=function(...a){
    try{
     const lines=Array.isArray(a[0])?a[0]:[String(a[0])],opts=a[3]&&typeof a[3]==='object'?a[3]:{};
     const w=Math.max(0,...lines.map(l=>doc.getTextWidth(String(l))));let x=a[1];
     if(opts.align==='right')x-=w;else if(opts.align==='center')x-=w/2;
     window.__calls.push({page:doc.internal.getCurrentPageInfo().pageNumber,value:lines.join(' '),x,y:a[2],w,size:doc.getFontSize(),align:opts.align||'left'});
    }catch(e){}
    return text.apply(this,a);
   };
   window.__doc=doc;return doc;
  };
 });
});
test.after(async()=>{await browser?.close();});
// The reported project: metric, 4/12, with every flashing line type in the card. `labels` translates the card's names.
async function render({orientation='portrait',manifest={},labels={}}={}){
 return page.evaluate(async({orientation,manifest,labels})=>{
  window.__calls=[];
  const points=[{x:20,y:20,z:0},{x:120,y:20,z:0},{x:120,y:120,z:3},{x:20,y:120,z:3}];
  const lines=points.map((p,i)=>({points:[p,points[(i+1)%4]],layer:1,start:p,end:points[(i+1)%4],type:i%2?'rake':'eave',length:Math.hypot((p.x-points[(i+1)%4].x)*.1,(p.y-points[(i+1)%4].y)*.1,p.z-points[(i+1)%4].z)/.3048}));
  const linear={ridge:98,hip:231,valley:176,rake:62,eave:303,head_wall:107.15,side_wall:115.55,trans:12,parapet:40,protrusion:9,chimney_back:6,chimney_edge:14,chimney_front:5};
  const snapshot={folderId:'summary-card-fixture',address:'10 Test Road',savedAt:'2026-10-29T12:00:00Z',pdfGeneratedAt:'2026-10-29T12:00:00Z',pdfSyncRevision:'summary-card-fixture',pdfRenderDateLabel:'10/29/2026',imageMetersPerPx:.1,radiusMeters:10,dims:{w:200,h:200},cropRegion:{minX:0,minY:0,width:140,height:140},geometry:{points,connections:lines},facesData:[{points,layer:1}],report:{lines,materials:{squares:{'4/12':111.41},totalSquares:111.41,linear}},customLabels:[{id:'face1',faceIndex:0,x:70,y:70,anchorX:70,anchorY:70,areaText:'11141',pitchText:'4/12',text:'4/12',layer:1}],manualWastePct:10,manualTotalFacets:1,pdfConfig:{summary:{page_top_view:false,page_elevations:false,page_3d:false,page_layers:false,page_gutters:false,page_notes:false}}};
  const full={id:'summary-card-fixture',project_type:'residential',measurement_system:'metric',report_language:'en-GB',...manifest};
  if(Object.keys(labels).length)full.language_snapshot={locale:full.report_language,report_dictionary:labels,catalog_versions:{reports:'fixture-'+full.report_language}};
  await FirstMatePDFStandalone.generateProjectPdfFromSnapshot(snapshot,{folderId:full.id,manifest:full},{mode:'summary',updateStatus:false,pageConfigOverride:{page_summary:true,report_orientation:orientation}});
  return {W:window.__doc.internal.pageSize.getWidth(),calls:window.__calls};
 },{orientation,manifest,labels});
}
// The card's rows: right-aligned values in the right-hand column, each with the label drawn level with it (a wrapped
// label is two lines centred on the value's baseline).
function cardRows(r,labels){
 const page=r.calls.find(c=>c.value===labels.roofArea)?.page;
 assert.ok(page,'summary card drawn');
 const onPage=r.calls.filter(c=>c.page===page),first=onPage.find(c=>c.value===labels.roofArea);
 const right=onPage.find(c=>c.align==='right'&&c.x>first.x&&Math.abs(c.y-first.y)<.01),edge=right.x+right.w;
 const values=onPage.filter(c=>c.align==='right'&&Math.abs(c.x+c.w-edge)<.01&&c.y>=first.y-.01&&c.y<first.y+20*8);
 return values.map(v=>({value:v,label:onPage.filter(c=>c.align==='left'&&Math.abs(c.x-first.x)<.01&&Math.abs(c.y-v.y)<3.2)}));
}
function assertNoOverlap(rows,where){
 assert.ok(rows.length>=15,where+': every row of the card is drawn ('+rows.length+')');
 for(const {value,label} of rows){
  assert.ok(label.length>=1&&label.length<=2,where+': '+value.value+' has a label on one or two lines');
  for(const line of label){
   assert.ok(line.x+line.w<value.x-.5,where+': "'+line.value+'" ('+(line.x+line.w).toFixed(2)+' mm) runs into "'+value.value+'" ('+value.x.toFixed(2)+' mm)');
   assert.ok(line.size>=6,where+': "'+line.value+'" stays readable ('+line.size+' pt)');
  }
 }
 return rows;
}
const label=(rows,text)=>rows.find(r=>r.label.map(l=>l.value).join(' ').replace(/- /g,'-')===text);
test('metric summary card: Headwall and Sidewall Flashing never overlap their values, portrait and landscape',async()=>{
 for(const orientation of ['portrait','landscape']){
  const rows=assertNoOverlap(cardRows(await render({orientation}),{roofArea:'Roof Area'}),orientation);
  for(const name of ['Headwall Flashing','Sidewall Flashing']){
   const row=label(rows,name);
   assert.ok(row,orientation+': '+name+' row');
   assert.match(row.value.value,/^\d+(\.\d+)? m$/,orientation+': '+name+' value in metres');
  }
  // Short labels keep the card's size.
  const ridge=label(rows,'Ridge');
  assert.equal(ridge.label[0].size,ridge.value.size,orientation+': Ridge keeps the card size');
 }
});
// The card's names as the shipped language packs translate them (public/v1/platform/localization/packs, 2026-10-29).
const PACKS={"de-DE": {"Roof Area": "Dachfläche", "Facets": "Dachflächen", "Pitch": "Dachneigung", "Skylights": "Dachfenster", "Chimneys": "Schornsteine", "Ridge": "First", "Hip": "Grat", "Valley": "Kehle", "Rake": "Ortgang", "Eave": "Traufe", "Headwall Flashing": "Firstwandanschlussblech", "Sidewall Flashing": "Seitenwandanschlussblech", "Transition": "Übergang", "Parapet Wall": "Attika", "Protrusion": "Dachaufbau", "Chimney Back Pan": "Kamin-Rückblech", "Chimney Step": "Kamin-Stufenblech", "Chimney Apron": "Kamin-Frontblech", "Counter Flashing": "Gegenblech"}, "nl-NL": {"Roof Area": "Dakoppervlakte", "Facets": "Dakvlakken", "Pitch": "Dakhelling", "Skylights": "Dakramen", "Chimneys": "Schoorstenen", "Ridge": "Nok", "Hip": "Hoekkeper", "Valley": "Kilgoot", "Rake": "Gevelrand", "Eave": "Dakrand", "Headwall Flashing": "Aansluiting tegen opgaande wand", "Sidewall Flashing": "Zijaansluiting", "Transition": "Overgang", "Parapet Wall": "Attikamuur", "Protrusion": "Uitstekend deel", "Chimney Back Pan": "Achterplaat schoorsteen", "Chimney Step": "Trapsgewijze aansluiting schoorsteen", "Chimney Apron": "Voorplaat schoorsteen", "Counter Flashing": "Tegenflitsing"}, "da-DK": {"Roof Area": "Tagareal", "Facets": "Tagflader", "Pitch": "Hældning", "Skylights": "Ovenlysvinduer", "Chimneys": "Skorstene", "Ridge": "Tagryg", "Hip": "Valm", "Valley": "Skotrende", "Rake": "Vindskede", "Eave": "Tagfod", "Headwall Flashing": "Inddækning ved gavl", "Sidewall Flashing": "Inddækning ved sidevæg", "Transition": "Overgang", "Parapet Wall": "Brystning", "Protrusion": "Fremspring", "Chimney Back Pan": "Baginddækning ved skorsten", "Chimney Step": "Trininddækning ved skorsten", "Chimney Apron": "Forkantsinddækning ved skorsten", "Counter Flashing": "Modinddækning"}, "sv-SE": {"Roof Area": "Takyta", "Facets": "Takytor", "Pitch": "Taklutning", "Skylights": "Takfönster", "Chimneys": "Skorstenar", "Ridge": "Nock", "Hip": "Höft", "Valley": "Ränndal", "Rake": "Gavelkant", "Eave": "Takfot", "Headwall Flashing": "Anslutningsbeslag vid vägg", "Sidewall Flashing": "Sidoväggsbeslag", "Transition": "Övergång", "Parapet Wall": "Parapetvägg", "Protrusion": "Utskjutande del", "Chimney Back Pan": "Skorstensbeslag, bakstycke", "Chimney Step": "Skorstensstegbeslag", "Chimney Apron": "Skorstensbeslag, framstycke", "Counter Flashing": "Motbeslag"}};
// Nothing of the label is lost: the lines read as the label once spaces and hyphens are set aside.
const letters=s=>s.replace(/[\s-]/g,'');
test('translated line-type names are used in the card, long ones wrap between words and nothing is cut off',async()=>{
 for(const [locale,labels] of Object.entries(PACKS))for(const orientation of ['portrait','landscape']){
  const where=locale+' '+orientation,rows=assertNoOverlap(cardRows(await render({orientation,manifest:{report_language:locale},labels}),{roofArea:labels['Roof Area']}),where);
  const shown=rows.map(r=>r.label.map(l=>l.value));
  for(const [english,name] of Object.entries(labels)){
   if(['Skylights','Chimneys'].includes(english))continue;
   const lines=shown.find(l=>letters(l.join(''))===letters(name));
   assert.ok(lines,where+': '+english+' shown whole as "'+name+'" ('+JSON.stringify(shown)+')');
   // A word is broken inside only when it is wider than the label at 6 pt (the German single-word flashing names).
   const words=name.split(/\s+/).flatMap(w=>w.split(/(?<=-)/));
   if(!/^(Firstwandanschlussblech|Seitenwandanschlussblech)$/.test(name))for(const line of lines)assert.ok(line.split(/\s+/).flatMap(w=>w.split(/(?<=-)/)).every(w=>words.includes(w)),where+': "'+line+'" breaks a word of "'+name+'"');
  }
 }
});
