import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {createRequire} from 'node:module';import ts from 'typescript';
const root=new URL('../../../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8'),require=createRequire(import.meta.url);
function functions(file,names){const code=read(file),tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true),found=[];function visit(n){if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))found.push(n.getText(tree));ts.forEachChild(n,visit);}visit(tree);assert.equal(found.length,names.length);return found.join('\n');}

// The published dataset of the dev pilot full-house project (exteriors_057d...), trimmed.
const pilot={roofSquares:{value:43.5958,unit:'roofing_square'},eavesLf:{value:336.08,unit:'ft'},ridgesLf:{value:92.56,unit:'ft'},hipsLf:{value:311.27,unit:'ft'},sideWallLf:{value:98.13,unit:'ft'},
 wallNetArea:{value:4430.779,unit:'ft2'},wallGrossArea:{value:4430.779,unit:'ft2'},wallOpeningArea:{value:0,unit:'ft2'},wallOpeningPerimeter:{value:0,unit:'ft'},wallReturnsArea:{value:0,unit:'ft2'},
 wallTopLf:{value:385.06,unit:'ft'},wallBottomLf:{value:399.237,unit:'ft'},insideCornersLf:{value:182.35,unit:'ft'},outsideCornersLf:{value:357.479,unit:'ft'},wallTransitionsLf:{value:0,unit:'ft'},wallTerminationsLf:{value:108.884,unit:'ft'}};
const roofValues=Object.fromEntries(Object.entries(pilot).filter(([k])=>!/^wall|Corners/.test(k)).map(([k,v])=>[k,v.value]));

function summaryContext(scope,{roofLoadFails=false}={}){
 const names=['formatSummaryNumber','reportSummaryRowsFromRoofMeasurements','reportSummaryIsFullHouse','reportSummaryWallRows','reportSummaryWithWallRows','reportSummaryStandardDetail','reportSummaryMetricCacheKey','loadReportSummaryMetricsFromXml','csvCell','csvNumericCell','summaryMetricLabel','reportSummaryMeasurementsCsv'];
 const context={Intl,Map,Set,Promise,measurementSummaryMetricCache:new Map(),measurementSummaryMetricLoads:new Set(),activeBaseProject:{id:'project_1'},activePreviewTab:'measurements',activeMeasurementTab:'summary',renderMeasurementsPanel(){},
  reportOrderManifest:()=>({measurement_scope:scope}),reportSummaryMetricsFromXml:()=>[],fmUrl:path=>'/v1/firstmeasure/'+path,requested:[],
  fetch:async url=>{context.requested.push(url);if(url==='/v1/firstmeasure/projects/exteriors_x/exterior-measurements')return {ok:true,json:async()=>({ok:true,measurements:pilot})};throw new Error('XML is not read when the dataset has roof rows');},
  // A customer is refused the publication dataset (403), so the shared roof load fails for them.
  window:{reportOrderState:{},FirstMeasureAPI:{roofMeasurements:{load:async()=>{if(roofLoadFails)throw new Error('403 capability_denied');return {measurements:roofValues,source:{status:'ready',value:{measurements:pilot}},origin:'project_measurement_dataset'};}}}}};
 vm.createContext(context);vm.runInContext(functions('public/libraries/apps/measurements/project.js',names),context);return context;
}
async function loadedRows(scope,options){const context=summaryContext(scope,options);context.loadReportSummaryMetricsFromXml('model_data.xml','exteriors_x');for(let i=0;i<20&&!context.measurementSummaryMetricCache.has('exteriors_x');i++)await new Promise(r=>setImmediate(r));return {context,rows:context.measurementSummaryMetricCache.get('exteriors_x')};}

test('a full-house customer summary adds the Report.pdf exterior summary and quantities after the roof rows',async()=>{
 const {context,rows}=await loadedRows('full_house');
 const plain=v=>JSON.parse(JSON.stringify(v)),walls=plain(rows.filter(r=>r.wall).map(r=>[r.label,r.value,r.unit]));
 assert.deepEqual(walls,[['Net wall area','4,430.8','sq ft'],['Gross wall area','4,430.8','sq ft'],['Opening area','0','sq ft'],['Opening perimeter','0','ft'],['Horizontal returns','0','sq ft'],
  ['Top of walls','385.1','ft'],['Bottom of walls','399.2','ft'],['Inside corners','182.4','ft'],['Outside corners','357.5','ft'],['Material transitions','0','ft'],['Exposed vertical terminations','108.9','ft']]);
 assert.ok(rows.findIndex(r=>r.wall)>rows.findLastIndex(r=>!r.wall),'walls follow the roof');
 const merged=context.reportSummaryWithWallRows([{label:'Roof squares',value:'43.6',unit:'sq'}],rows);
 assert.match(context.reportSummaryMeasurementsCsv(merged),/\r\nNet wall area,4430.8,sq ft\r\n/);
 assert.equal(context.reportSummaryStandardDetail(context.reportSummaryIsFullHouse(),true),'Full house PDF with roof, gutter and exterior wall measurements');
 // The wall rows still load when the customer's roof dataset load is refused.
 const refused=await loadedRows('full_house',{roofLoadFails:true});
 assert.deepEqual(plain(refused.rows.map(r=>r.label)),plain(walls.map(w=>w[0])));
 // Values in another unit are never shown as square feet.
 assert.equal(context.reportSummaryWallRows({wallNetArea:{value:400,unit:'m2'}}).length,0);assert.equal(context.reportSummaryWallRows(undefined).length,0);
});

