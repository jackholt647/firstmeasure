// The People 'compensation' slot filled by compensation-panel.js, in a real browser with a stubbed PayrollAPI and the
// clock held at 2026-06-01: one user, one group whose pay is split, and one role default. Run with `--import tsx` so
// what the panel sends can be held against the server's own schemas.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

const lib = (...parts) => path.resolve('../libraries', ...parts);

test('the compensation slot edits a payee\'s own layer and a default, previews before saving, and never shows an unresolved amount', async () => {
  let executablePath;
  for (const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', chromium.executablePath()]) { try { await access(candidate); executablePath = candidate; break; } catch {} }
  const browser = await chromium.launch({ executablePath, headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:900, height:900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<div id="user" style="width:760px"></div><div id="group" style="width:760px"></div><div id="role" style="width:760px"></div>');
    await page.evaluate(() => {
      const RealDate = Date;
      const fixed = new RealDate(2026, 5, 1, 12, 0, 0).getTime();
      window.Date = class extends RealDate { constructor(...values) { if (values.length) super(...values); else super(fixed); } static now() { return fixed; } };
      window.__APP = { userOrgId:'org', userBranchId:'default' };
      window.calls = []; window.dirty = []; window.saved = 0; window.streams = 0;
      window.EventSource = class { constructor(){ window.streams += 1; } };
      const copy = (value) => JSON.parse(JSON.stringify(value));
      const version = (definition) => [{ effective_from:'2026-01-01', definition }];
      const rules = [
        { id:'hourly', name:'Hourly', description:'Approved hours each week.', status:'active', versions:version({ parameters:{ rate_cents:{ label:'Hourly rate', type:'cents' }, overtime_after_hours:{ label:'Hours before overtime', type:'number', default:40 } } }) },
        { id:'commission', name:'Commission', description:'A share of the contract.', status:'active', versions:version({ parameters:{ rate_bps:{ label:'Share', type:'basis_points', default:500 } } }) },
        { id:'bonus', name:'Flat bonus', description:'A fixed amount each month.', status:'active', versions:version({ parameters:{} }) }
      ];
      const plans = [{ id:'sales', name:'Sales plan', description:'What salespeople are paid.', status:'active', versions:[{ effective_from:'2026-01-01', rules:[{ rule_id:'commission' }] }] }];
      const everyone = { source:{ type:'organization', id:'org', name:'Everyone' }, entries:[{ id:'e1', kind:'add', rule_id:'hourly', params:{ rate_cents:2500 }, effective_from:'2026-01-01', entered_by:'owner' }], schedules:[{ id:'c1', earning_kind:'*', schedule_id:'weekly', effective_from:'2026-01-01' }] };
      const salesRole = { source:{ type:'role', id:'sales', name:'Sales' }, entries:[{ id:'e2', kind:'plan', plan_id:'sales', effective_from:'2026-01-01' }] };
      window.db = {
        setups:{
          'organization_user:ada':{ payee:{ type:'organization_user', id:'ada' }, entries:[], revision:3, layers:[everyone, salesRole, { source:null, entries:[] }], distribution_today:null },
          'resource_group:g1':{ payee:{ type:'resource_group', id:'g1' }, entries:[], revision:0, layers:[everyone, { source:null, entries:[] }], distribution_today:{ mode:'as_one' } }
        },
        defaults:{ 'role:sales':{ subject:{ type:'role', id:'sales' }, subject_name:'Sales', revision:2, entries:[{ id:'e2', kind:'plan', plan_id:'sales', effective_from:'2026-01-01', entered_at:'2026-01-02T10:00:00.000Z', entered_by:'owner', entered_by_name:'Olive' }], covers_count:4, covers:[{ type:'organization_user', id:'ada', name:'Ada' }] } }
      };
      const key = (ref) => `${ref.type}:${ref.id}`;
      const stored = (table, id, payload) => { const row = table[id]; Object.assign(row, { entries:copy(payload.entries), schedules:copy(payload.schedules || []), distribution:copy(payload.distribution || []), revision:row.revision + 1 }); return copy(row); };
      window.PayrollAPI = {
        schedules:{ list:async () => ({ schedules:[{ id:'weekly', name:'Weekly', status:'active' }, { id:'monthly', name:'Monthly', status:'active' }] }) },
        pay:{
          rules:async () => copy(rules), plans:async () => copy(plans),
          splitRules:async () => [{ id:'present', name:'Present on the job', description:'Members with an approved shift share equally.', status:'active', versions:version({ parameters:{} }) }],
          unresolved:async () => [{ payee:{ type:'organization_user', id:'ada' }, rule_id:'hourly', unit:'2026-05-25', reason:'Set this payee\'s hourly rate.' }, { payee:{ type:'organization_user', id:'someone_else' }, rule_id:'hourly', reason:'Other' }],
          setup:async (_org, payee) => copy(db.setups[key(payee)]),
          default:async (_org, subject) => copy(db.defaults[key(subject)]),
          previewSetup:async (_org, payload) => { calls.push({ op:'setup.preview', payload:copy(payload) }); return { differences:[{ rule_id:'hourly', unit:'2026-05-25', line:'main', posted_cents:100000, target_cents:120000, delta_cents:20000, handling:'normal' }], unresolved:[{ rule_id:'bonus', reason:'No amount set.' }], total_delta_cents:20000 }; },
          saveSetup:async (_org, payload) => { calls.push({ op:'setup.save', payload:copy(payload) }); return stored(db.setups, key(payload.payee), payload); },
          previewDefault:async (_org, payload) => { calls.push({ op:'default.preview', payload:copy(payload) }); return { payee_count:4, changed_payee_count:1, difference_count:1, change_cents:5000, payees:[{ payee:{ type:'organization_user', id:'ada' }, payee_name:'Ada', change_cents:5000, unresolved:[], differences:[{ rule_id:'commission', unit:'p1', without_change_cents:10000, target_cents:15000, change_cents:5000, handling:'hold' }] }] }; },
          saveDefault:async (_org, payload) => { calls.push({ op:'default.save', payload:copy(payload) }); return stored(db.defaults, key(payload.subject), payload); }
        }
      };
    });
    for (const file of ['people-kit.js', 'slots.js', 'compensation-panel.js']) await page.addScriptTag({ path:lib('apps', 'people', file) });
    const last = (op) => page.evaluate((name) => calls.filter((call) => call.op === name).at(-1)?.payload, op);
    const mountSlot = (host, entity) => page.evaluate(({ host, entity }) => {
      window.handles = window.handles || {};
      window.handles[host] = FirstMatePeople.slots.mount(document.getElementById(host), 'compensation', { entity, orgId:'org', branchId:'default', readOnly:false, onDirty:(value) => dirty.push(`${host}:${value}`), onSaved:() => { saved += 1; } });
    }, { host, entity });

    // ---- A user: what they are paid by, the layer each rule came from, and their own changes on top ----
    await mountSlot('user', { kind:'organization_user', id:'ada', key:'organization_user:ada', name:'Ada' });
    const user = page.locator('#user');
    await user.locator('[data-comp-rule="hourly"]').waitFor();
    assert.match(await user.locator('[data-comp-rule="hourly"]').innerText(), /Hourly\s+Hourly rate: 25\.00 · Hours before overtime: 40\s+Organization/);
    assert.match(await user.locator('[data-comp-rule="commission"]').innerText(), /Commission\s+Share: 5%\s+Role Sales/);
    assert.equal(await user.locator('[data-comp-rule="hourly"]').getAttribute('data-comp-state'), 'inherit');
    const warning = await user.locator('[data-comp-unresolved]').innerText();
    assert.match(warning, /^\s*1 earning could not be worked out\s*Why\s*$/, 'an unresolved earning is a one-line warning with a way to the reason');
    assert.doesNotMatch(warning, /0\.00|\$0/, 'and is never shown as an amount');
    assert.equal(await user.locator('[data-comp-distribution]').count(), 0, 'a person has no members to divide pay among');
    assert.match(await user.locator('[data-comp-schedule="*"]').innerText(), /All earnings[\s\S]*Organization/);
    assert.equal(await user.locator('[data-comp-schedule="*"] option').first().innerText(), 'Inherit (Weekly)');
    assert.equal(await user.locator('[data-comp-date]').inputValue(), '2026-06-01');
    assert.equal(await user.locator('[data-comp-save]').count(), 0, 'the modal owns Save; the panel only previews');
    assert.equal(await user.locator('[data-comp-preview-run]').innerText(), 'Preview changes');
    // Descriptions are tooltips, not copy on the screen.
    assert.equal((await user.innerText()).includes('Approved hours each week'), false);
    assert.equal(await user.locator('[data-comp-rule="hourly"] .pp-comp-name').getAttribute('data-fm-tooltip'), 'Approved hours each week.');

    await user.locator('[data-comp-rule="hourly"] [data-comp-mode="override"]').click();
    assert.equal(await user.locator('[data-comp-rule="hourly"] [data-comp-param="rate_cents"]').inputValue(), '25', 'money is typed in whole units');
    await user.locator('[data-comp-rule="hourly"] [data-comp-param="rate_cents"]').fill('30');
    await user.locator('[data-comp-rule="hourly"] [data-comp-param="rate_cents"]').blur();
    await user.locator('[data-comp-rule="commission"] [data-comp-mode="remove"]').click();
    assert.equal(await user.locator('[data-comp-rule="commission"]').getAttribute('data-comp-state'), 'remove');
    await user.locator('[data-comp-add-rule]').selectOption('bonus');
    assert.equal(await user.locator('[data-comp-rule="bonus"]').getAttribute('data-comp-state'), 'own');
    await user.locator('[data-comp-schedule="*"] [data-comp-schedule-pick]').selectOption('monthly');
    assert.match(await user.locator('[data-comp-rule="hourly"]').innerText(), /Hourly rate: 30\.00/);
    // The modal's Save before a preview: the panel shows the preview and declines with a code the modal treats as a notice.
    assert.deepEqual(await page.evaluate(() => handles.user.save().then(() => ['saved'], (error) => [error.code, error.message])), ['preview_required', 'Check what this changes, then save again']);
    await user.locator('[data-comp-preview]').waitFor();
    const preview = await user.locator('[data-comp-preview]').innerText();
    assert.match(preview, /1 earnings would change\s*\+200\.00[\s\S]*Hourly · 2026-05-25: 1,000\.00 → 1,200\.00\s*\+200\.00[\s\S]*Could not be worked out: No amount set\./);
    const userPayload = { payee:{ type:'organization_user', id:'ada' }, expected_revision:3,
      entries:[{ kind:'override', rule_id:'hourly', params:{ rate_cents:3000, overtime_after_hours:40 }, effective_from:'2026-06-01' }, { kind:'remove', rule_id:'commission', effective_from:'2026-06-01' }, { kind:'add', rule_id:'bonus', effective_from:'2026-06-01' }],
      schedules:[{ effective_from:'2026-06-01', earning_kind:'*', schedule_id:'monthly' }] };
    assert.deepEqual(await last('setup.preview'), userPayload);
    assert.equal(await page.evaluate(() => calls.filter((call) => call.op === 'setup.save').length), 0);
    await page.evaluate(() => handles.user.save());
    await user.locator('[data-comp-status]', { hasText:'Saved' }).waitFor();
    assert.deepEqual(await last('setup.save'), userPayload);
    assert.equal(await user.locator('[data-comp-rule="hourly"]').getAttribute('data-comp-state'), 'override');
    // Going back to inheriting ends the override the day before a later date rather than deleting it.
    await user.locator('[data-comp-date]').fill('2026-07-01');
    await user.locator('[data-comp-rule="hourly"] [data-comp-mode="inherit"]').click();
    await user.locator('[data-comp-preview-run]').click();
    await user.locator('[data-comp-preview]').waitFor();
    assert.deepEqual((await last('setup.preview')).entries[0], { kind:'override', rule_id:'hourly', params:{ rate_cents:3000, overtime_after_hours:40 }, effective_from:'2026-06-01', effective_through:'2026-06-30' });

    // ---- A group: the same editor, and how its pay is divided, because payroll says its pay can be ----
    await mountSlot('group', { kind:'resource_group', id:'g1', key:'resource_group:g1', name:'Install team' });
    const group = page.locator('#group');
    await group.locator('[data-comp-distribution]').waitFor();
    assert.equal(await group.locator('[data-comp-dist]').inputValue(), '');
    await group.locator('[data-comp-dist]').selectOption('rule');
    await group.locator('[data-comp-preview-run]').click();
    assert.equal(await group.locator('[data-comp-status]').innerText(), 'Choose the split rule');
    await group.locator('[data-comp-split-rule]').selectOption('present');
    await group.locator('[data-comp-preview-run]').click();
    await group.locator('[data-comp-preview]').waitFor();
    await page.evaluate(() => handles.group.save());
    await group.locator('[data-comp-status]', { hasText:'Saved' }).waitFor();
    const groupPayload = await last('setup.save');
    assert.deepEqual(groupPayload, { payee:{ type:'resource_group', id:'g1' }, entries:[], schedules:[], expected_revision:0, distribution:[{ effective_from:'2026-06-01', mode:'split', method:'rule', split_rule_id:'present' }] });

    // ---- A role: the default everyone with it starts from, with who it covers, saved through the modal's own Save ----
    await mountSlot('role', { kind:'access_role', id:'sales', key:'access_role:sales', name:'Sales' });
    const role = page.locator('#role');
    await role.locator('[data-comp-rule="commission"]').waitFor();
    assert.equal(await role.locator('[data-comp="default"]').count(), 1);
    assert.equal(await role.locator('[data-comp-covers]').innerText(), '4 covered');
    assert.equal(await role.locator('[data-comp-distribution]').count(), 0, 'only a type of group says how pay is divided');
    assert.match(await role.locator('[data-comp-plans]').innerText(), /Sales plan/);
    await role.locator('[data-comp-rule="commission"] [data-comp-mode="override"]').click();
    assert.equal(await role.locator('[data-comp-param="rate_bps"]').inputValue(), '5', 'a percentage is typed as a percentage');
    await role.locator('[data-comp-param="rate_bps"]').fill('7.5');
    await role.locator('[data-comp-param="rate_bps"]').blur();
    const first = await page.evaluate(() => handles.role.save().then(() => 'saved', (error) => error.message));
    assert.equal(first, 'Check what this changes, then save again', 'the first save only shows the preview');
    assert.match(await role.locator('[data-comp-preview]').innerText(), /Ada · Commission · p1: 100\.00 → 150\.00 \(held for review\)\s*\+50\.00/);
    assert.equal(await page.evaluate(() => calls.filter((call) => call.op === 'default.save').length), 0);
    assert.equal(await page.evaluate(() => handles.role.save().then(() => 'saved', (error) => error.message)), 'saved');
    const rolePayload = await last('default.save');
    assert.deepEqual(rolePayload, { subject:{ type:'role', id:'sales' }, expected_revision:2, schedules:[],
      entries:[{ kind:'plan', plan_id:'sales', effective_from:'2026-01-01' }, { kind:'override', rule_id:'commission', params:{ rate_bps:750 }, effective_from:'2026-06-01' }] });
    assert.deepEqual(await last('default.preview'), rolePayload);

    assert.ok((await page.evaluate(() => dirty)).includes('user:true') && (await page.evaluate(() => dirty)).includes('role:false'));
    assert.equal(await page.evaluate(() => saved), 3);
    assert.equal(await page.evaluate(() => streams), 0, 'the panel opens no stream of its own');
    assert.equal(/crew/i.test(await page.locator('body').innerText()), false);
    const payRules = await import('../payroll/pay-rules.ts').catch(() => null);
    if (payRules) {
      for (const payload of [userPayload, groupPayload]) assert.equal(payRules.paySetupSaveSchema.safeParse(payload).success, true, JSON.stringify(payRules.paySetupSaveSchema.safeParse(payload).error?.issues));
      assert.equal(payRules.payDefaultSaveSchema.safeParse(rolePayload).success, true, JSON.stringify(payRules.payDefaultSaveSchema.safeParse(rolePayload).error?.issues));
    }
    // At phone width a rule row wraps to more lines instead of dropping anything: every control is on screen and nothing is clipped.
    await page.evaluate(() => { for (const id of ['user', 'group', 'role']) document.getElementById(id).style.width = '358px'; });
    for (const host of ['user', 'role']) {
      const clipped = await page.locator(`#${host}`).evaluate((root) => [...root.querySelectorAll('.pp-comp-row,.pp-comp-line,.pp-comp-bar,.pp-comp-foot')].flatMap((row) => {
        const box = row.getBoundingClientRect();
        const outside = [...row.querySelectorAll('button,select,input,.pp-pill,.pp-comp-params,.pp-comp-name')].filter((child) => child.matches('button,select,input') || child.textContent.trim()).filter((child) => { const inner = child.getBoundingClientRect(); return !(inner.width > 0 && inner.left >= box.left - 1 && inner.right <= box.right + 1 && child.scrollWidth <= child.clientWidth + 1); });
        return [...(row.scrollWidth <= row.clientWidth + 1 ? [] : [row.className]), ...outside.map((child) => `${row.className} > ${child.tagName.toLowerCase()}.${child.className} "${child.textContent.trim().slice(0, 30)}"`)];
      }));
      assert.deepEqual(clipped, [], `${host}: every control of every row is inside it at phone width`);
    }
    assert.equal(await user.locator('[data-comp-rule="hourly"] [data-comp-mode="remove"]').isVisible(), true);
    assert.equal(await user.locator('.pp-comp-pick', { hasText:'Another kind of earning' }).evaluate((button) => button.scrollWidth <= button.clientWidth + 1), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
