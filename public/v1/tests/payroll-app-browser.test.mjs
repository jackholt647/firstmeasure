import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// The Payroll app against a stubbed publication layer, for a payroll manager, someone with only the time clock and
// self-service earnings, and a named approver. Each view is drawn at desktop width and at 390px; screenshots go to
// output/payroll-ui/. What each person sees comes from permissions and app flags only.
const libraries = new URL('../../libraries/', import.meta.url);
const shots = new URL('../../../output/payroll-ui/', import.meta.url);
const shotPath = (name) => new URL(`${name}.png`, shots).pathname.replace(/^\/(\w:)/, '$1');
const day = (offset) => { const date = new Date(Date.now() + offset * 86400000); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const at = (offset, hour, minute = 0) => { const date = new Date(`${day(offset)}T00:00:00`); date.setHours(hour, minute, 0, 0); return date.toISOString(); };

function fixtures(){
  const ana = { type:'organization_user', id:'ana', name:'Ana Lopez', worker_type:'employee' };
  const ben = { type:'organization_user', id:'ben', name:'Ben Carter', worker_type:'employee' };
  const carla = { type:'organization_user', id:'carla', name:'Carla Diaz', worker_type:'employee' };
  const dev = { type:'organization_user', id:'dev', name:'Dev Patel', worker_type:'independent_contractor' };
  const summit = { type:'organization_connection', id:'summit', name:'Summit Roofing LLC', worker_type:'subcontractor' };
  const weekly = { id:'weekly', name:'Weekly hourly', currency:'USD', timezone:'America/Chicago', recurrence:{ frequency:'weekly', weekday:5 }, delay:{}, timing_basis:'worked', clawback_cap_percent:25, status:'active', revision:2 };
  const monthly = { id:'monthly', name:'Monthly commissions', currency:'USD', timezone:'America/Chicago', recurrence:{ frequency:'monthly', day:-1 }, delay:{}, timing_basis:'completed', clawback_cap_percent:25, status:'active', revision:1 };
  const preview = (payee, totals, projected = 0) => {
    const gross = Object.entries(totals).filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0);
    const off = Math.abs(totals.off_cycle || 0), claw = Math.abs(totals.clawback || 0);
    return { payee, worker_type:payee.worker_type, accrued:{ payee, gross_cents:gross, deduction_cents:off + claw, off_cycle_cents:off, clawback_cents:claw, net_cents:gross - off - claw, subgroup_totals:totals, entry_count:3 }, projected:{ gross_cents:projected, deduction_cents:0, net_cents:projected, subgroup_totals:projected ? { piece_rate:projected } : {}, entry_count:projected ? 1 : 0 }, forecast_net_cents:gross - off - claw + projected };
  };
  const item = (id, payee, totals, entries, status = 'draft') => {
    const gross = Object.entries(totals).filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0);
    const deduction = Object.entries(totals).filter(([, v]) => v < 0).reduce((s, [, v]) => s - v, 0);
    return { id, batch_id:'', payee, status, gross_cents:gross, commission_cents:totals.commission || 0, deduction_cents:deduction, net_cents:gross - deduction, subgroup_totals:totals, payment_reference:status === 'paid' ? 'GUSTO-4471' : '', entries, revision:1, run_at:'', paid_at:status === 'paid' ? at(-6, 9) : '' };
  };
  const entry = (id, kind, cents, extra = {}) => ({ id, kind, subgroup:kind, state:'accrued', amount_cents:cents, allocation_cents:cents, applied_cents:cents, remaining_cents:0, currency:'USD', description:'', metadata:{}, ...extra });
  const nextFriday = (() => { for (let i = 1; i <= 7; i++) { const d = new Date(`${day(i)}T12:00:00`); if (d.getDay() === 5) return i; } return 1; })();
  const monthEnd = (() => { const d = new Date(); const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); return Math.round((end - new Date(`${day(0)}T00:00:00`)) / 86400000); })();
  const monthlyBatch = { id:'run_monthly', schedule_id:'monthly', pay_date:day(monthEnd), period_start:day(monthEnd - 29), period_end:day(monthEnd), status:'draft', currency:'USD', run_type:'regular', approval:{ status:'pending', requested_approvers:[{ user_id:'owner', name:'Olive Owner' }, { user_id:'maria', name:'Maria Chen' }], decisions:[{ user_id:'maria', name:'Maria Chen', decision:'approved', decided_at:at(-1, 15), note:'' }], submitted_by:{ user_id:'owner', name:'Olive Owner' }, submitted_at:at(-1, 11) }, metadata:{}, revision:3,
    items:[item('i_carla', carla, { commission:380000, clawback:-25000 }, [entry('e1', 'commission', 380000, { description:'Estimator commission: 14 Maple St', project_title:'14 Maple St' }), entry('e2', 'clawback', -25000, { subgroup:'clawback', description:'Canceled: 9 Elm Ave' })])],
    total_cents:355000, employee_total_cents:355000, subcontractor_total_cents:0, created_at:at(-1, 10), updated_at:at(-1, 15), run_at:'', paid_at:'' };
  const paidRun = (id, offset, total) => ({ id, schedule_id:'weekly', pay_date:day(offset), period_start:day(offset - 13), period_end:day(offset - 7), status:'paid', currency:'USD', run_type:'regular', approval:{ status:'finalized', requested_approvers:[{ user_id:'owner', name:'Olive Owner' }], decisions:[{ user_id:'owner', name:'Olive Owner', decision:'approved', decided_at:at(offset - 1, 9) }], finalized_by:{ name:'Olive Owner' }, finalized_at:at(offset - 1, 9) }, metadata:{}, revision:6,
    items:[item(`${id}_ana`, ana, { hourly:118000, reimbursement:6200 }, [entry(`${id}a`, 'hourly', 118000, { description:'Hours, week of the 1st' }), entry(`${id}r`, 'reimbursement', 6200, { description:'Expense reimbursement: shingles run' })], 'paid'), item(`${id}_ben`, ben, { hourly:96500 }, [entry(`${id}b`, 'hourly', 96500)], 'paid'), item(`${id}_summit`, summit, { piece_rate:total - 220700 }, [entry(`${id}s`, 'piece_rate', total - 220700, { description:'Committed labor: 22 Oak Rd' })], 'paid')],
    total_cents:total, employee_total_cents:220700, subcontractor_total_cents:total - 220700, created_at:at(offset - 2, 9), updated_at:at(offset, 9), run_at:at(offset - 1, 10), paid_at:at(offset, 9) });
  const history = [paidRun('run_w1', nextFriday - 7, 868700), paidRun('run_w2', nextFriday - 14, 912300), monthlyBatch];
  const dashboard = {
    from:day(0), through:day(62), schedules:[weekly, monthly], diagnostics:[],
    upcoming:[
      { schedule:weekly, pay_date:day(nextFriday), period_start:day(nextFriday - 12), period_end:day(nextFriday - 6), cutoff_at:at(nextFriday - 6, 23, 59), batch:null,
        employees:[preview(ana, { hourly:120000, reimbursement:4500, off_cycle:-20000 }, 0), preview(ben, { hourly:96000, adjustment:15000 })],
        subcontractors:[preview(summit, { piece_rate:640000, reimbursement:12000 }, 180000), preview(dev, { piece_rate:85000 })],
        accrued_total_cents:100500 + 111000 + 652000 + 85000, projected_additional_cents:180000, forecast_total_cents:948500 + 180000 },
      { schedule:weekly, pay_date:day(nextFriday + 7), period_start:day(nextFriday - 5), period_end:day(nextFriday + 1), cutoff_at:at(nextFriday + 1, 23, 59), batch:null, employees:[], subcontractors:[], accrued_total_cents:0, projected_additional_cents:0, forecast_total_cents:0 },
      { schedule:monthly, pay_date:day(monthEnd), period_start:day(monthEnd - 29), period_end:day(monthEnd), cutoff_at:at(monthEnd, 23, 59), batch:monthlyBatch, employees:[preview(carla, { commission:380000, clawback:-25000 })], subcontractors:[], accrued_total_cents:355000, projected_additional_cents:0, forecast_total_cents:355000 }
    ],
    history:history.slice(0, 1), branch_scope:{ multiple:true }
  };
  const correction = { id:'held_1', payee:carla, kind:'commission', subgroup:'commission', state:'projected', amount_cents:-12000, remaining_cents:-12000, currency:'USD', description:'Estimator commission: 14 Maple St', eligible_at:at(-20, 12), metadata:{ source:'pay_rule', review_required:true, pay_rule:{ rule_id:'estimator_commission_sold' }, correction:{ posted_cents:190000, target_cents:178000 } } };
  const backPay = { id:'back_1', payee:ben, kind:'hourly', subgroup:'hourly', state:'accrued', amount_cents:8400, remaining_cents:8400, currency:'USD', description:'Hours corrected after the run', eligible_at:at(-12, 12), metadata:{ source:'pay_rule', off_cycle_requested:true, back_pay:true, pay_rule:{ rule_id:'hourly_time_clock' } } };
  const offCycle = [
    { id:'oc_1', payment_id:'p1', payee:ana, kind:'hourly', schedule_id:'weekly', currency:'USD', amount_cents:20000, subtracted_cents:0, waiting_cents:20000, status:'waiting', paid_on:day(-3), reference:'Check 1042', note:'Advance for the truck repair week', recorded_by_name:'Olive Owner', recorded_at:at(-3, 14), runs:[] },
    { id:'oc_2', payment_id:'p2', payee:summit, kind:'piece_rate', schedule_id:'weekly', currency:'USD', amount_cents:150000, subtracted_cents:150000, waiting_cents:0, status:'subtracted', paid_on:day(-16), reference:'ACH 88213', note:'', recorded_by_name:'Olive Owner', recorded_at:at(-16, 10), runs:[{ batch_id:'run_w2', pay_date:day(nextFriday - 14), status:'paid', applied_cents:150000 }] }
  ];
  const finalized = [
    { id:'lf_c1', commitment_id:'c1', list_id:'l1', list_title:'Tear-off and install', project_id:'p1', project_title:'22 Oak Rd', assignee:{ type:'organization_connection', id:'summit', name:'Summit Roofing LLC' }, total_cents:640000, finalized_at:at(-2, 16), pay_state:'waiting', earnings:[{ id:'x', payee:summit, kind:'piece_rate', state:'accrued', amount_cents:640000, applied_cents:0, remaining_cents:640000 }], earned_cents:640000, in_pay_run_cents:0 },
    { id:'lf_c2', commitment_id:'c2', list_id:'l2', list_title:'Gutter replacement', project_id:'p2', project_title:'5 Birch Ln', assignee:{ type:'organization_user', id:'dev', name:'Dev Patel' }, total_cents:85000, finalized_at:at(-1, 13), pay_state:'not_earned', earnings:[], earned_cents:0, in_pay_run_cents:0 },
    { id:'lf_c3', commitment_id:'c3', list_id:'l3', list_title:'Repair', project_id:'p3', project_title:'1 Pine Ct', assignee:summit, total_cents:40000, finalized_at:at(-20, 13), pay_state:'in_pay_run', earnings:[], earned_cents:40000, in_pay_run_cents:40000 }
  ];
  const shift = (id, user, offset, inH, outH, status, extra = {}) => ({ id, user_id:user.id, user:{ id:user.id, name:user.name }, project_id:'p1', project:{ id:'p1', title:extra.project || '22 Oak Rd' }, status:outH === null ? 'active' : 'closed', approval_status:status, clocked_in_at:at(offset, inH), clocked_out_at:outH === null ? '' : at(offset, outH), break_seconds:1800, worked_seconds:outH === null ? 0 : (outH - inH) * 3600 - 1800, revision:2, clock_in_location:{ status:'captured', distance_to_project_meters:extra.distance ?? 40 }, ...extra });
  const timesheets = [shift('s1', ana, -1, 7, 16, 'pending'), shift('s2', ben, -1, 7, 15, 'pending', { distance:1250, project:'5 Birch Ln' }), shift('s3', ana, -2, 7, 17, 'approved'), shift('s4', ben, -2, 8, 16, 'rejected', { manager_note:'Clocked in from home' }), shift('s5', ana, 0, 7, null, 'active'), shift('s6', ben, -3, 7, 15, 'approved', { corrected:true })];
  const myEarnings = { subject:ana, currency:'USD', totals:{ projected_cents:0, accrued_cents:104500, in_payroll_cents:0, owed_cents:104500, paid_cents:1650400, earned_cents:1754900 },
    projects:[{ project_id:'p1', title:'22 Oak Rd', currency:'USD', totals:{ owed_cents:62000 } }, { project_id:'p2', title:'5 Birch Ln', currency:'USD', totals:{ owed_cents:42500 } }],
    payments:history.slice(0, 2).map((run) => ({ id:run.id, batch_id:run.id, status:'paid', pay_date:run.pay_date, currency:'USD', net_cents:124200, schedule:{ id:'weekly', name:'Weekly hourly' }, allocations:[] })),
    off_cycle_payments:[{ id:'oc_1', kind:'hourly', amount_cents:20000, currency:'USD', paid_on:day(-3), reference:'Check 1042', waiting_cents:20000 }], entries:[], count:1 };
  const projectedMine = { payee:ana, total_cents:96000, earnings:[{ id:'pe1', project_title:'31 Cedar Way', description:'Committed labor', amount_cents:56000, expected_on:day(6) }, { id:'pe2', project_title:'8 Spruce St', description:'Committed labor', amount_cents:40000, expected_on:'' }], unresolved:[] };
  const approvals = { count:1, approvals:[{ ...monthlyBatch, schedule_name:'Monthly commissions', my_decision:'', items:monthlyBatch.items.map((row) => ({ payee:row.payee, gross_cents:row.gross_cents, deduction_cents:row.deduction_cents, net_cents:row.net_cents, subgroup_totals:row.subgroup_totals })) }] };
  const rules = [{ id:'hourly_time_clock', name:'Hourly from the time clock', versions:[] }, { id:'estimator_commission_sold', name:'Estimator commission when sold', versions:[] }, { id:'committed_labor', name:'Committed labor lists', versions:[] }];
  const catalog = [
    { type:'pay_run_summary', label:'Pay run summary', description:'Everyone in this pay run, employees then contractors, with earnings by kind, reimbursements, what was taken off and the amount to pay.', purpose:'Check a pay run before entering it.', scope:'payroll_run', scope_label:'Payroll run', formats:['csv', 'pdf'], group:'pay_run_file' },
    { type:'gusto_employees', label:'Gusto: employees', description:'One row per employee with earnings by kind in dollars.', purpose:'Import into Gusto.', scope:'payroll_run', scope_label:'Payroll run', formats:['csv'], group:'pay_run_file' },
    { type:'gusto_contractors', label:'Gusto: contractors', description:'One row per contractor or subcontractor company.', purpose:'Contractor payments in Gusto.', scope:'payroll_run', scope_label:'Payroll run', formats:['csv'], group:'pay_run_file' },
    { type:'quickbooks_payroll', label:'QuickBooks Payroll: employees', description:'One row per employee and pay item.', purpose:'QuickBooks Payroll.', scope:'payroll_run', scope_label:'Payroll run', formats:['csv'], group:'pay_run_file' },
    { type:'quickbooks_bills', label:'QuickBooks: contractor bills', description:'Contractors as bills to vendors.', purpose:'QuickBooks bills.', scope:'payroll_run', scope_label:'Payroll run', formats:['csv'], group:'pay_run_file' },
    { type:'earnings_ledger', label:'All earnings', description:'A detailed list of employee and contractor earnings recorded during the selected dates.', purpose:'Audit compensation.', scope:'date_range', scope_label:'Date range', formats:['csv', 'pdf'] },
    { type:'commissions', label:'Commission report', description:'Commission earnings, projects, payment status and remaining balances.', purpose:'Review commissions.', scope:'date_range', scope_label:'Date range', formats:['csv', 'pdf'] },
    { type:'timesheets', label:'Timesheet report', description:'Clock-in, clock-out, worked time, projects and approval status.', purpose:'Review field hours.', scope:'date_range', scope_label:'Date range', formats:['csv', 'pdf'] },
    { type:'reimbursements', label:'Reimbursement report', description:'Requested, approved and paid reimbursements.', purpose:'Reconcile receipts.', scope:'date_range', scope_label:'Date range', formats:['csv', 'pdf'] }
  ];
  const vocabulary = { operators:[], parameter_types:['number', 'boolean', 'text', 'cents', 'basis_points'], earning_kinds:['hourly', 'salary', 'piece_rate', 'commission', 'reimbursement', 'adjustment'], schedule_earning_kinds:['*', 'hourly', 'salary', 'piece_rate', 'commission', 'reimbursement', 'adjustment', 'clawback'], periods:['day', 'week', 'month', 'quarter', 'year'],
    labels:{ earning_kinds:{ '*':'All earnings', hourly:'Hourly', salary:'Salary', piece_rate:'Piece rate', commission:'Commission', reimbursement:'Reimbursement', adjustment:'Adjustment', clawback:'Clawback' }, parameter_types:{ number:'Number', cents:'Money', basis_points:'Percentage', boolean:'Yes or no', text:'Text' }, periods:{ day:'Day', week:'Week', month:'Month', quarter:'Quarter', year:'Year' } } };
  const setup = { effective:[{ rule_id:'hourly_time_clock', params:{ rate_cents:3200, overtime_after_hours:40 }, origin:{ type:'role', id:'installer', name:'Installer' } }], schedule_today:[{ earning_kind:'*', schedule_name:'Weekly hourly', origin:{ type:'organization', id:'org', name:'Everyone' } }], layers:[] };
  const units = [{ id:'u1', rule_id:'hourly_time_clock', unit:day(-6), status:'ok', earned_at:at(-6, 23), lines:[{ key:'main', amount_cents:120000, description:'37.5 hours' }] }, { id:'u2', rule_id:'hourly_time_clock', unit:day(-13), status:'error', earned_at:at(-13, 23), lines:[], error:'rate_cents is not set for this payee.' }];
  const unresolved = [{ id:'u', payee:{ type:'organization_user', id:'ben' }, payee_name:'Ben Carter', rule_id:'hourly_time_clock', unit:day(-13), whole_rule:false, earned_at:at(-13, 23), reason:'rate_cents is not set for this payee.' }];
  const reimbursements = [{ id:'r1', payee:ana, kind:'reimbursement', state:'accrued', amount_cents:4500, remaining_cents:4500, currency:'USD', schedule_id:'weekly', description:'Expense reimbursement: dump fee', project_title:'22 Oak Rd', metadata:{} }, { id:'r2', payee:ben, kind:'reimbursement', state:'accrued', amount_cents:2300, remaining_cents:2300, currency:'USD', schedule_id:'', description:'Expense reimbursement: nails', project_title:'', metadata:{} }];
  const directory = { users:[{ id:'owner', name:'Olive Owner' }, { id:'maria', name:'Maria Chen' }, { id:'ana', name:'Ana Lopez' }, { id:'ben', name:'Ben Carter' }, { id:'carla', name:'Carla Diaz' }, { id:'dev', name:'Dev Patel' }], connections:[{ id:'summit', name:'Summit Roofing LLC' }], resource_groups:[], roles:[] };
  const structure = { feature_enabled:true, multiple:true, my_branch_id:'default', my_region_ids:[], branches:[{ id:'default', name:'', status:'active' }, { id:'north', name:'North yard', status:'active' }], regions:[], access:{ see:'all', restricted:false, visible_branch_ids:['default', 'north'] } };
  const projectedAll = { payees:[{ id:'organization_connection:summit', payee:summit, payee_name:'Summit Roofing LLC', total_cents:1240000, count:3, unresolved_count:0, next_expected_on:day(4) }, { id:'organization_user:dev', payee:dev, payee_name:'Dev Patel', total_cents:0, count:0, unresolved_count:1, next_expected_on:'' }, { id:'organization_user:ana', payee:ana, payee_name:'Ana Lopez', total_cents:96000, count:2, unresolved_count:0, next_expected_on:day(6) }], total_cents:1336000, truncated:false };
  return { dashboard, history, review:{ held:[correction], off_cycle:[backPay] }, unresolved, offCycle, finalized, timesheets, myEarnings, projectedMine, approvals, rules, catalog, vocabulary, setup, units, reimbursements, directory, structure, projectedAll, schedules:[weekly, monthly] };
}

