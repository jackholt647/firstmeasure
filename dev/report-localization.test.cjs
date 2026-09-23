const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const U=require('../public/libraries/report-units.js');
function sourceFunction(file,name){
 const ts=require('../public/v1/node_modules/typescript'),source=fs.readFileSync(file,'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);let found;
 function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node.getText(tree);else ts.forEachChild(node,visit);}visit(tree);
 assert.ok(found,`${name} exists`);return ts.transpileModule(found,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
}
function context(preferences={}) {
 const c={console,currentProjectManifest:preferences,document:{getElementById:()=>null,addEventListener(){},querySelectorAll:()=>[]},navigator:{userAgent:'test'}};c.window=c;c.globalThis=c;vm.createContext(c);
 vm.runInContext(fs.readFileSync('public/libraries/report-units.js','utf8'),c);return c;
}
test('exact conversions, independent language/units, and unchanged imperial formatting',()=>{
 const us=U.create(),gb=U.create({measurement_system:'metric',report_language:'en-GB'});
 assert.equal(us.length(10,"10.0'"),"10.0'");assert.equal(us.area(100,'100 sq ft'),'100 sq ft');
 assert.equal(gb.value(100,'sf'),9.290304);assert.equal(gb.value(1,'sq'),9.290304);
 assert.equal(gb.quantity(10,'ft'),'3.05 m');assert.equal(gb.quantity(6,'inch'),'152.4 mm');
 assert.equal(gb.quantity(100,'si'),'645.16 cm²');
 assert.equal(gb.text('Color, aluminum, vapor and Miter Counts'),'Colour, aluminium, vapour and Mitre Counts');
 assert.equal(gb.label('Ridge Vent (4 ft sections)'),'Ridge Vent (1.22 m sections)');
 assert.equal(U.create({report_language:'en-GB'}).length(10,"10'"),"10'");
 assert.equal(U.create({measurement_system:'metric'}).text('Color'),'Color');
});
test('keyboard distance entry converts metres and millimetres exactly once; angles stay degrees',()=>{
 for(const metric of [false,true]){
  const c=context({measurement_system:metric?'metric':'imperial'});vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_distance_input.js','utf8'),c);
  for(const [unit,scale,expected]of [[undefined,.3048,metric?2:.6096],['inches',.0254,metric?.002:.0508],['degrees',1,2]]){
   let result;const owner={token:{},unit,unitsPerInput:scale,set:n=>result=n};
   c.ExteriorDistanceInput.key({key:'2',preventDefault(){},stopImmediatePropagation(){}},owner);assert.equal(result,expected);
  }
 }
});
test('roof PDF tables preserve US drawing commands and convert area and waste without changing takeoffs',()=>{
 const c=context();vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/pdf.js','utf8'),c);
 const render=p=>{c.currentProjectManifest=p;const calls=[];const doc=new Proxy({internal:{pageSize:{getWidth:()=>216,getHeight:()=>279}},getTextWidth:s=>String(s).length},{get:(o,k)=>k in o?o[k]:(...a)=>calls.push([k,...a])});c.drawPitchTable(doc,{'4/12':1},20,30,150);return calls;};
 assert.deepEqual(render({}),render({measurement_system:'imperial',report_language:'en-US'}));
 const metric=render({measurement_system:'metric',report_language:'en-GB'});assert.ok(metric.some(c=>c[0]==='text'&&c[1]==='9.29'));assert.ok(metric.some(c=>c[0]==='text'&&c[1]==='m²'));
 assert.equal(c.pdfMaterialAmount(10,'LF','10'),'3.05');assert.equal(c.pdfMaterialAmount(10,'piece','10'),'10');
});
test('exterior PDF converts dimensioned columns without mutating geometry or takeoffs',()=>{
 const R=require('../public/measure/internal/editor_scripts/exterior_report_model.js'),K=require('../public/measure/internal/editor_scripts/exterior_geometry.js');
 const c=context();delete c.document;c.ExteriorGeometry=K;vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/exterior_pdf.js','utf8'),c);
 const model=R.build({faces:[{points:[{x:0,y:0,z:0},{x:4,y:0,z:0},{x:4,y:0,z:4},{x:0,y:0,z:4}]}]}),before=JSON.stringify(model);
 const render=p=>{c.currentProjectManifest=p;const calls=[];const doc=new Proxy({internal:{pageSize:{getWidth:()=>210,getHeight:()=>297}},getTextWidth:s=>String(s).length,splitTextToSize:s=>[s]},{get:(o,k)=>k in o?o[k]:(...a)=>calls.push([k,...a])});c.drawExteriorReportPages(doc,model,{},t=>calls.push(['page',t]),{});return calls;};
 assert.deepEqual(render({}),render({measurement_system:'imperial',report_language:'en-US'}));
 const rows=render({measurement_system:'metric',report_language:'en-GB'}),text=rows.filter(c=>c[0]==='text').map(c=>c[1]).join('\n');
 assert.match(text,/16 m²/);assert.match(text,/4 m/);assert.doesNotMatch(text,/sq ft|ft2|Squares/);assert.equal(JSON.stringify(model),before);
});

test('PDF snapshots retain their units and locale after project defaults change',()=>{
 const c=context();vm.runInContext(fs.readFileSync('public/measure/internal/editor_scripts/pdf_standalone.js','utf8'),c);
 const api=c.FirstMatePDFStandalone,gb={measurement_system:'metric',report_language:'en-GB'};
 const frozen=api.preparePdfSyncSnapshot({},{runtimeContext:{manifest:gb},dateLabel:'21/09/2026'});
 const state=api.hydrateStandaloneContext(frozen,{manifest:{measurement_system:'imperial',report_language:'en-US'}});
 assert.deepEqual(JSON.parse(JSON.stringify(state.reportPreferences)),gb);assert.equal(c.ReportUnits.current().metric,true);
 const old=api.hydrateStandaloneContext({pdfRenderContext:{manifest:{project_type:'residential'}}},{manifest:gb});
 assert.deepEqual(JSON.parse(JSON.stringify(old.reportPreferences)),gb);
 const legacy=api.hydrateStandaloneContext({},{});assert.equal(legacy.reportPreferences.measurement_system,'imperial');
});

test('Company saves preferences only with customization enabled and preserves other branch settings',async()=>{
 const source=sourceFunction('public/libraries/apps/settings/company.js','saveOrg');
 for(const enabled of [false,true]){
  let saved;const c={normalizeOrganizationBusinessAddress:v=>v||{},normalizeLogoDisplay:v=>v||{},normalizeBrandPalette:v=>v||[],currentOrgId:()=> 'org',currentBranchId:()=> 'default',DEFAULT_LOGO:'default',companyLogoForSave:()=> 'logo',window:{PlatformAPI:{appFlags:{has:()=>enabled},orgs:{patch:async()=>{}},branches:{get:async()=>({data:{name:'Branch',contact:{extra:'keep'},report_preferences:{measurement_system:'imperial'}}}),save:async(org,branch,data)=>{saved=data;}}}}};
  vm.createContext(c);vm.runInContext(source,c);
  await c.saveOrg({name:'Company',report_preferences:{measurement_system:'metric',report_language:'en-GB'}});
  assert.equal(saved.report_preferences.measurement_system,enabled?'metric':'imperial');assert.equal(saved.name,'Branch');assert.equal(saved.contact.extra,'keep');
 }
});

test('branch API rejects preference changes while customization is disabled',async()=>{
 const source=sourceFunction('public/v1/platform/api.ts','assertBranchReportPreferences');
 const saved={measurement_system:'metric',report_language:'en-GB'};
 let enabled=false;const c={asObject:v=>v||{},reportPreferencesSchema:{parse:v=>{assert.ok(['metric','imperial'].includes(v.measurement_system));return v;}},isAppFlagEnabled:async()=>enabled,readDocument:async()=>({data:{report_preferences:saved}}),forbidden:()=>new Error('disabled')};
 vm.createContext(c);vm.runInContext(source,c);
 await c.assertBranchReportPreferences('org','default',{data:{report_preferences:saved}});
 await assert.rejects(c.assertBranchReportPreferences('org','default',{report_preferences:{measurement_system:'imperial'}}),/disabled/);
 enabled=true;await c.assertBranchReportPreferences('org','default',{data:{report_preferences:{measurement_system:'imperial'}}});
});


test('project preview formats each report range using its own units',()=>{
 const c={window:{ReportUnits:U}};vm.createContext(c);
 vm.runInContext(sourceFunction('public/libraries/apps/projects/viewer.js','formatRoofingSquareRange'),c);
 assert.equal(c.formatRoofingSquareRange(10,{measurement_system:'imperial'}),'8 to 10 Squares');
 assert.equal(c.formatRoofingSquareRange(10,{measurement_system:'metric',report_language:'en-GB'}),'74.32 to 92.9 m²');
 assert.equal(c.formatRoofingSquareRange(10,{measurement_system:'imperial'}),'8 to 10 Squares');
});
