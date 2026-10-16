/* public/libraries/apps/payroll/my-pay.js
 *
 * My pay: one person's own pay, the same everywhere it is shown. The Payroll app's My pay view, the field Earnings
 * tab (portal.crew_payouts), a project's Earnings tab (project.crew_payouts, that job only) and the sales Earnings
 * tab (portal.sales_earnings) all mount this. Who sees it is decided by the app that mounts it (its permission and
 * app flags); everything read here is the signed-in person's own, and the server refuses anything else.
 *
 *   const handle = FirstMateMyPay.mount(root, {
 *     orgId,
 *     projectId,          // one job only (project tab)
 *     projected,          // true: show the rule forecast; false: never; undefined: show it unless the server refuses
 *     timesheets,         // true / false / undefined (shown when the person has the time clock permission)
 *     presentation,       // 'commissions': commissions first, picked by earning kind
 *     title               // a heading; left out where the surrounding app already names the page
 *   });
 *   handle.refresh(); handle.destroy();
 *
 * Words: "Projected" is only ever the pay rule forecast of work not done yet. Ledger entries waiting for a
 * manager's review are "Held for review". Nothing that could not be worked out is shown as zero.
 */
(function(){
  'use strict';
  if (window.FirstMateMyPay) return;
  const clean = (value) => String(value ?? '').trim();
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const arr = (value) => Array.isArray(value) ? value : [];
  const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match]));
  const fill = (text, values) => String(text ?? '').replace(/\{(\w+)\}/g, (match, name) => (values && values[name] != null ? String(values[name]) : match));
  const t = (key, fallback, values) => { const readable = fill(fallback, values); return globalThis.PlatformLanguage?.text?.('payroll', key, readable, values) ?? readable; };
  const tip = (text) => (text ? ` data-fm-tooltip="${esc(text)}" title="${esc(text)}"` : '');
  const locale = () => globalThis.PlatformLanguage?.formatLocale?.() || undefined;
  const KINDS = { hourly:'Hourly', salary:'Salary', piece_rate:'Piece rate', commission:'Commission', reimbursement:'Reimbursement', adjustment:'Adjustment', clawback:'Clawback' };
  const kindLabel = (kind) => t(`kind_${kind}`, KINDS[kind] || clean(kind).replace(/_/g, ' '));
  function money(cents, currency = 'USD'){
    try { return new Intl.NumberFormat(locale(), { style:'currency', currency:clean(currency || 'USD').toUpperCase() }).format(num(cents) / 100); }
    catch (_) { return `${(num(cents) / 100).toFixed(2)} ${clean(currency || 'USD')}`; }
  }
  const signed = (cents, currency) => num(cents) < 0 ? `\u2212${money(Math.abs(num(cents)), currency)}` : money(cents, currency);
  function dateLabel(value, options = {}){
    const raw = clean(value);
    if (!raw) return '';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw);
    if (!Number.isFinite(date.getTime())) return raw;
    return new Intl.DateTimeFormat(locale(), { weekday:options.weekday ? 'short' : undefined, month:'short', day:'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year:'numeric' }) }).format(date);
  }
  const timeLabel = (value) => { const date = new Date(clean(value)); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(locale(), { hour:'numeric', minute:'2-digit' }).format(date) : ''; };
  const hours = (seconds) => { const total = Math.max(0, Math.round(num(seconds) / 60)); return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`; };
  const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const refused = (error) => Number(error?.status) === 403 || /denied|forbidden|not permitted|not shown|permission/i.test(clean(error?.code || error?.message));
  function hasPerm(key){
    if (typeof window.Portal?.util?.hasPerm === 'function') return window.Portal.util.hasPerm(key) === true;
    const permissions = obj(window.Portal?.currentUser?.permissions);
    return permissions[key] === true || (permissions['*'] === true && permissions[key] !== false);
  }

  function injectCss(){
    if (document.getElementById('fm_my_pay_css')) return;
    const style = document.createElement('style');
    style.id = 'fm_my_pay_css';
    style.textContent = `
      .mp{--mp-text:#101828;--mp-strong:#344054;--mp-muted:#667085;--mp-faint:#98a2b3;--mp-line:#e4e7ec;--mp-soft:#f8fafc;--mp-panel:#fff;--mp-ok:#067647;--mp-ok-bg:#ecfdf3;--mp-warn:#b54708;--mp-warn-bg:#fffaeb;--mp-danger:#b42318;
        container-type:inline-size;color:var(--mp-text);font-size:13px;line-height:1.35;box-sizing:border-box}
      .mp *{box-sizing:border-box}
      .mp-wrap{display:grid;gap:14px;max-width:1100px;margin:0 auto;padding:18px 22px 40px;min-width:0}
      .mp-title{margin:0;font-size:22px;font-weight:700}
      .mp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
      .mp-stat{display:grid;gap:3px;min-width:0;padding:13px 14px;border:1px solid var(--mp-line);border-radius:12px;background:var(--mp-panel)}
      .mp-stat>span{color:var(--mp-muted);font-size:12px;font-weight:600}
      .mp-stat>b{font-size:20px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mp-stat>small{color:var(--mp-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .mp-stat.warn>b{color:var(--mp-warn)}
      .mp-card{min-width:0;border:1px solid var(--mp-line);border-radius:12px;background:var(--mp-panel);overflow:hidden}
      .mp-card>header{display:flex;align-items:center;gap:8px;min-height:46px;padding:8px 16px;border-bottom:1px solid #eef0f3}
      .mp-card>header h2{margin:0;font-size:14px;font-weight:700}
      .mp-card>header .mp-count{color:var(--mp-muted);font-size:12.5px;font-weight:600;font-variant-numeric:tabular-nums}
      .mp-card.attention{border-color:#fedf89}
      .mp-card.attention>header{background:var(--mp-warn-bg)}
      .mp-empty{padding:16px;color:var(--mp-muted);font-size:12.5px}
      .mp-note{padding:10px 16px;color:var(--mp-muted);font-size:12px;border-top:1px solid #eef0f3}
      .mp-table{width:100%;border-collapse:collapse;font-size:12.5px}
      .mp-table th{padding:8px 12px;border-bottom:1px solid var(--mp-line);color:var(--mp-muted);font-size:11.5px;font-weight:650;text-align:left;white-space:nowrap;background:var(--mp-soft)}
      .mp-table td{padding:9px 12px;border-bottom:1px solid #eef0f3;color:var(--mp-strong);vertical-align:middle}
      .mp-table tbody tr:last-child td{border-bottom:0}
      .mp-table th:first-child,.mp-table td:first-child{padding-left:16px}
      .mp-table th:last-child,.mp-table td:last-child{padding-right:16px}
      .mp-table .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .mp-table .neg{color:var(--mp-danger)}
      .mp-name{display:grid;gap:1px;min-width:0}
      .mp-name>strong{font-weight:650;color:var(--mp-text)}
      .mp-name>small{color:var(--mp-muted);font-size:11.5px}
      .mp-pill{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:#f2f4f7;color:var(--mp-muted);font-size:10.5px;font-weight:700;white-space:nowrap}
      .mp-pill.ok{background:var(--mp-ok-bg);color:var(--mp-ok)}
      .mp-pill.warn{background:var(--mp-warn-bg);color:var(--mp-warn)}
      .mp-pill.danger{background:#fef3f2;color:var(--mp-danger)}
      .mp-reason{color:var(--mp-danger);font-size:12px}
      .mp-state{padding:40px 16px;text-align:center;color:var(--mp-muted)}
      @container (max-width:640px){
        .mp-wrap{padding:12px 12px 32px}
        .mp-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
        .mp-stat>b{font-size:17px}
        .mp-table .hide-sm{display:none}
        .mp-table.stack thead{display:none}
        .mp-table.stack,.mp-table.stack tbody{display:block;width:100%}
        .mp-table.stack tr{display:flex;flex-wrap:wrap;align-items:flex-end;gap:6px 16px;padding:10px 14px;border-bottom:1px solid #eef0f3}
        .mp-table.stack tbody tr:last-child{border-bottom:0}
        .mp-table.stack td{display:block;flex:1 1 26%;min-width:0;padding:0!important;border:0;text-align:left}
        .mp-table.stack td.num{text-align:left;white-space:normal}
        .mp-table.stack td[data-label]:not(.lead)::before{content:attr(data-label);display:block;margin-bottom:1px;color:var(--mp-faint);font-size:10.5px;font-weight:600}
        .mp-table.stack td.lead{flex-basis:100%}
      }
    `;
    document.head.appendChild(style);
  }

  const stat = (label, value, sub = '', tooltip = '', tone = '') => `<div class="mp-stat ${esc(tone)}"${tip(tooltip)} data-stat="${esc(label)}"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(sub)}</small></div>`;
  function card(id, title, tooltip, count, body, tone = ''){
    return `<section class="mp-card ${esc(tone)}" data-section="${esc(id)}"><header><h2${tip(tooltip)}>${esc(title)}</h2>${count === null ? '' : `<span class="mp-count">${esc(count)}</span>`}</header>${body}</section>`;
  }
  function table(columns, rows, empty){
    if (!rows.length) return `<div class="mp-empty">${esc(empty)}</div>`;
    const stack = columns.filter((column) => !String(column.cls || '').includes('hide-sm')).length > 3;
    return `<table class="mp-table${stack ? ' stack' : ''}"><thead><tr>${columns.map((column) => `<th class="${esc(column.cls || '')}">${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
  const td = (html, label = '', cls = '') => `<td class="${esc(cls)}"${label ? ` data-label="${esc(label)}"` : ''}>${html}</td>`;
  const name = (primary, secondary = '') => `<span class="mp-name"><strong>${esc(primary)}</strong>${secondary ? `<small>${esc(secondary)}</small>` : ''}</span>`;
  const pill = (label, tone = '') => `<span class="mp-pill ${esc(tone)}">${esc(label)}</span>`;
  function entryState(entry){
    if (clean(entry.state) === 'projected') return pill(t('held_for_review', 'Held for review'), 'warn');
    if (num(entry.remaining_cents) === 0 && num(entry.applied_cents) !== 0) return pill(t('in_a_pay_run', 'In a pay run'), 'ok');
    if (num(entry.applied_cents) !== 0) return pill(t('partly_in_run', 'Partly in a pay run'), 'ok');
    return pill(t('waiting_pay_run', 'Waiting for a pay run'));
  }

  function mount(root, options = {}){
    injectCss();
    const orgId = clean(options.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
    const projectId = clean(options.projectId);
    const commissions = options.presentation === 'commissions';
    let destroyed = false, token = 0;
    const data = { loading:true };
    const wantsTimesheets = () => options.timesheets === false ? false : options.timesheets === true || hasPerm('crew.time_clock.use');

    function render(){
      if (destroyed) return;
      const heading = options.title ? `<h1 class="mp-title">${esc(options.title)}</h1>` : '';
      if (data.loading) { root.innerHTML = `<div class="mp" data-my-pay><div class="mp-wrap">${heading}<div class="mp-state" role="status">${esc(t('loading', 'Loading\u2026'))}</div></div></div>`; return; }
      if (data.error) { root.innerHTML = `<div class="mp" data-my-pay><div class="mp-wrap">${heading}<div class="mp-state" role="alert">${esc(data.error)}</div></div></div>`; return; }
      const result = obj(data.result);
      const report = obj(result.earnings);
      const totals = obj(report.totals);
      const currency = clean(report.currency || 'USD');
      const entries = arr(report.entries);
      const held = entries.filter((entry) => clean(entry.state) === 'projected');
      const projection = data.projected ? obj(data.projected) : null;
      const forecast = projection ? arr(projection.earnings).filter((earning) => !projectId || clean(earning.project_id) === projectId) : [];
      const forecastUnresolved = projection ? arr(projection.unresolved).filter((entry) => !projectId || clean(entry.project_id) === projectId) : [];
      const forecastTotal = forecast.reduce((sum, earning) => sum + num(earning.amount_cents), 0);
      const next = obj(result.next_payment);
      const unresolved = projectId ? [] : arr(result.unresolved);
      const stats = [
        stat(t('earned_not_paid', 'Earned, not paid yet'), money(totals.owed_cents, currency), t('after_outside', 'After anything paid outside a pay run'), t('owed_tip', 'What you have earned that has not been paid yet.')),
        stat(t('next_pay_date', 'Next pay date'), next.pay_date ? dateLabel(next.pay_date, { weekday:true }) : t('not_set', 'Not set'), clean(next.schedule_name), t('next_pay_date_tip', 'The next day your pay schedule pays.')),
        stat(t('paid', 'Paid'), money(totals.paid_cents, currency), projectId ? t('for_this_job', 'For this job') : t('so_far', 'So far')),
        ...(projection ? [stat(t('projected', 'Projected'), money(forecastTotal, currency), t('from_work_not_done', 'From work not done yet'), t('projected_tip', 'What your pay rules say you can expect from work assigned to you and not done yet. It is paid once the work is done.'))] : []),
        ...(held.length ? [stat(t('held_for_review', 'Held for review'), signed(held.reduce((sum, entry) => sum + num(entry.amount_cents), 0), currency), t('held_sub', 'Waiting for your manager'), t('held_tip', 'A change to something already paid that your manager is reviewing. It does not count until they accept it.'), 'warn')] : [])
      ].join('');
      const attention = unresolved.length ? card('attention', t('not_worked_out', 'Not worked out yet'), t('not_worked_out_tip', 'Something about your pay could not be worked out. It is not counted as zero: payroll is looking at it.'), unresolved.length,
        table([{ label:t('what', 'What') }, { label:t('why', 'Why') }], unresolved.map((item) => `<tr>${td(name(clean(item.rule_name), item.whole_rule ? '' : dateLabel(item.earned_at)), t('what', 'What'), 'lead')}${td(`<span class="mp-reason">${esc(item.reason)}</span>`, t('why', 'Why'))}</tr>`), ''), 'attention') : '';
      const commissionEntries = entries.filter((entry) => ['commission', 'clawback'].includes(clean(entry.kind)) && clean(entry.state) !== 'projected');
      const commissionCard = commissions ? card('commissions', t('commissions', 'Commissions'), t('commissions_tip', 'Every commission and clawback on your deals, newest first.'), commissionEntries.length,
        table([{ label:t('deal', 'Deal') }, { label:t('earned_on', 'Earned on') }, { label:t('status', 'Status') }, { label:t('amount', 'Amount'), cls:'num' }], commissionEntries.slice(0, 100).map((entry) => `<tr>${td(name(clean(entry.project_title) || clean(entry.description) || kindLabel(entry.kind), clean(entry.kind) === 'clawback' ? kindLabel('clawback') : clean(entry.description)), t('deal', 'Deal'), 'lead')}${td(esc(dateLabel(entry.eligible_at)), t('earned_on', 'Earned on'))}${td(entryState(entry), t('status', 'Status'))}${td(esc(signed(entry.amount_cents, entry.currency || currency)), t('amount', 'Amount'), `num${num(entry.amount_cents) < 0 ? ' neg' : ''}`)}</tr>`), t('no_commissions', 'No commissions yet.'))) : '';
      const owedProjects = arr(report.projects).filter((project) => num(obj(project.totals).owed_cents) > 0);
      const earnedCard = projectId
        ? card('on-this-job', t('on_this_job', 'Earned on this job'), t('on_this_job_tip', 'Everything you earned on this job and where each part stands.'), entries.filter((entry) => clean(entry.state) !== 'projected').length,
          table([{ label:t('earning', 'Earning') }, { label:t('kind', 'Kind') }, { label:t('status', 'Status') }, { label:t('amount', 'Amount'), cls:'num' }], entries.filter((entry) => clean(entry.state) !== 'projected').slice(0, 100).map((entry) => `<tr>${td(name(clean(entry.description) || kindLabel(entry.kind), dateLabel(entry.eligible_at)), t('earning', 'Earning'), 'lead')}${td(esc(kindLabel(entry.kind)), t('kind', 'Kind'))}${td(entryState(entry), t('status', 'Status'))}${td(esc(signed(entry.amount_cents, entry.currency || currency)), t('amount', 'Amount'), `num${num(entry.amount_cents) < 0 ? ' neg' : ''}`)}</tr>`), t('nothing_on_job', 'You have not earned anything on this job yet.')))
        : card('owed', t('earned_not_paid', 'Earned, not paid yet'), t('owed_by_job_tip', 'By job: what you earned that is waiting for a pay run.'), owedProjects.length,
          table([{ label:t('job', 'Job') }, { label:t('owed', 'Owed'), cls:'num' }], owedProjects.map((project) => `<tr>${td(esc(clean(project.title) || t('other_earnings', 'Other earnings')), t('job', 'Job'), 'lead')}${td(`<b>${esc(money(obj(project.totals).owed_cents, project.currency || currency))}</b>`, t('owed', 'Owed'), 'num')}</tr>`), t('nothing_owed', 'Nothing is waiting to be paid.')));
      const forecastCard = projection ? card('projected', t('projected', 'Projected'), t('projected_tip', 'What your pay rules say you can expect from work assigned to you and not done yet. It is paid once the work is done.'), forecast.length,
        table([{ label:t('job', 'Job') }, { label:t('expected', 'Expected') }, { label:t('amount', 'Amount'), cls:'num' }], [
          ...forecast.map((earning) => `<tr>${td(name(clean(earning.project_title) || clean(earning.record_title) || t('work', 'Work'), clean(earning.share_of?.payee_name) ? t('share_of_group', 'Your share of what {name} earns', { name:earning.share_of.payee_name }) : clean(earning.description)), t('job', 'Job'), 'lead')}${td(esc(earning.expected_on ? dateLabel(earning.expected_on) : t('not_scheduled', 'Not scheduled')), t('expected', 'Expected'))}${td(esc(money(earning.amount_cents, currency)), t('amount', 'Amount'), 'num')}</tr>`),
          ...forecastUnresolved.map((entry) => `<tr>${td(name(clean(entry.project_title) || t('work', 'Work'), clean(entry.reason)), t('job', 'Job'), 'lead')}${td(esc(entry.expected_on ? dateLabel(entry.expected_on) : t('not_scheduled', 'Not scheduled')), t('expected', 'Expected'))}${td(`<span class="mp-reason"${tip(t('not_zero', 'Not worked out, not zero'))}>${esc(t('not_worked_out_short', 'Not worked out'))}</span>`, t('amount', 'Amount'), 'num')}</tr>`)
        ], t('nothing_projected', 'Nothing is projected for you.'))) : '';
      const heldCard = held.length ? card('held', t('held_for_review', 'Held for review'), t('held_tip', 'A change to something already paid that your manager is reviewing. It does not count until they accept it.'), held.length,
        table([{ label:t('what', 'What') }, { label:t('amount', 'Amount'), cls:'num' }], held.map((entry) => `<tr>${td(name(clean(entry.description) || kindLabel(entry.kind), clean(entry.project_title)), t('what', 'What'), 'lead')}${td(esc(signed(entry.amount_cents, entry.currency || currency)), t('amount', 'Amount'), `num${num(entry.amount_cents) < 0 ? ' neg' : ''}`)}</tr>`), '')) : '';
      const statusLabel = { paid:[t('paid', 'Paid'), 'ok'], run:[t('being_paid', 'Being paid'), ''], draft:[t('in_a_pay_run', 'In a pay run'), ''] };
      // In a project, only the pay runs that paid something for this job.
      const payments = arr(report.payments).filter((payment) => !projectId || num(payment.amount_cents) !== 0);
      const runsCard = card('payments', t('pay_runs', 'Pay runs'), t('pay_runs_tip', 'Pay runs that paid you, or are paying you.'), payments.length,
        table([{ label:t('pay_date', 'Pay date') }, { label:t('schedule', 'Schedule'), cls:'hide-sm' }, { label:t('status', 'Status') }, { label:t('amount', 'Amount'), cls:'num' }], payments.map((payment) => `<tr>${td(esc(dateLabel(payment.pay_date)), t('pay_date', 'Pay date'), 'lead')}${td(esc(clean(payment.schedule?.name)), t('schedule', 'Schedule'), 'hide-sm')}${td(pill(...(statusLabel[payment.status] || [clean(payment.status)])), t('status', 'Status'))}${td(esc(money(projectId ? payment.amount_cents : payment.net_cents, payment.currency || currency)), t('amount', 'Amount'), 'num')}</tr>`), t('no_payments', 'No pay run has paid you yet.')));
      const outside = arr(report.off_cycle_payments);
      const outsideCard = projectId ? '' : card('outside', t('paid_outside', 'Paid outside a pay run'), t('paid_outside_tip', 'Payments made to you outside a pay run. Your next pay run takes each off, so nothing is paid twice.'), outside.length,
        table([{ label:t('paid_on', 'Paid on') }, { label:t('kind', 'Kind'), cls:'hide-sm' }, { label:t('reference', 'Reference'), cls:'hide-sm' }, { label:t('amount', 'Amount'), cls:'num' }], outside.map((payment) => `<tr>${td(esc(dateLabel(payment.paid_on)), t('paid_on', 'Paid on'), 'lead')}${td(esc(kindLabel(payment.kind)), t('kind', 'Kind'), 'hide-sm')}${td(esc(clean(payment.reference) || '\u2014'), t('reference', 'Reference'), 'hide-sm')}${td(esc(money(payment.amount_cents, payment.currency || currency)), t('amount', 'Amount'), 'num')}</tr>`), t('none_outside', 'Nothing has been paid to you outside a pay run.')));
      const shifts = arr(data.timesheets?.timesheets).filter((shift) => !projectId || clean(shift.project_id) === projectId);
      const statusOf = (shift) => clean(shift.status) === 'active' ? pill(t('on_the_clock', 'On the clock')) : ({ approved:pill(t('approved', 'Approved'), 'ok'), rejected:pill(t('rejected', 'Rejected'), 'danger') })[clean(shift.approval_status)] || pill(t('needs_approval', 'Needs approval'), 'warn');
      const timeCard = data.timesheets ? card('timesheets', t('my_timesheets', 'My timesheets'), t('my_timesheets_tip', 'Your clocked shifts in the last two weeks and whether each was approved.'), `${shifts.length} \u00b7 ${hours(shifts.reduce((sum, shift) => sum + (clean(shift.status) === 'closed' ? num(shift.worked_seconds) : 0), 0))}`,
        table([{ label:t('day', 'Day') }, { label:t('in_out', 'In \u2013 out') }, { label:t('worked', 'Worked'), cls:'num' }, { label:t('project', 'Project'), cls:projectId ? 'hide-sm' : '' }, { label:t('status', 'Status') }], shifts.map((shift) => `<tr>${td(esc(dateLabel(shift.clocked_in_at, { weekday:true })), t('day', 'Day'), 'lead')}${td(esc(`${timeLabel(shift.clocked_in_at)} \u2013 ${shift.clocked_out_at ? timeLabel(shift.clocked_out_at) : t('now', 'now')}`), t('in_out', 'In \u2013 out'))}${td(clean(shift.status) === 'closed' ? esc(hours(shift.worked_seconds)) : '\u2014', t('worked', 'Worked'), 'num')}${td(esc(clean(shift.project?.title) || '\u2014'), t('project', 'Project'), projectId ? 'hide-sm' : '')}${td(statusOf(shift), t('status', 'Status'))}</tr>`), t('no_shifts', 'No shifts in the last two weeks.'))) : '';
      root.innerHTML = `<div class="mp" data-my-pay${projectId ? ` data-project="${esc(projectId)}"` : ''}><div class="mp-wrap">${heading}<div class="mp-stats">${stats}</div>${attention}${commissionCard}${earnedCard}${forecastCard}${heldCard}${runsCard}${outsideCard}${timeCard}${result.truncated ? `<div class="mp-note">${esc(t('truncated', 'Showing your newest records.'))}</div>` : ''}</div></div>`;
    }

    async function load(){
      const api = window.PayrollAPI;
      const current = ++token;
      if (!api?.earnings?.me) { data.loading = false; data.error = t('unavailable', 'Your pay could not be loaded.'); render(); return; }
      const today = new Date();
      const from = new Date(today.getTime() - 13 * 86400000);
      const [mine, projected, timesheets] = await Promise.all([
        api.earnings.me(orgId, { ...(projectId ? { project_id:projectId } : {}), payment_limit:50 }).then((value) => ({ value })).catch((error) => ({ error })),
        options.projected === false || !api.earnings.projectedMine ? null : api.earnings.projectedMine(orgId).then((value) => ({ value })).catch((error) => ({ error })),
        !wantsTimesheets() || !api.timesheets?.mine ? null : api.timesheets.mine(orgId, { from:dayKey(from), through:dayKey(today) }).then((value) => ({ value })).catch((error) => ({ error }))
      ]);
      if (destroyed || current !== token) return;
      data.loading = false;
      data.error = mine.error ? clean(mine.error.message) || t('unavailable', 'Your pay could not be loaded.') : '';
      data.result = mine.value;
      // A projection or timesheets this person may not see are simply not shown.
      data.projected = projected?.value ? obj(projected.value).projected || projected.value : null;
      if (projected?.error && !refused(projected.error)) data.projected = { earnings:[], unresolved:[{ reason:clean(projected.error.message) }] };
      data.timesheets = timesheets?.value || null;
      render();
    }
    const onUpdated = () => { void load(); };
    window.addEventListener('fm:payroll:updated', onUpdated);
    render();
    void load();
    return {
      refresh:load,
      destroy(){ destroyed = true; token++; window.removeEventListener('fm:payroll:updated', onUpdated); root.innerHTML = ''; }
    };
  }

  window.FirstMateMyPay = { mount };
})();
