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

  const normalizeFinancialView = (value) => ['cashflow', 'reconcile', 'payouts'].includes(String(value ?? '').trim()) ? String(value).trim() : 'projects';

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

  function injectCss(){
    if (document.getElementById('firstmate-financials-css')) return;
    const style = document.createElement('style');
    style.id = 'firstmate-financials-css';
    style.textContent = `
      .fn-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f5f7fa;color:#101828;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .fn-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;background:#fff;border-bottom:1px solid #e4e7ec}.fn-heading{display:flex;align-items:center;gap:11px;min-width:0}.fn-heading-icon{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;background:#ecfdf3;color:#067647;font-size:17px}.fn-heading h1{margin:0;font-size:19px;letter-spacing:-.02em}.fn-heading p{margin:3px 0 0;color:#667085;font-size:11px;font-weight:750}.fn-top-actions{display:flex;gap:8px;align-items:center}
      .fn-btn{min-height:35px;padding:7px 11px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:850 11px/1 Inter,system-ui;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}.fn-btn:hover:not(:disabled){border-color:#98a2b3;background:#f9fafb}.fn-btn:disabled{opacity:.55;cursor:default}.fn-btn.primary{background:#067647;border-color:#067647;color:#fff}.fn-icon-btn{width:34px;padding:0}
      .fn-content{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px;display:flex;flex-direction:column;gap:14px}.fn-content.fn-content-cash{overflow:hidden}.fn-tabs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.fn-tabs,.fn-segment{display:inline-flex;align-items:center;padding:3px;background:#eaecf0;border-radius:9px}.fn-tabs button,.fn-segment button{border:0;background:transparent;color:#667085;border-radius:7px;padding:8px 12px;font:900 11px/1 Inter,system-ui;cursor:pointer;white-space:nowrap}.fn-tabs button.active,.fn-segment button.active{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.14)}.fn-range-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.fn-date-nav{display:flex;align-items:center;background:#fff;border:1px solid #d0d5dd;border-radius:8px;overflow:hidden}.fn-date-nav button{width:34px;height:34px;border:0;background:#fff;color:#475467;cursor:pointer}.fn-date-nav button:hover{background:#f2f4f7}.fn-date-label{min-width:180px;text-align:center;padding:0 10px;font-size:11px;font-weight:900;color:#344054}
      .fn-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.fn-metrics.cash{grid-template-columns:repeat(5,minmax(0,1fr))}.fn-metric{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:13px;min-width:0;box-shadow:0 1px 2px rgba(16,24,40,.02)}.fn-metric-label{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#667085;font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.04em}.fn-metric-label i{color:#98a2b3}.fn-metric strong{display:block;margin-top:8px;font-size:23px;line-height:1;letter-spacing:-.035em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fn-metric small{display:block;margin-top:7px;color:#667085;font-size:10px;font-weight:750}.fn-positive{color:#067647!important}.fn-negative{color:#b42318!important}.fn-available{color:#175cd3!important}.fn-expected{color:#6941c6!important}
      .fn-card{background:#fff;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.02)}.fn-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid #eaecf0}.fn-card-head h2{margin:0;font-size:13px}.fn-card-head p{margin:3px 0 0;color:#667085;font-size:10px;font-weight:750}.fn-count{font-size:10px;font-weight:900;color:#667085;background:#f2f4f7;border-radius:999px;padding:5px 8px;white-space:nowrap}
      .fn-table-wrap{overflow:auto}.fn-table{width:100%;border-collapse:collapse;min-width:900px}.fn-table th,.fn-table td{padding:10px 12px;border-bottom:1px solid #f0f2f5;text-align:left;font-size:11px;vertical-align:middle}.fn-table th{background:#f9fafb;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}.fn-table tr:last-child td{border-bottom:0}.fn-table tbody tr[data-project-id]{cursor:pointer}.fn-table tbody tr[data-project-id]:hover{background:#f9fafb}.fn-right{text-align:right!important;white-space:nowrap}.fn-project{display:flex;align-items:center;gap:9px;min-width:190px}.fn-project-mark{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:#ecfdf3;color:#067647;flex:0 0 auto}.fn-project strong,.fn-project small{display:block}.fn-project strong{font-size:11px}.fn-project small{margin-top:2px;color:#667085;font-size:9px;font-weight:750;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-schedule{display:flex;flex-direction:column;gap:3px;min-width:150px}.fn-schedule strong{font-size:10px}.fn-schedule span{font-size:9px;color:#667085;font-weight:750}.fn-status{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 7px;background:#ecfdf3;color:#067647;font-size:9px;font-weight:950;text-transform:capitalize}.fn-status.unscheduled{background:#fffaeb;color:#b54708}.fn-margin{display:flex;align-items:center;justify-content:flex-end;gap:7px}.fn-margin-bar{width:55px;height:6px;border-radius:999px;background:#eaecf0;overflow:hidden}.fn-margin-bar span{display:block;height:100%;border-radius:999px;background:#12b76a}
      .fn-history-grid{display:grid;grid-template-columns:repeat(6,minmax(130px,1fr));gap:8px;padding:12px;overflow:auto}.fn-cycle{border:1px solid #e4e7ec;border-radius:9px;padding:10px;min-width:130px;background:#fff}.fn-cycle.current{border-color:#a6f4c5;background:#f6fef9}.fn-cycle-label{font-size:10px;font-weight:950}.fn-cycle-profit{display:block;margin-top:9px;font-size:18px;letter-spacing:-.03em}.fn-cycle-row{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:9px;color:#667085;font-weight:800}.fn-cycle-bar{height:4px;background:#f2f4f7;border-radius:999px;overflow:hidden;margin-top:9px}.fn-cycle-bar span{display:block;height:100%;background:#12b76a;border-radius:999px}.fn-empty{padding:34px 18px;text-align:center;color:#667085}.fn-empty i{display:block;font-size:22px;margin-bottom:9px;color:#98a2b3}.fn-empty strong{display:block;color:#344054;font-size:13px}.fn-empty span{display:block;margin-top:5px;font-size:11px}
      .fn-page-actions{display:flex;justify-content:center;padding:12px;border-top:1px solid #eaecf0;background:#f9fafb}
      .fn-cash-workspace{position:relative;flex:1;display:grid;grid-template-columns:minmax(270px,320px) minmax(0,1fr);gap:12px;align-items:stretch;min-height:0}.fn-chart-card{min-width:0;min-height:0;display:flex;flex-direction:column}.fn-cash-chart-head{align-items:flex-start;flex:0 0 auto}.fn-chart-head-actions{display:flex;align-items:flex-end;justify-content:flex-end;gap:10px;flex-wrap:wrap}.fn-legend{display:flex;align-items:center;gap:12px;font-size:10px;font-weight:850;color:#667085}.fn-legend span{display:flex;align-items:center;gap:5px}.fn-legend i{width:18px;height:3px;border-radius:999px}.fn-cash-settings{display:flex;gap:7px;align-items:center}.fn-clearing{display:flex;align-items:center;gap:5px;font-size:9px;font-weight:850;color:#667085;white-space:nowrap}.fn-clearing input{width:64px;border:1px solid #d0d5dd;border-radius:7px;padding:5px 6px;font:850 10px Inter,system-ui;color:#344054}.fn-chart-wrap{position:relative;flex:1;min-height:0;padding:10px 10px 2px}.fn-chart{display:block;width:100%;height:100%;min-height:0;overflow:visible}.fn-grid-line{stroke:#eaecf0;stroke-width:1}.fn-zero-line{stroke:#98a2b3;stroke-width:1.4;stroke-dasharray:5 5}.fn-axis-label{fill:#667085;font-size:10px;font-weight:750}.fn-line{fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.fn-line.available{stroke:#2e90fa}.fn-line.expected{stroke:#7f56d9;stroke-dasharray:7 5}.fn-line.safe{stroke:#12b76a}.fn-node{stroke:#fff;stroke-width:2;cursor:pointer;outline:none;transition:r .12s,stroke-width .12s}.fn-node.available{fill:#2e90fa}.fn-node.expected{fill:#7f56d9}.fn-node.safe{fill:#12b76a}.fn-node:hover,.fn-node:focus,.fn-node.is-highlighted{stroke:#101828;stroke-width:3;r:6}.fn-tooltip{position:fixed;z-index:2147483640;width:270px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:hidden;box-sizing:border-box;pointer-events:none;background:#101828;color:#fff;border-radius:9px;padding:10px;box-shadow:0 12px 30px rgba(16,24,40,.25);font-size:10px;display:none}.fn-tooltip.show{display:block}.fn-tooltip>strong{display:block;font-size:11px}.fn-tooltip-total{display:flex;justify-content:space-between;gap:8px;margin-top:7px;color:#d0d5dd;font-weight:850}.fn-tooltip-exposure{margin-top:8px;padding:7px 0;border-top:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);display:grid;gap:5px}.fn-tooltip-exposure span{display:flex;align-items:center;gap:6px;color:#d0d5dd}.fn-tooltip-exposure span b{margin-left:auto;color:#fff}.fn-tooltip-exposure .warn,.fn-tooltip-exposure .warn b{color:#fec84b}.fn-tooltip-list{margin-top:7px;display:flex;flex-direction:column;gap:4px}.fn-tooltip-item{display:flex;justify-content:space-between;gap:8px}.fn-tooltip-item span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-chart-empty{height:100%;min-height:0;display:grid;place-items:center;color:#667085;font-size:11px;font-weight:800}
      .fn-transaction-rail{min-height:0;height:auto;display:flex;flex-direction:column}.fn-transaction-rail .fn-card-head{flex:0 0 auto;padding:11px 12px}.fn-transaction-list{flex:1;min-height:0;overflow:auto;scrollbar-width:thin}.fn-transaction{position:relative;width:100%;border:0;border-bottom:1px solid #f0f2f5;background:#fff;padding:8px 9px;display:grid;grid-template-columns:26px minmax(0,1fr) auto;gap:8px;align-items:center;text-align:left;cursor:pointer;transition:background .12s,box-shadow .12s}.fn-transaction:hover,.fn-transaction:focus,.fn-transaction.is-highlighted{outline:0;background:#f5f8ff;box-shadow:inset 3px 0 #2e90fa}.fn-tx-icon{width:25px;height:25px;border-radius:7px;display:grid;place-items:center;font-size:9px}.fn-tx-icon.in{background:#ecfdf3;color:#067647}.fn-tx-icon.out{background:#fef3f2;color:#b42318}.fn-tx-main{min-width:0;display:block}.fn-tx-title,.fn-tx-meta,.fn-tx-state{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fn-tx-title{font-size:10px;font-weight:900;color:#344054}.fn-tx-meta{margin-top:2px;font-size:8px;font-weight:750;color:#667085}.fn-tx-state{width:max-content;max-width:100%;margin-top:3px;padding:2px 5px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:7px;font-weight:900;text-transform:uppercase;letter-spacing:.03em}.fn-tx-state.actual{background:#ecfdf3;color:#067647}.fn-tx-state.scheduled{background:#eff8ff;color:#175cd3}.fn-tx-state.estimated{background:#f9f5ff;color:#6941c6}.fn-tx-state.undated{background:#fffaeb;color:#b54708}.fn-tx-amount{font-size:10px;white-space:nowrap}.fn-empty.compact{padding:30px 12px}.fn-empty.compact i{font-size:18px}.fn-tx-popover{position:fixed;z-index:2147483300;display:none;width:270px;padding:10px;border-radius:9px;background:#101828;color:#fff;box-shadow:0 14px 34px rgba(16,24,40,.28);pointer-events:none;font-size:9px}.fn-tx-popover.show{display:block}.fn-tx-popover>strong,.fn-tx-popover>span{display:block}.fn-tx-popover>strong{font-size:11px}.fn-tx-popover>span{margin-top:3px;color:#98a2b3;font-weight:750}.fn-tx-popover-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.14)}.fn-tx-popover-grid span{color:#98a2b3}.fn-tx-popover-grid b{display:block;margin-top:2px;color:#fff}
      .fn-link{border:0;background:transparent;padding:0;color:#175cd3;font:850 11px Inter,system-ui;cursor:pointer;text-align:left}.fn-link:hover{text-decoration:underline}.fn-muted{color:#98a2b3;font-weight:750}
      .fn-metrics.payouts{grid-template-columns:repeat(6,minmax(0,1fr))}
      .fn-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 8px;font-size:9px;font-weight:950;text-transform:capitalize;background:#f2f4f7;color:#475467}
      .fn-badge.good{background:#ecfdf3;color:#067647}.fn-badge.info{background:#eff8ff;color:#175cd3}.fn-badge.warn{background:#fffaeb;color:#b54708}.fn-badge.bad{background:#fef3f2;color:#b42318}
      .fn-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .fn-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:6px 11px;font:900 10px/1 Inter,system-ui;cursor:pointer;white-space:nowrap}
      .fn-chip:hover{border-color:#98a2b3}.fn-chip.active{border-color:#101828;background:#101828;color:#fff}
      .fn-chip small{font-weight:800;opacity:.7;margin-left:4px}
      .fn-table tbody tr[data-fn-payout]{cursor:pointer}.fn-table tbody tr[data-fn-payout]:hover{background:#f9fafb}
      .fn-payout-id{display:flex;flex-direction:column;gap:2px;min-width:170px}.fn-payout-id strong{font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.fn-payout-id span{font-size:9px;color:#667085;font-weight:750}
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
      @media(max-width:1200px){.fn-metrics.cash{grid-template-columns:repeat(3,minmax(0,1fr))}.fn-metrics.payouts{grid-template-columns:repeat(3,minmax(0,1fr))}.fn-cash-workspace{grid-template-columns:minmax(240px,280px) minmax(0,1fr)}}
      @media(max-width:900px){.fn-content.fn-content-cash{overflow:auto}.fn-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.fn-history-grid{grid-template-columns:repeat(3,minmax(150px,1fr))}.fn-cash-workspace{flex:none;grid-template-columns:1fr}.fn-transaction-rail{height:280px}.fn-chart-card{min-height:458px}.fn-chart-wrap{min-height:370px}.fn-chart,.fn-chart-empty{min-height:360px}.fn-chart-head-actions{justify-content:flex-start}.fn-cash-chart-head{flex-direction:column}}
      @media(max-width:720px){.fn-top{padding:12px 14px}.fn-heading p{display:none}.fn-btn span{display:none}.fn-content{padding:12px}.fn-tabs-toolbar,.fn-range-tools{align-items:stretch}.fn-range-tools{width:100%}.fn-date-nav{flex:1}.fn-date-label{min-width:0;flex:1}.fn-segment{margin-left:auto}.fn-metrics,.fn-metrics.cash,.fn-metrics.payouts{grid-template-columns:1fr 1fr}.fn-modal-stats{grid-template-columns:1fr 1fr}.fn-metric{padding:11px}.fn-metric strong{font-size:18px}.fn-card-head{align-items:flex-start}.fn-cash-settings{flex-wrap:wrap}.fn-history-grid{grid-template-columns:repeat(6,150px)}}
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
      view:normalizeView(route.financialView),
      grain:['day','week','month'].includes(clean(route.financialGrain)) ? clean(route.financialGrain) : 'month',
      anchor:/^\d{4}-\d{2}-\d{2}$/.test(clean(route.financialDate)) ? dayStart(route.financialDate) : dayStart(new Date()),
      clearingHours:48,
      openingBalance:0,
      payoutFilter:'all',
      payoutDetail:null,
      data:null,
      loading:true,
      error:null,
      destroyed:false,
      loadToken:0,
      loadedAt:0,
      active:false
    };
    try {
      const stored = Number(window.localStorage?.getItem?.('fm:financial:clearing-hours'));
      if (Number.isFinite(stored) && stored >= 0 && stored <= 336) state.clearingHours = stored;
      const storedBalance = Number(window.localStorage?.getItem?.('fm:financial:opening-balance-cents'));
      if (Number.isFinite(storedBalance)) state.openingBalance = Math.round(storedBalance);
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
      const view = normalizeFinancialView(value);
      return view === 'payouts' && !merchantProcessingEnabled() ? 'projects' : view;
    }

    function range(){ return rangeFor(state.grain, state.anchor); }
    function modelTransactions(){
      return array(state.data?.transactions);
    }

    function routePatch(patch, history = 'replace'){
      if (window.Portal?.navigation?.applying) return;
      const method = history === 'push' ? 'push' : 'replace';
      window.Portal?.navigation?.[method]?.({ tab:'financials', ...patch }, {
        source:'financials',
        ownedKeys:['financialView','financialGrain','financialDate']
      });
    }

    function renderState(){
      const message = state.error?.message || clean(state.error) || 'Financial data is unavailable.';
      root.innerHTML = `<div class="fn-shell"><div class="fn-state"><div class="fn-state-inner"><div class="fn-state-icon"><i class="fas ${state.loading ? 'fa-circle-notch fn-spin' : 'fa-triangle-exclamation'}"></i></div><h2>${state.loading ? 'Building your financial forecast' : 'Financials could not load'}</h2><p>${state.loading ? 'Combining project schedules, payments, materials, payroll, and commissions.' : esc(message)}</p>${state.loading ? '' : `<button class="fn-btn primary" data-fn-action="refresh"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button>`}</div></div></div>`;
    }

    function headerHtml(){
      const selectedRange = range();
      return `<header class="fn-top">
        <div class="fn-heading"><span class="fn-heading-icon"><i class="fas fa-chart-line"></i></span><span><h1>${(globalThis.PlatformLanguage?.htmlText("financials","m_187b087cb700ce","Financials") ?? "Financials")}</h1><p>${(globalThis.PlatformLanguage?.htmlText("financials","m_1d8b2f9b15cbc7","Project profitability, money owed, and schedule-aware cash flow.") ?? "Project profitability, money owed, and schedule-aware cash flow.")}</p></span></div>
        <div class="fn-top-actions"><button class="fn-btn" data-fn-action="refresh" ${String(state.loading ? 'disabled' : '')}><i class="fas ${String(state.loading ? 'fa-circle-notch fn-spin' : 'fa-rotate')}"></i><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_78973ce0cf3403","Refresh") ?? "Refresh")}</span></button></div>
      </header><div class="fn-content${String(state.view === 'cashflow' ? ' fn-content-cash' : '')}">
        <div class="fn-tabs-toolbar"><div class="fn-tabs" role="tablist" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_761f608837c9a6","Financial views") ?? "Financial views")}"><button type="button" role="tab" data-fn-view="projects" class="${String(state.view === 'projects' ? 'active' : '')}" aria-selected="${String(state.view === 'projects')}"><i class="fas fa-briefcase"></i> ${String(esc(window.Portal?.terminology?.get?.('financials.profitability_view', 'Profitability') || 'Profitability'))}</button><button type="button" role="tab" data-fn-view="cashflow" class="${String(state.view === 'cashflow' ? 'active' : '')}" aria-selected="${String(state.view === 'cashflow')}"><i class="fas fa-wave-square"></i> ${String(esc(window.Portal?.terminology?.get?.('financials.cash_flow_view', 'Cash flow') || 'Cash flow'))}</button><button type="button" role="tab" data-fn-view="reconcile" class="${String(state.view === 'reconcile' ? 'active' : '')}" aria-selected="${String(state.view === 'reconcile')}"><i class="fas fa-check-double"></i> ${String(esc(window.Portal?.terminology?.get?.('financials.reconcile_view', 'Reconcile') || 'Reconcile'))}</button>${String(merchantProcessingEnabled() ? `<button type="button" role="tab" data-fn-view="payouts" class="${state.view === 'payouts' ? 'active' : ''}" aria-selected="${state.view === 'payouts'}"><i class="fas fa-money-bill-transfer"></i> ${esc(window.Portal?.terminology?.get?.('financials.payouts_view', 'Payouts') || 'Payouts')}</button>` : '')}</div>
          ${String(state.view === 'reconcile' || state.view === 'payouts' ? '' : `<div class="fn-range-tools"><button class="fn-btn" data-fn-action="today">${(globalThis.PlatformLanguage?.htmlText("financials","m_23929ba4ba84dd","Today") ?? "Today")}</button><div class="fn-date-nav"><button type="button" data-fn-action="previous" aria-label="${((v0) => globalThis.PlatformLanguage?.htmlText("financials","m_b0ae4f18f932d9",`Previous ${v0}`,{v0}) ?? `Previous ${v0}`)(esc(state.grain))}"><i class="fas fa-chevron-left"></i></button><span class="fn-date-label">${esc(rangeTitle(state.grain, selectedRange))}</span><button type="button" data-fn-action="next" aria-label="${((v2) => globalThis.PlatformLanguage?.htmlText("financials","m_b68752fb081712",`Next ${v2}`,{v2}) ?? `Next ${v2}`)(esc(state.grain))}"><i class="fas fa-chevron-right"></i></button></div><div class="fn-segment" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_179cb3b2ebc4a4","Financial period") ?? "Financial period")}">${['month','week','day'].map((grain) => `<button type="button" data-fn-grain="${grain}" class="${state.grain === grain ? 'active' : ''}">${grain[0].toUpperCase()}${grain.slice(1)}</button>`).join('')}</div></div>`)}
        </div>`;
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
      return `<section class="fn-metrics">
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_b20395aa99636a","Projected active profit ") ?? "Projected active profit ")}<i class="fas fa-chart-line"></i></span><strong class="${String(projectedProfit >= 0 ? 'fn-positive' : 'fn-negative')}">${String(money(projectedProfit))}</strong><small>${((v2,v3) => globalThis.PlatformLanguage?.htmlText("financials","m_abba3eaded07d0",`${v2} active project${v3}`,{v2,v3}) ?? `${v2} active project${v3}`)(activeCount,activeCount === 1 ? '' : 's')}</small></div>
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_129da9e878009d","Profit to date ") ?? "Profit to date ")}<i class="fas fa-coins"></i></span><strong class="${String(profitToDate >= 0 ? 'fn-positive' : 'fn-negative')}">${String(money(profitToDate))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_7be7089e8807f3","Collected revenue less paid project costs") ?? "Collected revenue less paid project costs")}</small></div>
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_f8e2f8481620fe","Owed by period end ") ?? "Owed by period end ")}<i class="fas fa-file-invoice-dollar"></i></span><strong>${String(money(owed))}</strong><small>${((v7) => globalThis.PlatformLanguage?.htmlText("financials","m_e146b7e444b6f1",`Scheduled customer obligations due by ${v7}`,{v7}) ?? `Scheduled customer obligations due by ${v7}`)(esc(dateLabel(selectedRange.endInclusive)))}</small></div>
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_add2f7f9427cda","Revenue in period ") ?? "Revenue in period ")}<i class="fas fa-arrow-trend-up"></i></span><strong>${String(money(revenueInRange))}</strong><small>${((v9) => globalThis.PlatformLanguage?.htmlText("financials","m_44577439ce4ab7",`Actual customer money clearing in this ${v9}`,{v9}) ?? `Actual customer money clearing in this ${v9}`)(esc(state.grain))}</small></div>
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_7f51d2b5cbf408","Active project profitability") ?? "Active project profitability")}</h2><p>${((v10) => globalThis.PlatformLanguage?.htmlText("financials","m_02f87093df8bfd",`Projected totals alongside the financial position at the end of the selected ${v10}.`,{v10}) ?? `Projected totals alongside the financial position at the end of the selected ${v10}.`)(esc(state.grain))}</p></div><span class="fn-count">${((v11) => globalThis.PlatformLanguage?.htmlText("financials","m_32a87082fe85c2",`${v11} active`,{v11}) ?? `${v11} active`)(activeCount)}</span></div>
          ${String(activeRows.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_fc05a804bd034c","Schedule") ?? "Schedule")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_1352cafa75b8da","Status") ?? "Status")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_73dcec25fe9540","Projected revenue") ?? "Projected revenue")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_7373a19a37d7ad","Projected profit") ?? "Projected profit")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_ef60edbf5a1f9d","Profit by period end") ?? "Profit by period end")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_20bdfc21d23edc","Customer owed") ?? "Customer owed")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_190ca7354b9101","Margin") ?? "Margin")}</th></tr></thead><tbody>${activeRows.map((row) => {
            const projectedRevenue = number(row.projected_revenue_cents);
            const projectedProfitRow = number(row.projected_profit_cents);
            const margin = projectedRevenue ? projectedProfitRow / projectedRevenue * 100 : 0;
            const profitAtEnd = number(row.profit_by_period_end_cents);
            return `<tr data-project-id="${esc(row.project.id)}" tabindex="0"><td><div class="fn-project"><span class="fn-project-mark"><i class="fas fa-house-chimney"></i></span><span><strong>${esc(titleForProject(row.project))}</strong><small>${esc(row.project.address || row.project.customer_name || clean(row.project.id))}</small></span></div></td><td><div class="fn-schedule"><strong>${row.window.start ? esc(dateLabel(row.window.start)) : 'Not scheduled'}</strong><span>${row.window.end ? `Expected completion ${esc(dateLabel(row.window.end))}` : 'Completion date needed'}</span></div></td><td><span class="fn-status ${row.window.start ? '' : 'unscheduled'}"><i class="fas ${row.window.start ? 'fa-calendar-check' : 'fa-calendar-xmark'}"></i>${row.window.start ? 'Scheduled' : 'Unscheduled'}</span></td><td class="fn-right">${money(projectedRevenue)}</td><td class="fn-right ${projectedProfitRow >= 0 ? 'fn-positive' : 'fn-negative'}"><strong>${money(projectedProfitRow)}</strong></td><td class="fn-right ${profitAtEnd >= 0 ? 'fn-positive' : 'fn-negative'}">${money(profitAtEnd)}</td><td class="fn-right">${money(row.customer_owed_cents)}</td><td class="fn-right"><div class="fn-margin"><span>${percent(margin)}</span><span class="fn-margin-bar"><span style="width:${Math.max(0, Math.min(100, margin))}%"></span></span></div></td></tr>`;
          }).join('')}</tbody></table></div>${state.data?.hasMore ? '<div class="fn-page-actions"><button class="fn-btn" data-fn-action="load-more" '+(state.loading ? 'disabled' : '')+`><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_261de3b5b52111"," Load more projects") ?? " Load more projects")}</button></div>` : ''}` : `<div class="fn-empty"><i class="fas fa-folder-open"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_1b49840a75aaa9","No active financial projects yet") ?? "No active financial projects yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_85c9cfa72b36e5","Signed project revenue and costs will appear here.") ?? "Signed project revenue and costs will appear here.")}</span></div>`)}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_ee752842d445f7","Revenue and profitability by cycle") ?? "Revenue and profitability by cycle")}</h2><p>${((v13) => globalThis.PlatformLanguage?.htmlText("financials","m_81c887bb713805",`Previous ${v13} cycles are based on cleared customer payments and actual outgoing payments.`,{v13}) ?? `Previous ${v13} cycles are based on cleared customer payments and actual outgoing payments.`)(esc(state.grain))}</p></div></div><div class="fn-history-grid">${String(cycles.map((cycle) => `<article class="fn-cycle ${cycle.current ? 'current' : ''}"><span class="fn-cycle-label">${esc(cycle.label)}${cycle.current ? ' · Current' : ''}</span><strong class="fn-cycle-profit ${cycle.profit >= 0 ? 'fn-positive' : 'fn-negative'}">${money(cycle.profit, true)}</strong><div class="fn-cycle-row"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_86ad4a76e7e7ca","Revenue") ?? "Revenue")}</span><b>${money(cycle.revenue, true)}</b></div><div class="fn-cycle-row"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_f958c97b3b0835","Expenses") ?? "Expenses")}</span><b>${money(cycle.expenses, true)}</b></div><div class="fn-cycle-bar"><span style="width:${Math.round(Math.abs(cycle.profit) / maxProfit * 100)}%;background:${cycle.profit >= 0 ? '#12b76a' : '#f04438'}"></span></div></article>`).join(''))}</div></section>`;
    }

    function reconcileRowHtml(payment, cleared){
      const id = clean(payment.id);
      const projectId = clean(payment.project_id);
      const inbound = clean(payment.direction || 'inbound') !== 'outbound';
      const at = payment.settled_at || payment.received_at || payment.created_at;
      const method = clean(payment.method?.label || payment.method?.type || payment.kind).replace(/_/g, ' ');
      return `<tr>
        <td>${esc(dateLabel(at, { year:false }))}</td>
        <td>${projectId ? `<button type="button" class="fn-link" data-fn-open-project="${esc(projectId)}">${esc(clean(payment.project_title) || projectId)}</button>` : `<span class="fn-muted">${(globalThis.PlatformLanguage?.htmlText("financials","m_500872d3c049f6","Company") ?? "Company")}</span>`}</td>
        <td><span class="fn-tx-icon ${inbound ? 'in' : 'out'}" style="width:20px;height:20px;font-size:9px"><i class="fas ${inbound ? 'fa-arrow-down' : 'fa-arrow-up'}"></i></span> ${esc(method || (inbound ? 'payment' : 'payment out'))}</td>
        <td class="fn-right ${inbound ? 'fn-positive' : 'fn-negative'}">${inbound ? '+' : '−'}${money(Math.abs(number(payment.amount_cents)))}</td>
        <td>${cleared ? esc(dateLabel(payment.cleared_at, { year:false })) : `<span class="fn-muted">${(globalThis.PlatformLanguage?.htmlText("financials","m_df2a233dc044ae","Awaiting bank") ?? "Awaiting bank")}</span>`}</td>
        <td class="fn-right">${cleared
          ? `<button type="button" class="fn-btn" data-fn-unclear-payment="${String(esc(id))}" ${String(state.loading ? 'disabled' : '')}><i class="fas fa-ban"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_121bd1ce330c8e"," Unclear") ?? " Unclear")}</button>`
          : `<button type="button" class="fn-btn primary" data-fn-clear-payment="${String(esc(id))}" ${String(state.loading ? 'disabled' : '')}><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_040ce86d2436e1"," Mark cleared") ?? " Mark cleared")}</button>`}</td>
      </tr>`;
    }

    function reconcileHtml(){
      const totals = object(state.data?.totals);
      const uncleared = array(state.data?.uncleared);
      const cleared = array(state.data?.cleared).slice().reverse();
      const unclearedNet = number(totals.uncleared_inbound_cents) - number(totals.uncleared_outbound_cents);
      return `<section class="fn-metrics">
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_66cfe4d15dbd80","Awaiting the bank ") ?? "Awaiting the bank ")}<i class="fas fa-hourglass-half"></i></span><strong>${String(number(totals.uncleared_count))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_abdd734e2a6c2f","Settled payments not yet confirmed against a statement") ?? "Settled payments not yet confirmed against a statement")}</small></div>
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_1e774361086e9c","Uncleared in ") ?? "Uncleared in ")}<i class="fas fa-arrow-down"></i></span><strong class="fn-positive">${String(money(totals.uncleared_inbound_cents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_7492b6603e6c7e","Recorded customer money not yet confirmed") ?? "Recorded customer money not yet confirmed")}</small></div>
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_4741f245997513","Uncleared out ") ?? "Uncleared out ")}<i class="fas fa-arrow-up"></i></span><strong class="fn-negative">${String(money(totals.uncleared_outbound_cents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_33123704a14dd7","Refunds and disbursements not yet confirmed") ?? "Refunds and disbursements not yet confirmed")}</small></div>
          <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_a63049b96293f9","Uncleared net ") ?? "Uncleared net ")}<i class="fas fa-scale-balanced"></i></span><strong class="${String(unclearedNet >= 0 ? 'fn-positive' : 'fn-negative')}">${String(money(unclearedNet))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_50d6a2d62c5016","Cash flow shifts by this much once confirmed") ?? "Cash flow shifts by this much once confirmed")}</small></div>
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_fde479c103476d","To reconcile") ?? "To reconcile")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("financials","m_256721a32d46c6","Confirm each recorded settlement against your bank statement. Cleared payments upgrade the cash-flow forecast from estimated to actual.") ?? "Confirm each recorded settlement against your bank statement. Cleared payments upgrade the cash-flow forecast from estimated to actual.")}</p></div><span class="fn-count">${String(uncleared.length)}</span></div>
          ${String(uncleared.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_2a0b11100c22a4","Date") ?? "Date")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_d0f1699dbcd6a5","Payment") ?? "Payment")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_376b722115b602","Cleared") ?? "Cleared")}</th><th></th></tr></thead><tbody>${uncleared.map((payment) => reconcileRowHtml(payment, false)).join('')}</tbody></table></div>` : `<div class="fn-empty"><i class="fas fa-check-double"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_48c87e92d9d697","Everything is reconciled") ?? "Everything is reconciled")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_5d9f37d6b39f0b","New settled payments will appear here until they are confirmed at the bank.") ?? "New settled payments will appear here until they are confirmed at the bank.")}</span></div>`)}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_d82b01c94f9f33","Recently cleared") ?? "Recently cleared")}</h2><p>${((v7,v8,v9) => globalThis.PlatformLanguage?.htmlText("financials","m_4244cf5c731306",`${v7} confirmed · ${v8} in · ${v9} out`,{v7,v8,v9}) ?? `${v7} confirmed · ${v8} in · ${v9} out`)(number(totals.cleared_count),money(totals.cleared_inbound_cents),money(totals.cleared_outbound_cents))}</p></div></div>
          ${String(cleared.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_2a0b11100c22a4","Date") ?? "Date")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_d0f1699dbcd6a5","Payment") ?? "Payment")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_376b722115b602","Cleared") ?? "Cleared")}</th><th></th></tr></thead><tbody>${cleared.slice(0, 25).map((payment) => reconcileRowHtml(payment, true)).join('')}</tbody></table></div>` : `<div class="fn-empty compact"><i class="fas fa-building-columns"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_235f562209bebd","Nothing cleared yet") ?? "Nothing cleared yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_ee8402a52321c5","Payments you confirm will collect here.") ?? "Payments you confirm will collect here.")}</span></div>`)}
        </section>`;
    }

    // --- Payouts view (merchant processing read models) ---------------------

    const PAYOUT_FILTERS = ['all', 'created', 'pended', 'held', 'completed', 'failed', 'returned'];

    function payoutBadge(status){
      const value = clean(status).toLowerCase() || 'created';
      const cls = value === 'completed' ? 'good'
        : ['failed', 'returned', 'cancelled'].includes(value) ? 'bad'
          : value === 'held' ? 'warn'
            : 'info';
      return `<span class="fn-badge ${cls}">${esc(value.replace(/_/g, ' '))}</span>`;
    }

    function disputeBadge(status){
      const value = clean(status).toLowerCase() || 'created';
      const cls = ['won', 'closed'].includes(value) ? 'good'
        : ['accepted', 'lost'].includes(value) ? 'bad'
          : ['contested', 'pre_arbitration', 'under_review'].includes(value) ? 'info'
            : 'warn';
      return `<span class="fn-badge ${cls}">${esc(value.replace(/_/g, ' '))}</span>`;
    }

    function payoutRowHtml(payout){
      const transactionCount = array(payout.transaction_ids).length || array(payout.provider_payment_ids).length;
      const arrived = clean(payout.arrived_at);
      return `<tr data-fn-payout="${esc(payout.id)}" tabindex="0">
        <td><div class="fn-payout-id"><strong>${esc(clean(payout.provider_payout_id) || clean(payout.id))}</strong><span>${esc(dateLabel(payout.created_at))}</span></div></td>
        <td>${payoutBadge(payout.status)}</td>
        <td class="fn-right"><strong>${moneyFine(payout.amount_cents)}</strong></td>
        <td class="fn-right">${moneyFine(payout.fee_cents)}</td>
        <td>${clean(payout.expected_arrival_at) ? esc(dateLabel(payout.expected_arrival_at)) : '<span class="fn-muted">—</span>'}</td>
        <td>${arrived ? esc(dateLabel(arrived)) : `<span class="fn-muted">${(globalThis.PlatformLanguage?.htmlText("financials","m_8e048627901567","Not arrived") ?? "Not arrived")}</span>`}</td>
        <td class="fn-right">${transactionCount}</td>
      </tr>`;
    }

    function payoutDetailModalHtml(){
      const detail = state.payoutDetail;
      if (!detail) return '';
      const payout = object(detail.payout);
      const transactions = array(detail.transactions);
      const body = detail.loading
        ? `<div class="fn-empty compact"><i class="fas fa-circle-notch fn-spin"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_abe6a9e399dd32","Loading payout") ?? "Loading payout")}</strong></div>`
        : detail.error
          ? `<div class="fn-empty compact"><i class="fas fa-triangle-exclamation"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_ec28130f32485c","Payout could not load") ?? "Payout could not load")}</strong><span>${String(esc(detail.error?.message || clean(detail.error) || 'Unknown error'))}</span></div>`
          : `<div class="fn-modal-stats">
              <div class="fn-modal-stat"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_c87aa4a42612df","Amount to bank") ?? "Amount to bank")}</span><strong>${String(moneyFine(payout.amount_cents))}</strong></div>
              <div class="fn-modal-stat"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_fcc3723f722f18","Processing fees") ?? "Processing fees")}</span><strong>${String(moneyFine(payout.fee_cents))}</strong></div>
              <div class="fn-modal-stat"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_c6aef2a3790870","Expected arrival") ?? "Expected arrival")}</span><strong>${String(clean(payout.expected_arrival_at) ? esc(dateLabel(payout.expected_arrival_at)) : '—')}</strong></div>
              <div class="fn-modal-stat"><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_b7ee7c97c74f9b","Arrived") ?? "Arrived")}</span><strong>${String(clean(payout.arrived_at) ? esc(dateLabel(payout.arrived_at)) : 'Not yet')}</strong></div>
            </div>
            ${String(transactions.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_2a0b11100c22a4","Date") ?? "Date")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_1d5ea39cc421fc","Invoice") ?? "Invoice")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_bd8c29e4635878","Gross") ?? "Gross")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_6f891fbf3f7955","Fee") ?? "Fee")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_8870b67246b7d9","Net") ?? "Net")}</th></tr></thead><tbody>${transactions.map((transaction) => {
              const gross = number(transaction.amount_cents);
              const fee = number(transaction.fee_cents);
              const net = Number.isFinite(Number(transaction.merchant_amount_cents)) && clean(transaction.merchant_amount_cents) !== '' ? number(transaction.merchant_amount_cents) : gross - fee;
              const projectId = clean(transaction.project_id);
              const invoiceId = clean(transaction.invoice_id);
              return `<tr>
                <td>${esc(dateLabel(transaction.received_at || transaction.created_at, { year:false }))}</td>
                <td>${projectId ? `<button type="button" class="fn-link" data-fn-open-project="${esc(projectId)}">${esc(clean(transaction.project_title) || projectId)}</button>` : `<span class="fn-muted">${(globalThis.PlatformLanguage?.htmlText("financials","m_500872d3c049f6","Company") ?? "Company")}</span>`}</td>
                <td>${invoiceId ? `<button type="button" class="fn-link" data-fn-open-invoice="${esc(invoiceId)}">${esc(invoiceId)}</button>` : '<span class="fn-muted">—</span>'}</td>
                <td class="fn-right">${moneyFine(gross)}</td>
                <td class="fn-right">${moneyFine(fee)}</td>
                <td class="fn-right"><strong>${moneyFine(net)}</strong></td>
              </tr>`;
            }).join('')}</tbody></table></div>` : `<div class="fn-empty compact"><i class="fas fa-receipt"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_45a12095bc0b48","No member transactions") ?? "No member transactions")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_5dab4fe427ad02","This payout has no linked payment records.") ?? "This payout has no linked payment records.")}</span></div>`)}`;
      return `<div class="fn-shade" data-fn-payout-shade><div class="fn-modal" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_335102d80b2040","Payout detail") ?? "Payout detail")}">
        <div class="fn-modal-head"><div><strong>${((v0) => globalThis.PlatformLanguage?.htmlText("financials","m_c32410e74d6868",`Payout ${v0}`,{v0}) ?? `Payout ${v0}`)(esc(clean(payout.provider_payout_id) || clean(detail.payoutId)))}</strong><span class="fn-modal-sub">${String(detail.loading ? 'Loading…' : `${array(detail.transactions).length} transaction${array(detail.transactions).length === 1 ? '' : 's'} · ${esc(clean(payout.currency) || 'USD')}`)}</span></div>
        <div style="display:flex;align-items:center;gap:10px">${String(detail.loading ? '' : payoutBadge(payout.status))}<button type="button" data-fn-close-payout aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_43963f1b979b52","Close payout detail") ?? "Close payout detail")}"><i class="fas fa-xmark"></i></button></div></div>
        <div class="fn-modal-body">${String(body)}</div>
      </div></div>`;
    }

    function payoutsHtml(){
      const summary = object(state.data?.summary);
      const payouts = array(state.data?.payouts);
      const disputes = array(state.data?.disputes);
      const nextPayout = object(summary.next_expected_payout);
      const openDisputes = number(summary.disputes_open_count);
      const effectiveRate = number(summary.effective_rate_bps) / 100;
      const filtered = state.payoutFilter === 'all'
        ? payouts
        : payouts.filter((payout) => clean(payout.status).toLowerCase() === state.payoutFilter);
      const countFor = (key) => key === 'all' ? payouts.length : payouts.filter((payout) => clean(payout.status).toLowerCase() === key).length;
      return `<section class="fn-metrics payouts">
          <div class="fn-metric" data-fn-tile="balance_pending"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_4044a709c2c433","Pending sweep ") ?? "Pending sweep ")}<i class="fas fa-wallet"></i></span><strong>${String(moneyFine(summary.balance_pending_cents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_3f21d8055c5d00","Captured payments awaiting the next batch") ?? "Captured payments awaiting the next batch")}</small></div>
          <div class="fn-metric" data-fn-tile="in_transit"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_9ff03ce19be18f","In transit ") ?? "In transit ")}<i class="fas fa-building-columns"></i></span><strong class="fn-available">${String(moneyFine(summary.in_transit_cents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_bbe4da53a62b2d","Batched and on the way to your bank") ?? "Batched and on the way to your bank")}</small></div>
          <div class="fn-metric" data-fn-tile="paid_out_30d"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_a22666a4be492d","Paid out (30d) ") ?? "Paid out (30d) ")}<i class="fas fa-circle-check"></i></span><strong class="fn-positive">${String(moneyFine(summary.paid_out_30d_cents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_799e9b77e1dc9a","Arrived at the bank in the last 30 days") ?? "Arrived at the bank in the last 30 days")}</small></div>
          <div class="fn-metric" data-fn-tile="fees_30d"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_ceabd802db7bfd","Fees (30d) ") ?? "Fees (30d) ")}<i class="fas fa-percent"></i></span><strong class="${String(number(summary.fees_30d_cents) ? 'fn-negative' : '')}">${String(moneyFine(summary.fees_30d_cents))}</strong><small>${String(number(summary.gross_30d_cents) ? `Effective rate ${effectiveRate.toFixed(2)}% on ${moneyFine(summary.gross_30d_cents)}` : 'No processed volume yet')}</small></div>
          <div class="fn-metric" data-fn-tile="next_payout"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_e3ec213ac69265","Next payout ") ?? "Next payout ")}<i class="fas fa-calendar-day"></i></span><strong class="fn-expected">${String(clean(nextPayout.payout_id) ? moneyFine(nextPayout.amount_cents) : '—')}</strong><small>${String(clean(nextPayout.payout_id) ? (clean(nextPayout.expected_arrival_at) ? `Expected ${esc(dateLabel(nextPayout.expected_arrival_at))}` : 'Arrival date pending') : 'No payout scheduled')}</small></div>
          <div class="fn-metric" data-fn-tile="open_disputes"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_b7febf91468fd6","Open disputes ") ?? "Open disputes ")}<i class="fas fa-scale-balanced"></i></span><strong class="${String(openDisputes ? 'fn-negative' : '')}">${String(openDisputes)}</strong><small>${String(openDisputes ? 'Respond before the deadline to contest' : 'No open chargebacks')}</small></div>
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_e06874e8b912d9","Payouts") ?? "Payouts")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("financials","m_2e930010f0998a","Batches swept from your processing balance to the bank, newest first.") ?? "Batches swept from your processing balance to the bank, newest first.")}</p></div><div class="fn-chips" role="group" aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_5bcdc053c26110","Payout status filter") ?? "Payout status filter")}">${String(PAYOUT_FILTERS.map((key) => `<button type="button" class="fn-chip ${state.payoutFilter === key ? 'active' : ''}" data-fn-payout-filter="${esc(key)}">${key === 'all' ? 'All' : esc(key)}<small>${countFor(key)}</small></button>`).join(''))}</div></div>
          ${String(filtered.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_47196f1d949c20","Payout") ?? "Payout")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_1352cafa75b8da","Status") ?? "Status")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_6c208c0cd6af0f","Fees") ?? "Fees")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_c6aef2a3790870","Expected arrival") ?? "Expected arrival")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_b7ee7c97c74f9b","Arrived") ?? "Arrived")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_ad68f8741d9002","Transactions") ?? "Transactions")}</th></tr></thead><tbody>${filtered.map(payoutRowHtml).join('')}</tbody></table></div>`
          : payouts.length ? `<div class="fn-empty"><i class="fas fa-filter"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_f380e9e06ef4c2","No payouts match this filter") ?? "No payouts match this filter")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_b759a25796c125","Try another status.") ?? "Try another status.")}</span></div>`
          : `<div class="fn-empty"><i class="fas fa-money-bill-transfer"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_7d3d62ef16a1b9","No payouts yet") ?? "No payouts yet")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_ecc1491e849fb1","Payouts will appear once payment processing is live.") ?? "Payouts will appear once payment processing is live.")}</span></div>`)}
        </section>
        <section class="fn-card"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_9b7a2edd995dfe","Disputes") ?? "Disputes")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("financials","m_96113a4810ac77","Chargebacks and payment disputes reported by the processor.") ?? "Chargebacks and payment disputes reported by the processor.")}</p></div><span class="fn-count">${String(disputes.length)}</span></div>
          ${String(disputes.length ? `<div class="fn-table-wrap"><table class="fn-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_1352cafa75b8da","Status") ?? "Status")}</th><th class="fn-right">${(globalThis.PlatformLanguage?.htmlText("financials","m_2b8c3448fa87a1","Amount") ?? "Amount")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_6480ed19528b5a","Reason") ?? "Reason")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_9212d954ad54f9","Opened") ?? "Opened")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_d0f1699dbcd6a5","Payment") ?? "Payment")}</th><th>${(globalThis.PlatformLanguage?.htmlText("financials","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th></th></tr></thead><tbody>${disputes.map((dispute) => {
            const projectId = clean(dispute.project_id);
            const closed = ['won', 'lost', 'closed', 'accepted'].includes(clean(dispute.status).toLowerCase());
            return `<tr data-fn-dispute="${esc(dispute.id)}">
              <td>${disputeBadge(dispute.status)}</td>
              <td class="fn-right"><strong>${moneyFine(dispute.amount_cents)}</strong></td>
              <td>${esc(clean(dispute.reason).replace(/_/g, ' ') || '—')}</td>
              <td>${esc(dateLabel(dispute.opened_at || dispute.created_at))}</td>
              <td>${clean(dispute.transaction_id) ? `<span class="fn-muted">${esc(clean(dispute.transaction_id))}</span>` : '<span class="fn-muted">—</span>'}</td>
              <td>${projectId ? `<button type="button" class="fn-link" data-fn-open-project="${esc(projectId)}">${esc(projectId)}</button>` : '<span class="fn-muted">—</span>'}</td>
              <td class="fn-right">${closed ? '<span class="fn-muted">—</span>' : `<button type="button" class="fn-chip" data-fn-dispute-respond="${esc(dispute.id)}" title="${(globalThis.PlatformLanguage?.htmlText("financials","m_c6cab8e36e851b","Dispute evidence is submitted on the processor's secure merchant portal") ?? "Dispute evidence is submitted on the processor's secure merchant portal")}"><i class="fas fa-arrow-up-right-from-square"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_63c93dd0696f86"," Respond at Forward") ?? " Respond at Forward")}</button>`}</td>
            </tr>`;
          }).join('')}</tbody></table></div>` : `<div class="fn-empty compact"><i class="fas fa-scale-balanced"></i><strong>${(globalThis.PlatformLanguage?.htmlText("financials","m_215c03ede9f243","No disputes") ?? "No disputes")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("financials","m_74fdbdbe1b1c64","Chargebacks reported by the processor will appear here.") ?? "Chargebacks reported by the processor will appear here.")}</span></div>`)}
        </section>${String(payoutDetailModalHtml())}`;
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
      const width = 1080;
      const height = 360;
      const pad = { left:76, right:24, top:20, bottom:40 };
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
      const xEvery = Math.max(1, Math.ceil(series.length / 8));
      const nodes = (key, cssClass, eventsForDay, exposure = false) => series.map((item, index) => {
        const related = exposure ? item.safeExposureTransactions : eventsForDay(item);
        return `<circle class="fn-node ${cssClass}" tabindex="0" data-fn-node="${index}" data-fn-line="${key}" data-fn-transaction-ids="${esc(transactionIds(related))}" cx="${x(index)}" cy="${y(item[key])}" r="4"><title>${esc(dateLabel(item.date))}: ${esc(key.replace(/_/g, ' '))} ${money(item[key])}</title></circle>`;
      }).join('');
      return ("<svg class=\"fn-chart\" viewBox=\"0 0 " + String(width) + " " + String(height) + "\" role=\"img\" aria-label=\"" + ((v2) => globalThis.PlatformLanguage?.text("financials","m_e39427244e8681",`Available, expected, and safe-to-spend cash for ${v2}`,{v2}) ?? `Available, expected, and safe-to-spend cash for ${v2}`)(esc(rangeTitle(state.grain, range()))) + "\">\n        " + String(ticks.map((tick) => `<line class="fn-grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(tick)}" y2="${y(tick)}"></line><text class="fn-axis-label" x="${pad.left - 10}" y="${y(tick) + 3}" text-anchor="end">${esc(money(tick, true))}</text>`).join('')) + "\n        " + String(min < 0 && max > 0 ? `<line class="fn-zero-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}"></line>` : '') + "\n        <path class=\"fn-line available\" d=\"" + String(path('available')) + "\"></path><path class=\"fn-line expected\" d=\"" + String(path('expected')) + "\"></path><path class=\"fn-line safe\" d=\"" + String(path('safe')) + "\"></path>\n        " + String(nodes('available', 'available', (item) => item.availableEvents)) + String(nodes('expected', 'expected', (item) => item.expectedEvents)) + String(nodes('safe', 'safe', () => [], true)) + "\n        " + String(series.map((item, index) => index % xEvery === 0 || index === series.length - 1 ? `<text class="fn-axis-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${esc(item.date.toLocaleDateString(undefined, { month:'short', day:'numeric' }))}</text>` : '').join('')) + "\n      </svg>");
    }

    function transactionRailHtml(transactions, selectedRange){
      const visible = transactions;
      return `<aside class="fn-card fn-transaction-rail"><div class="fn-card-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("financials","m_ad68f8741d9002","Transactions") ?? "Transactions")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("financials","m_bc494668697e73","Cleared, expected, and reserved movement.") ?? "Cleared, expected, and reserved movement.")}</p></div><span class="fn-count">${String(number(state.data?.transactionCount || visible.length))}</span></div><div class="fn-transaction-list">${String(visible.length ? visible.map((item) => {
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
        <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_0f5102aad156d3","Available cash ") ?? "Available cash ")}<i class="fas fa-building-columns"></i></span><strong class="fn-available">${String(money(end.available))}</strong><small>${((v1) => globalThis.PlatformLanguage?.htmlText("financials","m_bba8f2c0880969",`Cleared cash${v1}`,{v1}) ?? `Cleared cash${v1}`)(state.openingBalance ? ' plus opening balance' : ' · net movement from zero')}</small></div>
        <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_07d652ce236d27","Expected available ") ?? "Expected available ")}<i class="fas fa-chart-line"></i></span><strong class="fn-expected">${String(money(end.expected))}</strong><small>${((v3,v4) => globalThis.PlatformLanguage?.htmlText("financials","m_41cf05cf456858",`${v3} in · ${v4} out this period`,{v3,v4}) ?? `${v3} in · ${v4} out this period`)(money(expectedIn, true),money(expectedOut, true))}</small></div>
        <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_a2f15a2d87d4e3","Safe to spend ") ?? "Safe to spend ")}<i class="fas fa-shield-heart"></i></span><strong class="${String(end.safe >= 0 ? 'fn-positive' : 'fn-negative')}">${String(money(end.safe))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_0ba2b05af9d11a","Expected cash less unpaid commitments") ?? "Expected cash less unpaid commitments")}</small></div>
        <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_17c29efbe23853","Pending incoming ") ?? "Pending incoming ")}<i class="fas fa-hourglass-half"></i></span><strong>${String(money(end.pendingIncomingCents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_b411f5963a3d0f","Collected but not yet available") ?? "Collected but not yet available")}</small></div>
        <div class="fn-metric"><span class="fn-metric-label">${(globalThis.PlatformLanguage?.htmlText("financials","m_067e43c05b2612","Undated exposure ") ?? "Undated exposure ")}<i class="fas fa-calendar-xmark"></i></span><strong class="${String(end.undatedExposureCents ? 'fn-negative' : '')}">${String(money(end.undatedExposureCents))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("financials","m_7fb2c0748a593b","Reserved without a clearing date") ?? "Reserved without a clearing date")}</small></div>
      </section>
      <div class="fn-cash-workspace">${String(transactionRailHtml(transactions, selectedRange))}<section class="fn-card fn-chart-card"><div class="fn-card-head fn-cash-chart-head"><div><h2>${String(state.openingBalance ? 'Forecast cash position' : 'Net cash movement')}</h2><p>${(globalThis.PlatformLanguage?.htmlText("financials","m_47fe2d7add39b4","Hover a line node or transaction to trace its effect. Safe to spend reserves future and undated outgoing commitments.") ?? "Hover a line node or transaction to trace its effect. Safe to spend reserves future and undated outgoing commitments.")}</p></div><div class="fn-chart-head-actions"><div class="fn-legend"><span><i style="background:#2e90fa"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_f326bdcd77881a","Available") ?? "Available")}</span><span><i style="background:#7f56d9"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_ad21d839382e4a","Expected available") ?? "Expected available")}</span><span><i style="background:#12b76a"></i>${(globalThis.PlatformLanguage?.htmlText("financials","m_e4218fdc8067e4","Safe to spend") ?? "Safe to spend")}</span></div><div class="fn-cash-settings"><label class="fn-clearing">${(globalThis.PlatformLanguage?.htmlText("financials","m_d2583a98d76017","Opening $") ?? "Opening $")}<input type="number" step="0.01" value="${String((state.openingBalance / 100).toFixed(2))}" data-fn-opening-balance aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_7ccaf7f30436e3","Opening cash balance in dollars") ?? "Opening cash balance in dollars")}"></label><label class="fn-clearing">${(globalThis.PlatformLanguage?.htmlText("financials","m_bae1f3af80c464","Clearing ") ?? "Clearing ")}<input type="number" min="0" max="336" step="1" value="${String(state.clearingHours)}" data-fn-clearing aria-label="${(globalThis.PlatformLanguage?.htmlText("financials","m_4e589dfcef5c24","Customer payment clearing time in hours") ?? "Customer payment clearing time in hours")}">${(globalThis.PlatformLanguage?.htmlText("financials","m_f9b04bf72b9b3a"," hours") ?? " hours")}</label></div></div></div><div class="fn-chart-wrap">${String(chartHtml(series))}</div></section><div class="fn-tooltip" data-fn-tooltip role="tooltip"></div><div class="fn-tx-popover" data-fn-transaction-tooltip role="tooltip"></div></div>`;
    }

    function render(){
      if (state.destroyed) return;
      if (!state.data && (state.loading || state.error)) { renderState(); bind(); return; }
      const transactions = modelTransactions();
      root.innerHTML = `<div class="fn-shell">${headerHtml()}${state.view === 'cashflow' ? cashflowHtml(transactions) : state.view === 'reconcile' ? reconcileHtml() : state.view === 'payouts' ? payoutsHtml() : profitabilityHtml()}</div></div>`;
      bind();
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
      highlightTransactions(related.map((transaction) => transaction.id), { reveal:true });
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
      window.Portal?.navigation?.push?.({ tab:'financials', project:projectId, projectTab:'money' }, { source:'financial-project-money', ownedKeys:['project','projectTab'] });
    }

    function openInvoice(invoiceId){
      if (!invoiceId || window.Portal?.navigation?.applying) return;
      window.Portal?.navigation?.push?.({ tab:'invoices', invoice:invoiceId }, { source:'financials-payout-invoice', ownedKeys:['invoice'] });
    }

    function openPayoutDetail(payoutId){
      if (!payoutId) return;
      state.payoutDetail = { payoutId, loading:true, payout:null, transactions:[], error:null };
      render();
      Promise.resolve(window.PaymentsAPI?.payouts?.get?.(state.orgId, payoutId))
        .then((result) => {
          if (state.destroyed || state.payoutDetail?.payoutId !== payoutId) return;
          state.payoutDetail = { payoutId, loading:false, payout:object(result?.payout), transactions:array(result?.transactions), error:null };
          render();
        })
        .catch((error) => {
          if (state.destroyed || state.payoutDetail?.payoutId !== payoutId) return;
          state.payoutDetail = { payoutId, loading:false, payout:null, transactions:[], error };
          render();
        });
    }

    function closePayoutDetail(){
      if (!state.payoutDetail) return;
      state.payoutDetail = null;
      render();
    }

    function bind(){
      root.querySelector('[data-fn-action="refresh"]')?.addEventListener('click', () => load());
      root.querySelectorAll('[data-fn-view]').forEach((button) => button.addEventListener('click', () => {
        const view = normalizeView(button.dataset.fnView);
        if (view === state.view) return;
        state.view = view;
        state.payoutDetail = null;
        routePatch({ financialView:view }, 'push');
        state.data = null;
        load();
      }));
      root.querySelectorAll('[data-fn-payout-filter]').forEach((button) => button.addEventListener('click', () => {
        const filter = clean(button.dataset.fnPayoutFilter);
        if (!PAYOUT_FILTERS.includes(filter) || filter === state.payoutFilter) return;
        state.payoutFilter = filter;
        render();
      }));
      root.querySelectorAll('tr[data-fn-payout]').forEach((row) => {
        row.addEventListener('click', () => openPayoutDetail(row.dataset.fnPayout));
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPayoutDetail(row.dataset.fnPayout); } });
      });
      root.querySelector('[data-fn-close-payout]')?.addEventListener('click', closePayoutDetail);
      root.querySelector('[data-fn-payout-shade]')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closePayoutDetail(); });
      root.querySelectorAll('[data-fn-open-invoice]').forEach((button) => {
        button.addEventListener('click', (event) => { event.stopPropagation(); openInvoice(button.dataset.fnOpenInvoice); });
      });
      root.querySelectorAll('[data-fn-grain]').forEach((button) => button.addEventListener('click', () => {
        const grain = button.dataset.fnGrain;
        if (!['day','week','month'].includes(grain) || grain === state.grain) return;
        state.grain = grain;
        routePatch({ financialGrain:grain, financialDate:dateKey(state.anchor) });
        load({ silent:true });
      }));
      root.querySelector('[data-fn-action="previous"]')?.addEventListener('click', () => { state.anchor = shiftAnchor(state.grain, state.anchor, -1); routePatch({ financialDate:dateKey(state.anchor) }); load({ silent:true }); });
      root.querySelector('[data-fn-action="next"]')?.addEventListener('click', () => { state.anchor = shiftAnchor(state.grain, state.anchor, 1); routePatch({ financialDate:dateKey(state.anchor) }); load({ silent:true }); });
      root.querySelector('[data-fn-action="today"]')?.addEventListener('click', () => { state.anchor = dayStart(new Date()); routePatch({ financialDate:dateKey(state.anchor) }); load({ silent:true }); });
      root.querySelector('[data-fn-action="load-more"]')?.addEventListener('click', () => load({ append:true, silent:true }));
      root.querySelector('[data-fn-clearing]')?.addEventListener('change', (event) => {
        state.clearingHours = Math.max(0, Math.min(336, number(event.target.value)));
        try { window.localStorage?.setItem?.('fm:financial:clearing-hours', String(state.clearingHours)); } catch (_) {}
        load({ silent:true });
      });
      root.querySelector('[data-fn-opening-balance]')?.addEventListener('change', (event) => {
        const dollars = Number(String(event.target.value || '').replace(/[^0-9.-]/g, ''));
        state.openingBalance = Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
        try { window.localStorage?.setItem?.('fm:financial:opening-balance-cents', String(state.openingBalance)); } catch (_) {}
        load({ silent:true });
      });
      root.querySelectorAll('[data-project-id]').forEach((row) => {
        row.addEventListener('click', () => openProject(row.dataset.projectId));
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProject(row.dataset.projectId); } });
      });
      root.querySelectorAll('[data-fn-open-project]').forEach((button) => {
        button.addEventListener('click', (event) => { event.stopPropagation(); openProject(button.dataset.fnOpenProject); });
      });
      // Dispute responses are portal-only on the processor's side: mint a
      // single-use magic-link into Forward's merchant portal and open it in a
      // new tab (the evidence workflow lives there; webhooks update our rows).
      root.querySelectorAll('[data-fn-dispute-respond]').forEach((button) => {
        button.addEventListener('click', async (event) => {
          event.stopPropagation();
          button.disabled = true;
          const original = button.innerHTML;
          button.innerHTML = '<i class="fas fa-circle-notch fn-spin"></i> Opening...';
          try {
            const result = await window.PaymentsAPI.merchantPortal.loginUrl(state.orgId);
            const url = clean(result?.login_url);
            if (!url) throw new Error('No portal login link was returned.');
            window.open(url, '_blank', 'noopener');
          } catch (error) {
            console.warn('[financials] merchant portal login failed', error?.message || error);
          }
          button.innerHTML = original;
          button.disabled = false;
        });
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
      root.querySelectorAll('[data-fn-transaction]').forEach((row) => {
        const transaction = byId.get(row.dataset.fnTransaction);
        row.addEventListener('mouseenter', () => showTransactionDetail(row, transaction));
        row.addEventListener('mouseleave', hideTransactionDetail);
        row.addEventListener('focus', () => showTransactionDetail(row, transaction));
        row.addEventListener('blur', hideTransactionDetail);
        row.addEventListener('click', () => { if (transaction?.projectId) openProject(transaction.projectId); });
      });
    }

    async function load(options = {}){
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
          clearing_hours:state.clearingHours, opening_balance_cents:state.openingBalance
        };
        if (state.view === 'reconcile') {
          if (!window.PaymentsAPI?.payments?.reconciliation) throw new Error('The Payments API is unavailable.');
          const result = await window.PaymentsAPI.payments.reconciliation(state.orgId);
          if (state.destroyed || token !== state.loadToken) return;
          state.data = {
            kind:'reconcile',
            totals:object(result.totals),
            uncleared:array(result.uncleared),
            cleared:array(result.cleared)
          };
          state.loadedAt = Date.now();
          return;
        }
        if (state.view === 'payouts') {
          if (!window.PaymentsAPI?.finance?.summary) throw new Error('The Payments API is unavailable.');
          const [summaryResult, payoutsResult, disputesResult] = await Promise.all([
            window.PaymentsAPI.finance.summary(state.orgId),
            window.PaymentsAPI.payouts.list(state.orgId),
            window.PaymentsAPI.disputes.list(state.orgId)
          ]);
          if (state.destroyed || token !== state.loadToken) return;
          state.data = {
            kind:'payouts',
            summary:object(summaryResult.summary),
            payouts:array(payoutsResult.payouts),
            disputes:array(disputesResult.disputes)
          };
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
        if (nextRoute.tab !== 'financials') return;
        const nextView = normalizeView(nextRoute.financialView);
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
    refreshEvents.forEach((name) => window.addEventListener(name, scheduleRefresh));
    // Capabilities can resolve after mount; re-normalize the requested view so
    // a direct link to the Payouts view survives the async capability load,
    // and re-render so the tab button appears/disappears.
    const onCapabilitiesUpdated = () => {
      if (state.destroyed) return;
      const wanted = normalizeView((window.Portal?.navigation?.read?.() || {}).financialView);
      if (wanted !== state.view) { state.view = wanted; state.data = null; load(); return; }
      if (state.data) render();
    };
    window.addEventListener('fm:capabilities:updated', onCapabilitiesUpdated);
    load();

    return {
      destroy(){ state.destroyed = true; state.loadToken++; unregisterRoute?.(); refreshEvents.forEach((name) => window.removeEventListener(name, scheduleRefresh)); window.removeEventListener('fm:capabilities:updated', onCapabilitiesUpdated); root.innerHTML = ''; },
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
    access:{ applicationsAny:['management'], permissionsAny:['manage_projects','manage_payroll','manage_company_settings'] },
    mount:createApp
  });
})();
