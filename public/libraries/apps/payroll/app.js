/* public/libraries/apps/payroll/app.js
 * Global payroll workspace for schedule previews, batches, and payment history.
 */
(function(){
  'use strict';

  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerApp) return;

  const DAY_MS = 86400000;
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SUBGROUPS = ['hourly', 'salary', 'piece_rate', 'commission', 'adjustment', 'clawback'];
  const SUBGROUP_LABELS = {
    hourly:'Hourly', salary:'Salary', piece_rate:'Piece rate', commission:'Commission',
    adjustment:'Adjustment', clawback:'Clawback', other:'Other'
  };

  const clean = (value) => String(value ?? '').trim();
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const array = (value) => Array.isArray(value) ? value : [];
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

  function esc(value){
    return clean(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function dateKey(value = new Date()){
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function addDaysKey(value, days){
    const date = new Date(`${clean(value)}T12:00:00`);
    date.setDate(date.getDate() + Number(days || 0));
    return dateKey(date);
  }

  function formatDate(value, options = {}){
    const raw = clean(value);
    if (!raw) return '—';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T12:00:00`) : new Date(raw);
    if (!Number.isFinite(date.getTime())) return raw;
    return new Intl.DateTimeFormat(undefined, {
      month:options.short === false ? 'long' : 'short',
      day:'numeric',
      ...(options.year === false ? {} : { year:'numeric' })
    }).format(date);
  }

  function formatDateTime(value){
    const date = new Date(clean(value));
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }).format(date);
  }

  function formatMoney(cents, currency = 'USD', options = {}){
    try {
      return new Intl.NumberFormat(undefined, {
        style:'currency', currency:clean(currency || 'USD').toUpperCase(),
        minimumFractionDigits:options.compact ? 0 : 2,
        maximumFractionDigits:options.compact ? 0 : 2
      }).format(number(cents) / 100);
    } catch (_) {
      return `${(number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 })} ${clean(currency || 'USD')}`;
    }
  }

  function formatDuration(secondsValue){
    const total = Math.max(0, Math.round(number(secondsValue)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }

  function recurrenceLabel(schedule){
    const recurrence = object(schedule?.recurrence);
    const frequency = clean(recurrence.frequency);
    if (frequency === 'weekly') return `Every ${WEEKDAYS[number(recurrence.weekday)] || 'week'}`;
    if (frequency === 'biweekly') return `Every other ${WEEKDAYS[number(recurrence.weekday)] || 'week'}`;
    if (frequency === 'semi_monthly') return `Twice monthly · ${array(recurrence.days).map((day) => ordinal(day)).join(' & ')}`;
    if (frequency === 'monthly') return `Monthly · ${ordinal(recurrence.day)}`;
    return frequency ? frequency.replace(/_/g, ' ') : 'Custom schedule';
  }

  function ordinal(value){
    const n = Math.max(1, Math.round(number(value)));
    const mod100 = n % 100;
    const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1:'st', 2:'nd', 3:'rd' }[n % 10] || 'th');
    return `${n}${suffix}`;
  }

  function delayLabel(schedule){
    const delay = object(schedule?.delay);
    const parts = [];
    if (number(delay.periods)) parts.push(`${number(delay.periods)} pay period${number(delay.periods) === 1 ? '' : 's'}`);
    if (number(delay.days)) parts.push(`${number(delay.days)} day${number(delay.days) === 1 ? '' : 's'}`);
    return parts.length ? `${parts.join(' + ')} delay` : 'No payroll delay';
  }

  function statusLabel(status){
    const value = clean(status || 'draft').toLowerCase();
    return value === 'run' ? 'Run' : value === 'paid' ? 'Paid' : value === 'partial' ? 'Partially run' : value === 'void' ? 'Void' : 'Draft';
  }

  function statusBadge(status, options = {}){
    const value = clean(status || 'draft').toLowerCase();
    const icon = value === 'paid' ? 'fa-circle-check' : value === 'run' ? 'fa-play' : value === 'partial' ? 'fa-circle-half-stroke' : value === 'void' ? 'fa-ban' : 'fa-pen';
    return `<span class="fmp-status ${esc(value)}${options.small ? ' small' : ''}"><i class="fas ${icon}"></i>${esc(statusLabel(value))}</span>`;
  }

  function initials(name){
    return clean(name).split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '—';
  }

  function occurrenceKey(occurrence){
    return `${clean(occurrence?.schedule?.id)}:${clean(occurrence?.pay_date)}`;
  }

  function payeeKey(payee){
    return `${clean(payee?.type)}:${clean(payee?.id)}`;
  }

  function injectCss(){
    if (document.getElementById('firstmate-payroll-app-css')) return;
    const style = document.createElement('style');
    style.id = 'firstmate-payroll-app-css';
    style.textContent = `
      .fmp-shell{height:100%;min-height:0;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#f6f7f9;color:#101828;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      .fmp-shell *{box-sizing:border-box}.fmp-shell button,.fmp-shell input{font:inherit}.fmp-shell button{appearance:none}
      .fmp-top{position:sticky;top:0;z-index:15;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 26px;background:rgba(255,255,255,.94);border-bottom:1px solid #e7e9ee;backdrop-filter:blur(14px)}
      .fmp-heading{display:flex;align-items:center;gap:13px;min-width:0}.fmp-heading-icon{width:42px;height:42px;border-radius:13px;display:grid;place-items:center;color:#fff;background:linear-gradient(135deg,#1d2939,#344054);box-shadow:0 8px 22px rgba(16,24,40,.18)}
      .fmp-heading-copy{min-width:0}.fmp-heading h1{margin:0;font-size:22px;line-height:1.15;letter-spacing:-.02em}.fmp-heading p{margin:4px 0 0;color:#667085;font-size:12px;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .fmp-top-actions,.fmp-segment,.fmp-range-presets,.fmp-card-actions,.fmp-item-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .fmp-btn{border:1px solid #d9dee7;border-radius:10px;background:#fff;color:#344054;padding:9px 12px;font-size:12px;font-weight:850;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;transition:.16s ease;white-space:nowrap}
      .fmp-btn:hover:not(:disabled){border-color:#aeb7c6;box-shadow:0 3px 10px rgba(16,24,40,.08);transform:translateY(-1px)}.fmp-btn:disabled{opacity:.45;cursor:not-allowed}.fmp-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 5px 14px rgba(var(--primary-rgb,217,48,37),.2)}.fmp-btn.primary:hover:not(:disabled){background:var(--primary-dark,var(--primary,#d93025));border-color:var(--primary-dark,var(--primary,#d93025));color:var(--on-primary,#fff)}.fmp-btn.dark{background:#1d2939;border-color:#1d2939;color:#fff}.fmp-btn.success{background:#067647;border-color:#067647;color:#fff}.fmp-btn.ghost{background:transparent;border-color:transparent;box-shadow:none}.fmp-btn.small{min-height:30px;padding:7px 9px;font-size:11px;border-radius:8px}
      .fmp-content{max-width:1500px;margin:0 auto;padding:22px 26px 40px}.fmp-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.fmp-segment{background:#e9ecf1;border-radius:11px;padding:4px}.fmp-segment button{border:0;background:transparent;color:#667085;padding:8px 13px;border-radius:8px;font-size:12px;font-weight:900;cursor:pointer}.fmp-segment button.active{background:#fff;color:#101828;box-shadow:0 2px 7px rgba(16,24,40,.1)}
      .fmp-range{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:15px 17px;margin-bottom:16px;box-shadow:0 2px 6px rgba(16,24,40,.03)}.fmp-range-fields{display:flex;align-items:flex-end;gap:9px;flex-wrap:wrap}.fmp-field{display:grid;gap:5px}.fmp-field label{font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.055em;color:#667085}.fmp-field input{height:38px;border:1px solid #d7dce5;border-radius:9px;padding:0 10px;background:#fff;color:#101828;font-size:12px;font-weight:750;outline:none}.fmp-field input:focus{border-color:#98a2b3;box-shadow:0 0 0 3px rgba(152,162,179,.15)}.fmp-range-arrow{height:38px;display:grid;place-items:center;color:#98a2b3}.fmp-preset{border:0;border-radius:999px;padding:7px 10px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:850;cursor:pointer}.fmp-preset:hover{background:#e4e7ec}.fmp-projection-toggle{border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:8px 11px;color:#475467;font-size:11px;font-weight:850;cursor:pointer;display:inline-flex;align-items:center;gap:7px}.fmp-projection-toggle.active{background:#f4f3ff;border-color:#c3b5fd;color:#5925dc}.fmp-toggle-dot{width:8px;height:8px;border-radius:50%;background:#98a2b3}.fmp-projection-toggle.active .fmp-toggle-dot{background:#7f56d9;box-shadow:0 0 0 3px #ebe9fe}
      .fmp-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:11px;margin-bottom:17px}.fmp-metric{min-width:0;background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:14px 15px;display:grid;gap:5px;box-shadow:0 2px 6px rgba(16,24,40,.025)}.fmp-metric .label{font-size:10px;font-weight:900;color:#667085;text-transform:uppercase;letter-spacing:.05em}.fmp-metric .value{font-size:20px;font-weight:950;letter-spacing:-.025em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-metric .detail{font-size:11px;color:#667085;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-metric.accrued{border-top:3px solid #12b76a}.fmp-metric.projected{border-top:3px solid #7f56d9}.fmp-metric.forecast{border-top:3px solid #f79009}
      .fmp-diagnostic{display:flex;align-items:flex-start;gap:10px;border:1px solid #fedf89;background:#fffaeb;color:#93370d;border-radius:12px;padding:11px 13px;margin-bottom:14px;font-size:12px;font-weight:750}.fmp-diagnostic i{margin-top:2px;color:#f79009}.fmp-list{display:grid;gap:14px}.fmp-schedule-card{background:#fff;border:1px solid #e4e7ec;border-radius:17px;overflow:hidden;box-shadow:0 3px 10px rgba(16,24,40,.035)}.fmp-schedule-card.next{border-color:#c7d7fe;box-shadow:0 7px 24px rgba(53,88,206,.08)}
      .fmp-schedule-head{display:grid;grid-template-columns:minmax(250px,1.15fr) minmax(360px,1fr) auto;align-items:center;gap:18px;padding:16px 18px;cursor:pointer}.fmp-schedule-title{display:flex;align-items:center;gap:12px;min-width:0}.fmp-date-tile{width:54px;height:56px;border:1px solid #dce2ea;border-radius:13px;background:#f8fafc;display:grid;place-items:center;align-content:center;flex:0 0 auto}.fmp-date-tile b{font-size:20px;line-height:1;color:#101828}.fmp-date-tile span{font-size:9px;font-weight:950;text-transform:uppercase;letter-spacing:.08em;color:#667085;margin-bottom:3px}.fmp-title-copy{min-width:0}.fmp-title-copy h2{font-size:16px;margin:0;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-title-copy p{font-size:11px;color:#667085;font-weight:750;margin:5px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-next-label{display:inline-flex;margin-left:7px;border-radius:999px;padding:3px 7px;background:#eef4ff;color:#3538cd;font-size:9px;font-weight:950;text-transform:uppercase;vertical-align:2px}.fmp-schedule-totals{display:grid;grid-template-columns:repeat(3,minmax(90px,1fr));gap:9px}.fmp-mini-total{min-width:0;border-left:1px solid #eaecf0;padding-left:12px}.fmp-mini-total span{display:block;color:#667085;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.045em}.fmp-mini-total b{display:block;margin-top:4px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-mini-total.projected b{color:#6941c6}.fmp-mini-total.forecast b{color:#b54708}.fmp-chevron{width:32px;height:32px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;color:#667085;display:grid;place-items:center}.fmp-schedule-card.open .fmp-chevron i{transform:rotate(180deg)}.fmp-chevron i{transition:.18s ease}
      .fmp-schedule-body{border-top:1px solid #eaecf0;background:#fbfcfe;padding:15px 17px 17px}.fmp-occurrence-meta{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:13px}.fmp-meta-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid #e4e7ec;border-radius:999px;background:#fff;color:#475467;padding:6px 9px;font-size:10px;font-weight:850}.fmp-meta-chip i{color:#98a2b3}.fmp-batch-banner{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #dce3ec;border-radius:12px;background:#fff;padding:11px 12px;margin-bottom:13px}.fmp-batch-copy{display:flex;align-items:center;gap:10px;min-width:0}.fmp-batch-copy strong{display:block;font-size:12px}.fmp-batch-copy small{display:block;color:#667085;font-size:10px;font-weight:750;margin-top:3px}.fmp-batch-none{color:#667085;font-size:11px;font-weight:750}.fmp-batch-none b{color:#344054}
      .fmp-worker-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.fmp-worker-section{min-width:0;border:1px solid #e4e7ec;border-radius:13px;background:#fff;overflow:hidden}.fmp-worker-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;background:#f8fafc;border-bottom:1px solid #eaecf0}.fmp-worker-head strong{font-size:12px}.fmp-worker-head span{font-size:10px;color:#667085;font-weight:850}.fmp-worker-head .icon{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:#eef4ff;color:#3538cd}.fmp-worker-head.contractor .icon{background:#fff4ed;color:#c4320a}.fmp-worker-head-copy{display:flex;align-items:center;gap:8px}.fmp-worker-list{display:grid}.fmp-worker-row{display:grid;grid-template-columns:minmax(145px,1fr) minmax(140px,1.1fr) auto;gap:10px;align-items:center;padding:11px 12px;border-bottom:1px solid #f0f2f5}.fmp-worker-row:last-child{border-bottom:0}.fmp-person{display:flex;align-items:center;gap:9px;min-width:0}.fmp-avatar{width:31px;height:31px;border-radius:10px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:10px;font-weight:950;flex:0 0 auto}.fmp-person-copy{min-width:0}.fmp-person strong{display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-person small{display:block;margin-top:3px;font-size:9px;color:#98a2b3;font-weight:750;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-subgroups{display:flex;gap:5px;flex-wrap:wrap}.fmp-subgroup{display:inline-flex;align-items:center;gap:4px;border:1px solid #dfe3e9;border-radius:999px;background:#f8fafc;color:#475467;padding:4px 6px;font-size:9px;font-weight:900;white-space:nowrap}.fmp-subgroup.commission{background:#f4f3ff;border-color:#d9d6fe;color:#5925dc}.fmp-subgroup.clawback{background:#fef3f2;border-color:#fecdca;color:#b42318}.fmp-subgroup.projected{border-style:dashed}.fmp-worker-money{text-align:right;min-width:110px}.fmp-worker-money b{display:block;font-size:12px}.fmp-worker-money small{display:block;color:#667085;font-size:9px;font-weight:750;margin-top:3px}.fmp-item-actions{justify-content:flex-end;margin-top:6px}.fmp-empty-section{padding:22px 12px;text-align:center;color:#98a2b3;font-size:11px;font-weight:800}.fmp-empty-section i{display:block;font-size:17px;margin-bottom:6px;color:#d0d5dd}
      .fmp-history{display:grid;gap:12px}.fmp-history-card{background:#fff;border:1px solid #e4e7ec;border-radius:15px;overflow:hidden}.fmp-history-head{display:grid;grid-template-columns:minmax(230px,1fr) repeat(3,minmax(110px,.55fr)) auto;gap:13px;align-items:center;padding:14px 16px;cursor:pointer}.fmp-history-title{display:flex;align-items:center;gap:11px;min-width:0}.fmp-history-title .icon{width:36px;height:36px;border-radius:11px;background:#f2f4f7;color:#475467;display:grid;place-items:center}.fmp-history-title strong{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-history-title small{display:block;color:#667085;font-size:10px;font-weight:750;margin-top:3px}.fmp-history-stat span{display:block;color:#98a2b3;font-size:9px;font-weight:900;text-transform:uppercase}.fmp-history-stat b{display:block;font-size:12px;margin-top:3px}.fmp-history-body{padding:0 15px 15px;border-top:1px solid #eaecf0}.fmp-history-table{width:100%;border-collapse:collapse}.fmp-history-table th{text-align:left;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.04em;padding:10px 8px;border-bottom:1px solid #eaecf0}.fmp-history-table td{padding:10px 8px;border-bottom:1px solid #f0f2f5;font-size:11px}.fmp-history-table tr:last-child td{border-bottom:0}.fmp-right{text-align:right!important}
      .fmp-state{min-height:430px;display:grid;place-items:center;align-content:center;text-align:center;padding:36px;color:#667085}.fmp-state .state-icon{width:54px;height:54px;border-radius:16px;background:#fff;border:1px solid #e4e7ec;display:grid;place-items:center;font-size:20px;color:#98a2b3;margin-bottom:13px}.fmp-state h2{font-size:16px;color:#344054;margin:0}.fmp-state p{max-width:450px;font-size:12px;font-weight:700;line-height:1.55;margin:7px 0 15px}.fmp-spinner{animation:fmp-spin .8s linear infinite}@keyframes fmp-spin{to{transform:rotate(360deg)}}
      .fmp-status{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:5px 8px;background:#f2f4f7;color:#475467;font-size:9px;font-weight:950;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}.fmp-status.paid{background:#ecfdf3;color:#067647}.fmp-status.run{background:#eff8ff;color:#175cd3}.fmp-status.partial{background:#fffaeb;color:#b54708}.fmp-status.void{background:#fef3f2;color:#b42318}.fmp-status.small{padding:4px 6px;font-size:8px}
      .fmp-timesheet-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:11px;margin-bottom:16px}.fmp-timesheet-table-wrap{overflow:auto;background:#fff;border:1px solid #e4e7ec;border-radius:15px}.fmp-timesheet-table{width:100%;min-width:1050px;border-collapse:collapse}.fmp-timesheet-table th{text-align:left;padding:10px 11px;color:#667085;font-size:9px;text-transform:uppercase;letter-spacing:.045em;border-bottom:1px solid #e4e7ec;background:#f8fafc}.fmp-timesheet-table td{padding:11px;border-bottom:1px solid #eef0f3;font-size:11px;vertical-align:middle}.fmp-timesheet-table tr:last-child td{border-bottom:0}.fmp-timesheet-person strong,.fmp-timesheet-person span{display:block}.fmp-timesheet-person span{margin-top:3px;color:#667085;font-size:9px}.fmp-location{display:inline-flex;align-items:center;gap:5px;color:#175cd3;font-weight:850;text-decoration:none}.fmp-location.missing{color:#b54708}.fmp-location small{color:#667085;font-weight:750}.fmp-timesheet-actions{display:flex;gap:5px;justify-content:flex-end}.fmp-approval{display:inline-flex;border-radius:999px;padding:5px 8px;font-size:9px;font-weight:950;text-transform:uppercase;background:#fffaeb;color:#b54708}.fmp-approval.approved{background:#ecfdf3;color:#067647}.fmp-approval.rejected{background:#fef3f2;color:#b42318}.fmp-approval.active{background:#eff8ff;color:#175cd3}
      .fmp-export-intro{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;background:linear-gradient(135deg,#fff,#f8fafc);border:1px solid #dfe4eb;border-radius:17px;padding:18px 19px;margin-bottom:14px}.fmp-export-intro h2{margin:0;font-size:17px}.fmp-export-intro p{margin:6px 0 0;color:#667085;font-size:12px;line-height:1.55;max-width:760px}.fmp-export-builder{background:#fff;border:1px solid #e4e7ec;border-radius:17px;padding:17px;margin-bottom:17px;box-shadow:0 3px 10px rgba(16,24,40,.035)}.fmp-export-step{font-size:10px;font-weight:950;text-transform:uppercase;letter-spacing:.06em;color:#667085;margin-bottom:8px}.fmp-export-mode{display:flex;gap:8px;margin-bottom:15px}.fmp-export-mode button{flex:1;border:1px solid #d9dee7;border-radius:12px;background:#fff;text-align:left;padding:12px 13px;color:#475467;cursor:pointer}.fmp-export-mode button.active{border-color:#8098f9;background:#eef4ff;color:#3538cd;box-shadow:0 0 0 2px #e0e7ff}.fmp-export-mode strong,.fmp-export-mode span{display:block}.fmp-export-mode strong{font-size:12px}.fmp-export-mode span{font-size:10px;margin-top:3px;font-weight:700}.fmp-export-selection{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:13px;border-radius:12px;background:#f8fafc;border:1px solid #eaecf0}.fmp-export-selection .fmp-field{flex:1;min-width:190px}.fmp-export-selection select{height:39px;width:100%;border:1px solid #d7dce5;border-radius:9px;background:#fff;padding:0 10px;color:#101828;font-size:12px;font-weight:750}.fmp-report-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px;margin-top:14px}.fmp-report-card{border:1px solid #e4e7ec;border-radius:13px;padding:14px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:13px;align-items:center}.fmp-report-card h3{margin:0;font-size:13px}.fmp-report-card p{margin:5px 0 0;color:#667085;font-size:10.5px;line-height:1.45}.fmp-report-purpose{display:block;margin-top:6px;color:#475467;font-weight:800}.fmp-report-actions{display:grid;gap:6px}.fmp-export-history-head{display:flex;align-items:end;justify-content:space-between;gap:14px;margin:23px 2px 10px}.fmp-export-history-head h2{font-size:15px;margin:0}.fmp-export-history-head p{font-size:10px;color:#667085;margin:4px 0 0}.fmp-file-name{display:block;color:#667085;font-size:9px;margin-top:4px;max-width:520px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fmp-file-format{display:inline-flex;border-radius:6px;background:#f2f4f7;color:#475467;padding:4px 6px;font-size:9px;font-weight:950}.fmp-file-format.pdf{background:#fef3f2;color:#b42318}.fmp-file-format.csv{background:#ecfdf3;color:#067647}
      @media(max-width:1180px){.fmp-metrics{grid-template-columns:repeat(3,1fr)}.fmp-schedule-head{grid-template-columns:minmax(240px,1fr) minmax(330px,1fr) auto}.fmp-worker-grid{grid-template-columns:1fr}.fmp-history-head{grid-template-columns:minmax(220px,1fr) repeat(2,minmax(100px,.5fr)) auto}.fmp-history-stat.hide-medium{display:none}}
      @media(max-width:780px){.fmp-top{position:relative;padding:15px 16px;align-items:flex-start}.fmp-heading-icon{width:38px;height:38px}.fmp-heading h1{font-size:19px}.fmp-heading p{white-space:normal}.fmp-top-actions .fmp-btn span{display:none}.fmp-content{padding:14px 12px 30px}.fmp-toolbar{align-items:stretch;flex-direction:column}.fmp-segment{align-self:flex-start}.fmp-range{grid-template-columns:1fr;padding:13px}.fmp-range-fields{align-items:end}.fmp-range-presets{justify-content:flex-start}.fmp-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.fmp-metric:last-child{grid-column:span 2}.fmp-schedule-head{grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:13px}.fmp-schedule-totals{grid-column:1/-1;grid-row:2}.fmp-mini-total:first-child{border-left:0;padding-left:0}.fmp-schedule-body{padding:12px}.fmp-batch-banner{align-items:flex-start;flex-direction:column}.fmp-worker-row{grid-template-columns:minmax(0,1fr) auto}.fmp-subgroups{grid-column:1/-1;grid-row:2}.fmp-history-head{grid-template-columns:minmax(0,1fr) auto}.fmp-history-stat{display:none}.fmp-history-table{min-width:690px}.fmp-history-body{overflow:auto}.fmp-card-actions{width:100%}.fmp-card-actions .fmp-btn{flex:1}.fmp-export-intro{display:block}.fmp-export-mode{display:grid}.fmp-report-grid{grid-template-columns:1fr}.fmp-report-card{grid-template-columns:1fr}.fmp-report-actions{display:flex}}
      @media(max-width:480px){.fmp-range-arrow{display:none}.fmp-field{flex:1 1 130px}.fmp-field input{width:100%}.fmp-range-fields .fmp-btn{width:100%}.fmp-metrics{grid-template-columns:1fr}.fmp-metric:last-child{grid-column:auto}.fmp-schedule-totals{gap:5px}.fmp-mini-total{padding-left:7px}.fmp-mini-total b{font-size:12px}.fmp-date-tile{width:47px;height:50px}.fmp-worker-money{min-width:90px}.fmp-worker-row{padding:10px}.fmp-occurrence-meta{gap:5px}}
    `;
    document.head.appendChild(style);
  }

  function createSmokeData(state){
    const payDate = addDaysKey(state.from, 5);
    const laterDate = addDaysKey(state.from, 18);
    const weekly = { id:'schedule_weekly', name:'Weekly Field Payroll', currency:'USD', timezone:'America/Los_Angeles', recurrence:{ frequency:'weekly', weekday:5 }, delay:{ periods:1 }, timing_basis:'worked', clawback_cap_percent:100 };
    const semi = { id:'schedule_semimonthly', name:'Company Semi-monthly', currency:'USD', timezone:'America/Los_Angeles', recurrence:{ frequency:'semi_monthly', days:[1,15] }, delay:{ days:3 }, timing_basis:'completed', clawback_cap_percent:50 };
    const worker = (id, name, workerType, accrued, projected, groups) => ({
      payee:{ type:workerType === 'subcontractor' ? 'organization_connection' : 'organization_user', id, name, worker_type:workerType },
      worker_type:workerType,
      accrued:{ payee:{}, gross_cents:accrued, deduction_cents:0, net_cents:accrued, subgroup_totals:groups, entry_count:2 },
      projected:{ gross_cents:projected, deduction_cents:0, net_cents:projected, subgroup_totals:projected ? { piece_rate:projected } : {}, entry_count:projected ? 1 : 0 },
      forecast_net_cents:accrued + projected
    });
    const historyBatch = {
      id:'batch_smoke_paid', schedule_id:semi.id, pay_date:addDaysKey(state.from, -10), period_start:addDaysKey(state.from, -26), period_end:addDaysKey(state.from, -11),
      status:'paid', currency:'USD', total_cents:842500, employee_total_cents:742500, subcontractor_total_cents:100000, paid_at:new Date().toISOString(),
      items:[
        { id:'item_history_1', status:'paid', payee:{ type:'organization_user', id:'u3', name:'Morgan Lee', worker_type:'employee' }, gross_cents:612500, commission_cents:125000, deduction_cents:0, net_cents:612500, subgroup_totals:{ salary:487500, commission:125000 }, paid_at:new Date().toISOString() },
        { id:'item_history_2', status:'paid', payee:{ type:'organization_connection', id:'c2', name:'Apex Gutters', worker_type:'subcontractor' }, gross_cents:100000, commission_cents:0, deduction_cents:0, net_cents:100000, subgroup_totals:{ piece_rate:100000 }, paid_at:new Date().toISOString() }
      ]
    };
    return {
      ok:true, from:state.from, through:state.through, schedules:[weekly, semi], policies:[], diagnostics:[], history:[historyBatch],
      upcoming:[
        { schedule:weekly, pay_date:payDate, period_start:addDaysKey(payDate, -14), period_end:addDaysKey(payDate, -8), cutoff_at:`${addDaysKey(payDate, -7)}T23:59:59.999Z`, batch:null,
          employees:[worker('u1', 'Jordan Ramirez', 'employee', 184500, 42000, { hourly:142500, commission:42000 }), worker('u2', 'Taylor Chen', 'employee', 156000, 18000, { piece_rate:156000 })],
          subcontractors:[worker('c1', 'Summit Roofing Crew', 'subcontractor', 325000, 68000, { piece_rate:325000 })], accrued_total_cents:665500, projected_additional_cents:128000, forecast_total_cents:793500 },
        { schedule:semi, pay_date:laterDate, period_start:addDaysKey(laterDate, -17), period_end:addDaysKey(laterDate, -3), cutoff_at:`${addDaysKey(laterDate, -3)}T23:59:59.999Z`, batch:null,
          employees:[worker('u3', 'Morgan Lee', 'employee', 487500, 125000, { salary:487500 }), worker('u4', 'Alexis Brooks', 'employee', 95000, 55000, { commission:95000 })],
          subcontractors:[], accrued_total_cents:582500, projected_additional_cents:180000, forecast_total_cents:762500 }
      ]
    };
  }

  function createApp(context = {}){
    const root = context.roots?.main || context.root;
    if (!root) return { destroy(){} };
    injectCss();

    const today = dateKey();
    const state = {
      root,
      context,
      orgId:clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId),
      from:clean(context.params?.from) || today,
      through:clean(context.params?.through) || addDaysKey(today, 90),
      includeProjected:context.params?.include_projected !== false,
      view:['history','timesheets','contractors','exports','settings'].includes(clean(window.Portal?.navigation?.read?.().payrollView)) ? clean(window.Portal.navigation.read().payrollView) : 'upcoming',
      data:null,
      timesheetData:null,
      contractorData:null,
      exportData:null,
      exportMode:'payroll_run',
      selectedExportBatchId:'',
      exportFrom:addDaysKey(today, -30),
      exportThrough:today,
      timesheetFrom:addDaysKey(today, -14),
      timesheetThrough:today,
      error:null,
      loading:true,
      busyKey:'',
      expanded:new Set(),
      historyExpanded:new Set(),
      loadedAt:0,
      loadToken:0,
      destroyed:false
    };
    let settingsController = null;

    function toast(title, detail = '', ok = true){
      if (window.Portal?.ui?.showToast) window.Portal.ui.showToast(title, detail, ok);
      else if (window.PlatformUI?.showToast) window.PlatformUI.showToast(title, detail, ok);
      else if (!ok) window.alert(`${title}${detail ? `\n\n${detail}` : ''}`);
    }

    async function confirmAction(message){
      if (window.Portal?.ui?.confirm) return !!(await window.Portal.ui.confirm(message));
      return window.confirm(message);
    }

    function isBusy(key){ return state.busyKey === key; }

    function schedulesById(){
      return new Map(array(state.data?.schedules).map((schedule) => [clean(schedule.id), schedule]));
    }

    function occurrenceAmounts(occurrence){
      const batch = object(occurrence.batch);
      const hasBatch = !!clean(batch.id);
      const accrued = hasBatch ? number(batch.total_cents) : number(occurrence.accrued_total_cents);
      const projected = state.includeProjected ? number(occurrence.projected_additional_cents) : 0;
      return { accrued, projected, forecast:accrued + projected };
    }

    function normalizedPayees(occurrence, workerType){
      const previews = workerType === 'subcontractor' ? array(occurrence.subcontractors) : array(occurrence.employees);
      const batchItems = array(occurrence.batch?.items).filter((item) => workerType === 'subcontractor'
        ? clean(item?.payee?.worker_type || item?.worker_type || 'employee') !== 'employee'
        : clean(item?.payee?.worker_type || item?.worker_type || 'employee') === 'employee');
      const rows = new Map();
      previews.forEach((preview) => rows.set(payeeKey(preview.payee || preview.accrued?.payee), {
        payee:preview.payee || preview.accrued?.payee || preview.projected?.payee,
        worker_type:workerType,
        accrued:object(preview.accrued),
        projected:object(preview.projected),
        forecast_net_cents:number(preview.forecast_net_cents),
        batchItem:null
      }));
      batchItems.forEach((item) => {
        const key = payeeKey(item.payee);
        const current = rows.get(key) || { payee:item.payee, worker_type:workerType, accrued:{}, projected:{}, forecast_net_cents:0, batchItem:null };
        current.batchItem = item;
        current.payee = item.payee || current.payee;
        current.accrued = {
          gross_cents:number(item.gross_cents), deduction_cents:number(item.deduction_cents), net_cents:number(item.net_cents),
          commission_cents:number(item.commission_cents), subgroup_totals:object(item.subgroup_totals), entry_count:1
        };
        current.forecast_net_cents = number(item.net_cents) + number(current.projected?.net_cents);
        rows.set(key, current);
      });
      return [...rows.values()].sort((left, right) => clean(left.payee?.name).localeCompare(clean(right.payee?.name)));
    }

    function subgroupChips(row, currency){
      const accrued = object(row.accrued?.subgroup_totals);
      const projected = object(row.projected?.subgroup_totals);
      const keys = [...new Set([...SUBGROUPS, ...Object.keys(accrued), ...Object.keys(projected)])]
        .filter((key) => number(accrued[key]) !== 0 || (state.includeProjected && number(projected[key]) !== 0));
      if (!keys.length) return `<span class="fmp-subgroup other">${(globalThis.PlatformLanguage?.htmlText("payroll","m_4a04382820d2e1","Other") ?? "Other")}</span>`;
      return keys.map((key) => {
        const accruedAmount = number(accrued[key]);
        const projectedAmount = state.includeProjected ? number(projected[key]) : 0;
        const amount = accruedAmount + projectedAmount;
        const projectedOnly = accruedAmount === 0 && projectedAmount !== 0;
        return `<span class="fmp-subgroup ${esc(key)}${projectedOnly ? ' projected' : ''}" title="${projectedOnly ? 'Projected ' : ''}${esc(SUBGROUP_LABELS[key] || key)}">${esc(SUBGROUP_LABELS[key] || key.replace(/_/g, ' '))} · ${esc(formatMoney(amount, currency, { compact:true }))}</span>`;
      }).join('');
    }

    function itemActions(batch, item){
      if (!clean(batch?.id) || !clean(item?.id) || ['paid', 'void'].includes(clean(item.status))) return '';
      const runKey = `item:${item.id}:run`;
      const paidKey = `item:${item.id}:paid`;
      return `<div class="fmp-item-actions">
        ${clean(item.status) === 'draft' ? `<button class="fmp-btn small" data-action="item-action" data-batch-id="${esc(batch.id)}" data-item-id="${esc(item.id)}" data-next-status="run" ${isBusy(runKey) ? 'disabled' : ''}>${isBusy(runKey) ? '<i class="fas fa-spinner fmp-spinner"></i>' : '<i class="fas fa-play"></i>'} Run</button>` : ''}
        <button class="fmp-btn small success" data-action="item-action" data-batch-id="${esc(batch.id)}" data-item-id="${esc(item.id)}" data-next-status="paid" ${isBusy(paidKey) ? 'disabled' : ''}>${isBusy(paidKey) ? '<i class="fas fa-spinner fmp-spinner"></i>' : '<i class="fas fa-check"></i>'} Paid</button>
      </div>`;
    }

    function workerSection(title, icon, workerType, rows, occurrence){
      const currency = clean(occurrence.schedule?.currency || occurrence.batch?.currency || 'USD');
      const contractor = workerType === 'subcontractor';
      return `<section class="fmp-worker-section">
        <div class="fmp-worker-head${String(contractor ? ' contractor' : '')}">
          <div class="fmp-worker-head-copy"><span class="icon"><i class="fas ${String(icon)}"></i></span><strong>${String(esc(title))}</strong></div>
          <span>${((v3,v4) => globalThis.PlatformLanguage?.htmlText("payroll","m_6448e0d7c2d07a",`${v3} payee${v4}`,{v3,v4}) ?? `${v3} payee${v4}`)(rows.length,rows.length === 1 ? '' : 's')}</span>
        </div>
        <div class="fmp-worker-list">
          ${String(rows.length ? rows.map((row) => {
            const payee = object(row.payee);
            const accrued = row.batchItem ? number(row.batchItem.net_cents) : number(row.accrued?.net_cents);
            const projected = state.includeProjected ? number(row.projected?.net_cents) : 0;
            const total = accrued + projected;
            const status = row.batchItem ? statusBadge(row.batchItem.status, { small:true }) : (accrued > 0 ? `<span class="fmp-status small run"><i class="fas fa-coins"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_c34ad4e79e396b","Accrued") ?? "Accrued")}</span>` : `<span class="fmp-status small"><i class="fas fa-chart-line"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_d418a1dd99512f","Forecast") ?? "Forecast")}</span>`);
            return `<article class="fmp-worker-row">
              <div class="fmp-person">
                <span class="fmp-avatar">${esc(initials(payee.name || payee.id))}</span>
                <span class="fmp-person-copy"><strong title="${esc(payee.name || payee.id)}">${esc(payee.name || payee.id || 'Unknown payee')}</strong><small>${status} · ${contractor ? 'Subcontractor' : 'Employee'}</small></span>
              </div>
              <div class="fmp-subgroups">${subgroupChips(row, currency)}</div>
              <div class="fmp-worker-money">
                <b>${esc(formatMoney(total, currency))}</b>
                <small>${((v7,v8) => globalThis.PlatformLanguage?.htmlText("payroll","m_3a1fcb262241b6",`${v7} accrued${v8}`,{v7,v8}) ?? `${v7} accrued${v8}`)(esc(formatMoney(accrued, currency, { compact:true })),projected ? ` + ${esc(formatMoney(projected, currency, { compact:true }))} projected` : '')}</small>
                ${itemActions(occurrence.batch, row.batchItem)}
              </div>
            </article>`;
          }).join('') : `<div class="fmp-empty-section"><i class="fas ${contractor ? 'fa-helmet-safety' : 'fa-user-group'}"></i>${((v1) => globalThis.PlatformLanguage?.htmlText("payroll","m_3a6702885321a2",`No ${v1} in this payroll.`,{v1}) ?? `No ${v1} in this payroll.`)(contractor ? 'subcontractors' : 'employees')}</div>`)}
        </div>
      </section>`;
    }

    function approvalSummary(batch){
      const approval=object(batch?.approval); if (!clean(approval.status)) return '';
      const requested=array(approval.requested_approvers); const decisions=array(approval.decisions);
      return `<div style="font-size:11px;color:#667085;margin-top:4px">${(globalThis.PlatformLanguage?.htmlText("payroll","m_753b856d98671a","Approval: ") ?? "Approval: ")}<strong>${String(esc(approval.status))}</strong>${String(requested.length ? ` · ${requested.map((person) => { const decision=decisions.find((entry) => clean(entry.user_id) === clean(person.user_id)); return `${esc(person.name || person.user_id)}${decision ? ` (${esc(decision.decision)})` : ''}`; }).join(', ')}` : '')}</div>`;
    }

    function batchControls(occurrence){
      const batch = object(occurrence.batch);
      const currency = clean(occurrence.schedule?.currency || batch.currency || 'USD');
      if (!clean(batch.id)) {
        const amount = number(occurrence.accrued_total_cents);
        const key = `create:${occurrenceKey(occurrence)}`;
        return `<div class="fmp-batch-banner">
          <div class="fmp-batch-none"><b>${(globalThis.PlatformLanguage?.htmlText("payroll","m_7bda291a7ec7d2","No batch created.") ?? "No batch created.")}</b>${(globalThis.PlatformLanguage?.htmlText("payroll","m_222255f0484ee6"," Create one when the accrued amount is ready for payroll. Projected earnings stay out until they accrue.") ?? " Create one when the accrued amount is ready for payroll. Projected earnings stay out until they accrue.")}</div>
          <button class="fmp-btn primary" data-action="create-batch" data-schedule-id="${String(esc(occurrence.schedule?.id))}" data-pay-date="${String(esc(occurrence.pay_date))}" ${String(amount <= 0 || isBusy(key) ? 'disabled' : '')}>${String(isBusy(key) ? '<i class="fas fa-spinner fmp-spinner"></i>' : '<i class="fas fa-plus"></i>')} Create batch · ${String(esc(formatMoney(amount, currency, { compact:true })))}</button>
        </div>`;
      }
      const approvalStatus=clean(batch.approval?.status);
      const canRun = approvalStatus === 'finalized' && !['run', 'paid', 'void'].includes(clean(batch.status));
      const canPay = approvalStatus === 'finalized' && !['paid', 'void'].includes(clean(batch.status));
      return `<div class="fmp-batch-banner">
        <div class="fmp-batch-copy">
          ${String(statusBadge(batch.status))}
          <span><strong>${((v1) => globalThis.PlatformLanguage?.htmlText("payroll","m_2a99efe3caf1f5",`Batch ${v1}`,{v1}) ?? `Batch ${v1}`)(esc(batch.id))}</strong><small>${((v2,v3,v4) => globalThis.PlatformLanguage?.htmlText("payroll","m_3d4c7aa8503d45",`${v2} payee${v3} · ${v4}`,{v2,v3,v4}) ?? `${v2} payee${v3} · ${v4}`)(array(batch.items).length,array(batch.items).length === 1 ? '' : 's',esc(formatMoney(batch.total_cents, currency)))}</small>${String(approvalSummary(batch))}</span>
        </div>
        <div class="fmp-card-actions">
          ${String(!approvalStatus || ['draft','rejected'].includes(approvalStatus) ? `<button class="fmp-btn" data-action="approval-submit" data-batch-id="${esc(batch.id)}"><i class="fas fa-user-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_2f3f472e8e62f5"," Request approval") ?? " Request approval")}</button>` : '')}
          ${String(approvalStatus === 'pending' ? `<button class="fmp-btn success" data-action="approval-decide" data-batch-id="${esc(batch.id)}"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_727ff89ac91c2c"," Approve as me") ?? " Approve as me")}</button>` : '')}
          ${String(approvalStatus === 'approved' ? `<button class="fmp-btn success" data-action="approval-finalize" data-batch-id="${esc(batch.id)}"><i class="fas fa-lock"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_3623d3650448b8"," Finalize") ?? " Finalize")}</button>` : '')}
          ${String(approvalStatus === 'finalized' && clean(batch.status) === 'draft' ? `<button class="fmp-btn" data-action="approval-reopen" data-batch-id="${esc(batch.id)}"><i class="fas fa-pen-to-square"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_53e326dbad918f"," Reopen & refresh") ?? " Reopen & refresh")}</button>` : '')}
          ${String(canRun ? `<button class="fmp-btn" data-action="batch-action" data-batch-id="${esc(batch.id)}" data-next-status="run" ${isBusy(`batch:${batch.id}:run`) ? 'disabled' : ''}><i class="fas ${isBusy(`batch:${batch.id}:run`) ? 'fa-spinner fmp-spinner' : 'fa-play'}"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_fcd00a57679317"," Mark all Run") ?? " Mark all Run")}</button>` : '')}
          ${String(canPay ? `<button class="fmp-btn success" data-action="batch-action" data-batch-id="${esc(batch.id)}" data-next-status="paid" ${isBusy(`batch:${batch.id}:paid`) ? 'disabled' : ''}><i class="fas ${isBusy(`batch:${batch.id}:paid`) ? 'fa-spinner fmp-spinner' : 'fa-check-double'}"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_d651b7fabc83ec"," Mark all Paid") ?? " Mark all Paid")}</button>` : '')}
        </div>
      </div>`;
    }

    function scheduleCard(occurrence, index){
      const schedule = object(occurrence.schedule);
      const key = occurrenceKey(occurrence);
      const open = state.expanded.has(key);
      const amounts = occurrenceAmounts(occurrence);
      const currency = clean(schedule.currency || 'USD');
      const payDate = new Date(`${clean(occurrence.pay_date)}T12:00:00`);
      const month = Number.isFinite(payDate.getTime()) ? payDate.toLocaleDateString(undefined, { month:'short' }) : 'Pay';
      const day = Number.isFinite(payDate.getTime()) ? payDate.getDate() : '—';
      const employees = normalizedPayees(occurrence, 'employee');
      const subcontractors = normalizedPayees(occurrence, 'subcontractor');
      return `<article class="fmp-schedule-card${String(index === 0 ? ' next' : '')}${String(open ? ' open' : '')}">
        <div class="fmp-schedule-head" data-action="toggle-schedule" data-key="${String(esc(key))}" role="button" tabindex="0" aria-expanded="${String(open ? 'true' : 'false')}">
          <div class="fmp-schedule-title">
            <div class="fmp-date-tile"><span>${String(esc(month))}</span><b>${String(esc(day))}</b></div>
            <div class="fmp-title-copy"><h2>${String(esc(schedule.name || 'Payroll schedule'))}${String(index === 0 ? `<span class="fmp-next-label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_5e03a7c216f500","Next") ?? "Next")}</span>` : '')}</h2><p>${((v8,v9) => globalThis.PlatformLanguage?.htmlText("payroll","m_613f927946b35b",`Pay date ${v8} · ${v9}`,{v8,v9}) ?? `Pay date ${v8} · ${v9}`)(esc(formatDate(occurrence.pay_date)),esc(recurrenceLabel(schedule)))}</p></div>
          </div>
          <div class="fmp-schedule-totals">
            <div class="fmp-mini-total"><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_c34ad4e79e396b","Accrued") ?? "Accrued")}</span><b>${String(esc(formatMoney(amounts.accrued, currency)))}</b></div>
            <div class="fmp-mini-total projected"><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_929d3bd2149645","Projected") ?? "Projected")}</span><b>${String(esc(formatMoney(amounts.projected, currency)))}</b></div>
            <div class="fmp-mini-total forecast"><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_d418a1dd99512f","Forecast") ?? "Forecast")}</span><b>${String(esc(formatMoney(amounts.forecast, currency)))}</b></div>
          </div>
          <button class="fmp-chevron" type="button" aria-label="${String(open ? 'Collapse' : 'Expand')} ${String(esc(schedule.name))}"><i class="fas fa-chevron-down"></i></button>
        </div>
        ${String(open ? `<div class="fmp-schedule-body">
          <div class="fmp-occurrence-meta">
            <span class="fmp-meta-chip"><i class="fas fa-calendar-days"></i>${esc(formatDate(occurrence.period_start))} – ${esc(formatDate(occurrence.period_end))}</span>
            <span class="fmp-meta-chip"><i class="fas fa-hourglass-half"></i>${esc(delayLabel(schedule))}</span>
            <span class="fmp-meta-chip"><i class="fas ${schedule.timing_basis === 'completed' ? 'fa-flag-checkered' : 'fa-person-digging'}"></i>${((v4) => globalThis.PlatformLanguage?.htmlText("payroll","m_108e207af73dd4",`Recognize when ${v4}`,{v4}) ?? `Recognize when ${v4}`)(schedule.timing_basis === 'completed' ? 'completed' : 'worked')}</span>
            <span class="fmp-meta-chip"><i class="fas fa-scissors"></i>${((v5) => globalThis.PlatformLanguage?.htmlText("payroll","m_1047f11ac8a4bb",`Cutoff ${v5}`,{v5}) ?? `Cutoff ${v5}`)(esc(formatDateTime(occurrence.cutoff_at)))}</span>
            <span class="fmp-meta-chip"><i class="fas fa-shield-halved"></i>${((v6) => globalThis.PlatformLanguage?.htmlText("payroll","m_a96c7f61f8c7f7",`${v6}% max clawback`,{v6}) ?? `${v6}% max clawback`)(esc(number(schedule.clawback_cap_percent)))}</span>
          </div>
          ${batchControls(occurrence)}
          <div class="fmp-worker-grid">
            ${workerSection('Employees', 'fa-user-group', 'employee', employees, occurrence)}
            ${workerSection('Subcontractors', 'fa-helmet-safety', 'subcontractor', subcontractors, occurrence)}
          </div>
        </div>` : '')}
      </article>`;
    }

    function historyCard(batch, scheduleMap){
      const open = state.historyExpanded.has(clean(batch.id));
      const schedule = scheduleMap.get(clean(batch.schedule_id)) || {};
      const currency = clean(batch.currency || schedule.currency || 'USD');
      const items = array(batch.items);
      return `<article class="fmp-history-card">
        <div class="fmp-history-head" data-action="toggle-history" data-key="${String(esc(batch.id))}" role="button" tabindex="0" aria-expanded="${String(open ? 'true' : 'false')}">
          <div class="fmp-history-title"><span class="icon"><i class="fas fa-receipt"></i></span><span><strong>${String(esc(schedule.name || 'Payroll batch'))}</strong><small>${((v3,v4,v5) => globalThis.PlatformLanguage?.htmlText("payroll","m_590c41b7b858c6",`Pay date ${v3} · ${v4} payee${v5}`,{v3,v4,v5}) ?? `Pay date ${v3} · ${v4} payee${v5}`)(esc(formatDate(batch.pay_date)),items.length,items.length === 1 ? '' : 's')}</small></span></div>
          <div class="fmp-history-stat"><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_9403c7637d4905","Total") ?? "Total")}</span><b>${String(esc(formatMoney(batch.total_cents, currency)))}</b></div>
          <div class="fmp-history-stat"><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_af4c235bc74266","Employees") ?? "Employees")}</span><b>${String(esc(formatMoney(batch.employee_total_cents, currency)))}</b></div>
          <div class="fmp-history-stat hide-medium"><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_e761408c42ed5e","Subcontractors") ?? "Subcontractors")}</span><b>${String(esc(formatMoney(batch.subcontractor_total_cents, currency)))}</b></div>
          <div style="display:flex;align-items:center;gap:8px">${String(statusBadge(batch.status))}<span class="fmp-chevron"><i class="fas fa-chevron-down" style="${String(open ? 'transform:rotate(180deg)' : '')}"></i></span></div>
        </div>
        ${String(open ? `<div class="fmp-history-body">
          ${approvalSummary(batch)}
          <table class="fmp-history-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_4e3a8f50faa2d5","Payee") ?? "Payee")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_2e88df13ca7101","Type") ?? "Type")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_a6b5da8bcb27c3","Breakdown") ?? "Breakdown")}</th><th class="fmp-right">${(globalThis.PlatformLanguage?.htmlText("payroll","m_bd8c29e4635878","Gross") ?? "Gross")}</th><th class="fmp-right">${(globalThis.PlatformLanguage?.htmlText("payroll","m_3a9e6fbb77c33d","Deductions") ?? "Deductions")}</th><th class="fmp-right">${(globalThis.PlatformLanguage?.htmlText("payroll","m_8870b67246b7d9","Net") ?? "Net")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_1352cafa75b8da","Status") ?? "Status")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_9c2b37dfc8a2bc","Paid at") ?? "Paid at")}</th></tr></thead>
          <tbody>${items.map((item) => {
            const row = { accrued:{ subgroup_totals:object(item.subgroup_totals) }, projected:{} };
            const classification=clean(item.payee?.worker_type || 'employee');
            return `<tr><td><strong>${esc(item.payee?.name || item.payee?.id)}</strong></td><td>${classification === 'independent_contractor' ? 'Independent contractor' : classification === 'subcontractor' ? 'Subcontractor' : 'Employee'}</td><td><div class="fmp-subgroups">${subgroupChips(row, currency)}</div></td><td class="fmp-right">${esc(formatMoney(item.gross_cents, currency))}</td><td class="fmp-right">${number(item.deduction_cents) ? `−${esc(formatMoney(item.deduction_cents, currency))}` : '—'}</td><td class="fmp-right"><strong>${esc(formatMoney(item.net_cents, currency))}</strong></td><td>${statusBadge(item.status, { small:true })}</td><td>${item.paid_at ? esc(formatDateTime(item.paid_at)) : '—'}</td></tr>`;
          }).join('')}</tbody></table>
          ${!['paid', 'void'].includes(clean(batch.status)) ? `<div class="fmp-card-actions" style="justify-content:flex-end;margin-top:12px">
            ${!clean(batch.approval?.status) || clean(batch.approval?.status) === 'draft' || clean(batch.approval?.status) === 'rejected' ? `<button class="fmp-btn" data-action="approval-submit" data-batch-id="${esc(batch.id)}"><i class="fas fa-user-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_2f3f472e8e62f5"," Request approval") ?? " Request approval")}</button>` : ''}
            ${clean(batch.approval?.status) === 'pending' ? `<button class="fmp-btn success" data-action="approval-decide" data-batch-id="${esc(batch.id)}"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_727ff89ac91c2c"," Approve as me") ?? " Approve as me")}</button>` : ''}
            ${clean(batch.approval?.status) === 'approved' ? `<button class="fmp-btn success" data-action="approval-finalize" data-batch-id="${esc(batch.id)}"><i class="fas fa-lock"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_7c1f625b211f5e"," Finalize payroll") ?? " Finalize payroll")}</button>` : ''}
            ${clean(batch.approval?.status) === 'finalized' && clean(batch.status) === 'draft' ? `<button class="fmp-btn" data-action="batch-action" data-batch-id="${esc(batch.id)}" data-next-status="run"><i class="fas fa-play"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_fcd00a57679317"," Mark all Run") ?? " Mark all Run")}</button>` : ''}
            ${(clean(batch.approval?.status) === 'finalized' && clean(batch.status) === 'draft') || clean(batch.status) === 'run' ? `<button class="fmp-btn" data-action="approval-reopen" data-batch-id="${esc(batch.id)}"><i class="fas fa-pen-to-square"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_53e326dbad918f"," Reopen & refresh") ?? " Reopen & refresh")}</button>` : ''}
            ${clean(batch.approval?.status) === 'finalized' || ['run','partial'].includes(clean(batch.status)) ? `<button class="fmp-btn success" data-action="batch-action" data-batch-id="${esc(batch.id)}" data-next-status="paid"><i class="fas fa-check-double"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_d651b7fabc83ec"," Mark all Paid") ?? " Mark all Paid")}</button>` : ''}
          </div>` : ''}
        </div>` : '')}
      </article>`;
    }

    function rangeHtml(){
      return `<section class="fmp-range">
        <div class="fmp-range-fields">
          <div class="fmp-field"><label for="fmpRangeFrom">${(globalThis.PlatformLanguage?.htmlText("payroll","m_c313c42d1f7a10","From") ?? "From")}</label><input id="fmpRangeFrom" type="date" value="${String(esc(state.from))}"></div>
          <div class="fmp-range-arrow"><i class="fas fa-arrow-right"></i></div>
          <div class="fmp-field"><label for="fmpRangeThrough">${(globalThis.PlatformLanguage?.htmlText("payroll","m_6089f8623b0f11","Through") ?? "Through")}</label><input id="fmpRangeThrough" type="date" value="${String(esc(state.through))}" min="${String(esc(state.from))}"></div>
          <button class="fmp-btn dark" data-action="apply-range"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_4a4ef7a972510c"," Apply range") ?? " Apply range")}</button>
        </div>
        <div class="fmp-range-presets">
          <button class="fmp-preset" data-action="preset" data-days="30">${(globalThis.PlatformLanguage?.htmlText("payroll","m_abb8a16c33a945","30 days") ?? "30 days")}</button><button class="fmp-preset" data-action="preset" data-days="90">${(globalThis.PlatformLanguage?.htmlText("payroll","m_96c3192473b128","90 days") ?? "90 days")}</button><button class="fmp-preset" data-action="preset" data-days="180">${(globalThis.PlatformLanguage?.htmlText("payroll","m_6fdfbc2f933786","6 months") ?? "6 months")}</button><button class="fmp-preset" data-action="preset" data-days="365">${(globalThis.PlatformLanguage?.htmlText("payroll","m_4b231e0cddf70e","1 year") ?? "1 year")}</button>
          <button class="fmp-projection-toggle${String(state.includeProjected ? ' active' : '')}" data-action="toggle-projected" aria-pressed="${String(state.includeProjected ? 'true' : 'false')}"><span class="fmp-toggle-dot"></span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_44e7c844bf6527","Projected earnings") ?? "Projected earnings")}</button>
        </div>
      </section>`;
    }

    function metricsHtml(){
      const upcoming = array(state.data?.upcoming);
      const next = upcoming[0];
      const totals = upcoming.reduce((sum, occurrence) => {
        const values = occurrenceAmounts(occurrence);
        sum.accrued += values.accrued; sum.projected += values.projected; sum.forecast += values.forecast;
        return sum;
      }, { accrued:0, projected:0, forecast:0 });
      const currency = clean(next?.schedule?.currency || state.data?.schedules?.[0]?.currency || 'USD');
      const batches = upcoming.filter((occurrence) => clean(occurrence.batch?.id));
      return `<section class="fmp-metrics">
        <div class="fmp-metric"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_3880ce31dedd06","Next pay date") ?? "Next pay date")}</span><span class="value">${String(next ? esc(formatDate(next.pay_date, { year:false })) : '—')}</span><span class="detail">${String(next ? esc(next.schedule?.name || '') : 'No payroll scheduled')}</span></div>
        <div class="fmp-metric accrued"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_02e36c84f7302b","Accrued in range") ?? "Accrued in range")}</span><span class="value">${String(esc(formatMoney(totals.accrued, currency, { compact:true })))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_9561193cdfc6f5","Ready across scheduled cycles") ?? "Ready across scheduled cycles")}</span></div>
        <div class="fmp-metric projected"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_d20939f1e6df77","Projected additional") ?? "Projected additional")}</span><span class="value">${String(esc(formatMoney(totals.projected, currency, { compact:true })))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_d2b7b8565a580d","Not included in created batches") ?? "Not included in created batches")}</span></div>
        <div class="fmp-metric forecast"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_34d6d8e9d655bc","Range forecast") ?? "Range forecast")}</span><span class="value">${String(esc(formatMoney(totals.forecast, currency, { compact:true })))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_596454d77d55c3","Accrued plus projected labor") ?? "Accrued plus projected labor")}</span></div>
        <div class="fmp-metric"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_9714bf1827f13f","Payroll batches") ?? "Payroll batches")}</span><span class="value">${String(batches.length)}</span><span class="detail">${((v6,v7) => globalThis.PlatformLanguage?.htmlText("payroll","m_29bcd8d58a79a8",`${v6} active schedule group${v7}`,{v6,v7}) ?? `${v6} active schedule group${v7}`)(array(state.data?.schedules).length,array(state.data?.schedules).length === 1 ? '' : 's')}</span></div>
      </section>`;
    }

    function diagnosticsHtml(){
      return array(state.data?.diagnostics).map((diagnostic) => {
        if (clean(diagnostic.code) === 'unassigned_entries') return `<div class="fmp-diagnostic"><i class="fas fa-triangle-exclamation"></i><span><strong>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("payroll","m_ccb0a7fbff8fcd",`${v0} payroll entr${v1} not assigned to a pay schedule.`,{v0,v1}) ?? `${v0} payroll entr${v1} not assigned to a pay schedule.`)(number(diagnostic.count),number(diagnostic.count) === 1 ? 'y is' : 'ies are')}</strong>${((v2) => globalThis.PlatformLanguage?.htmlText("payroll","m_431b1e58e0a1e8",` Assign a schedule in Payroll settings so ${v2} can appear in an upcoming payroll.`,{v2}) ?? ` Assign a schedule in Payroll settings so ${v2} can appear in an upcoming payroll.`)(number(diagnostic.count) === 1 ? 'it' : 'they')}</span></div>`;
        return `<div class="fmp-diagnostic"><i class="fas fa-circle-info"></i><span>${esc(diagnostic.message || diagnostic.code || 'Payroll diagnostic')}</span></div>`;
      }).join('');
    }

    function locationHtml(value, label){
      const location = object(value);
      const captured = clean(location.status) === 'captured' && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude));
      if (!captured) return `<span class="fmp-location missing" title="${String(esc(location.reason || location.status || 'Not recorded'))}"><i class="fas fa-location-dot-slash"></i>${((v1) => globalThis.PlatformLanguage?.htmlText("payroll","m_a2abbd4a491432",`${v1} unavailable`,{v1}) ?? `${v1} unavailable`)(esc(label))}</span>`;
      const accuracy = number(location.accuracy_meters);
      const distance = Number.isFinite(Number(location.distance_to_project_meters)) ? number(location.distance_to_project_meters) : null;
      const detail = [accuracy ? `Â±${Math.round(accuracy)}m` : '', distance != null ? `${Math.round(distance)}m from job` : ''].filter(Boolean).join(' Â· ');
      const href = `https://www.google.com/maps?q=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`;
      return `<a class="fmp-location" href="${esc(href)}" target="_blank" rel="noopener"><i class="fas fa-location-dot"></i>${esc(label)}${detail ? `<small>${esc(detail)}</small>` : ''}</a>`;
    }

    function timesheetMetricsHtml(){
      const summary = object(state.timesheetData?.summary);
      return `<section class="fmp-timesheet-metrics">
        <div class="fmp-metric"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_a674a4cf49532a","Currently clocked in") ?? "Currently clocked in")}</span><span class="value">${String(number(summary.active))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_dd20fcf3b03743","Live active shifts") ?? "Live active shifts")}</span></div>
        <div class="fmp-metric forecast"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_d3ba5228539462","Pending review") ?? "Pending review")}</span><span class="value">${String(number(summary.pending))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_109e68d6521f7d","Closed, not yet accrued") ?? "Closed, not yet accrued")}</span></div>
        <div class="fmp-metric accrued"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_51be70f25415d9","Approved") ?? "Approved")}</span><span class="value">${String(number(summary.approved))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_1a9b825b05ac9b","Posted to payroll ledger") ?? "Posted to payroll ledger")}</span></div>
        <div class="fmp-metric"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_059a429eefd80b","Worked time") ?? "Worked time")}</span><span class="value">${String(esc(formatDuration(summary.worked_seconds)))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_40a0a105f15ffa","Across this date range") ?? "Across this date range")}</span></div>
        <div class="fmp-metric"><span class="label">${(globalThis.PlatformLanguage?.htmlText("payroll","m_c8563e08f09a81","Missing location") ?? "Missing location")}</span><span class="value">${String(number(summary.missing_location))}</span><span class="detail">${(globalThis.PlatformLanguage?.htmlText("payroll","m_3c8a8a9742e909","Denied, unavailable, or legacy") ?? "Denied, unavailable, or legacy")}</span></div>
      </section>`;
    }

    function timesheetRangeHtml(){
      return `<section class="fmp-range"><div class="fmp-range-fields">
        <div class="fmp-field"><label for="fmpTimesheetFrom">${(globalThis.PlatformLanguage?.htmlText("payroll","m_c313c42d1f7a10","From") ?? "From")}</label><input id="fmpTimesheetFrom" type="date" value="${String(esc(state.timesheetFrom))}"></div>
        <div class="fmp-range-arrow"><i class="fas fa-arrow-right"></i></div>
        <div class="fmp-field"><label for="fmpTimesheetThrough">${(globalThis.PlatformLanguage?.htmlText("payroll","m_6089f8623b0f11","Through") ?? "Through")}</label><input id="fmpTimesheetThrough" type="date" value="${String(esc(state.timesheetThrough))}" min="${String(esc(state.timesheetFrom))}"></div>
        <button class="fmp-btn dark" data-action="apply-timesheet-range"><i class="fas fa-calendar-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_4a4ef7a972510c"," Apply range") ?? " Apply range")}</button>
      </div><div class="fmp-range-presets"><button class="fmp-preset" data-action="timesheet-preset" data-days="7">${(globalThis.PlatformLanguage?.htmlText("payroll","m_016fb803931b09","7 days") ?? "7 days")}</button><button class="fmp-preset" data-action="timesheet-preset" data-days="14">${(globalThis.PlatformLanguage?.htmlText("payroll","m_6e4cfc8d97e558","14 days") ?? "14 days")}</button><button class="fmp-preset" data-action="timesheet-preset" data-days="30">${(globalThis.PlatformLanguage?.htmlText("payroll","m_abb8a16c33a945","30 days") ?? "30 days")}</button><button class="fmp-preset" data-action="timesheet-preset" data-days="90">${(globalThis.PlatformLanguage?.htmlText("payroll","m_96c3192473b128","90 days") ?? "90 days")}</button></div></section>`;
    }

    function timesheetsHtml(){
      if (state.loading && !state.timesheetData) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-spinner fmp-spinner"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_7eb1d571aa817d","Loading timesheets") ?? "Loading timesheets")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_cf8c14c49e68b2","Reading shifts, approvals, and clock locations.") ?? "Reading shifts, approvals, and clock locations.")}</p></div>`;
      if (state.error && !state.timesheetData) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-triangle-exclamation"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_3bab786d0ed977","Timesheets could not load") ?? "Timesheets could not load")}</h2><p>${String(esc(state.error.message || state.error))}</p><button class="fmp-btn primary" data-action="refresh"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div>`;
      const rows = array(state.timesheetData?.timesheets);
      if (!rows.length) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-clock"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_0a20a95c3fb7ae","No shifts in this range") ?? "No shifts in this range")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_ac23dfa7d4a35f","Clocked shifts will appear here for review and payroll approval.") ?? "Clocked shifts will appear here for review and payroll approval.")}</p></div>`;
      return `<div class="fmp-timesheet-table-wrap"><table class="fmp-timesheet-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_cd4c6b59af9d33","Worker") ?? "Worker")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_a5a3b1f08ca908","Clock in") ?? "Clock in")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_a955f5181dc29d","Clock out") ?? "Clock out")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_43a63afbcc6e8e","Worked") ?? "Worked")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_aaebd7ccba0b30","Project") ?? "Project")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_16a2f7a51e5335","Locations") ?? "Locations")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_1352cafa75b8da","Status") ?? "Status")}</th><th></th></tr></thead><tbody>${String(rows.map((shift) => {
        const approval = clean(shift.approval_status || (shift.status === 'active' ? 'active' : 'pending'));
        const closed = clean(shift.status) === 'closed';
        return `<tr><td><span class="fmp-timesheet-person"><strong>${esc(shift.user?.name || shift.user_id)}</strong><span>${esc(shift.user?.email || '')}</span></span></td>
          <td>${esc(formatDateTime(shift.clocked_in_at))}</td><td>${shift.clocked_out_at ? esc(formatDateTime(shift.clocked_out_at)) : `<span class="fmp-approval active">${(globalThis.PlatformLanguage?.htmlText("payroll","m_46e47f1706df0c","Active") ?? "Active")}</span>`}</td>
          <td><strong>${esc(formatDuration(shift.worked_seconds))}</strong><br><small>${((v5) => globalThis.PlatformLanguage?.htmlText("payroll","m_90b886ed23af83",`${v5} break`,{v5}) ?? `${v5} break`)(esc(formatDuration(shift.break_seconds)))}</small></td>
          <td>${esc(shift.project?.title || (globalThis.PlatformLanguage?.text("payroll","m_57bfc714f983ad","Unallocated") ?? "Unallocated"))}</td><td><div style="display:grid;gap:5px">${locationHtml(shift.clock_in_location, 'In')}${closed ? locationHtml(shift.clock_out_location, 'Out') : ''}</div></td>
          <td><span class="fmp-approval ${esc(approval)}">${esc(approval)}</span>${shift.manager_note ? `<br><small title="${esc(shift.manager_note)}">${esc(shift.manager_note)}</small>` : ''}</td>
          <td><div class="fmp-timesheet-actions"><button class="fmp-btn small" data-action="timesheet-edit" data-shift-id="${esc(shift.id)}" title="${(globalThis.PlatformLanguage?.htmlText("payroll","m_3657f854b9eb94","Correct times") ?? "Correct times")}"><i class="fas fa-pen"></i></button>${closed && approval !== 'approved' ? `<button class="fmp-btn small success" data-action="timesheet-approve" data-shift-id="${esc(shift.id)}"><i class="fas fa-check"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_5fab133a50e126"," Approve") ?? " Approve")}</button>` : ''}${closed && approval !== 'rejected' ? `<button class="fmp-btn small" data-action="timesheet-reject" data-shift-id="${esc(shift.id)}"><i class="fas fa-xmark"></i></button>` : ''}</div></td></tr>`;
      }).join(''))}</tbody></table></div>`;
    }

    function contractorsHtml(){
      if (state.loading && !state.contractorData) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-spinner fmp-spinner"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_65de6379fbec63","Loading payees") ?? "Loading payees")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_f47bd5fe91454a","Reading people, subcontractor companies, and payment terms.") ?? "Reading people, subcontractor companies, and payment terms.")}</p></div>`;
      const users = array(state.contractorData?.users);
      const connections = array(state.contractorData?.connections);
      return `<section class="fmp-range"><div><strong>${(globalThis.PlatformLanguage?.htmlText("payroll","m_bbcf73eb789ddf","Workers and subcontractors") ?? "Workers and subcontractors")}</strong><div style="color:#667085;font-size:12px;margin-top:4px">${(globalThis.PlatformLanguage?.htmlText("payroll","m_e7c30e4e0c04f1","Classify individual workers here. Company subcontractors retain their organization record and payment terms; project assignments continue to use the existing crew and resource assignment tools.") ?? "Classify individual workers here. Company subcontractors retain their organization record and payment terms; project assignments continue to use the existing crew and resource assignment tools.")}</div></div></section>
        <div class="fmp-timesheet-table-wrap"><table class="fmp-timesheet-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_4e3a8f50faa2d5","Payee") ?? "Payee")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_9bb65d62d4caa7","Record type") ?? "Record type")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_0ee677e8200886","Classification") ?? "Classification")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_462e38dd9a2f59","Payment terms") ?? "Payment terms")}</th><th></th></tr></thead><tbody>
        ${String(users.map((user) => { const classification=clean(user.worker_classification || user.worker_type || 'employee'); const terms=object(user.payment_terms); return `<tr><td><strong>${esc(user.name || user.display_name || user.email || user.id)}</strong><br><small>${esc(user.email || '')}</small></td><td>${(globalThis.PlatformLanguage?.htmlText("payroll","m_e778558ac68c5b","Individual") ?? "Individual")}</td><td><select data-contractor-classification="${esc(user.id)}"><option value="employee" ${classification === 'employee' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("payroll","m_479431cbbc40d0","Employee") ?? "Employee")}</option><option value="independent_contractor" ${classification === 'independent_contractor' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("payroll","m_1614e347d92a28","Independent contractor") ?? "Independent contractor")}</option></select></td><td><select data-contractor-basis="${esc(user.id)}"><option value="payroll_schedule" ${clean(terms.basis || 'payroll_schedule') === 'payroll_schedule' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("payroll","m_f4fa20da324a5e","Payroll schedule") ?? "Payroll schedule")}</option><option value="net_days" ${clean(terms.basis) === 'net_days' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("payroll","m_5c694b39fd19fa","Net days") ?? "Net days")}</option></select> <input style="width:70px" type="number" min="0" max="365" value="${number(terms.net_days)}" data-contractor-days="${esc(user.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("payroll","m_5c694b39fd19fa","Net days") ?? "Net days")}"></td><td><button class="fmp-btn small" data-action="save-worker-payee" data-user-id="${esc(user.id)}">${(globalThis.PlatformLanguage?.htmlText("payroll","m_5bab3e72de1ebf","Save") ?? "Save")}</button></td></tr>`; }).join(''))}
        ${String(connections.map((connection) => { const terms=object(connection.payment_terms); return `<tr><td><strong>${esc(connection.name || connection.company_name || connection.id)}</strong><br><small>${esc(connection.primary_contact?.email || '')}</small></td><td>${(globalThis.PlatformLanguage?.htmlText("payroll","m_be15c0d3344497","Subcontractor company") ?? "Subcontractor company")}</td><td>${(globalThis.PlatformLanguage?.htmlText("payroll","m_ede7d31c438e08","Subcontractor") ?? "Subcontractor")}</td><td><select data-connection-basis="${esc(connection.id)}"><option value="payroll_schedule" ${clean(terms.basis || 'payroll_schedule') === 'payroll_schedule' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("payroll","m_088a5b83330ee2","Payment cycle") ?? "Payment cycle")}</option><option value="net_days" ${clean(terms.basis) === 'net_days' ? 'selected' : ''}>${(globalThis.PlatformLanguage?.htmlText("payroll","m_5c694b39fd19fa","Net days") ?? "Net days")}</option></select> <input style="width:70px" type="number" min="0" max="365" value="${number(terms.net_days)}" data-connection-days="${esc(connection.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("payroll","m_5c694b39fd19fa","Net days") ?? "Net days")}"></td><td><button class="fmp-btn small" data-action="save-company-payee" data-connection-id="${esc(connection.id)}">${(globalThis.PlatformLanguage?.htmlText("payroll","m_5bab3e72de1ebf","Save") ?? "Save")}</button></td></tr>`; }).join(''))}
        ${String(!users.length && !connections.length ? `<tr><td colspan="5">${(globalThis.PlatformLanguage?.htmlText("payroll","m_005dc0671667db","No workforce or subcontractor records are available.") ?? "No workforce or subcontractor records are available.")}</td></tr>` : '')}</tbody></table></div>`;
    }

    function exportsHtml(){
      if (state.loading && !state.exportData) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-spinner fmp-spinner"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_4bf939ec84b6aa","Loading reports") ?? "Loading reports")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_47c2ba7f4c91da","Reading export definitions and generated documents.") ?? "Reading export definitions and generated documents.")}</p></div>`;
      const catalog=array(state.exportData?.catalog); const artifacts=array(state.exportData?.artifacts); const batches=array(state.data?.history); const scheduleMap=schedulesById();
      const reportByType=new Map(catalog.map((report) => [clean(report.type), report]));
      const selectedBatch=batches.find((batch) => clean(batch.id) === clean(state.selectedExportBatchId)) || batches[0];
      const availableReports=catalog.filter((report) => state.exportMode === 'payroll_run' ? ['payroll_run','payroll_run_or_date_range'].includes(clean(report.scope)) : ['date_range','payroll_run_or_date_range'].includes(clean(report.scope)));
      const batchOption=(batch) => { const schedule=scheduleMap.get(clean(batch.schedule_id)) || {}; const prefix=clean(batch.run_type) === 'off_cycle' ? 'Off-cycle payroll' : clean(schedule.name || 'Payroll'); return `${prefix} — paid ${formatDate(batch.pay_date)} — ${formatMoney(batch.total_cents,batch.currency)} — ${statusLabel(batch.status)}`; };
      const metadataFor=(artifact) => object(artifact.metadata);
      const reportName=(artifact) => clean(metadataFor(artifact).report_label || reportByType.get(clean(artifact.report_type))?.label || clean(artifact.report_type).replace(/_/g,' ').replace(/\b\w/g,(letter) => letter.toUpperCase()));
      const coverage=(artifact) => { const metadata=metadataFor(artifact); if (metadata.coverage_label) return clean(metadata.coverage_label); const batch=batches.find((item) => clean(item.id) === clean(artifact.batch_id)); return batch ? batchOption(batch) : metadata.from && metadata.through ? `${formatDate(metadata.from)} through ${formatDate(metadata.through)}` : 'Coverage was not recorded for this older export'; };
      return `<section class="fmp-export-intro"><div><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_d9207f2ac07c2a","Prepare payroll records") ?? "Prepare payroll records")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_7e5e7151e747b9","Choose one payroll run when you are paying workers or handing final numbers to your payroll provider. Choose a date range when your accountant or office needs activity across several payrolls. CSV files are best for spreadsheets and imports; PDFs are formatted for reading, sharing, or printing.") ?? "Choose one payroll run when you are paying workers or handing final numbers to your payroll provider. Choose a date range when your accountant or office needs activity across several payrolls. CSV files are best for spreadsheets and imports; PDFs are formatted for reading, sharing, or printing.")}</p></div><i class="fas fa-file-invoice-dollar" style="font-size:28px;color:#98a2b3"></i></section>
        <section class="fmp-export-builder"><div class="fmp-export-step">${(globalThis.PlatformLanguage?.htmlText("payroll","m_c189699a20e926","1. What should these reports cover?") ?? "1. What should these reports cover?")}</div><div class="fmp-export-mode"><button data-action="export-mode" data-mode="payroll_run" class="${String(state.exportMode === 'payroll_run' ? 'active' : '')}"><strong>${(globalThis.PlatformLanguage?.htmlText("payroll","m_155e03aed682c6","A specific payroll run") ?? "A specific payroll run")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_e6457fc3facbdb","Use for payroll processing, approval records, and provider handoff.") ?? "Use for payroll processing, approval records, and provider handoff.")}</span></button><button data-action="export-mode" data-mode="date_range" class="${String(state.exportMode === 'date_range' ? 'active' : '')}"><strong>${(globalThis.PlatformLanguage?.htmlText("payroll","m_0c55e913f098e3","A date range") ?? "A date range")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_f629af4c52c3ee","Use for bookkeeping, commissions, timesheets, and reimbursement review.") ?? "Use for bookkeeping, commissions, timesheets, and reimbursement review.")}</span></button></div>
        ${String(state.exportMode === 'payroll_run' ? (batches.length ? `<div class="fmp-export-selection"><div class="fmp-field"><label for="fmpExportBatch">${(globalThis.PlatformLanguage?.htmlText("payroll","m_8075e240b169cf","Payroll run") ?? "Payroll run")}</label><select id="fmpExportBatch">${batches.map((batch) => `<option value="${esc(batch.id)}" ${clean(batch.id) === clean(selectedBatch?.id) ? 'selected' : ''}>${esc(batchOption(batch))}</option>`).join('')}</select></div><button class="fmp-btn" data-action="create-all-exports" data-format="csv"><i class="fas fa-table"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_2cbe3b91007939"," Prepare all CSVs") ?? " Prepare all CSVs")}</button><button class="fmp-btn" data-action="create-all-exports" data-format="pdf"><i class="fas fa-print"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_a0690426e42dfc"," Prepare all PDFs") ?? " Prepare all PDFs")}</button></div>` : `<div class="fmp-diagnostic"><i class="fas fa-circle-info"></i><span><strong>${(globalThis.PlatformLanguage?.htmlText("payroll","m_95e5a181459c0f","There are no payroll runs to export yet.") ?? "There are no payroll runs to export yet.")}</strong>${(globalThis.PlatformLanguage?.htmlText("payroll","m_31a1ef86f4e30c"," Create a payroll batch first, then return here to select it.") ?? " Create a payroll batch first, then return here to select it.")}</span><button class="fmp-btn small" data-action="view" data-view="upcoming">${(globalThis.PlatformLanguage?.htmlText("payroll","m_4f7069fe2ff90f","Go to upcoming payroll") ?? "Go to upcoming payroll")}</button></div>`) : `<div class="fmp-export-selection"><div class="fmp-field"><label for="fmpExportFrom">${(globalThis.PlatformLanguage?.htmlText("payroll","m_8d1ab2a786950e","Start date") ?? "Start date")}</label><input id="fmpExportFrom" type="date" value="${esc(state.exportFrom)}"></div><div class="fmp-field"><label for="fmpExportThrough">${(globalThis.PlatformLanguage?.htmlText("payroll","m_75319fcfef3f5e","End date") ?? "End date")}</label><input id="fmpExportThrough" type="date" value="${esc(state.exportThrough)}" min="${esc(state.exportFrom)}"></div></div>`)}
        <div class="fmp-export-step" style="margin-top:18px">${(globalThis.PlatformLanguage?.htmlText("payroll","m_2dc0a7287892b3","2. Choose the records you need") ?? "2. Choose the records you need")}</div><div class="fmp-report-grid">${String(availableReports.map((report) => `<article class="fmp-report-card"><div><h3>${esc(report.label)}</h3><p>${esc(report.description)}<span class="fmp-report-purpose">${esc(report.purpose)}</span></p></div><div class="fmp-report-actions"><button class="fmp-btn small" data-action="create-export" data-export-type="${esc(report.type)}" data-format="csv" ${state.exportMode === 'payroll_run' && !selectedBatch ? 'disabled' : ''}><i class="fas fa-file-csv"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_9d0a9ac6e12896"," Download CSV") ?? " Download CSV")}</button><button class="fmp-btn small" data-action="create-export" data-export-type="${esc(report.type)}" data-format="pdf" ${state.exportMode === 'payroll_run' && !selectedBatch ? 'disabled' : ''}><i class="fas fa-file-pdf"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_932226afd1106e"," Download PDF") ?? " Download PDF")}</button></div></article>`).join(''))}</div></section>
        <div class="fmp-export-history-head"><div><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_6b2b4d7c5da0fa","Previously prepared reports") ?? "Previously prepared reports")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_700c117178092f","Coverage is shown here so you can tell exactly what each file contains before downloading it again.") ?? "Coverage is shown here so you can tell exactly what each file contains before downloading it again.")}</p></div><span style="font-size:11px;color:#667085;font-weight:800">${((v4,v5) => globalThis.PlatformLanguage?.htmlText("payroll","m_99071c28413a8e",`${v4} saved file${v5}`,{v4,v5}) ?? `${v4} saved file${v5}`)(artifacts.length,artifacts.length === 1 ? '' : 's')}</span></div>
        <div class="fmp-timesheet-table-wrap"><table class="fmp-timesheet-table"><thead><tr><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_c47c2ce6bb05c0","Report") ?? "Report")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_b59aa39327a43b","What it covers") ?? "What it covers")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_cdf11b397d38fc","Format") ?? "Format")}</th><th>${(globalThis.PlatformLanguage?.htmlText("payroll","m_984cc664c28b29","Prepared") ?? "Prepared")}</th><th></th></tr></thead><tbody>${String(artifacts.map((artifact) => { const format=clean(metadataFor(artifact).format || (clean(artifact.content_type).includes('pdf') ? 'pdf' : 'csv')); return `<tr><td><strong>${esc(reportName(artifact))}</strong><span class="fmp-file-name" title="${esc(artifact.file_name)}">${esc(artifact.file_name)}</span></td><td><strong>${esc(coverage(artifact))}</strong><br><small>${((v4,v5) => globalThis.PlatformLanguage?.htmlText("payroll","m_b1d072b88aab39",`${v4} record${v5}`,{v4,v5}) ?? `${v4} record${v5}`)(number(metadataFor(artifact).row_count),number(metadataFor(artifact).row_count) === 1 ? '' : 's')}</small></td><td><span class="fmp-file-format ${esc(format)}">${esc(format.toUpperCase())}</span></td><td>${esc(formatDateTime(artifact.created_at))}</td><td><a class="fmp-btn small" href="${esc(window.PayrollAPI.artifacts.downloadUrl(state.orgId, artifact.id))}" download><i class="fas fa-download"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_826f820584789d"," Download again") ?? " Download again")}</a></td></tr>`; }).join(''))}${String(!artifacts.length ? `<tr><td colspan="5">${(globalThis.PlatformLanguage?.htmlText("payroll","m_cb7a285d33e9b2","No reports have been prepared yet. Choose a report above to create the first one.") ?? "No reports have been prepared yet. Choose a report above to create the first one.")}</td></tr>` : '')}</tbody></table></div>`;
    }

    function bodyHtml(){
      if (state.view === 'timesheets') return timesheetsHtml();
      if (state.view === 'contractors') return contractorsHtml();
      if (state.view === 'exports') return exportsHtml();
      if (state.loading && !state.data) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-spinner fmp-spinner"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_d0469f4ea4c0cc","Loading payroll") ?? "Loading payroll")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_961537c1a70067","Building upcoming schedule groups and payroll previews.") ?? "Building upcoming schedule groups and payroll previews.")}</p></div>`;
      if (state.error && !state.data) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-triangle-exclamation"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_a805757c14ef68","Payroll could not load") ?? "Payroll could not load")}</h2><p>${String(esc(state.error.message || state.error))}</p><button class="fmp-btn primary" data-action="refresh"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_cbfbb44ff35f0f"," Try again") ?? " Try again")}</button></div>`;
      if (!array(state.data?.schedules).length) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-calendar-plus"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_af98d4fa763589","Create your first pay schedule") ?? "Create your first pay schedule")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_11167f4970bb3b","Payroll groups workers by schedule. Configure weekly, biweekly, semi-monthly, or monthly cycles here, then return to preview and run payroll.") ?? "Payroll groups workers by schedule. Configure weekly, biweekly, semi-monthly, or monthly cycles here, then return to preview and run payroll.")}</p><button class="fmp-btn primary" data-action="settings"><i class="fas fa-gear"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_00b847ae2b1181"," Configure payroll") ?? " Configure payroll")}</button></div>`;
      if (state.view === 'history') {
        const history = array(state.data?.history);
        if (!history.length) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-clock-rotate-left"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_df287cf95e8e63","No payroll history yet") ?? "No payroll history yet")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_100196122a2e0d","Created batches will appear here with their employee, subcontractor, run, and paid details.") ?? "Created batches will appear here with their employee, subcontractor, run, and paid details.")}</p><button class="fmp-btn" data-action="view" data-view="upcoming">${(globalThis.PlatformLanguage?.htmlText("payroll","m_f363a044460dbe","View upcoming payroll") ?? "View upcoming payroll")}</button></div>`;
        const scheduleMap = schedulesById();
        return `<div class="fmp-history">${history.map((batch) => historyCard(batch, scheduleMap)).join('')}</div>`;
      }
      const upcoming = array(state.data?.upcoming);
      if (!upcoming.length) return `<div class="fmp-state"><span class="state-icon"><i class="fas fa-calendar-xmark"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_04de86b118c040","No payroll dates in this range") ?? "No payroll dates in this range")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_21151a08806ec5","Choose a wider date range to see future payroll occurrences. You can look ahead as far as your planning horizon requires.") ?? "Choose a wider date range to see future payroll occurrences. You can look ahead as far as your planning horizon requires.")}</p><button class="fmp-btn" data-action="preset" data-days="365"><i class="fas fa-calendar-days"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_0ad0e2722333d3"," Show the next year") ?? " Show the next year")}</button></div>`;
      return `${diagnosticsHtml()}<div class="fmp-list">${upcoming.map(scheduleCard).join('')}</div>`;
    }

    function render(){
      if (state.destroyed) return;
      settingsController?.destroy?.();
      settingsController = null;
      if (state.view === 'settings') {
        root.innerHTML = '<div class="fmp-shell"><main class="fmp-content"><div data-payroll-settings-host></div></main></div>';
        const settingsHost = root.querySelector('[data-payroll-settings-host]');
        if (!window.FirstMatePayrollSettings?.mount) {
          settingsHost.innerHTML = `<div class="fmp-state"><span class="state-icon"><i class="fas fa-triangle-exclamation"></i></span><h2>${(globalThis.PlatformLanguage?.htmlText("payroll","m_46a683ef876bd0","Payroll settings could not load") ?? "Payroll settings could not load")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_c5efd7b69468f5","The payroll configuration bundle is unavailable.") ?? "The payroll configuration bundle is unavailable.")}</p><button class="fmp-btn" data-action="settings-back"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("payroll","m_a1209799a6f896"," Back to payroll") ?? " Back to payroll")}</button></div>`;
          return;
        }
        settingsController = window.FirstMatePayrollSettings.mount(settingsHost, {
          orgId:state.orgId,
          branchId:clean(state.context.branchId || window.__APP?.userBranchId || 'default'),
          routeTab:'payroll',
          routeHandlerId:`payroll-settings-view:${context.instanceId || 'main'}`,
          showToast:toast,
          onBack:closeSettings
        });
        return;
      }
      root.innerHTML = `<div class="fmp-shell">
        <header class="fmp-top">
          <div class="fmp-heading"><span class="fmp-heading-icon"><i class="fas fa-money-check-dollar"></i></span><span class="fmp-heading-copy"><h1>${(globalThis.PlatformLanguage?.htmlText("payroll","m_45e0abb75231e4","Payroll") ?? "Payroll")}</h1><p>${(globalThis.PlatformLanguage?.htmlText("payroll","m_bd05cc1ca9fa01","Accrued pay, forecasts, payroll batches, and payment status by schedule.") ?? "Accrued pay, forecasts, payroll batches, and payment status by schedule.")}</p></span></div>
          <div class="fmp-top-actions"><button class="fmp-btn" data-action="create-off-cycle"><i class="fas fa-calendar-plus"></i><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_7a7fb35aa48895","Off-cycle run") ?? "Off-cycle run")}</span></button><button class="fmp-btn" data-action="settings" title="${(globalThis.PlatformLanguage?.htmlText("payroll","m_86fa12758c2c13","Payroll settings") ?? "Payroll settings")}"><i class="fas fa-sliders"></i><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_7d461dc7d355cc","Settings") ?? "Settings")}</span></button><button class="fmp-btn" data-action="refresh" ${String(state.loading ? 'disabled' : '')}><i class="fas ${String(state.loading ? 'fa-spinner fmp-spinner' : 'fa-rotate')}"></i><span>${(globalThis.PlatformLanguage?.htmlText("payroll","m_78973ce0cf3403","Refresh") ?? "Refresh")}</span></button></div>
        </header>
        <main class="fmp-content">
          <div class="fmp-toolbar"><div class="fmp-segment"><button data-action="view" data-view="upcoming" class="${String(state.view === 'upcoming' ? 'active' : '')}">${String(esc(window.Portal?.terminology?.get?.('payroll.upcoming_view', 'Upcoming payroll') || 'Upcoming payroll'))}</button><button data-action="view" data-view="history" class="${String(state.view === 'history' ? 'active' : '')}">${String(esc(window.Portal?.terminology?.get?.('payroll.history_view', 'Batch history') || 'Batch history'))} <span style="color:#98a2b3">${String(array(state.data?.history).length)}</span></button></div><div style="font-size:11px;color:#667085;font-weight:800">${String(esc(formatDate(state.from)))} – ${String(esc(formatDate(state.through)))}</div></div>
          ${String(state.view === 'timesheets' ? timesheetRangeHtml() : ['contractors','exports'].includes(state.view) ? '' : rangeHtml())}
          ${String(state.view === 'timesheets' ? (state.timesheetData ? timesheetMetricsHtml() : '') : ['upcoming','history'].includes(state.view) && state.data ? metricsHtml() : '')}
          ${String(bodyHtml())}
        </main>
      </div>`;
      const segment = root.querySelector('.fmp-segment');
      const historyButton = segment?.querySelector('[data-view="history"]');
      if (segment && historyButton) {
        [['timesheets',`Timesheets <span style="color:#98a2b3">${number(state.timesheetData?.summary?.pending)}</span>`],['contractors','Contractors'],['exports',`Exports <span style="color:#98a2b3">${array(state.exportData?.artifacts).length}</span>`]].forEach(([view,label]) => { const control=document.createElement('button'); control.dataset.action='view'; control.dataset.view=view; control.className=state.view === view ? 'active' : ''; control.innerHTML=label; segment.insertBefore(control, historyButton); });
      }
    }

    async function load(options = {}){
      const token = ++state.loadToken;
      state.loading = true;
      state.error = null;
      if (!options.silent) render();
      try {
        if (!state.orgId) throw new Error('This payroll app needs an organization context.');
        const timesheetView = state.view === 'timesheets';
        const contractorView = state.view === 'contractors';
        const exportView = state.view === 'exports';
        const result = timesheetView
          ? await window.PayrollAPI?.timesheets?.list?.(state.orgId, { from:state.timesheetFrom, through:state.timesheetThrough, limit:500 })
          : contractorView ? await Promise.all([window.PlatformAPI.workforce.users(state.orgId, clean(state.context.branchId || 'default')), window.PlatformAPI.connections.list(state.orgId, { branchId:clean(state.context.branchId || 'default') })])
          : exportView ? await Promise.all([window.PayrollAPI.artifacts.catalog(state.orgId), window.PayrollAPI.artifacts.list(state.orgId, { limit:250 }), state.data ? Promise.resolve(state.data) : window.PayrollAPI.dashboard(state.orgId, { from:state.from, through:state.through, include_projected:state.includeProjected, history_limit:150 })])
          : (context.params?.smoke
            ? createSmokeData(state)
            : await window.PayrollAPI?.dashboard?.(state.orgId, { from:state.from, through:state.through, include_projected:state.includeProjected, history_limit:150 }));
        if (!result) throw new Error('PayrollAPI is unavailable. Load payroll-api.js before the payroll app bundle.');
        if (state.destroyed || token !== state.loadToken) return;
        if (timesheetView) state.timesheetData = result;
        else if (contractorView) state.contractorData = { users:array(result[0]?.users || result[0]), connections:array(result[1]?.connections || result[1]?.organization_connections || result[1]) };
        else if (exportView) { state.exportData={ catalog:array(result[0]?.exports || result[0]?.catalog || result[0]), artifacts:array(result[1]?.artifacts || result[1]) }; state.data=result[2]; const batches=array(result[2]?.history); if (!batches.some((batch) => clean(batch.id) === clean(state.selectedExportBatchId))) state.selectedExportBatchId=clean(batches[0]?.id); if (!batches.length) state.exportMode='date_range'; }
        else state.data = result;
        state.loadedAt = Date.now();
        const first = timesheetView || contractorView ? null : array((exportView ? result[2] : result).upcoming)[0];
        if (first && !state.expanded.size) state.expanded.add(occurrenceKey(first));
      } catch (error) {
        if (state.destroyed || token !== state.loadToken) return;
        state.error = error;
      } finally {
        if (!state.destroyed && token === state.loadToken) {
          state.loading = false;
          render();
        }
      }
    }

    async function perform(key, operation, successTitle, successDetail){
      if (state.busyKey) return;
      state.busyKey = key;
      render();
      try {
        await operation();
        toast(successTitle, successDetail, true);
        await load({ silent:true });
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("payroll","m_e9ff474f64ada3","Payroll action failed") ?? "Payroll action failed"), error?.message || String(error), false);
      } finally {
        state.busyKey = '';
        render();
      }
    }

    async function generateAndDownloadExport(payload){
      if (state.busyKey) return;
      state.busyKey=`export:${clean(payload.type)}:${clean(payload.format)}`;
      render();
      try {
        const result=await window.PayrollAPI.artifacts.create(state.orgId,payload);
        const artifact=result?.artifact;
        if (!artifact?.id) throw new Error('The report was prepared but no downloadable file was returned.');
        const link=document.createElement('a');
        link.href=window.PayrollAPI.artifacts.downloadUrl(state.orgId,artifact.id);
        link.download=clean(artifact.file_name);
        link.style.display='none';
        document.body.appendChild(link); link.click(); link.remove();
        toast(artifact.reused ? 'Existing report downloaded' : 'Report prepared and downloaded', artifact.reused ? 'The numbers and coverage matched a report already on file, so no duplicate was created.' : clean(object(artifact.metadata).coverage_label), true);
        await load({ silent:true });
      } catch (error) {
        toast((globalThis.PlatformLanguage?.text("payroll","m_aa85d9c3b3ddb4","Report could not be prepared") ?? "Report could not be prepared"), error?.message || String(error), false);
      } finally {
        state.busyKey=''; render();
      }
    }

    function openSettings(){
      if (window.Portal?.navigation?.navigate) {
        window.Portal.navigation.navigate({ tab:'payroll', payrollView:'settings', settingsView:null, settingsEntity:null }, {
          source:'payroll-settings', ownedKeys:['payrollView']
        });
      } else {
        state.view = 'settings';
        render();
      }
    }

    function closeSettings(){
      state.view = 'upcoming';
      window.Portal?.navigation?.replace?.({ tab:'payroll', payrollView:'upcoming', settingsView:null, settingsEntity:null }, {
        source:'payroll-settings-back', ownedKeys:['payrollView']
      });
      render();
      if (!state.data) load();
      void window.Portal?.navigation?.applyCurrent?.({ source:'payroll-settings-back', force:true });
    }

    async function onClick(event){
      const button = event.target.closest('[data-action]');
      if (!button || !root.contains(button)) return;
      const action = clean(button.dataset.action);
      if (action === 'refresh') { await load(); return; }
      if (action === 'settings') { openSettings(); return; }
      if (action === 'settings-back') { closeSettings(); return; }
      if (action === 'view') {
        const requested = clean(button.dataset.view);
        state.view = ['history','timesheets','contractors','exports'].includes(requested) ? requested : 'upcoming';
        if (!window.Portal?.navigation?.applying) window.Portal?.navigation?.push?.({ payrollView:state.view }, { source:'payroll-view', ownedKeys:['payrollView'] });
        render();
        if ((state.view === 'timesheets' && !state.timesheetData) || (state.view === 'contractors' && !state.contractorData) || (state.view === 'exports' && !state.exportData) || (!['timesheets','contractors','exports'].includes(state.view) && !state.data)) await load();
        return;
      }
      if (action === 'export-mode') {
        state.exportMode=clean(button.dataset.mode) === 'date_range' ? 'date_range' : 'payroll_run';
        render(); return;
      }
      if (action === 'save-worker-payee') {
        const userId=clean(button.dataset.userId); const classification=clean(root.querySelector(`[data-contractor-classification="${CSS.escape(userId)}"]`)?.value); const basis=clean(root.querySelector(`[data-contractor-basis="${CSS.escape(userId)}"]`)?.value); const netDays=number(root.querySelector(`[data-contractor-days="${CSS.escape(userId)}"]`)?.value);
        await perform(`worker:${userId}`, () => window.PlatformAPI.workforce.saveUserProfile(state.orgId, userId, { worker_classification:classification, payment_terms:{ basis, net_days:basis === 'net_days' ? netDays : 0 } }), 'Worker payment record saved', classification === 'employee' ? 'This person will be paid as an employee.' : 'This person will be paid as an independent contractor.'); return;
      }
      if (action === 'save-company-payee') {
        const connectionId=clean(button.dataset.connectionId); const connection=array(state.contractorData?.connections).find((item) => clean(item.id) === connectionId); const basis=clean(root.querySelector(`[data-connection-basis="${CSS.escape(connectionId)}"]`)?.value); const netDays=number(root.querySelector(`[data-connection-days="${CSS.escape(connectionId)}"]`)?.value);
        await perform(`company:${connectionId}`, () => window.PlatformAPI.connections.update(state.orgId, connectionId, { expected_revision:number(connection?.revision) || undefined, payment_terms:{ basis, net_days:basis === 'net_days' ? netDays : 0 } }), 'Subcontractor payment terms saved', basis === 'net_days' ? `Due net ${netDays}.` : 'Uses its assigned payment cycle.'); return;
      }
      if (action === 'create-export' || action === 'create-all-exports') {
        const batchId=clean(root.querySelector('#fmpExportBatch')?.value || state.selectedExportBatchId);
        const from=clean(root.querySelector('#fmpExportFrom')?.value || state.exportFrom); const through=clean(root.querySelector('#fmpExportThrough')?.value || state.exportThrough);
        if (state.exportMode === 'payroll_run' && !batchId) { toast((globalThis.PlatformLanguage?.text("payroll","m_bd8dee66726cce","Choose a payroll run") ?? "Choose a payroll run"), (globalThis.PlatformLanguage?.text("payroll","m_7ee93cc00027d8","Create or select the payroll these reports should cover.") ?? "Create or select the payroll these reports should cover."), false); return; }
        if (state.exportMode === 'date_range' && (!from || !through || through < from)) { toast((globalThis.PlatformLanguage?.text("payroll","m_b3e21deb231a02","Check the reporting dates") ?? "Check the reporting dates"), (globalThis.PlatformLanguage?.text("payroll","m_a668a43f42ae6e","The end date must be on or after the start date.") ?? "The end date must be on or after the start date."), false); return; }
        state.selectedExportBatchId=batchId; state.exportFrom=from; state.exportThrough=through;
        const payloadFor=(type,format) => state.exportMode === 'payroll_run' ? { type,format,batch_id:batchId } : { type,format,from,through };
        if (action === 'create-export') { await generateAndDownloadExport(payloadFor(clean(button.dataset.exportType),clean(button.dataset.format || 'csv'))); return; }
        const format=clean(button.dataset.format || 'csv'); const runReports=array(state.exportData?.catalog).filter((report) => ['payroll_run','payroll_run_or_date_range'].includes(clean(report.scope)));
        await perform(`export-package:${format}`, async () => { for (const report of runReports) await window.PayrollAPI.artifacts.create(state.orgId,payloadFor(clean(report.type),format)); }, `${format.toUpperCase()} payroll package prepared`, 'The reports are saved below. Repeated preparation will reuse files when the numbers have not changed.'); return;
      }
      if (action === 'create-off-cycle') {
        const schedules=array(state.data?.schedules); if (!schedules.length) { toast((globalThis.PlatformLanguage?.text("payroll","m_e5e4ec706cb78c","No pay schedule") ?? "No pay schedule"), (globalThis.PlatformLanguage?.text("payroll","m_46461ed38f2108","Create a payroll schedule before creating an off-cycle run.") ?? "Create a payroll schedule before creating an off-cycle run."), false); return; }
        const scheduleId=clean(window.prompt(`Schedule ID for the off-cycle run:\n${schedules.map((item) => `${item.name}: ${item.id}`).join('\n')}`, schedules[0].id)); if (!scheduleId) return;
        const payDate=clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_a9852246ab01b0","Off-cycle pay date (YYYY-MM-DD):") ?? "Off-cycle pay date (YYYY-MM-DD):"), dateKey())); if (!payDate) return; const reason=clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_12044b3e7b1eae","Reason for this off-cycle run:") ?? "Reason for this off-cycle run:"), 'Correction / special payment'));
        await perform('off-cycle', () => window.PayrollAPI.batches.create(state.orgId, { schedule_id:scheduleId, pay_date:payDate, run_type:'off_cycle', period_start:payDate, period_end:payDate, reason }), 'Off-cycle payroll created', `${formatDate(payDate)} · ${reason}`); return;
      }
      if (['approval-submit','approval-decide','approval-finalize','approval-reopen'].includes(action)) {
        const batchId=clean(button.dataset.batchId); let operation;
        if (action === 'approval-submit') { const users=array(state.contractorData?.users); const raw=clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_edf86ebf69a1b5","Named approver user IDs (comma-separated):") ?? "Named approver user IDs (comma-separated):"), clean(window.__APP?.userId || window.__APP?.user?.id))); if (!raw) return; const approvers=raw.split(',').map(clean).filter(Boolean).map((user_id) => { const person=users.find((item) => clean(item.id) === user_id); return { user_id, name:clean(person?.name || person?.display_name || person?.email || user_id) }; }); operation=() => window.PayrollAPI.batches.action(state.orgId,batchId,'submit_approval',{approvers}); }
        else if (action === 'approval-decide') operation=() => window.PayrollAPI.batches.action(state.orgId,batchId,'approve');
        else if (action === 'approval-finalize') operation=() => window.PayrollAPI.batches.action(state.orgId,batchId,'finalize');
        else { const okay=await confirmAction('Reopen this payroll run for corrections? Its unpaid items will be rebuilt from the currently eligible ledger, then named approval must be completed again.'); if (!okay) return; operation=() => window.PayrollAPI.batches.action(state.orgId,batchId,'reopen',{note:'Reopened and refreshed for correction'}); }
        await perform(`approval:${batchId}`, operation, action === 'approval-finalize' ? 'Payroll finalized' : action === 'approval-decide' ? 'Payroll approved' : action === 'approval-reopen' ? 'Payroll reopened' : 'Approval requested', `Batch ${batchId}`); return;
      }
      if (action === 'timesheet-preset') {
        state.timesheetThrough = dateKey();
        state.timesheetFrom = addDaysKey(state.timesheetThrough, -Math.max(1, number(button.dataset.days)));
        await load();
        return;
      }
      if (action === 'apply-timesheet-range') {
        const from = clean(root.querySelector('#fmpTimesheetFrom')?.value);
        const through = clean(root.querySelector('#fmpTimesheetThrough')?.value);
        if (!from || !through || through < from) { toast((globalThis.PlatformLanguage?.text("payroll","m_47300c8f100bea","Check the timesheet range") ?? "Check the timesheet range"), (globalThis.PlatformLanguage?.text("payroll","m_e03ae71c619ffa","The through date must be on or after the from date.") ?? "The through date must be on or after the from date."), false); return; }
        state.timesheetFrom = from; state.timesheetThrough = through;
        await load();
        return;
      }
      if (action === 'timesheet-approve') {
        const shift = array(state.timesheetData?.timesheets).find((item) => clean(item.id) === clean(button.dataset.shiftId));
        if (!shift) return;
        const okay = await confirmAction(`Approve ${clean(shift.user?.name || 'this worker')}'s ${formatDuration(shift.worked_seconds)} shift?\n\nApproval posts hourly earnings to the payroll ledger.`);
        if (!okay) return;
        await perform(`timesheet:${shift.id}:approve`, () => window.PayrollAPI.timesheets.approve(state.orgId, shift.id, { expected_revision:number(shift.revision) }), 'Timesheet approved', 'Hourly earnings were added to payroll.');
        return;
      }
      if (action === 'timesheet-reject') {
        const shift = array(state.timesheetData?.timesheets).find((item) => clean(item.id) === clean(button.dataset.shiftId));
        if (!shift) return;
        const note = clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_c1475fa89f3e57","Reason for rejecting this timesheet:") ?? "Reason for rejecting this timesheet:"), shift.manager_note || ''));
        if (!note) return;
        await perform(`timesheet:${shift.id}:reject`, () => window.PayrollAPI.timesheets.reject(state.orgId, shift.id, { expected_revision:number(shift.revision), manager_note:note }), 'Timesheet rejected', 'The shift will not be included in payroll until corrected and approved.');
        return;
      }
      if (action === 'timesheet-edit') {
        const shift = array(state.timesheetData?.timesheets).find((item) => clean(item.id) === clean(button.dataset.shiftId));
        if (!shift || clean(shift.status) === 'active') { toast((globalThis.PlatformLanguage?.text("payroll","m_ef784128f3fdd2","Timesheet is still active") ?? "Timesheet is still active"), (globalThis.PlatformLanguage?.text("payroll","m_f9f46c423f61bf","Clock the worker out before correcting the shift.") ?? "Clock the worker out before correcting the shift."), false); return; }
        const clockedIn = clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_cd991aa67db1ed","Clock-in timestamp (ISO 8601):") ?? "Clock-in timestamp (ISO 8601):"), shift.clocked_in_at));
        if (!clockedIn) return;
        const clockedOut = clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_8e852469bbc431","Clock-out timestamp (ISO 8601):") ?? "Clock-out timestamp (ISO 8601):"), shift.clocked_out_at));
        if (!clockedOut) return;
        const breakMinutes = Number(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_a206ef00d1fa3a","Unpaid break minutes:") ?? "Unpaid break minutes:"), String(Math.round(number(shift.break_seconds) / 60))));
        if (!Number.isFinite(breakMinutes) || breakMinutes < 0) return;
        const projectId = clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_ec7249ef30e71a","Project ID (optional):") ?? "Project ID (optional):"), shift.project_id || ''));
        const note = clean(window.prompt((globalThis.PlatformLanguage?.text("payroll","m_80dc7bf47d9149","Correction note:") ?? "Correction note:"), shift.manager_note || 'Manager correction'));
        await perform(`timesheet:${shift.id}:edit`, () => window.PayrollAPI.timesheets.update(state.orgId, shift.id, {
          expected_revision:number(shift.revision), clocked_in_at:clockedIn, clocked_out_at:clockedOut,
          break_seconds:Math.round(breakMinutes * 60), project_id:projectId, manager_note:note
        }), 'Timesheet corrected', 'The shift returned to pending review.');
        return;
      }
      if (action === 'toggle-projected') { state.includeProjected = !state.includeProjected; await load(); return; }
      if (action === 'preset') {
        state.from = dateKey();
        state.through = addDaysKey(state.from, Math.max(1, number(button.dataset.days)));
        state.expanded.clear();
        await load();
        return;
      }
      if (action === 'apply-range') {
        const from = clean(root.querySelector('#fmpRangeFrom')?.value);
        const through = clean(root.querySelector('#fmpRangeThrough')?.value);
        if (!from || !through || through < from) { toast((globalThis.PlatformLanguage?.text("payroll","m_c6703996cff386","Check the payroll range") ?? "Check the payroll range"), (globalThis.PlatformLanguage?.text("payroll","m_e03ae71c619ffa","The through date must be on or after the from date.") ?? "The through date must be on or after the from date."), false); return; }
        state.from = from; state.through = through; state.expanded.clear();
        await load();
        return;
      }
      if (action === 'toggle-schedule') {
        if (event.target.closest('[data-action]:not([data-action="toggle-schedule"])')) return;
        const key = clean(button.dataset.key);
        if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
        render();
        return;
      }
      if (action === 'toggle-history') {
        const key = clean(button.dataset.key);
        if (state.historyExpanded.has(key)) state.historyExpanded.delete(key); else state.historyExpanded.add(key);
        render();
        return;
      }
      if (action === 'create-batch') {
        const scheduleId = clean(button.dataset.scheduleId);
        const payDate = clean(button.dataset.payDate);
        const occurrence = array(state.data?.upcoming).find((item) => clean(item.schedule?.id) === scheduleId && clean(item.pay_date) === payDate);
        if (!occurrence) return;
        const okay = await confirmAction(`Create the ${clean(occurrence.schedule?.name || 'payroll')} batch for ${formatDate(payDate)}?\n\nOnly accrued earnings will be reserved in this batch. Projected earnings remain in the forecast until they accrue.`);
        if (!okay) return;
        await perform(`create:${occurrenceKey(occurrence)}`, () => window.PayrollAPI.batches.create(state.orgId, { schedule_id:scheduleId, pay_date:payDate }), 'Payroll batch created', `${occurrence.schedule?.name || 'Payroll'} · ${formatDate(payDate)}`);
        return;
      }
      if (action === 'item-action') {
        const batchId = clean(button.dataset.batchId);
        const itemId = clean(button.dataset.itemId);
        const nextStatus = clean(button.dataset.nextStatus) === 'paid' ? 'paid' : 'run';
        if (nextStatus === 'paid') {
          const okay = await confirmAction('Mark this payee as paid? This records the payment time and locks the item from further status changes.');
          if (!okay) return;
        }
        await perform(`item:${itemId}:${nextStatus}`, () => window.PayrollAPI.batches.updateItem(state.orgId, batchId, itemId, { status:nextStatus }), nextStatus === 'paid' ? 'Payee marked paid' : 'Payee marked run', 'The payroll batch status has been updated.');
        return;
      }
      if (action === 'batch-action') {
        const batchId = clean(button.dataset.batchId);
        const nextStatus = clean(button.dataset.nextStatus) === 'paid' ? 'paid' : 'run';
        const okay = await confirmAction(nextStatus === 'paid'
          ? 'Mark every unpaid payee in this batch as paid? Paid items are locked and the batch will be recorded in payroll history.'
          : 'Mark every draft payee in this batch as run? You can still mark workers paid individually afterward.');
        if (!okay) return;
        await perform(`batch:${batchId}:${nextStatus}`, () => window.PayrollAPI.batches.action(state.orgId, batchId, nextStatus), nextStatus === 'paid' ? 'Payroll marked paid' : 'Payroll run recorded', `Batch ${batchId}`);
      }
    }

    function onKeydown(event){
      if (!['Enter', ' '].includes(event.key)) return;
      const target = event.target.closest('[data-action="toggle-schedule"],[data-action="toggle-history"]');
      if (!target || !root.contains(target)) return;
      event.preventDefault();
      target.click();
    }

    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    const unregisterRoute = window.Portal?.navigation?.registerHandler?.(`payroll-view:${context.instanceId || 'main'}`, {
      priority:400,
      apply:(route) => {
        if (route.tab !== 'payroll') return;
        const routedView = clean(route.payrollView);
        const next = ['history','timesheets','contractors','exports','settings'].includes(routedView) ? routedView : 'upcoming';
        if (next !== state.view) {
          state.view = next;
          render();
          if (next !== 'settings' && ((next === 'timesheets' && !state.timesheetData) || (next === 'contractors' && !state.contractorData) || (next === 'exports' && !state.exportData) || (!['timesheets','contractors','exports'].includes(next) && !state.data))) load();
        }
      }
    });
    render();
    if (state.view !== 'settings') load();

    return {
      destroy(){
        state.destroyed = true;
        state.loadToken++;
        settingsController?.destroy?.();
        unregisterRoute?.();
        root.removeEventListener('click', onClick);
        root.removeEventListener('keydown', onKeydown);
        root.innerHTML = '';
      },
      setActive(active){
        if (active && Date.now() - state.loadedAt > 30000 && !state.loading) load({ silent:!!state.data });
      },
      update(nextContext = {}){
        const nextOrgId = clean(nextContext.orgId || nextContext.currentUser?.organization_id || state.orgId);
        if (nextOrgId && nextOrgId !== state.orgId) { state.orgId = nextOrgId; state.data = null; load(); }
      },
      refresh(){ return load(); }
    };
  }

  runtime.registerApp({
    id:'portal.payroll',
    package:'payroll',
    kind:'portal_tab',
    title:(globalThis.PlatformLanguage?.text("payroll","m_45e0abb75231e4","Payroll") ?? "Payroll"),
    label:(globalThis.PlatformLanguage?.text("payroll","m_45e0abb75231e4","Payroll") ?? "Payroll"),
    icon:'fa-money-check-dollar',
    order:55,
    surfaces:['portal_tab'],
    regions:['main'],
    visible:true,
    fullBleed:true,
    access:{
      applicationsAny:['management'],
      permissionsAny:['manage_payroll', 'manage_company_settings']
    },
    mount:createApp
  });
})();