test('a roof-only summary renders exactly as before, even when its dataset holds wall keys',async()=>{
 const {context,rows}=await loadedRows('roof');
 assert.deepEqual(JSON.parse(JSON.stringify(rows)),JSON.parse(JSON.stringify(context.reportSummaryRowsFromRoofMeasurements(roofValues))));
 assert.ok(!rows.some(r=>r.wall));assert.equal(context.requested.length,0,'a roof-only summary makes no exterior request');
 const refused=await loadedRows('roof',{roofLoadFails:true});assert.equal(refused.rows.length,0);assert.equal(refused.context.requested.length,0);
 const roofRows=[{label:'Roof squares',value:'43.6',unit:'sq'},{label:'Eaves',value:'336',unit:'ft'}];
 assert.deepEqual(JSON.parse(JSON.stringify(context.reportSummaryWithWallRows(roofRows,rows))),roofRows);
 assert.equal(context.reportSummaryStandardDetail(false,true),'Main roof measurement PDF with gutter measurements');
 assert.equal(context.reportSummaryStandardDetail(false,false),'Main roof measurement PDF');
});

test('the customer Summary.pdf of a full-house order carries one Exterior Summary page; the full report keeps every exterior page',()=>{
 const pdf=read('public/measure/internal/editor_scripts/pdf.js');
 assert.match(pdf,/mode === 'summary' && isCustomerFullHousePdf\(state\) && state\.exteriorReport\?\.walls\?\.length \? customerExteriorPages\(s\) : null/);
 assert.match(pdf,/window\.drawExteriorReportPages\(doc, state\.exteriorReport, state\.exteriorSettings \|\| \{\}, beginReportPage, brandingColors, summaryExteriorPages\)/);
 assert.match(pdf,/CUSTOMER_EXTERIOR_PAGE_DEFAULTS = \{ ext_page_summary: true, ext_page_elevations: false, ext_page_dimensions: false, ext_page_openings: false, ext_page_quantities: false, ext_page_allowances: false, ext_page_notes: false \}/,'by default a customer PDF carries only the Exterior Summary');
 const X=require('../../measure/internal/editor_scripts/exterior_pdf.js'),{jsPDF}=require('jspdf');
 const wall={id:'W01',material:'Vinyl',normal:{x:0,y:-1,z:0},points:[{x:0,y:0,z:0},{x:5,y:0,z:0},{x:5,y:0,z:3},{x:0,y:0,z:3}],holes:[],gross:161,net:161,openingArea:0,width:16.4,height:9.8,openings:[]};
 const model={walls:[wall],openings:[],returns:[],roof:[],base:[],totals:{gross:161,net:161,openingArea:0,openingPerimeter:0,top:16,bottom:16,transitions:0,terminations:0,inside:0,outside:0,returns:0}};
 const warn=console.warn;console.warn=()=>{};
 try{
  const render=draw=>{const doc=new jsPDF({unit:'mm',format:'letter'}),pages=[];draw(doc,(title)=>{if(pages.length)doc.addPage();pages.push(title);});return pages;};
  assert.deepEqual(render((doc,begin)=>X.drawExteriorSummaryPage(doc,model,{},begin,{})),['Exterior Summary']);
  const full=render((doc,begin)=>X.drawExteriorReportPages(doc,model,{},begin,{}));
  assert.deepEqual(full.slice(0,2),['Exterior Summary','Front Elevation']);assert.ok(full.includes('Exterior Quantities'));
  // A customer PDF draws only the exterior pages the organization chose.
  const none={summary:false,elevations:false,dimensions:false,openings:false,quantities:false,allowances:false};
  assert.deepEqual(render((doc,begin)=>X.drawExteriorReportPages(doc,model,{},begin,{},{...none,summary:true})),['Exterior Summary']);
  assert.deepEqual(render((doc,begin)=>X.drawExteriorReportPages(doc,model,{},begin,{},{...none,quantities:true})),['Exterior Quantities']);
  const picked=render((doc,begin)=>X.drawExteriorReportPages(doc,model,{},begin,{},{...none,elevations:true,openings:true,allowances:true}));
  assert.ok(picked.includes('Front Elevation')&&picked.includes('Opening Schedule')&&picked.includes('Material Allowances'));
  assert.ok(!picked.includes('Exterior Summary')&&!picked.includes('Exterior Quantities')&&!picked.some(t=>/Dimensions/.test(t)));
  assert.deepEqual(render((doc,begin)=>X.drawExteriorReportPages(doc,model,{},begin,{},none)),[]);
 }finally{console.warn=warn;}
});
