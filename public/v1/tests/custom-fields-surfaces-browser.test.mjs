import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

// The field types the server accepts, read from the contracts so that a new type cannot be added there without the
// shared library learning to edit and show it.
async function serverTypes(){
  const list=(source,name)=>[...source.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`))[1].matchAll(/"([a-z_]+)"/g)].map(m=>m[1]);
  const contracts=await readFile(path.resolve('custom_fields/contracts.ts'),'utf8'),contacts=await readFile(path.resolve('contacts/contracts.ts'),'utf8');
  return [...list(contracts,'export const types'),...list(contacts,'CONTACT_REFERENCE_TYPES'),...list(contacts,'MEDIA_REFERENCE_TYPES')];
}
async function launch(){
  let executablePath;
  for(const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium',chromium.executablePath()]){try{await access(p);executablePath=p;break;}catch{}}
  return chromium.launch({executablePath,headless:true});
}
const REFERENCES={
  users:[{id:'ada',name:'Ada Lovelace'},{id:'ben',name:'Ben Okri'}],groups:[{id:'crew_a',name:'Crew A'}],companies:[{id:'acme',name:'Acme Subs'}],
  departments:[{id:'sales',label:'Sales',color:'#2563eb',icon:'fa-handshake'},{id:'service',name:'Service',color:'#16a34a'},{id:'ops',name:'Operations',color:'#9333ea'},{id:'legal',name:'Legal',color:'#dc2626'},{id:'old',name:'Old',color:'#111111',status:'archived'}],
  contacts:[{label:'Grace Hopper',reference:{contact_id:'c1',project_id:'p1'},kind:'human'},{label:'Initech',reference:{contact_id:'c2',project_id:'p1'},kind:'org'}],
  media:[{label:'roof.jpg',reference:{media_id:'m1'},content_type:'image/jpeg'},{label:'walk.mp4',reference:{media_id:'m2'},content_type:'video/mp4'}]
};
async function open(browser,html){
  const page=await browser.newPage();
  await page.setContent(html);
  // Anything the library asks the platform for is counted: the three surfaces must ask for nothing.
  await page.evaluate(refs=>{
    window.__APP={userOrgId:'org',userBranchId:'default'};window.calls=[];window.REFERENCES=refs;
    const counted=name=>new Proxy(function(){},{get:(_t,key)=>key==='then'?undefined:counted(`${name}.${String(key)}`),apply:()=>{window.calls.push(name);return Promise.resolve({});}});
    window.PlatformAPI=counted('PlatformAPI');window.fetch=(...args)=>{window.calls.push(`fetch ${args[0]}`);return Promise.reject(new Error('no network'));};
  },REFERENCES);
  await page.addScriptTag({path:path.resolve('../libraries/custom-fields/firstmate-custom-fields.js')});
  await page.evaluate(async()=>{await new Promise(done=>setTimeout(done,20));window.calls.length=0;});
  return page;
}

test('every field type has an editor, a compact read-only value, an empty state and validation feedback',async()=>{
  const types=await serverTypes();
  assert.ok(types.includes('department') && types.includes('timezone') && types.length>=36,types.join(','));
  const browser=await launch();
  try{
    const page=await open(browser,'<div id="form" style="width:640px"></div><div id="value"></div>');
    const report=await page.evaluate(types=>{
      const cf=window.FirstMateCustomFields,refs=window.REFERENCES;
      const samples={text:'Blue',multiline:'Line one\nLine two',email:'ada@example.test',phone:'+1 (206) 555-0100',platform_phone:{phone_number:'+12065550123',issuance_id:'i1'},url:'https://example.test/docs',number:4.5,integer:7,currency:1250,percentage:12.5,slider:40,date:'2026-10-13',datetime:'2026-10-13T09:30',timezone:'America/Chicago',boolean:true,toggle:false,select:'b',radio:'a',multiselect:['a','b'],tags:['red','green'],list:['one','two'],array:[{name:'Chair'}],object:{count:2},key_value:{model:'X1'},json:{any:[1,2]},formula:42,
        organization_user:{subject_type:'organization_user',subject_id:'ada'},resource_group:{subject_type:'resource_group',subject_id:'crew_a'},organization_connection:{subject_type:'organization_connection',subject_id:'acme'},assignable_subject:{subject_type:'resource_group',subject_id:'crew_a'},department:{department_id:'sales'},
        contact:{contact_id:'c1',project_id:'p1'},human_contact:{contact_id:'c1',project_id:'p1'},org_contact:{contact_id:'c2',project_id:'p1'},media:{media_id:'m1'},photo:{media_id:'m1'},video:{media_id:'m2'}};
      const catalog=new Set(cf.TYPE_CATALOG.map(type=>type.value)),out={};
      for(const type of types){
        const def={path:`f_${type}`,label:`Field ${type}`,type,required:!['formula','platform_phone','boolean','toggle'].includes(type),options:[{value:'a',label:'Alpha',color:'#f59e0b'},{value:'b',label:'Beta'}],formula:'1+1',min:0,max:5000};
        const sample=samples[type];
        // Editor: mounted through the values form with nothing stored, then with the sample.
        const emptyForm=cf.mountValuesForm(document.querySelector('#form'),{groups:[{id:'g',label:'',fields:[def]}],values:{},references:refs});
        const field=document.querySelector(`#form [data-custom-field-path="f_${type}"]`);
        const managed=['formula','platform_phone'].includes(type);
        const control=field.querySelector('[data-fm-cf-input]'),readonly=field.querySelector('[data-fm-cfx-readonly]');
        const checked=emptyForm.validate();
        const feedback=field.querySelector('[data-fm-cf-error]')?.textContent || '';
        cf.mountValuesForm(document.querySelector('#form'),{groups:[{id:'g',label:'',fields:[def]}],values:{[`f_${type}`]:sample},references:refs});
        const filled=cf.mountValuesForm(document.querySelector('#form'),{groups:[{id:'g',label:'',fields:[def]}],values:{[`f_${type}`]:sample},references:refs});
        const roundTrip=filled.getChanges(),stillValid=filled.validate();
        out[type]={catalog:catalog.has(type),sample:sample!==undefined,editor:managed?!!readonly:!!control,emptyValid:checked.valid,feedback,
          roundTrip:Object.keys(roundTrip),filledValid:stillValid.valid,filledErrors:stillValid.errors,
          emptyHtml:cf.renderValue(def,undefined,{references:refs}),html:cf.renderValue(def,sample,{references:refs}),text:cf.renderValueText(def,sample,{references:refs}),emptyText:cf.renderValueText(def,null,{references:refs})};
      }
      return out;
    },types);
    for(const type of types){
      // The server counts an empty dictionary as a value, and a yes/no field always has one.
      const row=report[type],managed=['formula','platform_phone'].includes(type),flag=['boolean','toggle','object','key_value','json'].includes(type);
      assert.equal(row.catalog,true,`${type}: missing from the type catalog`);
      assert.equal(row.sample,true,`${type}: this test has no sample value`);
      assert.equal(row.editor,true,`${type}: no editor`);
      // A required field left empty says so beside the field; managed and yes/no fields have nothing to require.
      if(!managed && !flag){assert.equal(row.emptyValid,false,`${type}: required and empty should be invalid`);assert.match(row.feedback,/is required/,`${type}: no validation feedback`);}
      assert.deepEqual(row.roundTrip,[],`${type}: showing a stored value must not read back as a change`);
      assert.equal(row.filledValid,true,`${type}: a valid stored value was reported invalid: ${JSON.stringify(row.filledErrors)}`);
      assert.match(row.emptyHtml,/fm-cfv-empty/,`${type}: no empty state`);
      assert.equal(row.emptyText,'',`${type}: empty text`);
      assert.match(row.html,new RegExp(`data-fm-cfv-type="${type}"`),`${type}: read-only renderer`);
      assert.doesNotMatch(row.html,/fm-cfv-empty/,`${type}: a value rendered as empty`);
      assert.ok(row.text.length>0,`${type}: no text rendering`);
      assert.doesNotMatch(row.html+row.text,/\[object Object\]|undefined|issuance_id|subject_id|contact_id|media_id|department_id/,`${type}: raw storage leaked into the display: ${row.html}`);
    }
    assert.match(report.organization_user.html,/Ada Lovelace/);assert.match(report.resource_group.html,/fa-people-group/);assert.match(report.organization_connection.text,/Acme Subs/);
    assert.match(report.contact.html,/Grace Hopper/);assert.match(report.video.text,/walk\.mp4/);
    assert.match(report.email.html,/href="mailto:ada@example\.test"/);assert.match(report.phone.html,/href="tel:\+12065550100"/);assert.match(report.platform_phone.html,/href="tel:\+12065550123"/);
    assert.match(report.url.html,/href="https:\/\/example\.test\/docs"[^>]*rel="noopener noreferrer"/);
    assert.match(report.boolean.html,/Yes/);assert.match(report.toggle.html,/No/);
    assert.match(report.select.text,/Beta/);assert.match(report.multiselect.text,/Alpha, Beta/);assert.match(report.radio.html,/--fm-chip:#f59e0b/);
    assert.equal(report.currency.text.includes('1,250'),true);assert.match(report.array.text,/1 item/);assert.match(report.object.text,/1 entry/);

    // The department chip uses the department's color and, when it has one, its icon; long lists collapse.
    const chips=await page.evaluate(()=>{
      const cf=window.FirstMateCustomFields,def={path:'d',label:'Departments',type:'department',cardinality:'many'};
      cf.mountValue(document.querySelector('#value'),def,[{department_id:'sales'},{department_id:'service'},{department_id:'ops'},{department_id:'legal'},{department_id:'gone'}],{references:window.REFERENCES,max:3});
      const nodes=[...document.querySelectorAll('#value .fm-cfv-chip')];
      return nodes.map(node=>({text:node.textContent.trim(),color:node.style.getPropertyValue('--fm-chip'),icon:node.querySelector('i')?.className || '',dot:!!node.querySelector('.fm-cfv-dot'),tip:node.dataset.fmTooltip || '',background:getComputedStyle(node).backgroundColor}));
    });
    assert.deepEqual(chips.map(chip=>chip.text),['Sales','Service','Operations','+2']);
    assert.equal(chips[0].color,'#2563eb');assert.match(chips[0].icon,/fa-handshake/);assert.equal(chips[0].dot,false);
    assert.equal(chips[1].color,'#16a34a');assert.equal(chips[1].dot,true);assert.notEqual(chips[0].background,chips[1].background,'the tint comes from the department color');
    assert.equal(chips[3].tip,'Legal, gone');
    assert.deepEqual(await page.evaluate(()=>window.calls),[],'the surfaces must not fetch');
  }finally{await browser.close();}
});

