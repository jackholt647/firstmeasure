/* public/libraries/apps/payroll/app.js
 *
 * Payroll: what is due and when it runs, who is paid how much and why, review of what needs a person, timesheets,
 * pay run history, reports and Payroll settings. Money is not moved here: a pay run is reviewed, approved, copied
 * out to Gusto, QuickBooks Payroll or similar, and marked done. Server contracts: docs/architecture/pay-rules.md.
 *
 * What each person sees comes from their permissions and the organization's app flags only (ACTIONS below). Every
 * control names the action it needs; one that is not allowed is not drawn.
 *
 *   Pay runs    upcoming pay dates, what each will pay and to whom; draft, approve, copy out, mark paid
 *   Review      earnings that could not be worked out, held corrections, back pay asked for off-cycle, payments
 *               made outside a pay run, work orders finalized to be paid, reimbursements waiting to be paid
 *   Timesheets  everyone's shifts for payroll managers; your own for someone with only the time clock
 *   Earnings    per person: owed, next pay date, projected, and why
 *   History     past pay runs
 *   Reports     date-range reports and saved files
 *   Approvals   pay runs waiting for you as a named approver
 *   My pay      your own earnings, payments and, when allowed, what you are projected to earn
 *   Settings    Payroll settings (apps/settings/payroll.js), mounted here and nowhere else
 *
 * Built from the People kit (apps/people/people-kit.js, entity-modal.js) so it reads like People settings.
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const clean = (value) => String(value ?? '').trim();
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const arr = (value) => Array.isArray(value) ? value : [];
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const kit = () => window.FirstMatePeople?.kit;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match]));
  const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (match, name) => (values && values[name] != null ? String(values[name]) : match));
  const t = (key, fallback, values) => { const readable = fill(fallback, values); return globalThis.PlatformLanguage?.text?.('payroll', key, readable, values) ?? readable; };
  const tip = (text) => (text ? ` data-fm-tooltip="${esc(text)}"` : '');
  const info = (text) => kit()?.info ? kit().info(text) : '';
  const pill = (label, tone = 'neutral', tooltip = '', icon = '') => kit()?.pill ? kit().pill({ label, tone, tooltip, icon }) : `<span>${esc(label)}</span>`;
  const toast = (title, message, ok = true) => { try { window.Portal?.ui?.showToast?.(title, message, ok); } catch (_) {} };

  // ---- Dates and money -------------------------------------------------------------------------------------

  function dayKey(value = new Date()){
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function addDays(key, days){ const date = new Date(`${clean(key)}T12:00:00`); date.setDate(date.getDate() + Number(days || 0)); return dayKey(date); }
  const locale = () => globalThis.PlatformLanguage?.formatLocale?.() || undefined;
  function dateLabel(value, options = {}){
    const raw = clean(value);
    if (!raw) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw);
    if (!Number.isFinite(date.getTime())) return raw;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return new Intl.DateTimeFormat(locale(), { weekday:options.weekday ? 'short' : undefined, month:'short', day:'numeric', ...(sameYear && !options.year ? {} : { year:'numeric' }) }).format(date);
  }
  function timeLabel(value){
    const date = new Date(clean(value));
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale(), { hour:'numeric', minute:'2-digit' }).format(date) : '';
  }
  function dateTimeLabel(value){ const raw = clean(value); return raw ? `${dateLabel(raw)} ${timeLabel(raw)}` : ''; }
  function money(cents, currency = 'USD'){
    try { return new Intl.NumberFormat(locale(), { style:'currency', currency:clean(currency || 'USD').toUpperCase() }).format(num(cents) / 100); }
    catch (_) { return `${(num(cents) / 100).toFixed(2)} ${clean(currency || 'USD')}`; }
  }
  /** A deduction is shown with a minus sign and never as a negative check. */
  function minus(cents, currency){ return num(cents) ? `\u2212${money(Math.abs(num(cents)), currency)}` : money(0, currency); }
  function hours(seconds){ const total = Math.max(0, Math.round(num(seconds) / 60)); return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`; }
  const localInput = (value) => { const date = new Date(clean(value)); if (!Number.isFinite(date.getTime())) return ''; const pad = (n) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
  const payeeKey = (payee) => `${clean(payee?.type)}:${clean(payee?.id)}`;
  const KIND_FALLBACK = { hourly:'Hourly', salary:'Salary', piece_rate:'Piece rate', commission:'Commission', reimbursement:'Reimbursement', adjustment:'Adjustment', clawback:'Clawback', off_cycle:'Paid outside a pay run', other:'Other' };
  const PAYEE_TYPES = { organization_user:'Person', resource_group:'Group', organization_connection:'Company' };

  // ---- What this person may do -----------------------------------------------------------------------------

  /*
   * Permissions from the signed-in user (Portal.util.hasPerm, else the mount context); features from the
   * organization's capability state. A feature whose state has not loaded is not hidden: the server decides.
   */
  function perm(key, context){
    if (typeof window.Portal?.util?.hasPerm === 'function') return window.Portal.util.hasPerm(key) === true;
    const permissions = obj(context?.permissions || window.Portal?.currentUser?.permissions);
    if (permissions[key] === false) return false;
    return permissions['*'] === true || permissions[key] === true;
  }
  function feature(key){
    const state = (window.Portal?.capabilities || window.PlatformAPI?.capabilities)?.current?.();
    // As the app runtime does: until the organization's capability state has loaded, nothing is hidden for it.
    if (!state?.definitions_by_key || !state?.effective_by_key) return true;
    return state.effective_by_key[key] === true;
  }
  const approvalsSeen = new Map();
  function timeClockOption(){
    const entitlements = window.Portal?.currentUser?.appEntitlements;
    const today = Array.isArray(entitlements) ? entitlements.find((entry) => entry?.id === 'portal.crew_overview') : null;
    return today?.allowed === true && today.option_values?.time_clock === true;
  }
  const CAPABILITIES = {
    payroll_app:() => feature('apps.payroll'),
    pay_runs:() => feature('payroll.pay_runs'),
    self_service:() => feature('payroll.self_service_earnings'),
    time_clock_feature:() => feature('crew.time_clock'),
    manage_payroll:(context) => perm('manage_payroll', context) || perm('manage_company_settings', context),
    // The time clock is Today's App experience option, not a permission (docs/architecture/app-experience.md).
    time_clock:() => timeClockOption(),
    own_projection:(context) => perm('payroll.view_own_projected_earnings', context),
    named_approver:() => num(approvalsSeen.get(orgOf())) > 0
  };
  /* Every control, the capabilities it needs (all of `all`, one of `any`) and what it calls on the server. */
  const ACTIONS = Object.freeze({
    'view.runs':{ all:['payroll_app', 'manage_payroll'], server:'payroll.dashboard (manage_payroll | manage_company_settings)' },
    'view.review':{ all:['payroll_app', 'manage_payroll'], server:'payroll.pay_review, pay_unresolved, off_cycle_payments, finalized_work' },
    'view.timesheets':{ all:['payroll_app'], any:['manage_payroll', 'time_clock'], server:'payroll.timesheets | payroll.my_timesheets (Today time clock option)' },
    'view.payees':{ all:['payroll_app', 'manage_payroll'], server:'payroll.upcoming, payroll.projected_earnings' },
    'view.history':{ all:['payroll_app', 'manage_payroll'], server:'payroll.batches' },
    'view.reports':{ all:['payroll_app', 'manage_payroll'], server:'payroll.export_catalog, payroll.artifacts' },
    'view.approvals':{ all:['payroll_app', 'pay_runs'], any:['manage_payroll', 'named_approver'], server:'payroll.my_approvals (being named on a pay run)' },
    'view.mine':{ all:['self_service'], server:'payroll.my_earnings (payroll.self_service_earnings)' },
    'view.settings':{ all:['payroll_app', 'manage_payroll'], server:'payroll.configuration, pay rules and plans' },
    'runs.draft':{ all:['payroll_app', 'pay_runs', 'manage_payroll'], server:'payroll.batch.create' },
    'runs.approve':{ all:['payroll_app', 'pay_runs', 'manage_payroll'], server:'payroll.batch.action submit_approval, approve, finalize' },
    'runs.ask':{ all:['payroll_app', 'pay_runs', 'manage_payroll'], server:'payroll.batch.action submit_approval, payroll.directory' },
    'runs.decide':{ all:['payroll_app', 'pay_runs'], server:'payroll.batch.decide (named approver)' },
    'runs.reopen':{ all:['payroll_app', 'pay_runs', 'manage_payroll'], server:'payroll.batch.action reopen' },
    'runs.void':{ all:['payroll_app', 'pay_runs', 'manage_payroll'], server:'payroll.batch.action void' },
    'runs.done':{ all:['payroll_app', 'pay_runs', 'manage_payroll'], server:'payroll.batch.action finalize, run, paid; payroll.batch.item.update' },
    'runs.export':{ all:['payroll_app', 'manage_payroll'], server:'payroll.artifact.generate' },
    'earnings.refresh':{ all:['payroll_app', 'manage_payroll'], server:'payroll.earnings.refresh' },
    'earnings.why':{ all:['payroll_app', 'manage_payroll'], server:'payroll.pay_setup, pay_units, payroll.records, payroll.earnings' },
    'earnings.projected':{ all:['payroll_app', 'manage_payroll'], server:'payroll.projected_earnings' },
    'review.accept':{ all:['payroll_app', 'manage_payroll'], server:'payroll.projection.accrue' },
    'review.decline':{ all:['payroll_app', 'manage_payroll'], server:'payroll.correction.decline' },
    'offcycle.record':{ all:['payroll_app', 'manage_payroll'], server:'payroll.offCycle.record' },
    'offcycle.remove':{ all:['payroll_app', 'manage_payroll'], server:'payroll.offCycle.remove' },
    'timesheets.all':{ all:['payroll_app', 'manage_payroll'], server:'payroll.timesheets' },
    'timesheets.approve':{ all:['payroll_app', 'manage_payroll'], server:'payroll.timesheet.approve' },
    'timesheets.reject':{ all:['payroll_app', 'manage_payroll'], server:'payroll.timesheet.reject' },
    'timesheets.correct':{ all:['payroll_app', 'manage_payroll'], server:'payroll.timesheet.correct' },
    'timesheets.mine':{ all:['time_clock_feature', 'time_clock'], server:'payroll.timesheets.me (Today time clock option)' },
    'reports.generate':{ all:['payroll_app', 'manage_payroll'], server:'payroll.artifact.generate' },
    'mine.projected':{ all:['self_service', 'own_projection'], server:'payroll.projectedEarnings.me (payroll.view_own_projected_earnings)' }
  });
  function allows(id, context){
    const entry = ACTIONS[id];
    if (!entry) { (window.FirstMatePayroll.undeclared = window.FirstMatePayroll.undeclared || []).push(id); return false; }
    const holds = (key) => CAPABILITIES[key] ? CAPABILITIES[key](context) === true : false;
    return (entry.all || []).every(holds) && (!entry.any || entry.any.some(holds));
  }
  const orgOf = (context) => clean(context?.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  const meOf = () => clean(window.__APP?.userId || window.Portal?.currentUser?.id || window.__APP?.user?.id);

  const VIEWS = [
    ['upcoming', 'Pay runs', 'view.runs', 'What is due, when each pay run pays, who is in it and how much.'],
    ['review', 'Review', 'view.review', 'Everything that needs a person before people are paid.'],
    ['timesheets', 'Timesheets', 'view.timesheets', 'Clocked hours: correct, approve or reject them.'],
    ['payees', 'Earnings', 'view.payees', 'What each person is owed and projected to earn, and why.'],
    ['history', 'History', 'view.history', 'Pay runs already run or paid.'],
    ['exports', 'Reports', 'view.reports', 'Reports for a date range, and files prepared before.'],
    ['approvals', 'Approvals', 'view.approvals', 'Pay runs waiting for your approval.'],
    ['mine', 'My pay', 'view.mine', 'What you have earned, been paid and can expect.'],
    ['settings', 'Settings', 'view.settings', 'Pay schedules, when people are paid, pay plans and pay rules.']
  ];
  const viewNeeds = Object.fromEntries(VIEWS.map(([id, , needs]) => [id, needs]));

  // ---- Styles ----------------------------------------------------------------------------------------------

  function injectCss(){
    if (document.getElementById('fmp_css')) return;
    const style = document.createElement('style');
    style.id = 'fmp_css';
    style.textContent = `
      .fmp{min-height:100%;background:var(--bg,#f5f6f8);container-type:inline-size}
      .fmp-wrap{display:grid;gap:16px;max-width:1240px;margin:0 auto;min-width:0;padding:18px 22px 40px}
      .pp-modal-panel{container-type:inline-size}
      .fmp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
      .fmp-bar-fill{flex:1}
      .fmp-bar .pp-select{min-width:150px}
      .fmp-bar .pp-input{height:34px}
      .fmp-date{display:inline-flex;align-items:center;gap:6px;color:var(--pp-muted);font-size:12px;font-weight:600}
      .fmp-date input{width:142px}
      .fmp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
      .fmp-stat{display:grid;gap:3px;min-width:0;padding:13px 14px;border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-panel)}
      .fmp-stat>span{color:var(--pp-muted);font-size:12px;font-weight:600}
      .fmp-stat>b{font-size:20px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmp-stat>small{color:var(--pp-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .fmp-stat.warn>b{color:var(--pp-warn)}
      button.fmp-stat{text-align:left;font:inherit;color:inherit;cursor:pointer}
      button.fmp-stat:hover{border-color:var(--pp-accent)}
      .fmp-card{min-width:0;border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-panel);overflow:hidden}
      .fmp-card>header{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-height:48px;padding:8px 10px 8px 16px;border-bottom:1px solid var(--pp-line-soft)}
      .fmp-card>header h2{margin:0;font-size:14px;font-weight:700;color:var(--pp-text)}
      .fmp-card>header .fmp-count{color:var(--pp-muted);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}
      .fmp-card>header .fmp-card-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
      .fmp-card>header .pp-btn{height:30px}
      .fmp-empty{padding:18px 16px;color:var(--pp-muted);font-size:12.5px}
      .fmp-note{padding:10px 16px;color:var(--pp-muted);font-size:12px;border-top:1px solid var(--pp-line-soft)}
      .fmp-table{width:100%;border-collapse:collapse;font-size:12.5px}
      .fmp-table th{padding:8px 12px;border-bottom:1px solid var(--pp-line);color:var(--pp-muted);font-size:11.5px;font-weight:650;text-align:left;white-space:nowrap;background:var(--pp-soft)}
      .fmp-table td{padding:9px 12px;border-bottom:1px solid var(--pp-line-soft);vertical-align:middle;color:var(--pp-strong)}
      .fmp-table tbody tr:last-child td{border-bottom:0}
      .fmp-table th:first-child,.fmp-table td:first-child{padding-left:16px}
      .fmp-table th:last-child,.fmp-table td:last-child{padding-right:14px}
      .fmp-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .fmp-table .neg{color:var(--pp-danger)}
      .fmp-table .act{text-align:right;white-space:nowrap;width:1%}
      .fmp-table .act .pp-btn{height:28px;padding:0 10px;font-size:12px}
      .fmp-table tr[data-open]{cursor:pointer}
      .fmp-table tr[data-open]:hover td{background:var(--pp-soft)}
      .fmp-table tr.fmp-sub td{background:var(--pp-soft);font-weight:700;color:var(--pp-text)}
      .fmp-table tr.fmp-section td{padding-top:12px;color:var(--pp-muted);font-size:11.5px;font-weight:700;background:var(--pp-panel)}
      .fmp-name{display:grid;gap:1px;min-width:0}
      .fmp-name>strong{font-weight:650;color:var(--pp-text);overflow:hidden;text-overflow:ellipsis}
      .fmp-name>small{color:var(--pp-muted);font-size:11.5px}
      .fmp-link{padding:0;border:0;background:none;color:var(--pp-text);font:inherit;font-weight:650;cursor:pointer;text-align:left;text-decoration:underline;text-decoration-color:var(--pp-line);text-underline-offset:3px}
      .fmp-link:hover{color:var(--pp-accent);text-decoration-color:currentColor}
      .fmp-steps{display:grid;gap:10px;padding:12px 14px;margin-bottom:14px;border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-soft)}
      .fmp-steps>p{margin:0;color:var(--pp-strong);font-size:12.5px;line-height:1.45}
      .fmp-steps-actions{display:flex;flex-wrap:wrap;gap:8px}
      .fmp-files{display:grid;gap:8px}
      .fmp-file{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--pp-line);border-radius:10px;background:var(--pp-panel)}
      .fmp-file>i{color:var(--pp-faint)}
      .fmp-file>div{flex:1;min-width:0;display:grid;gap:2px}
      .fmp-file strong{font-size:12.5px}
      .fmp-file small{color:var(--pp-muted);font-size:11.5px}
      .fmp-file .pp-btn{height:30px}
      .fmp-modal-section{display:grid;gap:8px;margin-bottom:18px}
      .fmp-modal-section>h3{display:flex;align-items:center;gap:4px;margin:0;font-size:13px;font-weight:700}
      .fmp-modal-section .fmp-table{border:1px solid var(--pp-line);border-radius:10px;overflow:hidden;border-collapse:separate;border-spacing:0}
      .fmp-reason{color:var(--pp-danger);font-size:12px}
      .fmp-muted{color:var(--pp-muted)}
      .fmp-state{padding:48px 16px;text-align:center;color:var(--pp-muted)}
      .fmp-state>strong{display:block;margin-bottom:6px;color:var(--pp-strong);font-size:14px}
      .fmp-busy{opacity:.6;pointer-events:none}
      .fmp a.pp-btn,.pp-modal a.pp-btn{text-decoration:none}
      .fmp-titled{display:inline-flex;align-items:center;gap:2px}
      .fmp-settings{min-width:0}
      @container (max-width:640px){
        .fmp-wrap{padding:12px 12px 32px}
        .fmp-bar .pp-seg{max-width:100%;overflow-x:auto;scrollbar-width:none}
        .fmp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
        .fmp-stat>b{font-size:17px}
        .fmp-bar .pp-select,.fmp-bar .pp-search{flex:1 1 140px;min-width:0}
        .fmp-date input{width:128px}
        .fmp-card>header .fmp-card-actions{width:100%;margin-left:0}
        .fmp-card>header .fmp-card-actions .pp-btn{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
        .fmp-table .hide-sm{display:none}
        .fmp-table.stack thead{display:none}
        .fmp-table.stack,.fmp-table.stack tbody{display:block;width:100%}
        .fmp-table.stack tr{display:flex;flex-wrap:wrap;align-items:flex-end;gap:6px 16px;padding:10px 14px;border-bottom:1px solid var(--pp-line-soft)}
        .fmp-table.stack tbody tr:last-child{border-bottom:0}
        .fmp-table.stack td{display:block;flex:1 1 26%;min-width:0;padding:0!important;border:0;text-align:left;background:none!important}
        .fmp-table.stack td.num{text-align:left;white-space:normal}
        .fmp-table.stack td[data-label]:not(.lead)::before{content:attr(data-label);display:block;margin-bottom:1px;color:var(--pp-faint);font-size:10.5px;font-weight:600}
        .fmp-table.stack td.lead{flex-basis:100%}
        .fmp-table.stack td.act{flex-basis:100%;text-align:left}
        .fmp-table.stack td.act:empty{display:none}
        .fmp-table.stack td.hide-sm{display:none}
        .fmp-table.stack tr.fmp-section{display:block;padding:10px 14px 2px;border:0}
        .fmp-table.stack tr.fmp-section td{min-width:0}
      }
    `;
    document.head.appendChild(style);
  }

  // ---- Small pieces ----------------------------------------------------------------------------------------

  function card({ id, title, tooltip, count, actions = '', body }){
    return `<section class="fmp-card" data-section="${esc(id)}"><header><h2${tip(tooltip)}>${esc(title)}</h2>${tooltip ? info(tooltip) : ''}${count === undefined || count === null ? '' : `<span class="fmp-count">${esc(count)}</span>`}<div class="fmp-card-actions">${actions}</div></header>${body}</section>`;
  }
  function table(columns, rows, options = {}){
    if (!rows.length) return `<div class="fmp-empty">${esc(options.empty || t('nothing_here', 'Nothing here.'))}</div>`;
    const head = columns.map((column) => `<th class="${esc(column.cls || '')}"${tip(column.tooltip)}>${esc(column.label)}</th>`).join('');
    // Wide tables become labeled blocks on a phone; two or three columns stay a table.
    return `<table class="fmp-table${columns.filter((column) => !String(column.cls || '').includes('hide-sm')).length > 3 ? ' stack' : ''}"${options.label ? ` aria-label="${esc(options.label)}"` : ''}><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
  const td = (html, label = '', cls = '') => `<td class="${esc(cls)}"${label ? ` data-label="${esc(label)}"` : ''}>${html}</td>`;
  const stat = ({ label, value, sub = '', tooltip = '', tone = '', open = '' }) => open
    ? `<button type="button" class="fmp-stat ${esc(tone)}" data-go="${esc(open)}"${tip(tooltip)}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(sub)}</small></button>`
    : `<div class="fmp-stat ${esc(tone)}"${tip(tooltip)}><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(sub)}</small></div>`;
  function button(id, context, { label, icon = '', tone = '', attrs = '', tooltip = '' }){
    if (!allows(id, context)) return '';
    return `<button type="button" class="pp-btn ${esc(tone)}" ${attrs}${tip(tooltip)}>${icon ? `<i class="fas ${esc(icon)}" aria-hidden="true"></i>` : ''}${esc(label)}</button>`;
  }
  function nameCell(primary, secondary = ''){
    return `<span class="fmp-name"><strong>${esc(primary)}</strong>${secondary ? `<small>${esc(secondary)}</small>` : ''}</span>`;
  }
  const payeeName = (payee) => clean(payee?.name) || clean(payee?.id) || t('someone', 'Someone');
  const paidAs = (payee) => clean(payee?.type) === 'organization_connection' ? t('company', 'Company') : clean(payee?.worker_type || 'employee') === 'employee' ? t('employee', 'Employee') : t('contractor', 'Contractor');
  function download(url){
    const link = document.createElement('a');
    link.href = url; link.download = ''; link.rel = 'noopener';
    document.body.appendChild(link); link.click(); link.remove();
  }

  // What a pay run pays one person, from either the upcoming preview or a drafted run.
  function lineOf(item, preview){
    const source = preview ? obj(item.accrued) : item;
    const totals = obj(source.subgroup_totals);
    const reimbursement = num(totals.reimbursement);
    const offCycle = Math.abs(num(totals.off_cycle));
    const clawback = Math.abs(num(totals.clawback));
    const kinds = Object.entries(totals).filter(([key, value]) => !['reimbursement', 'off_cycle', 'clawback'].includes(key) && num(value) > 0);
    return {
      payee:obj(item.payee), kinds, reimbursement, offCycle, clawback,
      earned:kinds.reduce((sum, [, value]) => sum + num(value), 0),
      net:num(source.net_cents), projected:preview ? num(obj(item.projected).net_cents) : 0,
      status:preview ? '' : clean(item.status), item:preview ? null : item
    };
  }
  function runStatus(occurrence, batch){
    if (!batch) return { key:'none', label:t('not_drafted', 'Not drafted'), tone:'neutral' };
    const approval = clean(obj(batch.approval).status);
    const status = clean(batch.status);
    if (status === 'void') return { key:'void', label:t('voided', 'Voided'), tone:'muted' };
    if (status === 'paid') return { key:'paid', label:t('paid', 'Paid'), tone:'ok' };
    if (status === 'run') return { key:'run', label:t('entered', 'Entered, not paid'), tone:'role' };
    if (status === 'partial') return { key:'partial', label:t('partly_paid', 'Partly paid'), tone:'role' };
    if (approval === 'pending') return { key:'pending', label:t('waiting_approval', 'Waiting for approval'), tone:'warn' };
    if (approval === 'rejected') return { key:'rejected', label:t('rejected', 'Rejected'), tone:'danger' };
    if (approval === 'approved' || approval === 'finalized') return { key:'approved', label:t('approved', 'Approved'), tone:'ok' };
    return { key:'draft', label:t('draft', 'Draft'), tone:'neutral' };
  }

  // ---- The app ---------------------------------------------------------------------------------------------

  function createApp(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    injectCss();
    const today = dayKey();
    const routed = () => window.AppChrome?.resolve?.('payroll', window.Portal?.navigation?.read?.().payrollView, context) || 'upcoming';
    const state = {
      orgId:orgOf(context),
      view:clean(context.params?.standalone) || routed(),
      data:{}, errors:{}, loading:false, busy:false, destroyed:false, token:0,
      branch:clean(context.params?.branch_ids),
      structure:null, vocabulary:null, rules:null, directory:null, settings:null,
      ts:{ from:clean(context.params?.from) || addDays(today, -14), through:clean(context.params?.through) || today, status:'pending', search:'' },
      reports:{ from:addDays(today, -30), through:today },
      payeeSearch:'', projected:null,
      // A widget may ask for its own dates; the tab looks two months ahead.
      range:{ from:clean(context.params?.from) || today, through:clean(context.params?.through) || addDays(today, 62) }
    };
    const can = (id) => allows(id, context);
    const branchArgs = () => (state.branch ? { branch_ids:state.branch } : {});
    let settingsHandle = null;

    function rerenderModal(){ openModal?.refresh?.(); }
    let openModal = null;

    // -- Loading --
    async function guarded(read){ try { return { value:await read() }; } catch (error) { return { error:clean(error?.message) || t('unavailable', 'This could not be loaded.') }; } }
    async function loadShared(){
      if (state.structure === null && window.PlatformAPI?.publication?.read) {
        const result = await window.PlatformAPI.publication.read(state.orgId, { provider:'organization-branches', export:'structure', target:{ scope:'organization', organizationId:state.orgId } }).catch(() => null);
        state.structure = result?.status === 'ready' ? obj(result.value) : {};
      }
      if (can('view.runs') && state.settings === null) state.settings = await Promise.resolve(window.PayrollAPI?.published?.read?.(state.orgId, 'configuration')).then((value) => obj(value?.settings)).catch(() => ({})) || {};
      if (can('view.runs') && state.vocabulary === null) state.vocabulary = await Promise.resolve(window.PayrollAPI?.pay?.vocabulary?.(state.orgId)).catch(() => ({})) || {};
    }
    async function load(options = {}){
      if (state.destroyed || !state.orgId || state.view === 'settings' || state.view === 'mine') return;
      if (!window.PayrollAPI) { state.loading = false; state.unavailable = true; render(); return; }
      const token = ++state.token;
      if (!options.silent) { state.loading = true; render(); }
      await loadShared();
      const view = state.view, api = window.PayrollAPI;
      const tasks = {};
      if (view === 'upcoming' || view === 'payees') {
        tasks.dashboard = () => api.dashboard(state.orgId, { from:state.range.from, through:state.range.through, include_projected:true, history_limit:1, ...branchArgs() });
        if (view === 'upcoming' && can('view.review')) { tasks.review = () => api.pay.review(state.orgId); tasks.unresolved = () => api.pay.unresolved(state.orgId); tasks.offCycle = () => api.offCycle.list(state.orgId, branchArgs()); }
      }
      if (view === 'review') {
        tasks.review = () => api.pay.review(state.orgId);
        tasks.unresolved = () => api.pay.unresolved(state.orgId);
        tasks.offCycle = () => api.offCycle.list(state.orgId, branchArgs());
        tasks.finalized = () => api.finalizedWork(state.orgId, branchArgs());
        tasks.reimbursements = () => api.ledger.list(state.orgId, { kind:'reimbursement', state:'accrued', open_only:true, limit:500, ...branchArgs() });
        tasks.rules = () => api.pay.rules(state.orgId);
      }
      if (view === 'timesheets') {
        tasks.timesheets = can('timesheets.all')
          ? () => api.timesheets.list(state.orgId, { from:state.ts.from, through:state.ts.through, limit:1000, ...branchArgs() })
          : () => api.timesheets.mine(state.orgId, { from:state.ts.from, through:state.ts.through });
      }
      if (view === 'history') { tasks.batches = () => api.batches.list(state.orgId, { limit:100, ...branchArgs() }).then((result) => arr(result?.batches)); tasks.schedules = () => api.schedules.list(state.orgId, { includeArchived:true }).then((result) => result.schedules); tasks.offCycle = () => api.offCycle.list(state.orgId, branchArgs()); }
      if (view === 'exports') { tasks.catalog = () => api.artifacts.catalog(state.orgId).then((result) => arr(result?.exports)); tasks.artifacts = () => api.artifacts.list(state.orgId, { limit:100 }).then((result) => arr(result?.artifacts)); }
      if (view === 'approvals') tasks.approvals = () => api.approvals.mine(state.orgId);
      const entries = Object.entries(tasks);
      const results = await Promise.all(entries.map(([, read]) => guarded(read)));
      if (token !== state.token || state.destroyed) return;
      entries.forEach(([key], index) => { state.data[key] = results[index].value; state.errors[key] = results[index].error || ''; });
      if (view === 'approvals') { approvalsSeen.set(state.orgId, num(state.data.approvals?.count)); }
      state.loading = false;
      render();
      rerenderModal();
    }
    async function perform(label, work, success = ''){
      if (state.busy) return null;
      state.busy = true;
      root.classList.add('fmp-busy');
      try {
        const result = await work();
        if (success) toast(success, label);
        return result ?? true;
      } catch (error) {
        toast(t('not_done', 'That did not work'), clean(error?.message) || label, false);
        return null;
      } finally {
        state.busy = false;
        root.classList.remove('fmp-busy');
        await load({ silent:true });
      }
    }

    // -- Shared toolbar pieces --
    function branchControl(){
      const structure = obj(state.structure);
      if (structure.multiple !== true) return '';
      const access = obj(structure.access);
      const names = new Map(arr(structure.branches).map((branch) => [clean(branch.id), clean(branch.name) || t('main_branch', 'Main branch')]));
      const options = [{ value:'', label:access.restricted ? t('my_branches', 'My branches') : t('all_branches', 'All branches') }, { value:'mine', label:t('my_branch', 'My branch') }];
      if (arr(structure.my_region_ids).length && access.see !== 'own') options.push({ value:'region', label:t('my_region', 'My region') });
      arr(access.visible_branch_ids).forEach((id) => options.push({ value:id, label:names.get(clean(id)) || id }));
      return kit().select({ name:'branch', value:state.branch, options, label:t('branch', 'Branch'), attrs:'data-branch' });
    }
    const hiddenNote = (count) => count ? `<div class="fmp-note">${esc(t('hidden_people', '{count} people of other branches are not shown.', { count }))}</div>` : '';

    // -- Pay runs --
    function occurrenceRows(){
      const list = arr(state.data.dashboard?.upcoming);
      return list.filter((occurrence) => occurrence.batch || arr(occurrence.employees).length || arr(occurrence.subcontractors).length);
    }
    function upcomingView(){
      const dashboard = obj(state.data.dashboard);
      const runs = occurrenceRows();
      const currency = clean(dashboard.schedules?.[0]?.currency || 'USD');
      const next = runs.find((occurrence) => runStatus(occurrence, occurrence.batch).key !== 'paid');
      const due30 = runs.filter((occurrence) => clean(occurrence.pay_date) <= addDays(state.range.from, 30)).reduce((sum, occurrence) => sum + num(occurrence.accrued_total_cents), 0);
      const projected = runs.reduce((sum, occurrence) => sum + num(occurrence.projected_additional_cents), 0);
      const review = obj(state.data.review);
      const attention = arr(review.held).length + arr(review.off_cycle).length + arr(state.data.unresolved).length;
      const offWaiting = arr(state.data.offCycle).filter((row) => num(row.waiting_cents) > 0);
      const stats = `<div class="fmp-stats">
        ${stat({ label:t('next_pay_date', 'Next pay date'), value:next ? dateLabel(next.pay_date, { weekday:true }) : t('none', 'None'), sub:next ? `${clean(next.schedule?.name)} \u00b7 ${money(next.accrued_total_cents, currency)}` : t('nothing_due', 'Nothing is due'), tooltip:t('next_pay_date_tip', 'The next pay run that is not paid yet, and what it pays from earnings so far.') })}
        ${stat({ label:t('due_30', 'Due in the next 30 days'), value:money(due30, currency), sub:t('earned_so_far', 'From earnings so far'), tooltip:t('due_30_tip', 'What the pay runs in the next 30 days pay from what has been earned so far, after anything already paid outside a pay run and any clawbacks.') })}
        ${stat({ label:t('projected_more', 'Projected on top'), value:money(projected, currency), sub:t('not_earned_yet', 'Not earned yet'), tooltip:t('projected_more_tip', 'Forecast earnings posted to the ledger that are not earned yet. They are not paid until they are.') })}
        ${can('view.review') ? stat({ label:t('needs_review', 'Needs review'), value:String(attention), sub:attention ? t('before_paying', 'Look at these before paying') : t('all_clear', 'All clear'), tone:attention ? 'warn' : '', open:'review', tooltip:t('needs_review_tip', 'Earnings that could not be worked out, corrections held for review and back pay asked to be paid off-cycle.') }) : ''}
      </div>`;
      const rows = runs.map((occurrence) => {
        const status = runStatus(occurrence, occurrence.batch);
        const batch = occurrence.batch;
        const people = batch ? arr(batch.items).length : arr(occurrence.employees).length + arr(occurrence.subcontractors).length;
        const employees = batch ? num(batch.employee_total_cents) : arr(occurrence.employees).reduce((sum, item) => sum + num(item.accrued?.net_cents), 0);
        const contractors = batch ? num(batch.subcontractor_total_cents) : arr(occurrence.subcontractors).reduce((sum, item) => sum + num(item.accrued?.net_cents), 0);
        const key = `${clean(occurrence.schedule?.id)}|${clean(occurrence.pay_date)}`;
        return `<tr data-open="run" data-run="${esc(key)}" tabindex="0">
          ${td(nameCell(dateLabel(occurrence.pay_date, { weekday:true }), clean(occurrence.schedule?.name)), t('pay_date', 'Pay date'), 'lead')}
          ${td(esc(`${dateLabel(occurrence.period_start)} \u2013 ${dateLabel(occurrence.period_end)}`), t('period', 'Period'), 'hide-sm')}
          ${td(esc(people), t('people', 'People'), 'num hide-sm')}
          ${td(esc(money(employees, currency)), t('employees', 'Employees'), 'num hide-sm')}
          ${td(esc(money(contractors, currency)), t('contractors', 'Contractors'), 'num hide-sm')}
          ${td(`<b>${esc(money(employees + contractors, currency))}</b>`, t('to_pay', 'To pay'), 'num')}
          ${td(pill(status.label, status.tone), t('status', 'Status'))}
        </tr>`;
      });
      const quiet = arr(dashboard.upcoming).length - runs.length;
      const unscheduled = arr(dashboard.diagnostics).find((row) => row.code === 'unassigned_entries');
      const actions = [
        button('earnings.refresh', context, { label:t('refresh_earnings', 'Refresh earnings'), icon:'fa-rotate', attrs:'data-act="refresh-earnings"', tooltip:t('refresh_tip', 'Work out everyone\u2019s earnings from their pay rules now. Drafting a pay run does this too.') }),
        button('offcycle.record', context, { label:t('record_payment_short', 'Record a payment'), icon:'fa-hand-holding-dollar', attrs:'data-act="record-offcycle"', tooltip:t('record_payment_tip', 'You paid someone outside the normal pay run. Record it here and their next pay run takes it off, so nobody is paid twice.') })
      ].join('');
      return `${stats}
        ${card({ id:'runs', title:t('upcoming_pay_runs', 'Upcoming pay runs'), tooltip:t('upcoming_tip', 'Each pay date of each pay schedule in the next two months that has someone to pay. Open one to see who is in it, approve it, copy it out to your payroll software and mark it paid.'), count:runs.length, actions,
          body:`${table([{ label:t('pay_date', 'Pay date') }, { label:t('period', 'Period'), cls:'hide-sm' }, { label:t('people', 'People'), cls:'num hide-sm' }, { label:t('employees', 'Employees'), cls:'num hide-sm' }, { label:t('contractors', 'Contractors'), cls:'num hide-sm' }, { label:t('to_pay', 'To pay'), cls:'num', tooltip:t('to_pay_tip', 'After payments already made outside a pay run and clawbacks.') }, { label:t('status', 'Status') }], rows, { empty:t('no_runs', 'No pay run in the next two months has anyone to pay.'), label:t('upcoming_pay_runs', 'Upcoming pay runs') })}
          ${quiet > 0 ? `<div class="fmp-note">${esc(t('quiet_dates', '{count} more pay dates have nothing to pay yet.', { count:quiet }))}</div>` : ''}
          ${unscheduled ? `<div class="fmp-note">${esc(t('unscheduled', '{count} earnings have no pay schedule and are in no pay run. Choose the company\u2019s pay schedule in Settings.', { count:num(unscheduled.count) }))}</div>` : ''}` })}
        ${offWaiting.length ? card({ id:'offcycle-waiting', title:t('paid_outside_waiting', 'Paid outside a pay run, still to take off'), tooltip:t('paid_outside_waiting_tip', 'Payments recorded as made outside a pay run that the next pay runs will take off what these people are paid.'), count:offWaiting.length,
          body:table([{ label:t('person', 'Person') }, { label:t('paid_on', 'Paid on') }, { label:t('still_to_take_off', 'Still to take off'), cls:'num' }], offWaiting.map((row) => `<tr>${td(nameCell(payeeName(row.payee), kindLabel(row.kind)), t('person', 'Person'), 'lead')}${td(esc(dateLabel(row.paid_on)), t('paid_on', 'Paid on'))}${td(esc(minus(row.waiting_cents, row.currency)), t('still_to_take_off', 'Still to take off'), 'num neg')}</tr>`)) }) : ''}`;
    }
    function kindLabel(kind){
      const labels = obj(obj(state.vocabulary).labels).earning_kinds;
      return clean(obj(labels)[kind]) || KIND_FALLBACK[kind] || clean(kind).replace(/_/g, ' ');
    }

    // -- A pay run, opened --
    function findOccurrence(key){
      const [scheduleId, payDate] = clean(key).split('|');
      return arr(state.data.dashboard?.upcoming).find((occurrence) => clean(occurrence.schedule?.id) === scheduleId && clean(occurrence.pay_date) === payDate) || null;
    }
    function openRun(source){
      const modalKit = window.FirstMatePeople?.entityModal;
      if (!modalKit) return;
      let current = source;
      const live = () => {
        if (current.fromHistory) return arr(state.data.batches).find((batch) => batch.id === current.batch.id) ? { batch:arr(state.data.batches).find((batch) => batch.id === current.batch.id), fromHistory:true } : current;
        const occurrence = findOccurrence(current.key);
        return occurrence ? { key:current.key, occurrence, batch:occurrence.batch } : current;
      };
      const panels = {};
      const summaryModel = () => {
        const { occurrence, batch } = current;
        const status = runStatus(occurrence, batch);
        const currency = clean(batch?.currency || occurrence?.schedule?.currency || 'USD');
        const lines = runLines(current);
        const total = lines.reduce((sum, line) => sum + line.net, 0);
        const employees = lines.filter((line) => paidAs(line.payee) === t('employee', 'Employee'));
        return {
          kind:'pay_run', id:clean(batch?.id || current.key), name:dateLabel(batch?.pay_date || occurrence?.pay_date, { weekday:true, year:true }),
          secondary:clean(batch?.run_type) === 'off_cycle' ? t('off_cycle_run', 'Off-cycle pay run') : clean(occurrence?.schedule?.name) || (batch ? scheduleNameOf(batch) : t('pay_run', 'Pay run')),
          icon:'fa-money-check-dollar', pills:[{ label:status.label, tone:status.tone }],
          facts:[
            { icon:'fa-calendar', label:t('period', 'Period'), value:`${dateLabel(batch?.period_start || occurrence?.period_start)} \u2013 ${dateLabel(batch?.period_end || occurrence?.period_end)}` },
            ...(occurrence?.cutoff_at ? [{ icon:'fa-scissors', label:t('earnings_until', 'Earnings up to'), value:dateTimeLabel(occurrence.cutoff_at), tooltip:t('cutoff_tip', 'Earnings earned after this are paid on a later pay run.') }] : []),
            { icon:'fa-users', label:t('people', 'People'), value:String(lines.length) },
            { icon:'fa-user', label:t('employees', 'Employees'), value:money(employees.reduce((sum, line) => sum + line.net, 0), currency) },
            { icon:'fa-building', label:t('contractors', 'Contractors'), value:money(total - employees.reduce((sum, line) => sum + line.net, 0), currency) },
            { icon:'fa-sack-dollar', label:t('to_pay', 'To pay'), value:money(total, currency) },
            ...(!batch && num(occurrence?.projected_additional_cents) ? [{ icon:'fa-chart-line', label:t('projected_on_top', 'Projected on top'), value:money(occurrence.projected_additional_cents, currency), tooltip:t('projected_more_tip', 'Forecast earnings posted to the ledger that are not earned yet. They are not paid until they are.') }] : [])
          ]
        };
      };
      const tabs = [
        { id:'people', label:t('people', 'People'), icon:'fa-users', needs:null, mount(panel){ panels.people = panel; drawPeople(panel); return { show(){ drawPeople(panel); } }; } },
        ...(can('runs.export') ? [{ id:'export', label:t('copy_out', 'Copy out'), icon:'fa-file-export', needs:null, tooltip:t('copy_out_tip', 'Files for Gusto, QuickBooks Payroll or your bookkeeper.'), mount(panel){ panels.export = panel; drawExport(panel); return { show(){ drawExport(panel); } }; } }] : []),
        { id:'approval', label:t('approval', 'Approval'), icon:'fa-signature', needs:null, mount(panel){ panels.approval = panel; drawApproval(panel); return { show(){ drawApproval(panel); } }; } }
      ];
      const modal = modalKit.open({
        label:t('pay_run', 'Pay run'), footer:false, tabs, tab:'people',
        summary(host){ host.innerHTML = kit().summary(summaryModel(), 'panel'); },
        actions:() => [],
        onClose(){ openModal = null; }
      });
      openModal = { refresh(){ current = live(); modal.refreshSummary(); Object.entries(panels).forEach(([id, panel]) => ({ people:drawPeople, export:drawExport, approval:drawApproval })[id]?.(panel)); } };

      function drawPeople(panel){
        const { batch } = current;
        const currency = clean(batch?.currency || current.occurrence?.schedule?.currency || 'USD');
        const lines = runLines(current);
        const status = runStatus(current.occurrence, batch);
        const sections = [[t('employees', 'Employees'), lines.filter((line) => paidAs(line.payee) === t('employee', 'Employee'))], [t('contractors', 'Contractors'), lines.filter((line) => paidAs(line.payee) !== t('employee', 'Employee'))]];
        const markPaid = batch && (['approved', 'run', 'partial'].includes(status.key) || (status.key === 'draft' && obj(state.settings).approval_required === false)) && can('runs.done');
        const rows = sections.filter(([, list]) => list.length).flatMap(([label, list]) => [
          `<tr class="fmp-section"><td colspan="7">${esc(label)}</td></tr>`,
          ...list.sort((a, b) => payeeName(a.payee).localeCompare(payeeName(b.payee))).map((line) => `<tr>
            ${td(`${can('earnings.why') ? `<button type="button" class="fmp-link" data-why="${esc(payeeKey(line.payee))}" data-why-name="${esc(payeeName(line.payee))}">${esc(payeeName(line.payee))}</button>` : esc(payeeName(line.payee))}<br><small class="fmp-muted">${esc(line.kinds.map(([kind, cents]) => `${kindLabel(kind)} ${money(cents, currency)}`).join(' \u00b7 ') || paidAs(line.payee))}</small>`, t('person', 'Person'), 'lead')}
            ${td(esc(money(line.earned, currency)), t('earned', 'Earned'), 'num')}
            ${td(esc(money(line.reimbursement, currency)), t('reimbursements', 'Reimbursements'), 'num')}
            ${td(line.offCycle ? `<span${tip(t('already_paid_tip', 'Paid outside a pay run and taken off here.'))}>${esc(minus(line.offCycle, currency))}</span>` : '\u2014', t('already_paid', 'Already paid'), `num${line.offCycle ? ' neg' : ''}`)}
            ${td(line.clawback ? esc(minus(line.clawback, currency)) : '\u2014', t('taken_back', 'Taken back'), `num${line.clawback ? ' neg' : ''}`)}
            ${td(`<b>${esc(money(line.net, currency))}</b>`, t('to_pay', 'To pay'), 'num')}
            ${td(line.status === 'paid' ? pill(t('paid', 'Paid'), 'ok') : markPaid ? `<button type="button" class="pp-btn" data-item-paid="${esc(line.item.id)}">${esc(t('mark_paid', 'Mark paid'))}</button>` : '', '', 'act')}
          </tr>`)
        ]);
        panel.innerHTML = `${stepsHtml()}
          <div class="fmp-modal-section">${table([{ label:t('person', 'Person') }, { label:t('earned', 'Earned'), cls:'num' }, { label:t('reimbursements', 'Reimbursements'), cls:'num' }, { label:t('already_paid', 'Already paid'), cls:'num', tooltip:t('already_paid_col_tip', 'Payments recorded as made outside a pay run, taken off so nobody is paid twice.') }, { label:t('taken_back', 'Taken back'), cls:'num', tooltip:t('taken_back_tip', 'Clawbacks and corrections, limited by the pay schedule\u2019s clawback cap.') }, { label:t('to_pay', 'To pay'), cls:'num' }, { label:'', cls:'act' }], rows, { empty:t('nobody_in_run', 'Nobody is in this pay run yet.'), label:t('people', 'People') })}${hiddenNote(num(batch?.branch_view?.hidden_payee_count || current.occurrence?.branch_view?.hidden_payee_count))}</div>
          ${reimbursementsHtml(currency)}`;
      }
      function reimbursementsHtml(currency){
        const entries = arr(current.batch?.items).flatMap((item) => arr(item.entries).filter((entry) => clean(entry.kind) === 'reimbursement' && num(entry.allocation_cents) > 0).map((entry) => ({ ...entry, payee:item.payee })));
        if (!current.batch) return '';
        return `<div class="fmp-modal-section"><h3${tip(t('reimbursements_run_tip', 'Approved expense reimbursements paid with this run. They are shown on their own line in every file.'))}>${esc(t('reimbursements_in_run', 'Reimbursements in this pay run'))}</h3>${table([{ label:t('person', 'Person') }, { label:t('for', 'For') }, { label:t('amount', 'Amount'), cls:'num' }], entries.map((entry) => `<tr>${td(esc(payeeName(entry.payee)), t('person', 'Person'), 'lead')}${td(esc(clean(entry.description) || t('reimbursement', 'Reimbursement')), t('for', 'For'))}${td(esc(money(entry.allocation_cents, currency)), t('amount', 'Amount'), 'num')}</tr>`), { empty:t('no_reimbursements', 'No reimbursements are in this pay run.') })}</div>`;
      }
      function stepsHtml(){
        const { occurrence, batch } = current;
        const status = runStatus(occurrence, batch);
        const approval = obj(batch?.approval);
        const me = meOf();
        const named = arr(approval.requested_approvers);
        const decided = new Map(arr(approval.decisions).map((decision) => [clean(decision.user_id), decision]));
        const waitingFor = named.filter((person) => clean(decided.get(clean(person.user_id))?.decision) !== 'approved').map((person) => clean(person.name) || clean(person.user_id));
        const iAmNamed = named.some((person) => clean(person.user_id) === me) && !decided.has(me);
        // The organization's payroll setting: with approval off a pay run goes draft, entered, paid.
        const approvalOff = obj(state.settings).approval_required === false;
        const text = {
          none:t('step_none', 'Not drafted yet. Drafting works out everyone\u2019s earnings again and fixes who is in this pay run and what each is paid.'),
          draft:approvalOff ? t('step_draft_open', 'Check who is in it and what each is paid, copy it out to your payroll software, then mark it entered and, once people are paid, paid.') : t('step_draft', 'Check who is in it and what each is paid. Approve it yourself, or ask someone to approve it.'),
          pending:t('step_pending', 'Waiting for {names}.', { names:waitingFor.join(', ') || t('the_approvers', 'the approvers') }),
          rejected:t('step_rejected', 'Rejected{note}. Reopen it to fix what is wrong; it is worked out again.', { note:arr(approval.decisions).find((decision) => decision.decision === 'rejected')?.note ? `: \u201c${arr(approval.decisions).find((decision) => decision.decision === 'rejected').note}\u201d` : '' }),
          approved:t('step_approved', 'Approved. Copy it out to your payroll software, then mark it entered and, once people are paid, paid.'),
          run:t('step_run', 'Entered in your payroll software. Mark it paid once people are paid, or mark each person.'),
          partial:t('step_partial', 'Some people are marked paid. Mark the rest once they are paid.'),
          paid:t('step_paid', 'Paid {date}. A change to what anyone earned now comes out as a correction on a later pay run.', { date:dateLabel(batch?.paid_at) }),
          void:t('step_void', 'This pay run was voided. Its earnings are back in the next pay run.')
        }[status.key];
        const buttons = {
          none:[button('runs.draft', context, { label:t('draft_run', 'Draft pay run'), icon:'fa-file-pen', tone:'primary', attrs:'data-run-act="draft"' })],
          draft:approvalOff
            ? [button('runs.done', context, { label:t('mark_entered', 'Mark entered'), icon:'fa-file-import', attrs:'data-run-act="run"', tooltip:t('mark_entered_tip', 'You entered or imported it in your payroll software.') }), button('runs.done', context, { label:t('mark_all_paid', 'Mark all paid'), icon:'fa-circle-check', tone:'primary', attrs:'data-run-act="paid"' }), button('runs.ask', context, { label:t('ask_approval', 'Ask someone to approve'), icon:'fa-user-check', tone:'quiet', attrs:'data-run-act="ask"', tooltip:t('ask_optional_tip', 'Pay runs do not need approval here, but you can still ask someone.') }), button('runs.void', context, { label:t('void', 'Void'), icon:'fa-ban', tone:'quiet', attrs:'data-run-act="void"' })]
            : [button('runs.approve', context, { label:t('approve', 'Approve'), icon:'fa-check', tone:'primary', attrs:'data-run-act="approve-self"', tooltip:t('approve_self_tip', 'You approve it as the only approver.') }), button('runs.ask', context, { label:t('ask_approval', 'Ask someone to approve'), icon:'fa-user-check', attrs:'data-run-act="ask"' }), button('runs.void', context, { label:t('void', 'Void'), icon:'fa-ban', tone:'quiet', attrs:'data-run-act="void"' })],
          pending:[iAmNamed ? button('runs.decide', context, { label:t('approve', 'Approve'), icon:'fa-check', tone:'primary', attrs:'data-run-act="decide-approve"' }) : '', iAmNamed ? button('runs.decide', context, { label:t('reject', 'Reject'), icon:'fa-xmark', attrs:'data-run-act="decide-reject"' }) : '', button('runs.reopen', context, { label:t('reopen', 'Reopen'), icon:'fa-rotate-left', tone:'quiet', attrs:'data-run-act="reopen"' })],
          rejected:[button('runs.reopen', context, { label:t('reopen_fix', 'Reopen to fix'), icon:'fa-rotate-left', tone:'primary', attrs:'data-run-act="reopen"' }), button('runs.void', context, { label:t('void', 'Void'), icon:'fa-ban', tone:'quiet', attrs:'data-run-act="void"' })],
          approved:[button('runs.done', context, { label:t('mark_entered', 'Mark entered'), icon:'fa-file-import', attrs:'data-run-act="run"', tooltip:t('mark_entered_tip', 'You entered or imported it in your payroll software.') }), button('runs.done', context, { label:t('mark_all_paid', 'Mark all paid'), icon:'fa-circle-check', tone:'primary', attrs:'data-run-act="paid"' })],
          run:[button('runs.done', context, { label:t('mark_all_paid', 'Mark all paid'), icon:'fa-circle-check', tone:'primary', attrs:'data-run-act="paid"' })],
          partial:[button('runs.done', context, { label:t('mark_rest_paid', 'Mark the rest paid'), icon:'fa-circle-check', tone:'primary', attrs:'data-run-act="paid"' })],
          paid:[], void:[]
        }[status.key].filter(Boolean).join('');
        return `<div class="fmp-steps" data-run-steps="${esc(status.key)}"><p>${esc(text)}</p>${buttons ? `<div class="fmp-steps-actions">${buttons}</div>` : ''}</div>`;
      }
      function drawExport(panel){
        const batch = current.batch;
        const catalog = arr(state.data.catalog).length ? arr(state.data.catalog) : null;
        const files = catalog ? catalog.filter((entry) => entry.group === 'pay_run_file') : PAY_RUN_FILES;
        panel.innerHTML = `<div class="fmp-modal-section"><h3${tip(t('copy_out_long', 'The platform does not move money. Copy each pay run into your payroll software with these files, then mark it entered and paid here. Employees and contractors are in separate files, earnings are by kind and reimbursements have their own line.'))}>${esc(t('files_for_run', 'Files for this pay run'))}${info(t('copy_out_long', 'The platform does not move money. Copy each pay run into your payroll software with these files, then mark it entered and paid here. Employees and contractors are in separate files, earnings are by kind and reimbursements have their own line.'))}</h3>
          ${batch && runStatus(current.occurrence, batch).key !== 'void' ? `<div class="fmp-files">${files.map((file) => `<div class="fmp-file" data-file="${esc(file.type)}"><i class="fas ${esc(file.type.startsWith('gusto') ? 'fa-g' : file.type.startsWith('quickbooks') ? 'fa-q' : 'fa-list')}" aria-hidden="true"></i><div><span class="fmp-titled"><strong${tip(`${file.description} ${file.purpose || ''}`)}>${esc(file.label)}</strong>${info(`${file.description} ${file.purpose || ''}`)}</span></div>${arr(file.formats).map((format) => `<button type="button" class="pp-btn" data-export="${esc(file.type)}" data-format="${esc(format)}"><i class="fas fa-download" aria-hidden="true"></i>${esc(format.toUpperCase())}</button>`).join('')}</div>`).join('')}</div>`
            : `<div class="fmp-empty">${esc(t('draft_first', 'Draft the pay run first: the files are made from what it fixes.'))}</div>`}</div>`;
      }
      function drawApproval(panel){
        const approval = obj(current.batch?.approval);
        const named = arr(approval.requested_approvers);
        const decisions = new Map(arr(approval.decisions).map((decision) => [clean(decision.user_id), decision]));
        panel.innerHTML = `<div class="fmp-modal-section"><h3>${esc(t('approvers', 'Approvers'))}</h3>${table([{ label:t('person', 'Person') }, { label:t('decision', 'Decision') }, { label:t('when', 'When') }, { label:t('note', 'Note') }], named.map((person) => { const decision = decisions.get(clean(person.user_id)); return `<tr>${td(esc(clean(person.name) || person.user_id), t('person', 'Person'), 'lead')}${td(decision ? pill(decision.decision === 'approved' ? t('approved', 'Approved') : t('rejected', 'Rejected'), decision.decision === 'approved' ? 'ok' : 'danger') : pill(t('waiting', 'Waiting'), 'warn'), t('decision', 'Decision'))}${td(esc(dateTimeLabel(decision?.decided_at)), t('when', 'When'))}${td(esc(clean(decision?.note)), t('note', 'Note'))}</tr>`; }), { empty:current.batch ? t('no_approvers', 'Nobody has been asked to approve this pay run yet.') : t('draft_first_approval', 'Draft the pay run first.') })}
          ${approval.submitted_at ? `<p class="fmp-muted">${esc(t('asked_by', 'Asked by {name} {when}.', { name:clean(obj(approval.submitted_by).name) || t('someone', 'Someone'), when:dateTimeLabel(approval.submitted_at) }))}</p>` : ''}
          ${approval.finalized_at ? `<p class="fmp-muted">${esc(t('finalized_by', 'Made final by {name} {when}.', { name:clean(obj(approval.finalized_by).name) || t('someone', 'Someone'), when:dateTimeLabel(approval.finalized_at) }))}</p>` : ''}</div>`;
      }
      modal.el.addEventListener('click', async (event) => {
        const why = event.target.closest('[data-why]');
        if (why) { openWhy({ type:why.dataset.why.split(':')[0], id:why.dataset.why.split(':').slice(1).join(':'), name:why.dataset.whyName }, why); return; }
        const exportButton = event.target.closest('[data-export]');
        if (exportButton && current.batch) {
          await perform(t('file_ready', 'The file is downloading.'), async () => {
            const artifact = await window.PayrollAPI.artifacts.create(state.orgId, { type:exportButton.dataset.export, format:exportButton.dataset.format, batch_id:current.batch.id, ...branchArgs() });
            download(artifact.artifact?.download_url || window.PayrollAPI.artifacts.downloadUrl(state.orgId, artifact.artifact?.id));
          });
          return;
        }
        const itemPaid = event.target.closest('[data-item-paid]');
        if (itemPaid) { await markPaid(itemPaid, itemPaid.dataset.itemPaid); return; }
        const act = event.target.closest('[data-run-act]');
        if (act) await runAction(act.dataset.runAct, act);
      });
      async function markPaid(anchor, itemId){
        const values = await kit().form(anchor, { title:itemId ? t('mark_person_paid', 'Mark paid') : t('mark_all_paid', 'Mark all paid'), submitLabel:t('mark_paid', 'Mark paid'), fields:[{ id:'reference', label:t('payment_reference', 'Payment reference (optional)'), placeholder:'' }] });
        if (!values) return;
        const batchId = current.batch.id;
        await perform(t('marked_paid', 'Marked paid'), async () => {
          if (clean(obj(current.batch.approval).status) === 'approved') await window.PayrollAPI.batches.action(state.orgId, batchId, 'finalize');
          if (itemId) return window.PayrollAPI.batches.updateItem(state.orgId, batchId, itemId, { status:'paid', ...(values.reference ? { payment_reference:values.reference } : {}) });
          return window.PayrollAPI.batches.action(state.orgId, batchId, 'paid', { payment_reference:values.reference });
        }, t('marked_paid', 'Marked paid'));
      }
      async function runAction(action, anchor){
        const api = window.PayrollAPI, batch = current.batch, occurrence = current.occurrence;
        if (action === 'draft') {
          const result = await perform(t('drafted', 'Pay run drafted'), () => api.batches.create(state.orgId, { schedule_id:occurrence.schedule.id, pay_date:occurrence.pay_date }), t('drafted', 'Pay run drafted'));
          const unresolved = num(result?.earnings_refresh?.unresolved_count);
          if (unresolved) toast(t('some_not_worked_out', 'Some earnings could not be worked out'), t('see_review', '{count} are listed under Review. They are not paid as zero.', { count:unresolved }), false);
          return;
        }
        if (action === 'approve-self') {
          const me = meOf();
          await perform(t('approved_note', 'Approved'), async () => {
            await api.batches.action(state.orgId, batch.id, 'submit_approval', { approvers:[{ user_id:me }] });
            await api.batches.action(state.orgId, batch.id, 'approve');
            return api.batches.action(state.orgId, batch.id, 'finalize');
          }, t('approved_note', 'Approved'));
          return;
        }
        if (action === 'ask') {
          if (!state.directory) state.directory = await api.published.read(state.orgId, 'directory').catch(() => ({ users:[] }));
          const people = arr(state.directory.users).filter((user) => clean(user.id));
          const values = await kit().form(anchor, { title:t('ask_approval', 'Ask someone to approve'), submitLabel:t('ask', 'Ask'), choices:{ id:'approvers', label:t('who_approves', 'Who approves'), items:people.map((user) => ({ id:user.id, label:clean(user.name) || user.id })), value:[], min:1 } });
          if (!values) return;
          await perform(t('asked', 'Asked for approval'), () => api.batches.action(state.orgId, batch.id, 'submit_approval', { approvers:values.approvers.map((user_id) => ({ user_id })) }), t('asked', 'Asked for approval'));
          return;
        }
        if (action === 'decide-approve' || action === 'decide-reject') {
          const reject = action === 'decide-reject';
          const values = reject ? await kit().form(anchor, { title:t('reject_run', 'Reject this pay run'), submitLabel:t('reject', 'Reject'), fields:[{ id:'note', label:t('what_is_wrong', 'What is wrong'), required:true }] }) : {};
          if (!values) return;
          await perform(reject ? t('rejected', 'Rejected') : t('approved_note', 'Approved'), async () => {
            await api.approvals.decide(state.orgId, batch.id, reject ? 'reject' : 'approve', values.note || '');
            if (!reject) {
              const fresh = await api.batches.get(state.orgId, batch.id).catch(() => null);
              if (clean(fresh?.batch?.approval?.status) === 'approved') await api.batches.action(state.orgId, batch.id, 'finalize');
            }
          }, reject ? t('rejected', 'Rejected') : t('approved_note', 'Approved'));
          return;
        }
        if (action === 'reopen') {
          if (!await kit().confirm(anchor, { title:t('reopen_confirm', 'Reopen this pay run? It is worked out again from current earnings and needs approving again.'), confirmLabel:t('reopen', 'Reopen') })) return;
          await perform(t('reopened', 'Reopened'), () => api.batches.action(state.orgId, batch.id, 'reopen', { note:t('reopened_note', 'Reopened to fix') }), t('reopened', 'Reopened'));
          return;
        }
        if (action === 'void') {
          if (!await kit().confirm(anchor, { title:t('void_confirm', 'Void this pay run? Its earnings go back to the next pay run.'), confirmLabel:t('void', 'Void'), tone:'danger' })) return;
          await perform(t('voided', 'Voided'), () => api.batches.action(state.orgId, batch.id, 'void'), t('voided', 'Voided'));
          return;
        }
        if (action === 'run') {
          await perform(t('entered', 'Entered'), async () => {
            if (clean(obj(batch.approval).status) === 'approved') await api.batches.action(state.orgId, batch.id, 'finalize');
            return api.batches.action(state.orgId, batch.id, 'run');
          }, t('marked_entered', 'Marked entered'));
          return;
        }
        if (action === 'paid') await markPaid(anchor, '');
      }
    }
    function runLines(source){
      if (source.batch) return arr(source.batch.items).map((item) => lineOf(item, false));
      const occurrence = obj(source.occurrence);
      return [...arr(occurrence.employees), ...arr(occurrence.subcontractors)].map((item) => lineOf(item, true));
    }

    // -- Why someone is paid what they are --
    async function openWhy(payee, opener){
      const modalKit = window.FirstMatePeople?.entityModal;
      if (!modalKit || !can('earnings.why')) return;
      const api = window.PayrollAPI;
      const data = { loading:true };
      const panels = {};
      const modal = modalKit.open({
        label:t('why_paid', 'Why {name} is paid what they are', { name:payeeName(payee) }), opener, footer:false, tab:'paid_by',
        summary(host){
          const report = obj(data.earnings);
          const totals = obj(report.totals);
          const currency = clean(report.currency || 'USD');
          const schedule = arr(data.setup?.schedule_today).find((row) => row.earning_kind === '*');
          host.innerHTML = kit().summary({
            kind:clean(payee.type), id:clean(payee.id), name:payeeName(payee), secondary:PAYEE_TYPES[clean(payee.type)] || '',
            facts:[
              { icon:'fa-sack-dollar', label:t('owed', 'Owed'), value:data.loading ? '\u2026' : money(totals.owed_cents, currency), tooltip:t('owed_tip', 'Earned and not paid yet, after anything paid outside a pay run.') },
              { icon:'fa-money-check-dollar', label:t('in_a_run', 'In a pay run'), value:data.loading ? '\u2026' : money(totals.in_payroll_cents, currency) },
              { icon:'fa-circle-check', label:t('paid', 'Paid'), value:data.loading ? '\u2026' : money(totals.paid_cents, currency) },
              ...(data.projected ? [{ icon:'fa-chart-line', label:t('projected', 'Projected'), value:money(data.projected.total_cents, currency), tooltip:t('projected_tip', 'What their pay rules say they can expect from work not done yet. Never paid until earned.') }] : []),
              { icon:'fa-calendar-days', label:t('paid_on', 'Paid on'), value:clean(schedule?.schedule_name) || (data.loading ? '\u2026' : t('no_schedule', 'No schedule')) }
            ]
          }, 'panel');
        },
        tabs:[
          { id:'paid_by', label:t('paid_by', 'Paid by'), icon:'fa-scale-balanced', needs:null, mount(panel){ panels.paid_by = panel; draw(); return {}; } },
          { id:'results', label:t('worked_out', 'Worked out'), icon:'fa-calculator', needs:null, mount(panel){ panels.results = panel; draw(); return {}; } },
          { id:'ledger', label:t('ledger', 'Ledger'), icon:'fa-receipt', needs:null, mount(panel){ panels.ledger = panel; draw(); return {}; } },
          ...(can('earnings.projected') ? [{ id:'projected', label:t('projected', 'Projected'), icon:'fa-chart-line', needs:null, mount(panel){ panels.projected = panel; draw(); return {}; } }] : []),
          { id:'payments', label:t('payments', 'Payments'), icon:'fa-clock-rotate-left', needs:null, mount(panel){ panels.payments = panel; draw(); return {}; } }
        ]
      });
      function ruleName(id){ return clean(arr(data.rules).find((rule) => rule.id === id)?.name) || clean(id).replace(/_/g, ' '); }
      function originLabel(origin){
        if (!origin) return t('own_setup', 'Their own setup');
        const name = clean(origin.name) || clean(origin.id);
        return ({ organization:t('everyone', 'Everyone'), role:t('role_default', '{name} role', { name }), group_type:t('group_type_default', '{name} groups', { name }), company_type:t('company_type_default', '{name} companies', { name }) })[clean(origin.type)] || name;
      }
      function draw(){
        const currency = clean(data.earnings?.currency || 'USD');
        const loading = `<div class="fmp-state">${esc(t('loading', 'Loading\u2026'))}</div>`;
        if (panels.paid_by) {
          const setup = obj(data.setup);
          const distribution = obj(setup.distribution_today);
          const split = clean(payee.type) === 'resource_group' ? (clean(distribution.mode) === 'split'
            ? (clean(distribution.method) === 'rule' ? t('split_rule', 'What the group earns is divided among its members by a split rule.') : clean(distribution.method) === 'shares' ? t('split_shares', 'What the group earns is divided among its members by fixed shares.') : t('split_equal', 'What the group earns is divided equally among its members.'))
            : t('as_one', 'The group is paid as one payee.')) : '';
          panels.paid_by.innerHTML = data.loading ? loading : `
            <div class="fmp-modal-section"><h3${tip(t('rules_tip', 'The pay rules in effect today and the layer each comes from. Change how someone is paid in People, Compensation.'))}>${esc(t('pay_rules_today', 'Pay rules in effect today'))}${info(t('rules_tip', 'The pay rules in effect today and the layer each comes from. Change how someone is paid in People, Compensation.'))}</h3>
              ${table([{ label:t('rule', 'Rule') }, { label:t('from', 'From') }, { label:t('settings_used', 'Settings used') }], arr(setup.effective).map((slot) => `<tr>${td(esc(ruleName(slot.rule_id)), t('rule', 'Rule'), 'lead')}${td(esc(originLabel(slot.origin)) + (slot.changed_above ? ` ${pill(t('changed_for_them', 'Changed for them'), 'role')}` : ''), t('from', 'From'))}${td(esc(Object.entries(obj(slot.params)).map(([key, value]) => `${key.replace(/_(cents|bps)$/, '').replace(/_/g, ' ')} ${/_cents$/.test(key) ? money(value, currency) : /_bps$/.test(key) ? `${num(value) / 100}%` : value}`).join(', ') || '\u2014'), t('settings_used', 'Settings used'))}</tr>`), { empty:t('no_rules', 'No pay rule is in effect for them today. Set how they are paid in People, Compensation.') })}
              ${split ? `<p class="fmp-muted">${esc(split)}</p>` : ''}</div>
            <div class="fmp-modal-section"><h3>${esc(t('when_paid', 'When they are paid'))}</h3>
              ${table([{ label:t('earnings', 'Earnings') }, { label:t('schedule', 'Schedule') }, { label:t('chosen_by', 'Chosen by') }], arr(setup.schedule_today).map((row) => `<tr>${td(esc(row.earning_kind === '*' ? t('everything', 'Everything') : kindLabel(row.earning_kind)), t('earnings', 'Earnings'), 'lead')}${td(nameCell(clean(row.schedule_name) || t('missing_schedule', 'A schedule that no longer exists'), [clean(row.timing_basis) ? (clean(row.timing_basis) === 'completed' ? t('when_completed', 'recognized when the job is completed') : t('when_worked', 'recognized when the work is done')) : '', row.clawback_cap_percent === null || row.clawback_cap_percent === undefined ? '' : t('cap', 'clawbacks capped at {percent}% of a check', { percent:num(row.clawback_cap_percent) })].filter(Boolean).join(' \u00b7 ')), t('schedule', 'Schedule'))}${td(esc(originLabel(row.origin)), t('chosen_by', 'Chosen by'))}</tr>`), { empty:t('no_schedule_chosen', 'No pay schedule is chosen for them. Choose the company\u2019s schedule in Settings.') })}</div>`;
        }
        if (panels.results) {
          const units = arr(data.units);
          panels.results.innerHTML = data.loading ? loading : `<div class="fmp-modal-section"><h3${tip(t('results_tip', 'What each pay rule last worked out, one row per record or period it pays. Something that could not be worked out is never paid as zero.'))}>${esc(t('what_rules_worked_out', 'What each rule worked out'))}</h3>
            ${table([{ label:t('rule', 'Rule') }, { label:t('earned_on', 'Earned on') }, { label:t('result', 'Result') }, { label:t('amount', 'Amount'), cls:'num' }], units.slice(0, 200).map((unit) => { const total = arr(unit.lines).reduce((sum, line) => sum + num(line.amount_cents), 0); const failed = unit.status === 'error'; return `<tr>${td(nameCell(ruleName(unit.rule_id), arr(unit.lines).map((line) => clean(line.description)).filter(Boolean).join(', ')), t('rule', 'Rule'), 'lead')}${td(esc(dateLabel(unit.earned_at)), t('earned_on', 'Earned on'))}${td(failed ? `<span class="fmp-reason">${esc(clean(unit.error) || t('could_not', 'Could not be worked out'))}</span>` : unit.status === 'withdrawn' ? pill(t('taken_back', 'Taken back'), 'muted') : pill(t('worked_out', 'Worked out'), 'ok'), t('result', 'Result'))}${td(failed ? '\u2014' : esc(money(total, currency)), t('amount', 'Amount'), 'num')}</tr>`; }), { empty:t('no_results', 'No pay rule has worked out anything for them yet. Refresh earnings once they have a pay setup.') })}</div>`;
        }
        if (panels.ledger) {
          const entries = arr(data.ledger).slice().sort((a, b) => clean(b.created_at).localeCompare(clean(a.created_at)));
          const stateLabel = (entry) => entry.state === 'void' ? t('void', 'Void') : entry.state === 'projected' ? (entry.metadata?.review_required ? t('held', 'Held for review') : t('projected', 'Projected')) : num(entry.remaining_cents) === 0 ? t('in_a_run', 'In a pay run') : num(entry.applied_cents) ? t('partly_in_run', 'Partly in a pay run') : t('waiting_run', 'Waiting for a pay run');
          panels.ledger.innerHTML = data.loading ? loading : `<div class="fmp-modal-section"><h3${tip(t('ledger_tip', 'Every earning posted for them. Nothing posted is ever edited: a change is a new entry.'))}>${esc(t('ledger_entries', 'Ledger entries'))}</h3>
            ${table([{ label:t('earning', 'Earning') }, { label:t('kind', 'Kind') }, { label:t('state', 'State') }, { label:t('amount', 'Amount'), cls:'num' }], entries.slice(0, 200).map((entry) => `<tr>${td(nameCell(clean(entry.description) || kindLabel(entry.kind), [clean(entry.project_title), dateLabel(entry.metadata?.pay_rule?.earned_on || entry.eligible_at), entry.metadata?.split?.of ? t('share_of', 'their share of {amount}, split {count} ways', { amount:money(entry.metadata.split.line_cents, entry.currency), count:num(entry.metadata.split.members) }) : '', entry.metadata?.correction ? t('correction_of', 'correction: {before} before, {now} now', { before:money(entry.metadata.correction.posted_cents, entry.currency), now:money(entry.metadata.correction.target_cents, entry.currency) }) : ''].filter(Boolean).join(' \u00b7 ')), t('earning', 'Earning'), 'lead')}${td(esc(entry.subgroup === 'off_cycle' ? t('paid_outside', 'Paid outside a pay run') : kindLabel(entry.kind)), t('kind', 'Kind'))}${td(esc(stateLabel(entry)), t('state', 'State'))}${td(esc(num(entry.amount_cents) < 0 ? minus(entry.amount_cents, entry.currency) : money(entry.amount_cents, entry.currency)), t('amount', 'Amount'), `num${num(entry.amount_cents) < 0 ? ' neg' : ''}`)}</tr>`), { empty:t('no_entries', 'Nothing has been posted for them.') })}</div>`;
        }
        if (panels.projected) {
          const projected = obj(data.projected);
          panels.projected.innerHTML = data.loading ? loading : `<div class="fmp-modal-section"><h3${tip(t('projected_tip', 'What their pay rules say they can expect from work not done yet. Never paid until earned.'))}>${esc(t('projected', 'Projected'))}</h3>
            ${table([{ label:t('work', 'Work') }, { label:t('expected', 'Expected') }, { label:t('amount', 'Amount'), cls:'num' }], [...arr(projected.earnings).map((earning) => `<tr>${td(nameCell(clean(earning.project_title) || clean(earning.record_title) || t('projected', 'Projected'), clean(earning.description)), t('work', 'Work'), 'lead')}${td(esc(earning.expected_on ? dateLabel(earning.expected_on) : t('not_scheduled', 'Not scheduled')), t('expected', 'Expected'))}${td(esc(money(earning.amount_cents, currency)), t('amount', 'Amount'), 'num')}</tr>`), ...arr(projected.unresolved).map((entry) => `<tr>${td(nameCell(clean(entry.project_title) || ruleName(entry.rule_id), clean(entry.reason)), t('work', 'Work'), 'lead')}${td(esc(entry.expected_on ? dateLabel(entry.expected_on) : t('not_scheduled', 'Not scheduled')), t('expected', 'Expected'))}${td('\u2014', t('amount', 'Amount'), 'num')}</tr>`)], { empty:t('nothing_projected', 'Nothing is projected for them.') })}</div>`;
        }
        if (panels.payments) {
          const report = obj(data.earnings);
          panels.payments.innerHTML = data.loading ? loading : paymentsHtml(report);
        }
      }
      const [setup, units, ledger, earnings, projected, rules] = await Promise.all([
        api.pay.setup(state.orgId, payee).catch(() => null),
        api.pay.units(state.orgId, payee).catch(() => []),
        api.ledger.list(state.orgId, { payee_type:payee.type, payee_id:payee.id, limit:1000 }).then((result) => result.entries).catch(() => []),
        api.earnings.forPayee(state.orgId, payee.type, payee.id, { payment_limit:50 }).then((result) => (Array.isArray(result.earnings) ? result.earnings[0] : result.earnings)).catch(() => null),
        can('earnings.projected') ? api.pay.projected(state.orgId, payee).catch(() => null) : null,
        state.rules ? Promise.resolve(state.rules) : api.pay.rules(state.orgId).catch(() => [])
      ]);
      Object.assign(data, { setup, units, ledger, earnings, projected, rules, loading:false });
      state.rules = rules;
      modal.refreshSummary();
      draw();
    }
    function paymentsTable(report){
      const currency = clean(report.currency || 'USD');
      const statusLabel = { paid:t('paid', 'Paid'), run:t('entered', 'Entered, not paid'), draft:t('in_a_run', 'In a pay run') };
      return table([{ label:t('pay_date', 'Pay date') }, { label:t('schedule', 'Schedule') }, { label:t('status', 'Status') }, { label:t('amount', 'Amount'), cls:'num' }], arr(report.payments).map((payment) => `<tr>${td(esc(dateLabel(payment.pay_date)), t('pay_date', 'Pay date'), 'lead')}${td(esc(clean(payment.schedule?.name)), t('schedule', 'Schedule'))}${td(pill(statusLabel[payment.status] || payment.status, payment.status === 'paid' ? 'ok' : 'neutral'), t('status', 'Status'))}${td(esc(money(payment.net_cents, payment.currency || currency)), t('amount', 'Amount'), 'num')}</tr>`), { empty:t('no_payments', 'No pay run has paid anything yet.') });
    }
    function outsideTable(report){
      const currency = clean(report.currency || 'USD');
      return table([{ label:t('paid_on', 'Paid on') }, { label:t('kind', 'Kind') }, { label:t('reference', 'Reference') }, { label:t('amount', 'Amount'), cls:'num' }], arr(report.off_cycle_payments).map((payment) => `<tr>${td(esc(dateLabel(payment.paid_on)), t('paid_on', 'Paid on'), 'lead')}${td(esc(kindLabel(payment.kind)), t('kind', 'Kind'))}${td(esc(clean(payment.reference) || '\u2014'), t('reference', 'Reference'))}${td(esc(money(payment.amount_cents, payment.currency || currency)), t('amount', 'Amount'), 'num')}</tr>`), { empty:t('none_outside', 'Nothing has been paid outside a pay run.') });
    }
    function paymentsHtml(report){
      return `<div class="fmp-modal-section"><h3>${esc(t('pay_runs', 'Pay runs'))}</h3>${paymentsTable(report)}</div>
        <div class="fmp-modal-section"><h3${tip(t('paid_outside_tip', 'Payments made outside a pay run. The next pay run takes each off, so nothing is paid twice.'))}>${esc(t('paid_outside', 'Paid outside a pay run'))}</h3>${outsideTable(report)}</div>`;
    }

    // -- Review --
    function reviewView(){
      const review = obj(state.data.review);
      const currency = 'USD';
      const unresolved = arr(state.data.unresolved);
      const held = arr(review.held);
      const offCycle = arr(review.off_cycle);
      const payments = arr(state.data.offCycle);
      const finalized = arr(state.data.finalized);
      const reimbursements = arr(state.data.reimbursements?.entries);
      state.rules = arr(state.data.rules).length ? state.data.rules : state.rules;
      const ruleName = (id) => clean(arr(state.rules).find((rule) => rule.id === id)?.name) || clean(id).replace(/_/g, ' ');
      const whyButton = (payee) => can('earnings.why') ? `<button type="button" class="fmp-link" data-why="${esc(payeeKey(payee))}" data-why-name="${esc(payeeName(payee))}">${esc(payeeName(payee))}</button>` : esc(payeeName(payee));
      const errorNote = (key) => state.errors[key] ? `<div class="fmp-note fmp-reason">${esc(state.errors[key])}</div>` : '';
      const waitingWork = finalized.filter((row) => row.pay_state !== 'in_pay_run');
      return `
        ${card({ id:'unresolved', title:t('could_not_work_out', 'Could not be worked out'), tooltip:t('unresolved_tip', 'Earnings a pay rule could not work out at the last refresh. They are not paid as zero: whatever was posted before stays until each is fixed and earnings are refreshed.'), count:unresolved.length,
          actions:button('earnings.refresh', context, { label:t('try_again', 'Refresh earnings'), icon:'fa-rotate', attrs:'data-act="refresh-earnings"' }),
          body:table([{ label:t('person', 'Person') }, { label:t('rule', 'Rule') }, { label:t('why', 'Why') }], unresolved.map((item) => `<tr>${td(whyButton({ ...item.payee, name:item.payee_name }), t('person', 'Person'), 'lead')}${td(nameCell(ruleName(item.rule_id), item.whole_rule ? t('whole_rule', 'The whole rule') : dateLabel(item.earned_at)), t('rule', 'Rule'))}${td(`<span class="fmp-reason">${esc(item.reason)}</span>`, t('why', 'Why'))}</tr>`), { empty:t('all_worked_out', 'Every earning was worked out.') }) + errorNote('unresolved') })}
        ${card({ id:'held', title:t('held_corrections', 'Corrections held for review'), tooltip:t('held_tip', 'A rule now works out a different amount for something already in a pay run. Accept to count it in the next pay run, or decline to leave what was paid as it is; a declined correction is not raised again.'), count:held.length,
          body:table([{ label:t('person', 'Person') }, { label:t('what', 'What') }, { label:t('before_now', 'Before \u2192 now'), cls:'num' }, { label:t('difference', 'Difference'), cls:'num' }, { label:'', cls:'act' }], held.map((entry) => { const correction = obj(entry.metadata?.correction); return `<tr>${td(whyButton(entry.payee), t('person', 'Person'), 'lead')}${td(nameCell(clean(entry.description) || kindLabel(entry.kind), ruleName(entry.metadata?.pay_rule?.rule_id)), t('what', 'What'))}${td(esc(`${money(correction.posted_cents, entry.currency)} \u2192 ${money(correction.target_cents, entry.currency)}`), t('before_now', 'Before \u2192 now'), 'num')}${td(esc(num(entry.amount_cents) < 0 ? minus(entry.amount_cents, entry.currency) : `+${money(entry.amount_cents, entry.currency)}`), t('difference', 'Difference'), `num${num(entry.amount_cents) < 0 ? ' neg' : ''}`)}${td(`${button('review.accept', context, { label:t('accept', 'Accept'), attrs:`data-accept="${esc(entry.id)}"` })}${button('review.decline', context, { label:t('decline', 'Decline'), tone:'quiet', attrs:`data-decline="${esc(entry.id)}"` })}`, '', 'act')}</tr>`; }), { empty:t('none_held', 'No corrections are waiting for review.') }) })}
        ${card({ id:'back-pay', title:t('back_pay_offcycle', 'Back pay asked to be paid off-cycle'), tooltip:t('back_pay_tip', 'Corrections for periods already paid whose pay schedule asks for them to be paid outside the normal run. If you pay one outside a pay run, record it: the next pay run then takes it off. Otherwise it is paid on the next pay run.'), count:offCycle.length,
          body:table([{ label:t('person', 'Person') }, { label:t('what', 'What') }, { label:t('amount', 'Amount'), cls:'num' }, { label:'', cls:'act' }], offCycle.map((entry) => `<tr>${td(whyButton(entry.payee), t('person', 'Person'), 'lead')}${td(nameCell(clean(entry.description) || kindLabel(entry.kind), dateLabel(entry.eligible_at)), t('what', 'What'))}${td(esc(money(entry.remaining_cents, entry.currency)), t('amount', 'Amount'), 'num')}${td(button('offcycle.record', context, { label:t('record_paid', 'Record as paid'), attrs:`data-record-for="${esc(payeeKey(entry.payee))}" data-record-kind="${esc(entry.kind)}" data-record-cents="${esc(num(entry.remaining_cents))}"` }), '', 'act')}</tr>`), { empty:t('no_back_pay', 'No back pay is waiting for an off-cycle payment.') }) })}
        ${card({ id:'offcycle', title:t('paid_outside', 'Paid outside a pay run'), tooltip:t('offcycle_tip', 'Payments made outside the normal pay run, recorded against the person and the kind of earning. The next pay run on that kind\u2019s schedule takes each off what it pays them, in full up to what it pays; the rest waits for the run after. Nothing already posted is changed.'), count:payments.length,
          actions:button('offcycle.record', context, { label:t('record_payment_short', 'Record a payment'), icon:'fa-plus', attrs:'data-act="record-offcycle"' }),
          body:table([{ label:t('person', 'Person') }, { label:t('paid_on', 'Paid on') }, { label:t('reference', 'Reference') }, { label:t('amount', 'Amount'), cls:'num' }, { label:t('taken_off', 'Taken off'), cls:'num', tooltip:t('taken_off_tip', 'How much pay runs have taken off so far.') }, { label:t('still_to_take_off', 'Still to take off'), cls:'num' }, { label:'', cls:'act' }], payments.map((row) => `<tr>${td(nameCell(payeeName(row.payee), kindLabel(row.kind)), t('person', 'Person'), 'lead')}${td(esc(dateLabel(row.paid_on)), t('paid_on', 'Paid on'))}${td(esc(clean(row.reference) || '\u2014') + (row.note ? ` <span class="fmp-muted"${tip(row.note)}><i class="fas fa-note-sticky"></i></span>` : ''), t('reference', 'Reference'))}${td(esc(money(row.amount_cents, row.currency)), t('amount', 'Amount'), 'num')}${td(esc(money(row.subtracted_cents, row.currency)), t('taken_off', 'Taken off'), 'num')}${td(esc(money(row.waiting_cents, row.currency)), t('still_to_take_off', 'Still to take off'), 'num')}${td(row.status === 'waiting' ? button('offcycle.remove', context, { label:t('remove', 'Remove'), tone:'quiet', attrs:`data-remove-offcycle="${esc(row.id)}"`, tooltip:t('remove_tip', 'Remove a payment recorded by mistake. Only possible before a pay run takes it off.') }) : pill(row.status === 'subtracted' ? t('taken_off_all', 'Taken off') : t('partly', 'Partly taken off'), row.status === 'subtracted' ? 'ok' : 'warn'), '', 'act')}</tr>`), { empty:t('none_outside', 'Nothing has been paid outside a pay run.') }) + errorNote('offCycle') })}
        ${card({ id:'finalized', title:t('work_to_pay', 'Work orders finalized to be paid'), tooltip:t('work_to_pay_tip', 'Labor lists confirmed as done and marked to be paid at closeout, with the earnings they produced. Not earned yet means earnings have not been refreshed since, or the assignee is not paid by a rule that reads committed labor.'), count:waitingWork.length,
          body:table([{ label:t('work_order', 'Work order') }, { label:t('assignee', 'Assignee') }, { label:t('finalized', 'Finalized') }, { label:t('amount', 'Amount'), cls:'num' }, { label:t('earnings', 'Earnings') }], waitingWork.map((row) => `<tr>${td(nameCell(clean(row.list_title) || t('labor', 'Labor'), clean(row.project_title)), t('work_order', 'Work order'), 'lead')}${td(esc(payeeName(row.assignee)), t('assignee', 'Assignee'))}${td(esc(dateLabel(row.finalized_at)), t('finalized', 'Finalized'))}${td(esc(money(row.total_cents)), t('amount', 'Amount'), 'num')}${td(row.pay_state === 'not_earned' ? pill(t('not_earned', 'Not earned yet'), 'warn') : `${pill(t('earned_waiting', 'Earned, waiting for a pay run'), 'ok')} <span class="fmp-muted">${esc(row.earnings.map((entry) => `${payeeName(entry.payee)} ${money(entry.amount_cents)}`).join(', '))}</span>`, t('earnings', 'Earnings'))}</tr>`), { empty:t('no_work_waiting', 'Every finalized work order is in a pay run.') }) + (finalized.length > waitingWork.length ? `<div class="fmp-note">${esc(t('work_in_runs', '{count} more are already in a pay run.', { count:finalized.length - waitingWork.length }))}</div>` : '') + errorNote('finalized') })}
        ${card({ id:'reimbursements', title:t('reimbursements_waiting', 'Reimbursements waiting to be paid'), tooltip:t('reimbursements_waiting_tip', 'Approved receipt reimbursements set to be paid with payroll and not in a pay run yet. One with no pay schedule is in no pay run until the company\u2019s schedule is chosen.'), count:reimbursements.length,
          body:table([{ label:t('person', 'Person') }, { label:t('for', 'For') }, { label:t('pay_schedule', 'Pay schedule') }, { label:t('amount', 'Amount'), cls:'num' }], reimbursements.map((entry) => `<tr>${td(esc(payeeName(entry.payee)), t('person', 'Person'), 'lead')}${td(nameCell(clean(entry.description) || t('reimbursement', 'Reimbursement'), clean(entry.project_title)), t('for', 'For'))}${td(entry.schedule_id ? esc(scheduleName(entry.schedule_id)) : pill(t('no_schedule', 'No schedule'), 'warn'), t('pay_schedule', 'Pay schedule'))}${td(esc(money(entry.remaining_cents, entry.currency || currency)), t('amount', 'Amount'), 'num')}</tr>`), { empty:t('no_reimbursements_waiting', 'No approved reimbursement is waiting to be paid.') }) + errorNote('reimbursements') })}`;
    }
    function scheduleName(id){ return clean(arr(state.data.dashboard?.schedules).find((schedule) => schedule.id === id)?.name) || t('pay_schedule', 'Pay schedule'); }

    // -- Timesheets --
    function timesheetsView(){
      const all = can('timesheets.all');
      const result = obj(state.data.timesheets);
      const rows = arr(result.timesheets);
      const search = state.ts.search.toLowerCase();
      const statusOf = (shift) => clean(shift.status) === 'active' ? 'active' : clean(shift.approval_status || 'pending');
      const shown = rows.filter((shift) => (state.ts.status === 'all' || statusOf(shift) === state.ts.status) && (!search || `${clean(shift.user?.name)} ${clean(shift.project?.title)}`.toLowerCase().includes(search)));
      const counts = rows.reduce((total, shift) => { total[statusOf(shift)] = (total[statusOf(shift)] || 0) + 1; return total; }, {});
      const segments = [['pending', t('needs_approval', 'Needs approval')], ['approved', t('approved', 'Approved')], ['rejected', t('rejected', 'Rejected')], ['active', t('on_the_clock', 'On the clock')], ['all', t('all', 'All')]];
      const statusPill = (shift) => ({ active:pill(t('on_the_clock', 'On the clock'), 'role'), pending:pill(t('needs_approval', 'Needs approval'), 'warn'), approved:pill(t('approved', 'Approved'), 'ok'), rejected:pill(t('rejected', 'Rejected'), 'danger') })[statusOf(shift)] || '';
      const where = (shift) => { const location = obj(shift.clock_in_location); if (location.status !== 'captured') return `<span class="fmp-muted"${tip(t('no_location_tip', 'No location was recorded when they clocked in.'))}><i class="fas fa-location-crosshairs"></i></span>`; const meters = num(location.distance_to_project_meters); return location.distance_to_project_meters === undefined || location.distance_to_project_meters === null ? '' : `<span class="${meters > 300 ? 'fmp-reason' : 'fmp-muted'}"${tip(t('distance_tip', 'How far from the project they clocked in.'))}>${meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`}</span>`; };
      const pendingClosed = shown.filter((shift) => statusOf(shift) === 'pending' && clean(shift.status) === 'closed');
      const columns = [...(all ? [{ label:t('person', 'Person') }] : []), { label:t('day', 'Day') }, { label:t('in_out', 'In \u2013 out') }, { label:t('break', 'Break'), cls:'num' }, { label:t('worked', 'Worked'), cls:'num' }, { label:t('project', 'Project') }, { label:t('where', 'Where') }, { label:t('status', 'Status') }, ...(all ? [{ label:'', cls:'act' }] : [])];
      const body = shown.map((shift) => `<tr data-shift="${esc(shift.id)}">
        ${all ? td(nameCell(clean(shift.user?.name) || clean(shift.user_id), clean(shift.manager_note)), t('person', 'Person'), 'lead') : ''}
        ${td(esc(dateLabel(shift.clocked_in_at, { weekday:true })), t('day', 'Day'), all ? '' : 'lead')}
        ${td(esc(`${timeLabel(shift.clocked_in_at)} \u2013 ${shift.clocked_out_at ? timeLabel(shift.clocked_out_at) : t('now', 'now')}`) + (shift.corrected ? ` ${pill(t('corrected', 'Corrected'), 'role', t('corrected_tip', 'A manager changed the times.'))}` : ''), t('in_out', 'In \u2013 out'))}
        ${td(esc(hours(shift.break_seconds)), t('break', 'Break'), 'num')}
        ${td(clean(shift.status) === 'closed' ? `<b>${esc(hours(shift.worked_seconds))}</b>` : '\u2014', t('worked', 'Worked'), 'num')}
        ${td(esc(clean(shift.project?.title) || '\u2014'), t('project', 'Project'))}
        ${td(where(shift), t('where', 'Where'))}
        ${td(statusPill(shift), t('status', 'Status'))}
        ${all ? td(clean(shift.status) === 'closed' ? [statusOf(shift) !== 'approved' ? button('timesheets.approve', context, { label:t('approve', 'Approve'), attrs:`data-ts-approve="${esc(shift.id)}"` }) : '', button('timesheets.correct', context, { label:t('fix', 'Fix'), tone:'quiet', attrs:`data-ts-edit="${esc(shift.id)}"`, tooltip:t('fix_tip', 'Correct the clock times or the break.') }), statusOf(shift) !== 'rejected' ? button('timesheets.reject', context, { label:t('reject', 'Reject'), tone:'quiet', attrs:`data-ts-reject="${esc(shift.id)}"` }) : ''].join('') : '', '', 'act') : ''}
      </tr>`);
      const workedTotal = shown.reduce((sum, shift) => sum + (clean(shift.status) === 'closed' ? num(shift.worked_seconds) : 0), 0);
      return `<div class="fmp-bar">
          <div class="pp-seg" role="group" aria-label="${esc(t('show', 'Show'))}">${segments.map(([id, label]) => `<button type="button" data-ts-status="${esc(id)}" aria-pressed="${state.ts.status === id}">${esc(label)}${id !== 'all' && counts[id] ? ` <span class="pp-seg-count">${counts[id]}</span>` : ''}</button>`).join('')}</div>
          <label class="fmp-date">${esc(t('from', 'From'))}<input class="pp-input" type="date" data-ts-from value="${esc(state.ts.from)}"></label>
          <label class="fmp-date">${esc(t('to', 'To'))}<input class="pp-input" type="date" data-ts-through value="${esc(state.ts.through)}"></label>
          ${all ? `<label class="pp-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-ts-search placeholder="${esc(t('search_people', 'Search people or projects'))}" value="${esc(state.ts.search)}" aria-label="${esc(t('search_people', 'Search people or projects'))}"></label>` : ''}
          ${all ? branchControl() : ''}
        </div>
        ${card({ id:'timesheets', title:all ? t('timesheets', 'Timesheets') : t('your_timesheets', 'Your timesheets'), tooltip:all ? t('timesheets_tip', 'Approving, fixing or rejecting a shift changes the time clock; each person\u2019s pay rules price approved hours at the next earnings refresh. A change to a shift already paid comes out as a correction.') : t('your_timesheets_tip', 'Your clocked shifts and whether each was approved.'), count:`${shown.length} \u00b7 ${hours(workedTotal)}`,
          actions:all && pendingClosed.length && state.ts.status === 'pending' ? button('timesheets.approve', context, { label:t('approve_all_shown', 'Approve all {count} shown', { count:pendingClosed.length }), icon:'fa-check-double', attrs:'data-ts-approve-all' }) : '',
          body:table(columns, body, { empty:state.errors.timesheets || t('no_shifts', 'No shifts in these dates.'), label:t('timesheets', 'Timesheets') }) })}`;
    }

    // -- Earnings (payees) --
    function payeesView(){
      const dashboard = obj(state.data.dashboard);
      const currency = clean(dashboard.schedules?.[0]?.currency || 'USD');
      const people = new Map();
      for (const occurrence of arr(dashboard.upcoming)) {
        for (const item of [...arr(occurrence.employees), ...arr(occurrence.subcontractors)]) {
          const key = payeeKey(item.payee);
          const row = people.get(key) || { payee:item.payee, owed:0, projectedLedger:0, next:'' };
          row.owed += num(item.accrued?.net_cents);
          row.projectedLedger += num(item.projected?.net_cents);
          if (!row.next || clean(occurrence.pay_date) < row.next) row.next = clean(occurrence.pay_date);
          people.set(key, row);
        }
      }
      const projected = state.projected?.value;
      for (const row of arr(projected?.payees)) {
        const key = payeeKey(row.payee);
        const entry = people.get(key) || { payee:{ ...row.payee, name:row.payee_name }, owed:0, projectedLedger:0, next:'' };
        entry.projected = num(row.total_cents); entry.expected = clean(row.next_expected_on); entry.projectedUnresolved = num(row.unresolved_count);
        if (!clean(entry.payee.name)) entry.payee = { ...entry.payee, name:row.payee_name };
        people.set(key, entry);
      }
      const search = state.payeeSearch.toLowerCase();
      const list = [...people.values()].filter((row) => !search || payeeName(row.payee).toLowerCase().includes(search)).sort((a, b) => payeeName(a.payee).localeCompare(payeeName(b.payee)));
      const projectedCell = (row) => !projected ? '' : row.projectedUnresolved && !row.projected ? `<span class="fmp-reason"${tip(t('projection_unresolved_tip', 'Some projected earnings could not be worked out. Open Why for the reasons.'))}>${esc(t('not_worked_out', 'Not worked out'))}</span>` : esc(money(row.projected || 0, currency));
      const totalOwed = list.reduce((sum, row) => sum + row.owed, 0), totalProjected = list.reduce((sum, row) => sum + num(row.projected), 0);
      return `<div class="fmp-bar"><label class="pp-search"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><input type="search" data-payee-search placeholder="${esc(t('search_people_only', 'Search people'))}" value="${esc(state.payeeSearch)}" aria-label="${esc(t('search_people_only', 'Search people'))}"></label>${branchControl()}<span class="fmp-bar-fill"></span>
          ${can('earnings.projected') && !projected ? `<button type="button" class="pp-btn" data-act="load-projected"${tip(t('projected_all_tip', 'Work out what everyone\u2019s pay rules project from work not done yet. Nothing is posted.'))}><i class="fas fa-chart-line" aria-hidden="true"></i>${esc(state.projected?.loading ? t('working_out', 'Working it out\u2026') : t('show_projected', 'Show projected'))}</button>` : ''}
        </div>
        <div class="fmp-stats">${stat({ label:t('owed_upcoming', 'Owed in the next two months'), value:money(totalOwed, currency), sub:t('people_count', '{count} people', { count:list.length }) })}${projected ? stat({ label:t('projected', 'Projected'), value:money(totalProjected, currency), sub:t('from_work_not_done', 'From work not done yet'), tooltip:t('projected_tip_all', 'What everyone\u2019s pay rules project from labor committed or assigned and not done yet. Never paid until earned.') }) : ''}</div>
        ${card({ id:'payees', title:t('earnings_by_person', 'Earnings by person'), tooltip:t('earnings_by_person_tip', 'What each person is owed on the upcoming pay runs and, when shown, projected to earn. Open someone to see why.'), count:list.length,
          body:`${table([{ label:t('person', 'Person') }, { label:t('paid_as', 'Paid as') }, { label:t('next_pay_date', 'Next pay date') }, { label:t('owed', 'Owed'), cls:'num', tooltip:t('owed_tip', 'Earned and not paid yet, after anything paid outside a pay run.') }, ...(projected ? [{ label:t('projected', 'Projected'), cls:'num' }] : [])], list.map((row) => `<tr data-open="why" data-why="${esc(payeeKey(row.payee))}" data-why-name="${esc(payeeName(row.payee))}" tabindex="0">${td(nameCell(payeeName(row.payee)), t('person', 'Person'), 'lead')}${td(esc(paidAs(row.payee)), t('paid_as', 'Paid as'))}${td(esc(row.next ? dateLabel(row.next) : '\u2014'), t('next_pay_date', 'Next pay date'))}${td(`<b>${esc(money(row.owed, currency))}</b>`, t('owed', 'Owed'), 'num')}${projected ? td(projectedCell(row), t('projected', 'Projected'), 'num') : ''}</tr>`), { empty:t('nobody_owed', 'Nobody is owed anything on the upcoming pay runs.') })}
          ${projected?.truncated ? `<div class="fmp-note">${esc(t('projected_truncated', 'Projected for the first {count} people only.', { count:arr(projected.payees).length }))}</div>` : ''}${projected?.hidden_payee_count ? hiddenNote(projected.hidden_payee_count) : ''}` })}`;
    }

    // -- History --
    function historyView(){
      const batches = arr(state.data.batches);
      const rows = batches.map((batch) => {
        const status = runStatus(null, batch);
        return `<tr data-open="history" data-batch="${esc(batch.id)}" tabindex="0">${td(nameCell(dateLabel(batch.pay_date, { weekday:true, year:true }), clean(batch.run_type) === 'off_cycle' ? t('off_cycle_run', 'Off-cycle pay run') : scheduleNameOf(batch)), t('pay_date', 'Pay date'), 'lead')}${td(esc(`${dateLabel(batch.period_start)} \u2013 ${dateLabel(batch.period_end)}`), t('period', 'Period'), 'hide-sm')}${td(esc(arr(batch.items).length), t('people', 'People'), 'num')}${td(`<b>${esc(money(batch.total_cents, batch.currency))}</b>`, t('total', 'Total'), 'num')}${td(pill(status.label, status.tone), t('status', 'Status'))}${td(esc(batch.paid_at ? dateLabel(batch.paid_at) : '\u2014'), t('paid_on', 'Paid on'))}</tr>`;
      });
      const outside = arr(state.data.offCycle);
      return `<div class="fmp-bar">${branchControl()}</div>
        ${card({ id:'history', title:t('pay_runs', 'Pay runs'), tooltip:t('history_tip', 'Every pay run, newest first. Open one to see who was paid what, download its files again or see who approved it.'), count:batches.length, body:table([{ label:t('pay_date', 'Pay date') }, { label:t('period', 'Period'), cls:'hide-sm' }, { label:t('people', 'People'), cls:'num' }, { label:t('total', 'Total'), cls:'num' }, { label:t('status', 'Status') }, { label:t('paid_on', 'Paid on') }], rows, { empty:t('no_history', 'No pay run has been drafted yet.') }) })}
        ${card({ id:'outside', title:t('paid_outside', 'Paid outside a pay run'), tooltip:t('paid_outside_tip', 'Payments made outside a pay run. The next pay run takes each off, so nothing is paid twice.'), count:outside.length, body:table([{ label:t('person', 'Person') }, { label:t('paid_on', 'Paid on') }, { label:t('reference', 'Reference') }, { label:t('amount', 'Amount'), cls:'num' }], outside.map((row) => `<tr>${td(nameCell(payeeName(row.payee), kindLabel(row.kind)), t('person', 'Person'), 'lead')}${td(esc(dateLabel(row.paid_on)), t('paid_on', 'Paid on'))}${td(esc(clean(row.reference) || '\u2014'), t('reference', 'Reference'))}${td(esc(money(row.amount_cents, row.currency)), t('amount', 'Amount'), 'num')}</tr>`), { empty:t('none_outside', 'Nothing has been paid outside a pay run.') }) })}`;
    }
    function scheduleNameOf(batch){ return clean([...arr(state.data.schedules), ...arr(state.data.dashboard?.schedules)].find((schedule) => schedule.id === batch.schedule_id)?.name) || clean(batch.schedule_name) || t('pay_run', 'Pay run'); }

    // -- Reports --
    function reportsView(){
      const catalog = arr(state.data.catalog).filter((entry) => entry.group !== 'pay_run_file' && entry.scope !== 'payroll_run');
      const artifacts = arr(state.data.artifacts);
      const rows = catalog.map((report) => `<tr>${td(`<span class="fmp-titled"><strong${tip(`${report.description} ${report.purpose}`)}>${esc(report.label)}</strong>${info(`${report.description} ${report.purpose}`)}</span>`, t('report', 'Report'), 'lead')}${td(arr(report.formats).map((format) => button('reports.generate', context, { label:format.toUpperCase(), icon:'fa-download', attrs:`data-report="${esc(report.type)}" data-format="${esc(format)}"` })).join(' '), '', 'act')}</tr>`);
      const saved = artifacts.map((artifact) => { const metadata = obj(artifact.metadata); return `<tr>${td(nameCell(clean(metadata.report_label) || clean(artifact.report_type), clean(metadata.coverage_label)), t('file', 'File'), 'lead')}${td(esc(clean(metadata.format || '').toUpperCase()), t('format', 'Format'))}${td(esc(dateTimeLabel(artifact.created_at)), t('prepared', 'Prepared'))}${td(`<a class="pp-btn" href="${esc(window.PayrollAPI.artifacts.downloadUrl(state.orgId, artifact.id))}" download><i class="fas fa-download" aria-hidden="true"></i>${esc(t('download', 'Download'))}</a>`, '', 'act')}</tr>`; });
      return `<div class="fmp-bar"><label class="fmp-date">${esc(t('from', 'From'))}<input class="pp-input" type="date" data-report-from value="${esc(state.reports.from)}"></label><label class="fmp-date">${esc(t('to', 'To'))}<input class="pp-input" type="date" data-report-through value="${esc(state.reports.through)}"></label></div>
        ${card({ id:'reports', title:t('reports', 'Reports'), tooltip:t('reports_tip', 'Reports for the dates above. Files for one pay run (Gusto, QuickBooks, the pay run summary) are in that pay run, under Copy out.'), count:catalog.length, body:table([{ label:t('report', 'Report') }, { label:'', cls:'act' }], rows, { empty:state.errors.catalog || t('no_reports', 'No reports are available.') }) })}
        ${card({ id:'saved', title:t('saved_files', 'Prepared files'), tooltip:t('saved_files_tip', 'Every file prepared before, newest first. The same numbers prepared again reuse the file.'), count:artifacts.length, body:table([{ label:t('file', 'File') }, { label:t('format', 'Format') }, { label:t('prepared', 'Prepared') }, { label:'', cls:'act' }], saved, { empty:t('no_files', 'No file has been prepared yet.') }) })}`;
    }

    // -- Approvals --
    function approvalsView(){
      const approvals = arr(state.data.approvals?.approvals);
      if (state.errors.approvals) return `<div class="fmp-state"><strong>${esc(t('unavailable', 'This could not be loaded.'))}</strong>${esc(state.errors.approvals)}</div>`;
      if (!approvals.length) return card({ id:'approvals', title:t('waiting_for_you', 'Waiting for your approval'), tooltip:t('approvals_tip', 'Pay runs someone asked you to approve.'), count:0, body:`<div class="fmp-empty">${esc(t('nothing_to_approve', 'Nothing is waiting for your approval.'))}</div>` });
      return approvals.map((run) => {
        const decided = clean(run.my_decision);
        const lines = arr(run.items).map((item) => lineOf(item, false));
        const rows = lines.sort((a, b) => payeeName(a.payee).localeCompare(payeeName(b.payee))).map((line) => `<tr>${td(nameCell(payeeName(line.payee), paidAs(line.payee)), t('person', 'Person'), 'lead')}${td(esc(money(line.earned, run.currency)), t('earned', 'Earned'), 'num')}${td(esc(money(line.reimbursement, run.currency)), t('reimbursements', 'Reimbursements'), 'num')}${td(line.offCycle + line.clawback ? esc(minus(line.offCycle + line.clawback, run.currency)) : '\u2014', t('taken_off', 'Taken off'), `num${line.offCycle + line.clawback ? ' neg' : ''}`)}${td(`<b>${esc(money(line.net, run.currency))}</b>`, t('to_pay', 'To pay'), 'num')}</tr>`);
        const actions = decided ? pill(decided === 'approved' ? t('you_approved', 'You approved') : t('you_rejected', 'You rejected'), decided === 'approved' ? 'ok' : 'danger') : `${button('runs.decide', context, { label:t('reject', 'Reject'), attrs:`data-approval-reject="${esc(run.id)}"` })}${button('runs.decide', context, { label:t('approve', 'Approve'), icon:'fa-check', tone:'primary', attrs:`data-approval-approve="${esc(run.id)}"` })}`;
        return card({ id:`approval-${run.id}`, title:`${dateLabel(run.pay_date, { weekday:true })} \u00b7 ${clean(run.schedule_name) || t('pay_run', 'Pay run')}`, tooltip:t('approval_card_tip', 'Asked by {name}. {period}', { name:clean(obj(run.approval?.submitted_by).name) || t('someone', 'Someone'), period:`${dateLabel(run.period_start)} \u2013 ${dateLabel(run.period_end)}` }), count:money(run.total_cents, run.currency), actions,
          body:table([{ label:t('person', 'Person') }, { label:t('earned', 'Earned'), cls:'num' }, { label:t('reimbursements', 'Reimbursements'), cls:'num' }, { label:t('taken_off', 'Taken off'), cls:'num' }, { label:t('to_pay', 'To pay'), cls:'num' }], rows) });
      }).join('');
    }

    // -- Settings: the one Payroll settings component, mounted here --
    function mountSettings(host){
      if (!window.FirstMatePayrollSettings?.mount) { host.innerHTML = `<div class="fmp-state"><strong>${esc(t('settings_unavailable', 'Payroll settings could not be loaded.'))}</strong></div>`; return; }
      settingsHandle = window.FirstMatePayrollSettings.mount(host, { orgId:state.orgId, branchId:clean(window.__APP?.userBranchId || 'default'), routeTab:'payroll', embedded:true, showToast:(title, message, ok) => toast(title, message, ok !== false) });
    }

    // -- Drawing --
    function render(){
      if (state.destroyed) return;
      const view = state.view;
      if (!viewNeeds[view] || !allows(viewNeeds[view], context)) {
        root.innerHTML = `<div class="pp fmp"><div class="fmp-state"><strong>${esc(t('not_available', 'Nothing in Payroll is available to you here.'))}</strong></div></div>`;
        return;
      }
      if (view === 'mine') {
        if (!root.querySelector('[data-payroll-mine-host]')) {
          settingsHandle?.destroy?.();
          root.innerHTML = '<div class="pp fmp" data-payroll-view="mine"><div data-payroll-mine-host></div></div>';
          const host = root.querySelector('[data-payroll-mine-host]');
          settingsHandle = window.FirstMateMyPay?.mount ? window.FirstMateMyPay.mount(host, { orgId:state.orgId, projected:can('mine.projected') }) : null;
          if (!settingsHandle) host.innerHTML = `<div class="fmp-state"><strong>${esc(t('not_loaded', 'Payroll could not be loaded.'))}</strong></div>`;
        }
        return;
      }
      if (view === 'settings') {
        if (!root.querySelector('[data-payroll-settings-host]')) {
          settingsHandle?.destroy?.();
          root.innerHTML = '<div class="pp fmp" data-payroll-view="settings"><div class="fmp-wrap fmp-settings" data-payroll-settings-host></div></div>';
          mountSettings(root.querySelector('[data-payroll-settings-host]'));
        }
        return;
      }
      if (!kit() || state.unavailable) { root.innerHTML = `<div class="fmp-state"><strong>${esc(t('not_loaded', 'Payroll could not be loaded.'))}</strong></div>`; return; }
      const loaded = Object.keys(state.data).length > 0;
      const draw = { upcoming:upcomingView, review:reviewView, timesheets:timesheetsView, payees:payeesView, history:historyView, exports:reportsView, approvals:approvalsView }[view];
      const focus = document.activeElement && root.contains(document.activeElement) ? (document.activeElement.matches('input[type="search"]') ? document.activeElement.dataset : null) : null;
      root.innerHTML = `<div class="pp fmp" data-payroll-view="${esc(view)}"><div class="fmp-wrap">${state.loading && !loaded ? `<div class="fmp-state" role="status">${esc(t('loading', 'Loading\u2026'))}</div>` : draw()}</div></div>`;
      if (focus) { const input = root.querySelector(Object.keys(focus).map((key) => `[data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`).join('')); if (input) { input.focus(); input.setSelectionRange?.(input.value.length, input.value.length); } }
    }

    // -- Events --
    async function recordOffCycle(anchor, preset = {}){
      if (!state.directory) state.directory = await window.PayrollAPI.published.read(state.orgId, 'directory').catch(() => ({ users:[], connections:[], resource_groups:[] }));
      const directory = obj(state.directory);
      const people = [
        ...arr(directory.users).map((user) => ({ value:`organization_user:${user.id}`, label:clean(user.name) || user.id })),
        ...arr(directory.resource_groups).map((group) => ({ value:`resource_group:${group.id}`, label:clean(group.name) || group.id })),
        ...arr(directory.connections).map((company) => ({ value:`organization_connection:${company.id}`, label:clean(company.name) || company.id }))
      ].sort((a, b) => a.label.localeCompare(b.label));
      const kinds = (arr(obj(state.vocabulary).earning_kinds).length ? arr(state.vocabulary.earning_kinds) : ['hourly', 'salary', 'piece_rate', 'commission', 'reimbursement', 'adjustment']).map((kind) => ({ value:kind, label:kindLabel(kind) }));
      const values = await kit().form(anchor, {
        title:t('record_payment', 'Record a payment made outside a pay run'), submitLabel:t('record', 'Record'),
        fields:[
          { id:'payee', label:t('who_was_paid', 'Who was paid'), type:'select', options:people, value:preset.payee || '', placeholder:t('choose', 'Choose') },
          { id:'kind', label:t('paid_for', 'Paid for'), type:'select', options:kinds, value:preset.kind || 'hourly' },
          { id:'amount', label:t('amount', 'Amount'), type:'number', value:preset.cents ? (num(preset.cents) / 100).toFixed(2) : '', required:true },
          { id:'paid_on', label:t('paid_on', 'Paid on'), type:'date', value:today, required:true },
          { id:'reference', label:t('reference_optional', 'Reference (optional)'), value:'' },
          { id:'note', label:t('note_optional', 'Note (optional)'), value:'' }
        ],
        submit:async (form) => {
          const [type, ...rest] = clean(form.payee).split(':');
          const cents = Math.round(Number(String(form.amount).replace(/[^0-9.]/g, '')) * 100);
          if (!type || !rest.length) throw new Error(t('choose_person', 'Choose who was paid.'));
          if (!Number.isFinite(cents) || cents <= 0) throw new Error(t('amount_positive', 'Enter the amount that was paid.'));
          return window.PayrollAPI.offCycle.record(state.orgId, { payee:{ type, id:rest.join(':') }, kind:form.kind, amount_cents:cents, paid_on:form.paid_on, ...(form.reference ? { reference:form.reference } : {}), ...(form.note ? { note:form.note } : {}) });
        }
      });
      if (values) { toast(t('recorded', 'Payment recorded'), t('recorded_note', 'The next pay run takes it off what they are paid.')); await load({ silent:true }); }
    }
    async function onClick(event){
      const go = event.target.closest('[data-go]');
      if (go) { navigate(go.dataset.go); return; }
      const act = event.target.closest('[data-act]');
      if (act) {
        const kind = act.dataset.act;
        if (kind === 'refresh-earnings') {
          const result = await perform(t('refreshed', 'Earnings refreshed'), () => window.PayrollAPI.pay.refreshEarnings(state.orgId));
          if (result) toast(t('refreshed', 'Earnings refreshed'), t('refresh_result', '{posted} changes posted, {held} held for review, {unresolved} could not be worked out.', { posted:num(result.posted_count), held:num(result.held_count), unresolved:num(result.unresolved_count) }), !num(result.unresolved_count));
        } else if (kind === 'record-offcycle') await recordOffCycle(act);
        else if (kind === 'load-projected') {
          state.projected = { loading:true }; render();
          try { state.projected = { value:await window.PayrollAPI.pay.projected(state.orgId) }; }
          catch (error) { state.projected = null; toast(t('projected_failed', 'Projected earnings could not be worked out'), clean(error?.message), false); }
          render();
        }
        return;
      }
      const recordFor = event.target.closest('[data-record-for]');
      if (recordFor) { await recordOffCycle(recordFor, { payee:recordFor.dataset.recordFor, kind:recordFor.dataset.recordKind, cents:recordFor.dataset.recordCents }); return; }
      const removeOff = event.target.closest('[data-remove-offcycle]');
      if (removeOff) {
        if (await kit().confirm(removeOff, { title:t('remove_confirm', 'Remove this payment? It was recorded by mistake and no pay run has taken it off.'), confirmLabel:t('remove', 'Remove'), tone:'danger' })) await perform(t('removed', 'Removed'), () => window.PayrollAPI.offCycle.remove(state.orgId, removeOff.dataset.removeOffcycle), t('removed', 'Removed'));
        return;
      }
      const accept = event.target.closest('[data-accept]');
      if (accept) { await perform(t('accepted', 'Accepted'), () => window.PayrollAPI.ledger.accrueProjection(state.orgId, accept.dataset.accept), t('accepted_note', 'It is counted in their next pay run.')); return; }
      const decline = event.target.closest('[data-decline]');
      if (decline) {
        const values = await kit().form(decline, { title:t('decline_correction', 'Decline this correction'), submitLabel:t('decline', 'Decline'), fields:[{ id:'note', label:t('note_optional', 'Note (optional)') }] });
        if (values) await perform(t('declined', 'Declined'), () => window.PayrollAPI.pay.declineCorrection(state.orgId, decline.dataset.decline, values.note), t('declined_note', 'What was already paid stays as it is.'));
        return;
      }
      const why = event.target.closest('[data-why]');
      if (why && (event.target.closest('button') || why.dataset.open === 'why')) { const [type, ...rest] = why.dataset.why.split(':'); openWhy({ type, id:rest.join(':'), name:why.dataset.whyName }, why); return; }
      const run = event.target.closest('[data-run]');
      if (run) { const occurrence = findOccurrence(run.dataset.run); if (occurrence) openRun({ key:run.dataset.run, occurrence, batch:occurrence.batch }); return; }
      const history = event.target.closest('[data-batch]');
      if (history) { const batch = arr(state.data.batches).find((item) => item.id === history.dataset.batch); if (batch) openRun({ batch, fromHistory:true, occurrence:null }); return; }
      const status = event.target.closest('[data-ts-status]');
      if (status) { state.ts.status = status.dataset.tsStatus; render(); return; }
      const tsApprove = event.target.closest('[data-ts-approve]');
      if (tsApprove) { const shift = shiftOf(tsApprove.dataset.tsApprove); if (shift) await perform(t('approved_shift', 'Shift approved'), () => window.PayrollAPI.timesheets.approve(state.orgId, shift.id, { expected_revision:num(shift.revision) }), t('approved_shift', 'Shift approved')); return; }
      if (event.target.closest('[data-ts-approve-all]')) {
        const shifts = arr(state.data.timesheets?.timesheets).filter((shift) => clean(shift.status) === 'closed' && clean(shift.approval_status || 'pending') === 'pending' && (!state.ts.search || `${clean(shift.user?.name)} ${clean(shift.project?.title)}`.toLowerCase().includes(state.ts.search.toLowerCase())));
        await perform(t('approved_shifts', 'Shifts approved'), async () => { for (const shift of shifts) await window.PayrollAPI.timesheets.approve(state.orgId, shift.id, { expected_revision:num(shift.revision) }); }, t('approved_count', '{count} shifts approved', { count:shifts.length }));
        return;
      }
      const tsReject = event.target.closest('[data-ts-reject]');
      if (tsReject) {
        const shift = shiftOf(tsReject.dataset.tsReject);
        const values = shift && await kit().form(tsReject, { title:t('reject_shift', 'Reject this shift'), submitLabel:t('reject', 'Reject'), fields:[{ id:'note', label:t('why_rejected', 'Why'), required:true }] });
        if (values) await perform(t('rejected_shift', 'Shift rejected'), () => window.PayrollAPI.timesheets.reject(state.orgId, shift.id, { expected_revision:num(shift.revision), manager_note:values.note }), t('rejected_shift', 'Shift rejected'));
        return;
      }
      const tsEdit = event.target.closest('[data-ts-edit]');
      if (tsEdit) {
        const shift = shiftOf(tsEdit.dataset.tsEdit);
        if (!shift) return;
        const values = await kit().form(tsEdit, { title:t('fix_shift', 'Fix this shift'), submitLabel:t('save', 'Save'), fields:[
          { id:'in', label:t('clocked_in', 'Clocked in'), type:'datetime-local', value:localInput(shift.clocked_in_at), required:true },
          { id:'out', label:t('clocked_out', 'Clocked out'), type:'datetime-local', value:localInput(shift.clocked_out_at), required:true },
          { id:'break', label:t('break_minutes', 'Break (minutes)'), type:'number', value:String(Math.round(num(shift.break_seconds) / 60)) },
          { id:'note', label:t('note_optional', 'Note (optional)'), value:clean(shift.manager_note) }
        ], submit:(form) => window.PayrollAPI.timesheets.update(state.orgId, shift.id, { expected_revision:num(shift.revision), clocked_in_at:new Date(form.in).toISOString(), clocked_out_at:new Date(form.out).toISOString(), break_seconds:Math.max(0, Math.round(num(form.break) * 60)), ...(form.note ? { manager_note:form.note } : {}) }) });
        if (values) { toast(t('fixed', 'Shift fixed'), t('fixed_note', 'Pay rules price the new hours at the next earnings refresh.')); await load({ silent:true }); }
        return;
      }
      const report = event.target.closest('[data-report]');
      if (report) {
        await perform(t('file_ready', 'The file is downloading.'), async () => {
          const result = await window.PayrollAPI.artifacts.create(state.orgId, { type:report.dataset.report, format:report.dataset.format, from:state.reports.from, through:state.reports.through });
          download(result.artifact?.download_url || window.PayrollAPI.artifacts.downloadUrl(state.orgId, result.artifact?.id));
        });
        return;
      }
      const approvalApprove = event.target.closest('[data-approval-approve]');
      if (approvalApprove) { await perform(t('approved_note', 'Approved'), () => window.PayrollAPI.approvals.decide(state.orgId, approvalApprove.dataset.approvalApprove, 'approve'), t('approved_note', 'Approved')); return; }
      const approvalReject = event.target.closest('[data-approval-reject]');
      if (approvalReject) {
        const values = await kit().form(approvalReject, { title:t('reject_run', 'Reject this pay run'), submitLabel:t('reject', 'Reject'), fields:[{ id:'note', label:t('what_is_wrong', 'What is wrong'), required:true }] });
        if (values) await perform(t('rejected', 'Rejected'), () => window.PayrollAPI.approvals.decide(state.orgId, approvalReject.dataset.approvalReject, 'reject', values.note), t('rejected', 'Rejected'));
      }
    }
    const shiftOf = (id) => arr(state.data.timesheets?.timesheets).find((shift) => shift.id === id);
    function onKeydown(event){
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest?.('tr[data-open]');
      if (row && event.target === row) { event.preventDefault(); row.click(); }
    }
    let searchTimer = 0;
    function onInput(event){
      const target = event.target;
      if (target.matches('[data-ts-search]')) { state.ts.search = target.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); }
      if (target.matches('[data-payee-search]')) { state.payeeSearch = target.value; clearTimeout(searchTimer); searchTimer = setTimeout(render, 120); }
    }
    function onChange(event){
      const target = event.target;
      if (target.matches('[data-branch]')) { state.branch = target.value; state.projected = null; load(); return; }
      if (target.matches('[data-ts-from]')) { state.ts.from = target.value; load(); return; }
      if (target.matches('[data-ts-through]')) { state.ts.through = target.value; load(); return; }
      if (target.matches('[data-report-from]')) state.reports.from = target.value;
      if (target.matches('[data-report-through]')) state.reports.through = target.value;
    }
    // Inside the Payroll tab a link to another view changes the tab's route; anywhere else (an agent panel) it changes this view.
    function navigate(view){
      if (window.Portal?.navigation?.read?.()?.tab === 'payroll' && window.Portal.navigation.navigate) {
        window.Portal.navigation.navigate({ tab:'payroll', payrollView:view }, { source:'payroll-view', ownedKeys:['payrollView'] });
        return;
      }
      state.view = view; state.data = {}; render(); load();
    }

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
    // A widget is refreshed by the widget runtime when payroll changes; a view mounted on its own listens itself.
    let active = true;
    const onUpdated = () => { if (active && state.view !== 'settings') load({ silent:true }); };
    if (context.params?.widget !== true) window.addEventListener('fm:payroll:updated', onUpdated);
    if (['exports', 'upcoming', 'history'].includes(state.view)) window.PayrollAPI?.artifacts?.catalog?.(state.orgId).then((result) => { state.data.catalog = arr(result?.exports); }).catch(() => {});
    render();
    load();

    return {
      destroy(){
        state.destroyed = true; state.token++;
        window.removeEventListener('fm:payroll:updated', onUpdated);
        settingsHandle?.destroy?.();
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        root.removeEventListener('input', onInput);
        root.removeEventListener('change', onChange);
        root.innerHTML = '';
      },
      setActive(value){ active = !!value; },
      update(next = {}){ const orgId = orgOf(next); if (orgId && orgId !== state.orgId) { state.orgId = orgId; state.data = {}; load(); } },
      serialize(){ return { ...(context.params?.from ? { from:state.range.from, through:state.range.through } : {}), ...(state.branch ? { branch_ids:state.branch } : {}) }; },
      refresh(){ return load({ silent:true }); }
    };
  }

  // The pay run files the server offers (payroll/exports.ts); used until the catalog has loaded.
  const PAY_RUN_FILES = [
    { type:'pay_run_summary', label:'Pay run summary', description:'Everyone in this pay run, employees then contractors, with earnings by kind, reimbursements, what was taken off and the amount to pay.', formats:['csv', 'pdf'] },
    { type:'gusto_employees', label:'Gusto: employees', description:'One row per employee with earnings by kind, reimbursements and what was already paid or taken back.', formats:['csv'] },
    { type:'gusto_contractors', label:'Gusto: contractors', description:'One row per contractor or subcontractor company.', formats:['csv'] },
    { type:'quickbooks_payroll', label:'QuickBooks Payroll: employees', description:'One row per employee and pay item.', formats:['csv'] },
    { type:'quickbooks_bills', label:'QuickBooks: contractor bills', description:'Contractors as bills to vendors.', formats:['csv'] }
  ];

  // Which widget shows a view: timesheets are everyone's for payroll managers and your own otherwise.
  function widgetFor(view, context){
    if (view === 'timesheets' && !allows('timesheets.all', context)) return 'payroll.my_timesheets';
    return `payroll.${view}`;
  }

  // The Payroll tab: one header with the views this person may open, and the view below it.
  function createTab(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    const orgId = orgOf(context);
    let alive = true, widget = null;
    let view = context.params?.standalone || window.AppChrome.resolve('payroll', window.Portal?.navigation?.read?.().payrollView, context);
    function render(){
      if (!alive) return;
      widget?.destroy?.();
      widget = null;
      const tabs = context.params?.standalone ? '' : window.AppChrome.tabs('payroll', view, 'data-payroll-view', context);
      root.innerHTML = `<div style="height:100%;display:flex;flex-direction:column;min-height:0">${context.params?.standalone ? '' : window.AppChrome.header({ title:t('payroll', 'Payroll'), icon:'fa-money-check-dollar', tabs })}<div data-payroll-host style="flex:1;min-height:0;overflow:auto"></div></div>`;
      const host = root.querySelector('[data-payroll-host]');
      if (!view) { host.innerHTML = `<div class="fmp-state" style="padding:48px;text-align:center;color:#667085">${esc(t('not_available', 'Nothing in Payroll is available to you here.'))}</div>`; return; }
      if (window.FirstMateWidgets?.mount) widget = window.FirstMateWidgets.mount(host, { id:widgetFor(view, context), version:'1', target:{ scope:'organization', organizationId:orgId } }, { ...context, surface:'dashboard' });
      else widget = createApp({ ...context, root:host, roots:{ main:host }, params:{ ...context.params, standalone:view } });
    }
    const click = (event) => {
      const button = event.target.closest('[data-payroll-view]');
      if (!button || !root.contains(button) || button.closest('[data-payroll-host]')) return;
      view = button.dataset.payrollView;
      render();
      window.Portal?.navigation?.navigate?.({ tab:'payroll', payrollView:view }, { source:'payroll-tab', ownedKeys:['payrollView'] });
    };
    const unregister = window.Portal?.navigation?.registerHandler?.(`payroll-tab:${context.instanceId || 'main'}`, { priority:400, apply:(route) => {
      if (context.params?.standalone || route.tab !== 'payroll') return;
      const next = window.AppChrome.resolve('payroll', route.payrollView, context);
      if (next !== view) { view = next; render(); }
    } });
    const layout = () => { if (context.params?.standalone) return; view = window.AppChrome.resolve('payroll', window.Portal?.navigation?.read?.().payrollView, context); render(); };
    root.addEventListener('click', click);
    window.addEventListener('fm:app-placements:updated', layout);
    render();
    // Someone without payroll management sees Approvals only while a pay run is waiting for them.
    if (!allows('view.runs', context) && feature('apps.payroll') && window.PayrollAPI?.approvals?.mine && orgId) {
      window.PayrollAPI.approvals.mine(orgId).then((result) => {
        const before = approvalsSeen.get(orgId);
        approvalsSeen.set(orgId, num(result?.count));
        if (alive && before !== num(result?.count)) layout();
      }).catch(() => {});
    }
    return {
      destroy(){ alive = false; widget?.destroy?.(); unregister?.(); root.removeEventListener('click', click); window.removeEventListener('fm:app-placements:updated', layout); root.replaceChildren(); },
      setActive(value){ widget?.setVisible?.(value); widget?.setActive?.(value); },
      refresh(){ return widget?.refresh?.(); },
      update(next){ context = { ...context, ...next }; render(); }
    };
  }

  window.FirstMatePayroll = { mountView:createApp, ACTIONS, allows, VIEWS:VIEWS.map(([id, title, needs]) => ({ id, title, needs })) };

  runtime.registerApp({
    id:'portal.payroll',
    package:'payroll',
    kind:'portal_tab',
    title:t('payroll', 'Payroll'),
    label:t('payroll', 'Payroll'),
    icon:'fa-money-check-dollar',
    order:55,
    surfaces:['portal_tab'],
    regions:['main'],
    visible:true,
    fullBleed:true,
    // Which views open is decided inside by permission and app flag (ACTIONS); who has the tab is App experience.
    mount:createTab
  });
  window.AppChrome.registerGroup({ id:'payroll', parent:'portal.payroll', title:t('payroll', 'Payroll'), icon:'fa-money-check-dollar', default:'upcoming',
    members:VIEWS.map(([id, title, needs, description]) => ({ id, title:t(`view_${id}`, title), description, available:(context) => allows(needs, context) })),
    mount:(view, context) => createTab({ ...context, params:{ ...context.params, standalone:view } }) });
})();
