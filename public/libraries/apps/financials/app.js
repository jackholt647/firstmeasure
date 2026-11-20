/* public/libraries/apps/financials/app.js
 * Global project profitability and cash-flow forecasting workspace.
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const array = (value) => Array.isArray(value) ? value : [];
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const clean = (value) => String(value ?? '').trim();
  const number = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[match]));

  function date(value){
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value) : null;
    const text = clean(value);
    if (!text) return null;
    const plain = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = plain ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]), 12) : new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function dayStart(value){
    const result = date(value) || new Date();
    result.setHours(0, 0, 0, 0);
    return result;
  }

  function addDays(value, amount){
    const result = dayStart(value);
    result.setDate(result.getDate() + Number(amount || 0));
    return result;
  }

  function dateKey(value){
    const result = date(value);
    if (!result) return '';
    return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}-${String(result.getDate()).padStart(2, '0')}`;
  }

  function dateLabel(value, options = {}){
    const result = date(value);
    if (!result) return 'Unscheduled';
    return result.toLocaleDateString(undefined, {
      month:options.long ? 'long' : 'short',
      day:'numeric',
      ...(options.year === false ? {} : { year:'numeric' })
    });
  }

  // Payouts and Disputes are the shared payments widgets (GP-76), the same
  // ones Settings › Money shows. GP-113: Payouts also holds what Reconcile was
  // (recorded payments to confirm at the bank), and Receipts lists every receipt.
  const DATED_VIEWS = ['projects', 'cashflow'];
  const legacyView = (value) => String(value ?? '').trim() === 'reconcile' ? 'payouts' : value;
  const normalizeFinancialView = (value) => ['cashflow', 'payouts', 'receipts', 'disputes'].includes(String(legacyView(value) ?? '').trim()) ? String(legacyView(value)).trim() : 'projects';
  // GP-113: the header filters each view offers. Values are kept per browser, so a filter stays while you move
  // between views and when you come back.
  const FILTER_KEY = 'fm:financial:filters';
  const FILTER_FIELDS = {
    q:{ label:(globalThis.PlatformLanguage?.text("financials","m_55524759bb89e3","Search") ?? "Search"), kind:'search' },
    // Profitability lists open projects unless asked; cash flow counts every project unless asked.
    status:{ label:(globalThis.PlatformLanguage?.text("financials","m_19156e80fc8a6e","Projects") ?? "Projects"), options:[['', 'Open projects'], ['closed', 'Closed projects'], ['all', 'All projects']], cashflow:[['', 'All projects'], ['open', 'Open projects'], ['closed', 'Closed projects']] },
    schedule:{ label:(globalThis.PlatformLanguage?.text("financials","m_fc05a804bd034c","Schedule") ?? "Schedule"), options:[['', 'Any schedule'], ['scheduled', 'On the calendar'], ['unscheduled', 'Not on the calendar']] },
    result:{ label:(globalThis.PlatformLanguage?.text("financials","m_7373a19a37d7ad","Projected profit") ?? "Projected profit"), options:[['', 'Any result'], ['profit', 'Making money'], ['loss', 'Losing money']] },
    payroll:{ label:(globalThis.PlatformLanguage?.text("financials","m_45e0abb75231e4","Payroll") ?? "Payroll"), options:[['', 'Include payroll'], ['exclude', 'Leave out payroll']] },
    review:{ label:(globalThis.PlatformLanguage?.text("financials","m_b0bb1e74e2a6d3","Review") ?? "Review"), options:[['', 'All receipts'], ['needs_review', 'Needs review'], ['reviewed', 'Reviewed'], ['unassigned', 'No project']] },
    uploader:{ label:(globalThis.PlatformLanguage?.text("financials","m_5dbb1b599b0286","Uploaded by") ?? "Uploaded by"), options:[['', 'Anyone']] }
  };
  const VIEW_FILTERS = {
    projects:['q', 'status', 'schedule', 'result'],
    cashflow:['q', 'status', 'schedule', 'payroll'],
    receipts:['q', 'review', 'uploader']
  };

  function money(value, compact = false){
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), {
      style:'currency', currency:'USD',
      notation:compact && Math.abs(number(value)) >= 100_000 ? 'compact' : 'standard',
      maximumFractionDigits:compact ? 1 : 0
    }).format(number(value) / 100);
  }

  // Exact currency for processor amounts — fees and merchant nets are rarely
  // whole dollars, so show cents whenever they are present.
  function moneyFine(value){
    const cents = number(value);
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), {
      style:'currency', currency:'USD',
      minimumFractionDigits:cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits:2
    }).format(cents / 100);
  }

  // GP-134: a phone figure in a tile or a list: whole dollars under $1,000, then $1.2K, $12K, $1.2M.
  function moneyShort(value){
    const dollars = number(value) / 100;
    return new Intl.NumberFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), {
      style:'currency', currency:'USD',
      notation:Math.abs(dollars) >= 1000 ? 'compact' : 'standard',
      minimumFractionDigits:0, maximumFractionDigits:Math.abs(dollars) >= 1000 ? 1 : 0
    }).format(dollars);
  }

  function percent(value){
    return `${Math.round(Number(value || 0))}%`;
  }

  function rangeFor(grain, anchorValue){
    const anchor = dayStart(anchorValue);
    let start = new Date(anchor);
    let end = addDays(anchor, 1);
    if (grain === 'month') {
      start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    } else if (grain === 'week') {
      const mondayOffset = (anchor.getDay() + 6) % 7;
      start = addDays(anchor, -mondayOffset);
      end = addDays(start, 7);
    }
    return { start, end, endInclusive:new Date(end.getTime() - 1), key:dateKey(start) };
  }

  function shiftAnchor(grain, anchorValue, direction){
    const anchor = dayStart(anchorValue);
    if (grain === 'month') return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
    return addDays(anchor, direction * (grain === 'week' ? 7 : 1));
  }

  function rangeTitle(grain, range){
    if (grain === 'month') return range.start.toLocaleDateString(undefined, { month:'long', year:'numeric' });
    if (grain === 'day') return range.start.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric', year:'numeric' });
    return `${dateLabel(range.start)} – ${dateLabel(range.endInclusive)}`;
  }

  // GP-134: the period as a phone's period control names it (Nov 2026, Nov 16 – Nov 22, Fri, Nov 20).
  function rangeTitleShort(grain, range){
    if (grain === 'month') return range.start.toLocaleDateString(undefined, { month:'short', year:'numeric' });
    if (grain === 'day') return range.start.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric' });
    return `${dateLabel(range.start, { year:false })} – ${dateLabel(range.endInclusive, { year:false })}`;
  }

  // GP-134: a phone gets its own layout (the shared tab strip, one row of figures, lists instead of tables), at the
  // width app-chrome.js switches its strip to the phone row. A desktop renders exactly as before.
  const phoneQuery = window.matchMedia?.('(max-width:800px)');
  const isPhone = () => !!phoneQuery?.matches;

  function injectCss(){
    if (document.getElementById('firstmate-financials-css')) return;
    const style = document.createElement('style');
    style.id = 'firstmate-financials-css';
    style.textContent = `
      .fn-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f5f7fa;color:#101828}
      .fn-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;background:#fff;border-bottom:1px solid #e4e7ec}.fn-heading{display:flex;align-items:center;gap:11px;min-width:0}.fn-heading-icon{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#ecfdf3;color:#067647;font-size:17px}.fn-heading h1{margin:0;font-size:19px;letter-spacing:-.02em}.fn-heading p{margin:3px 0 0;color:#667085;font-size:11px;font-weight:750}.fn-top-actions{display:flex;gap:8px;align-items:center}
      .fn-btn{min-height:35px;padding:7px 11px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-weight:850;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}.fn-btn:hover:not(:disabled){border-color:#98a2b3;background:#f9fafb}.fn-btn:disabled{opacity:.55;cursor:default}.fn-btn.primary{background:#067647;border-color:#067647;color:#fff}.fn-btn.primary:hover:not(:disabled){background:#05603a;border-color:#05603a}.fn-icon-btn{width:34px;padding:0}
      .fn-content{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px}.fn-content.fn-content-cash{overflow:hidden}.fn-tabs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.fn-tabs,.fn-segment{display:inline-flex;align-items:center;padding:3px;background:#eaecf0;border-radius:9px}.fn-tabs button,.fn-segment button{border:0;background:transparent;color:#667085;border-radius:7px;padding:8px 12px;font-weight:900;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap}.fn-tabs button.active,.fn-segment button.active{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.14)}.fn-range-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fn-date-nav{display:flex;align-items:center;background:#fff;border:1px solid #d0d5dd;border-radius:8px;overflow:hidden}.fn-date-nav button{width:34px;height:34px;border:0;background:#fff;color:#475467;cursor:pointer}.fn-date-nav button:hover{background:#f2f4f7}.fn-date-label{min-width:180px;text-align:center;padding:0 10px;font-size:11px;font-weight:900;color:#344054}
      .fn-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.fn-metrics.cash{grid-template-columns:repeat(5,minmax(0,1fr))}.fn-metric{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:13px;min-width:0;box-shadow:0 1px 2px rgba(16,24,40,.02)}.fn-metric-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#667085;font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.04em}.fn-metric-label i{color:#98a2b3}.fn-metric strong{display:block;margin-top:8px;font-size:23px;line-height:1;letter-spacing:-.035em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fn-metric small{display:block;margin-top:7px;color:#667085;font-size:10px;font-weight:750}.fn-positive{color:#067647!important}.fn-negative{color:#b42318!important}.fn-available{color:#175cd3!important}.fn-expected{color:#6941c6!important}
      .fn-card{background:#fff;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.02)}.fn-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid #eaecf0}.fn-card-head h2{margin:0;font-size:13px}.fn-card-head p{margin:3px 0 0;color:#667085;font-size:10px;font-weight:750}.fn-count{font-size:10px;font-weight:900;color:#667085;background:#f2f4f7;border-radius:999px;padding:5px 8px;white-space:nowrap}
      .fn-table-wrap{overflow:auto}.fn-table{width:100%;border-collapse:collapse;min-width:900px}.fn-table th,.fn-table td{padding:10px 12px;border-bottom:1px solid #f0f2f5;text-align:left;font-size:11px;vertical-align:middle}.fn-table th{background:#f9fafb;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}.fn-table tr:last-child td{border-bottom:0}.fn-table tbody tr[data-project-id]{cursor:pointer}.fn-table tbody tr[data-project-id]:hover{background:#f9fafb}.fn-right{text-align:right!important;white-space:nowrap}.fn-project{display:flex;align-items:center;gap:9px;min-width:190px}.fn-project-mark{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#ecfdf3;color:#067647;flex:0 0 auto}.fn-project strong,.fn-project small{display:block}.fn-project strong{font-size:11px}.fn-project small{margin-top:2px;color:#667085;font-size:9px;font-weight:750;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-schedule{display:flex;flex-direction:column;gap:3px;min-width:130px}.fn-schedule strong{font-size:10px}.fn-schedule span{font-size:9px;color:#667085;font-weight:750}.fn-status{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 7px;background:#ecfdf3;color:#067647;font-size:9px;font-weight:950;text-transform:capitalize}.fn-status.unscheduled{background:#fffaeb;color:#b54708}.fn-margin{display:flex;align-items:center;justify-content:flex-end;gap:7px}.fn-margin-bar{width:55px;height:6px;border-radius:999px;background:#eaecf0;overflow:hidden}.fn-margin-bar span{display:block;height:100%;border-radius:999px;background:#12b76a}
      .fn-history-grid{display:grid;grid-template-columns:repeat(6,minmax(130px,1fr));gap:8px;padding:12px;overflow:auto}.fn-cycle{border:1px solid #e4e7ec;border-radius:9px;padding:10px;min-width:130px;background:#fff}.fn-cycle.current{border-color:#a6f4c5;background:#f6fef9}.fn-cycle-label{font-size:10px;font-weight:950}.fn-cycle-profit{display:block;margin-top:9px;font-size:18px;letter-spacing:-.03em}.fn-cycle-row{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:9px;color:#667085;font-weight:800}.fn-cycle-bar{height:4px;background:#f2f4f7;border-radius:999px;overflow:hidden;margin-top:9px}.fn-cycle-bar span{display:block;height:100%;background:#12b76a;border-radius:999px}.fn-empty{padding:34px 18px;text-align:center;color:#667085}.fn-empty i{display:block;font-size:22px;margin-bottom:9px;color:#98a2b3}.fn-empty strong{display:block;color:#344054;font-size:13px}.fn-empty span{display:block;margin-top:5px;font-size:11px}
      .fn-page-actions{display:flex;justify-content:center;padding:12px;border-top:1px solid #eaecf0;background:#f9fafb}
      .fn-cash-workspace{position:relative;flex:1;display:grid;grid-template-columns:minmax(270px,320px) minmax(0,1fr);gap:12px;align-items:stretch;min-height:0}.fn-chart-card{min-width:0;min-height:0;display:flex;flex-direction:column}.fn-cash-chart-head{align-items:flex-start;flex:0 0 auto}.fn-chart-head-actions{display:flex;align-items:flex-end;justify-content:flex-end;gap:10px;flex-wrap:wrap}.fn-legend{display:flex;align-items:center;gap:12px;font-size:10px;font-weight:850;color:#667085}.fn-legend span{display:flex;align-items:center;gap:5px}.fn-legend i{width:18px;height:3px;border-radius:999px}.fn-cash-settings{display:flex;gap:7px;align-items:center}.fn-clearing{display:flex;align-items:center;gap:5px;font-size:9px;font-weight:850;color:#667085;white-space:nowrap}.fn-clearing input{width:64px;border:1px solid #d0d5dd;border-radius:7px;padding:5px 6px;font-weight:850;font-size:10px;color:#344054}.fn-chart-wrap{position:relative;flex:1;min-height:0;padding:10px 10px 2px}.fn-chart{display:block;width:100%;height:100%;min-height:0;overflow:visible}.fn-grid-line{stroke:#eaecf0;stroke-width:1}.fn-zero-line{stroke:#98a2b3;stroke-width:1.4;stroke-dasharray:5 5}.fn-axis-label{fill:#667085;font-size:10px;font-weight:750}.fn-line{fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.fn-line.available{stroke:#2e90fa}.fn-line.expected{stroke:#7f56d9;stroke-dasharray:7 5}.fn-line.safe{stroke:#12b76a}.fn-node{stroke:#fff;stroke-width:2;cursor:pointer;outline:none;transition:r .12s,stroke-width .12s}.fn-node.available{fill:#2e90fa}.fn-node.expected{fill:#7f56d9}.fn-node.safe{fill:#12b76a}.fn-node:hover,.fn-node:focus,.fn-node.is-highlighted{stroke:#101828;stroke-width:3;r:6}.fn-tooltip{position:fixed;z-index:2147483640;width:270px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden;box-sizing:border-box;pointer-events:none;background:#101828;color:#fff;border-radius:9px;padding:10px;box-shadow:0 12px 30px rgba(16,24,40,.25);font-size:10px;display:none}.fn-tooltip.show{display:block}.fn-tooltip>strong{display:block;font-size:11px}.fn-tooltip-total{display:flex;justify-content:space-between;gap:8px;margin-top:7px;color:#d0d5dd;font-weight:850}.fn-tooltip-exposure{margin-top:8px;padding:7px 0;border-top:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);display:grid;gap:5px}.fn-tooltip-exposure span{display:flex;align-items:center;gap:6px;color:#d0d5dd}.fn-tooltip-exposure span b{margin-left:auto;color:#fff}.fn-tooltip-exposure .warn,.fn-tooltip-exposure .warn b{color:#fec84b}.fn-tooltip-list{margin-top:7px;display:flex;flex-direction:column;gap:4px}.fn-tooltip-item{display:flex;justify-content:space-between;gap:8px}.fn-tooltip-item span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-chart-empty{height:100%;min-height:0;display:grid;place-items:center;color:#667085;font-size:11px;font-weight:800}
      .fn-transaction-rail{min-height:0;height:auto;display:flex;flex-direction:column}.fn-transaction-rail .fn-card-head{flex:0 0 auto;padding:11px 12px}.fn-transaction-list{flex:1;min-height:0;overflow:auto;scrollbar-width:thin}.fn-transaction{position:relative;width:100%;border:0;border-bottom:1px solid #f0f2f5;background:#fff;padding:8px 9px;display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;cursor:pointer;transition:background .12s,box-shadow .12s}.fn-transaction:hover,.fn-transaction:focus,.fn-transaction.is-highlighted{outline:0;background:#f5f8ff;box-shadow:inset 3px 0 #2e90fa}.fn-tx-icon{width:25px;height:25px;border-radius:7px;display:grid;place-items:center;font-size:9px}.fn-tx-icon.in{background:#ecfdf3;color:#067647}.fn-tx-icon.out{background:#fef3f2;color:#b42318}.fn-tx-main{min-width:0;display:block}.fn-tx-title,.fn-tx-meta,.fn-tx-state{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-tx-title{font-size:10px;font-weight:900;color:#344054}.fn-tx-meta{margin-top:2px;font-size:8px;font-weight:750;color:#667085}.fn-tx-state{width:max-content;max-width:100%;margin-top:3px;padding:2px 5px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.03em}.fn-tx-state.actual{background:#ecfdf3;color:#067647}.fn-tx-state.scheduled{background:#eff8ff;color:#175cd3}.fn-tx-state.estimated{background:#f9f5ff;color:#6941c6}.fn-tx-state.undated{background:#fffaeb;color:#b54708}.fn-tx-amount{font-size:10px;white-space:nowrap}.fn-empty.compact{padding:30px 12px}.fn-empty.compact i{font-size:18px}.fn-tx-popover{position:fixed;z-index:2147483300;display:none;width:270px;padding:10px;border-radius:9px;background:#101828;color:#fff;box-shadow:0 14px 34px rgba(16,24,40,.28);pointer-events:none;font-size:9px}.fn-tx-popover.show{display:block}.fn-tx-popover>strong,.fn-tx-popover>span{display:block}.fn-tx-popover>strong{font-size:11px}.fn-tx-popover>span{margin-top:3px;color:#98a2b3;font-weight:750}.fn-tx-popover-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14)}.fn-tx-popover-grid span{color:#98a2b3}.fn-tx-popover-grid b{display:block;margin-top:2px;color:#fff}
      .fn-link{border:0;background:transparent;padding:0;color:#175cd3;font-weight:850;font-size:11px;cursor:pointer;text-align:left}.fn-link:hover{text-decoration:underline}.fn-muted{color:#98a2b3;font-weight:750}
      .fn-metrics.payouts{grid-template-columns:repeat(6,minmax(0,1fr))}
      .fn-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 8px;font-size:9px;font-weight:950;text-transform:capitalize;background:#f2f4f7;color:#475467}
      .fn-badge.good{background:#ecfdf3;color:#067647}.fn-badge.info{background:#eff8ff;color:#175cd3}.fn-badge.warn{background:#fffaeb;color:#b54708}.fn-badge.bad{background:#fef3f2;color:#b42318}
      .fn-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .fn-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:6px 11px;font-weight:900;font-size:10px;line-height:1;cursor:pointer;white-space:nowrap}
      .fn-chip:hover{border-color:#98a2b3}.fn-chip.active{border-color:#101828;background:#101828;color:#fff}
      .fn-chip small{font-weight:800;opacity:.7;margin-left:4px}
      .fn-shade{position:fixed;inset:0;z-index:2147483200;background:rgba(16,24,40,.5);display:grid;place-items:center;padding:18px}
      .fn-modal{width:min(860px,96vw);max-height:92vh;overflow:auto;border-radius:15px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.4)}
      .fn-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:1px solid #eaecf0}
      .fn-modal-head strong{font-size:14px}.fn-modal-head .fn-modal-sub{display:block;margin-top:3px;color:#667085;font-size:10px;font-weight:750}
      .fn-modal-head button{width:32px;height:32px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#475467;cursor:pointer}
      .fn-modal-body{padding:16px 18px;display:grid;gap:13px}
      .fn-modal-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
      .fn-modal-stat{border:1px solid #eaecf0;border-radius:10px;padding:10px 12px}.fn-modal-stat span{display:block;color:#667085;font-size:9px;font-weight:950;text-transform:uppercase;letter-spacing:.04em}.fn-modal-stat strong{display:block;margin-top:5px;font-size:15px;letter-spacing:-.02em}
      .fn-modal .fn-table{min-width:640px}
      .fn-state{height:100%;display:grid;place-items:center;padding:30px}.fn-state-inner{text-align:center;color:#667085;max-width:420px}.fn-state-icon{width:44px;height:44px;margin:0 auto 12px;border-radius:12px;background:#ecfdf3;color:#067647;display:grid;place-items:center;font-size:18px}.fn-state h2{margin:0;color:#344054;font-size:16px}.fn-state p{margin:7px 0 13px;font-size:11px;line-height:1.5}.fn-spin{animation:fn-spin 1s linear infinite}@keyframes fn-spin{to{transform:rotate(360deg)}}
      /* GP-113: the header carries the period (like Scheduling's), the views and the filters. */
      .fn-shell [data-app-header="shared"]{position:relative}
      .fn-date-controls{display:inline-flex;align-items:center;gap:8px;flex-wrap:nowrap}
      .fn-seg{display:inline-flex;align-items:center;gap:2px;height:36px;box-sizing:border-box;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:12px;padding:3px}
      .fn-seg>button{height:28px;min-height:0!important;border:0;border-radius:9px!important;background:transparent;color:#475467;padding:0 10px!important;font:inherit;font-size:12px!important;font-weight:950!important;display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
      .fn-seg>button i{font-size:11px}.fn-seg>button:hover{background:#f2f4f7;color:#101828}
      .fn-seg>button.active{background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .fn-seg>button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
      .fn-filter-btn{position:relative;gap:7px}.fn-filter-btn.has-filters{color:var(--primary-readable,var(--primary,#d93025))!important;border-color:var(--primary,#d93025)!important}
      .fn-filter-btn b{min-width:17px;height:17px;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:10px;display:inline-grid;place-items:center;padding:0 4px}
      .fn-filter-panel{position:absolute;z-index:30;right:22px;top:calc(100% - 6px);width:min(340px,calc(100vw - 32px));box-sizing:border-box;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 18px 40px rgba(16,24,40,.16);padding:14px;display:grid;gap:11px}
      .fn-filter-panel[hidden]{display:none}
      .fn-filter-panel label{display:grid;gap:5px;font-size:11px;font-weight:850;color:#475467}
      .fn-filter-panel input,.fn-filter-panel select{font:inherit;font-size:12px;font-weight:650;color:#101828;border:1px solid #d0d5dd;border-radius:9px;padding:8px 10px;background:#fff;min-width:0}
      .fn-filter-panel-foot{display:flex;justify-content:space-between;gap:8px;align-items:center}
      .fn-active-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .fn-active-filters>span{font-size:11px;font-weight:850;color:#667085;margin-right:2px}
      .fn-filter-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#344054;padding:5px 6px 5px 10px;font:inherit;font-size:11px;font-weight:800;cursor:pointer}
      .fn-filter-chip i{font-size:10px;color:#98a2b3}.fn-filter-chip:hover{border-color:#98a2b3}.fn-filter-chip:hover i{color:#b42318}
      .fn-filter-clear{border:0;background:transparent;color:#175cd3;font:inherit;font-size:11px;font-weight:850;cursor:pointer;padding:4px}
      .fn-tip{display:inline-grid;place-items:center;width:16px;height:16px;margin-left:4px;color:#98a2b3;font-size:11px;vertical-align:-1px;cursor:help;border-radius:999px}
      .fn-tip:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
      .fn-metric[data-fm-tooltip]{cursor:help}.fn-metric:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
      button.fn-metric{font:inherit;text-align:left;cursor:pointer}button.fn-metric.active{border-color:var(--primary,#d93025);box-shadow:0 0 0 1px var(--primary,#d93025)}
      .fn-table td.fn-actions{text-align:right;white-space:nowrap;width:1%;padding-left:4px}.fn-table td.fn-actions .fn-btn{min-height:30px;padding:6px 9px}
      .fn-receipt{display:flex;align-items:center;gap:9px;min-width:180px}.fn-receipt-mark{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#f2f4f7;color:#475467;flex:0 0 auto;overflow:hidden}.fn-receipt-mark img{width:100%;height:100%;object-fit:cover}
      .fn-receipt strong,.fn-receipt small{display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-receipt strong{font-size:11px}.fn-receipt small{margin-top:2px;color:#667085;font-size:9px;font-weight:750}
      .fn-settings label{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #eaecf0;font-size:12px;font-weight:750;color:#344054}
      .fn-settings label small{display:block;margin-top:3px;font-size:11px;font-weight:600;color:#667085}
      .fn-settings input{width:130px;font:inherit;font-size:12px;font-weight:700;border:1px solid #d0d5dd;border-radius:9px;padding:8px 10px;text-align:right}
      .fn-settings h3{margin:4px 0 0;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#667085}
      .fn-settings-link{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid #eaecf0;border-radius:10px;font-size:12px;font-weight:700;color:#344054}
      .fn-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid #eaecf0}
      .fn-modal.fn-modal-small{width:min(520px,96vw)}
      .fn-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
      @media(max-width:800px){.fn-shell .app-header-tools{flex-wrap:wrap!important}.fn-date-controls{order:-1;width:100%}.fn-date-controls .fn-seg:last-child{margin-left:auto}.fn-filter-panel{right:14px}}
      @media(max-width:1200px){.fn-metrics.cash{grid-template-columns:repeat(3,minmax(0,1fr))}.fn-metrics.payouts{grid-template-columns:repeat(3,minmax(0,1fr))}.fn-cash-workspace{grid-template-columns:minmax(240px,280px) minmax(0,1fr)}}
      @media(max-width:900px){.fn-content.fn-content-cash{overflow:auto}.fn-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.fn-history-grid{grid-template-columns:repeat(3,minmax(150px,1fr))}.fn-cash-workspace{flex:none;grid-template-columns:1fr}.fn-transaction-rail{height:280px}.fn-chart-card{min-height:458px}.fn-chart-wrap{min-height:370px}.fn-chart,.fn-chart-empty{min-height:360px}.fn-chart-head-actions{justify-content:flex-start}.fn-cash-chart-head{flex-direction:column}}
      @media(max-width:720px){.fn-top{padding:12px 14px}.fn-heading p{display:none}.fn-btn span{display:none}.fn-content{padding:12px}.fn-tabs-toolbar,.fn-range-tools{align-items:stretch}.fn-range-tools{width:100%}.fn-date-nav{flex:1}.fn-date-label{min-width:0;flex:1}.fn-segment{margin-left:auto}.fn-metrics,.fn-metrics.cash,.fn-metrics.payouts{grid-template-columns:1fr 1fr}.fn-modal-stats{grid-template-columns:1fr 1fr}.fn-metric{padding:11px}.fn-metric strong{font-size:18px}.fn-card-head{align-items:flex-start}.fn-cash-settings{flex-wrap:wrap}.fn-history-grid{grid-template-columns:repeat(6,150px)}}
      /* GP-134: the phone layout. The portal's top bar names the app, so the header is only the shared tab strip;
         one row holds the period (or the receipt search) and the filters; figures sit in one row; lists are cards. */
      @media(max-width:800px){
        .fn-shell>[data-app-header="shared"]{padding:0!important;min-height:0;gap:0!important;background:var(--panel,#fff)}
        .fn-shell>[data-app-header="shared"] .app-heading,.fn-shell>[data-app-header="shared"]>.app-header-tools:empty{display:none}
        .fn-shell>[data-app-header="shared"]:not(:has(app-tab-strip)){display:none!important}
        .fn-shell>[data-app-header="shared"]>.app-header-strip{flex-basis:100%;margin:0}
        .fn-shell>[data-app-header="shared"] app-tab-strip{border-top:0}
        .fn-pbar{position:relative;flex:none;display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--panel,#fff);border-bottom:1px solid #e4e7ec}
        .fn-pbar>.fn-filter-btn,.fn-pbar>.fn-icon-btn{flex:none;width:40px;height:40px;min-height:0;padding:0;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#475467;display:inline-grid;place-items:center;font-size:14px}
        .fn-pbar>.fn-filter-btn b{position:absolute;top:-5px;right:-5px}
        .fn-pperiod{flex:1;min-width:0;display:flex;align-items:center;height:40px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;background:#fff;overflow:hidden}
        .fn-pperiod>button{flex:none;height:100%;min-width:38px;border:0;background:transparent;color:#475467;font:inherit;font-size:13px;cursor:pointer}
        .fn-pperiod>button:active{background:#f2f4f7}
        .fn-pperiod-label{flex:1;min-width:0;text-align:center;font-size:13px;font-weight:800;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .fn-pperiod>.fn-ptoday{min-width:0;height:28px;margin:0 2px;padding:0 9px;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:900}
        .fn-pgrain{flex:none;height:40px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:800;padding:0 8px}
        .fn-psearch{position:relative;flex:1;min-width:0;display:flex;align-items:center;gap:9px;height:40px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:999px;background:#f9fafb;color:#667085;padding:0 14px;font:inherit;font-size:13px;font-weight:650;text-align:left;cursor:pointer}
        .fn-psearch>span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .fn-psearch>b{min-width:18px;height:18px;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font-size:10px;display:inline-grid;place-items:center;padding:0 5px}
        .fn-pbar .fn-filter-panel{left:12px;right:12px;top:calc(100% + 4px);width:auto}
        .fn-filter-panel input,.fn-filter-panel select{min-height:42px;font-size:14px}
        .fn-content,.fn-content.fn-content-cash{overflow:auto;padding:12px 12px calc(24px + env(safe-area-inset-bottom));gap:12px}
        .fn-content>*{flex-shrink:0}
        .fn-active-filters{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.fn-active-filters>*{flex:none}
        .fn-metrics,.fn-metrics.cash{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);grid-template-columns:none;gap:6px}
        .fn-metric{padding:9px 8px 10px;border-radius:10px}
        .fn-metric-label{display:block;min-height:2.3em;font-size:9.5px;letter-spacing:.02em;line-height:1.15}
        .fn-metric strong{margin-top:5px;font-size:15px;letter-spacing:-.02em}
        .fn-metric small{margin-top:3px;font-size:10px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .fn-card-head{padding:12px 14px}.fn-card-head h2{font-size:14px}
        .fn-plist{display:flex;flex-direction:column}
        .fn-prow{display:block;padding:12px 14px;border-bottom:1px solid #f0f2f5;background:#fff;cursor:pointer;-webkit-tap-highlight-color:transparent}
        .fn-prow:last-child{border-bottom:0}.fn-prow:active{background:#f9fafb}
        .fn-prow:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:-2px}
        .fn-prow-top{display:flex;align-items:flex-start;gap:12px}
        .fn-prow-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
        .fn-prow-name>strong,.fn-prow-name>.fn-link{font-size:13.5px;font-weight:800;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .fn-prow-name>.fn-link{color:#175cd3}
        .fn-prow-name>small{font-size:11.5px;font-weight:650;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .fn-prow-when{display:inline-flex;align-items:center;gap:5px;margin-top:3px;font-size:11px;font-weight:800;color:#067647}.fn-prow-when.unscheduled{color:#b54708}
        .fn-prow-figure{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px;text-align:right}
        .fn-prow-figure>strong{font-size:16px;letter-spacing:-.02em}.fn-prow-figure>small{font-size:11px;font-weight:750;color:#667085}
        .fn-prow-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0 0;padding:9px 0 0;border-top:1px dashed #eaecf0}
        .fn-prow-facts>div{min-width:0}.fn-prow-facts dt{font-size:9.5px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fn-prow-facts dd{margin:2px 0 0;font-size:13px;font-weight:800}
        .fn-pcycles{display:flex;flex-direction:column;padding:4px 0}
        .fn-pcycle{display:grid;grid-template-columns:62px minmax(0,1fr) auto;align-items:center;gap:2px 10px;padding:9px 14px}
        .fn-pcycle.current{background:#f6fef9}
        .fn-pcycle-label{grid-row:span 2;font-size:12px;font-weight:850;color:#344054}.fn-pcycle-label small{display:block;margin-top:1px;font-size:9.5px;font-weight:800;color:#067647}
        .fn-pcycle-bar{height:6px;border-radius:999px;background:#f2f4f7;overflow:hidden}.fn-pcycle-bar>span{display:block;height:100%;border-radius:999px}
        .fn-pcycle>strong{font-size:14px;text-align:right}
        .fn-pcycle-sub{grid-column:2/4;font-size:10.5px;font-weight:700;color:#667085}
        .fn-ppay{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:8px 10px;cursor:default}
        .fn-ppay>.fn-tx-icon{width:30px;height:30px;border-radius:9px;font-size:11px}
        .fn-ppay-amount{justify-self:end;font-size:14px;white-space:nowrap}
        .fn-ppay-state{grid-column:2;font-size:11px;font-weight:750;color:#667085}
        .fn-ppay>.fn-btn{grid-column:3;min-height:36px;font-size:12px}
        .fn-preceipt{display:flex;align-items:center;gap:12px}
        .fn-preceipt>.fn-receipt-mark{width:42px;height:42px;border-radius:10px}
        .fn-cash-workspace{display:flex;flex-direction:column;gap:12px}
        .fn-cash-workspace>.fn-chart-card{order:-1;min-height:0}
        .fn-cash-chart-head{flex-direction:column;align-items:stretch;gap:8px}.fn-chart-head-actions{justify-content:flex-start}.fn-legend{flex-wrap:wrap;gap:6px 12px}
        .fn-chart-wrap{min-height:0;padding:6px 4px 2px}.fn-chart{height:auto;min-height:0;aspect-ratio:400/240}.fn-chart-empty{min-height:160px}
        .fn-axis-label{font-size:10px}
        .fn-transaction-rail{height:auto}.fn-transaction-list{overflow:visible}
        .fn-transaction{grid-template-columns:30px minmax(0,1fr) auto;gap:10px;padding:11px 14px}
        .fn-tx-icon{width:30px;height:30px;font-size:11px}.fn-tx-title{font-size:13px}.fn-tx-meta{font-size:11px}.fn-tx-state{font-size:9px;padding:2px 6px}.fn-tx-amount{font-size:13px}
        .fn-tx-popover{display:none!important}
        .fn-tooltip{width:240px}
        .fn-empty{padding:26px 16px}
        .fn-state{padding:24px 16px}
        .fn-shade{place-items:end stretch;padding:0}
        .fn-modal,.fn-modal.fn-modal-small{width:100%;max-height:90vh;border-radius:16px 16px 0 0;padding-bottom:env(safe-area-inset-bottom)}
        .fn-settings label{flex-direction:column;align-items:stretch;gap:8px}.fn-settings input{width:100%;box-sizing:border-box;min-height:42px;font-size:14px;text-align:left}
        .fn-modal-foot .fn-btn{flex:1;min-height:42px;font-size:13px}
      }
    `;
    document.head.appendChild(style);
  }

  function projectLifecycle(project){
    const projection = object(project.work_projection);
    return Object.keys(object(projection.lifecycle)).length ? object(projection.lifecycle) : object(project.lifecycle);
  }

  function isActiveProject(project){
    const status = clean(projectLifecycle(project).status).toLowerCase();
    return !['completed', 'canceled', 'cancelled', 'lost'].includes(status);
  }

  function eventStart(event){ return date(event.start_at || event.start || event.starts_at || event.start_date); }
  function eventEnd(event){ return date(event.end_at || event.end || event.ends_at || event.end_date) || eventStart(event); }
  function eventKind(event){ return clean(event.schedule_item_kind || event.kind || event.type || event.event_type_default_id).toLowerCase(); }
  function isMaterialEvent(event){ return /material|deliver/.test(eventKind(event)) || /material|deliver/i.test(clean(event.title)); }
  function isWorkEvent(event){ return !isMaterialEvent(event) && !/sales|appointment|inspection|estimate/.test(eventKind(event)); }

  function projectWindow(project){
    const scheduled = array(project.events).filter((event) => !/cancel|void/i.test(clean(event.status)));
    const work = scheduled.filter(isWorkEvent);
    const relevant = work.length ? work : scheduled.filter((event) => !isMaterialEvent(event));
    const starts = relevant.map(eventStart).filter(Boolean).sort((a, b) => a - b);
    const ends = relevant.map(eventEnd).filter(Boolean).sort((a, b) => a - b);
    const start = starts[0] || date(project.start_at || project.start_date || project.scheduled_start_at || project.created_at);
    const end = ends.at(-1) || date(project.end_at || project.end_date || project.scheduled_end_at || project.completed_at) || start;
    return { start, end, deliveries:scheduled.filter(isMaterialEvent).map(eventStart).filter(Boolean).sort((a, b) => a - b) };
  }

  function dueDate(obligation, window){
    const direct = date(obligation.due_at || obligation.due_date || obligation.scheduled_at || obligation.expected_at);
    if (direct) return direct;
    const label = clean(obligation.label || obligation.title || obligation.kind);
    if (/deposit|initial|start/i.test(label)) return window.start;
    return window.end || window.start;
  }

  function paymentInitiatedDate(payment){
    return date(payment.received_at || payment.processed_at || payment.authorized_at || payment.created_at);
  }

  function paymentClearedDate(payment, clearingHours = 0){
    const explicit = date(payment.cleared_at || payment.available_at || payment.settled_at || payment.paid_at);
    if (explicit) return { at:explicit, confidence:'actual' };
    const initiated = paymentInitiatedDate(payment);
    if (!initiated) return { at:null, confidence:'undated' };
    const inbound = clean(payment.direction).toLowerCase() !== 'outbound';
    return {
      at:new Date(initiated.getTime() + (inbound ? Math.max(0, clearingHours) * 3_600_000 : 0)),
      confidence:clean(payment.status).toLowerCase() === 'settled' ? 'actual' : 'estimated'
    };
  }

  function titleForProject(project){
    return clean(project.title || project.project_title || project.project_name || project.address || project.customer_name) || 'Untitled project';
  }

  function logSourceSkip(source, error, detail = {}){
    console.warn('[Financials] Optional source skipped', {
      source,
      ...detail,
      error:error?.message || clean(error) || 'Unknown source error'
    });
  }

  function transactionId(...parts){
    return `cash-${parts.map((part) => clean(part).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).filter(Boolean).join('-') || Math.random().toString(36).slice(2)}`;
  }

  function cashTransaction(input = {}){
    const amount = number(input.amount);
    const clearedAt = date(input.clearedAt);
    const expectedClearAt = clearedAt || date(input.expectedClearAt);
    const knownAt = date(input.knownAt || input.initiatedAt || input.accruedAt);
    return {
      id:clean(input.id) || transactionId(input.kind, input.projectId, input.label, amount, dateKey(expectedClearAt || knownAt)),
      amount,
      direction:amount >= 0 ? 'in' : 'out',
      kind:clean(input.kind || 'other'),
      label:clean(input.label || 'Financial movement'),
      projectId:clean(input.projectId),
      projectTitle:clean(input.projectTitle),
      knownAt,
      accruedAt:date(input.accruedAt),
      initiatedAt:date(input.initiatedAt),
      expectedClearAt,
      clearedAt,
      confidence:clean(input.confidence || (clearedAt ? 'actual' : (expectedClearAt ? 'scheduled' : 'undated'))),
      source:clean(input.source),
      metadata:object(input.metadata)
    };
  }

  function projectTransactions(row, clearingHours){
    const { project, summary, window } = row;
    const projectId = clean(project.id);
    const projectTitle = titleForProject(project);
    const transactions = [];
    const add = (input) => {
      const transaction = cashTransaction({ projectId, projectTitle, ...input });
      if (transaction.amount) transactions.push(transaction);
    };

    array(summary.obligations).filter((item) => clean(item.status) !== 'void').forEach((item, index) => {
      const remaining = Math.max(0, number(item.amount_cents) - number(item.allocated_cents));
      if (!remaining) return;
      const due = dueDate(item, window);
      add({
        id:transactionId('obligation', projectId, item.id || index), amount:remaining, kind:'customer',
        label:clean(item.label || item.title || (globalThis.PlatformLanguage?.text("financials","m_46943c90c95da3","Customer payment") ?? "Customer payment")), knownAt:item.created_at || project.created_at || due,
        accruedAt:due, expectedClearAt:due ? new Date(due.getTime() + Math.max(0, clearingHours) * 3_600_000) : null,
        confidence:date(item.due_at || item.due_date || item.scheduled_at || item.expected_at) ? 'scheduled' : (due ? 'estimated' : 'undated'),
        source:'payment_obligation'
      });
    });

    array(summary.payments).forEach((item, index) => {
      const outbound = clean(item.direction).toLowerCase() === 'outbound';
      const status = clean(item.status).toLowerCase();
      if (!['settled','paid','partially_refunded','refunded','completed'].includes(status)) return;
      const initiated = paymentInitiatedDate(item);
      const cleared = paymentClearedDate(item, clearingHours);
      add({
        id:transactionId('payment', projectId, item.id || index),
        amount:outbound ? -Math.abs(number(item.amount_cents)) : Math.abs(number(item.amount_cents)),
        kind:outbound ? 'expense' : 'customer', label:clean(item.label || item.description || item.kind || (outbound ? 'Payment out' : 'Customer payment')),
        knownAt:initiated || cleared.at, initiatedAt:initiated, clearedAt:cleared.confidence === 'actual' ? cleared.at : null,
        expectedClearAt:cleared.at, confidence:cleared.confidence, source:'payment'
      });
    });

    const materialProjected = Math.max(0, number(summary.materials?.projected_cents) - number(summary.materials?.paid_cents));
    if (materialProjected > 0) {
      const deliveries = window.deliveries.length ? window.deliveries : [window.start].filter(Boolean);
      if (!deliveries.length) {
        add({ id:transactionId('materials', projectId, 'undated'), amount:-materialProjected, kind:'material', label:(globalThis.PlatformLanguage?.text("financials","m_1e8696cb1255fe","Materials commitment") ?? "Materials commitment"), knownAt:project.created_at, confidence:'undated', source:'material_projection' });
      } else {
        const base = Math.floor(materialProjected / deliveries.length);
        deliveries.forEach((delivery, index) => add({
          id:transactionId('materials', projectId, index), amount:-(index === deliveries.length - 1 ? materialProjected - base * index : base),
          kind:'material', label:(globalThis.PlatformLanguage?.text("financials","m_d42d32b7e5e874","Material payment") ?? "Material payment"), knownAt:project.created_at || window.start || delivery, accruedAt:delivery,
          expectedClearAt:delivery, confidence:window.deliveries.length ? 'scheduled' : 'estimated', source:'material_projection'
        }));
      }
    }
    const materialPaid = number(summary.materials?.paid_cents);
    const hasMaterialPayment = array(summary.payments).some((item) => /material/.test(clean(item.kind || item.label || item.description).toLowerCase()));
    if (materialPaid && !hasMaterialPayment) {
      const paidAt = window.deliveries[0] || window.start;
      add({ id:transactionId('materials-paid', projectId), amount:-materialPaid, kind:'material', label:(globalThis.PlatformLanguage?.text("financials","m_75d9cdb5b1b8df","Material payment cleared") ?? "Material payment cleared"), knownAt:project.created_at || paidAt, clearedAt:paidAt, confidence:paidAt ? 'estimated' : 'undated', source:'material_paid_total' });
    }

    array(summary.payables).forEach((item, index) => {
      const kind = clean(item.kind).toLowerCase();
      if (/material/.test(kind)) return;
      const remaining = Math.max(0, number(item.amount_cents) - number(item.paid_cents));
      if (!remaining) return;
      const due = date(item.due_at);
      add({
        id:transactionId('payable', projectId, item.id || index), amount:-remaining,
        kind:/crew|labor|payroll|commission/.test(kind) ? 'payroll' : 'expense',
        label:clean(item.notes || item.payee_ref?.name || item.vendor_ref?.name || item.kind || 'Project expense'),
        knownAt:item.created_at || project.created_at || window.start, accruedAt:item.created_at || window.start,
        expectedClearAt:due, confidence:due ? 'scheduled' : 'undated', source:'payable', metadata:{ payableKind:kind }
      });
    });
    return transactions;
  }

  function payrollTransactions(data){
    const transactions = [];
    const coveredScheduleIds = new Set();
    array(data?.payroll?.history).filter((batch) => clean(batch.status) !== 'void').forEach((batch, index) => {
      coveredScheduleIds.add(clean(batch.schedule_id));
      const clearedAt = date(batch.paid_at || batch.pay_date);
      transactions.push(cashTransaction({
        id:transactionId('payroll-history', batch.id || index), amount:-Math.abs(number(batch.total_cents)), kind:'payroll',
        label:((v0) => globalThis.PlatformLanguage?.text("financials","m_6acae344e57858",`${v0} paid`,{v0}) ?? `${v0} paid`)(clean(batch.schedule?.name) || 'Payroll'), knownAt:batch.created_at || batch.period_start || clearedAt,
        accruedAt:batch.period_end, initiatedAt:batch.run_at, clearedAt, confidence:batch.paid_at ? 'actual' : 'estimated', source:'payroll_batch'
      }));
    });
    array(data?.payroll?.upcoming).forEach((occurrence, index) => {
      const batch = object(occurrence.batch);
      if (clean(batch.id) && array(data?.payroll?.history).some((item) => clean(item.id) === clean(batch.id))) return;
      const amount = clean(batch.id) ? number(batch.total_cents) : number(occurrence.accrued_total_cents) + number(occurrence.projected_additional_cents);
      if (!amount) return;
      coveredScheduleIds.add(clean(occurrence.schedule_id || occurrence.schedule?.id));
      transactions.push(cashTransaction({
        id:transactionId('payroll-upcoming', occurrence.schedule_id || occurrence.schedule?.id, occurrence.pay_date || index),
        amount:-Math.abs(amount), kind:'payroll', label:((v0) => globalThis.PlatformLanguage?.text("financials","m_fb088710bc740f",`${v0} expected`,{v0}) ?? `${v0} expected`)(clean(occurrence.schedule?.name) || 'Payroll'),
        knownAt:occurrence.period_start || occurrence.cutoff_at, accruedAt:occurrence.cutoff_at || occurrence.period_end,
        expectedClearAt:occurrence.pay_date, confidence:'scheduled', source:'payroll_forecast'
      }));
    });
    array(data?.ledger?.entries).filter((entry) => clean(entry.state) !== 'void').forEach((entry, index) => {
      const scheduleId = clean(entry.schedule_id);
      if (scheduleId && coveredScheduleIds.has(scheduleId)) return;
      transactions.push(cashTransaction({
        id:transactionId('payroll-undated', entry.id || index), amount:-number(entry.remaining_cents ?? entry.amount_cents), kind:'payroll',
        label:clean(entry.description || entry.kind || 'Labor accrued'), projectId:entry.project_id, projectTitle:entry.project_title,
        knownAt:entry.eligible_at || entry.created_at, accruedAt:entry.eligible_at || entry.completed_at || entry.worked_at,
        confidence:'undated', source:'payroll_ledger'
      }));
    });
    return transactions.filter((item) => item.amount);
  }

  function removeDuplicatedPayables(transactions, payroll){
    const hasForwardPayroll = payroll.some((item) => item.source === 'payroll_forecast' || item.source === 'payroll_ledger');
    const payrollProjects = new Set(payroll.filter((item) => item.projectId).map((item) => item.projectId));
    if (!hasForwardPayroll && !payrollProjects.size) return transactions;
    return transactions.filter((item) => {
      if (item.source !== 'payable' || item.kind !== 'payroll') return true;
      return !hasForwardPayroll && !payrollProjects.has(item.projectId);
    });
  }

  function actualCashEvents(transactions){
    return transactions.filter((item) => item.clearedAt).map((item) => ({
      ...item, at:item.clearedAt, day:dateKey(item.clearedAt), line:'actual'
    }));
  }

  function sumEvents(events){ return events.reduce((sum, item) => sum + number(item.amount), 0); }

  function projectPoint(row, transactions, range){
    const actual = actualCashEvents(transactions).filter((event) => event.at < range.end && event.projectId === clean(row.project.id));
    const actualRevenue = sumEvents(actual.filter((item) => item.amount > 0));
    const actualOut = Math.abs(sumEvents(actual.filter((item) => item.amount < 0)));
    const due = array(row.summary.obligations).filter((item) => {
      const when = dueDate(item, row.window);
      return when && when < range.end && clean(item.status) !== 'void';
    }).reduce((sum, item) => sum + Math.max(0, number(item.amount_cents)), 0);
    return {
      revenue:actualRevenue,
      expenses:actualOut,
      profit:actualRevenue - actualOut,
      owed:Math.max(0, due - actualRevenue)
    };
  }

  function buckets(grain, anchor, count = 6){
    const result = [];
    let cursor = shiftAnchor(grain, anchor, -(count - 1));
    for (let index = 0; index < count; index++) {
      const range = rangeFor(grain, cursor);
      result.push({ ...range, current:index === count - 1, label:grain === 'month' ? range.start.toLocaleDateString(undefined, { month:'short', year:'2-digit' }) : grain === 'week' ? `${dateLabel(range.start, { year:false })}` : range.start.toLocaleDateString(undefined, { month:'short', day:'numeric' }) });
      cursor = shiftAnchor(grain, cursor, 1);
    }
    return result;
  }

  function dailyCashSeries(transactions, range, openingBalance = 0){
    const days = [];
    for (let cursor = new Date(range.start); cursor < range.end; cursor = addDays(cursor, 1)) {
      const key = dateKey(cursor);
      const end = addDays(cursor, 1);
      const availableEvents = transactions.filter((item) => item.clearedAt && item.clearedAt >= cursor && item.clearedAt < end);
      const expectedEvents = transactions.filter((item) => {
        const at = item.clearedAt || item.expectedClearAt;
        return at && at >= cursor && at < end;
      });
      const commitmentEvents = transactions.filter((item) => item.amount < 0 && item.knownAt && item.knownAt >= cursor && item.knownAt < end);
      const pendingIncoming = transactions.filter((item) => item.amount > 0 && item.initiatedAt && item.initiatedAt < end && (!item.clearedAt || item.clearedAt >= end));
      const datedExposureTransactions = transactions.filter((item) => {
        const clearAt = item.clearedAt || item.expectedClearAt;
        const known = !item.knownAt || item.knownAt < end;
        return item.amount < 0 && known && clearAt && clearAt >= end;
      });
      const undatedExposureTransactions = transactions.filter((item) => item.amount < 0 && (!item.knownAt || item.knownAt < end) && !item.clearedAt && !item.expectedClearAt);
      days.push({
        date:new Date(cursor), key, availableEvents, expectedEvents, commitmentEvents, pendingIncoming,
        datedExposureTransactions, undatedExposureTransactions,
        availableDelta:sumEvents(availableEvents), expectedDelta:sumEvents(expectedEvents),
        pendingIncomingCents:sumEvents(pendingIncoming),
        datedExposureCents:Math.abs(sumEvents(datedExposureTransactions)),
        undatedExposureCents:Math.abs(sumEvents(undatedExposureTransactions))
      });
    }
    let available = number(openingBalance);
    let expected = number(openingBalance);
    let previousSafe = null;
    return days.map((item) => {
      available += item.availableDelta;
      expected += item.expectedDelta;
      const safe = expected - item.datedExposureCents - item.undatedExposureCents;
      const safeDelta = previousSafe == null ? safe - number(openingBalance) : safe - previousSafe;
      previousSafe = safe;
      const safeExposureTransactions = [...item.datedExposureTransactions, ...item.undatedExposureTransactions];
      return { ...item, available, expected, safe, safeDelta, safeExposureTransactions };
    });
  }

  async function concurrentMap(values, limit, mapper){
    const results = new Array(values.length);
    let next = 0;
    async function worker(){
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index], index);
      }
    }
    await Promise.all(Array.from({ length:Math.min(limit, values.length) }, worker));
    return results;
  }

  function apiTransaction(item){
    return cashTransaction({
      id:item.id, amount:item.amount, kind:item.kind, label:item.label,
      projectId:item.project_id, projectTitle:item.project_title,
      knownAt:item.known_at, accruedAt:item.accrued_at, initiatedAt:item.initiated_at,
      expectedClearAt:item.expected_clear_at, clearedAt:item.cleared_at,
      confidence:item.confidence, source:item.source, metadata:item.metadata
    });
  }

  function apiSeriesItem(item){
    const availableEvents = array(item.available_events).map(apiTransaction);
    const expectedEvents = array(item.expected_events).map(apiTransaction);
    const exposureIds = array(item.exposure_transaction_ids);
    return {
      date:date(item.date), key:clean(item.date),
      available:number(item.available_cents), expected:number(item.expected_cents), safe:number(item.safe_cents),
      availableDelta:number(item.available_delta_cents), expectedDelta:number(item.expected_delta_cents), safeDelta:number(item.safe_delta_cents),
      pendingIncomingCents:number(item.pending_incoming_cents), datedExposureCents:number(item.dated_exposure_cents), undatedExposureCents:number(item.undated_exposure_cents),
      availableEvents, expectedEvents, commitmentEvents:[],
      safeExposureTransactions:exposureIds.map((id) => ({ id:clean(id) }))
    };
  }

  function createApp(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    injectCss();

    const route = window.Portal?.navigation?.read?.() || {};
    const state = {
      root,
      orgId:clean(context.orgId || context.currentUser?.organization_id || window.__APP?.userOrgId || window.__APP?.orgId),
      branchId:clean(context.branchId || window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.branchId || 'default') || 'default',
      view:normalizeView(context.params?.standalone || window.AppChrome.resolve('financials',legacyView(route.financialView),context)),
      grain:['day','week','month'].includes(clean(route.financialGrain)) ? clean(route.financialGrain) : 'month',
      anchor:/^\d{4}-\d{2}-\d{2}$/.test(clean(route.financialDate)) ? dayStart(route.financialDate) : dayStart(new Date()),
      clearingHours:48,
      openingBalance:0,
      filters:{},
      filtersOpen:false,
      settingsOpen:false,
      widget:null,
      data:null,
      loading:true,
      error:null,
      destroyed:false,
      loadToken:0,
      loadedAt:0,
      active:false
    };
    try {
      // Nothing stored is not 0 (Number(null) is): the 48-hour default stays until someone sets another.
      const storedText = window.localStorage?.getItem?.('fm:financial:clearing-hours');
      const stored = storedText == null || storedText === '' ? NaN : Number(storedText);
      if (Number.isFinite(stored) && stored >= 0 && stored <= 336) state.clearingHours = stored;
      const storedBalance = Number(window.localStorage?.getItem?.('fm:financial:opening-balance-cents'));
      if (Number.isFinite(storedBalance)) state.openingBalance = Math.round(storedBalance);
      const storedFilters = JSON.parse(window.localStorage?.getItem?.(FILTER_KEY) || '{}');
      Object.keys(FILTER_FIELDS).forEach((name) => { if (typeof storedFilters?.[name] === 'string') state.filters[name] = storedFilters[name]; });
    } catch (_) {}

    // Capability gate for the Payouts view — merchant processing is off until
    // the org completes boarding, so the tab hides itself (same helper shape
    // as documents/studio.js capabilityEnabled).
    function capabilityEnabled(key){
      const caps = context.capabilities?.current?.() || window.Portal?.capabilities?.current?.() || null;
      if (caps?.effective_by_key && Object.prototype.hasOwnProperty.call(caps.effective_by_key, key)) return caps.effective_by_key[key] === true;
      return false;
    }
    function merchantProcessingEnabled(){ return capabilityEnabled('money.merchant_processing'); }

    function normalizeView(value){
      if(value==='')return '';
      const view = normalizeFinancialView(value);
      return view === 'disputes' && !merchantProcessingEnabled() ? 'projects' : view;
    }

    function range(){ return rangeFor(state.grain, state.anchor); }
    function modelTransactions(){
      return array(state.data?.transactions);
    }

    function routePatch(patch, history = 'replace'){
      if (context.params?.standalone || window.Portal?.navigation?.applying) return;
      const method = history === 'push' ? 'push' : 'replace';
      window.Portal?.navigation?.[method]?.({ tab:'financials', ...patch }, {
        source:'financials',
        ownedKeys:['financialView','financialGrain','financialDate']
      });
    }

    function renderState(){
      const message = state.error?.message || clean(state.error) || 'Financial data is unavailable.';
      root.innerHTML = `<div class="fn-shell">${state.view ? headerHtml() : ''}<div class="fn-state"><div class="fn-state-inner"><div class="fn-state-icon"><i class="fas ${state.loading ? 'fa-circle-notch fn-spin' : 'fa-triangle-exclamation'}"></i></div><h2>${state.loading ? (DATED_VIEWS.includes(state.view) ? 'Building your financial forecast' : `Loading ${viewTitle(state.view).toLowerCase()}`) : 'Financials could not load'}</h2><p>${state.loading ? (DATED_VIEWS.includes(state.view) ? 'Combining project schedules, payments, materials, payroll, and commissions.' : '') : esc(message)}</p>${state.loading ? '' : `<button class="fn-btn primary" data-fn-action="refresh"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button>`}</div></div>${state.view ? '</div>' : ''}</div>`;
    }

    function viewTitle(view){
      return ({ projects:'Profitability', cashflow:'Cash flow', payouts:'Payouts', receipts:'Receipts', disputes:'Disputes' })[view] || 'Financials';
    }

    // GP-113: one tooltip affordance for every explanation that used to be a subtitle.
    function tipHtml(text){
      const tip = clean(text);
      return tip ? `<span class="fn-tip" tabindex="0" role="img" aria-label="${esc(tip)}" data-fm-tooltip="${esc(tip)}"><i class="fas fa-circle-info" aria-hidden="true"></i></span>` : '';
    }

    // On a phone a tile shows its short label and figure (`phone`, `phoneNote`); the tooltip keeps the full words.
    function metricHtml({ label, icon, value, tone = '', tooltip:tip = '', filter = '', short = '', phone = '', phoneNote = '' }){
      const attrs = `${tip ? ` data-fm-tooltip="${esc(tip)}" aria-label="${esc(`${label}: ${value}. ${tip}`)}"` : ''}`;
      const body = isPhone()
        ? `<span class="fn-metric-label">${esc(short || label)}</span><strong class="${esc(tone)}">${esc(phone || value)}</strong>${phoneNote ? `<small>${esc(phoneNote)}</small>` : ''}`
        : `<span class="fn-metric-label">${esc(label)}<i class="fas ${esc(icon)}"></i></span><strong class="${esc(tone)}">${esc(value)}</strong>`;
      if (filter) return `<button type="button" class="fn-metric${state.filters.review === filter ? ' active' : ''}" data-fn-review-filter="${esc(filter)}" aria-pressed="${state.filters.review === filter}"${attrs}>${body}</button>`;
      return `<div class="fn-metric" tabindex="0"${attrs}>${body}</div>`;
    }

    // Today ◀ ▶ and Day / Week / Month, as Scheduling shows them, left of the views (GP-113).
    function dateControlsHtml(){
      if (!DATED_VIEWS.includes(state.view)) return '';
      return `<div class="fn-date-controls"><span class="fn-seg" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_28f3688fd7ff27","Period") ?? "Period")}">
          <button type="button" data-fn-action="previous" aria-label="${((v0) => globalThis.PlatformLanguage?.text("financials","m_b0ae4f18f932d9",`Previous ${v0}`,{v0}) ?? `Previous ${v0}`)(esc(state.grain))}" data-fm-tooltip="Previous ${esc(state.grain)}"><i class="fas fa-chevron-left"></i></button>
          <button type="button" data-fn-action="today">${(globalThis.PlatformLanguage?.htmlText("financials","m_23929ba4ba84dd","Today") ?? "Today")}</button>
          <button type="button" data-fn-action="next" aria-label="${((v2) => globalThis.PlatformLanguage?.text("financials","m_b68752fb081712",`Next ${v2}`,{v2}) ?? `Next ${v2}`)(esc(state.grain))}" data-fm-tooltip="Next ${esc(state.grain)}"><i class="fas fa-chevron-right"></i></button>
        </span><span class="fn-seg" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_179cb3b2ebc4a4","Financial period") ?? "Financial period")}">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([grain, label]) => `<button type="button" data-fn-grain="${grain}" class="${state.grain === grain ? 'active' : ''}" aria-pressed="${state.grain === grain}">${esc(label)}</button>`).join('')}</span></div>`;
    }

    function viewFilters(){ return VIEW_FILTERS[state.view] || []; }

    function filterOptions(name){
      if (name === 'uploader') {
        const people = new Map();
        array(state.data?.receipts).forEach((receipt) => {
          const id = clean(receipt.uploaded_by?.user_id);
          if (id) people.set(id, clean(receipt.uploaded_by?.name) || 'Unknown');
        });
        if (state.filters.uploader && !people.has(state.filters.uploader)) people.set(state.filters.uploader, 'Someone else');
        return [...FILTER_FIELDS.uploader.options, ...[...people].sort((a, b) => a[1].localeCompare(b[1]))];
      }
      return (state.view === 'cashflow' && FILTER_FIELDS[name].cashflow) || FILTER_FIELDS[name].options || [];
    }

    function activeFilters(){
      return viewFilters().filter((name) => clean(state.filters[name])).map((name) => {
        const value = clean(state.filters[name]);
        const label = FILTER_FIELDS[name].kind === 'search' ? `“${value}”` : (filterOptions(name).find(([id]) => id === value)?.[1] || value);
        return { name, label:`${FILTER_FIELDS[name].label}: ${label}` };
      });
    }

    function filterButtonHtml(){
      if (!viewFilters().length) return '';
      const count = activeFilters().length;
      return `<button type="button" class="fn-filter-btn${count ? ' has-filters' : ''}" data-fn-filters-toggle aria-expanded="${state.filtersOpen}" aria-controls="fnFilterPanel" aria-label="${((v2) => globalThis.PlatformLanguage?.text("financials","m_59335f52f97281",`Filters${v2}`,{v2}) ?? `Filters${v2}`)(count ? ` (${count} on)` : '')}" data-fm-tooltip="Filters"><i class="fas fa-filter" aria-hidden="true"></i>${count ? `<b>${count}</b>` : ''}</button>`;
    }

    function filterPanelHtml(){
      if (!viewFilters().length) return '';
      return `<form class="fn-filter-panel" id="fnFilterPanel" data-fn-filter-panel ${state.filtersOpen ? '' : 'hidden'}>${viewFilters().map((name) => {
        const field = FILTER_FIELDS[name];
        if (field.kind === 'search') return `<label>${esc(field.label)}<input type="search" name="${name}" value="${esc(state.filters[name])}" placeholder="${esc(state.view === 'receipts' ? 'Receipt, project or address' : 'Project, customer or address')}" autocomplete="off"></label>`;
        return `<label>${esc(field.label)}<select name="${name}">${filterOptions(name).map(([value, label]) => `<option value="${esc(value)}" ${clean(state.filters[name]) === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
      }).join('')}<div class="fn-filter-panel-foot"><button type="button" class="fn-filter-clear" data-fn-filters-clear>${(globalThis.PlatformLanguage?.htmlText("financials","m_3d416befe4dad6","Clear filters") ?? "Clear filters")}</button><button type="submit" class="fn-btn primary">${(globalThis.PlatformLanguage?.htmlText("financials","m_8cb6b086a0e69c","Done") ?? "Done")}</button></div></form>`;
    }

    function activeFiltersHtml(){
      const active = activeFilters();
      if (!active.length) return '';
      return `<div class="fn-active-filters" role="status"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_d8cca9660fd93a","Filtered by") ?? "Filtered by")}</span>${active.map((item) => `<button type="button" class="fn-filter-chip" data-fn-filter-remove="${esc(item.name)}" aria-label="Remove ${esc(item.label)}">${esc(item.label)}<i class="fas fa-xmark" aria-hidden="true"></i></button>`).join('')}<button type="button" class="fn-filter-clear" data-fn-filters-clear>${(globalThis.PlatformLanguage?.htmlText("financials","m_df4c9025f9cc03","Clear all") ?? "Clear all")}</button></div>`;
    }

    // GP-134: on a phone the portal's top bar already names the app, so the header is only the shared tab strip
    // (Settings at its end, as in Communications), and one row under it holds the period and the filters.
    function phoneHeaderHtml(){
      const standalone = context.params?.standalone;
      const dated = DATED_VIEWS.includes(state.view);
      const settingsTab = { id:'settings', title:'Settings', icon:'fa-gear', attribute:'data-fn-settings' };
      const strip = standalone ? '' : window.AppChrome.tabs('financials', state.view, 'data-fn-view', context, { strip:true, extra:[settingsTab] });
      const selectedRange = range();
      const current = selectedRange.key === rangeFor(state.grain, new Date()).key;
      const period = dated ? `<div class="fn-pperiod" role="group" aria-label="${esc(rangeTitle(state.grain, selectedRange))}">
          <button type="button" data-fn-action="previous" aria-label="Previous ${esc(state.grain)}"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
          <span class="fn-pperiod-label">${esc(rangeTitleShort(state.grain, selectedRange))}</span>
          ${current ? '' : `<button type="button" class="fn-ptoday" data-fn-action="today">${(globalThis.PlatformLanguage?.htmlText("financials","m_23929ba4ba84dd","Today") ?? "Today")}</button>`}
          <button type="button" data-fn-action="next" aria-label="Next ${esc(state.grain)}"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
        </div><select class="fn-pgrain" data-fn-grain-select aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_179cb3b2ebc4a4","Financial period") ?? "Financial period")}">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([grain, label]) => `<option value="${grain}" ${state.grain === grain ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>` : '';
      // Receipts have no period: their row is the search, which opens the filters.
      const search = !dated && viewFilters().includes('q') ? `<button type="button" class="fn-psearch" data-fn-filters-toggle aria-expanded="${state.filtersOpen}" aria-controls="fnFilterPanel"><i class="fas fa-magnifying-glass" aria-hidden="true"></i><span>${esc(clean(state.filters.q) || 'Search and filter receipts')}</span>${activeFilters().length ? `<b>${activeFilters().length}</b>` : ''}</button>` : '';
      const settings = standalone ? `<button type="button" class="fn-btn fn-icon-btn" data-fn-settings aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_44392902abcd78","Financials settings") ?? "Financials settings")}"><i class="fas fa-gear"></i></button>` : '';
      const bar = period || search || settings ? `<div class="fn-pbar">${period}${search || filterButtonHtml()}${settings}${filterPanelHtml()}</div>` : '';
      return `${window.AppChrome.header({ title:standalone ? viewTitle(state.view) : 'Financials', icon:'fa-chart-line', strip })}${bar}<div class="fn-content${state.view === 'cashflow' ? ' fn-content-cash' : ''}">${activeFiltersHtml()}`;
    }

    function headerHtml(){
      if (isPhone()) return phoneHeaderHtml();
      const standalone = context.params?.standalone;
      const dated = DATED_VIEWS.includes(state.view);
      const settings = `<button type="button" class="fn-btn" data-fn-settings aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_44392902abcd78","Financials settings") ?? "Financials settings")}" data-fm-tooltip="Financials settings"><i class="fas fa-gear"></i></button>`;
      return `${window.AppChrome.header({ title:standalone ? viewTitle(state.view) : 'Financials', icon:'fa-chart-line',
        subtitle:dated ? rangeTitle(state.grain, range()) : '',
        tabs:`${dateControlsHtml()}${standalone ? '' : window.AppChrome.tabs('financials', state.view, 'data-fn-view', context)}`,
        actions:`${filterButtonHtml()}${settings}` }).replace('</header>', `${filterPanelHtml()}</header>`)}<div class="fn-content${state.view === 'cashflow' ? ' fn-content-cash' : ''}">${activeFiltersHtml()}`;
    }

    // A project is its customer (or a name someone gave it) and its address; a stand-in title ("New Project") and
    // the record id are not names (GP-113).
    function projectNames(project = {}){
      const address = clean(project.address);
      const title = clean(project.title || project.project_title || project.project_name);
      const placeholder = !title || /^(?:new|untitled) project$/i.test(title) || title === address || title === clean(project.id);
      const name = clean(project.customer_name) || (placeholder ? '' : title);
      if (name) return { primary:name, secondary:address && address !== name ? address : '' };
      return { primary:address || title || 'Untitled project', secondary:'' };
    }

    function profitabilityHtml(){
      const selectedRange = range();
      const totals = object(state.data?.totals);
      const activeRows = array(state.data?.projects);
      const displayCycles = buckets(state.grain, state.anchor);
      const cycles = array(state.data?.cycles).map((item, index) => ({
        ...displayCycles[index], revenue:number(item.revenue_cents), expenses:number(item.expenses_cents), profit:number(item.profit_cents)
      }));
      const projectedProfit = number(totals.projected_profit_cents);
      const profitToDate = number(totals.profit_to_date_cents);
      const owed = number(totals.owed_by_period_end_cents);
      const revenueInRange = number(totals.revenue_in_period_cents);
      const activeCount = number(totals.matching_project_count);
      const maxProfit = Math.max(1, ...cycles.map((item) => Math.abs(item.profit)));
      const listed = clean(state.filters.status) === 'closed' ? 'closed' : clean(state.filters.status) === 'all' ? 'listed' : 'active';
      return `<section class="fn-metrics">
          ${metricHtml({ label:'Projected profit', icon:'fa-chart-line', value:money(projectedProfit), short:'Projected profit', phone:moneyShort(projectedProfit), tone:projectedProfit >= 0 ? 'fn-positive' : 'fn-negative', tooltip:`Projected profit of the ${activeCount} ${listed} project${activeCount === 1 ? '' : 's'} below.` })}
          ${metricHtml({ label:'Profit to date', icon:'fa-coins', value:money(profitToDate), short:'Profit to date', phone:moneyShort(profitToDate), tone:profitToDate >= 0 ? 'fn-positive' : 'fn-negative', tooltip:'Collected revenue less paid project costs.' })}
          ${metricHtml({ label:'Owed by period end', icon:'fa-file-invoice-dollar', value:money(owed), short:'Owed', phone:moneyShort(owed), tooltip:`Scheduled customer payments due by ${dateLabel(selectedRange.endInclusive)} and not yet paid.` })}
          ${metricHtml({ label:'Revenue in period', icon:'fa-arrow-trend-up', value:money(revenueInRange), short:'Revenue', phone:moneyShort(revenueInRange), tooltip:`Customer money that cleared in this ${state.grain}.` })}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${esc(listed === 'active' ? 'Active project profitability' : 'Project profitability')}${tipHtml(`Projected totals beside each project's position at the end of the selected ${state.grain}. Use Filters to choose which projects are counted.`)}</h2></div><span class="fn-count">${esc(`${activeCount} ${listed}`)}</span></div>
          ${activeRows.length && isPhone() ? `${projectListHtml(activeRows)}${state.data?.hasMore ? `<div class="fn-page-actions"><button class="fn-btn" data-fn-action="load-more" ${state.loading ? 'disabled' : ''}><i class="fas fa-plus"></i> Load more projects</button></div>` : ''}` : activeRows.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>Project</th><th>Schedule</th><th>Status</th><th class="fn-right">Projected revenue</th><th class="fn-right">Projected profit</th><th class="fn-right">Profit by period end</th><th class="fn-right">Customer owed</th><th class="fn-right">Margin</th><th><span class="fn-sr">Open</span></th></tr></thead><tbody>${activeRows.map((row) => {
            const projectedRevenue = number(row.projected_revenue_cents);
            const projectedProfitRow = number(row.projected_profit_cents);
            const margin = projectedRevenue ? projectedProfitRow / projectedRevenue * 100 : 0;
            const profitAtEnd = number(row.profit_by_period_end_cents);
            const names = projectNames(row.project);
            const scheduled = row.window?.scheduled ?? !!row.window?.start;
            return `<tr data-project-id="${esc(row.project.id)}" tabindex="0"><td><div class="fn-project"><span class="fn-project-mark"><i class="fas fa-house-chimney"></i></span><span><strong>${esc(names.primary)}</strong>${names.secondary ? `<small>${esc(names.secondary)}</small>` : ''}</span></div></td><td><div class="fn-schedule"><strong>${scheduled && row.window.start ? esc(dateLabel(row.window.start)) : 'Not scheduled'}</strong><span>${scheduled && row.window.end ? `Expected completion ${esc(dateLabel(row.window.end))}` : 'Completion date needed'}</span></div></td><td><span class="fn-status ${scheduled ? '' : 'unscheduled'}"><i class="fas ${scheduled ? 'fa-calendar-check' : 'fa-calendar-xmark'}"></i>${scheduled ? 'Scheduled' : 'Unscheduled'}</span></td><td class="fn-right">${money(projectedRevenue)}</td><td class="fn-right ${projectedProfitRow >= 0 ? 'fn-positive' : 'fn-negative'}"><strong>${money(projectedProfitRow)}</strong></td><td class="fn-right ${profitAtEnd >= 0 ? 'fn-positive' : 'fn-negative'}">${money(profitAtEnd)}</td><td class="fn-right">${money(row.customer_owed_cents)}</td><td class="fn-right"><div class="fn-margin"><span>${percent(margin)}</span><span class="fn-margin-bar"><span style="width:${Math.max(0, Math.min(100, margin))}%"></span></span></div></td><td class="fn-actions"><button type="button" class="fn-btn fn-open-project" data-fn-open-project="${esc(row.project.id)}" aria-label="Open ${esc(names.primary)}"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>Open project</button></td></tr>`;
          }).join('')}</tbody></table></div>${state.data?.hasMore ? `<div class="fn-page-actions"><button class="fn-btn" data-fn-action="load-more" ${state.loading ? 'disabled' : ''}><i class="fas fa-plus"></i> Load more projects</button></div>` : ''}` : `<div class="fn-empty"><i class="fas fa-folder-open"></i><strong>${activeFilters().length ? 'No projects match these filters' : 'No active financial projects yet'}</strong><span>${activeFilters().length ? 'Change or clear the filters to see more.' : 'Signed project revenue and costs will appear here.'}</span></div>`}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${((v8) => globalThis.PlatformLanguage?.text("financials","m_8bf1727c2d9fd8",`Revenue and profitability by cycle${v8}`,{v8}) ?? `Revenue and profitability by cycle${v8}`)(tipHtml(`Previous ${state.grain} cycles, from cleared customer payments and actual outgoing payments.`))}</h2></div></div>${isPhone() ? cycleListHtml(cycles, maxProfit) : `<div class="fn-history-grid">${cycles.map((cycle) => `<article class="fn-cycle ${cycle.current ? 'current' : ''}"><span class="fn-cycle-label">${esc(cycle.label)}${cycle.current ? ' · Current' : ''}</span><strong class="fn-cycle-profit ${cycle.profit >= 0 ? 'fn-positive' : 'fn-negative'}">${money(cycle.profit, true)}</strong><div class="fn-cycle-row"><span>Revenue</span><b>${money(cycle.revenue, true)}</b></div><div class="fn-cycle-row"><span>Expenses</span><b>${money(cycle.expenses, true)}</b></div><div class="fn-cycle-bar"><span style="width:${Math.round(Math.abs(cycle.profit) / maxProfit * 100)}%;background:${cycle.profit >= 0 ? '#12b76a' : '#f04438'}"></span></div></article>`).join('')}</div>`}</section>`;
    }

    // GP-134: a phone lists each project as a card: who and where, its schedule, its projected profit and margin, then
    // revenue, profit by the period's end and what the customer owes. The whole card opens the project.
    function projectListHtml(rows){
      return `<div class="fn-plist">${rows.map((row) => {
        const projectedRevenue = number(row.projected_revenue_cents);
        const projectedProfitRow = number(row.projected_profit_cents);
        const margin = projectedRevenue ? projectedProfitRow / projectedRevenue * 100 : 0;
        const profitAtEnd = number(row.profit_by_period_end_cents);
        const names = projectNames(row.project);
        const scheduled = row.window?.scheduled ?? !!row.window?.start;
        const schedule = scheduled && row.window.start ? `${dateLabel(row.window.start, { year:false })}${row.window.end ? ` – ${dateLabel(row.window.end, { year:false })}` : ''}` : 'Not scheduled';
        return `<article class="fn-prow" data-project-id="${esc(row.project.id)}" tabindex="0" role="button" aria-label="Open ${esc(names.primary)}">
          <div class="fn-prow-top"><span class="fn-prow-name"><strong>${esc(names.primary)}</strong>${names.secondary ? `<small>${esc(names.secondary)}</small>` : ''}<span class="fn-prow-when ${scheduled ? '' : 'unscheduled'}"><i class="fas ${scheduled ? 'fa-calendar-check' : 'fa-calendar-xmark'}" aria-hidden="true"></i>${esc(schedule)}</span></span>
          <span class="fn-prow-figure"><strong class="${projectedProfitRow >= 0 ? 'fn-positive' : 'fn-negative'}">${esc(moneyShort(projectedProfitRow))}</strong><small>${esc(percent(margin))} margin</small></span></div>
          <dl class="fn-prow-facts"><div><dt>Revenue</dt><dd>${esc(moneyShort(projectedRevenue))}</dd></div><div><dt>By ${esc(state.grain)} end</dt><dd class="${profitAtEnd >= 0 ? 'fn-positive' : 'fn-negative'}">${esc(moneyShort(profitAtEnd))}</dd></div><div><dt>Owed</dt><dd>${esc(moneyShort(row.customer_owed_cents))}</dd></div></dl>
        </article>`;
      }).join('')}</div>`;
    }

    // GP-134: the cycles as one row each on a phone: the cycle, a bar for its profit, the profit, and revenue and
    // expenses under it.
    function cycleListHtml(cycles, maxProfit){
      return `<div class="fn-pcycles">${cycles.map((cycle) => `<div class="fn-pcycle${cycle.current ? ' current' : ''}"><span class="fn-pcycle-label">${esc(cycle.label)}${cycle.current ? '<small>Current</small>' : ''}</span><span class="fn-pcycle-bar"><span style="width:${Math.round(Math.abs(cycle.profit) / maxProfit * 100)}%;background:${cycle.profit >= 0 ? '#12b76a' : '#f04438'}"></span></span><strong class="${cycle.profit >= 0 ? 'fn-positive' : 'fn-negative'}">${esc(moneyShort(cycle.profit))}</strong><small class="fn-pcycle-sub">Revenue ${esc(moneyShort(cycle.revenue))} · Expenses ${esc(moneyShort(cycle.expenses))}</small></div>`).join('')}</div>`;
    }

    function reconcileRowHtml(payment, cleared){
      const id = clean(payment.id);
      const projectId = clean(payment.project_id);
      const inbound = clean(payment.direction || 'inbound') !== 'outbound';
      const at = payment.settled_at || payment.received_at || payment.created_at;
      const method = clean(payment.method?.label || payment.method?.type || payment.kind).replace(/_/g, ' ');
      return `<tr>
        <td>${esc(dateLabel(at, { year:false }))}</td>
        <td>${projectId ? `<button type="button" class="fn-link" data-fn-open-project="${esc(projectId)}">${esc(clean(payment.project_title) || 'Open project')}</button>` : `<span class="fn-muted">${(globalThis.PlatformLanguage?.htmlText("financials","m_500872d3c049f6","Company") ?? "Company")}</span>`}</td>
        <td><span class="fn-tx-icon ${inbound ? 'in' : 'out'}" style="width:20px;height:20px;font-size:9px"><i class="fas ${inbound ? 'fa-arrow-down' : 'fa-arrow-up'}"></i></span> ${esc(method || (inbound ? 'payment' : 'payment out'))}</td>
        <td class="fn-right ${inbound ? 'fn-positive' : 'fn-negative'}">${inbound ? '+' : '−'}${money(Math.abs(number(payment.amount_cents)))}</td>
        <td>${cleared ? esc(dateLabel(payment.cleared_at, { year:false })) : `<span class="fn-muted">${(globalThis.PlatformLanguage?.htmlText("financials","m_df2a233dc044ae","Awaiting bank") ?? "Awaiting bank")}</span>`}</td>
        <td class="fn-right">${cleared
          ? `<button type="button" class="fn-btn" data-fn-unclear-payment="${esc(id)}" ${state.loading ? 'disabled' : ''}><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_121bd1ce330c8e"," Unclear") ?? " Unclear")}</button>`
          : `<button type="button" class="fn-btn primary" data-fn-clear-payment="${esc(id)}" ${state.loading ? 'disabled' : ''}><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_040ce86d2436e1"," Mark cleared") ?? " Mark cleared")}</button>`}</td>
      </tr>`;
    }

    // GP-134: on a phone each payment is a card: which way it went, its project, method and date, the amount, and
    // whether the bank has it with the button that changes that.
    function reconcileListHtml(payments, cleared){
      return `<div class="fn-plist">${payments.map((payment) => {
        const id = clean(payment.id);
        const projectId = clean(payment.project_id);
        const inbound = clean(payment.direction || 'inbound') !== 'outbound';
        const at = payment.settled_at || payment.received_at || payment.created_at;
        const method = clean(payment.method?.label || payment.method?.type || payment.kind).replace(/_/g, ' ') || (inbound ? 'payment' : 'payment out');
        return `<article class="fn-prow fn-ppay">
          <span class="fn-tx-icon ${inbound ? 'in' : 'out'}"><i class="fas ${inbound ? 'fa-arrow-down' : 'fa-arrow-up'}" aria-hidden="true"></i></span>
          <span class="fn-prow-name">${projectId ? `<button type="button" class="fn-link" data-fn-open-project="${esc(projectId)}">${esc(clean(payment.project_title) || 'Open project')}</button>` : `<strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_500872d3c049f6","Company") ?? "Company")}</strong>`}<small>${esc(method)} · ${esc(dateLabel(at, { year:false }))}</small></span>
          <strong class="fn-ppay-amount ${inbound ? 'fn-positive' : 'fn-negative'}">${inbound ? '+' : '−'}${esc(moneyFine(Math.abs(number(payment.amount_cents))))}</strong>
          <span class="fn-ppay-state">${cleared ? `Cleared ${esc(dateLabel(payment.cleared_at, { year:false }))}` : (globalThis.PlatformLanguage?.htmlText("financials","m_df2a233dc044ae","Awaiting bank") ?? "Awaiting bank")}</span>
          ${cleared
            ? `<button type="button" class="fn-btn" data-fn-unclear-payment="${esc(id)}" ${state.loading ? 'disabled' : ''}><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_121bd1ce330c8e"," Unclear") ?? " Unclear")}</button>`
            : `<button type="button" class="fn-btn primary" data-fn-clear-payment="${esc(id)}" ${state.loading ? 'disabled' : ''}><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_040ce86d2436e1"," Mark cleared") ?? " Mark cleared")}</button>`}
        </article>`;
      }).join('')}</div>`;
    }

    // GP-113: Payouts is one tab for "has the money arrived": the processor's payouts (when the organization takes
    // card and bank payments here) and the payments recorded by hand that still need confirming at the bank.
    function payoutsHtml(){
      const totals = object(state.data?.totals);
      const uncleared = array(state.data?.uncleared);
      const cleared = array(state.data?.cleared).slice().reverse();
      const unclearedNet = number(totals.uncleared_inbound_cents) - number(totals.uncleared_outbound_cents);
      const head = ['Date', 'Project', 'Payment'].map((label) => `<th>${esc(label)}</th>`).join('') + `<th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_376b722115b602","Cleared") ?? "Cleared")}</th><th></th>`;
      return `${merchantProcessingEnabled() ? widgetHtml() : ''}
        <section class="fn-card"><div class="fn-card-head"><div><h2>${((v1) => globalThis.PlatformLanguage?.text("financials","m_1653d78ad46232",`Payments to confirm${v1}`,{v1}) ?? `Payments to confirm${v1}`)(tipHtml('Settled payments, refunds and disbursements not yet confirmed against your bank statement. Confirming one moves the cash-flow forecast from estimated to actual.'))}</h2></div><span class="fn-count" data-fm-tooltip="${esc(`${money(totals.uncleared_inbound_cents)} in · ${money(totals.uncleared_outbound_cents)} out`)}">${esc(`${uncleared.length} · ${unclearedNet >= 0 ? '+' : '−'}${money(Math.abs(unclearedNet))}`)}</span></div>
          ${uncleared.length && isPhone() ? reconcileListHtml(uncleared, false) : uncleared.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr>${head}</tr></thead><tbody>${uncleared.map((payment) => reconcileRowHtml(payment, false)).join('')}</tbody></table></div>` : `<div class="fn-empty compact"><i class="fas fa-check-double"></i><strong>Everything is confirmed</strong><span>New settled payments appear here until they are confirmed at the bank.</span></div>`}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${((v5) => globalThis.PlatformLanguage?.text("financials","m_525a8def75c84b",`Recently confirmed${v5}`,{v5}) ?? `Recently confirmed${v5}`)(tipHtml(`${number(totals.cleared_count)} confirmed · ${money(totals.cleared_inbound_cents)} in · ${money(totals.cleared_outbound_cents)} out`))}</h2></div></div>
          ${cleared.length && isPhone() ? reconcileListHtml(cleared.slice(0, 25), true) : cleared.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr>${head}</tr></thead><tbody>${cleared.slice(0, 25).map((payment) => reconcileRowHtml(payment, true)).join('')}</tbody></table></div>` : `<div class="fn-empty compact"><i class="fas fa-building-columns"></i><strong>Nothing confirmed yet</strong><span>Payments you confirm collect here.</span></div>`}
        </section>`;
    }

    // GP-113: every receipt in the organization, the project it is for and whether it still needs review; a receipt
    // opens in its project's Finances, beside the same review form.
    function receiptReviewed(receipt){ return clean(receipt.status).toLowerCase() === 'applied'; }
    function receiptAmount(receipt){ return number(receipt.total_cents ?? receipt.effective?.total_cents ?? receipt.extraction?.total_cents); }
    function receiptDate(receipt){ return clean(receipt.purchase_date || receipt.effective?.purchase_date) || clean(receipt.uploaded_at || receipt.created_at); }

    function filteredReceipts(){
      const query = clean(state.filters.q).toLowerCase();
      const review = clean(state.filters.review);
      const uploader = clean(state.filters.uploader);
      return array(state.data?.receipts).filter((receipt) => {
        const projectId = clean(receipt.project_id);
        if (review === 'needs_review' && receiptReviewed(receipt)) return false;
        if (review === 'reviewed' && !receiptReviewed(receipt)) return false;
        if (review === 'unassigned' && projectId) return false;
        if (uploader && clean(receipt.uploaded_by?.user_id) !== uploader) return false;
        if (!query) return true;
        const project = object(state.data?.projectsById?.[projectId]);
        const text = [receipt.title, receipt.extraction?.vendor_name, receipt.file?.file_name, receipt.uploaded_by?.name, project.title, project.address, project.customer_name].map(clean).join(' ').toLowerCase();
        return query.split(/\s+/).every((word) => text.includes(word));
      });
    }

    function receiptsHtml(){
      const all = array(state.data?.receipts);
      const rows = filteredReceipts();
      const needs = all.filter((receipt) => !receiptReviewed(receipt));
      const unassigned = all.filter((receipt) => !clean(receipt.project_id));
      const total = (list) => list.reduce((sum, receipt) => sum + receiptAmount(receipt), 0);
      return `<section class="fn-metrics">
          ${metricHtml({ label:'Needs review', icon:'fa-hourglass-half', value:`${needs.length} · ${money(total(needs))}`, short:'To review', phone:String(needs.length), phoneNote:moneyShort(total(needs)), tone:needs.length ? 'fn-negative' : '', tooltip:'Receipts not yet filed under an expense. Select to list only these.', filter:'needs_review' })}
          ${metricHtml({ label:'Reviewed', icon:'fa-check-double', value:`${all.length - needs.length} · ${money(total(all) - total(needs))}`, short:'Reviewed', phone:String(all.length - needs.length), phoneNote:moneyShort(total(all) - total(needs)), tone:'fn-positive', tooltip:'Receipts already filed under a project expense. Select to list only these.', filter:'reviewed' })}
          ${metricHtml({ label:'No project', icon:'fa-folder-open', value:String(unassigned.length), short:'No project', phoneNote:moneyShort(total(unassigned)), tooltip:'Receipts uploaded without a project. Select to list only these.', filter:'unassigned' })}
          ${metricHtml({ label:'All receipts', icon:'fa-receipt', value:`${all.length} · ${money(total(all))}`, short:'All', phone:String(all.length), phoneNote:moneyShort(total(all)), tooltip:'Every receipt your organization has uploaded. Select to list them all.', filter:'' })}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${((v4) => globalThis.PlatformLanguage?.text("financials","m_9920ef9e94207d",`Receipts${v4}`,{v4}) ?? `Receipts${v4}`)(tipHtml('Every uploaded receipt, newest first. Review one here or in its project’s Finances: both open the same review form.'))}</h2></div><span class="fn-count">${esc(rows.length === all.length ? `${all.length}` : `${rows.length} of ${all.length}`)}</span></div>
          ${rows.length && isPhone() ? receiptListHtml(rows) : rows.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>Date</th><th>Receipt</th><th>Project</th><th>Uploaded by</th><th class="fn-right">Amount</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((receipt) => {
            const projectId = clean(receipt.project_id);
            const project = object(state.data?.projectsById?.[projectId]);
            const names = projectId ? projectNames({ id:projectId, ...project }) : null;
            const reviewed = receiptReviewed(receipt);
            const image = /^image\//.test(clean(receipt.file?.content_type)) && window.PaymentsAPI?.receipts?.fileUrl ? window.PaymentsAPI.receipts.fileUrl(state.orgId, receipt.id, { inline:true }) : '';
            const title = clean(receipt.title || receipt.extraction?.vendor_name || receipt.file?.file_name) || 'Receipt';
            const fileName = clean(receipt.file?.file_name);
            return `<tr data-fn-receipt="${esc(receipt.id)}" tabindex="0">
              <td>${esc(dateLabel(receiptDate(receipt)))}</td>
              <td><div class="fn-receipt"><span class="fn-receipt-mark">${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : '<i class="fas fa-receipt"></i>'}</span><span><strong>${esc(title)}</strong>${fileName && fileName !== title ? `<small>${esc(fileName)}</small>` : ''}</span></div></td>
              <td>${names ? `<button type="button" class="fn-link" data-fn-open-project="${esc(projectId)}" data-fm-tooltip="${esc(names.secondary || names.primary)}">${esc(names.primary)}</button>` : '<span class="fn-muted">No project</span>'}</td>
              <td>${esc(clean(receipt.uploaded_by?.name) || 'Unknown')}</td>
              <td class="fn-right">${receiptAmount(receipt) ? moneyFine(receiptAmount(receipt)) : '<span class="fn-muted">Not read</span>'}</td>
              <td><span class="fn-badge ${reviewed ? 'good' : 'warn'}">${reviewed ? 'Reviewed' : 'Needs review'}</span></td>
              <td class="fn-actions"><button type="button" class="fn-btn${reviewed ? '' : ' primary'}" data-fn-open-receipt="${esc(receipt.id)}">${reviewed ? '<i class="fas fa-eye" aria-hidden="true"></i>Open' : '<i class="fas fa-pen-to-square" aria-hidden="true"></i>Review'}</button></td>
            </tr>`;
          }).join('')}</tbody></table></div>` : `<div class="fn-empty"><i class="fas fa-receipt"></i><strong>${all.length ? 'No receipts match these filters' : 'No receipts yet'}</strong><span>${all.length ? 'Change or clear the filters to see more.' : 'Receipts uploaded from a project or the phone app appear here.'}</span></div>`}
        </section>`;
    }

    // GP-134: a phone lists each receipt as a card: its picture, what it is, its project and date, who uploaded it,
    // the amount and whether it still needs review. The card opens the review.
    function receiptListHtml(rows){
      return `<div class="fn-plist">${rows.map((receipt) => {
        const projectId = clean(receipt.project_id);
        const project = object(state.data?.projectsById?.[projectId]);
        const names = projectId ? projectNames({ id:projectId, ...project }) : null;
        const reviewed = receiptReviewed(receipt);
        const image = /^image\//.test(clean(receipt.file?.content_type)) && window.PaymentsAPI?.receipts?.fileUrl ? window.PaymentsAPI.receipts.fileUrl(state.orgId, receipt.id, { inline:true }) : '';
        const title = clean(receipt.title || receipt.extraction?.vendor_name || receipt.file?.file_name) || 'Receipt';
        return `<article class="fn-prow fn-preceipt" data-fn-receipt="${esc(receipt.id)}" tabindex="0" role="button" aria-label="${esc(`${reviewed ? 'Open' : 'Review'} ${title}`)}">
          <span class="fn-receipt-mark">${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : '<i class="fas fa-receipt"></i>'}</span>
          <span class="fn-prow-name"><strong>${esc(title)}</strong><small>${names ? esc(names.primary) : 'No project'} · ${esc(dateLabel(receiptDate(receipt), { year:false }))}</small><small>${esc(clean(receipt.uploaded_by?.name) || 'Unknown')}</small></span>
          <span class="fn-prow-figure"><strong>${receiptAmount(receipt) ? esc(moneyFine(receiptAmount(receipt))) : '<span class="fn-muted">Not read</span>'}</strong><span class="fn-badge ${reviewed ? 'good' : 'warn'}">${reviewed ? 'Reviewed' : 'Needs review'}</span></span>
        </article>`;
      }).join('')}</div>`;
    }

    function settingsModalHtml(){
      return `<div class="fn-shade" data-fn-settings-shade><form class="fn-modal fn-modal-small fn-settings" role="dialog" aria-modal="true" aria-labelledby="fnSettingsTitle" data-fn-settings-form>
        <div class="fn-modal-head"><div><strong id="fnSettingsTitle">${(globalThis.PlatformLanguage?.htmlText("financials","m_44392902abcd78","Financials settings") ?? "Financials settings")}</strong></div><button type="button" data-fn-settings-close aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>
        <div class="fn-modal-body">
          <h3>${(globalThis.PlatformLanguage?.htmlText("financials","m_805ee16e5f3952","Cash flow") ?? "Cash flow")}</h3>
          <div><label><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_e665b691247939","Opening cash balance") ?? "Opening cash balance")}<small>${(globalThis.PlatformLanguage?.htmlText("financials","m_d11c5674aacecd","Cash on hand when the forecast starts. Leave at 0 to chart net movement only.") ?? "Cash on hand when the forecast starts. Leave at 0 to chart net movement only.")}</small></span><input type="number" step="0.01" name="opening" value="${esc((state.openingBalance / 100).toFixed(2))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_7ccaf7f30436e3","Opening cash balance in dollars") ?? "Opening cash balance in dollars")}"></label>
          <label><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_4c70554cc8095c","Customer payment clearing time") ?? "Customer payment clearing time")}<small>${(globalThis.PlatformLanguage?.htmlText("financials","m_d0dedcf1ac295d","How long a customer payment takes to become available to spend.") ?? "How long a customer payment takes to become available to spend.")}</small></span><input type="number" min="0" max="336" step="1" name="clearing" value="${esc(state.clearingHours)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_4e589dfcef5c24","Customer payment clearing time in hours") ?? "Customer payment clearing time in hours")}"></label></div>
          <h3>${(globalThis.PlatformLanguage?.htmlText("financials","m_5842802f6c8cbb","Payments") ?? "Payments")}</h3>
          <div class="fn-settings-link"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_5c9d5275be4e91","Payment methods, payouts account and fees are in Settings › Money.") ?? "Payment methods, payouts account and fees are in Settings › Money.")}</span><button type="button" class="fn-btn" data-fn-open-money-settings><i class="fas fa-wallet" aria-hidden="true"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_c25cc66b28cc9d","Open") ?? "Open")}</button></div>
        </div>
        <div class="fn-modal-foot"><button type="button" class="fn-btn" data-fn-settings-close>${(globalThis.PlatformLanguage?.htmlText("financials","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button type="submit" class="fn-btn primary">${(globalThis.PlatformLanguage?.htmlText("financials","m_5bab3e72de1ebf","Save") ?? "Save")}</button></div>
      </form></div>`;
    }

    // --- Payouts and Disputes: the shared payments widgets (GP-76) -----------

    // One widget element per view, kept across renders so its state survives.
    function widgetHtml(){ return `<div class="fn-widget-host" data-fn-widget="${esc(state.view)}"></div>`; }

    function mountWidget(){
      const host = root.querySelector('[data-fn-widget]');
      if (!host) return;
      const widgets = window.FirstMatePaymentsWidgets;
      if (!widgets) { host.innerHTML = `<div class="fn-empty"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_0243634a51f011","Payments are unavailable right now.") ?? "Payments are unavailable right now.")}</strong></div>`; return; }
      if (!state.widget || state.widget.view !== state.view || state.widget.orgId !== state.orgId) {
        state.widget?.instance?.destroy?.();
        const element = document.createElement('div');
        const instance = state.view === 'disputes'
          ? widgets.mountDisputes(element, { orgId:state.orgId, onOpenProject:openProject, phoneCards:true })
          : widgets.mountPayouts(element, { orgId:state.orgId, onOpenProject:openProject, onOpenInvoice:openInvoice, onOpenDisputes:() => switchView('disputes'), phoneCards:true });
        state.widget = { view:state.view, orgId:state.orgId, element, instance };
      }
      host.replaceWith(state.widget.element);
    }

    function switchView(view){
      const next = normalizeView(view);
      if (next === state.view) return;
      state.view = next;
      routePatch({ financialView:next }, 'push');
      state.data = null;
      load();
    }

    function transactionDate(item){ return item.clearedAt || item.expectedClearAt || item.initiatedAt || item.accruedAt || item.knownAt; }

    function transactionStateLabel(item){
      if (item.confidence === 'actual') return 'Actual';
      if (item.confidence === 'scheduled') return 'Scheduled';
      if (item.confidence === 'estimated') return 'Estimated';
      return 'Undated';
    }

    function transactionIds(items){ return items.map((item) => item.id).filter(Boolean).join(' '); }

    function chartHtml(series){
      if (!series.length) return `<div class="fn-chart-empty">${(globalThis.PlatformLanguage?.htmlText("financials","m_b5bf39bc056d36","No days are available in this period.") ?? "No days are available in this period.")}</div>`;
      // GP-134: a phone draws the chart at its own size, so its axis labels stay readable.
      const compact = isPhone();
      const width = compact ? 400 : 1080;
      const height = compact ? 240 : 360;
      const pad = compact ? { left:50, right:20, top:12, bottom:30 } : { left:76, right:24, top:20, bottom:40 };
      const values = series.flatMap((item) => [item.available, item.expected, item.safe, 0]);
      let min = Math.min(...values);
      let max = Math.max(...values);
      if (min === max) { min -= 100; max += 100; }
      const spread = max - min;
      min -= spread * .1;
      max += spread * .1;
      const x = (index) => pad.left + (series.length === 1 ? (width - pad.left - pad.right) / 2 : index / (series.length - 1) * (width - pad.left - pad.right));
      const y = (value) => pad.top + (max - value) / (max - min) * (height - pad.top - pad.bottom);
      const path = (key) => series.map((item, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(item[key]).toFixed(1)}`).join(' ');
      const ticks = Array.from({ length:5 }, (_, index) => max - (max - min) * index / 4);
      const xEvery = Math.max(1, Math.ceil(series.length / (compact ? 4 : 8)));
      const nodes = (key, cssClass, eventsForDay, exposure = false) => series.map((item, index) => {
        const related = exposure ? item.safeExposureTransactions : eventsForDay(item);
        return `<circle class="fn-node ${cssClass}" tabindex="0" data-fn-node="${index}" data-fn-line="${key}" data-fn-transaction-ids="${esc(transactionIds(related))}" cx="${x(index)}" cy="${y(item[key])}" r="${compact ? 3 : 4}"><title>${esc(dateLabel(item.date))}: ${esc(key.replace(/_/g, ' '))} ${money(item[key])}</title></circle>`;
      }).join('');
      return ("<svg class=\"fn-chart\" viewBox=\"0 0 " + String(width) + " " + String(height) + "\" role=\"img\" aria-label=\"" + ((v2) => globalThis.PlatformLanguage?.text("financials","m_e39427244e8681",`Available, expected, and safe-to-spend cash for ${v2}`,{v2}) ?? `Available, expected, and safe-to-spend cash for ${v2}`)(esc(rangeTitle(state.grain, range()))) + "\">\n        " + String(ticks.map((tick) => `<line class="fn-grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"></line><text class="fn-axis-label" x="${pad.left - 10}" y="${y(tick) + 3}" text-anchor="end">${esc(money(tick, true))}</text>`).join('')) + "\n        " + String(min < 0 && max > 0 ? `<line class="fn-zero-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"></line>` : '') + "\n        <path class=\"fn-line available\" d=\"" + String(path('available')) + "\"></path><path class=\"fn-line expected\" d=\"" + String(path('expected')) + "\"></path><path class=\"fn-line safe\" d=\"" + String(path('safe')) + "\"></path>\n        " + String(nodes('available', 'available', (item) => item.availableEvents)) + String(nodes('expected', 'expected', (item) => item.expectedEvents)) + String(nodes('safe', 'safe', () => [], true)) + "\n        " + String(series.map((item, index) => index % xEvery === 0 || index === series.length - 1 ? `<text class="fn-axis-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${esc(item.date.toLocaleDateString(undefined, { month:'short', day:'numeric' }))}</text>` : '').join('')) + "\n      </svg>");
    }

    function transactionRailHtml(transactions, selectedRange){
      const visible = transactions;
      return `<aside class="fn-card fn-transaction-rail"><div class="fn-card-head"><div><h2>${((v0) => globalThis.PlatformLanguage?.text("financials","m_c3eb288dd68605",`Transactions${v0}`,{v0}) ?? `Transactions${v0}`)(tipHtml('Cleared, expected and reserved movement.'))}</h2></div><span class="fn-count">${String(number(state.data?.transactionCount || visible.length))}</span></div><div class="fn-transaction-list">${String(visible.length ? visible.map((item) => {
        const at = transactionDate(item);
        return `<button type="button" class="fn-transaction" data-fn-transaction="${esc(item.id)}"><span class="fn-tx-icon ${item.amount >= 0 ? 'in' : 'out'}"><i class="fas ${item.amount >= 0 ? 'fa-arrow-down' : 'fa-arrow-up'}"></i></span><span class="fn-tx-main"><span class="fn-tx-title">${esc(item.label)}</span><span class="fn-tx-meta">${esc(item.projectTitle || (item.kind === 'payroll' ? 'Company payroll' : 'Company'))}</span><span class="fn-tx-state ${esc(item.confidence)}">${esc(transactionStateLabel(item))}${at ? ` · ${esc(dateLabel(at, { year:false }))}` : ''}</span></span><strong class="fn-tx-amount ${item.amount >= 0 ? 'fn-positive' : 'fn-negative'}">${item.amount >= 0 ? '+' : '−'}${money(Math.abs(item.amount), true)}</strong></button>`;
      }).join('') : `<div class="fn-empty compact"><i class="fas fa-receipt"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_0a7cadb6874455","No transactions in this period") ?? "No transactions in this period")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_37e5136c07c1cb","Undated commitments will appear here too.") ?? "Undated commitments will appear here too.")}</span></div>`)}${String(state.data?.hasMore ? `<div class="fn-page-actions"><button class="fn-btn" data-fn-action="load-more" ${state.loading ? 'disabled' : ''}>${(globalThis.PlatformLanguage?.htmlText("financials","m_211d60bfa491e9","Load more") ?? "Load more")}</button></div>` : '')}</div></aside>`;
    }

    function cashflowHtml(transactions){
      const selectedRange = range();
      const series = array(state.data?.series);
      const totals = object(state.data?.totals);
      const end = { available:number(totals.available_cents), expected:number(totals.expected_cents), safe:number(totals.safe_cents), pendingIncomingCents:number(totals.pending_incoming_cents), undatedExposureCents:number(totals.undated_exposure_cents) };
      const expectedIn = number(totals.expected_in_cents);
      const expectedOut = number(totals.expected_out_cents);
      return `<section class="fn-metrics cash">
        ${metricHtml({ label:(globalThis.PlatformLanguage?.text("financials","m_26a99e83a3505b","Available cash") ?? "Available cash"), icon:'fa-building-columns', value:money(end.available), short:'Available', phone:moneyShort(end.available), tone:'fn-available', tooltip:state.openingBalance ? 'Cleared cash plus your opening balance.' : 'Cleared cash: net movement from zero. Set an opening balance in Financials settings.' })}
        ${metricHtml({ label:(globalThis.PlatformLanguage?.text("financials","m_ad21d839382e4a","Expected available") ?? "Expected available"), icon:'fa-chart-line', value:money(end.expected), short:'Expected', phone:moneyShort(end.expected), tone:'fn-expected', tooltip:((v0,v1) => globalThis.PlatformLanguage?.text("financials","m_f6f19f6351ec46",`${v0} in and ${v1} out this period.`,{v0,v1}) ?? `${v0} in and ${v1} out this period.`)(money(expectedIn),money(expectedOut)) })}
        ${metricHtml({ label:(globalThis.PlatformLanguage?.text("financials","m_e4218fdc8067e4","Safe to spend") ?? "Safe to spend"), icon:'fa-shield-heart', value:money(end.safe), short:'Safe to spend', phone:moneyShort(end.safe), tone:end.safe >= 0 ? 'fn-positive' : 'fn-negative', tooltip:(globalThis.PlatformLanguage?.text("financials","m_71627a3bc42ab8","Expected cash less unpaid commitments.") ?? "Expected cash less unpaid commitments.") })}
        ${metricHtml({ label:(globalThis.PlatformLanguage?.text("financials","m_2a64ec2d1a192c","Pending incoming") ?? "Pending incoming"), icon:'fa-hourglass-half', value:money(end.pendingIncomingCents), short:'Pending', phone:moneyShort(end.pendingIncomingCents), tooltip:(globalThis.PlatformLanguage?.text("financials","m_0916c3264f05b5","Collected but not yet available.") ?? "Collected but not yet available.") })}
        ${metricHtml({ label:(globalThis.PlatformLanguage?.text("financials","m_438be42c1b6cb3","Undated exposure") ?? "Undated exposure"), icon:'fa-calendar-xmark', value:money(end.undatedExposureCents), short:'Undated', phone:moneyShort(end.undatedExposureCents), tone:end.undatedExposureCents ? 'fn-negative' : '', tooltip:(globalThis.PlatformLanguage?.text("financials","m_12d68f7ced0b3b","Money reserved for commitments that have no clearing date.") ?? "Money reserved for commitments that have no clearing date.") })}
      </section>
      <div class="fn-cash-workspace">${String(transactionRailHtml(transactions, selectedRange))}<section class="fn-card fn-chart-card"><div class="fn-card-head fn-cash-chart-head"><div><h2>${String(state.openingBalance ? 'Forecast cash position' : 'Net cash movement')}${tipHtml('Hover a line node or transaction to trace its effect. Safe to spend reserves future and undated outgoing commitments.')}</h2></div><div class="fn-chart-head-actions"><div class="fn-legend"><span><i style="background:#2e90fa"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_f326bdcd77881a","Available") ?? "Available")}</span><span><i style="background:#7f56d9"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_ad21d839382e4a","Expected available") ?? "Expected available")}</span><span><i style="background:#12b76a"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_e4218fdc8067e4","Safe to spend") ?? "Safe to spend")}</span></div></div></div><div class="fn-chart-wrap">${String(chartHtml(series))}</div></section><div class="fn-tooltip" data-fn-tooltip role="tooltip"></div><div class="fn-tx-popover" data-fn-transaction-tooltip role="tooltip"></div></div>`;
    }

    function render(){
      if(!state.view){root.innerHTML=`<div class="fn-shell">${window.AppChrome.header({title:'Financials',icon:'fa-chart-line',actions:'<button data-app-layout-open="financials">App layout</button>'})}<p>${(globalThis.PlatformLanguage?.htmlText("financials","m_830502e22b2140","No accessible apps in this group.") ?? "No accessible apps in this group.")}</p></div>`;return;}
      if (state.destroyed) return;
      if (!state.data && (state.loading || state.error)) { renderState(); bind(); return; }
      const transactions = modelTransactions();
      const focused = document.activeElement?.closest?.('[data-fn-filter-panel]') ? clean(document.activeElement.name) : '';
      const body = state.view === 'cashflow' ? cashflowHtml(transactions) : state.view === 'payouts' ? payoutsHtml() : state.view === 'receipts' ? receiptsHtml() : state.view === 'disputes' ? widgetHtml() : profitabilityHtml();
      root.innerHTML = `<div class="fn-shell">${headerHtml()}${body}</div></div>${state.settingsOpen ? settingsModalHtml() : ''}`;
      bind();
      mountWidget();
      if (focused) root.querySelector(`[data-fn-filter-panel] [name="${focused}"]`)?.focus();
    }

    function clearCashHighlights(){
      root.querySelectorAll('.fn-node.is-highlighted,.fn-transaction.is-highlighted').forEach((element) => element.classList.remove('is-highlighted'));
    }

    function highlightTransactions(ids = [], options = {}){
      clearCashHighlights();
      const wanted = new Set(ids.filter(Boolean));
      if (!wanted.size) return;
      root.querySelectorAll('[data-fn-transaction]').forEach((row) => row.classList.toggle('is-highlighted', wanted.has(row.dataset.fnTransaction)));
      root.querySelectorAll('[data-fn-transaction-ids]').forEach((node) => {
        const nodeIds = clean(node.dataset.fnTransactionIds).split(/\s+/).filter(Boolean);
        node.classList.toggle('is-highlighted', nodeIds.some((id) => wanted.has(id)));
      });
      if (options.reveal) root.querySelector('[data-fn-transaction].is-highlighted')?.scrollIntoView?.({ block:'nearest' });
    }

    function showNode(node){
      const index = Number(node.dataset.fnNode);
      const line = clean(node.dataset.fnLine);
      const series = array(state.data?.series);
      const item = series[index];
      const tooltip = root.querySelector('[data-fn-tooltip]');
      if (!item || !tooltip) return;
      const labels = { available:'Available cash', expected:'Expected available', safe:'Safe to spend' };
      const dayEvents = line === 'available' ? item.availableEvents : item.expectedEvents;
      const related = line === 'safe' ? item.safeExposureTransactions : dayEvents;
      // On a phone the list is below the chart: scrolling to it would take the tooltip off the screen.
      highlightTransactions(related.map((transaction) => transaction.id), { reveal:!isPhone() });
      const delta = line === 'available' ? item.availableDelta : line === 'expected' ? item.expectedDelta : item.safeDelta;
      tooltip.innerHTML = `<strong>${String(esc(dateLabel(item.date)))} · ${String(esc(labels[line] || line))}</strong><div class="fn-tooltip-total"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_78ff1aaef0c389","Position") ?? "Position")}</span><b>${String(money(item[line]))}</b></div><div class="fn-tooltip-total"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_9964885fff7421","Daily change") ?? "Daily change")}</span><b>${String(delta >= 0 ? '+' : '−')}${String(money(Math.abs(delta)))}</b></div><div class="fn-tooltip-exposure"><span><i class="fas fa-calendar-days"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_854e8e12743170","Dated future exposure ") ?? "Dated future exposure ")}<b>${String(money(item.datedExposureCents))}</b></span><span class="${String(item.undatedExposureCents ? 'warn' : '')}"><i class="fas fa-calendar-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_644de3ea02521d","Undated exposure reserved ") ?? "Undated exposure reserved ")}<b>${String(money(item.undatedExposureCents))}</b></span><span><i class="fas fa-hourglass-half"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_17c29efbe23853","Pending incoming ") ?? "Pending incoming ")}<b>${String(money(item.pendingIncomingCents))}</b></span></div>${String(dayEvents.length ? `<div class="fn-tooltip-list">${dayEvents.slice(0, 6).map((event) => `<div class="fn-tooltip-item"><span>${esc(event.label)}</span><b>${event.amount >= 0 ? '+' : '−'}${money(Math.abs(event.amount))}</b></div>`).join('')}</div>` : `<div class="fn-tooltip-list">${(globalThis.PlatformLanguage?.htmlText("financials","m_039ac323d0b72f","No new movement on this day.") ?? "No new movement on this day.")}</div>`)}`;
      const nodeRect = node.getBoundingClientRect();
      const viewportMargin = 8;
      const nodeGap = 10;
      tooltip.style.visibility = 'hidden';
      tooltip.style.left = '0';
      tooltip.style.top = '0';
      tooltip.classList.add('show');
      const tooltipRect = tooltip.getBoundingClientRect();
      const maxLeft = Math.max(viewportMargin, window.innerWidth - tooltipRect.width - viewportMargin);
      const left = Math.max(viewportMargin, Math.min(maxLeft, nodeRect.left + nodeRect.width / 2 - tooltipRect.width / 2));
      let top = nodeRect.top - tooltipRect.height - nodeGap;
      if (top < viewportMargin) top = nodeRect.bottom + nodeGap;
      if (top + tooltipRect.height > window.innerHeight - viewportMargin) {
        top = Math.max(viewportMargin, window.innerHeight - tooltipRect.height - viewportMargin);
      }
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.visibility = '';
    }

    function hideNode(){ root.querySelector('[data-fn-tooltip]')?.classList.remove('show'); clearCashHighlights(); }

    function showTransactionDetail(row, transaction){
      const popover = root.querySelector('[data-fn-transaction-tooltip]');
      if (!popover || !transaction) return;
      const at = transactionDate(transaction);
      const clearLabel = transaction.clearedAt ? 'Cleared' : transaction.expectedClearAt ? 'Expected clearing' : 'Clearing';
      popover.innerHTML = `<strong>${String(esc(transaction.label))}</strong><span>${String(esc(transaction.projectTitle || (transaction.kind === 'payroll' ? 'Company payroll' : 'Company')))}</span><div class="fn-tx-popover-grid"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_5469184513c8bc","Amount ") ?? "Amount ")}<b>${String(transaction.amount >= 0 ? '+' : '−')}${String(money(Math.abs(transaction.amount)))}</b></span><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_5b1cdca9bcee11","Status ") ?? "Status ")}<b>${String(esc(transactionStateLabel(transaction)))}</b></span><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_21043cdf9f50a0","Known / accrued ") ?? "Known / accrued ")}<b>${String(transaction.knownAt ? esc(dateLabel(transaction.knownAt)) : 'Unknown')}</b></span><span>${String(esc(clearLabel))} <b>${String(at ? esc(dateLabel(at)) : 'Undated')}</b></span></div>`;
      const rect = row.getBoundingClientRect();
      const width = 270;
      popover.style.left = `${Math.min(window.innerWidth - width - 10, rect.right + 8)}px`;
      popover.style.top = `${Math.max(8, Math.min(window.innerHeight - 170, rect.top))}px`;
      popover.classList.add('show');
      highlightTransactions([transaction.id]);
    }

    function hideTransactionDetail(){ root.querySelector('[data-fn-transaction-tooltip]')?.classList.remove('show'); clearCashHighlights(); }

    function openProject(projectId){
      if (!projectId || window.Portal?.navigation?.applying) return;
      // navigate, not push: a route patch alone never opened the project window (GP-113).
      window.Portal?.navigation?.navigate?.({ project:projectId, projectTab:'money' }, { source:'financial-project-money', ownedKeys:['project','projectTab'] });
    }

    function openInvoice(invoiceId){
      if (!invoiceId || window.Portal?.navigation?.applying) return;
      window.Portal?.navigation?.push?.({ tab:'invoices', invoice:invoiceId }, { source:'financials-payout-invoice', ownedKeys:['invoice'] });
    }

    function saveFilters(){
      try { window.localStorage?.setItem?.(FILTER_KEY, JSON.stringify(state.filters)); } catch (_) {}
    }

    // Receipts filter in the page; every other view asks the server again (the figures follow the filters).
    function setFilters(patch){
      const before = JSON.stringify(state.filters);
      Object.entries(patch).forEach(([name, value]) => { if (FILTER_FIELDS[name]) state.filters[name] = clean(value); });
      if (JSON.stringify(state.filters) === before) { render(); return; }
      saveFilters();
      if (state.view === 'receipts') render();
      else load({ silent:true });
    }

    function filterQuery(){
      const query = {};
      viewFilters().forEach((name) => {
        const value = clean(state.filters[name]);
        if (!value || name === 'review' || name === 'uploader') return;
        if (name === 'status' && !filterOptions('status').some(([id]) => id === value)) return;
        query[name] = value;
      });
      return query;
    }

    function openReceipt(receiptId){
      const receipt = array(state.data?.receipts).find((item) => clean(item.id) === clean(receiptId));
      if (!receipt || window.Portal?.navigation?.applying) return;
      const projectId = clean(receipt.project_id);
      // A project's receipt opens in its Finances beside the review form; one with no project opens in Receipts.
      if (projectId) window.Portal?.navigation?.navigate?.({ project:projectId, projectTab:'money', receipt:receipt.id }, { source:'financials-receipt', ownedKeys:['project', 'projectTab', 'receipt'] });
      else window.Portal?.navigation?.push?.({ tab:'receipts', receipt:receipt.id }, { source:'financials-receipt', ownedKeys:['receipt'] });
    }

    function openSettings(open){
      state.settingsOpen = !!open;
      render();
      if (open) root.querySelector(isPhone() ? '[data-fn-settings-form]' : '[data-fn-settings-form] input')?.focus();
      else root.querySelector('[data-fn-settings]')?.focus();
    }

    function bind(){
      root.querySelector('[data-fn-action="refresh"]')?.addEventListener('click', () => load());
      root.querySelector('[data-fn-filters-toggle]')?.addEventListener('click', () => {
        state.filtersOpen = !state.filtersOpen;
        render();
        // A phone's keyboard would cover the panel; only the receipt search row opens straight into typing.
        if (state.filtersOpen && (!isPhone() || state.view === 'receipts')) root.querySelector('[data-fn-filter-panel] input, [data-fn-filter-panel] select')?.focus();
      });
      const panel = root.querySelector('[data-fn-filter-panel]');
      panel?.addEventListener('change', (event) => { if (event.target.name && event.target.name !== 'q') setFilters({ [event.target.name]:event.target.value }); });
      panel?.addEventListener('submit', (event) => {
        event.preventDefault();
        state.filtersOpen = false;
        setFilters({ q:panel.querySelector('[name="q"]')?.value || '' });
        root.querySelector('[data-fn-filters-toggle]')?.focus();
      });
      panel?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        state.filtersOpen = false;
        render();
        root.querySelector('[data-fn-filters-toggle]')?.focus();
      });
      root.querySelectorAll('[data-fn-filters-clear]').forEach((button) => button.addEventListener('click', () => {
        setFilters(Object.fromEntries(viewFilters().map((name) => [name, ''])));
      }));
      root.querySelectorAll('[data-fn-filter-remove]').forEach((button) => button.addEventListener('click', () => setFilters({ [button.dataset.fnFilterRemove]:'' })));
      root.querySelectorAll('[data-fn-review-filter]').forEach((button) => button.addEventListener('click', () => setFilters({ review:button.dataset.fnReviewFilter })));
      root.querySelectorAll('[data-fn-open-receipt]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); openReceipt(button.dataset.fnOpenReceipt); }));
      root.querySelectorAll('[data-fn-receipt]').forEach((row) => {
        row.addEventListener('click', () => openReceipt(row.dataset.fnReceipt));
        row.addEventListener('keydown', (event) => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openReceipt(row.dataset.fnReceipt); } });
      });
      root.querySelector('[data-fn-settings]')?.addEventListener('click', () => openSettings(true));
      root.querySelectorAll('[data-fn-settings-close]').forEach((button) => button.addEventListener('click', () => openSettings(false)));
      const shade = root.querySelector('[data-fn-settings-shade]');
      shade?.addEventListener('click', (event) => { if (event.target === shade) openSettings(false); });
      shade?.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); openSettings(false); } });
      root.querySelector('[data-fn-open-money-settings]')?.addEventListener('click', () => {
        state.settingsOpen = false;
        render();
        window.Portal?.navigation?.push?.({ tab:'company_settings', sub:'money' }, { source:'financials-settings', ownedKeys:['sub'] });
      });
      root.querySelector('[data-fn-settings-form]')?.addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.target;
        const dollars = Number(String(form.elements.opening?.value || '').replace(/[^0-9.-]/g, ''));
        state.openingBalance = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
        state.clearingHours = Math.max(0, Math.min(336, number(form.elements.clearing?.value)));
        try {
          window.localStorage?.setItem?.('fm:financial:opening-balance-cents', String(state.openingBalance));
          window.localStorage?.setItem?.('fm:financial:clearing-hours', String(state.clearingHours));
        } catch (_) {}
        state.settingsOpen = false;
        if (DATED_VIEWS.includes(state.view)) load({ silent:true }); else render();
        root.querySelector('[data-fn-settings]')?.focus();
      });
      root.querySelectorAll('[data-fn-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.fnView)));
      root.querySelectorAll('[data-fn-open-invoice]').forEach((button) => {
        button.addEventListener('click', (event) => { event.stopPropagation(); openInvoice(button.dataset.fnOpenInvoice); });
      });
      const setGrain = (grain) => {
        if (!['day','week','month'].includes(grain) || grain === state.grain) return;
        state.grain = grain;
        routePatch({ financialGrain:grain, financialDate:dateKey(state.anchor) });
        load({ silent:true });
      };
      root.querySelectorAll('[data-fn-grain]').forEach((button) => button.addEventListener('click', () => setGrain(button.dataset.fnGrain)));
      root.querySelector('[data-fn-grain-select]')?.addEventListener('change', (event) => setGrain(event.target.value));
      root.querySelector('[data-fn-action="previous"]')?.addEventListener('click', () => { state.anchor = shiftAnchor(state.grain, state.anchor, -1); routePatch({ financialDate:dateKey(state.anchor) }); load({ silent:true }); });
      root.querySelector('[data-fn-action="next"]')?.addEventListener('click', () => { state.anchor = shiftAnchor(state.grain, state.anchor, 1); routePatch({ financialDate:dateKey(state.anchor) }); load({ silent:true }); });
      root.querySelector('[data-fn-action="today"]')?.addEventListener('click', () => { state.anchor = dayStart(new Date()); routePatch({ financialDate:dateKey(state.anchor) }); load({ silent:true }); });
      root.querySelector('[data-fn-action="load-more"]')?.addEventListener('click', () => load({ append:true, silent:true }));
      root.querySelectorAll('[data-project-id]').forEach((row) => {
        row.addEventListener('click', () => openProject(row.dataset.projectId));
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProject(row.dataset.projectId); } });
      });
      root.querySelectorAll('[data-fn-open-project]').forEach((button) => {
        button.addEventListener('click', (event) => { event.stopPropagation(); openProject(button.dataset.fnOpenProject); });
      });
      const reconcileAction = (paymentId, action) => {
        if (!paymentId || state.loading) return;
        state.loading = true;
        render();
        Promise.resolve(action === 'clear'
          ? window.PaymentsAPI.payments.clear(state.orgId, paymentId, {})
          : window.PaymentsAPI.payments.unclear(state.orgId, paymentId))
          .catch((error) => { state.error = error; })
          .finally(() => { state.loading = false; load({ silent:true }); });
      };
      root.querySelectorAll('[data-fn-clear-payment]').forEach((button) => {
        button.addEventListener('click', () => reconcileAction(button.dataset.fnClearPayment, 'clear'));
      });
      root.querySelectorAll('[data-fn-unclear-payment]').forEach((button) => {
        button.addEventListener('click', () => reconcileAction(button.dataset.fnUnclearPayment, 'unclear'));
      });
      root.querySelectorAll('[data-fn-node]').forEach((node) => {
        node.addEventListener('mouseenter', () => showNode(node));
        node.addEventListener('mouseleave', hideNode);
        node.addEventListener('focus', () => showNode(node));
        node.addEventListener('blur', hideNode);
      });
      const transactions = modelTransactions();
      const byId = new Map(transactions.map((item) => [item.id, item]));
      // A phone row already shows its state and date; a tap opens the project rather than a hover card.
      const phone = isPhone();
      root.querySelectorAll('[data-fn-transaction]').forEach((row) => {
        const transaction = byId.get(row.dataset.fnTransaction);
        if (!phone) {
          row.addEventListener('mouseenter', () => showTransactionDetail(row, transaction));
          row.addEventListener('mouseleave', hideTransactionDetail);
          row.addEventListener('focus', () => showTransactionDetail(row, transaction));
          row.addEventListener('blur', hideTransactionDetail);
        }
        row.addEventListener('click', () => { if (transaction?.projectId) openProject(transaction.projectId); });
      });
    }

    async function load(options = {}){
      if(!state.view){render();return;}
      const token = ++state.loadToken;
      state.loading = true;
      state.error = null;
      if (!options.silent) render();
      try {
        if (!state.orgId) throw new Error('An organization is required to load financials.');
        if (!window.FinancialsAPI) throw new Error('The Financials API is unavailable.');
        const selectedRange = range();
        const currentCursor = options.append ? clean(state.data?.nextCursor) : '';
        const query = {
          from:dateKey(selectedRange.start), through:dateKey(selectedRange.end), cursor:currentCursor,
          limit:state.view === 'cashflow' ? 100 : 50,
          clearing_hours:state.clearingHours, opening_balance_cents:state.openingBalance,
          ...filterQuery()
        };
        if (state.view === 'payouts') {
          if (!window.PaymentsAPI?.payments?.reconciliation) throw new Error('The Payments API is unavailable.');
          if (state.data?.kind === 'payouts') state.widget?.instance?.refresh?.();
          const result = await window.PaymentsAPI.payments.reconciliation(state.orgId);
          if (state.destroyed || token !== state.loadToken) return;
          state.data = {
            kind:'payouts',
            totals:object(result.totals),
            uncleared:array(result.uncleared),
            cleared:array(result.cleared)
          };
          state.loadedAt = Date.now();
          return;
        }
        if (state.view === 'receipts') {
          if (!window.PaymentsAPI?.receipts?.listFor) throw new Error('The Payments API is unavailable.');
          // Project names come from the project list, once per visit (the receipts list names only the project id).
          const [result, projects] = await Promise.all([
            window.PaymentsAPI.receipts.listFor(state.orgId, { kind:'organization', id:state.orgId }),
            state.projectsById && !options.reloadProjects ? Promise.resolve(null) : (window.PlatformAPI?.projects?.list?.(state.orgId) || Promise.resolve(null)).catch((error) => { logSourceSkip('projects', error); return null; })
          ]);
          if (state.destroyed || token !== state.loadToken) return;
          if (projects) {
            state.projectsById = {};
            array(projects.documents).forEach((document) => {
              const data = object(document?.data && typeof document.data === 'object' ? document.data : document);
              const id = clean(data.platform_project_id || data.id || document?.id);
              if (id) state.projectsById[id] = { title:clean(data.title || data.project_title || data.project_name), address:clean(data.address || data.project_address), customer_name:clean(data.customer_name || data.primary_contact_name) };
            });
          }
          state.data = { kind:'receipts', receipts:array(result?.receipts), projectsById:state.projectsById || {} };
          state.loadedAt = Date.now();
          return;
        }
        if (state.view === 'disputes') {
          // The widget loads its own data; a refresh reaches it.
          if (state.data?.kind === state.view) state.widget?.instance?.refresh?.();
          state.data = { kind:state.view };
          state.loadedAt = Date.now();
          return;
        }
        const result = state.view === 'cashflow'
          ? await window.FinancialsAPI.cashFlow(state.orgId, query)
          : await window.FinancialsAPI.projects(state.orgId, query);
        if (state.destroyed || token !== state.loadToken) return;
        if (state.view === 'cashflow') {
          const page = object(result.transactions);
          const incoming = array(page.items).map(apiTransaction);
          state.data = {
            kind:'cashflow', totals:object(result.totals), series:array(result.series).map(apiSeriesItem),
            transactions:options.append ? [...array(state.data?.transactions), ...incoming] : incoming,
            transactionCount:number(page.count), hasMore:page.has_more === true, nextCursor:clean(page.next_cursor),
            payrollIncluded:result.payroll_included !== false, asOf:result.as_of
          };
        } else {
          const page = object(result.projects);
          const incoming = array(page.items);
          state.data = {
            kind:'projects', totals:object(result.totals), cycles:array(result.cycles),
            projects:options.append ? [...array(state.data?.projects), ...incoming] : incoming,
            hasMore:page.has_more === true, nextCursor:clean(page.next_cursor), asOf:result.as_of
          };
        }
        state.loadedAt = Date.now();
      } catch (error) {
        if (state.destroyed || token !== state.loadToken) return;
        state.error = error;
      } finally {
        if (!state.destroyed && token === state.loadToken) { state.loading = false; render(); }
      }
    }

    const unregisterRoute = window.Portal?.navigation?.registerHandler?.(`financials-route:${context.instanceId || 'main'}`, {
      priority:410,
      immediate:true,
      apply(nextRoute){
        if (context.params?.standalone || nextRoute.tab !== 'financials') return;
        const nextView = normalizeView(window.AppChrome.resolve('financials',legacyView(nextRoute.financialView),context));
        const nextGrain = ['day','week','month'].includes(clean(nextRoute.financialGrain)) ? clean(nextRoute.financialGrain) : 'month';
        const nextAnchor = /^\d{4}-\d{2}-\d{2}$/.test(clean(nextRoute.financialDate)) ? dayStart(nextRoute.financialDate) : state.anchor;
        const changed = state.view !== nextView || state.grain !== nextGrain || dateKey(state.anchor) !== dateKey(nextAnchor);
        state.view = nextView;
        state.grain = nextGrain;
        state.anchor = nextAnchor;
        if (changed && state.data) { state.data = null; load(); }
      }
    });

    const refreshEvents = ['fm:projects:refresh','fm:calendar:refresh','fm:dashboard:refresh','fm:payroll:updated','fm:money:updated'];
    const scheduleRefresh = () => { if (state.active && !state.loading) load({ silent:true }); };
    const onLayout=()=>{if(context.params?.standalone)return;const next=normalizeView(window.AppChrome.resolve('financials',legacyView(window.Portal?.navigation?.read?.().financialView),context));if(next!==state.view){state.view=next;state.data=null;void load();}else render();};
    window.addEventListener('fm:app-placements:updated',onLayout);
    const refreshTimer=setInterval(()=>{if(!document.hidden && !root.contains(document.activeElement))scheduleRefresh();},30000);
    refreshEvents.forEach((name) => window.addEventListener(name, scheduleRefresh));
    // Capabilities can resolve after mount; re-normalize the requested view so
    // a direct link to the Payouts view survives the async capability load,
    // and re-render so the tab button appears/disappears.
    const onCapabilitiesUpdated = () => {
      if (state.destroyed) return;
      const wanted = normalizeView(context.params?.standalone || window.AppChrome.resolve('financials',legacyView((window.Portal?.navigation?.read?.() || {}).financialView),context));
      if (wanted !== state.view) { state.view = wanted; state.data = null; load(); return; }
      if (state.data) render();
    };
    window.addEventListener('fm:capabilities:updated', onCapabilitiesUpdated);
    // The filter panel closes on a click anywhere else.
    const onPointerDown = (event) => {
      if (!state.filtersOpen || event.target.closest?.('[data-fn-filter-panel],[data-fn-filters-toggle]')) return;
      state.filtersOpen = false;
      root.querySelector('[data-fn-filter-panel]')?.setAttribute('hidden', '');
      root.querySelector('[data-fn-filters-toggle]')?.setAttribute('aria-expanded', 'false');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    // Crossing the phone width swaps layouts (a rotated tablet, a resized window).
    const onPhoneChange = () => { if (!state.destroyed && state.data) render(); };
    phoneQuery?.addEventListener?.('change', onPhoneChange);
    load();

    return {
      destroy(){ state.widget?.instance?.destroy?.(); state.widget = null; window.removeEventListener('fm:app-placements:updated',onLayout); clearInterval(refreshTimer); state.destroyed = true; state.loadToken++; unregisterRoute?.(); refreshEvents.forEach((name) => window.removeEventListener(name, scheduleRefresh)); window.removeEventListener('fm:capabilities:updated', onCapabilitiesUpdated); document.removeEventListener('pointerdown', onPointerDown, true); phoneQuery?.removeEventListener?.('change', onPhoneChange); root.innerHTML = ''; },
      setActive(active){ state.active = !!active; if (active && Date.now() - state.loadedAt > 60_000 && !state.loading) load({ silent:!!state.data }); },
      update(nextContext = {}){ const nextOrg = clean(nextContext.orgId || nextContext.currentUser?.organization_id); if (nextOrg && nextOrg !== state.orgId) { state.orgId = nextOrg; state.data = null; load(); } },
      refresh(){ return load(); }
    };
  }

  runtime.registerApp({
    id:'portal.financials',
    package:'financials',
    kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("financials","m_187b087cb700ce","Financials") ?? "Financials"),
    label:(globalThis.PlatformLanguage?.text("financials","m_187b087cb700ce","Financials") ?? "Financials"),
    icon:'fa-chart-line',
    order:52,
    surfaces:['portal_tab'],
    regions:['main'],
    visible:true,
    fullBleed:true,
    mount:createApp
  });
  // GP-113: Reconcile is part of Payouts (old links to it land there); Receipts lists every receipt.
  const merchantProcessing = (context) => (context.capabilities?.current?.() || window.Portal?.capabilities?.current?.())?.effective_by_key?.['money.merchant_processing'] === true;
  const moneyOn = () => (window.Portal?.appFlags || window.PlatformAPI?.appFlags)?.value?.('platform', 'money', true) !== false;
  window.AppChrome.registerGroup({id:'financials',parent:'portal.financials',routeParam:'financialView',title:(globalThis.PlatformLanguage?.text("financials","m_187b087cb700ce","Financials") ?? "Financials"),icon:'fa-chart-line',default:'projects',
    members:[{id:'projects',title:(globalThis.PlatformLanguage?.text("financials","m_b25e412b4ffbc5","Profitability") ?? "Profitability"),short:'Profit',icon:'fa-chart-line'},{id:'cashflow',title:(globalThis.PlatformLanguage?.text("financials","m_805ee16e5f3952","Cash flow") ?? "Cash flow"),icon:'fa-chart-area'},
      {id:'payouts',title:(globalThis.PlatformLanguage?.text("financials","m_e06874e8b912d9","Payouts") ?? "Payouts"),icon:'fa-building-columns'},
      {id:'receipts',title:(globalThis.PlatformLanguage?.text("financials","m_fc54001a0cc000","Receipts") ?? "Receipts"),icon:'fa-receipt',available:moneyOn},
      {id:'disputes',title:(globalThis.PlatformLanguage?.text("financials","m_9b7a2edd995dfe","Disputes") ?? "Disputes"),icon:'fa-scale-balanced',available:merchantProcessing}],
    mount:(view,context)=>createApp({...context,params:{...context.params,standalone:view}})});
})();