test('the values form groups fields by where they come from, in a narrow column and a wide one',async()=>{
  const browser=await launch();
  try{
    const page=await open(browser,'<div id="narrow" style="width:300px"></div><div id="wide" style="width:820px"></div>');
    await page.evaluate(()=>{
      const cf=window.FirstMateCustomFields;
      window.resolved={entity:'user',id:'ada',recordRevision:4,
        homes:[{kind:'role',id:'driver',name:'Driver',fields:['cdl_number','license_class','home_department','wage_note']},{kind:'role',id:'foreman',name:'Foreman',fields:['crew_size','cdl_number','helpers']}],
        unassigned:['shirt_size'],
        fields:[
          {path:'cdl_number',label:'CDL number',type:'text',required:true,writable:true,description:'As printed on the licence',schema:{type:'string'},homes:[{kind:'role',id:'driver',name:'Driver'},{kind:'role',id:'foreman',name:'Foreman'}]},
          {path:'license_class',label:'Licence class',type:'select',options:['A','B'],writable:true,schema:{type:'string',enum:['A','B']},homes:[{kind:'role',id:'driver',name:'Driver'}]},
          {path:'home_department',label:'Home department',type:'department',cardinality:'many',writable:true,schema:{type:'array'},homes:[{kind:'role',id:'driver',name:'Driver'}]},
          {path:'wage_note',label:'Wage note',type:'text',private:true,writable:false,schema:{type:'string'},homes:[{kind:'role',id:'driver',name:'Driver'}]},
          {path:'crew_size',label:'Crew size',type:'integer',min:1,max:12,writable:true,schema:{type:'integer',minimum:1,maximum:12},homes:[{kind:'role',id:'foreman',name:'Foreman'}]},
          {path:'helpers',label:'Helpers',type:'organization_user',cardinality:'many',writable:true,schema:{type:'array'},homes:[{kind:'role',id:'foreman',name:'Foreman'}]},
          {path:'shirt_size',label:'Shirt size',type:'radio',options:['S','M','L'],writable:true,schema:{type:'string'},homes:[]},
          {path:'retired_thing',label:'Retired',type:'text',enabled:false,writable:false,homes:[]}
        ],
        values:{cdl_number:'D-100',license_class:'B',wage_note:'top band',home_department:[{department_id:'sales'}],crew_size:4}};
      window.changes=[];window.saves=[];window.failSave=null;
      for(const id of ['narrow','wide']) window[id]=cf.mountValuesForm(document.querySelector('#'+id),{resolved:window.resolved,references:window.REFERENCES,
        onChange:event=>window.changes.push(event.changes),onSave:async(changes,values)=>{if(window.failSave)throw window.failSave;window.saves.push({changes,values});}});
    });
    const layout=id=>page.evaluate(id=>{
      const rootNode=document.querySelector(`#${id} [data-fm-cfx]`);
      return {groups:[...rootNode.querySelectorAll('[data-fm-cfx-group]')].map(group=>({id:group.dataset.fmCfxGroup,title:group.querySelector('.fm-cfx-group-title span')?.textContent || '',fields:[...group.querySelectorAll('[data-custom-field-path]')].map(node=>node.dataset.customFieldPath)})),
        columns:getComputedStyle(rootNode.querySelector('.fm-cfx-grid')).gridTemplateColumns.split(' ').length,overflow:rootNode.scrollWidth>rootNode.clientWidth+1,
        text:rootNode.innerText};
    },id);
    const narrow=await layout('narrow'),wide=await layout('wide');
    assert.deepEqual(narrow.groups,[
      {id:'role:driver',title:'Driver',fields:['cdl_number','license_class','home_department','wage_note']},
      {id:'role:foreman',title:'Foreman',fields:['crew_size','helpers']},
      {id:'unassigned',title:'Other',fields:['shirt_size']}
    ],'a field two roles declare is shown once, under the first; retired fields are not shown');
    assert.equal(narrow.columns,1);assert.equal(wide.columns,2);assert.equal(narrow.overflow,false);assert.equal(wide.overflow,false);
    // Only titles are visible: the description is a tooltip and the accessible name of its icon.
    assert.doesNotMatch(narrow.text,/As printed on the licence/);
    assert.equal(await page.locator('#narrow [data-custom-field-path="cdl_number"] [data-fm-tooltip="As printed on the licence"]').getAttribute('aria-label'),'As printed on the licence');
    assert.equal(await page.locator('#narrow [data-custom-field-path="cdl_number"] [data-fm-tooltip="Also from Foreman"]').count(),1);
    assert.equal(await page.locator('#narrow [data-custom-field-path="cdl_number"] input').getAttribute('aria-label'),'CDL number');
    // A field the reader cannot change is shown as its value, not as a disabled input.
    assert.equal(await page.locator('#narrow [data-custom-field-path="wage_note"] [data-fm-cfx-readonly] .fm-cfv-text').textContent(),'top band');
    assert.equal(await page.locator('#narrow [data-custom-field-path="wage_note"] input').count(),0);
    assert.equal(await page.locator('#narrow [data-custom-field-path="wage_note"] [data-fm-tooltip="Read only"]').count(),1);
    assert.deepEqual(await page.evaluate(()=>window.narrow.getChanges()),{},'nothing edited, nothing to write');

    // Validation feedback sits beside the field and is announced.
    await page.locator('#narrow [data-fm-cf-input="cdl_number"]').fill('');
    await page.locator('#narrow [data-fm-cf-input="crew_size"]').fill('40');
    await page.locator('#narrow [data-fm-cfx-save]').click();
    assert.equal(await page.locator('#narrow [data-custom-field-path="cdl_number"] [data-fm-cf-error]').textContent(),'CDL number is required.');
    assert.equal(await page.locator('#narrow [data-custom-field-path="crew_size"] [data-fm-cf-error]').textContent(),'Crew size must be no more than 12.');
    assert.equal(await page.locator('#narrow [data-fm-cf-input="cdl_number"]').getAttribute('aria-invalid'),'true');
    assert.equal(await page.locator('#narrow [data-fm-cfx-status]').textContent(),'CDL number is required.');
    assert.equal(await page.evaluate(()=>window.saves.length),0);

    // The department picker: chips in the department's color, add and remove.
    const picker=page.locator('#narrow [data-fm-cf-input="home_department"]');
    assert.deepEqual(await picker.locator('[data-dept-id]').evaluateAll(nodes=>nodes.map(node=>[node.dataset.deptId,node.style.getPropertyValue('--fm-chip')])),[['sales','#2563eb']]);
    assert.deepEqual(await picker.locator('[data-dept-add] option').evaluateAll(nodes=>nodes.map(node=>node.value)),['','service','ops','legal'],'chosen and archived departments are not offered');
    await picker.locator('[data-dept-add]').selectOption('service');
    await picker.locator('[data-dept-id="sales"] [data-dept-remove]').click();
    assert.deepEqual(await picker.locator('[data-dept-id]').evaluateAll(nodes=>nodes.map(node=>node.dataset.deptId)),['service']);

    await page.locator('#narrow [data-fm-cf-input="cdl_number"]').fill('D-200');
    await page.locator('#narrow [data-fm-cf-input="crew_size"]').fill('6');
    await page.locator('#narrow [data-fm-cf-input="helpers"]').selectOption(['organization_user:ada','organization_user:ben']);
    await page.locator('#narrow [data-custom-field-path="shirt_size"] label.fm-cf-choice',{hasText:'M'}).click();
    assert.deepEqual(await page.evaluate(()=>window.changes.at(-1)),{cdl_number:'D-200',home_department:[{department_id:'service'}],crew_size:6,helpers:[{subject_type:'organization_user',subject_id:'ada',name:'Ada Lovelace'},{subject_type:'organization_user',subject_id:'ben',name:'Ben Okri'}],shirt_size:'M'});
    // A refused save shows the server's reason on the field it names and keeps what was typed.
    await page.evaluate(()=>{window.failSave=Object.assign(new Error('CDL number is already in use.'),{details:{path:'cdl_number'}});});
    await page.locator('#narrow [data-fm-cfx-save]').click();
    await page.waitForFunction(()=>document.querySelector('#narrow [data-fm-cfx-status]').textContent==='CDL number is already in use.');
    assert.equal(await page.locator('#narrow [data-custom-field-path="cdl_number"] [data-fm-cf-error]').textContent(),'CDL number is already in use.');
    assert.equal(await page.locator('#narrow [data-fm-cf-input="cdl_number"]').inputValue(),'D-200');
    await page.evaluate(()=>{window.failSave=null;});
    await page.locator('#narrow [data-fm-cfx-save]').click();
    await page.waitForFunction(()=>window.saves.length===1);
    const saved=await page.evaluate(()=>window.saves[0]);
    assert.deepEqual(Object.keys(saved.changes).sort(),['cdl_number','crew_size','helpers','home_department','shirt_size']);
    assert.equal(saved.values.wage_note,'top band','values the form does not edit are untouched');
    await page.waitForFunction(()=>document.querySelector('#narrow [data-fm-cfx-status]').textContent==='Saved');
    assert.deepEqual(await page.evaluate(()=>window.narrow.getChanges()),{},'saved values become the baseline');

    // Read-only mode and the empty state.
    const readOnly=await page.evaluate(()=>{
      const cf=window.FirstMateCustomFields,box=document.querySelector('#wide');
      cf.mountValuesForm(box,{resolved:window.resolved,references:window.REFERENCES,readOnly:true,onSave:async()=>{}});
      const result={inputs:box.querySelectorAll('input,select,textarea').length,save:box.querySelectorAll('[data-fm-cfx-save]').length,department:box.querySelector('[data-custom-field-path="home_department"] .fm-cfv-chip')?.textContent.trim(),empty:box.querySelector('[data-custom-field-path="helpers"] .fm-cfv-empty')?.getAttribute('aria-label')};
      cf.mountValuesForm(box,{resolved:{homes:[],unassigned:[],fields:[],values:{}},emptyText:'No fields for this group'});
      return {...result,emptyText:box.innerText.trim()};
    });
    assert.deepEqual(readOnly,{inputs:0,save:0,department:'Sales',empty:'Not set',emptyText:'No fields for this group'});
    assert.deepEqual(await page.evaluate(()=>window.calls),[],'the surfaces must not fetch');
  }finally{await browser.close();}
});