const people = {
  manager:{ userId:'owner', permissions:{ manage_payroll:true, manage_company_settings:true, 'crew.time_clock.use':true, 'payroll.view_own_projected_earnings':true } },
  crew:{ userId:'ana', permissions:{ 'crew.time_clock.use':true, 'payroll.view_own_projected_earnings':true } },
  approver:{ userId:'owner', permissions:{} }
};

async function openApp(browser, who, viewport, adjust = ''){
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { errors.push(`dialog: ${dialog.message()}`); dialog.dismiss(); });
  await page.route('https://payroll.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/libraries/')) return route.fulfill({ contentType:'application/javascript; charset=utf-8', body:await readFile(new URL(path.replace('/libraries/', ''), libraries)) });
    if (path.startsWith('/v1/')) return route.fulfill({ contentType:'text/csv', body:'ok' });
    return route.fulfill({ contentType:'text/html', body:'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px Inter,Arial,sans-serif;--bg:#f2f4f7}main{height:100vh}</style><main></main>' });
  });
  await page.goto('https://payroll.test/');
  // Icons as the portal loads them; the views work without them when there is no network.
  await Promise.race([page.addStyleTag({ url:'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css' }).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))]);
  await page.evaluate(({ who, data, adjust }) => {
    window.data = data;
    window.calls = [];
    window.prompt = () => { throw new Error('window.prompt is not used'); };
    window.__APP = { userOrgId:'org', userId:who.userId };
    const route = { tab:'payroll' };
    const handlers = [];
    const hasPerm = (key) => who.permissions[key] === true;
    window.Portal = {
      currentUser:{ id:who.userId, permissions:who.permissions }, util:{ hasPerm }, ui:{ showToast:(...values) => { (window.toasts = window.toasts || []).push(values); } },
      capabilities:{ current:() => ({ definitions_by_key:{}, effective_by_key:{ 'apps.payroll':true, 'payroll.pay_runs':true, 'payroll.self_service_earnings':true, 'crew.time_clock':true } }) },
      navigation:{ read:() => route, registerHandler:(id, handler) => { handlers.push(handler); return () => {}; }, navigate:(patch) => { Object.assign(route, patch); handlers.forEach((handler) => handler.apply(route)); }, push:(patch) => Object.assign(route, patch), replace:(patch) => Object.assign(route, patch) }
    };
    const value = (v) => JSON.parse(JSON.stringify(v));
    const reads = {
      pay_review:() => data.review, pay_unresolved:() => data.unresolved, off_cycle_payments:() => data.offCycle, finalized_work:() => data.finalized,
      my_approvals:() => (who.userId === 'owner' ? data.approvals : { count:0, approvals:[] }), directory:() => data.directory, pay_rules:() => data.rules, pay_rule_vocabulary:() => data.vocabulary, pay_setup:() => data.setup, pay_units:() => data.units,
      projected_earnings:(ref) => ref.target.id ? data.projectedMine : data.projectedAll,
      configuration:() => ({ schedules:data.schedules, schedule_choices:[], settings:{ approval_required:data.approvalRequired !== false, revision:1 } }), pay_plans:() => [], pay_rule_sources:() => [], pay_default:() => ({ subject:{ type:'organization', id:'org' }, entries:[], schedules:[{ id:'c1', earning_kind:'*', schedule_id:'weekly', effective_from:'2026-01-01' }], revision:2 })
    };
    const denied = { manager:[], crew:['dashboard', 'pay_review', 'directory'], approver:['dashboard'] };
    window.PlatformAPI = { publication:{
      read:async (org, ref) => {
        if (ref.provider === 'organization-branches') return { status:'ready', value:data.structure };
        const read = reads[ref.export];
        return read ? { status:'ready', value:value(read(ref)) } : { status:'ready', value:{} };
      },
      invoke:async (org, action, target, input) => {
        window.calls.push({ action, target, input });
        const ok = (v) => ({ receipt:{ status:'succeeded' }, value:value(v) });
        const needsManager = ['payroll.dashboard.read', 'payroll.timesheets.list', 'payroll.batches.list', 'payroll.ledger.list'];
        if (needsManager.includes(action) && !who.permissions.manage_payroll) throw Object.assign(new Error('Payroll management access is required.'), { status:403 });
        switch (action) {
          case 'payroll.dashboard.read': return ok(data.dashboard);
          case 'payroll.batches.list': return ok(data.history);
          case 'payroll.batch.read': return ok(data.history.find((run) => run.id === target.id));
          case 'payroll.timesheets.list': return ok({ timesheets:data.timesheets, count:data.timesheets.length });
          case 'payroll.timesheets.me': return ok({ timesheets:data.timesheets.filter((row) => row.user_id === who.userId), count:3 });
          case 'payroll.earnings.me': return ok({ earnings:[data.myEarnings], count:1 });
          case 'payroll.earnings.read': return ok({ earnings:[data.myEarnings], count:1 });
          case 'payroll.projectedEarnings.me': return ok(data.projectedMine);
          case 'payroll.ledger.list': return ok(input.kind === 'reimbursement' ? data.reimbursements : data.reimbursements.concat(data.review.held));
          case 'payroll.exports.catalog': return ok(data.catalog);
          case 'payroll.artifacts.list': return ok([{ id:'art1', report_type:'gusto_employees', created_at:new Date().toISOString(), metadata:{ report_label:'Gusto: employees', coverage_label:'Weekly hourly - pay date', format:'csv' } }]);
          case 'payroll.artifact.generate': return ok({ id:'art2', download_url:'/v1/payroll/organizations/org/artifacts/art2/download', metadata:{ format:input.format } });
          case 'payroll.schedules.list': return ok(data.schedules);
          case 'payroll.batch.create': return ok({ batch:{ ...data.history[2], id:'run_new' }, earnings_refresh:{ unresolved_count:1 } });
          case 'payroll.offCycle.record': return ok({ ...data.offCycle[0], id:'oc_new' });
          case 'payroll.settings.save': data.approvalRequired = input.approval_required; return ok({ approval_required:input.approval_required, revision:2 });
          default: return ok({ batch:data.history[2] });
        }
      }
    } };
    if (adjust) new Function('data', adjust)(data);
  }, { who:people[who], data:fixtures(), adjust });
  for (const script of ['app-runtime/firstmate-embeddable-apps.js', 'app-runtime/app-chrome.js', 'apps/people/people-kit.js', 'apps/people/entity-modal.js', 'payroll-api/payroll-api.js', 'apps/settings/payroll.js', 'apps/payroll/my-pay.js', 'apps/payroll/app.js']) await page.addScriptTag({ url:`https://payroll.test/libraries/${script}` });
  await page.evaluate(async (who) => { window.handle = await window.FirstMateEmbeddableApps.mount(document.querySelector('main'), 'portal.payroll', { surface:'portal_tab', orgId:'org', permissions:who.permissions }); }, people[who]);
  return { page, errors };
}
const tabs = (page) => page.locator('[data-app-header] .app-tabs button').allTextContents();
async function show(page, view){
  await page.locator(`[data-app-header] [data-payroll-view="${view}"]`).click();
  await page.locator(`.fmp[data-payroll-view="${view}"]`).waitFor();
  await page.waitForFunction(() => !document.querySelector('.fmp .fmp-state[role=status]'));
}
async function shoot(page, name, phone){
  await page.waitForTimeout(320); // modals and popovers fade in
  await page.screenshot({ path:shotPath(name), fullPage:true });
  if (!phone) return;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} scrolls sideways`);
}

test('payroll app: a payroll manager runs payroll, reviews, fixes timesheets and copies a pay run out', async () => {
  await mkdir(shots, { recursive:true });
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    for (const [width, height, suffix] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
      const phone = suffix === 'phone';
      const { page, errors } = await openApp(browser, 'manager', { width, height });
      assert.deepEqual(await tabs(page), ['Pay runs', 'Review', 'Timesheets', 'Earnings', 'History', 'Reports', 'Approvals', 'My pay', 'Settings']);
      assert.equal(await page.locator('h1').count(), 1, 'one header');

      await show(page, 'upcoming');
      assert.match(await page.locator('[data-section="runs"]').innerText(), /Summit Roofing|Weekly hourly/);
      assert.equal(await page.locator('[data-section="runs"] tbody tr').count(), 2, 'pay dates with nobody to pay are left out');
      assert.match(await page.locator('.fmp-stats').innerText(), /Needs review\s+3/);
      assert.match(await page.locator('[data-section="offcycle-waiting"]').innerText(), /Ana Lopez/);
      const runMoney = await page.locator('[data-section="runs"] td.num').first().evaluate((cell) => getComputedStyle(cell).textAlign);
      if (!phone) assert.equal(runMoney, 'right');
      await shoot(page, `pay-runs-${suffix}`, phone);
      // Needs review leads to Review through the tab's route.
      await page.locator('[data-go="review"]').click();
      await page.locator('.fmp[data-payroll-view="review"]').waitFor();
      assert.equal(await page.locator('[data-app-header] [aria-current="page"]').innerText(), 'Review');
      await show(page, 'upcoming');

      // An undrafted pay run: who is in it and what each is paid, with what was paid outside a run taken off.
      await page.locator('[data-section="runs"] tbody tr').first().click();
      await page.locator('.pp-modal [data-run-steps="none"]').waitFor();
      const people = await page.locator('.pp-modal [data-modal-panel="people"]').innerText();
      assert.match(people, /Ana Lopez/); assert.match(people, /−\$200\.00/); assert.match(people, /Contractors/); assert.match(people, /Summit Roofing LLC/);
      await shoot(page, `pay-run-preview-${suffix}`);
      await page.locator('.pp-modal [data-run-act="draft"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.batch.create'));
      await page.keyboard.press('Escape');

      // A drafted pay run waiting for the owner, who is named and has not decided.
      await page.locator('[data-section="runs"] tbody tr').nth(1).click();
      await page.locator('.pp-modal [data-run-steps="pending"]').waitFor();
      assert.match(await page.locator('.pp-modal [data-run-steps]').innerText(), /Waiting for Olive Owner/);
      await shoot(page, `pay-run-approval-${suffix}`);
      await page.locator('.pp-modal [data-modal-tab="export"]').click();
      await page.locator('.pp-modal [data-file="gusto_employees"]').waitFor();
      await shoot(page, `pay-run-copy-out-${suffix}`);
      await page.locator('.pp-modal [data-export="gusto_employees"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.artifact.generate' && call.input.type === 'gusto_employees' && call.input.batch_id === 'run_monthly'));
      await page.locator('.pp-modal [data-modal-tab="approval"]').click();
      assert.match(await page.locator('.pp-modal [data-modal-panel="approval"]').innerText(), /Maria Chen[\s\S]*Approved/);
      await page.locator('.pp-modal [data-modal-tab="people"]').click();
      await page.locator('.pp-modal [data-run-act="decide-approve"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.batch.decide' && call.input.decision === 'approve'));
      await page.keyboard.press('Escape');

      // Why someone is paid what they are.
      await show(page, 'payees');
      await page.locator('[data-act="load-projected"]').click();
      await page.waitForFunction(() => document.querySelector('[data-section="payees"] td[data-label="Projected"]'));
      await shoot(page, `earnings-${suffix}`, phone);
      await page.locator('[data-section="payees"] tr[data-why="organization_user:ana"]').click();
      await page.locator('.pp-modal [data-modal-panel="paid_by"]').getByText('Hourly from the time clock').waitFor();
      assert.match(await page.locator('.pp-modal [data-modal-panel="paid_by"]').innerText(), /Installer role/);
      await shoot(page, `why-${suffix}`);
      await page.locator('.pp-modal [data-modal-tab="results"]').click();
      assert.match(await page.locator('.pp-modal [data-modal-panel="results"]').innerText(), /rate_cents is not set/);
      await page.keyboard.press('Escape');

      await show(page, 'review');
      for (const section of ['unresolved', 'held', 'back-pay', 'offcycle', 'finalized', 'reimbursements']) await page.locator(`[data-section="${section}"]`).waitFor();
      assert.match(await page.locator('[data-section="finalized"]').innerText(), /Not earned yet/);
      assert.match(await page.locator('[data-section="finalized"]').innerText(), /1 more are already in a pay run/);
      assert.match(await page.locator('[data-section="reimbursements"]').innerText(), /No schedule/);
      await shoot(page, `review-${suffix}`, phone);
      // Recording back pay as paid outside a run fills the form from the correction.
      await page.locator('[data-section="back-pay"] [data-record-for]').click();
      await page.locator('.pp-form').waitFor();
      assert.equal(await page.locator('.pp-form [name="amount"]').inputValue(), '84.00');
      assert.equal(await page.locator('.pp-form [name="payee"]').inputValue(), 'organization_user:ben');
      await shoot(page, `record-off-cycle-${suffix}`);
      await page.locator('.pp-form [name="reference"]').fill('Check 1050');
      await page.locator('.pp-form button[type="submit"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.offCycle.record' && call.input.amount_cents === 8400 && call.input.kind === 'hourly' && call.input.reference === 'Check 1050'));
      await page.locator('[data-section="held"] [data-accept]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.projection.accrue' && call.target.id === 'held_1'));

      await show(page, 'timesheets');
      assert.equal(await page.locator('[data-section="timesheets"] tbody tr').count(), 2, 'needs approval first');
      assert.match(await page.locator('[data-section="timesheets"]').innerText(), /1\.3 km/);
      await shoot(page, `timesheets-${suffix}`, phone);
      await page.locator('[data-ts-edit="s1"]').click();
      await page.locator('.pp-form [name="break"]').fill('45');
      await page.locator('.pp-form button[type="submit"]').click();
      await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.timesheet.correct' && call.input.break_seconds === 2700 && call.input.expected_revision === 2));
      await page.locator('[data-ts-approve-all]').click();
      await page.waitForFunction(() => calls.filter((call) => call.action === 'payroll.timesheet.approve').length === 2);
      await page.locator('[data-ts-status="all"]').click();
      assert.equal(await page.locator('[data-section="timesheets"] tbody tr').count(), 6);

      await show(page, 'history');
      assert.equal(await page.locator('[data-section="history"] tbody tr').count(), 3);
      await shoot(page, `history-${suffix}`, phone);
      await page.locator('[data-section="history"] tbody tr').first().click();
      await page.locator('.pp-modal [data-run-steps="paid"]').waitFor();
      assert.match(await page.locator('.pp-modal [data-modal-panel="people"]').innerText(), /Reimbursements in this pay run[\s\S]*shingles run/);
      await page.keyboard.press('Escape');

      await show(page, 'exports');
      assert.equal(await page.locator('[data-section="reports"] tbody tr').count(), 4, 'pay run files are in the pay run, not here');
      await shoot(page, `reports-${suffix}`, phone);

      await show(page, 'approvals');
      await page.locator('[data-approval-approve="run_monthly"]').waitFor();
      await shoot(page, `approvals-${suffix}`, phone);

      await show(page, 'mine');
      await page.locator('[data-section="projected"]').waitFor();
      await shoot(page, `my-pay-manager-${suffix}`, phone);

      await page.locator('[data-app-header] [data-payroll-view="settings"]').click();
      await page.locator('[data-payroll-settings-host] .pycfg').waitFor();
      await page.locator('[data-payroll-settings-host] [data-select-schedule]').first().waitFor();
      assert.equal(await page.locator('[data-payroll-settings-host] .pycfg-head').count(), 0, 'Settings inside Payroll has no second header');
      // Whether pay runs need approval is a payroll setting; on unless turned off.
      assert.equal(await page.locator('[data-approval-required]').isChecked(), true);
      await shoot(page, `settings-${suffix}`, phone);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('payroll app: someone with only the time clock and self-service earnings sees their own pay and time', async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    for (const [width, height, suffix] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
      const { page, errors } = await openApp(browser, 'crew', { width, height });
      assert.deepEqual(await tabs(page), ['Timesheets', 'My pay']);
      await show(page, 'mine');
      const text = await page.locator('.fmp').innerText();
      assert.match(text, /Earned, not paid yet/); assert.match(text, /31 Cedar Way/); assert.match(text, /Paid outside a pay run[\s\S]*\$200\.00/); assert.match(text, /My timesheets/);
      assert.equal(await page.locator('[data-act], [data-why], [data-run]').count(), 0, 'no manager controls');
      await shoot(page, `my-pay-${suffix}`, suffix === 'phone');
      await show(page, 'timesheets');
      await page.locator('[data-ts-status="all"]').click();
      assert.equal(await page.locator('[data-section="timesheets"] tbody tr').count(), 3);
      assert.equal(await page.locator('[data-ts-approve], [data-ts-edit], [data-ts-reject], [data-ts-search]').count(), 0);
      assert.match(await page.locator('[data-section="timesheets"] h2').innerText(), /Your timesheets/);
      await shoot(page, `my-timesheets-${suffix}`, suffix === 'phone');
      assert.ok(await page.evaluate(() => calls.every((call) => !['payroll.timesheets.list', 'payroll.dashboard.read'].includes(call.action))), 'never asks for everyone’s data');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('payroll app: a named approver without payroll management sees only Approvals and decides', async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    const { page, errors } = await openApp(browser, 'approver', { width:1440, height:900 });
    await page.waitForFunction(() => document.querySelectorAll('[data-app-header] .app-tabs button').length === 2);
    assert.deepEqual(await tabs(page), ['Approvals', 'My pay']);
    await show(page, 'approvals');
    assert.match(await page.locator('.fmp').innerText(), /Carla Diaz[\s\S]*\$3,550\.00/);
    await page.locator('[data-approval-reject="run_monthly"]').click();
    await page.locator('.pp-form [name="note"]').fill('Carla’s clawback is wrong');
    await shoot(page, 'approver-reject-desktop');
    await page.locator('.pp-form button[type="submit"]').click();
    await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.batch.decide' && call.input.decision === 'reject' && /clawback/.test(call.input.note)));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('payroll app: with approval turned off a pay run goes draft, entered, paid, and the setting saves', async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    // The next weekly run is drafted; the organization turned approval off.
    const adjust = `data.approvalRequired = false;
      const occurrence = data.dashboard.upcoming[0];
      occurrence.batch = { ...data.history[0], id:'run_open', status:'draft', pay_date:occurrence.pay_date, approval:{ status:'not_required' }, paid_at:'', run_at:'', items:data.history[0].items.map((item) => ({ ...item, status:'draft', paid_at:'', payment_reference:'' })) };`;
    const { page, errors } = await openApp(browser, 'manager', { width:1440, height:900 }, adjust);
    await show(page, 'upcoming');
    await page.locator('[data-section="runs"] tbody tr').first().click();
    const steps = page.locator('.pp-modal [data-run-steps="draft"]');
    await steps.waitFor();
    assert.match(await steps.innerText(), /copy it out to your payroll software, then mark it entered/);
    assert.equal(await steps.locator('[data-run-act="approve-self"]').count(), 0, 'no approval step');
    await shoot(page, 'pay-run-no-approval-desktop');
    await steps.locator('[data-run-act="run"]').click();
    await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.batch.action' && call.input.action === 'run'));
    assert.ok(await page.evaluate(() => !calls.some((call) => call.action === 'payroll.batch.action' && ['submit_approval', 'finalize'].includes(call.input.action))));
    await page.locator('.pp-modal [data-item-paid]').first().click();
    await page.locator('.pp-form button[type="submit"]').click();
    await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.batch.item.update' && call.input.status === 'paid'));
    await page.keyboard.press('Escape');
    // The setting itself, in Payroll settings.
    await page.locator('[data-app-header] [data-payroll-view="settings"]').click();
    const toggle = page.locator('[data-approval-required]');
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await page.waitForFunction(() => calls.some((call) => call.action === 'payroll.settings.save' && call.input.approval_required === true && call.input.expected_revision === 1));
    await shoot(page, 'settings-approval-desktop');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
