import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../../', import.meta.url);

async function source(path){
  return readFile(new URL(path, root), 'utf8');
}

async function loadRuntime(definitions = []){
  const saves = [];
  const window = {
    __APP:{ userOrgId:'org_test', userBranchId:'branch_test' },
    Portal:{
      cfg:{ userOrgId:'org_test' },
      branchModules:{ currentBranchId:() => 'branch_test' }
    },
    PlatformAPI:{
      branchModules:{
        get:async () => ({ data:{ fields:definitions } }),
        save:async (...args) => { saves.push(args); return { ok:true }; }
      }
    },
    CustomEvent:class CustomEvent { constructor(type, init = {}){ this.type = type; this.detail = init.detail; } },
    dispatchEvent(){},
    addEventListener(){},
    setTimeout,
    clearTimeout,
    Intl,
    Date,
    Math,
    console
  };
  window.window = window;
  vm.runInNewContext(await source('libraries/custom-fields/firstmate-custom-fields.js'), window, { filename:'firstmate-custom-fields.js' });
  await window.FirstMateCustomFields.load({ force:true });
  return { api:window.FirstMateCustomFields, saves };
}

test('custom fields normalize visibility, scope gates, and formula values', async () => {
  const { api } = await loadRuntime([
    { id:'hours', key:'labor_hours', label:'Labor hours', entity:'project', type:'number', show_in_scope:true, formula_available:true },
    { id:'rate', key:'hourly_rate', label:'Hourly rate', entity:'project', type:'currency', formula_available:true },
    { id:'total', key:'labor_total', label:'Labor total', entity:'project', type:'formula', formula:'{{labor_hours}} * {{hourly_rate}}', formula_available:true },
    { id:'roof', key:'roof_system', label:'Roof system', entity:'project', type:'select', scope_mode:'selected', scopes:['roof_replacement'] },
    { id:'hidden', key:'automation_score', label:'Automation score', entity:'project', type:'number', background_only:true, formula_available:true },
    { id:'contact', key:'referral_source', label:'Referral source', entity:'contact', type:'text' }
  ]);
  const project = {
    scope:{ pieces:[{ template_id:'roof_replacement' }] },
    custom_field_values:{ labor_hours:4, hourly_rate:75, automation_score:9 }
  };

  assert.equal(api.fieldsFor('project', project, { location:'overview' }).some((field) => field.key === 'roof_system'), true);
  assert.equal(api.fieldsFor('project', project, { location:'overview' }).some((field) => field.key === 'automation_score'), false);
  assert.deepEqual(Array.from(api.scopeTokens(project)).includes('roof_replacement'), true);
  assert.equal(api.scopeEntries(project).some((entry) => entry.key === 'labor_hours'), true);
  assert.deepEqual({ ...api.valuesForFormula(project) }, {
    custom_labor_hours:4,
    custom_hourly_rate:75,
    custom_labor_total:300,
    custom_automation_score:9
  });
});

test('contact values use a dedicated contact payload and definitions persist in the branch module', async () => {
  const { api, saves } = await loadRuntime([]);
  const contact = api.applyValues({ name:'Ada' }, 'contact', { referral_source:'Partner' });
  assert.equal(contact.contact_custom_field_values.referral_source, 'Partner');
  assert.equal(contact.custom_field_values.referral_source, 'Partner');

  await api.saveDefinitions([{ key:'job_code', label:'Job code', entity:'project', type:'text' }]);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][2], 'custom_fields');
  assert.equal(saves[0][3].fields[0].show_in_overview, true);
});

test('rich field definitions preserve real JSON data types and mirror project compatibility values', async () => {
  const { api } = await loadRuntime([]);
  const definitions = [
    api.normalizeDefinition({ key:'approved', label:'Approved', type:'toggle' }),
    api.normalizeDefinition({ key:'trades', label:'Trades', type:'multiselect', options:['Roofing', { label:'Solar work', value:'solar' }] }),
    api.normalizeDefinition({ key:'labels', label:'Labels', type:'tags' }),
    api.normalizeDefinition({ key:'equipment', label:'Equipment', type:'key_value' }),
    api.normalizeDefinition({ key:'payload', label:'Payload', type:'json' })
  ];
  assert.deepEqual(definitions.map((field) => field.data_type), ['boolean', 'array', 'array', 'object', 'json']);
  assert.deepEqual({ ...definitions[1].options[1] }, { label:'Solar work', value:'solar', color:'' });
  assert.equal(definitions[1].layout, 'full');
  assert.equal(definitions[1].formula_available, false);

  const values = {
    approved:true,
    trades:['Roofing', 'solar'],
    labels:['priority', 'repeat customer'],
    equipment:{ manufacturer:'Acme', serial:'A-100' },
    payload:{ nested:{ count:2 }, rows:[1, 2] }
  };
  const project = api.applyValues({ id:'project_rich' }, 'project', values);
  assert.deepEqual({ ...project.custom_field_values }, values);
  assert.deepEqual({ ...project.custom_fields }, values);
  assert.deepEqual({ ...api.rawValues(project) }, values);
  assert.equal(api.formatValue(definitions[1], values.trades), 'Roofing, solar');
  assert.match(api.formatValue(definitions[3], values.equipment), /manufacturer: Acme/);
});

