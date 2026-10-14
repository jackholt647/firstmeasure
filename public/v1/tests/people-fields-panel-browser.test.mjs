// The People 'fields' slot filled by fields-panel.js: one record and one home, in a real browser with stubbed publication.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

const lib = (...parts) => path.resolve('../libraries', ...parts);

test('the fields slot shows a record\'s values by home and a home\'s definitions, and saves both through publication', async () => {
  let executablePath;
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', chromium.executablePath()]) { try { await access(candidate); executablePath = candidate; break; } catch {} }
  const browser = await chromium.launch({ executablePath, headless:true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="record" style="width:420px"></div><div id="home" style="width:420px"></div><div id="department" style="width:420px"></div>');
    await page.evaluate(() => {
      window.__APP = { userOrgId:'org', userBranchId:'default' };
      window.reads = []; window.invokes = []; window.other = []; window.fail = null; window.dirty = {}; window.savedCalls = 0;
      window.resolved = {
        entity:'user', id:'ada', recordRevision:4,
        homes:[{ kind:'role', id:'driver', name:'Driver', fields:['cdl_number', 'depot'] }],
        unassigned:['shirt_size'],
        fields:[
          { path:'cdl_number', label:'CDL number', type:'text', required:true, writable:true, description:'As printed on the licence', schema:{ type:'string' }, homes:[{ kind:'role', id:'driver', name:'Driver' }] },
          { path:'depot', label:'Depot', type:'department', writable:true, schema:{ type:'object' }, homes:[{ kind:'role', id:'driver', name:'Driver' }] },
          { path:'shirt_size', label:'Shirt size', type:'select', options:['S', 'M'], writable:true, schema:{ type:'string' }, homes:[] }
        ],
        values:{ cdl_number:'D-100', depot:{ department_id:'sales' } }
      };
      window.definitions = { role:{ home:{ kind:'role', id:'driver', name:'Driver', exists:true }, entity:'user', revision:'rev-1', retired:[], fields:[{ entity:'user', home:{ kind:'role', id:'driver' }, path:'cdl_number', label:'CDL number', type:'text', required:true, order:0 }] },
        department:{ home:{ kind:'department', id:'sales', name:'Sales', exists:true }, entity:'department', revision:'dep-1', retired:[], fields:[] } };
      window.PlatformAPI = {
        publication:{
          read:async (_org, source) => {
            window.reads.push(`${source.provider}.${source.export}`);
            if (source.provider === 'custom-fields-homes') return { status:'ready', value:JSON.parse(JSON.stringify(window.definitions[source.args.kind])) };
            return { status:'ready', value:JSON.parse(JSON.stringify(window.resolved)) };
          },
          invoke:async (_org, action, target, input, options) => {
            if (window.fail) { const error = new Error(window.fail.message); error.data = window.fail; throw error; }
            window.invokes.push({ action, target, input, key:options?.idempotencyKey });
            if (action === 'custom-fields.user.write') { Object.assign(window.resolved.values, input.values); window.resolved.recordRevision += 1; return { status:'succeeded', value:{ id:'ada', revision:window.resolved.recordRevision } }; }
            if (action === 'custom-fields.definitions.place') { window.resolved.unassigned = []; window.resolved.homes[0].fields.push(input.path); window.resolved.fields[2].homes = [{ kind:'role', id:'driver', name:'Driver' }]; return { status:'succeeded', value:{ kind:input.kind, id:input.id, revision:'rev-2', count:2 } }; }
            const held = window.definitions[input.kind]; held.fields = input.fields; held.revision += '+';
            return { status:'succeeded', value:{ kind:input.kind, id:input.id, revision:held.revision, count:input.fields.length } };
          }
        },
        connections:{ list:async () => { window.other.push('connections'); return { organization_connections:[{ id:'acme', name:'Acme Subs' }] }; } },
        contacts:{ options:async () => { window.other.push('contacts'); return { contacts:[] }; } },
        media:{ list:async () => { window.other.push('media'); return { media:[] }; } }
      };
    });
    for (const file of [['apps', 'people', 'people-kit.js'], ['apps', 'people', 'slots.js'], ['custom-fields', 'firstmate-custom-fields.js']]) await page.addScriptTag({ path:lib(...file) });
    await page.evaluate(() => {
      const roles = [{ id:'driver', name:'Driver' }, { id:'foreman', name:'Foreman' }];
      window.FirstMatePeople.data = { can:{ settings:true, users:true }, state:{ users:[{ id:'ada', name:'Ada Lovelace', access_role_ids:['driver', 'foreman'] }], groups:[{ id:'g1', name:'Group one', kind_id:'install' }], roles,
        departments:[{ id:'sales', label:'Sales', color:'#2563eb' }, { id:'service', label:'Service', color:'#16a34a' }] },
        user:(id) => window.FirstMatePeople.data.state.users.find((user) => user.id === id), userRoleIds:(user) => user.access_role_ids || [],
        groupTypeName:(id) => ({ install:'Install team' }[id] || ''), companyTypeName:(id) => ({ supplier:'Supplier', roofing:'Roofing', gutters:'Gutters' }[id] || ''), companyTypeIds:() => ['roofing', 'gutters'] };
    });
    assert.equal(await page.evaluate(() => { const box = document.createElement('div'); window.FirstMatePeople.slots.mount(box, 'fields', { entity:{ kind:'organization_user', id:'ada' } }); return !!box.querySelector('[data-people-slot-empty]'); }), true, 'a placeholder until the panel registers');
    await page.addScriptTag({ path:lib('apps', 'people', 'fields-panel.js') });
    const mount = (id, entity, readOnly = false) => page.evaluate(({ id, entity, readOnly }) => {
      const slots = window.FirstMatePeople.slots;
      window[id] = slots.mount(document.querySelector('#' + id), 'fields', { entity:slots.entity(entity.kind, entity.id, entity.name), orgId:'org', branchId:'default', readOnly,
        onDirty:(value) => { window.dirty[id] = value; }, onSaved:() => { window.savedCalls += 1; } });
    }, { id, entity, readOnly });

    // ---- A record.
    await mount('record', { kind:'organization_user', id:'ada', name:'Ada' });
    await page.waitForSelector('#record [data-fm-cfx-group]');
    assert.deepEqual(await page.locator('#record [data-fm-cfx-group]').evaluateAll((nodes) => nodes.map((node) => [node.dataset.fmCfxGroup, node.querySelector('.fm-cfx-group-title span').textContent, [...node.querySelectorAll('[data-custom-field-path]')].map((field) => field.dataset.customFieldPath)])),
      [['role:driver', 'Driver', ['cdl_number', 'depot']], ['unassigned', 'Other', ['shirt_size']]]);
    assert.equal(await page.locator('#record [data-fm-cf-input="depot"] [data-dept-id="sales"]').evaluate((node) => node.style.getPropertyValue('--fm-chip')), '#2563eb', 'departments come from the People store');
    assert.doesNotMatch(await page.locator('#record').innerText(), /As printed on the licence|shows on everyone|crew/i, 'titles only; nothing says crew');
    assert.equal(await page.locator('#record [data-fm-cfx-save]').count(), 0, 'the modal owns Save');
    assert.equal(await page.evaluate(() => window.dirty.record), false);
    await page.locator('#record [data-fm-cf-input="cdl_number"]').fill('');
    assert.equal(await page.evaluate(() => window.dirty.record), true);
    assert.match(await page.evaluate(() => window.record.save().then(() => 'saved', (error) => error.message)), /CDL number is required/);
    assert.equal(await page.locator('#record [data-custom-field-path="cdl_number"] [data-fm-cf-error]').count(), 1);
    await page.locator('#record [data-fm-cf-input="cdl_number"]').fill('D-200');
    // The server refuses: the reason lands on the field it names.
    await page.evaluate(() => { window.fail = { code:'custom_field_pattern', message:'CDL number does not match its declared pattern.', details:{ path:'cdl_number' } }; });
    assert.match(await page.evaluate(() => window.record.save().then(() => 'saved', (error) => error.message)), /declared pattern/);
    assert.equal(await page.locator('#record [data-custom-field-path="cdl_number"] [data-fm-cf-error]').textContent(), 'CDL number does not match its declared pattern.');
    await page.evaluate(() => { window.fail = null; });
    await page.evaluate(() => window.record.save());
    const write = await page.evaluate(() => window.invokes[0]);
    assert.deepEqual({ action:write.action, target:write.target, input:write.input }, { action:'custom-fields.user.write', target:{ scope:'organization', organizationId:'org', id:'ada' }, input:{ values:{ cdl_number:'D-200' }, expectedRevision:4 } });
    assert.ok(write.key);
    await page.waitForFunction(() => window.dirty.record === false);
    assert.equal(await page.locator('#record [data-fm-cf-input="cdl_number"]').inputValue(), 'D-200');
    // A field with no home can be placed on one of this person's roles.
    assert.deepEqual(await page.locator('#record [data-place-home] option').allTextContents(), ['Driver', 'Foreman']);
    assert.deepEqual(await page.locator('#record [data-place-field] option').allTextContents(), ['Shirt size']);
    await page.locator('#record [data-place-home]').selectOption('foreman');
    await page.locator('#record [data-place-go]').click();
    await page.waitForFunction(() => window.savedCalls === 1);
    assert.deepEqual(await page.evaluate(() => window.invokes[1].input), { path:'shirt_size', kind:'role', id:'foreman' });
    assert.equal(await page.locator('#record [data-people-fields-place]').count(), 0, 'nothing left to place');
    // Someone who may not edit sees values, no inputs and no placing.
    await page.evaluate(() => { window.resolved.unassigned = ['shirt_size']; window.resolved.fields[2].homes = []; });
    await mount('department', { kind:'organization_user', id:'ada' }, true);
    await page.waitForSelector('#department [data-fm-cfx-group]');
    assert.deepEqual(await page.evaluate(() => [document.querySelectorAll('#department input,#department select,#department textarea').length, document.querySelectorAll('#department [data-people-fields-place]').length]), [0, 0]);

    // ---- A home: a role.
    await mount('home', { kind:'access_role', id:'driver', name:'Driver' });
    await page.waitForSelector('#home [data-cfd-row]');
    assert.deepEqual(await page.locator('#home [data-cfd-open]').allTextContents(), ['CDL number']);
    assert.equal(await page.locator('#home [data-cfd-save]').count(), 0, 'the modal owns Save');
    await page.locator('#home [data-cfd-add]').click();
    await page.locator('#home [name="label"]').fill('Licence class');
    assert.equal(await page.evaluate(() => window.dirty.home), true);
    // Another role already uses this key for a different kind of value.
    await page.evaluate(() => { window.fail = { code:'custom_field_home_conflict', message:'raw', details:{ path:'licence_class', home:'role:foreman', type:'integer', cardinality:'one' } }; });
    const refused = await page.evaluate(() => window.home.save().then(() => 'saved', (error) => error.message));
    assert.equal(refused, '"licence_class" is already used on the role Foreman with the type integer. Use the same type here, or another key.');
    assert.equal(await page.locator('#home [data-people-fields-note]').textContent(), refused);
    assert.match(await page.locator('#home [data-cfd-path="licence_class"] [data-fm-cf-error]').first().textContent(), /role Foreman/);
    await page.evaluate(() => { window.fail = { code:'custom_field_unassigned_conflict', message:'raw', details:{ path:'licence_class' } }; });
    assert.match(await page.evaluate(() => window.home.save().then(() => 'saved', (error) => error.message)), /already exists as a field with no home/);
    await page.evaluate(() => { window.fail = null; });
    await page.evaluate(() => window.home.save());
    const saved = await page.evaluate(() => window.invokes.at(-1));
    assert.deepEqual({ action:saved.action, target:saved.target, kind:saved.input.kind, id:saved.input.id, revision:saved.input.expectedRevision, paths:saved.input.fields.map((field) => [field.path, field.entity, field.home, field.order]) },
      { action:'custom-fields.definitions.save', target:{ scope:'organization', organizationId:'org' }, kind:'role', id:'driver', revision:'rev-1', paths:[['cdl_number', 'user', { kind:'role', id:'driver' }, 0], ['licence_class', 'user', { kind:'role', id:'driver' }, 1]] });
    await page.waitForFunction(() => window.dirty.home === false);
    assert.deepEqual(await page.locator('#home [data-cfd-open]').allTextContents(), ['CDL number', 'Licence class']);
    const before = await page.evaluate(() => window.invokes.length);
    await page.evaluate(() => window.home.save());
    assert.equal(await page.evaluate(() => window.invokes.length), before, 'nothing changed, nothing sent');

    // ---- A department is a home and nothing else.
    await mount('department', { kind:'department', id:'sales', name:'Sales' });
    await page.waitForSelector('#department [data-people-fields="home"] [data-cfd-empty]');
    assert.equal(await page.locator('#department [data-fm-cfx]').count(), 0);
    assert.equal(await page.evaluate(() => window.reads.at(-1)), 'custom-fields-homes.definitions');
    // An outside company: every type it has is offered when placing a field, by name, whether or not the type holds a field yet.
    await page.evaluate(() => { window.resolved.homes = [{ kind:'company_type', id:'roofing', name:'roofing', fields:['cdl_number', 'depot'] }]; });
    await mount('home', { kind:'organization_connection', id:'acme', name:'Acme Subs' });
    await page.waitForSelector('#home [data-place-home]');
    assert.deepEqual(await page.locator('#home [data-place-home] option').evaluateAll((nodes) => nodes.map((node) => [node.value, node.dataset.kind, node.textContent])), [['roofing', 'company_type', 'Roofing'], ['gutters', 'company_type', 'Gutters']]);
    assert.equal(await page.locator('#home [data-fm-cfx-save], #home [data-cfd-save]').count(), 0, 'the modal owns Save');
    assert.equal(await page.evaluate(() => window.reads.at(-1)), 'custom-fields-company.resolved');
    // A conflict with a group type or a company type names it.
    await page.evaluate(() => { window.definitions.group_type = { home:{ kind:'group_type', id:'install', name:'Install team', exists:true }, entity:'team', revision:'g-1', retired:[], fields:[] }; });
    await mount('home', { kind:'resource_group_kind', id:'install', name:'Install team' });
    await page.waitForSelector('#home [data-cfd-add]');
    await page.locator('#home [data-cfd-add]').click();
    await page.evaluate(() => { window.fail = { code:'custom_field_home_conflict', message:'raw', details:{ path:'new_field', home:'group_type:install', type:'date', cardinality:'one' } }; });
    assert.match(await page.evaluate(() => window.home.save().then(() => 'saved', (error) => error.message)), /on the group type Install team with the type date/);
    await page.evaluate(() => { window.fail = null; });
    // entity.home says so outright for kinds the slot does not name, such as a company type.
    await page.evaluate(() => { window.definitions.company_type = { home:{ kind:'company_type', id:'supplier', name:'Supplier', exists:true }, entity:'company', revision:'c-1', retired:[], fields:[] };
      window.FirstMatePeople.fieldsPanel.mount(document.querySelector('#record'), { entity:{ kind:'company_type', id:'supplier', home:{ kind:'company_type', id:'supplier' } }, orgId:'org' }); });
    await page.waitForSelector('#record [data-people-fields="home"]');
    // Outside companies were read once for the whole page; contacts and media never, since no field needed them.
    assert.deepEqual(await page.evaluate(() => window.other), ['connections']);
    await page.evaluate(() => { window.FirstMatePeople.data.state.connections = [{ id:'acme', name:'Acme Subs' }]; window.other.length = 0; window.FirstMatePeople.fieldsPanel.mount(document.querySelector('#department'), { entity:{ kind:'access_role', id:'driver' }, orgId:'other-org' }); });
    await page.waitForSelector('#department [data-people-fields="home"]');
    assert.deepEqual(await page.evaluate(() => window.other), [], 'companies come from the People store when it has them');
  } finally { await browser.close(); }
});
