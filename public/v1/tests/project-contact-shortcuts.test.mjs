import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
const comms=await readFile(new URL('../../libraries/apps/comms/project.js',import.meta.url),'utf8');
test('contact call prepares the parent phone and side tray without dialing; disabled phones use tel',async()=>{
 const body=source.slice(source.indexOf('  async function prepareProjectContactCall('),source.indexOf('  async function handleProjectContactAction('));
 const calls=[],modes=[];let enabled=true,opened=true;
 const phone={refreshStatus:async()=>({settings:{enabled}}),open:async c=>{calls.push(c);return opened;}};
 const window={parent:{Portal:{appFlags:{has:()=>true},CustomerPhone:phone,PhoneTray:{showDocked:()=>calls.push('dock')}}},location:{href:''}};
 const prepare=new Function('window','projectWindowBridge','projectOpenId','projectModalWindow',body+';return prepareProjectContactCall;')(window,{},()=> 'project-one',{state:{mode:'modal'},setMode:m=>modes.push(m)});
 const contact={id:'contact-two',name:'Jane',phone:'+1 (555) 123-4567'};
 await prepare(contact);assert.deepEqual(calls,[{contact_id:'contact-two',customer_name:'Jane',customer_number:contact.phone,project_id:'project-one'},'dock']);assert.deepEqual(modes,['full']);assert.equal(window.location.href,'');
 enabled=false;await prepare(contact);assert.equal(window.location.href,'tel:+15551234567');assert.equal(calls.length,2);
 enabled=true;opened=false;await prepare(contact);assert.equal(calls.length,3);assert.equal(modes.length,1,'active call guard must not change placement');
});
test('contact email and text shortcuts use the chosen recipient without sending',()=>{
 const body=comms.slice(comms.indexOf('  function openContactDraft('),comms.indexOf('  const api = {'));
 const state={},views=[];
 const open=new Function('state','visibleTabs','beginEmailDraft','beginSmsDraft','clean','setView',body+';return openContactDraft;')(state,()=>[{id:'email'},{id:'sms'}],()=>{state.emailDraft={to:'primary@example.test',cc:'',bcc:''};state.emailComposeOpen=true;},()=>{state.smsDraft={to:'primary-number'};state.smsComposeOpen=true;},s=>String(s).trim(),(v,o)=>views.push([v,o]));
 open('email',' other@example.test ');assert.equal(state.emailDraft.to,'other@example.test');assert.equal(state.emailComposeOpen,true);
 open('sms','+15550001234');assert.equal(state.smsDraft.to,'+15550001234');assert.equal(state.smsComposeOpen,true);
 assert.deepEqual(views,[['email',{pushRoute:true}],['sms',{pushRoute:true}]]);assert.throws(()=>open('call','123'));
});

test('all contact names appear in the title with shared surnames paired',()=>{
 const body=source.slice(source.indexOf('  function formatProjectContactNames('),source.indexOf('  function projectHeaderIdentityHtml('));
 const format=new Function(body+';return formatProjectContactNames;')();
 assert.equal(format(['Bill Jones','Sarah Jones']),'Bill & Sarah Jones');
 assert.equal(format(['Bill Jones','Sarah Jones','Phil Smart']),'Bill & Sarah Jones, Phil Smart');
 assert.equal(format(['Bill Jones','Phil Smart']),'Bill Jones & Phil Smart');
 assert.equal(format([{name:'Bill Jones'},{name:'Phil Smart'},{name:'Sarah Jones'}]),'Bill & Sarah Jones, Phil Smart');
 assert.equal(format(['Cher','Madonna']),'Cher & Madonna');
 assert.equal(format(['Bill Jones','Bill Jones','']),'Bill Jones');
 assert.equal(format([]),'');
});

test('All Contacts is the default and Primary Contact, Address and Manual remain distinct',()=>{
 const extract=name=>{const start=source.indexOf('  function '+name+'(');return source.slice(start,source.indexOf('\n  }',start)+4);};
 const resolve=new Function('branchProjectConfig','projectPrimaryContactAlias','projectText','projectTitleAlias',extract('formatProjectContactNames')+extract('projectDisplayTitle')+';return projectDisplayTitle;')({},p=>p.contacts.find(c=>c.primary)||p.contacts[0],(...v)=>v.find(Boolean)||'',p=>p.title);
 const project={contacts:[{name:'Bill Jones'},{name:'Sarah Jones',primary:true}],address:'123 Main',title:'Kitchen'};
 assert.equal(resolve(project),'Bill & Sarah Jones');
 assert.equal(resolve(project,{title_mode:'customer_name'}),'Sarah Jones');
 assert.equal(resolve(project,{title_mode:'address'}),'123 Main');
 assert.equal(resolve(project,{title_mode:'manual'}),'Kitchen');
});