test('project schemas add nested assignment fields without replacing global custom fields', async () => {
  const { api } = await loadRuntime([
    { id:'job', key:'job_code', label:'Job code', entity:'project', type:'text' }
  ]);
  const project = {
    custom_field_schema:{
      version:3,
      groups:[{ path:'assignments', label:'Assignments', collapsed_by_default:true }],
      fields:[{
        path:'assignments.estimator',
        label:'Estimator',
        type:'assignable_subject',
        cardinality:'one',
        sources:[{ kind:'scope', scope_template_id:'sales_pipeline' }],
        ui:{ project_tag:true }
      }]
    },
    custom_field_values:{
      assignments:{
        estimator:{ subject_type:'organization_user', subject_id:'user_1', name:'Ada' }
      }
    }
  };
  const fields = api.fieldsFor('project', project, { location:'all' });
  assert.deepEqual(Array.from(fields, (field) => field.path), ['assignments.estimator', 'job_code']);
  assert.equal(api.projectSchema(project).groups[0].collapsed_by_default, true);
  assert.equal(api.valueAtPath(api.rawValues(project), 'assignments.estimator').subject_id, 'user_1');
  assert.equal(api.formatValue(fields[0], api.valueFor(fields[0], project, fields)), 'Ada');

  const changed = api.applyValues(project, 'project', {
    assignments:{ project_manager:{ subject_type:'organization_user', subject_id:'user_2' } }
  });
  assert.equal(changed.custom_field_values.assignments.estimator.subject_id, 'user_1');
  assert.equal(changed.custom_field_values.assignments.project_manager.subject_id, 'user_2');
});

test('settings use responsive type sections and a structured choice builder', async () => {
  const runtime = await source('libraries/custom-fields/firstmate-custom-fields.js');
  assert.match(runtime, /\.cf-section\[hidden\]\{display:none!important\}/);
  assert.match(runtime, /data-cf-option-list/);
  assert.match(runtime, /data-cf-option-add/);
  assert.match(runtime, /data-cf-option-remove/);
  assert.doesNotMatch(runtime, /name="options"/);
});

test('portal surfaces and pricebook are wired to the shared custom-field runtime', async () => {
  const [portal, settings, overview, projectRequest, projectLeft, contact, scope, pricebook, proposals] = await Promise.all([
    source('portal/index.php'),
    source('libraries/apps/settings/company.js'),
    source('libraries/apps/project-map/app.js'),
    source('libraries/apps/project-request/app.js'),
    source('libraries/apps/firstmeasure/order/app.js'),
    source('libraries/apps/contacts/modal.js'),
    source('libraries/apps/materials/project.js'),
    source('libraries/pricebook/firstmate-pricebook.js'),
    source('libraries/apps/proposals/project.js')
  ]);
  assert.match(portal, /custom-fields\/firstmate-custom-fields\.js/);
  assert.match(settings, /data-configuration-pane="custom_fields"/);
  assert.doesNotMatch(overview, /data-project-custom-fields/);
  assert.match(projectLeft, /rStepAddress[\s\S]*rProjectCustomFields[\s\S]*rStepType/);
  assert.match(projectRequest, /renderProjectCustomFields/);
  assert.match(projectRequest, /custom_field:/);
  assert.match(projectRequest, /close\(\{ skipHistory:true \}\);[\s\S]*modules\?\.contacts\?\.open/);
  assert.match(contact, /fmContactAddress[\s\S]*fmContactCustomFields[\s\S]*fm-contact-meta/);
  assert.match(contact, /flat:true/);
  assert.match(contact, /validateEditor/);
  assert.match(contact, /futureOpen:\s*false/);
  assert.match(contact, /dockDeferredSections:\s*true/);
  assert.match(contact, /scrollItemsOnly:\s*true/);
  assert.match(contact, /\.fm-contact-todos\{[^}]*flex:1 1 180px[^}]*overflow:hidden/);
  assert.match(contact, /\.fm-contact-actions\{[^}]*flex:0 0 auto/);
  assert.match(scope, /scopeEntries/);
  assert.match(pricebook, /type === 'custom_field'/);
  assert.match(proposals, /valuesForFormula/);
});
