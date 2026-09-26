import assert from 'node:assert/strict';
import test from 'node:test';
import {createLanguage} from '../platform/localization/core.js';
import {terminologyContract} from '../platform/localization/terminology.js';
import {terminologyAssistantTools} from '../assistant/agent/terminology.js';
const create=()=>{
 const language=createLanguage({locale:'en-US',measurement_system:'imperial'});
 language.register({version:'test',namespaces:{terminology:{'en-US':Object.fromEntries(Object.entries(terminologyContract).map(([key,item])=>[key,item.label]))},projects:{'en-US':{new:'New Project',many:'My Projects',count:{format:'icu',message:'{count, plural, one {# project} other {# projects}} for {name}'}}},crew:{'en-US':{add:'Add crew member',list:'Crew Members'}},scheduling:{'en-US':{title:'Crew / Subcontractor'}}}});
 return language;
};
test('noun changes compose navigation and ICU literals without rewriting supplied values',()=>{
 const l=create();l.setTerminology({localized_labels:{'en-US':{projects:{project:'Job',projects:'Jobs'}}}});
 assert.equal(l.text('projects','new'),'New Job');assert.equal(l.term('projects.portal_tab','My Projects'),'My Jobs');
 assert.equal(l.text('projects','count','',{count:2,name:'Project North'}),'2 jobs for Project North');
 assert.equal(l.text('projects','missing','Customer-authored Project'),'Customer-authored Project');
});
test('locale changes, resets, legacy aliases and explicit phrase overrides',()=>{
 const l=create();l.setTerminology({labels:{crew:{crew_member:'Technician'}},localized_labels:{'en-US':{projects:{projects:'Jobs',portal_tab:'My work'}},'en-GB':{projects:{projects:'Contracts'}}}});
 assert.equal(l.term('workforce.worker_singular','Crew Member'),'Technician');
 assert.equal(l.text('crew','add'),'Add technician');assert.equal(l.term('projects.portal_tab','My Projects'),'My work');
 l.configure({locale:'en-GB',measurement_system:'imperial'});assert.equal(l.text('projects','many'),'My Contracts');
 l.setTerminology({labels:{projects:{projects:'Jobs'}},localized_labels:{'en-GB':{projects:{projects:''}}}});assert.equal(l.text('projects','many'),'My Projects');
});
test('HTML sinks escape custom literals; plain text and authored ICU values retain their representation',()=>{
 const l=create();l.setTerminology({localized_labels:{'en-US':{projects:{project:'<img src=x onerror=alert(1)>',projects:'R&D Jobs'}}}});
 assert.equal(l.htmlText('projects','new'),'New &lt;img src=x onerror=alert(1)&gt;');assert.equal(l.text('projects','many'),'My R&D Jobs');
 assert.equal(l.htmlText('projects','count','',{count:2,name:'&lt;Customer&gt;'}),'2 r&amp;d jobs for &lt;Customer&gt;');
});
test('workforce labels are shared without leaking across language instances',()=>{
 const a=create(),b=create();a.setTerminology({localized_labels:{'en-US':{workforce:{resource_group_singular:'Team',worker_plural:'Employees',organization_connection_singular:'Partner'}}}});
 assert.equal(a.text('scheduling','title'),'Team / Partner');assert.equal(a.text('crew','list'),'Employees');assert.equal(b.text('crew','list'),'Crew Members');
});
test('focused FirstMate tool requires company settings permission and returns only valid drafts',async()=>{
 const tool=terminologyAssistantTools[0]!;assert.equal(tool.permission,'manage_company_settings');assert.equal(tool.publication?.effect,'read');
 const run:any={input:{locale:'en-US',catalog:[{key:'projects.project'}]},renders:[]};
 const result=await tool.execute(run,{changes:[{key:'projects.project',value:'Job'},{key:'unknown.key',value:'Bad'}],focus_keys:['projects.project','unknown.key']});
 assert.equal(result.saved,false);assert.deepEqual(run.renders[0].changes,[{key:'projects.project',value:'Job'}]);
});

test('issued US document harness installs frozen terminology, independent of later preferences',async()=>{
 const {serverLanguage}=await import('../platform/localization/server.js');const {buildRenderHarnessHtml}=await import('../documents/render.js');
 const engine=await serverLanguage({locale:'en-US',measurement_system:'imperial'},['doc-widgets']);engine.setTerminology({localized_labels:{'en-US':{projects:{project:'Job'}}}});
 const snapshot=engine.snapshot();engine.setTerminology({localized_labels:{'en-US':{projects:{project:'Contract'}}}});
 const html=await buildRenderHarnessHtml({resolved_definition:{pages:[]},theme:{},themeContext:{},widgetData:{},scope:{},language_snapshot:snapshot});
 assert.ok(html.includes('PlatformLanguage.setTerminology('));assert.ok(html.includes('"project":"Job"'));assert.equal(snapshot.terminology.localized_labels?.['en-US']?.projects?.project,'Job');
});

test('shared nouns resolve across every shipped UI namespace and English articles follow worker names',async()=>{
 const {readFile}=await import('node:fs/promises');const catalog=JSON.parse(await readFile(new URL('../platform/localization/catalog-source.json',import.meta.url),'utf8'));
 for(const namespace of Object.keys(catalog).filter(key=>key!=='terminology')){
  const language=create();language.register({version:'cross-app',namespaces:{[namespace]:{'en-US':{probe:'New Project for a crew member'}}}});language.setTerminology({localized_labels:{'en-US':{projects:{project:'Job'},workforce:{worker_singular:'Employee'}}}});
  assert.equal(language.text(namespace,'probe'),'New Job for an employee',namespace);
 }
});

test('known API error text uses terminology while contextual errors remain verbatim',()=>{
 const language=create();language.register({version:'errors',namespaces:{errors:{'en-US':{missing:'Project not found'}}}});language.setTerminology({localized_labels:{'en-US':{projects:{project:'Job'}}}});
 assert.equal(language.error('missing','Project not found'),'Job not found');assert.equal(language.error('missing','Project North is unavailable'),'Project North is unavailable');
});

test('older locale-scoped aliases and saved defaults participate in comprehensive renames',()=>{
 const language=create();language.setTerminology({localized_labels:{'en-US':{crew:{crew_member:'Technician'},projects:{projects:'Jobs',portal_tab:'My Projects'}}}});
 assert.equal(language.term('workforce.worker_singular','Crew Member'),'Technician');assert.equal(language.term('projects.portal_tab','My Projects'),'My Jobs');
});
