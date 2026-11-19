/* libraries/payments-widgets/payments-widgets.js
 * Payouts and disputes (GP-76): one widget each, the same in Financials
 * (Payouts, Disputes) and in Settings › Money (Payouts, Disputes).
 *
 *   const widget = FirstMatePaymentsWidgets.mountPayouts(host, { orgId, onOpenProject, onOpenInvoice, onOpenDisputes });
 *   const widget = FirstMatePaymentsWidgets.mountDisputes(host, { orgId, onOpenProject });
 *   widget.refresh(); widget.destroy();
 *
 * Disputes come from the processor (Forward): the widget pulls them on open
 * (POST …/disputes/sync). Forward has no API to answer a dispute, so the
 * company writes its response here and FirstMate staff file it in Forward's
 * portal (docs/architecture/payments.md, "Disputes").
 */
(function(){
  if (window.FirstMatePaymentsWidgets) return;
  const NS = 'financials';

  function clean(value){ return String(value ?? '').trim(); }
  function object(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function array(value){ return Array.isArray(value) ? value : []; }
  function number(value){ const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  }
  function fill(text, values){ return values ? String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match)) : String(text); }
  // Copy is catalogued under the financials namespace (catalog-source.json).
  function t(key, text, values){
    const fallback = fill(text, values);
    return globalThis.PlatformLanguage?.text?.(NS, key, fallback, values) ?? fallback;
  }
  function h(key, text, values){ return esc(t(key, text, values)); }

  function locale(){ return globalThis.PlatformLanguage?.formatLocale?.('en-US') || 'en-US'; }
  function money(cents, currency = 'USD'){
    const value = number(cents);
    try {
      return new Intl.NumberFormat(locale(), {
        style:'currency', currency:clean(currency).toUpperCase() || 'USD',
        minimumFractionDigits:value % 100 === 0 ? 0 : 2, maximumFractionDigits:2
      }).format(value / 100);
    } catch (_) { return `$${(value / 100).toFixed(2)}`; }
  }
  // Forward sends calendar dates (YYYY-MM-DD): read them as local days, not UTC midnight.
  function toDate(value){
    const raw = clean(value);
    if (!raw) return null;
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const result = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(raw);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  function dateLabel(value, fallback = '—'){
    const result = toDate(value);
    return result ? result.toLocaleDateString(locale(), { month:'short', day:'numeric', year:'numeric' }) : fallback;
  }
  function daysUntil(value){
    const result = toDate(value);
    if (!result) return null;
    const end = new Date(result.getFullYear(), result.getMonth(), result.getDate(), 23, 59, 59);
    return Math.ceil((end.getTime() - Date.now()) / 86_400_000) - 1;
  }

  function api(){
    const client = window.PaymentsAPI;
    if (!client?.request) throw new Error(t('m_0243634a51f011', 'Payments are unavailable right now.'));
    return client;
  }
  function orgPath(orgId, path){ return `/organizations/${encodeURIComponent(clean(orgId))}${path}`; }
  function call(orgId, path, options = {}){ return api().request(orgPath(orgId, path), options); }
  function fileUrl(path){ return api().url(path); }

  // The portal replaces confirm and prompt with versions that return a promise; plain pages return the answer.
  async function ask(kind, message, value = ''){
    return await Promise.resolve(kind === 'prompt' ? window.prompt(message, value) : window.confirm(message));
  }

  function toast(title, message, ok = true){
    const show = window.Portal?.ui?.showToast || window.showToast;
    if (typeof show === 'function') show(title, message, ok);
  }

  // --- Styles -----------------------------------------------------------------

  function injectCss(){
    if (document.getElementById('firstmate-payments-widgets-css')) return;
    const style = document.createElement('style');
    style.id = 'firstmate-payments-widgets-css';
    style.textContent = `
      .pmw{display:flex;flex-direction:column;gap:14px;color:#101828;font-size:12px;min-width:0}
      .pmw *{box-sizing:border-box}
      .pmw button{font:inherit}
      .pmw-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
      .pmw-metric{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:12px 13px;min-width:0}
      .pmw-metric.pmw-click{cursor:pointer}.pmw-metric.pmw-click:hover{border-color:#98a2b3}
      .pmw-metric-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#667085;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .pmw-metric-label i{color:#98a2b3}
      .pmw-metric strong{display:block;margin-top:8px;font-size:21px;line-height:1;letter-spacing:-.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pmw-good{color:#067647!important}.pmw-bad{color:#b42318!important}.pmw-blue{color:#175cd3!important}.pmw-purple{color:#6941c6!important}
      .pmw-card{background:#fff;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;min-width:0}
      .pmw-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid #eaecf0}
      .pmw-card-head h2{margin:0;font-size:13px;display:flex;align-items:center;gap:7px}
      .pmw-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .pmw-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:6px 10px;font-weight:850;font-size:10px;line-height:1;cursor:pointer;white-space:nowrap}
      .pmw-chip:hover{border-color:#98a2b3}.pmw-chip.active{border-color:#101828;background:#101828;color:#fff}
      .pmw-chip small{font-weight:800;opacity:.7;margin-left:4px}
      .pmw-btn{min-height:32px;padding:6px 11px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-weight:850;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;white-space:nowrap}
      .pmw-btn:hover:not(:disabled){border-color:#98a2b3;background:#f9fafb}.pmw-btn:disabled{opacity:.55;cursor:default}
      .pmw-btn.primary{background:var(--primary-readable,var(--primary,#101828));border-color:var(--primary-readable,var(--primary,#101828));color:#fff}
      .pmw-btn.primary:hover:not(:disabled){filter:brightness(.95);background:var(--primary-readable,var(--primary,#101828))}
      .pmw-btn.danger{color:#b42318}
      .pmw-icon-btn{width:32px;padding:0}
      .pmw-table-wrap{overflow:auto}
      .pmw-table{width:100%;border-collapse:collapse;min-width:640px}
      .pmw-table th,.pmw-table td{padding:9px 12px;border-bottom:1px solid #f0f2f5;text-align:left;font-size:11px;vertical-align:middle}
      .pmw-table th{background:#f9fafb;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
      .pmw-table tr:last-child td{border-bottom:0}
      .pmw-table tbody tr[data-pmw-row]{cursor:pointer}.pmw-table tbody tr[data-pmw-row]:hover{background:#f9fafb}
      .pmw-right{text-align:right!important;white-space:nowrap}
      .pmw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
      .pmw-sub{display:block;margin-top:2px;color:#667085;font-size:9.5px;font-weight:750}
      .pmw-muted{color:#98a2b3;font-weight:750}
      .pmw-link{border:0;background:transparent;padding:0;color:#175cd3;font-weight:850;font-size:11px;cursor:pointer;text-align:left}
      .pmw-link:hover{text-decoration:underline}
      .pmw-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 8px;font-size:9.5px;font-weight:900;background:#f2f4f7;color:#475467;white-space:nowrap}
      .pmw-badge.good{background:#ecfdf3;color:#067647}.pmw-badge.info{background:#eff8ff;color:#175cd3}.pmw-badge.warn{background:#fffaeb;color:#b54708}.pmw-badge.bad{background:#fef3f2;color:#b42318}
      .pmw-due{font-weight:850}.pmw-due.soon{color:#b42318}.pmw-due.past{color:#98a2b3}
      .pmw-empty{padding:30px 16px;text-align:center;color:#667085}
      .pmw-empty i{display:block;font-size:20px;margin-bottom:8px;color:#98a2b3}
      .pmw-empty strong{display:block;color:#344054;font-size:12.5px}
      .pmw-empty span{display:block;margin-top:4px;font-size:11px}
      .pmw-note{display:flex;align-items:flex-start;gap:9px;border-radius:10px;padding:10px 12px;font-size:11.5px;font-weight:750;line-height:1.45;background:#f9fafb;border:1px solid #eaecf0;color:#475467}
      .pmw-note i{margin-top:2px}
      .pmw-note.warn{background:#fffaeb;border-color:#fedf89;color:#93370d}
      .pmw-note.info{background:#eff8ff;border-color:#b2ddff;color:#194185}
      .pmw-note.good{background:#ecfdf3;border-color:#abefc6;color:#05603a}
      .pmw-note.bad{background:#fef3f2;border-color:#fecdca;color:#912018}
      .pmw-note strong{display:block;margin-bottom:2px}
      .pmw-tip{display:inline-grid;place-items:center;width:15px;height:15px;padding:0;border:1px solid #98a2b3;border-radius:50%;background:none;color:#667085;font:italic 10px Georgia,serif;cursor:help;vertical-align:middle;flex:0 0 auto}
      .pmw-spin{animation:pmw-spin 1s linear infinite}@keyframes pmw-spin{to{transform:rotate(360deg)}}
      .pmw-shade{position:fixed;inset:0;z-index:2147483200;background:rgba(16,24,40,.5);display:grid;place-items:center;padding:18px}
      .pmw-modal{width:min(820px,96vw);max-height:92vh;overflow:auto;border-radius:14px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.4)}
      .pmw-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #eaecf0}
      .pmw-modal-head strong{font-size:14px}
      .pmw-modal-body{padding:14px 16px;display:grid;gap:12px}
      .pmw-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:9px}
      .pmw-stat{border:1px solid #eaecf0;border-radius:10px;padding:9px 11px;min-width:0}
      .pmw-stat span{display:block;color:#667085;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
      .pmw-stat strong{display:block;margin-top:5px;font-size:15px;letter-spacing:-.02em;overflow-wrap:anywhere}
      .pmw-detail{display:grid;gap:12px}
      .pmw-detail-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .pmw-detail-title{flex:1;min-width:180px}
      .pmw-detail-title strong{display:block;font-size:17px;letter-spacing:-.02em}
      .pmw-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0;border:1px solid #eaecf0;border-radius:10px;overflow:hidden;margin:0}
      .pmw-fact{padding:9px 12px;border-bottom:1px solid #f0f2f5;border-right:1px solid #f0f2f5;min-width:0}
      .pmw-fact dt{color:#667085;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center;gap:5px}
      .pmw-fact dd{margin:4px 0 0;font-weight:850;font-size:11.5px;overflow-wrap:anywhere}
      .pmw-section{border:1px solid #eaecf0;border-radius:10px;padding:12px 13px;display:grid;gap:11px;background:#fff}
      .pmw-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
      .pmw-section-head h3{margin:0;font-size:12.5px;display:flex;align-items:center;gap:7px}
      .pmw-choice{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
      .pmw-choice button{display:flex;align-items:flex-start;gap:9px;text-align:left;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:10px 11px;cursor:pointer;color:#344054}
      .pmw-choice button i{margin-top:2px;color:#667085}
      .pmw-choice button strong{display:block;font-size:12px;color:#101828}
      .pmw-choice button span{display:block;margin-top:2px;font-size:10.5px;font-weight:700;color:#667085;line-height:1.35}
      .pmw-choice button.active{border-color:var(--primary-readable,var(--primary,#101828));box-shadow:0 0 0 1px var(--primary-readable,var(--primary,#101828)) inset;background:rgba(var(--primary-rgb,16,24,40),.04)}
      .pmw-choice button.active i{color:var(--primary-readable,var(--primary,#101828))}
      .pmw-field{display:grid;gap:5px;min-width:0}
      .pmw-field-label{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:900;color:#344054}
      .pmw-field input,.pmw-field select,.pmw-field textarea{width:100%;border:1px solid #d0d5dd;border-radius:8px;padding:7px 9px;font:inherit;font-size:12px;color:#101828;background:#fff}
      .pmw-field textarea{min-height:64px;resize:vertical;line-height:1.45}
      .pmw-field input[type=date]{max-width:180px}
      .pmw-field select{max-width:280px}
      .pmw-field input:disabled,.pmw-field select:disabled,.pmw-field textarea:disabled{background:#f9fafb;color:#475467}
      .pmw-fields{display:grid;gap:10px}
      .pmw-files{display:grid;gap:6px}
      .pmw-file{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(120px,190px) auto;gap:8px;align-items:center;border:1px solid #eaecf0;border-radius:9px;padding:6px 8px}
      .pmw-file > i{color:#667085}
      .pmw-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800}
      .pmw-file input{border:1px solid #d0d5dd;border-radius:7px;padding:5px 7px;font:inherit;font-size:11px;width:100%}
      .pmw-suggest{display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:10.5px;color:#667085;font-weight:750}
      .pmw-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .pmw-actions .pmw-status{margin-right:auto;color:#667085;font-size:11px;font-weight:750}
      .pmw-history{display:grid;gap:4px;font-size:10.5px;color:#667085;font-weight:750}
      .pmw-filed-text{white-space:pre-wrap;font-size:11.5px;line-height:1.5;margin:0}
      @media(max-width:640px){.pmw-choice{grid-template-columns:1fr}.pmw-file{grid-template-columns:auto minmax(0,1fr) auto}.pmw-file input{grid-column:2/4}.pmw-metric strong{font-size:18px}}
    `;
    document.head.appendChild(style);
  }

  function infoTip(text){
    return `<button type="button" class="pmw-tip" aria-label="${esc(text)}" title="${esc(text)}" data-fm-tooltip="${esc(text)}">i</button>`;
  }

  function stateHtml(icon, title, text = '', spin = false){
    return `<div class="pmw-empty"><i class="fas ${icon}${spin ? ' pmw-spin' : ''}"></i><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  }

  // --- Payouts ------------------------------------------------------------------

  const PAYOUT_FILTERS = ['all', 'created', 'pended', 'held', 'completed', 'failed', 'returned'];

  function payoutBadge(status){
    const value = clean(status).toLowerCase() || 'created';
    const cls = value === 'completed' ? 'good'
      : ['failed', 'returned', 'cancelled'].includes(value) ? 'bad'
        : value === 'held' ? 'warn'
          : 'info';
    return `<span class="pmw-badge ${cls}">${esc(value.replace(/_/g, ' '))}</span>`;
  }

  function mountPayouts(host, options = {}){
    injectCss();
    const state = { orgId:clean(options.orgId), filter:'all', data:null, loading:true, error:null, detail:null, destroyed:false, token:0 };
    const root = document.createElement('div');
    root.className = 'pmw pmw-payouts';
    root.dataset.paymentsWidget = 'payouts';
    host.replaceChildren(root);

    async function load(){
      const token = ++state.token;
      state.loading = !state.data;
      state.error = null;
      render();
      try {
        const client = api();
        const [summary, payouts] = await Promise.all([client.finance.summary(state.orgId), client.payouts.list(state.orgId)]);
        if (state.destroyed || token !== state.token) return;
        state.data = { summary:object(summary?.summary), payouts:array(payouts?.payouts) };
      } catch (error) {
        if (state.destroyed || token !== state.token) return;
        state.error = error;
      }
      state.loading = false;
      render();
    }

    function metricsHtml(){
      const summary = object(state.data?.summary);
      const next = object(summary.next_expected_payout);
      const openDisputes = number(summary.disputes_open_count);
      const rate = number(summary.effective_rate_bps) / 100;
      const tile = (key, label, icon, value, cls, tip, extra = '') => `<div class="pmw-metric${extra}" data-pmw-tile="${key}" title="${esc(tip)}"><span class="pmw-metric-label">${esc(label)}<i class="fas ${icon}"></i></span><strong class="${cls}">${value}</strong></div>`;
      return `<section class="pmw-metrics">
        ${tile('balance_pending', t('m_becdcc8cbaa176', 'Pending sweep'), 'fa-wallet', esc(money(summary.balance_pending_cents)), '', t('m_3f21d8055c5d00', 'Captured payments awaiting the next batch'))}
        ${tile('in_transit', t('m_ca8ccb0cd0c3a8', 'In transit'), 'fa-building-columns', esc(money(summary.in_transit_cents)), 'pmw-blue', t('m_bbe4da53a62b2d', 'Batched and on the way to your bank'))}
        ${tile('paid_out_30d', t('m_d2dc5ad9c103dd', 'Paid out (30d)'), 'fa-circle-check', esc(money(summary.paid_out_30d_cents)), 'pmw-good', t('m_799e9b77e1dc9a', 'Arrived at the bank in the last 30 days'))}
        ${tile('fees_30d', t('m_0e253de628063a', 'Fees (30d)'), 'fa-percent', esc(money(summary.fees_30d_cents)), number(summary.fees_30d_cents) ? 'pmw-bad' : '', number(summary.gross_30d_cents) ? t('m_18a9cfec7e01b1', 'Effective rate {rate}% on {gross}', { rate:rate.toFixed(2), gross:money(summary.gross_30d_cents) }) : t('m_23169756b7879f', 'No processed volume yet'))}
        ${tile('next_payout', t('m_7ed3e155de203d', 'Next payout'), 'fa-calendar-day', clean(next.payout_id) ? esc(money(next.amount_cents)) : '—', 'pmw-purple', clean(next.payout_id) ? (clean(next.expected_arrival_at) ? t('m_24933113d39b41', 'Expected {date}', { date:dateLabel(next.expected_arrival_at) }) : t('m_f0e56ce95c4d46', 'Arrival date pending')) : t('m_6f1517d0879dec', 'No payout scheduled'))}
        ${tile('open_disputes', t('m_a96c7e54509a11', 'Open disputes'), 'fa-scale-balanced', esc(String(openDisputes)), openDisputes ? 'pmw-bad' : '', openDisputes ? t('m_c531bb64c7da54', 'Respond before the deadline to fight them') : t('m_19fcb2d5ada4c1', 'No open chargebacks'), typeof options.onOpenDisputes === 'function' ? ' pmw-click' : '')}
      </section>`;
    }

    function rowHtml(payout){
      const count = array(payout.transaction_ids).length || array(payout.provider_payment_ids).length;
      return `<tr data-pmw-row="${esc(payout.id)}" tabindex="0">
        <td><span class="pmw-mono">${esc(clean(payout.provider_payout_id) || clean(payout.id))}</span><span class="pmw-sub">${esc(dateLabel(payout.created_at))}</span></td>
        <td>${payoutBadge(payout.status)}</td>
        <td class="pmw-right"><strong>${esc(money(payout.amount_cents, payout.currency))}</strong></td>
        <td class="pmw-right">${esc(money(payout.fee_cents, payout.currency))}</td>
        <td>${clean(payout.expected_arrival_at) ? esc(dateLabel(payout.expected_arrival_at)) : '<span class="pmw-muted">—</span>'}</td>
        <td>${clean(payout.arrived_at) ? esc(dateLabel(payout.arrived_at)) : `<span class="pmw-muted">${h('m_8e048627901567', 'Not arrived')}</span>`}</td>
        <td class="pmw-right">${count}</td>
      </tr>`;
    }

    function listHtml(){
      const payouts = array(state.data?.payouts);
      const filtered = state.filter === 'all' ? payouts : payouts.filter((payout) => clean(payout.status).toLowerCase() === state.filter);
      const countFor = (key) => key === 'all' ? payouts.length : payouts.filter((payout) => clean(payout.status).toLowerCase() === key).length;
      const chips = PAYOUT_FILTERS.filter((key) => key === 'all' || key === state.filter || countFor(key))
        .map((key) => `<button type="button" class="pmw-chip ${state.filter === key ? 'active' : ''}" data-pmw-filter="${esc(key)}">${key === 'all' ? h('m_61df468d92e238', 'All') : esc(key)}<small>${countFor(key)}</small></button>`).join('');
      const body = filtered.length
        ? `<div class="pmw-table-wrap"><table class="pmw-table"><thead><tr><th>${h('m_47196f1d949c20', 'Payout')}</th><th>${h('m_1352cafa75b8da', 'Status')}</th><th class="pmw-right">${h('m_2b8c3448fa87a1', 'Amount')}</th><th class="pmw-right">${h('m_6c208c0cd6af0f', 'Fees')}</th><th>${h('m_c6aef2a3790870', 'Expected arrival')}</th><th>${h('m_b7ee7c97c74f9b', 'Arrived')}</th><th class="pmw-right">${h('m_ad68f8741d9002', 'Transactions')}</th></tr></thead><tbody>${filtered.map(rowHtml).join('')}</tbody></table></div>`
        : payouts.length ? stateHtml('fa-filter', t('m_f380e9e06ef4c2', 'No payouts match this filter'), t('m_b759a25796c125', 'Try another status.'))
          : stateHtml('fa-money-bill-transfer', t('m_7d3d62ef16a1b9', 'No payouts yet'), t('m_ecc1491e849fb1', 'Payouts will appear once payment processing is live.'));
      return `<section class="pmw-card"><div class="pmw-card-head"><h2>${h('m_e06874e8b912d9', 'Payouts')} ${infoTip(t('m_2e930010f0998a', 'Batches swept from your processing balance to the bank, newest first.'))}</h2><div class="pmw-chips" role="group" aria-label="${h('m_5bcdc053c26110', 'Payout status filter')}">${chips}</div></div>${body}</section>`;
    }

    function detailHtml(){
      const detail = state.detail;
      if (!detail) return '';
      const payout = object(detail.payout);
      const transactions = array(detail.transactions);
      const body = detail.loading ? stateHtml('fa-circle-notch', t('m_abe6a9e399dd32', 'Loading payout'), '', true)
        : detail.error ? stateHtml('fa-triangle-exclamation', t('m_ec28130f32485c', 'Payout could not load'), clean(detail.error?.message || detail.error))
          : `<div class="pmw-stats">
              <div class="pmw-stat"><span>${h('m_c87aa4a42612df', 'Amount to bank')}</span><strong>${esc(money(payout.amount_cents, payout.currency))}</strong></div>
              <div class="pmw-stat"><span>${h('m_fcc3723f722f18', 'Processing fees')}</span><strong>${esc(money(payout.fee_cents, payout.currency))}</strong></div>
              <div class="pmw-stat"><span>${h('m_c6aef2a3790870', 'Expected arrival')}</span><strong>${esc(dateLabel(payout.expected_arrival_at))}</strong></div>
              <div class="pmw-stat"><span>${h('m_b7ee7c97c74f9b', 'Arrived')}</span><strong>${clean(payout.arrived_at) ? esc(dateLabel(payout.arrived_at)) : h('m_97fa06087b4ebb', 'Not yet')}</strong></div>
            </div>
            ${transactions.length ? `<div class="pmw-table-wrap"><table class="pmw-table"><thead><tr><th>${h('m_2a0b11100c22a4', 'Date')}</th><th>${h('m_aaebd7ccba0b30', 'Project')}</th><th>${h('m_1d5ea39cc421fc', 'Invoice')}</th><th class="pmw-right">${h('m_bd8c29e4635878', 'Gross')}</th><th class="pmw-right">${h('m_6f891fbf3f7955', 'Fee')}</th><th class="pmw-right">${h('m_8870b67246b7d9', 'Net')}</th></tr></thead><tbody>${transactions.map((transaction) => {
              const gross = number(transaction.amount_cents);
              const fee = number(transaction.fee_cents);
              const net = clean(transaction.merchant_amount_cents) !== '' && Number.isFinite(Number(transaction.merchant_amount_cents)) ? number(transaction.merchant_amount_cents) : gross - fee;
              const projectId = clean(transaction.project_id);
              const invoiceId = clean(transaction.invoice_id);
              return `<tr>
                <td>${esc(dateLabel(transaction.received_at || transaction.created_at))}</td>
                <td>${projectId ? `<button type="button" class="pmw-link" data-pmw-project="${esc(projectId)}">${esc(clean(transaction.project_title) || projectId)}</button>` : `<span class="pmw-muted">${h('m_500872d3c049f6', 'Company')}</span>`}</td>
                <td>${invoiceId && typeof options.onOpenInvoice === 'function' ? `<button type="button" class="pmw-link" data-pmw-invoice="${esc(invoiceId)}">${esc(invoiceId)}</button>` : invoiceId ? esc(invoiceId) : '<span class="pmw-muted">—</span>'}</td>
                <td class="pmw-right">${esc(money(gross))}</td><td class="pmw-right">${esc(money(fee))}</td><td class="pmw-right"><strong>${esc(money(net))}</strong></td>
              </tr>`;
            }).join('')}</tbody></table></div>` : stateHtml('fa-receipt', t('m_45a12095bc0b48', 'No member transactions'), t('m_5dab4fe427ad02', 'This payout has no linked payment records.'))}`;
      return `<div class="pmw-shade" data-pmw-shade><div class="pmw-modal" role="dialog" aria-modal="true" aria-label="${h('m_335102d80b2040', 'Payout detail')}">
        <div class="pmw-modal-head"><div><strong>${h('m_b7daeba1ccae6d', 'Payout {v0}', { v0:clean(payout.provider_payout_id) || clean(detail.payoutId) })}</strong><span class="pmw-sub">${detail.loading ? '' : esc(`${transactions.length} · ${clean(payout.currency) || 'USD'}`)}</span></div>
        <div style="display:flex;align-items:center;gap:10px">${detail.loading ? '' : payoutBadge(payout.status)}<button type="button" class="pmw-btn pmw-icon-btn" data-pmw-close aria-label="${h('m_43963f1b979b52', 'Close payout detail')}"><i class="fas fa-xmark"></i></button></div></div>
        <div class="pmw-modal-body">${body}</div></div></div>`;
    }

    function render(){
      if (state.destroyed) return;
      if (!state.data) {
        root.innerHTML = state.loading ? stateHtml('fa-circle-notch', t('m_70c006e9fd1698', 'Loading payouts'), '', true)
          : `${stateHtml('fa-triangle-exclamation', t('m_36bf20afe15b5c', 'Payouts could not load'), clean(state.error?.message || state.error))}<div class="pmw-actions" style="justify-content:center"><button type="button" class="pmw-btn" data-pmw-retry><i class="fas fa-rotate"></i>${h('m_cbfbb44ff35f0f', ' Try again')}</button></div>`;
        return;
      }
      root.innerHTML = `${metricsHtml()}${listHtml()}${detailHtml()}`;
    }

    function openDetail(payoutId){
      if (!payoutId) return;
      state.detail = { payoutId, loading:true };
      window.addEventListener('keydown', onEscape, true);
      render();
      Promise.resolve(api().payouts.get(state.orgId, payoutId)).then((result) => {
        if (state.destroyed || state.detail?.payoutId !== payoutId) return;
        state.detail = { payoutId, loading:false, payout:object(result?.payout), transactions:array(result?.transactions) };
        render();
      }).catch((error) => {
        if (state.destroyed || state.detail?.payoutId !== payoutId) return;
        state.detail = { payoutId, loading:false, error };
        render();
      });
    }
    function closeDetail(){
      window.removeEventListener('keydown', onEscape, true);
      if (state.detail) { state.detail = null; render(); }
    }
    // Caught in the window's capture phase: the portal's modal stack would otherwise close the page behind it.
    function onEscape(event){
      if (event.key !== 'Escape' || !state.detail) return;
      event.stopPropagation();
      event.preventDefault();
      closeDetail();
    }

    root.addEventListener('click', (event) => {
      const target = event.target.closest('button,[data-pmw-row],[data-pmw-tile],[data-pmw-shade]');
      if (!target || !root.contains(target)) return;
      if (target.matches('[data-pmw-shade]')) { if (event.target === target) closeDetail(); return; }
      if (target.matches('[data-pmw-retry]')) return void load();
      if (target.matches('[data-pmw-filter]')) { state.filter = clean(target.dataset.pmwFilter); render(); return; }
      if (target.matches('[data-pmw-close]')) return closeDetail();
      if (target.matches('[data-pmw-project]')) { event.stopPropagation(); closeDetail(); options.onOpenProject?.(target.dataset.pmwProject); return; }
      if (target.matches('[data-pmw-invoice]')) { event.stopPropagation(); closeDetail(); options.onOpenInvoice?.(target.dataset.pmwInvoice); return; }
      if (target.matches('[data-pmw-tile="open_disputes"]')) { options.onOpenDisputes?.(); return; }
      if (target.matches('[data-pmw-row]')) openDetail(target.dataset.pmwRow);
    });
    root.addEventListener('keydown', (event) => {
      const row = event.target.closest?.('[data-pmw-row]');
      if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(row.dataset.pmwRow); }
    });

    load();
    return {
      el:root,
      refresh:load,
      setOrg(orgId){ if (clean(orgId) && clean(orgId) !== state.orgId) { state.orgId = clean(orgId); state.data = null; load(); } },
      destroy(){ state.destroyed = true; window.removeEventListener('keydown', onEscape, true); root.remove(); }
    };
  }

  // --- Disputes -----------------------------------------------------------------

  // Forward's statuses (DisputeDTO): new, accepted, contested, in_review, in_pre_arbitration, lost, won.
  const CLOSED = ['accepted', 'won', 'lost', 'closed', 'cancelled'];
  function disputeStatus(status){
    const value = clean(status).toLowerCase() || 'new';
    const known = {
      new:[t('m_678a6f4f28a8be', 'Needs response'), 'warn'],
      created:[t('m_678a6f4f28a8be', 'Needs response'), 'warn'],
      contested:[t('m_53e7312cae4760', 'Contested'), 'info'],
      in_review:[t('m_a5adb64bece6bf', 'In review'), 'info'],
      under_review:[t('m_a5adb64bece6bf', 'In review'), 'info'],
      in_pre_arbitration:[t('m_06f09fbdd8cb1d', 'Pre-arbitration'), 'warn'],
      won:[t('m_8ef0771ff96741', 'Won'), 'good'],
      lost:[t('m_235d86f4916a45', 'Lost'), 'bad'],
      accepted:[t('m_a72e62a169cf77', 'Accepted'), 'bad'],
      closed:[t('m_7e569700dccbbb', 'Closed'), '']
    }[value] || [value.replace(/_/g, ' '), 'info'];
    return { label:known[0], cls:known[1] };
  }
  function disputeBadge(status){
    const { label, cls } = disputeStatus(status);
    return `<span class="pmw-badge ${cls}">${esc(label)}</span>`;
  }
  function responseStatus(status){
    return {
      draft:[t('m_9ce407c87de615', 'Draft'), ''],
      submitted:[t('m_463f1b8347d88d', 'With FirstMate'), 'info'],
      returned:[t('m_ec130175824f7d', 'Sent back'), 'warn'],
      filed:[t('m_1c2a2c4880bbd4', 'Filed'), 'good']
    }[clean(status)] || null;
  }
  function responseBadge(status){
    const known = responseStatus(status);
    return known ? `<span class="pmw-badge ${known[1]}">${esc(known[0])}</span>` : '<span class="pmw-muted">—</span>';
  }
  function isOpen(dispute){ return !CLOSED.includes(clean(dispute.status).toLowerCase()); }
  function needsAction(dispute){
    const response = clean(object(dispute.response).status);
    return isOpen(dispute) && ['new', 'created', 'in_pre_arbitration'].includes(clean(dispute.status).toLowerCase()) && response !== 'submitted' && response !== 'filed';
  }
  function dueHtml(dispute){
    if (!clean(dispute.respond_by)) return '<span class="pmw-muted">—</span>';
    const days = daysUntil(dispute.respond_by);
    if (!isOpen(dispute) || days === null) return esc(dateLabel(dispute.respond_by));
    const cls = days < 0 ? 'past' : days <= 3 ? 'soon' : '';
    const left = days < 0 ? t('m_bb38f09c44016c', 'passed') : days === 0 ? t('m_142008e9368105', 'today') : t('m_a8e3a01198daa5', '{n} days left', { n:days });
    return `<span class="pmw-due ${cls}">${esc(dateLabel(dispute.respond_by))}</span><span class="pmw-sub">${esc(left)}</span>`;
  }

  // The evidence the card networks ask for, by kind of reason. Forward
  // documents no requirements of its own, so these follow Visa and
  // Mastercard's dispute rules for each reason group.
  const COMMON_FIELDS = [
    { key:'service_description', type:'textarea', label:() => t('m_575d93c825e45f', 'What you provided'), tip:() => t('m_7c5c8197fe1bcf', 'The work or product, where and when, as the customer agreed to it.') },
    { key:'service_date', type:'date', label:() => t('m_c514811aa5b1e2', 'Date the work was finished'), tip:() => t('m_ebced8479dc6e1', 'Leave blank if the work is not finished yet.') },
    { key:'customer_communication', type:'textarea', label:() => t('m_e49d3788da794d', 'Contact with the customer'), tip:() => t('m_8d136c752e2414', 'Emails, texts or calls that show the customer knew about and accepted the charge. Attach copies below.') }
  ];
  const CATEGORIES = [
    { id:'fraud', label:() => t('m_7b310b7b3d4860', 'Fraud or not recognized'), docs:['contract', 'invoice', 'photos', 'messages'],
      fields:[{ key:'cardholder_proof', type:'textarea', label:() => t('m_669970f4a85a80', 'How you know the cardholder made this purchase'), tip:() => t('m_34991dd4aadced', "A signed contract or proposal, meeting them in person, work done at the cardholder's billing address, earlier payments they did not dispute.") }] },
    { id:'not_received', label:() => t('m_ff2196ccbfddb1', 'Work not done or not received'), docs:['completion', 'photos', 'invoice', 'messages'],
      fields:[{ key:'delivery_proof', type:'textarea', label:() => t('m_623466829347ce', 'Proof the work was done'), tip:() => t('m_e653591fc9e5c1', 'Completion date, sign-off or inspection, before and after photos.') }] },
    { id:'not_as_described', label:() => t('m_b138f1bd9b33ba', 'Not as described or defective'), docs:['contract', 'photos', 'warranty', 'messages'],
      fields:[{ key:'quality_rebuttal', type:'textarea', label:() => t('m_90178a801ab7f9', 'Why the work matched what was agreed'), tip:() => t('m_046b644a7378ee', 'Point to the contract scope, warranties, and any offer to fix an issue that the customer turned down.') }] },
    { id:'duplicate', label:() => t('m_da70f3de56c157', 'Duplicate or paid another way'), docs:['invoice', 'receipts'],
      fields:[{ key:'duplicate_explanation', type:'textarea', label:() => t('m_c31a4d2cbc3569', 'Why these are separate charges'), tip:() => t('m_3ceaf41f583200', 'Name the other charge (date and amount) and what each one paid for, for example a deposit and the final payment.') }] },
    { id:'credit_not_processed', label:() => t('m_9f90950e5d95c7', 'Refund not processed'), docs:['refund_policy', 'contract', 'messages'],
      fields:[{ key:'refund_rebuttal', type:'textarea', label:() => t('m_8ff5b7093e2c03', 'Why no refund is owed'), tip:() => t('m_faf4e18795cb63', 'Quote your refund policy and when the customer accepted it, or show the refund was already made.') }] },
    { id:'cancelled', label:() => t('m_9863f11d60b2fa', 'Cancelled'), docs:['contract', 'refund_policy', 'messages'],
      fields:[{ key:'cancellation_rebuttal', type:'textarea', label:() => t('m_37bb0f600a07e2', "Why the cancellation doesn't apply"), tip:() => t('m_c53f49554e5149', 'Your cancellation terms, when the customer accepted them, and whether work had already started.') }] },
    { id:'incorrect_amount', label:() => t('m_c96a8092e88e9a', 'Wrong amount'), docs:['contract', 'change_orders', 'invoice'],
      fields:[{ key:'amount_explanation', type:'textarea', label:() => t('m_308a3d5b547dd5', 'Why the amount is right'), tip:() => t('m_10a4cd453d62e6', 'Show the signed amount, any change orders, and the invoice that matches the charge.') }] },
    { id:'other', label:() => t('m_44f003d0d61c95', 'Something else'), docs:['contract', 'invoice', 'messages'], fields:[] }
  ];
  const DOC_LABELS = {
    contract:() => t('m_0513a3bdf25864', 'Signed contract'),
    invoice:() => t('m_1d5ea39cc421fc', 'Invoice'),
    photos:() => t('m_3b3686892868de', 'Photos of the work'),
    messages:() => t('m_e25508b43befdf', 'Emails or texts'),
    completion:() => t('m_b35ddf74715df9', 'Completion sign-off'),
    warranty:() => t('m_ce136d616af520', 'Warranty'),
    receipts:() => t('m_1efb698e62ef77', 'Receipts for both charges'),
    refund_policy:() => t('m_a97cf7217333f7', 'Refund policy'),
    change_orders:() => t('m_9b66c8f287b44d', 'Change orders')
  };
  function categoryFor(dispute){
    const reason = clean(dispute.reason).toLowerCase();
    const code = clean(dispute.reason_code);
    if (/fraud|not authori[sz]ed|not recogni[sz]ed|no cardholder|unauthori/.test(reason) || /^10\./.test(code) || ['4837', '4840', '4849', '4863', '4870', '4871'].includes(code)) return 'fraud';
    if (/duplicate|paid by other means/.test(reason) || code === '12.6' || code === '4834') return 'duplicate';
    if (/not received|not provided|non.?receipt/.test(reason) || code === '13.1' || code === '4855') return 'not_received';
    if (/not as described|defective|quality|counterfeit|misrepresent/.test(reason) || ['13.3', '13.4', '13.5', '4853'].includes(code)) return 'not_as_described';
    if (/credit not processed|refund/.test(reason) || code === '13.6' || code === '4860') return 'credit_not_processed';
    if (/cancel/.test(reason) || ['13.2', '13.7', '4841'].includes(code)) return 'cancelled';
    if (/incorrect amount|amount/.test(reason) || code === '12.5') return 'incorrect_amount';
    return 'other';
  }
  function category(id){ return CATEGORIES.find((entry) => entry.id === id) || CATEGORIES[CATEGORIES.length - 1]; }

  function mountDisputes(host, options = {}){
    injectCss();
    const state = {
      orgId:clean(options.orgId),
      filter:'action',
      list:null, canRespond:false, staff:false, sync:null, syncing:false, syncedAt:0,
      queue:null, queueLoading:false,
      loading:true, error:null,
      open:null, // { id, orgId, staffView, loading, error, data, form, saving, uploading, status }
      destroyed:false, token:0
    };
    const root = document.createElement('div');
    root.className = 'pmw pmw-disputes';
    root.dataset.paymentsWidget = 'disputes';
    // The response form has its own Save and Submit; Settings must not autosave it.
    root.dataset.settingsAutosave = 'off';
    host.replaceChildren(root);

    async function loadList(){
      const token = ++state.token;
      state.loading = !state.list;
      state.error = null;
      render();
      try {
        const result = await call(state.orgId, '/disputes');
        if (state.destroyed || token !== state.token) return;
        state.list = array(result?.disputes);
        state.canRespond = result?.can_respond === true;
        state.staff = result?.staff === true;
        if (!state.list.some(needsAction) && state.filter === 'action') state.filter = state.list.some(isOpen) ? 'open' : 'all';
      } catch (error) {
        if (state.destroyed || token !== state.token) return;
        state.error = error;
      }
      state.loading = false;
      render();
    }

    // Pull every dispute from the processor (the server skips a pull made in the last 30 s unless forced).
    async function syncList(force = false){
      if (state.syncing) return;
      state.syncing = true;
      render();
      try {
        const result = await call(state.orgId, '/disputes/sync', { method:'POST', body:{ force } });
        if (state.destroyed) return;
        state.sync = object(result?.sync);
        state.syncedAt = Date.now();
        if (Array.isArray(result?.disputes)) state.list = result.disputes;
      } catch (error) {
        if (state.destroyed) return;
        state.sync = { ok:false, error:clean(error?.message) };
      }
      state.syncing = false;
      render();
    }

    async function loadQueue(){
      state.queueLoading = true;
      render();
      try {
        const result = await api().request('/staff/dispute-responses?status=all');
        if (state.destroyed) return;
        state.queue = array(result?.disputes);
      } catch (error) {
        if (state.destroyed) return;
        state.queue = [];
        toast(t('m_28c7503e189537', 'Could not load the filing queue'), clean(error?.message), false);
      }
      state.queueLoading = false;
      render();
    }

    function listCounts(list){
      return {
        action:list.filter(needsAction).length,
        open:list.filter(isOpen).length,
        closed:list.filter((dispute) => !isOpen(dispute)).length,
        all:list.length
      };
    }

    function syncNote(){
      if (state.syncing) return `<span class="pmw-sub"><i class="fas fa-circle-notch pmw-spin"></i> ${h('m_c059a842fdc832', 'Checking Forward…')}</span>`;
      if (state.sync && state.sync.ok === false) return `<span class="pmw-sub pmw-bad" title="${esc(state.sync.error || '')}"><i class="fas fa-triangle-exclamation"></i> ${h('m_6f75be5ff33bd6', 'Forward could not be reached')}</span>`;
      if (state.sync?.synced_at) return `<span class="pmw-sub">${h('m_ea81199f747f4c', 'Up to date with Forward')}</span>`;
      return '';
    }

    function rowHtml(dispute, staffQueue = false){
      const response = object(dispute.response);
      return `<tr data-pmw-row="${esc(dispute.id)}" ${staffQueue ? `data-pmw-org="${esc(dispute.organization_id)}"` : ''} tabindex="0">
        ${staffQueue ? `<td><strong>${esc(dispute.organization_name)}</strong></td>` : ''}
        <td>${disputeBadge(dispute.status)}</td>
        <td class="pmw-right"><strong>${esc(money(dispute.amount_cents, dispute.currency))}</strong></td>
        <td><span>${esc(clean(dispute.reason).replace(/_/g, ' ') || '—')}</span>${clean(dispute.reason_code) ? `<span class="pmw-sub">${h('m_a6f3f2a6513bca', 'Code {code}', { code:dispute.reason_code })}</span>` : ''}</td>
        <td>${esc(dateLabel(dispute.dispute_date || dispute.opened_at || dispute.created_at))}${clean(dispute.card_last4) ? `<span class="pmw-sub">•••• ${esc(dispute.card_last4)}</span>` : ''}</td>
        <td>${dueHtml(dispute)}</td>
        <td>${responseBadge(response.status)}</td>
      </tr>`;
    }

    function listHtml(){
      const staffQueue = state.filter === 'queue';
      const list = array(state.list);
      const counts = listCounts(list);
      const chips = [
        ['action', t('m_678a6f4f28a8be', 'Needs response'), counts.action],
        ['open', t('m_c25cc66b28cc9d', 'Open'), counts.open],
        ['closed', t('m_7e569700dccbbb', 'Closed'), counts.closed],
        ['all', t('m_61df468d92e238', 'All'), counts.all],
        ...(state.staff ? [['queue', t('m_1210548bf1668b', 'FirstMate filing'), state.queue ? state.queue.filter((row) => clean(object(row.response).status) === 'submitted').length : '']] : [])
      ].map(([key, label, count]) => `<button type="button" class="pmw-chip ${state.filter === key ? 'active' : ''}" data-pmw-filter="${key}"${key === 'queue' ? ` title="${h('m_97faebbc0ec5b0', 'Every company’s submitted responses, to file in Forward (FirstMate staff only)')}"` : ''}>${esc(label)}${count !== '' ? `<small>${esc(count)}</small>` : ''}</button>`).join('');
      const rows = staffQueue ? array(state.queue)
        : state.filter === 'action' ? list.filter(needsAction)
          : state.filter === 'open' ? list.filter(isOpen)
            : state.filter === 'closed' ? list.filter((dispute) => !isOpen(dispute))
              : list;
      const head = `<tr>${staffQueue ? `<th>${h('m_500872d3c049f6', 'Company')}</th>` : ''}<th>${h('m_1352cafa75b8da', 'Status')}</th><th class="pmw-right">${h('m_2b8c3448fa87a1', 'Amount')}</th><th>${h('m_6480ed19528b5a', 'Reason')}</th><th>${h('m_7502deb3a808c4', 'Disputed')}</th><th>${h('m_f3cd041a0e8054', 'Respond by')}</th><th>${h('m_053144b11a8523', 'Your response')}</th></tr>`;
      const body = staffQueue && state.queueLoading ? stateHtml('fa-circle-notch', t('m_2c576c3f0f45aa', 'Loading the filing queue'), '', true)
        : rows.length ? `<div class="pmw-table-wrap"><table class="pmw-table"><thead>${head}</thead><tbody>${rows.map((row) => rowHtml(row, staffQueue)).join('')}</tbody></table></div>`
          : staffQueue ? stateHtml('fa-inbox', t('m_0ee1595c28f3b8', 'Nothing to file'), t('m_842579346ae2aa', 'Responses companies submit appear here.'))
            : list.length ? stateHtml('fa-filter', t('m_8d244eb3362749', 'No disputes match this filter'), t('m_c40115afc71a89', 'Try another one.'))
              : stateHtml('fa-scale-balanced', t('m_215c03ede9f243', 'No disputes'), t('m_0ba2f9eb690a41', 'When a customer disputes a card payment with their bank, it appears here.'));
      const tip = t('m_f943e0f8f2cbc8', "A dispute (chargeback) is a customer asking their bank to take back a card payment. Fight it with a response before the deadline, or accept it. FirstMate files your response with Forward for you.");
      return `<section class="pmw-card"><div class="pmw-card-head"><h2>${h('m_9b7a2edd995dfe', 'Disputes')} ${infoTip(tip)}</h2><div class="pmw-chips" role="group" aria-label="${h('m_ae8ecada9f6cd7', 'Dispute filter')}">${chips}</div></div>
        <div class="pmw-card-head" style="padding:8px 14px;border-bottom:${rows.length ? '1px solid #eaecf0' : '0'}">${syncNote() || '<span></span>'}<button type="button" class="pmw-btn" data-pmw-sync ${state.syncing ? 'disabled' : ''} title="${h('m_671a69b402c120', 'Pull the latest disputes from Forward')}"><i class="fas fa-rotate${state.syncing ? ' pmw-spin' : ''}"></i>${h('m_78973ce0cf3403', 'Refresh')}</button></div>
        ${body}</section>`;
    }

    // --- One dispute ---

    function blankForm(dispute){
      const response = object(dispute.response);
      return {
        decision:clean(response.decision),
        category:clean(response.category) || categoryFor(dispute),
        summary:clean(response.summary),
        evidence:{ ...object(response.evidence) },
        attachments:array(response.attachments).map((file) => ({ ...file })),
        dirty:false
      };
    }

    async function openDispute(id, orgId = state.orgId, staffView = false){
      state.open = { id, orgId, staffView, loading:true };
      render();
      root.scrollIntoView?.({ block:'nearest' });
      try {
        const result = staffView
          ? await api().request(`/staff/organizations/${encodeURIComponent(orgId)}/disputes/${encodeURIComponent(id)}`)
          : await call(orgId, `/disputes/${encodeURIComponent(id)}`);
        if (state.destroyed || state.open?.id !== id) return;
        state.open = { id, orgId, staffView, loading:false, data:result, form:blankForm(object(result?.dispute)) };
      } catch (error) {
        if (state.destroyed || state.open?.id !== id) return;
        state.open = { id, orgId, staffView, loading:false, error };
      }
      render();
    }

    async function closeDispute(){
      if (state.open?.form?.dirty && !(await ask('confirm', t('m_171c970287658e', 'Leave without saving your response?')))) return;
      state.open = null;
      render();
    }

    function fact(label, value, tip = ''){
      return `<div class="pmw-fact"><dt>${esc(label)}${tip ? infoTip(tip) : ''}</dt><dd>${value || '<span class="pmw-muted">—</span>'}</dd></div>`;
    }

    function factsHtml(data){
      const dispute = object(data.dispute);
      const payment = data.payment ? object(data.payment) : null;
      const project = data.project ? object(data.project) : null;
      const extended = clean(dispute.original_respond_by) && clean(dispute.original_respond_by) !== clean(dispute.respond_by);
      const transactionAmount = number(dispute.transaction_amount_cents);
      return `<dl class="pmw-facts">
        ${fact(t('m_6480ed19528b5a', 'Reason'), `${esc(clean(dispute.reason) || '—')}${clean(dispute.reason_code) ? `<span class="pmw-sub">${h('m_a6f3f2a6513bca', 'Code {code}', { code:dispute.reason_code })}</span>` : ''}`, t('m_2c8c60d7088d63', "The reason the cardholder's bank gave, with the card network's reason code."))}
        ${fact(t('m_f3cd041a0e8054', 'Respond by'), `${dueHtml(dispute)}${extended ? `<span class="pmw-sub">${h('m_b0ac2095c38e18', 'Was {date}', { date:dateLabel(dispute.original_respond_by) })}</span>` : ''}`, t('m_b86a2c83d15c64', 'After this date the bank decides without your response. FirstMate needs a day or two to file it.'))}
        ${fact(t('m_7502deb3a808c4', 'Disputed'), esc(dateLabel(dispute.dispute_date || dispute.opened_at)))}
        ${fact(t('m_023c7d7ca8a301', 'Received'), esc(dateLabel(dispute.received_date)))}
        ${fact(t('m_dd2dde7989cd96', 'Card'), clean(dispute.card_last4) ? esc(`•••• ${dispute.card_last4}`) : '')}
        ${fact(t('m_7e7ee3cbe09235', 'Original charge'), transactionAmount || clean(dispute.transaction_date) ? `${transactionAmount ? esc(money(transactionAmount, dispute.currency)) : ''}${clean(dispute.transaction_date) ? `<span class="pmw-sub">${esc(dateLabel(dispute.transaction_date))}</span>` : ''}` : '')}
        ${fact(t('m_10df4f5589c049', 'Authorization code'), clean(dispute.authorization_code) ? `<span class="pmw-mono">${esc(dispute.authorization_code)}</span>` : '')}
        ${fact(t('m_aaebd7ccba0b30', 'Project'), project ? (typeof options.onOpenProject === 'function' && !state.open?.staffView ? `<button type="button" class="pmw-link" data-pmw-project="${esc(project.id)}">${esc(project.title || project.id)}</button>` : esc(project.title || project.id)) + (project.customer_name ? `<span class="pmw-sub">${esc(project.customer_name)}</span>` : '') : '', project ? '' : t('m_42b04cbf0280ea', 'Shown when the payment was taken through FirstMate.'))}
        ${fact(t('m_d0f1699dbcd6a5', 'Payment'), payment ? `${esc(money(payment.amount_cents, payment.currency))}<span class="pmw-sub">${esc(dateLabel(payment.received_at))}${payment.payer_name ? ` · ${esc(payment.payer_name)}` : ''}</span>` : '')}
        ${fact(t('m_9e8dc60a408036', 'Forward dispute'), `<span class="pmw-mono">${esc(dispute.provider_dispute_id)}</span>`)}
      </dl>`;
    }

    function filedAtForwardHtml(dispute){
      const notes = array(dispute.provider_notes).filter((note) => clean(note.message));
      const files = array(dispute.provider_attachments);
      if (!clean(dispute.filed_response) && !notes.length && !files.length) return '';
      return `<section class="pmw-section"><div class="pmw-section-head"><h3><i class="fas fa-building-columns"></i>${h('m_ccb6804cffbd05', 'On file at Forward')}</h3></div>
        ${clean(dispute.filed_response) ? `<p class="pmw-filed-text">${esc(dispute.filed_response)}</p>` : ''}
        ${notes.map((note) => `<div class="pmw-note"><i class="fas fa-note-sticky"></i><div>${esc(note.message)}<span class="pmw-sub">${esc(dateLabel(note.created_at))}</span></div></div>`).join('')}
        ${files.length ? `<div class="pmw-sub">${h('m_8f9e6b8fb785ac', '{n} files are attached at Forward. Forward does not share them with FirstMate.', { n:files.length })}</div>` : ''}
      </section>`;
    }

    function fieldHtml(field, value, disabled){
      const id = `pmw-${field.key}-${Math.random().toString(36).slice(2, 7)}`;
      const input = field.type === 'textarea'
        ? `<textarea id="${id}" data-pmw-evidence="${esc(field.key)}" rows="3" ${disabled ? 'disabled' : ''}>${esc(value)}</textarea>`
        : `<input id="${id}" type="${field.type}" data-pmw-evidence="${esc(field.key)}" value="${esc(value)}" ${disabled ? 'disabled' : ''}>`;
      return `<div class="pmw-field"><label class="pmw-field-label" for="${id}">${esc(field.label())} ${infoTip(field.tip())}</label>${input}</div>`;
    }

    function filesHtml(form, disabled, open){
      const cat = category(form.category);
      const used = new Set(form.attachments.map((file) => clean(file.label)));
      const evidenceUrl = (file) => fileUrl(open.staffView
        ? `/staff/organizations/${encodeURIComponent(open.orgId)}/disputes/${encodeURIComponent(open.id)}/evidence/${encodeURIComponent(file.media_id)}`
        : `${orgPath(open.orgId, `/disputes/${encodeURIComponent(open.id)}/evidence/${encodeURIComponent(file.media_id)}`)}`);
      const list = form.attachments.map((file, index) => `<div class="pmw-file">
          <i class="fas ${/^image\//.test(clean(file.content_type)) ? 'fa-file-image' : /pdf/.test(clean(file.content_type)) ? 'fa-file-pdf' : 'fa-file-lines'}"></i>
          <span class="pmw-file-name" title="${esc(file.file_name)}">${file.saved === false ? esc(file.file_name) : `<a href="${esc(evidenceUrl(file))}" target="_blank" rel="noopener" download>${esc(file.file_name)}</a>`}</span>
          <input type="text" list="pmw-doc-labels" data-pmw-file-label="${index}" value="${esc(file.label)}" placeholder="${h('m_52584a933140c4', 'What is this?')}" ${disabled ? 'disabled' : ''}>
          ${disabled ? '<span></span>' : `<button type="button" class="pmw-btn pmw-icon-btn danger" data-pmw-file-remove="${index}" aria-label="${h('m_d466314640d7b0', 'Remove file')}"><i class="fas fa-trash"></i></button>`}
        </div>`).join('');
      const suggestions = cat.docs.filter((key) => !used.has(DOC_LABELS[key]())).map((key) => `<span class="pmw-badge">${esc(DOC_LABELS[key]())}</span>`).join('');
      return `<div class="pmw-field"><span class="pmw-field-label">${h('m_28c80635ad0efa', 'Evidence files')} ${infoTip(t('m_469944a369a4ac', 'PDFs, photos, Word documents or text files, up to 10 MB each and 20 in all. Name each one so FirstMate files it under the right heading.'))}</span>
        <datalist id="pmw-doc-labels">${Object.values(DOC_LABELS).map((label) => `<option value="${esc(label())}">`).join('')}</datalist>
        <div class="pmw-files">${list}</div>
        ${disabled ? (form.attachments.length ? '' : `<span class="pmw-muted">${h('m_1653e9aa78fa45', 'No files attached.')}</span>`) : `<div class="pmw-suggest">
          <button type="button" class="pmw-btn" data-pmw-upload ${open.uploading ? 'disabled' : ''}><i class="fas ${open.uploading ? 'fa-circle-notch pmw-spin' : 'fa-paperclip'}"></i>${open.uploading ? h('m_50479360308f51', 'Uploading…') : h('m_032133d04a761e', 'Attach files')}</button>
          ${suggestions ? `<span>${h('m_e4fc8e25c284b9', 'Helps here:')}</span>${suggestions}` : ''}
          <input type="file" data-pmw-file-input multiple hidden accept=".pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt,.csv,.doc,.docx,application/pdf,image/*,text/plain,text/csv">
        </div>`}
      </div>`;
    }

    function responseBanner(response, dispute, staffView){
      const status = clean(response.status);
      if (status === 'submitted') return `<div class="pmw-note info"><i class="fas fa-paper-plane"></i><div><strong>${h('m_463f1b8347d88d', 'With FirstMate')}</strong>${staffView ? h('m_eb2ab6c6bc8825', 'Submitted by {name} on {date}. File it in Forward, then mark it filed.', { name:clean(response.submitted_by) || '—', date:dateLabel(response.submitted_at) }) : h('m_a92c264a93ebaa', 'We file your response with Forward before {date}. You can still change it until we do.', { date:dateLabel(dispute.respond_by, t('m_d6d902263f2634', 'the deadline')) })}</div></div>`;
      if (status === 'returned') return `<div class="pmw-note warn"><i class="fas fa-rotate-left"></i><div><strong>${h('m_5610de8b802272', 'FirstMate sent this back')}</strong>${esc(clean(response.staff_note) || t('m_71ed0bfc7f1357', 'Change your response and submit it again.'))}</div></div>`;
      if (status === 'filed') return `<div class="pmw-note good"><i class="fas fa-circle-check"></i><div><strong>${h('m_fa61f7b2de9309', 'Filed with Forward')}</strong>${h('m_c045eb1def57b6', 'FirstMate filed this on {date}. The bank decides next; this page updates when Forward does.', { date:dateLabel(response.filed_at) })}${clean(response.staff_note) ? `<span class="pmw-sub">${esc(response.staff_note)}</span>` : ''}</div></div>`;
      return '';
    }

    function responseHtml(open){
      const dispute = object(open.data?.dispute);
      const response = object(dispute.response);
      const form = open.form;
      const status = clean(response.status);
      const closed = !isOpen(dispute);
      if (closed && !status) return `<div class="pmw-note"><i class="fas fa-lock"></i><div>${h('m_b34be81399d69f', 'This dispute is closed. There is nothing to respond to.')}</div></div>`;
      const canEdit = !open.staffView && open.data?.can_respond === true && !closed && (status === '' || status === 'draft' || status === 'returned');
      const disabled = !canEdit;
      const cat = category(form.category);
      const contest = form.decision === 'contest';
      const accept = form.decision === 'accept';
      const decision = `<div class="pmw-choice" role="radiogroup" aria-label="${h('m_923d54f04ea3d3', 'Your decision')}">
          <button type="button" role="radio" aria-checked="${contest}" class="${contest ? 'active' : ''}" data-pmw-decision="contest" ${disabled ? 'disabled' : ''}><i class="fas fa-shield-halved"></i><div><strong>${h('m_602034bcfbe88d', 'Fight it')}</strong><span>${h('m_2b256129afa50d', 'Show the charge was right. If the bank agrees, you keep the money.')}</span></div></button>
          <button type="button" role="radio" aria-checked="${accept}" class="${accept ? 'active' : ''}" data-pmw-decision="accept" ${disabled ? 'disabled' : ''}><i class="fas fa-hand"></i><div><strong>${h('m_6dd38259c4a8f6', 'Accept it')}</strong><span>${h('m_32c2c27289f9a5', 'The customer keeps the refund. Nothing else to send.')}</span></div></button>
        </div>`;
      const contestFields = contest ? `<div class="pmw-fields">
          <div class="pmw-field"><label class="pmw-field-label" for="pmw-category">${h('m_74c247874d32ca', 'What the customer says')} ${infoTip(t('m_c41da33ab1cc67', "Picked from the bank's reason. It decides which evidence helps most."))}</label>
            <select id="pmw-category" data-pmw-category ${disabled ? 'disabled' : ''}>${CATEGORIES.map((entry) => `<option value="${entry.id}" ${entry.id === cat.id ? 'selected' : ''}>${esc(entry.label())}</option>`).join('')}</select></div>
          <div class="pmw-field"><label class="pmw-field-label" for="pmw-summary">${h('m_053144b11a8523', 'Your response')} ${infoTip(t('m_16dd381f7606e8', 'A short letter to the bank: what the customer bought, that they got it, and why the charge is right. Refer to your files.'))}</label>
            <textarea id="pmw-summary" data-pmw-summary rows="5" placeholder="${h('m_40d622ff5a52e6', 'The customer signed our proposal on … and we finished the work on …')}" ${disabled ? 'disabled' : ''}>${esc(form.summary)}</textarea></div>
          ${[...cat.fields, ...COMMON_FIELDS].map((field) => fieldHtml(field, clean(form.evidence[field.key]), disabled)).join('')}
          ${filesHtml(form, disabled, open)}
        </div>` : accept ? `<div class="pmw-field"><label class="pmw-field-label" for="pmw-summary">${h('m_0c02725cc5c100', 'Note for FirstMate (optional)')}</label><textarea id="pmw-summary" data-pmw-summary rows="2" ${disabled ? 'disabled' : ''}>${esc(form.summary)}</textarea></div>` : '';
      const actions = canEdit ? `<div class="pmw-actions"><span class="pmw-status">${esc(open.status || (form.dirty ? t('m_b3ebdfc21e717e', 'Unsaved changes') : clean(response.updated_at) ? t('m_67308ce7dbbce4', 'Saved {date}', { date:dateLabel(response.updated_at) }) : ''))}</span>
          <button type="button" class="pmw-btn" data-pmw-save ${open.saving ? 'disabled' : ''}>${h('m_bb186c33ef3094', 'Save draft')}</button>
          <button type="button" class="pmw-btn primary" data-pmw-submit ${open.saving || !form.decision ? 'disabled' : ''}><i class="fas fa-paper-plane"></i>${accept ? h('m_d3ad1f45352bd0', 'Send to FirstMate') : h('m_e773db72b24d00', 'Submit response')}</button></div>`
        : !open.staffView && status === 'submitted' && open.data?.can_respond === true && !closed ? `<div class="pmw-actions"><button type="button" class="pmw-btn" data-pmw-reopen ${open.saving ? 'disabled' : ''}><i class="fas fa-pen"></i>${h('m_2e5e3fdd4da5f7', 'Change response')}</button></div>`
          : !open.staffView && open.data?.can_respond !== true && !status ? `<div class="pmw-note"><i class="fas fa-user-lock"></i><div>${h('m_e303e20d35ba15', 'Someone who manages company settings can respond to this dispute.')}</div></div>` : '';
      return `<section class="pmw-section" data-pmw-response><div class="pmw-section-head"><h3><i class="fas fa-reply"></i>${h('m_053144b11a8523', 'Your response')}</h3>${responseBadge(status)}</div>
        ${responseBanner(response, dispute, open.staffView)}
        ${status || canEdit ? decision : ''}
        ${status || canEdit ? contestFields : ''}
        ${actions}
        ${open.staffView ? staffActionsHtml(open) : ''}
        ${array(response.history).length ? `<div class="pmw-history">${array(response.history).map((entry) => `<span>${esc(dateLabel(entry.at))} · ${esc(historyLabel(entry.action))} · ${esc(entry.by)}${clean(entry.note) ? ` — ${esc(entry.note)}` : ''}</span>`).join('')}</div>` : ''}
      </section>`;
    }

    function historyLabel(action){
      return { submitted:t('m_e2b803de55a93e', 'Submitted'), reopened:t('m_c476638e89f336', 'Reopened'), filed:t('m_1c2a2c4880bbd4', 'Filed'), returned:t('m_ec130175824f7d', 'Sent back') }[clean(action)] || clean(action);
    }

    function staffActionsHtml(open){
      const response = object(object(open.data?.dispute).response);
      const pending = clean(response.status) === 'submitted';
      return `<div class="pmw-note"><i class="fas fa-user-shield"></i><div style="flex:1;display:grid;gap:8px"><strong>${h('m_257c898501d9ee', 'FirstMate staff')}</strong>
        <span>${h('m_5da056f68daa2b', "File this in Forward's portal under the company's merchant account: choose the same decision, paste the response and attach each file.")}</span>
        <div class="pmw-actions" style="justify-content:flex-start">
          <button type="button" class="pmw-btn" data-pmw-copy><i class="fas fa-copy"></i>${h('m_b421c5f99c63dd', 'Copy response')}</button>
          ${pending ? `<button type="button" class="pmw-btn primary" data-pmw-staff="filed"><i class="fas fa-circle-check"></i>${h('m_e944f21288b995', 'Mark filed')}</button>
          <button type="button" class="pmw-btn" data-pmw-staff="return"><i class="fas fa-rotate-left"></i>${h('m_449c9cb1efb6d4', 'Send back')}</button>` : ''}
        </div></div></div>`;
    }

    function detailHtml(open){
      if (open.loading) return stateHtml('fa-circle-notch', t('m_7a913539ee5960', 'Loading dispute'), '', true);
      if (open.error) return stateHtml('fa-triangle-exclamation', t('m_8ec7d8249a46fe', 'This dispute could not load'), clean(open.error?.message || open.error));
      const dispute = object(open.data?.dispute);
      const days = daysUntil(dispute.respond_by);
      const urgent = needsAction(dispute) && days !== null && days >= 0 && days <= 3;
      return `<div class="pmw-detail">
        <div class="pmw-detail-top">
          <button type="button" class="pmw-btn" data-pmw-back><i class="fas fa-arrow-left"></i>${h('m_209292b0163db9', 'All disputes')}</button>
          <div class="pmw-detail-title"><strong>${esc(money(dispute.amount_cents, dispute.currency))}</strong><span class="pmw-sub">${open.staffView && open.data?.organization_id ? `${esc(clean(array(state.queue).find((row) => row.id === dispute.id)?.organization_name) || open.data.organization_id)} · ` : ''}${esc(clean(dispute.reason) || '')}</span></div>
          ${disputeBadge(dispute.status)}
        </div>
        ${urgent ? `<div class="pmw-note bad"><i class="fas fa-clock"></i><div><strong>${h('m_d5f4ff255a22de', 'Due soon')}</strong>${h('m_af7ad032b413f6', 'Submit your response today so FirstMate can file it in time.')}</div></div>` : ''}
        ${factsHtml(open.data)}
        ${responseHtml(open)}
        ${filedAtForwardHtml(dispute)}
      </div>`;
    }

    function render(){
      if (state.destroyed) return;
      // Keep what was typed: every render redraws the form from state.
      if (state.open?.form && root.querySelector('[data-pmw-response]')) readForm();
      const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = focused ? (focused.dataset.pmwEvidence ? `[data-pmw-evidence="${focused.dataset.pmwEvidence}"]` : focused.matches('[data-pmw-summary]') ? '[data-pmw-summary]' : '') : '';
      if (state.open) root.innerHTML = detailHtml(state.open);
      else if (!state.list) {
        root.innerHTML = state.loading ? stateHtml('fa-circle-notch', t('m_117e4bdc126d0f', 'Loading disputes'), '', true)
          : `${stateHtml('fa-triangle-exclamation', t('m_c79661134ecd55', 'Disputes could not load'), clean(state.error?.message || state.error))}<div class="pmw-actions" style="justify-content:center"><button type="button" class="pmw-btn" data-pmw-retry><i class="fas fa-rotate"></i>${h('m_cbfbb44ff35f0f', ' Try again')}</button></div>`;
      } else root.innerHTML = listHtml();
      if (focusKey) root.querySelector(focusKey)?.focus?.();
    }

    function readForm(){
      const open = state.open;
      if (!open?.form) return;
      const summary = root.querySelector('[data-pmw-summary]');
      if (summary) open.form.summary = summary.value;
      root.querySelectorAll('[data-pmw-evidence]').forEach((input) => { open.form.evidence[input.dataset.pmwEvidence] = input.value; });
      root.querySelectorAll('[data-pmw-file-label]').forEach((input) => {
        const file = open.form.attachments[Number(input.dataset.pmwFileLabel)];
        if (file) file.label = input.value;
      });
    }

    async function saveResponse(action){
      const open = state.open;
      if (!open?.form || open.saving) return;
      readForm();
      const form = open.form;
      if (action === 'submit' && form.decision === 'contest' && clean(form.summary).length < 20) {
        open.status = t('m_03db266f12e69e', 'Write a few sentences in Your response first.');
        render();
        root.querySelector('[data-pmw-summary]')?.focus();
        return;
      }
      if (action === 'submit' && !(await ask('confirm', form.decision === 'accept'
        ? t('m_30358fb5441911', 'Send FirstMate your decision to accept this dispute? The customer keeps the money.')
        : t('m_4d1adaea4274d9', 'Submit this response? FirstMate files it with Forward for you.')))) return;
      open.saving = true;
      open.status = action === 'submit' ? t('m_35f0835e302ea2', 'Submitting…') : t('m_ea600c018fb36c', 'Saving…');
      render();
      try {
        const body = action === 'reopen' ? { action } : {
          action,
          ...(form.decision ? { decision:form.decision } : {}),
          category:form.category,
          summary:form.summary,
          evidence:Object.fromEntries(Object.entries(form.evidence).filter(([, value]) => clean(value))),
          attachments:form.attachments.map((file) => ({ media_id:file.media_id, label:clean(file.label) }))
        };
        const result = await call(open.orgId, `/disputes/${encodeURIComponent(open.id)}/response`, { method:'PUT', body });
        if (state.destroyed || state.open !== open) return;
        const dispute = object(result?.dispute);
        open.data = { ...open.data, dispute };
        open.form = blankForm(dispute);
        open.status = action === 'submit' ? t('m_e2b803de55a93e', 'Submitted') : action === 'reopen' ? '' : t('m_4bb4688766e904', 'Saved');
        state.list = array(state.list).map((entry) => entry.id === dispute.id ? dispute : entry);
        if (action === 'submit') toast(t('m_5b8cfa7a60a8d9', 'Response submitted'), t('m_7b876e4efd22a4', 'FirstMate will file it with Forward.'), true);
      } catch (error) {
        if (state.destroyed || state.open !== open) return;
        open.status = clean(error?.message) || t('m_58d11f2689a63e', 'Could not save.');
        toast(t('m_c8b7bd7ca69f49', 'Save failed'), open.status, false);
      }
      open.saving = false;
      render();
    }

    async function staffAct(action){
      const open = state.open;
      if (!open || open.saving) return;
      const note = await ask('prompt', action === 'filed'
        ? t('m_b712ce7d22d3e3', 'Note for the company (optional), e.g. where it was filed:')
        : t('m_f5703af2a93f40', 'What should the company change?'), '');
      if (note === null) return;
      if (action === 'return' && !clean(note)) return;
      open.saving = true;
      render();
      try {
        const result = await api().request(`/staff/organizations/${encodeURIComponent(open.orgId)}/disputes/${encodeURIComponent(open.id)}/response`, { method:'POST', body:{ action, note:clean(note) } });
        if (state.destroyed || state.open !== open) return;
        open.data = { ...open.data, dispute:object(result?.dispute) };
        state.queue = array(state.queue).map((row) => row.id === open.id && row.organization_id === open.orgId ? { ...row, response:object(result?.dispute?.response) } : row);
      } catch (error) {
        toast(t('m_04a3f4a86f90c7', 'Could not update'), clean(error?.message), false);
      }
      open.saving = false;
      render();
    }

    function copyText(open){
      const dispute = object(open.data?.dispute);
      const response = object(dispute.response);
      const cat = category(clean(response.category));
      const evidence = object(response.evidence);
      const fields = [...cat.fields, ...COMMON_FIELDS].filter((field) => clean(evidence[field.key]));
      const lines = [
        `${t('m_9e8dc60a408036', 'Forward dispute')}: ${clean(dispute.provider_dispute_id)}`,
        `${t('m_2b8c3448fa87a1', 'Amount')}: ${money(dispute.amount_cents, dispute.currency)} · ${clean(dispute.reason)}${clean(dispute.reason_code) ? ` (${clean(dispute.reason_code)})` : ''}`,
        `${t('m_923d54f04ea3d3', 'Your decision')}: ${clean(response.decision) === 'accept' ? t('m_6dd38259c4a8f6', 'Accept it') : t('m_602034bcfbe88d', 'Fight it')}`,
        '',
        clean(response.summary),
        ...fields.flatMap((field) => ['', `${field.label()}:`, clean(evidence[field.key])]),
        ...(array(response.attachments).length ? ['', `${t('m_28c80635ad0efa', 'Evidence files')}:`, ...array(response.attachments).map((file) => `- ${clean(file.label) || clean(file.file_name)} (${clean(file.file_name)})`)] : [])
      ];
      return lines.join('\n').trim();
    }

    async function uploadFiles(files){
      const open = state.open;
      if (!open?.form || !files.length) return;
      readForm();
      if (open.form.attachments.length + files.length > 20) { toast(t('m_627eee4e46ca16', 'Too many files'), t('m_886a8c8e45d257', 'Attach up to 20 files.'), false); return; }
      open.uploading = true;
      render();
      for (const file of files) {
        try {
          if (file.size > 10 * 1024 * 1024) throw new Error(t('m_5f6c6402c46164', '{name} is over 10 MB.', { name:file.name }));
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('read failed'));
            reader.readAsDataURL(file);
          });
          const result = await call(open.orgId, `/disputes/${encodeURIComponent(open.id)}/evidence`, {
            method:'POST',
            body:{ file_name:file.name, content_type:file.type || 'application/octet-stream', data_base64:data }
          });
          if (state.open !== open) return;
          const stored = object(result?.file);
          const cat = category(open.form.category);
          const used = new Set(open.form.attachments.map((entry) => clean(entry.label)));
          const suggestion = cat.docs.map((key) => DOC_LABELS[key]()).find((label) => !used.has(label)) || '';
          open.form.attachments.push({ ...stored, label:suggestion });
          open.form.dirty = true;
        } catch (error) {
          toast(t('m_eba695c553b0b3', 'Upload failed'), clean(error?.message), false);
        }
      }
      open.uploading = false;
      // Keep the new files: save the draft so they are named on the dispute.
      render();
      await saveResponse('save');
    }

    root.addEventListener('click', async (event) => {
      const target = event.target.closest('button,[data-pmw-row]');
      if (!target || !root.contains(target) || target.disabled) return;
      const open = state.open;
      if (target.matches('[data-pmw-retry]')) return void loadList();
      if (target.matches('[data-pmw-sync]')) return void syncList(true);
      if (target.matches('[data-pmw-filter]')) {
        state.filter = clean(target.dataset.pmwFilter);
        render();
        if (state.filter === 'queue') loadQueue();
        return;
      }
      if (target.matches('[data-pmw-row]')) {
        const staffRow = !!target.dataset.pmwOrg;
        openDispute(target.dataset.pmwRow, staffRow ? target.dataset.pmwOrg : state.orgId, staffRow);
        return;
      }
      if (target.matches('[data-pmw-back]')) return closeDispute();
      if (target.matches('[data-pmw-project]')) { options.onOpenProject?.(target.dataset.pmwProject); return; }
      if (!open?.form) return;
      if (target.matches('[data-pmw-decision]')) {
        readForm();
        open.form.decision = target.dataset.pmwDecision;
        open.form.dirty = true;
        open.status = '';
        render();
        return;
      }
      if (target.matches('[data-pmw-upload]')) { root.querySelector('[data-pmw-file-input]')?.click(); return; }
      if (target.matches('[data-pmw-file-remove]')) {
        readForm();
        open.form.attachments.splice(Number(target.dataset.pmwFileRemove), 1);
        open.form.dirty = true;
        render();
        return;
      }
      if (target.matches('[data-pmw-save]')) return void saveResponse('save');
      if (target.matches('[data-pmw-submit]')) return void saveResponse('submit');
      if (target.matches('[data-pmw-reopen]')) return void saveResponse('reopen');
      if (target.matches('[data-pmw-staff]')) return void staffAct(target.dataset.pmwStaff);
      if (target.matches('[data-pmw-copy]')) {
        try {
          await navigator.clipboard.writeText(copyText(open));
          toast(t('m_16841202d17c7c', 'Copied'), t('m_49509eede4376c', 'Paste it into the response at Forward.'), true);
        } catch (_) {
          ask('prompt', t('m_b68d29b7be4612', 'Copy the response:'), copyText(open));
        }
      }
    });
    root.addEventListener('input', (event) => {
      if (!state.open?.form) return;
      if (event.target.matches('[data-pmw-summary],[data-pmw-evidence],[data-pmw-file-label]')) {
        state.open.form.dirty = true;
        const status = root.querySelector('.pmw-actions .pmw-status');
        if (status) status.textContent = t('m_b3ebdfc21e717e', 'Unsaved changes');
      }
    });
    root.addEventListener('change', (event) => {
      if (!state.open?.form) return;
      if (event.target.matches('[data-pmw-category]')) {
        readForm();
        state.open.form.category = event.target.value;
        state.open.form.dirty = true;
        render();
      }
      if (event.target.matches('[data-pmw-file-input]')) {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        uploadFiles(files);
      }
    });
    root.addEventListener('keydown', (event) => {
      const row = event.target.closest?.('[data-pmw-row]');
      if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); row.click(); }
    });

    loadList().then(() => { if (!state.destroyed) syncList(false); });
    return {
      el:root,
      // A refresh re-reads our list; the processor is asked again at most every 5 minutes.
      refresh(){ return loadList().then(() => { if (Date.now() - state.syncedAt > 300_000) syncList(false); }); },
      setOrg(orgId){ if (clean(orgId) && clean(orgId) !== state.orgId) { state.orgId = clean(orgId); state.list = null; state.open = null; loadList().then(() => syncList(false)); } },
      openDispute(id){ return openDispute(id); },
      destroy(){ state.destroyed = true; root.remove(); }
    };
  }

  window.FirstMatePaymentsWidgets = Object.freeze({ mountPayouts, mountDisputes, categoryFor });
})();