test('the definitions editor adds, edits, reorders and retires the fields of one home',async()=>{
  const browser=await launch();
  try{
    const page=await open(browser,'<div id="narrow" style="width:290px"></div><div id="wide" style="width:820px"></div>');
    await page.evaluate(()=>{
      const cf=window.FirstMateCustomFields;
      window.initial=[
        {entity:'user',home:{kind:'role',id:'driver'},path:'cdl_number',label:'CDL number',type:'text',required:true,order:0,description:'As printed on the licence',assignment_policy:{keep:'me'},value_schema:{type:'string'}},
        {entity:'user',home:{kind:'role',id:'driver'},path:'license_class',label:'Licence class',type:'select',options:['A','B'],default_value:'B',order:1},
        {entity:'user',home:{kind:'role',id:'driver'},path:'line',label:'Truck line',type:'platform_phone',read_only:true,order:2}
      ];
      window.edits=0;window.saves=[];window.failSave=null;
      window.editor=cf.mountDefinitionsEditor(document.querySelector('#narrow'),{title:'Driver',entity:'user',home:{kind:'role',id:'driver',name:'Driver'},fields:window.initial,references:window.REFERENCES,
        onChange:()=>{window.edits++;},onSave:async fields=>{if(window.failSave)throw window.failSave;window.saves.push(fields);}});
      window.wideEditor=cf.mountDefinitionsEditor(document.querySelector('#wide'),{entity:'user',home:{kind:'role',id:'driver'},fields:window.initial,references:window.REFERENCES});
    });
    const titles=()=>page.locator('#narrow [data-cfd-row] [data-cfd-open]').allTextContents();
    assert.deepEqual(await titles(),['CDL number','Licence class','Truck line']);
    assert.equal(await page.evaluate(()=>window.editor.isDirty()),false);
    assert.equal(await page.locator('#narrow .fm-cfd-head strong').textContent(),'Driver');
    // Titles only: the type is an icon with a tooltip, hints are tooltips.
    assert.equal(await page.locator('#narrow [data-cfd-path="cdl_number"] .fm-cfd-type').getAttribute('aria-label'),'Short text');
    assert.equal(await page.locator('#narrow [data-cfd-path="cdl_number"] .fm-cfd-badge[aria-label="Required"]').count(),1);
    assert.doesNotMatch(await page.locator('#narrow').innerText(),/Names, codes|stable name|tooltip beside/);

    // Edit an existing field: its key is fixed, its title and rules are not.
    await page.locator('#narrow [data-cfd-path="cdl_number"] [data-cfd-open]').click();
    assert.equal(await page.locator('#narrow [name="path"]').isDisabled(),true);
    assert.doesNotMatch(await page.locator('#narrow').innerText(),/It cannot change once|Shown as a tooltip/);
    assert.equal(await page.locator('#narrow [data-cfd-field="path"] [data-fm-tooltip]').getAttribute('aria-label'),'The stable name values are stored under. It cannot change once the field is saved.');
    const columns=id=>page.evaluate(id=>getComputedStyle(document.querySelector(`#${id} .fm-cfd-grid`)).gridTemplateColumns.split(' ').length,id);
    assert.equal(await columns('narrow'),1);
    await page.locator('#wide [data-cfd-path="cdl_number"] [data-cfd-open]').click();
    assert.equal(await columns('wide'),2);
    assert.equal(await page.evaluate(()=>['narrow','wide'].every(id=>{const node=document.querySelector(`#${id} [data-fm-cfd]`);return node.scrollWidth<=node.clientWidth+1;})),true,'no horizontal overflow at either width');
    await page.locator('#narrow [name="label"]').fill('CDL no.');
    assert.deepEqual((await titles())[0],'CDL no.');
    await page.locator('#narrow [name="private"]').check();
    await page.locator('#narrow [name="required"]').uncheck();
    await page.locator('#narrow [data-cfd-default] [data-fm-cf-input="default"]').fill('PENDING');

    // Add a field: the key follows the title until it is edited; a choice type needs choices.
    await page.locator('#narrow [data-cfd-add]').click();
    await page.locator('#narrow [name="label"]').fill('Endorsements held');
    assert.equal(await page.locator('#narrow [name="path"]').inputValue(),'endorsements_held');
    assert.equal(await page.locator('#narrow [name="path"]').isDisabled(),false);
    assert.equal(await page.locator('#narrow select[name="type"] option[value="platform_phone"]').count(),0,'managed types cannot be chosen');
    assert.equal(await page.locator('#narrow select[name="type"] option[value="department"]').count(),1);
    await page.locator('#narrow select[name="type"]').selectOption('multiselect');
    assert.equal((await page.evaluate(()=>window.editor.validate())).errors[0].message,'Add at least one choice.');
    assert.equal(await page.locator('#narrow [data-cfd-field="options"] [data-fm-cf-error]').textContent(),'Add at least one choice.');
    for(const choice of ['Hazmat','Tanker']){await page.locator('#narrow [data-cfd-choice-add]').click();await page.locator('#narrow [data-cfd-choice] input').last().fill(choice);}
    await page.locator('#narrow [name="required"]').check();
    // A second new field that is a department reference, several allowed, with a default.
    await page.locator('#narrow [data-cfd-add]').click();
    await page.locator('#narrow [name="label"]').fill('Depots');
    await page.locator('#narrow select[name="type"]').selectOption('department');
    await page.locator('#narrow [name="many"]').check();
    await page.locator('#narrow [data-cfd-default] [data-dept-add]').selectOption('ops');
    assert.equal(await page.locator('#narrow [data-cfd-default] [data-dept-id="ops"]').count(),1);
    // A key that is already taken is refused beside the key.
    await page.locator('#narrow [name="path"]').fill('license_class');
    const clash=await page.evaluate(()=>window.editor.validate());
    assert.deepEqual(clash.errors.map(error=>[error.field,error.message]),[['path','Another field here already uses this key.']]);
    assert.equal(await page.locator('#narrow [data-cfd-field="path"] [data-fm-cf-error]').count(),1);
    await page.locator('#narrow [name="path"]').fill('depots');

    // Reorder with the buttons, then retire a saved field (asked twice) and remove nothing else.
    await page.locator('#narrow [data-cfd-path="depots"] [data-cfd-up]').click();
    await page.locator('#narrow [data-cfd-path="depots"] [data-cfd-up]').click();
    await page.locator('#narrow [data-cfd-path="depots"] [data-cfd-up]').click();
    assert.deepEqual(await titles(),['CDL no.','Depots','Licence class','Truck line','Endorsements held']);
    await page.locator('#narrow [data-cfd-path="license_class"] [data-cfd-retire]').click();
    assert.deepEqual((await titles()).length,5,'retiring asks first');
    await page.locator('#narrow [data-cfd-path="license_class"] [data-cfd-retire-cancel]').click();
    await page.locator('#narrow [data-cfd-path="license_class"] [data-cfd-retire]').click();
    await page.locator('#narrow [data-cfd-path="license_class"] [data-cfd-retire-confirm]').click();
    assert.deepEqual(await titles(),['CDL no.','Depots','Truck line','Endorsements held']);
    assert.equal(await page.locator('#narrow [data-cfd-retired] li').count(),1);
    assert.equal(await page.evaluate(()=>window.editor.isDirty()),true);
    assert.ok(await page.evaluate(()=>window.edits)>5);

    // A refused save says why on the field it names; then the save goes through with the whole ordered list.
    await page.evaluate(()=>{window.failSave=Object.assign(new Error('depots is already a text field in role foreman.'),{details:{path:'depots'}});});
    await page.locator('#narrow [data-cfd-save]').click();
    await page.waitForFunction(()=>document.querySelector('#narrow [data-cfd-path="depots"] [data-fm-cf-error]'));
    assert.match(await page.locator('#narrow [data-cfd-path="depots"] [data-fm-cf-error]').first().textContent(),/already a text field in role foreman/);
    await page.evaluate(()=>{window.failSave=null;});
    await page.locator('#narrow [data-cfd-save]').click();
    await page.waitForFunction(()=>window.saves.length===1);
    const saved=await page.evaluate(()=>window.saves[0]);
    assert.deepEqual(saved.map(field=>[field.path,field.type,field.order]),[['cdl_number','text',0],['depots','department',1],['line','platform_phone',2],['endorsements_held','multiselect',3]]);
    for(const field of saved){assert.deepEqual(field.home,{kind:'role',id:'driver'});assert.equal(field.entity,'user');assert.equal('value_schema' in field,false);}
    assert.deepEqual({label:saved[0].label,required:saved[0].required,private:saved[0].private,default_value:saved[0].default_value,description:saved[0].description,kept:saved[0].assignment_policy},{label:'CDL no.',required:false,private:true,default_value:'PENDING',description:'As printed on the licence',kept:{keep:'me'}});
    assert.deepEqual({cardinality:saved[1].cardinality,default_value:saved[1].default_value},{cardinality:'many',default_value:[{department_id:'ops'}]});
    assert.deepEqual({options:saved[3].options,required:saved[3].required},{options:['Hazmat','Tanker'],required:true});
    assert.equal(saved[2].read_only,true);
    await page.waitForFunction(()=>document.querySelector('#narrow [data-cfd-status]')?.textContent==='Saved');
    assert.equal(await page.evaluate(()=>window.editor.isDirty()),false);
    assert.equal(await page.locator('#narrow [data-cfd-retired]').count(),0);
    // Once saved, the new field's key is fixed too.
    await page.locator('#narrow [data-cfd-path="depots"] [data-cfd-open]').click();
    if(await page.locator('#narrow [data-cfd-path="depots"] [name="path"]').count()===0) await page.locator('#narrow [data-cfd-path="depots"] [data-cfd-open]').click();
    assert.equal(await page.locator('#narrow [data-cfd-path="depots"] [name="path"]').isDisabled(),true);

    // Read-only and empty.
    const fixed=await page.evaluate(()=>{
      const cf=window.FirstMateCustomFields,box=document.querySelector('#wide');
      cf.mountDefinitionsEditor(box,{fields:window.initial,readOnly:true});
      const result={buttons:box.querySelectorAll('[data-cfd-add],[data-cfd-retire],[data-cfd-up],[data-cfd-save],[data-cfd-grip]').length};
      box.querySelector('[data-cfd-open]').click();
      result.enabled=[...box.querySelectorAll('[data-cfd-detail] input,[data-cfd-detail] select')].filter(node=>!node.disabled).length;
      const handle=cf.mountDefinitionsEditor(box,{fields:[]});
      return {...result,empty:box.querySelector('[data-cfd-empty]').textContent,fields:handle.getFields()};
    });
    assert.deepEqual(fixed,{buttons:0,enabled:0,empty:'No fields yet',fields:[]});
    assert.deepEqual(await page.evaluate(()=>window.calls),[],'the surfaces must not fetch');
  }finally{await browser.close();}
});
