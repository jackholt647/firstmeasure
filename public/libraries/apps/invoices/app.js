/* public/libraries/apps/invoices/app.js
 * Global Invoices tab: org-wide outstanding invoices with aging, projects that
 * still need billing, quick invoice send, and payment/production-hold controls.
 * Data comes entirely from the payments module; every status shown here is
 * derived server-side from payment obligations — nothing is persisted per-view.
 */
(function(){
  const Portal = window.Portal;
  const runtime = window.FirstMateEmbeddableApps;
  if (!Portal || !runtime?.registerApp) return;

  const util = Portal.util || {};
  const esc = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[match])));
  const injectCSS = util.injectCSS || (() => {});
  const showToast = Portal.ui?.showToast || (() => {});

  function clean(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }
  function object(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function array(value){ return Array.isArray(value) ? value : []; }
  function money(cents){
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style:'currency', currency:'USD', maximumFractionDigits:(Number(cents) || 0) % 100 === 0 ? 0 : 2 }).format((Number(cents) || 0) / 100);
  }
  function shortDate(value){
    const text = clean(value);
    if (!text) return '—';
    const date = new Date(text.length === 10 ? `${text}T12:00:00` : text);
    return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });
  }
  function statusLabel(status){
    const text = clean(status, 'draft');
    return text === 'partially_paid' ? 'Partial' : text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ');
  }
  function daysPast(dueDate){
    const due = Date.parse(`${clean(dueDate)}T00:00:00`);
    if (!Number.isFinite(due)) return 0;
    return Math.floor((Date.now() - due) / 86400000);
  }

  const VIEWS = ['outstanding', 'needs_invoicing', 'history'];
  const OUTSTANDING_STATUSES = ['draft', 'due', 'overdue', 'partially_paid'];

  function injectStyles(){
    injectCSS('invoices-tab-css', `
      .inv-shell{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:#f8fafc}
      .inv-shell *{box-sizing:border-box}
      .inv-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 22px 0}
      .inv-heading{display:flex;align-items:center;gap:13px}
      .inv-heading-icon{width:44px;height:44px;border-radius:13px;display:flex;align-items:center;justify-content:center;background:var(--primary,#d93025);color:#fff;font-size:18px}
      .inv-heading h1{margin:0;font-size:21px}
      .inv-heading p{margin:3px 0 0;color:#667085;font-size:12px;font-weight:700}
      .inv-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:7px 13px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font-size:12px;font-weight:900;cursor:pointer}
      .inv-btn:disabled{opacity:.55;cursor:default}
      .inv-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
      .inv-btn.subtle{border-color:transparent;background:transparent}
      .inv-cards{flex:0 0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;padding:16px 22px 0}
      .inv-card{border:1px solid #e4e7ec;border-radius:13px;background:#fff;padding:13px 15px}
      .inv-card span{display:block;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em}
      .inv-card strong{display:block;margin-top:6px;font-size:21px}
      .inv-card em{display:block;margin-top:3px;color:#667085;font-size:11px;font-style:normal;font-weight:800}
      .inv-card.alert strong{color:#b42318}
      .inv-card.hold strong{color:#93370d}
      .inv-tabs-row{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:16px 22px 0}
      .inv-tabs{display:inline-flex;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:4px;gap:4px}
      .inv-tabs button{border:0;border-radius:8px;background:transparent;color:#475467;padding:8px 14px;font-size:12px;font-weight:900;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .inv-tabs button.active{background:#101828;color:#fff}
      .inv-tabs .inv-count{min-width:20px;padding:2px 6px;border-radius:999px;background:#eef2f6;color:#344054;font-size:10px;font-weight:1000}
      .inv-tabs button.active .inv-count{background:rgba(255,255,255,.2);color:#fff}
      .inv-filters{display:inline-flex;gap:6px;flex-wrap:wrap}
      .inv-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:6px 12px;font-size:11px;font-weight:900;cursor:pointer}
      .inv-chip.active{border-color:#101828;background:#101828;color:#fff}
      .inv-body{flex:1;min-height:0;overflow:auto;padding:14px 22px 24px}
      .inv-table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #e4e7ec;border-radius:13px;overflow:hidden}
      .inv-table th{position:sticky;top:0;background:#f9fafb;color:#475467;text-align:left;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;padding:11px 12px;border-bottom:1px solid #e4e7ec}
      .inv-table td{padding:12px;border-bottom:1px solid #f2f4f7;font-size:12.5px;vertical-align:middle}
      .inv-table tr:last-child td{border-bottom:0}
      .inv-table tr[data-invoice]{cursor:pointer}
      .inv-table tr[data-invoice]:hover td{background:#f9fafb}
      .inv-table .num{text-align:right;font-variant-numeric:tabular-nums}
      .inv-proj strong{display:block}
      .inv-proj span{display:block;margin-top:2px;color:#667085;font-size:11px;font-weight:700}
      .inv-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 9px;background:#f2f4f7;color:#475467;font-size:10.5px;font-weight:1000;text-transform:capitalize;white-space:nowrap}
      .inv-pill.due{background:#eff8ff;color:#175cd3}
      .inv-pill.overdue{background:#fef3f2;color:#b42318}
      .inv-pill.partially_paid{background:#fffaeb;color:#93370d}
      .inv-pill.paid{background:#ecfdf3;color:#067647}
      .inv-pill.void{background:#f2f4f7;color:#98a2b3;text-decoration:line-through}
      .inv-hold-flag{color:#93370d;font-size:13px}
      .inv-late{display:block;margin-top:2px;color:#b42318;font-size:10px;font-weight:900}
      .inv-empty{border:1px dashed #d0d5dd;border-radius:13px;background:#fff;padding:44px 20px;text-align:center;color:#667085}
      .inv-empty i{font-size:30px;margin-bottom:10px;color:#98a2b3}
      .inv-empty strong{display:block;color:#101828;font-size:15px;margin-bottom:4px}
      .inv-groups{display:grid;gap:12px}
      .inv-group{border:1px solid #e4e7ec;border-radius:13px;background:#fff;overflow:hidden}
      .inv-group-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid #f2f4f7}
      .inv-group-head strong{font-size:14px}
      .inv-group-head .inv-proj span{margin-top:2px}
      .inv-group-head aside{display:flex;align-items:center;gap:16px}
      .inv-group-head aside div span{display:block;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase}
      .inv-group-head aside div strong{display:block;margin-top:2px;font-size:16px}
      .inv-obls{display:grid}
      .inv-obl{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid #f6f7f9;font-size:12.5px}
      .inv-obl:last-child{border-bottom:0}
      .inv-obl label{display:flex;align-items:center;gap:10px;flex:1;min-width:0;cursor:pointer}
      .inv-obl input{width:15px;height:15px;accent-color:var(--primary,#d93025)}
      .inv-obl .inv-obl-due{color:#667085;font-size:11px;font-weight:800;white-space:nowrap}
      .inv-obl .num{margin-left:auto;font-weight:900;font-variant-numeric:tabular-nums}
      .inv-shade{position:fixed;inset:0;z-index:2147483200;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:18px}
      .inv-modal{width:min(560px,96vw);max-height:92vh;overflow:auto;border-radius:15px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.4)}
      .inv-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid #eaecf0}
      .inv-modal-head strong{font-size:15px}
      .inv-modal-head button{width:32px;height:32px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;cursor:pointer}
      .inv-modal-body{padding:16px 18px;display:grid;gap:13px}
      .inv-modal-body label{display:grid;gap:5px;font-size:11px;font-weight:1000;color:#475467;text-transform:uppercase;letter-spacing:.04em}
      .inv-modal-body input[type=text],.inv-modal-body input[type=email],.inv-modal-body input[type=date],.inv-modal-body input[type=number],.inv-modal-body select,.inv-modal-body textarea{border:1px solid #d0d5dd;border-radius:9px;padding:9px 11px;font:inherit;font-size:13px}
      .inv-modal-body textarea{min-height:70px;resize:vertical}
      .inv-modal-lines{border:1px solid #eaecf0;border-radius:11px;overflow:hidden}
      .inv-modal-lines>div{display:flex;justify-content:space-between;gap:12px;padding:9px 12px;border-bottom:1px solid #f2f4f7;font-size:12.5px}
      .inv-modal-lines>div:last-child{border-bottom:0}
      .inv-modal-lines .total{background:#f9fafb;font-weight:1000}
      .inv-modal-check{display:flex !important;flex-direction:row;align-items:center;gap:9px;text-transform:none !important;font-size:12.5px !important;font-weight:800 !important;color:#344054 !important}
      .inv-modal-check input{width:15px;height:15px;accent-color:var(--primary,#d93025)}
      .inv-modal-foot{display:flex;justify-content:flex-end;gap:9px;padding:14px 18px;border-top:1px solid #eaecf0}
      .inv-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .inv-detail-grid>div span{display:block;color:#667085;font-size:10px;font-weight:1000;text-transform:uppercase}
      .inv-detail-grid>div strong{display:block;margin-top:3px;font-size:13px}
      .inv-detail-actions{display:flex;flex-wrap:wrap;gap:8px}
      .inv-hold-note{border:1px solid #fedf89;background:#fffaeb;color:#93370d;border-radius:11px;padding:10px 12px;font-size:12px;font-weight:800;display:flex;gap:9px;align-items:flex-start}
      .inv-state{flex:1;display:flex;align-items:center;justify-content:center;color:#667085;font-weight:800;gap:10px}
      @media(max-width:760px){.inv-table th:nth-child(3),.inv-table td:nth-child(3),.inv-table th:nth-child(4),.inv-table td:nth-child(4){display:none}.inv-top,.inv-cards,.inv-tabs-row{padding-left:14px;padding-right:14px}.inv-body{padding:12px 14px 20px}}
    `);
  }

  function createApp(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    injectStyles();

    const route = Portal.navigation?.read?.() || {};
    const state = {
      orgId:clean(context.orgId, context.currentUser?.organization_id, window.__APP?.userOrgId, window.__APP?.orgId),
      view:VIEWS.includes(clean(route.invoicesView)) ? clean(route.invoicesView) : 'outstanding',
      statusFilter:clean(route.invoicesStatus),
      invoices:[],
      summary:{},
      settings:{},
      uninvoiced:[],
      loading:true,
      error:null,
      destroyed:false,
      loadToken:0,
      loadedAt:0,
      active:false,
      openInvoiceId:clean(route.tab) === 'invoices' ? clean(route.invoice) : ''
    };
    let shade = null;

    const api = () => window.PaymentsAPI;

    function routePatch(patch, history = 'replace'){
      if (Portal.navigation?.applying) return;
      Portal.navigation?.[history === 'push' ? 'push' : 'replace']?.({ tab:'invoices', ...patch }, {
        source:'invoices-tab', ownedKeys:['invoicesView', 'invoicesStatus', 'invoice']
      });
    }

    async function load(options = {}){
      const token = ++state.loadToken;
      if (!options.silent) { state.loading = true; render(); }
      state.error = null;
      try {
        const [listResult, uninvoicedResult] = await Promise.all([
          api()?.invoices?.listAll?.(state.orgId),
          api()?.invoices?.uninvoiced?.(state.orgId)
        ]);
        if (state.destroyed || token !== state.loadToken) return;
        state.invoices = array(listResult?.invoices);
        state.summary = object(listResult?.summary);
        state.settings = object(listResult?.settings);
        state.uninvoiced = array(uninvoicedResult?.projects);
        state.loadedAt = Date.now();
      } catch (error) {
        if (state.destroyed || token !== state.loadToken) return;
        state.error = error;
      } finally {
        if (!state.destroyed && token === state.loadToken) { state.loading = false; render(); }
      }
    }

    function invoiceById(id){
      return state.invoices.find((invoice) => clean(invoice.id) === clean(id)) || null;
    }
    function readyCents(){
      return state.uninvoiced.reduce((sum, group) => sum + (Number(group.ready_cents) || 0), 0);
    }
    function readyProjects(){
      return state.uninvoiced.filter((group) => (Number(group.ready_cents) || 0) > 0).length;
    }

    /* ---------- header + summary ---------- */

    function summaryCardsHtml(){
      const summary = state.summary;
      const aging = object(summary.aging);
      const late = (Number(object(aging.days_1_30).cents) || 0) + (Number(object(aging.days_31_60).cents) || 0)
        + (Number(object(aging.days_61_90).cents) || 0) + (Number(object(aging.days_over_90).cents) || 0);
      return `<div class="inv-cards">
        <div class="inv-card"><span>${(globalThis.PlatformLanguage?.text("invoices","m_4dbdd1ef75b232","Outstanding") ?? "Outstanding")}</span><strong>${String(esc(money(summary.outstanding_cents)))}</strong><em>${((v1,v2) => globalThis.PlatformLanguage?.text("invoices","m_53e5c09c00d9bc",`${v1} open invoice${v2}`,{v1,v2}) ?? `${v1} open invoice${v2}`)(Number(summary.outstanding_count) || 0,(Number(summary.outstanding_count) || 0) === 1 ? '' : 's')}</em></div>
        <div class="inv-card ${String(Number(summary.overdue_cents) > 0 ? 'alert' : '')}"><span>${(globalThis.PlatformLanguage?.text("invoices","m_cda60f7c71e465","Overdue") ?? "Overdue")}</span><strong>${String(esc(money(summary.overdue_cents)))}</strong><em>${((v5) => globalThis.PlatformLanguage?.text("invoices","m_8908f4d6b3d1e0",`${v5} past due in aging`,{v5}) ?? `${v5} past due in aging`)(esc(money(late)))}</em></div>
        <div class="inv-card"><span>${(globalThis.PlatformLanguage?.text("invoices","m_2d68d3be56a5d5","Needs invoicing") ?? "Needs invoicing")}</span><strong>${String(esc(money(readyCents())))}</strong><em>${((v7,v8) => globalThis.PlatformLanguage?.text("invoices","m_25c52b780ffec9",`${v7} project${v8} ready to bill`,{v7,v8}) ?? `${v7} project${v8} ready to bill`)(readyProjects(),readyProjects() === 1 ? '' : 's')}</em></div>
        <div class="inv-card"><span>${(globalThis.PlatformLanguage?.text("invoices","m_e342ad7e70d797","Drafts") ?? "Drafts")}</span><strong>${String(esc(money(summary.draft_cents)))}</strong><em>${((v10) => globalThis.PlatformLanguage?.text("invoices","m_653c1089db6e76",`${v10} not sent yet`,{v10}) ?? `${v10} not sent yet`)(Number(summary.draft_count) || 0)}</em></div>
        <div class="inv-card ${String(Number(summary.production_hold_count) > 0 ? 'hold' : '')}"><span>${(globalThis.PlatformLanguage?.text("invoices","m_4dd806ab820ee7","Production holds") ?? "Production holds")}</span><strong>${String(Number(summary.production_hold_count) || 0)}</strong><em>${((v13) => globalThis.PlatformLanguage?.text("invoices","m_a56978a610b31e",`${v13} blocking work`,{v13}) ?? `${v13} blocking work`)(esc(money(summary.production_hold_cents)))}</em></div>
      </div>`;
    }

    function agingChipsHtml(){
      const aging = object(state.summary.aging);
      const buckets = [
        ['', 'All'],
        ['current', `Current · ${money(object(aging.current).cents)}`],
        ['1-30', `1–30 days · ${money(object(aging.days_1_30).cents)}`],
        ['31-60', `31–60 · ${money(object(aging.days_31_60).cents)}`],
        ['61-90', `61–90 · ${money(object(aging.days_61_90).cents)}`],
        ['90+', `90+ · ${money(object(aging.days_over_90).cents)}`]
      ];
      return ("<div class=\"inv-filters\" role=\"group\" aria-label=\"" + (globalThis.PlatformLanguage?.text("invoices","m_efef896c588723","Aging filter") ?? "Aging filter") + "\">" + String(buckets.map(([key, label]) =>
        `<button type="button" class="inv-chip ${state.statusFilter === key ? 'active' : ''}" data-inv-aging="${esc(key)}">${esc(label)}</button>`).join('')) + "</div>");
    }

    function agingBucket(invoice){
      const days = daysPast(invoice.due_date);
      if (days <= 0) return 'current';
      if (days <= 30) return '1-30';
      if (days <= 60) return '31-60';
      if (days <= 90) return '61-90';
      return '90+';
    }

    /* ---------- outstanding + history tables ---------- */

    function invoiceRowsHtml(invoices){
      if (!invoices.length) {
        return `<div class="inv-empty"><i class="fas fa-file-invoice-dollar"></i><strong>${(globalThis.PlatformLanguage?.text("invoices","m_68dbf82a534e40","No invoices here") ?? "No invoices here")}</strong><div>${String(state.view === 'history' ? 'Paid and voided invoices will appear here.' : 'Invoices you create or quick-send will appear here.')}</div></div>`;
      }
      return `<table class="inv-table"><thead><tr><th>${(globalThis.PlatformLanguage?.text("invoices","m_1d5ea39cc421fc","Invoice") ?? "Invoice")}</th><th>${(globalThis.PlatformLanguage?.text("invoices","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.text("invoices","m_ae8e4953e07d70","Customer") ?? "Customer")}</th><th>${(globalThis.PlatformLanguage?.text("invoices","m_103d1f897eea51","Issued") ?? "Issued")}</th><th>${(globalThis.PlatformLanguage?.text("invoices","m_3dac4d5769efeb","Due") ?? "Due")}</th><th>${(globalThis.PlatformLanguage?.text("invoices","m_1352cafa75b8da","Status") ?? "Status")}</th><th class="num">${(globalThis.PlatformLanguage?.text("invoices","m_9403c7637d4905","Total") ?? "Total")}</th><th class="num">${(globalThis.PlatformLanguage?.text("invoices","m_4c3d3abe22cc64","Balance") ?? "Balance")}</th></tr></thead><tbody>
        ${String(invoices.map((invoice) => {
          const project = object(invoice.project_ref);
          const customer = object(invoice.customer);
          const status = clean(invoice.status, 'draft');
          const late = status === 'overdue' ? daysPast(invoice.due_date) : 0;
          const hold = object(invoice.production_hold).enabled === true;
          return `<tr data-invoice="${esc(invoice.id)}" tabindex="0">
            <td><strong>${esc(invoice.invoice_number)}</strong>${hold ? ' <i class="fas fa-hand inv-hold-flag" title="Production hold"></i>' : ''}</td>
            <td class="inv-proj"><strong>${esc(clean(project.title, 'Project'))}</strong><span>${esc(clean(project.address))}</span></td>
            <td>${esc(clean(customer.name, '—'))}</td>
            <td>${esc(shortDate(invoice.issue_date))}</td>
            <td>${esc(shortDate(invoice.due_date))}${late > 0 ? `<span class="inv-late">${late} day${late === 1 ? '' : 's'} late</span>` : ''}</td>
            <td><span class="inv-pill ${esc(status)}">${esc(statusLabel(status))}</span></td>
            <td class="num">${esc(money(invoice.total_cents))}</td>
            <td class="num"><strong>${esc(money(invoice.balance_due_cents))}</strong></td>
          </tr>`;
        }).join(''))}
      </tbody></table>`;
    }

    function visibleInvoices(){
      if (state.view === 'history') {
        return state.invoices.filter((invoice) => ['paid', 'void'].includes(clean(invoice.status)));
      }
      let rows = state.invoices.filter((invoice) => OUTSTANDING_STATUSES.includes(clean(invoice.status, 'draft')));
      if (state.statusFilter) rows = rows.filter((invoice) => agingBucket(invoice) === state.statusFilter);
      return rows;
    }

    /* ---------- needs invoicing ---------- */

    function needsInvoicingHtml(){
      if (!state.uninvoiced.length) {
        return `<div class="inv-empty"><i class="fas fa-circle-check"></i><strong>${(globalThis.PlatformLanguage?.text("invoices","m_a3887b226f7a26","Everything is invoiced") ?? "Everything is invoiced")}</strong><div>${(globalThis.PlatformLanguage?.text("invoices","m_aa808e0784bc06","Payments from signed proposal schedules that have not been invoiced yet will show up here.") ?? "Payments from signed proposal schedules that have not been invoiced yet will show up here.")}</div></div>`;
      }
      return `<div class="inv-groups">${state.uninvoiced.map((group) => {
        const customer = object(group.customer);
        const obligations = array(group.obligations);
        const ready = Number(group.ready_cents) || 0;
        return `<section class="inv-group" data-inv-group="${String(esc(group.project_id))}">
          <div class="inv-group-head">
            <div class="inv-proj"><strong>${String(esc(clean(group.project_title, 'Project')))}</strong><span>${String(esc(clean(customer.name)))}${String(clean(group.project_address) ? ` · ${esc(group.project_address)}` : '')}</span></div>
            <aside>
              <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_54cfffd37995ce","Ready to bill") ?? "Ready to bill")}</span><strong>${String(esc(money(ready)))}</strong></div>
              <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_b5ac06a4625965","Uninvoiced") ?? "Uninvoiced")}</span><strong>${String(esc(money(group.uninvoiced_cents)))}</strong></div>
              <button type="button" class="inv-btn primary" data-inv-quick="${String(esc(group.project_id))}" ${String(obligations.length ? '' : 'disabled')}><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.text("invoices","m_afe97af27aaf04"," Quick send") ?? " Quick send")}</button>
            </aside>
          </div>
          <div class="inv-obls">${String(obligations.map((obligation) => {
            const readyRow = ['due', 'overdue', 'partially_paid'].includes(clean(obligation.status));
            return `<div class="inv-obl">
              <label><input type="checkbox" data-inv-obligation="${esc(obligation.id)}" ${readyRow ? 'checked' : ''}><span>${esc(clean(obligation.label, 'Payment'))}</span></label>
              <span class="inv-obl-due">${clean(obligation.due_at) ? `Due ${esc(shortDate(obligation.due_at))}` : esc(statusLabel(clean(obligation.due_rule, 'scheduled')).replace(/_/g, ' '))}</span>
              <span class="inv-pill ${esc(clean(obligation.status))}">${esc(statusLabel(obligation.status))}</span>
              <span class="num">${esc(money(obligation.open_cents))}</span>
            </div>`;
          }).join(''))}</div>
        </section>`;
      }).join('')}</div>`;
    }

    /* ---------- modals ---------- */

    function closeModal(){
      shade?.remove();
      shade = null;
    }
    function openModal(title, bodyHtml, footHtml){
      closeModal();
      shade = document.createElement('div');
      shade.className = 'inv-shade';
      shade.innerHTML = `<div class="inv-modal" role="dialog" aria-modal="true" aria-label="${String(esc(title))}">
        <div class="inv-modal-head"><strong>${String(esc(title))}</strong><button type="button" data-inv-close aria-label="${(globalThis.PlatformLanguage?.text("invoices","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
        <div class="inv-modal-body">${String(bodyHtml)}</div>
        ${String(footHtml ? `<div class="inv-modal-foot">${footHtml}</div>` : '')}
      </div>`;
      shade.addEventListener('click', (event) => { if (event.target === shade) closeModal(); });
      shade.querySelector('[data-inv-close]')?.addEventListener('click', closeModal);
      document.body.appendChild(shade);
      return shade;
    }

    async function run(button, work, successTitle, successMessage){
      if (button) button.disabled = true;
      try {
        await work();
        closeModal();
        showToast(successTitle, successMessage, true);
        await load({ silent:true });
      } catch (error) {
        if (button) button.disabled = false;
        showToast((globalThis.PlatformLanguage?.text("invoices","m_a8f5c20e1ab081","That did not work") ?? "That did not work"), error?.message || 'Try again shortly.', false);
      }
    }

    function openQuickSend(projectId){
      const group = state.uninvoiced.find((item) => clean(item.project_id) === clean(projectId));
      if (!group) return;
      const groupRoot = root.querySelector(`[data-inv-group="${CSS.escape(clean(projectId))}"]`);
      const checkedIds = Array.from(groupRoot?.querySelectorAll('[data-inv-obligation]:checked') || [])
        .map((input) => clean(input.dataset.invObligation));
      const obligations = array(group.obligations).filter((obligation) => checkedIds.includes(clean(obligation.id)));
      if (!obligations.length) { showToast((globalThis.PlatformLanguage?.text("invoices","m_d0dd7cc24f327a","Nothing selected") ?? "Nothing selected"), (globalThis.PlatformLanguage?.text("invoices","m_f32fe1266e8de8","Check at least one payment to invoice.") ?? "Check at least one payment to invoice."), false); return; }
      const total = obligations.reduce((sum, obligation) => sum + (Number(obligation.open_cents) || 0), 0);
      const customer = object(group.customer);
      const dueDays = Number(state.settings.default_due_days) || 0;
      const modal = openModal(`Invoice ${clean(group.project_title, 'project')}`, `
        <div class="inv-modal-lines">
          ${String(obligations.map((obligation) => `<div><span>${esc(clean(obligation.label, 'Payment'))}</span><strong>${esc(money(obligation.open_cents))}</strong></div>`).join(''))}
          <div class="total"><span>${((v1) => globalThis.PlatformLanguage?.text("invoices","m_12a7cf8be65a45",`Invoice total${v1}`,{v1}) ?? `Invoice total${v1}`)(dueDays ? ` · due ${dueDays} day${dueDays === 1 ? '' : 's'} after issue` : ' · due on receipt')}</span><strong>${String(esc(money(total)))}</strong></div>
        </div>
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_8ea15c3c9b6b15","Send to") ?? "Send to")}<input type="email" data-inv-field="recipient" value="${String(esc(clean(customer.email)))}" placeholder="${(globalThis.PlatformLanguage?.text("invoices","m_f4baf1974f472e","customer@email.com") ?? "customer@email.com")}"></label>
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_1cc093ae43d736","Message (optional)") ?? "Message (optional)")}<textarea data-inv-field="message" placeholder="${(globalThis.PlatformLanguage?.text("invoices","m_0a914652da199e","Added to the invoice email.") ?? "Added to the invoice email.")}"></textarea></label>
        <label class="inv-modal-check"><input type="checkbox" data-inv-field="portal" checked>${(globalThis.PlatformLanguage?.text("invoices","m_41d5592457592e","Include a customer portal payment link") ?? "Include a customer portal payment link")}</label>
      `, `
        <button type="button" class="inv-btn" data-inv-run="draft"><i class="fas fa-file-lines"></i>${(globalThis.PlatformLanguage?.text("invoices","m_41345d62fd1e26"," Create draft") ?? " Create draft")}</button>
        <button type="button" class="inv-btn primary" data-inv-run="send"><i class="fas fa-paper-plane"></i>${(globalThis.PlatformLanguage?.text("invoices","m_0e86e0e0285518"," Send invoice") ?? " Send invoice")}</button>
      `);
      modal.querySelectorAll('[data-inv-run]').forEach((button) => button.addEventListener('click', () => {
        const send = button.dataset.invRun === 'send';
        const recipient = clean(modal.querySelector('[data-inv-field="recipient"]')?.value);
        if (send && !recipient) { showToast((globalThis.PlatformLanguage?.text("invoices","m_642dd51b07acb4","Recipient required") ?? "Recipient required"), (globalThis.PlatformLanguage?.text("invoices","m_6194e45b3022dc","Add a customer email address to send this invoice.") ?? "Add a customer email address to send this invoice."), false); return; }
        run(button, () => api().invoices.quick(state.orgId, projectId, {
          obligation_ids:checkedIds,
          send,
          ...(send ? { recipient } : {}),
          include_portal_link:modal.querySelector('[data-inv-field="portal"]')?.checked !== false,
          ...(clean(modal.querySelector('[data-inv-field="message"]')?.value) ? { message:clean(modal.querySelector('[data-inv-field="message"]').value) } : {})
        }), send ? 'Invoice sent' : 'Draft created', send ? `${money(total)} invoice emailed to ${recipient}.` : `${money(total)} draft invoice created.`);
      }));
    }

    function openSend(invoice, { reminder = false } = {}){
      const customer = object(invoice.customer);
      const modal = openModal(reminder ? `Payment reminder · ${clean(invoice.invoice_number)}` : `Send ${clean(invoice.invoice_number)}`, `
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_8ea15c3c9b6b15","Send to") ?? "Send to")}<input type="email" data-inv-field="recipient" value="${String(esc(clean(customer.email)))}" placeholder="${(globalThis.PlatformLanguage?.text("invoices","m_f4baf1974f472e","customer@email.com") ?? "customer@email.com")}"></label>
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_1cc093ae43d736","Message (optional)") ?? "Message (optional)")}<textarea data-inv-field="message">${String(reminder ? esc(`Friendly reminder: invoice ${clean(invoice.invoice_number)} for ${money(invoice.balance_due_cents)} is ${clean(invoice.status) === 'overdue' ? 'past due' : 'outstanding'}.`) : '')}</textarea></label>
        <label class="inv-modal-check"><input type="checkbox" data-inv-field="portal" checked>${(globalThis.PlatformLanguage?.text("invoices","m_41d5592457592e","Include a customer portal payment link") ?? "Include a customer portal payment link")}</label>
      `, `<button type="button" class="inv-btn primary" data-inv-run="send"><i class="fas fa-paper-plane"></i> ${reminder ? 'Send reminder' : 'Send invoice'}</button>`);
      modal.querySelector('[data-inv-run="send"]')?.addEventListener('click', (event) => {
        const recipient = clean(modal.querySelector('[data-inv-field="recipient"]')?.value);
        if (!recipient) { showToast((globalThis.PlatformLanguage?.text("invoices","m_642dd51b07acb4","Recipient required") ?? "Recipient required"), (globalThis.PlatformLanguage?.text("invoices","m_60d5a9767bf392","Add a customer email address.") ?? "Add a customer email address."), false); return; }
        run(event.currentTarget, () => api().invoices.email(state.orgId, invoice.id, {
          recipient,
          include_portal_link:modal.querySelector('[data-inv-field="portal"]')?.checked !== false,
          ...(clean(modal.querySelector('[data-inv-field="message"]')?.value) ? { message:clean(modal.querySelector('[data-inv-field="message"]').value) } : {})
        }), reminder ? 'Reminder sent' : 'Invoice sent', `Emailed to ${recipient}.`);
      });
    }

    function openRecordPayment(invoice){
      const balance = Number(invoice.balance_due_cents) || 0;
      const modal = openModal(`Record payment · ${clean(invoice.invoice_number)}`, `
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_2b8c3448fa87a1","Amount") ?? "Amount")}<input type="number" data-inv-field="amount" min="0.01" step="0.01" value="${String((balance / 100).toFixed(2))}"></label>
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_6952fe71f8dc85","Method") ?? "Method")}<select data-inv-field="method"><option value="check">${(globalThis.PlatformLanguage?.text("invoices","m_cc74e4e6c905ec","Check") ?? "Check")}</option><option value="cash">${(globalThis.PlatformLanguage?.text("invoices","m_f758b041cf8d5c","Cash") ?? "Cash")}</option><option value="ach">${(globalThis.PlatformLanguage?.text("invoices","m_cbee52f472a222","Bank transfer") ?? "Bank transfer")}</option><option value="card">${(globalThis.PlatformLanguage?.text("invoices","m_1c7d0d61ca4acd","Card (offline)") ?? "Card (offline)")}</option><option value="other">${(globalThis.PlatformLanguage?.text("invoices","m_4a04382820d2e1","Other") ?? "Other")}</option></select></label>
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_cc60ed0361b690","Reference / note (optional)") ?? "Reference / note (optional)")}<input type="text" data-inv-field="note" placeholder="${(globalThis.PlatformLanguage?.text("invoices","m_486e0e4a6f4872","Check #, confirmation, etc.") ?? "Check #, confirmation, etc.")}"></label>
      `, `<button type="button" class="inv-btn primary" data-inv-run="record"><i class="fas fa-money-check-dollar"></i>${(globalThis.PlatformLanguage?.text("invoices","m_a7ed489b9d2e04"," Record payment") ?? " Record payment")}</button>`);
      modal.querySelector('[data-inv-run="record"]')?.addEventListener('click', (event) => {
        const amountCents = Math.round(Number(modal.querySelector('[data-inv-field="amount"]')?.value || 0) * 100);
        if (!(amountCents > 0)) { showToast((globalThis.PlatformLanguage?.text("invoices","m_8c6b93a6f46da8","Amount required") ?? "Amount required"), (globalThis.PlatformLanguage?.text("invoices","m_25db752992dcde","Enter a payment amount greater than zero.") ?? "Enter a payment amount greater than zero."), false); return; }
        run(event.currentTarget, async () => {
          // Allocate explicitly across this invoice's open obligations (in due
          // order) so the payment cannot drift to other receivables on the job.
          const open = array(invoice.obligations)
            .filter((obligation) => !['paid', 'void'].includes(clean(obligation.status)))
            .map((obligation) => ({ id:clean(obligation.id), open:Math.max(0, (Number(obligation.amount_cents) || 0) - (Number(obligation.allocated_cents) || 0)) }))
            .filter((obligation) => obligation.open > 0);
          const result = await api().payments.create(state.orgId, {
            project_id:clean(invoice.project_id),
            amount_cents:amountCents,
            kind:'customer_payment',
            allocate:false,
            method:{ type:clean(modal.querySelector('[data-inv-field="method"]')?.value, 'other') },
            notes:clean(modal.querySelector('[data-inv-field="note"]')?.value),
            metadata:{ invoice_id:clean(invoice.id) }
          });
          let remaining = amountCents;
          const allocations = [];
          for (const obligation of open) {
            if (remaining <= 0) break;
            const slice = Math.min(remaining, obligation.open);
            allocations.push({ obligation_id:obligation.id, amount_cents:slice });
            remaining -= slice;
          }
          if (allocations.length) {
            await api().payments.reallocate(state.orgId, clean(result?.payment?.id), { allocations });
          }
        }, 'Payment recorded', `${money(amountCents)} applied to ${clean(invoice.invoice_number)}.`);
      });
    }

    function openVoid(invoice){
      const modal = openModal(`Void ${clean(invoice.invoice_number)}`, `
        <p style="margin:0;color:#475467;font-size:13px;line-height:1.5">${(globalThis.PlatformLanguage?.text("invoices","m_c054461f0239b3","Voiding removes this invoice from outstanding balances. Payments from the proposal schedule stay collectible and return to the needs-invoicing list.") ?? "Voiding removes this invoice from outstanding balances. Payments from the proposal schedule stay collectible and return to the needs-invoicing list.")}</p>
        <label>${(globalThis.PlatformLanguage?.text("invoices","m_da81805c527616","Reason (optional)") ?? "Reason (optional)")}<input type="text" data-inv-field="reason" placeholder="${(globalThis.PlatformLanguage?.text("invoices","m_746208a72bcd7d","Why is this invoice being voided?") ?? "Why is this invoice being voided?")}"></label>
      `, `<button type="button" class="inv-btn primary" data-inv-run="void"><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.text("invoices","m_589d10fd2ddd52"," Void invoice") ?? " Void invoice")}</button>`);
      modal.querySelector('[data-inv-run="void"]')?.addEventListener('click', (event) => {
        run(event.currentTarget, () => api().invoices.voidInvoice(state.orgId, invoice.id, {
          reason:clean(modal.querySelector('[data-inv-field="reason"]')?.value)
        }), 'Invoice voided', `${clean(invoice.invoice_number)} was voided.`);
      });
    }

    function openHold(invoice){
      const hold = object(invoice.production_hold);
      const enabled = hold.enabled === true;
      const modal = openModal(`Production hold · ${clean(invoice.invoice_number)}`, `
        <p style="margin:0;color:#475467;font-size:13px;line-height:1.5">${enabled
          ? 'This invoice is currently holding production. Clearing the hold lets scheduled work continue.'
          : 'Flag this invoice as blocking production. The hold shows on the project and is visible to work automations until the balance clears.'}</p>
        ${enabled ? '' : `<label>${(globalThis.PlatformLanguage?.text("invoices","m_63b99552978591","Note (optional)") ?? "Note (optional)")}<input type="text" data-inv-field="note" placeholder="${(globalThis.PlatformLanguage?.text("invoices","m_4f27abc0733ecb","e.g. Deposit required before install") ?? "e.g. Deposit required before install")}" value="${String(esc(clean(hold.note)))}"></label>`}
      `, `<button type="button" class="inv-btn primary" data-inv-run="hold"><i class="fas fa-hand"></i> ${enabled ? 'Clear hold' : 'Hold production'}</button>`);
      modal.querySelector('[data-inv-run="hold"]')?.addEventListener('click', (event) => {
        run(event.currentTarget, () => api().invoices.setProductionHold(state.orgId, invoice.id, {
          enabled:!enabled,
          ...(enabled ? {} : { note:clean(modal.querySelector('[data-inv-field="note"]')?.value) })
        }), enabled ? 'Hold cleared' : 'Production held', enabled ? 'Work can continue on this project.' : `${clean(invoice.invoice_number)} now blocks production until paid.`);
      });
    }

    function openDetail(invoiceId, { fromRoute = false } = {}){
      const invoice = invoiceById(invoiceId);
      if (!invoice) return;
      if (!fromRoute) routePatch({ invoice:clean(invoice.id) }, 'push');
      state.openInvoiceId = clean(invoice.id);
      const customer = object(invoice.customer);
      const project = object(invoice.project_ref);
      const hold = object(invoice.production_hold);
      const status = clean(invoice.status, 'draft');
      const deliveries = array(invoice.email_deliveries);
      const lastDelivery = deliveries[deliveries.length - 1];
      const canSend = !['paid', 'void'].includes(status);
      const modal = openModal(`${clean(invoice.invoice_number)} · ${money(invoice.total_cents)}`, `
        ${String(hold.enabled === true ? `<div class="inv-hold-note"><i class="fas fa-hand"></i><span>Production hold${clean(hold.note) ? ` — ${esc(hold.note)}` : ''}. Work is blocked until this invoice is paid.</span></div>` : '')}
        <div class="inv-detail-grid">
          <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_1352cafa75b8da","Status") ?? "Status")}</span><strong><span class="inv-pill ${String(esc(status))}">${String(esc(statusLabel(status)))}</span></strong></div>
          <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_74667921211303","Balance due") ?? "Balance due")}</span><strong>${String(esc(money(invoice.balance_due_cents)))}${String(Number(invoice.amount_paid_cents) > 0 ? ` <em style="color:#067647;font-style:normal;font-size:11px">(${esc(money(invoice.amount_paid_cents))} paid)</em>` : '')}</strong></div>
          <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_aaebd7ccba0b30","Project") ?? "Project")}</span><strong>${String(esc(clean(project.title, '—')))}</strong></div>
          <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_ae8e4953e07d70","Customer") ?? "Customer")}</span><strong>${String(esc(clean(customer.name, '—')))}</strong></div>
          <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_103d1f897eea51","Issued") ?? "Issued")}</span><strong>${String(esc(shortDate(invoice.issue_date)))}</strong></div>
          <div><span>${(globalThis.PlatformLanguage?.text("invoices","m_3dac4d5769efeb","Due") ?? "Due")}</span><strong>${String(esc(shortDate(invoice.due_date)))}</strong></div>
        </div>
        <div class="inv-modal-lines">
          ${String(array(invoice.line_items).map((line) => `<div><span>${esc(clean(object(line).description, 'Item'))}</span><strong>${esc(money(object(line).amount_cents))}</strong></div>`).join(''))}
          ${String(Number(invoice.tax_cents) > 0 ? `<div><span>Sales tax (${esc(String(Number(invoice.tax_percent) || 0))}%)</span><strong>${esc(money(invoice.tax_cents))}</strong></div>` : '')}
          <div class="total"><span>${(globalThis.PlatformLanguage?.text("invoices","m_9403c7637d4905","Total") ?? "Total")}</span><strong>${String(esc(money(invoice.total_cents)))}</strong></div>
        </div>
        ${String(lastDelivery ? `<p style="margin:0;color:#667085;font-size:12px;font-weight:700"><i class="fas fa-envelope"></i> Last ${object(lastDelivery).sent === true ? 'sent' : 'attempted'} to ${esc(clean(object(lastDelivery).recipient))} · ${esc(shortDate(object(lastDelivery).attempted_at))}</p>` : '')}
        <div class="inv-detail-actions">
          ${String(canSend ? `<button type="button" class="inv-btn primary" data-inv-action="send"><i class="fas fa-paper-plane"></i> ${deliveries.length ? 'Resend' : 'Send'}</button>` : '')}
          ${String(canSend && deliveries.length ? '<button type="button" class="inv-btn" data-inv-action="remind"><i class="fas fa-bell"></i> Reminder</button>' : '')}
          ${String(canSend ? '<button type="button" class="inv-btn" data-inv-action="payment"><i class="fas fa-money-check-dollar"></i> Record payment</button>' : '')}
          <a class="inv-btn" href="${String(esc(api()?.invoices?.pdfUrl?.(state.orgId, invoice.id) || '#'))}" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i>${(globalThis.PlatformLanguage?.text("invoices","m_ff8d3e1189f812"," PDF") ?? " PDF")}</a>
          ${String(status !== 'void' ? `<button type="button" class="inv-btn" data-inv-action="hold"><i class="fas fa-hand"></i> ${hold.enabled === true ? 'Clear hold' : 'Hold production'}</button>` : '')}
          ${String(canSend ? '<button type="button" class="inv-btn" data-inv-action="void"><i class="fas fa-ban"></i> Void</button>' : '')}
          <button type="button" class="inv-btn subtle" data-inv-action="project"><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.text("invoices","m_53787840db7d1c"," Open project") ?? " Open project")}</button>
        </div>
      `, '');
      const closeDetailRoute = () => {
        if (clean((Portal.navigation?.read?.() || {}).invoice) === clean(invoice.id)) {
          Portal.navigation?.backOrClose?.(['invoice'], { invoice:null }, { source:'invoices-detail-close' });
        }
        state.openInvoiceId = '';
      };
      shade.addEventListener('click', (event) => { if (event.target === shade) closeDetailRoute(); });
      modal.querySelector('[data-inv-close]')?.addEventListener('click', closeDetailRoute);
      modal.querySelectorAll('[data-inv-action]').forEach((button) => button.addEventListener('click', () => {
        const action = button.dataset.invAction;
        if (action === 'project') {
          closeModal();
          Portal.navigation?.push?.({ project:clean(invoice.project_id), projectTab:'money', moneyView:'invoices' }, { source:'invoices-tab-project', ownedKeys:['project', 'projectTab'] });
          return;
        }
        state.openInvoiceId = '';
        routePatch({ invoice:null }, 'replace');
        if (action === 'send') openSend(invoice);
        if (action === 'remind') openSend(invoice, { reminder:true });
        if (action === 'payment') openRecordPayment(invoice);
        if (action === 'void') openVoid(invoice);
        if (action === 'hold') openHold(invoice);
      }));
    }

    /* ---------- render ---------- */

    function render(){
      if (state.destroyed) return;
      if (state.loading && !state.invoices.length) {
        root.innerHTML = `<div class="inv-shell"><div class="inv-state"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("invoices","m_6a61f184648ac2"," Loading invoices...") ?? " Loading invoices...")}</div></div>`;
        return;
      }
      if (state.error) {
        root.innerHTML = `<div class="inv-shell"><div class="inv-state" style="flex-direction:column"><i class="fas fa-triangle-exclamation" style="font-size:26px"></i><div>${String(esc(state.error?.message || 'Invoices could not load.'))}</div><button type="button" class="inv-btn" data-inv-refresh><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.text("invoices","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div></div>`;
        root.querySelector('[data-inv-refresh]')?.addEventListener('click', () => load());
        return;
      }
      const needsCount = readyProjects();
      root.innerHTML = `<div class="inv-shell">
        <header class="inv-top">
          <div class="inv-heading"><span class="inv-heading-icon"><i class="fas fa-file-invoice-dollar"></i></span><span><h1>${String(esc(Portal.terminology?.get?.('invoices.portal_tab', 'Invoices') || 'Invoices'))}</h1><p>${(globalThis.PlatformLanguage?.text("invoices","m_98f85e256f1ab1","Outstanding balances, jobs to bill, and payment status across every project.") ?? "Outstanding balances, jobs to bill, and payment status across every project.")}</p></span></div>
          <button type="button" class="inv-btn" data-inv-refresh ${String(state.loading ? 'disabled' : '')}><i class="fas ${String(state.loading ? 'fa-circle-notch fa-spin' : 'fa-rotate')}"></i><span>${(globalThis.PlatformLanguage?.text("invoices","m_78973ce0cf3403","Refresh") ?? "Refresh")}</span></button>
        </header>
        ${String(summaryCardsHtml())}
        <div class="inv-tabs-row">
          <div class="inv-tabs" role="tablist" aria-label="${(globalThis.PlatformLanguage?.text("invoices","m_fae86dba7fee35","Invoice views") ?? "Invoice views")}">
            <button type="button" role="tab" data-inv-view="outstanding" class="${String(state.view === 'outstanding' ? 'active' : '')}" aria-selected="${String(state.view === 'outstanding')}"><i class="fas fa-hourglass-half"></i>${(globalThis.PlatformLanguage?.text("invoices","m_9d1ec8c49d6f47"," Outstanding") ?? " Outstanding")}</button>
            <button type="button" role="tab" data-inv-view="needs_invoicing" class="${String(state.view === 'needs_invoicing' ? 'active' : '')}" aria-selected="${String(state.view === 'needs_invoicing')}"><i class="fas fa-bolt"></i>${(globalThis.PlatformLanguage?.text("invoices","m_8c92e8f6e62299"," Needs invoicing ") ?? " Needs invoicing ")}<span class="inv-count">${String(needsCount)}</span></button>
            <button type="button" role="tab" data-inv-view="history" class="${String(state.view === 'history' ? 'active' : '')}" aria-selected="${String(state.view === 'history')}"><i class="fas fa-clock-rotate-left"></i>${(globalThis.PlatformLanguage?.text("invoices","m_b78c21a6c3a083"," History") ?? " History")}</button>
          </div>
          ${String(state.view === 'outstanding' ? agingChipsHtml() : '')}
        </div>
        <div class="inv-body">
          ${String(state.view === 'needs_invoicing' ? needsInvoicingHtml() : invoiceRowsHtml(visibleInvoices()))}
        </div>
      </div>`;

      root.querySelector('[data-inv-refresh]')?.addEventListener('click', () => load());
      root.querySelectorAll('[data-inv-view]').forEach((button) => button.addEventListener('click', () => {
        if (state.view === button.dataset.invView) return;
        state.view = button.dataset.invView;
        routePatch({ invoicesView:state.view, invoicesStatus:null }, 'push');
        state.statusFilter = '';
        render();
      }));
      root.querySelectorAll('[data-inv-aging]').forEach((button) => button.addEventListener('click', () => {
        state.statusFilter = clean(button.dataset.invAging);
        routePatch({ invoicesStatus:state.statusFilter || null }, 'replace');
        render();
      }));
      root.querySelectorAll('tr[data-invoice]').forEach((row) => {
        row.addEventListener('click', () => openDetail(row.dataset.invoice));
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter') openDetail(row.dataset.invoice); });
      });
      root.querySelectorAll('[data-inv-quick]').forEach((button) => button.addEventListener('click', () => openQuickSend(button.dataset.invQuick)));

      if (state.openInvoiceId && !shade) openDetail(state.openInvoiceId, { fromRoute:true });
    }

    const unregisterRoute = Portal.navigation?.registerHandler?.(`invoices-route:${context.instanceId || 'main'}`, {
      priority:415,
      immediate:true,
      apply(nextRoute){
        if (nextRoute.tab !== 'invoices') return;
        const nextView = VIEWS.includes(clean(nextRoute.invoicesView)) ? clean(nextRoute.invoicesView) : 'outstanding';
        const nextFilter = clean(nextRoute.invoicesStatus);
        const nextInvoice = clean(nextRoute.invoice);
        const changed = state.view !== nextView || state.statusFilter !== nextFilter;
        state.view = nextView;
        state.statusFilter = nextFilter;
        if (!nextInvoice && state.openInvoiceId) { state.openInvoiceId = ''; closeModal(); }
        if (nextInvoice && nextInvoice !== state.openInvoiceId && state.invoices.length) openDetail(nextInvoice, { fromRoute:true });
        if (changed && !state.loading) render();
      }
    });

    const refreshEvents = ['fm:money:updated', 'fm:projects:refresh', 'fm:dashboard:refresh'];
    const scheduleRefresh = () => { if (state.active && !state.loading) load({ silent:true }); };
    refreshEvents.forEach((name) => window.addEventListener(name, scheduleRefresh));
    load();

    return {
      destroy(){
        state.destroyed = true;
        state.loadToken++;
        closeModal();
        unregisterRoute?.();
        refreshEvents.forEach((name) => window.removeEventListener(name, scheduleRefresh));
        root.innerHTML = '';
      },
      setActive(active){
        state.active = !!active;
        if (active && Date.now() - state.loadedAt > 60000 && !state.loading) load({ silent:!!state.invoices.length });
      },
      update(nextContext = {}){
        const nextOrg = clean(nextContext.orgId, nextContext.currentUser?.organization_id);
        if (nextOrg && nextOrg !== state.orgId) { state.orgId = nextOrg; state.invoices = []; load(); }
      },
      refresh(){ return load(); }
    };
  }

  runtime.registerApp({
    id:'portal.invoices',
    package:'invoices',
    kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("invoices","m_74b68c454b06a0","Invoices") ?? "Invoices"),
    label:(globalThis.PlatformLanguage?.text("invoices","m_74b68c454b06a0","Invoices") ?? "Invoices"),
    icon:'fa-file-invoice-dollar',
    order:51,
    surfaces:['portal_tab'],
    regions:['main'],
    visible:true,
    fullBleed:true,
    access:{ applicationsAny:['management'], permissionsAny:['manage_projects', 'manage_payroll', 'manage_company_settings'] },
    mount:createApp
  });
})();
