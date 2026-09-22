/* public/libraries/apps/crew/app.js
 * Assigned-work Crew experience. Visibility and parameters are resolved by the
 * shared embeddable-app entitlement runtime; this package never self-gates.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  const Portal = window.Portal;
  if (!runtime || !Portal) return;

  const clean = (value) => String(value ?? '').trim();
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const esc = (value) => runtime.escapeHtml ? runtime.escapeHtml(value) : clean(value).replace(/[&<>"']/g, '');
  const first = (...values) => values.find((value) => clean(value)) ?? '';
  const localDateKey = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const nowDate = () => localDateKey(new Date());
  const addLocalDays = (dateKey, days) => {
    const date = dateValue(dateKey) || new Date();
    date.setDate(date.getDate() + Number(days || 0));
    return localDateKey(date);
  };
  const orgId = (context = {}) => clean(context.orgId || window.__APP?.userOrgId || window.__APP?.orgId);
  const userId = (context = {}) => clean(context.currentUser?.id || context.user?.id || Portal.currentUser?.id || window.__APP?.userId || window.__APP?.user_id);
  const projectId = (context = {}) => clean(context.projectId || context.project?.id || context.entityId);
  const currency = (cents, empty = '$0.00') => {
    const amount = Number(cents);
    if (!Number.isFinite(amount)) return empty;
    return (amount / 100).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style:'currency', currency:'USD' });
  };
  const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
  const dateValue = (value) => {
    const text = clean(value);
    const parts = text.match(dateOnlyPattern);
    const date = value instanceof Date
      ? value
      : (parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : new Date(text));
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const shortDate = (value, fallback = '') => dateValue(value)?.toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' }) || fallback;
  const timeText = (value, fallback = '') => dateOnlyPattern.test(clean(value))
    ? fallback
    : (dateValue(value)?.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) || fallback);
  const durationText = (secondsValue) => {
    const seconds = Math.max(0, Math.floor(Number(secondsValue) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
  };
  const statusError = (error, fallback) => clean(error?.data?.message || error?.message || fallback || 'Something went wrong.');
  const responseRows = (result, ...keys) => {
    for (const key of keys) {
      const value = result?.[key] ?? result?.data?.[key] ?? result?.summary?.[key];
      if (Array.isArray(value)) return value;
    }
    return Array.isArray(result) ? result : [];
  };
  const showToast = (title, message, ok = true) => Portal.ui?.showToast?.(title, message, ok);
  const RECEIPT_ACCEPT = 'image/*,.pdf,.doc,.docx,.dot,.odt,.rtf,.pages,.xls,.xlsx,.csv,.tsv,.iif,.ppt,.pptx,.txt,.md,.json,.xml,.html,.htm,.eml,.mht,.tif,.tiff,.avif,.bmp,.heic,.heif';

  function clockLocationEvidence(){
    const capturedAt = new Date().toISOString();
    if (!window.isSecureContext) return Promise.resolve({ status:'unavailable', reason:'secure_context_required', captured_at:capturedAt });
    if (!navigator.geolocation?.getCurrentPosition) return Promise.resolve({ status:'unavailable', reason:'geolocation_unsupported', captured_at:capturedAt });
    return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        status:'captured',
        latitude:Number(position.coords.latitude),
        longitude:Number(position.coords.longitude),
        accuracy_meters:Number(position.coords.accuracy || 0),
        altitude_meters:Number.isFinite(Number(position.coords.altitude)) ? Number(position.coords.altitude) : null,
        captured_at:new Date(position.timestamp || Date.now()).toISOString()
      }),
      (error) => resolve({
        status:error?.code === 1 ? 'denied' : 'unavailable',
        reason:error?.code === 1 ? 'permission_denied' : error?.code === 3 ? 'timed_out' : 'position_unavailable',
        captured_at:new Date().toISOString()
      }),
      { enableHighAccuracy:true, timeout:8000, maximumAge:30000 }
    ));
  }

  const css = `
    .crew-shell{--crew-ink:#101828;--crew-muted:#667085;--crew-line:#e4e7ec;--crew-soft:#f6f8fb;min-height:100%;box-sizing:border-box;padding:clamp(14px,2.5vw,28px);background:linear-gradient(180deg,#f8fafc 0,#f3f6fa 100%);color:var(--crew-ink);font-family:inherit}
    .crew-page{width:min(1120px,100%);margin:0 auto;display:grid;gap:16px}.crew-page.narrow{width:min(760px,100%)}.crew-dashboard{display:grid;gap:16px}
    .crew-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}.crew-eyebrow{font-size:10px;font-weight:1000;letter-spacing:.1em;text-transform:uppercase;color:var(--primary-readable,var(--primary,#d93025))}.crew-title{margin:3px 0 0;font-size:clamp(24px,4vw,34px);line-height:1.06;font-weight:1000}.crew-sub{margin:5px 0 0;color:var(--crew-muted);font-size:13px;font-weight:800;line-height:1.4}
    .crew-btn{min-height:40px;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:#fff;color:#344054;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer;box-sizing:border-box}.crew-btn:hover{border-color:rgba(var(--primary-rgb,217,48,37),.32);color:var(--primary-readable,var(--primary,#d93025))}.crew-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 10px 24px rgba(var(--primary-rgb,217,48,37),.18)}.crew-btn.danger{border-color:#fecdca;color:#b42318;background:#fff5f4}.crew-btn.ghost{background:transparent}.crew-btn:disabled{opacity:.48;cursor:not-allowed;box-shadow:none}
    .crew-card{border:1px solid rgba(15,23,42,.085);border-radius:18px;background:#fff;box-shadow:0 12px 30px rgba(15,23,42,.055);padding:16px;box-sizing:border-box}.crew-card-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.crew-card-title h3{margin:0;font-size:14px;font-weight:1000}.crew-card-title small{color:var(--crew-muted);font-size:11px;font-weight:850}
    .crew-state{min-height:180px;display:grid;place-items:center;text-align:center;color:var(--crew-muted);padding:28px;box-sizing:border-box}.crew-state>div{display:grid;justify-items:center;gap:9px}.crew-state i{font-size:28px;color:#98a2b3}.crew-state strong{color:#344054}.crew-state.error i,.crew-state.error strong{color:#b42318}.crew-spinner{width:26px;height:26px;border:3px solid #e4e7ec;border-top-color:var(--primary,#d93025);border-radius:999px;animation:crew-spin .8s linear infinite}@keyframes crew-spin{to{transform:rotate(360deg)}}
    .crew-project-list{display:grid;gap:10px}.crew-project-tile{--scope-color:var(--primary,#d93025);position:relative;width:100%;border:1px solid rgba(15,23,42,.09);border-left:5px solid var(--scope-color);border-radius:16px;background:#fff;padding:14px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;text-align:left;color:inherit;cursor:pointer;box-shadow:0 8px 22px rgba(15,23,42,.04)}.crew-project-tile:hover{transform:translateY(-1px);box-shadow:0 13px 28px rgba(15,23,42,.09)}.crew-project-tile.overdue{background:linear-gradient(90deg,#fff7f6,#fff 34%);border-color:#fecdca;border-left-color:#d92d20}.crew-project-icon{width:44px;height:44px;border-radius:13px;background:color-mix(in srgb,var(--scope-color) 12%,#fff);color:var(--scope-color);display:grid;place-items:center;font-size:17px}.crew-project-copy{min-width:0;display:grid;gap:4px}.crew-project-copy strong{font-size:14px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crew-project-copy span{font-size:11px;font-weight:850;color:var(--crew-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crew-project-meta{display:grid;justify-items:end;gap:5px;white-space:nowrap}.crew-project-time{font-size:12px;font-weight:1000}.crew-day-count{display:inline-flex;align-items:center;gap:4px;border-radius:999px;background:#f2f4f7;color:#475467;padding:4px 8px;font-size:10px;font-weight:1000}.crew-day-count .late{color:#d92d20}.crew-overdue-label{color:#d92d20;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em}
    .crew-clock{position:sticky;bottom:max(10px,env(safe-area-inset-bottom));z-index:10;border:1px solid rgba(15,23,42,.11);border-radius:18px;background:rgba(255,255,255,.95);backdrop-filter:blur(16px);box-shadow:0 18px 48px rgba(15,23,42,.16);padding:11px 12px;display:flex;align-items:center;gap:12px}.crew-clock-main{min-width:0;flex:1;display:flex;align-items:center;gap:10px}.crew-clock-dot{width:11px;height:11px;border-radius:999px;background:#12b76a;box-shadow:0 0 0 5px #ecfdf3}.crew-clock-dot.break{background:#f79009;box-shadow:0 0 0 5px #fffaeb}.crew-clock-copy{min-width:0}.crew-clock-copy strong{display:block;font-size:12px;font-weight:1000}.crew-clock-copy span{display:block;margin-top:2px;color:var(--crew-muted);font-size:10px;font-weight:850}.crew-clock-time{font-size:17px;font-weight:1000;font-variant-numeric:tabular-nums}.crew-clock-actions{display:flex;align-items:center;gap:7px}
    .crew-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.crew-summary{border:1px solid var(--crew-line);border-radius:15px;background:#fff;padding:14px}.crew-summary span{display:block;color:var(--crew-muted);font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.crew-summary strong{display:block;margin-top:5px;font-size:20px;font-weight:1000}.crew-summary small{display:block;margin-top:3px;color:var(--crew-muted);font-size:10px;font-weight:800}[data-earnings],[data-project-earnings]{display:grid;align-content:start;gap:16px}
    .crew-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.crew-search{flex:1;min-width:210px;height:42px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;padding:0 13px;font:inherit;font-size:13px;font-weight:850;color:var(--crew-ink);outline:none}.crew-search:focus,.crew-field input:focus,.crew-field select:focus,.crew-field textarea:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}.crew-chips{display:flex;gap:6px;overflow-x:auto}.crew-chip{height:36px;border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:0 12px;font-size:11px;font-weight:1000;white-space:nowrap;cursor:pointer}.crew-chip.active{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.07);color:var(--primary-readable,var(--primary,#d93025))}
    .crew-schedule-shell{height:100%;min-height:0;overflow:hidden}.crew-schedule-page{width:100%;height:100%;min-height:0;margin:0;display:block}.crew-schedule-calendar{height:100%;min-height:0;overflow:hidden}.crew-schedule-calendar>.prs-wrap{height:100%;min-height:0}.crew-schedule-calendar .prs-wrap.list-mode .prs-list{padding:16px;box-sizing:border-box}
    .crew-row-list{display:grid;gap:8px}.crew-row{border:1px solid var(--crew-line);border-radius:14px;background:#fff;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}.crew-row-copy{min-width:0}.crew-row-copy strong{display:block;font-size:12px;font-weight:1000}.crew-row-copy span{display:block;margin-top:3px;color:var(--crew-muted);font-size:10px;font-weight:850}.crew-row-value{text-align:right;font-size:13px;font-weight:1000}.crew-row-value small{display:block;color:var(--crew-muted);font-size:9px;margin-top:3px}.crew-row-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap}.crew-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:#f2f4f7;color:#475467;padding:4px 8px;font-size:9px;font-weight:1000;text-transform:uppercase}.crew-pill.good{background:#ecfdf3;color:#067647}.crew-pill.warn{background:#fffaeb;color:#b54708}.crew-pill.bad{background:#fef3f2;color:#b42318}
    .crew-form{display:grid;gap:11px}.crew-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.crew-field{display:grid;gap:5px;color:var(--crew-muted);font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em}.crew-field.wide{grid-column:1/-1}.crew-field input,.crew-field select,.crew-field textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:11px;background:#fff;color:var(--crew-ink);padding:10px 11px;font:inherit;font-size:12px;font-weight:850;text-transform:none;letter-spacing:0;outline:none}.crew-field textarea{min-height:82px;resize:vertical}.crew-form-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.crew-inline-form{display:none}.crew-inline-form.open{display:grid}
    .crew-project-app{height:100%;min-height:0;overflow:auto;background:#f5f7fa}.crew-project-page{min-height:100%;box-sizing:border-box;padding:clamp(14px,2.5vw,24px);display:grid;align-content:start;gap:14px}.crew-project-page>.crew-page{margin:0 auto}.crew-overview-card{display:grid;gap:14px}.crew-overview-top{display:flex;align-items:center;gap:12px}.crew-overview-top .crew-project-icon{width:46px;height:46px;border-radius:14px;font-size:18px;flex:none}.crew-overview-title{margin:2px 0 0;font-size:clamp(18px,3.4vw,23px);font-weight:1000;line-height:1.15}.crew-info-rows{display:grid;border:1px solid var(--crew-line);border-radius:14px;overflow:hidden}.crew-info-row{display:flex;align-items:center;gap:11px;padding:11px 12px;background:#fff;border-top:1px solid #eef0f3;color:inherit;text-decoration:none}.crew-info-row:first-child{border-top:0}.crew-info-row>i{width:30px;height:30px;border-radius:9px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:12px;flex:none}.crew-info-copy{min-width:0}.crew-info-copy span{display:block;color:var(--crew-muted);font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.crew-info-copy strong{display:block;margin-top:2px;font-size:12px;font-weight:950;overflow-wrap:anywhere}a.crew-info-row:hover{background:#f8fafc}.crew-info-action{margin-left:auto;color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:1000;white-space:nowrap}.crew-notes{white-space:pre-wrap;line-height:1.55;color:#344054;font-size:13px;font-weight:750}
    .crew-material-list{display:grid;gap:8px}[data-material-lists]{display:grid;gap:16px}.crew-material-label{margin:14px 0 0;color:var(--crew-muted);font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em}.crew-material-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.crew-material-head h3{margin:0;font-size:14px}.crew-material-items{display:grid;gap:0;border:1px solid var(--crew-line);border-radius:13px;overflow:hidden}.crew-material-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:10px 11px;background:#fff;border-top:1px solid #eef0f3}.crew-material-item:first-child{border-top:0}.crew-material-item strong,.crew-material-item span{display:block}.crew-material-item strong{font-size:11px}.crew-material-item span{margin-top:2px;color:var(--crew-muted);font-size:10px;font-weight:850}.crew-material-item b{font-size:11px}.crew-receipt-review{display:grid;gap:8px}.crew-receipt-line{display:grid;grid-template-columns:auto minmax(0,1fr) 92px;gap:8px;align-items:center;border:1px solid var(--crew-line);border-radius:11px;padding:8px;background:#fff}.crew-receipt-line input[type=checkbox]{width:18px;height:18px;accent-color:var(--primary,#d93025)}.crew-receipt-line input[type=text],.crew-receipt-line input[type=number]{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:8px;padding:8px;font:inherit;font-size:11px;font-weight:850}
    .crew-icon-btn{width:34px;height:34px;border:1px solid var(--crew-line);border-radius:10px;background:#fff;color:#667085;display:grid;place-items:center;cursor:pointer}.crew-icon-btn.danger{color:#b42318}
    .crew-todo-list{display:grid;gap:8px}.crew-todo-item{display:flex;align-items:center;gap:11px;border:1px solid var(--crew-line);border-radius:14px;background:#fff;padding:11px 12px;transition:background .25s,border-color .2s}.crew-todo-item.done{background:#fbfefc}.crew-todo-item.priority{border-left:3px solid #d92d20;background:linear-gradient(90deg,#fff7f6,#fff 40%)}.crew-todo-copy{min-width:0;flex:1}.crew-todo-copy strong{display:block;font-size:12px;font-weight:950}.crew-todo-item.done .crew-todo-copy strong{color:#98a2b3;text-decoration:line-through}.crew-todo-copy span{display:block;margin-top:2px;color:var(--crew-muted);font-size:9px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crew-todo-flag{color:#d92d20;font-size:9px;margin-right:4px;vertical-align:1px}.crew-todo-due{flex:none;font-size:10px;font-weight:1000;color:#475467;white-space:nowrap}.crew-todo-due.past{color:#d92d20}.crew-todo-item.done .crew-cl-check{background:#12b76a;border-color:#12b76a}.crew-todo-item.done .crew-cl-check i{opacity:1;transform:scale(1)}
    .crew-overview-strip{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap}.crew-strip-chip{flex:1 1 200px;min-width:0;display:flex;align-items:center;gap:9px;border:1px solid var(--crew-line);border-radius:13px;background:#fff;padding:10px 11px;color:inherit;text-decoration:none}.crew-strip-chip>i{width:28px;height:28px;border-radius:9px;background:#f2f4f7;color:#475467;display:grid;place-items:center;font-size:11px;flex:none}.crew-strip-copy{min-width:0}.crew-strip-copy span{display:block;color:var(--crew-muted);font-size:8px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.crew-strip-copy strong{display:block;margin-top:1px;font-size:11px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}a.crew-strip-chip:hover{background:#f8fafc}
    .crew-cl-stack{display:grid;gap:16px}.crew-cl-head{display:flex;align-items:center;gap:11px}.crew-cl-icon{width:38px;height:38px;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));display:grid;place-items:center;font-size:15px;flex:none}.crew-cl-icon.supervisor{background:#eff8ff;color:#175cd3}.crew-cl-copy{min-width:0;flex:1}.crew-cl-copy h3{margin:0;font-size:14px;font-weight:1000}.crew-cl-copy span{display:block;margin-top:2px;color:var(--crew-muted);font-size:10px;font-weight:850}.crew-cl-progress{display:grid;justify-items:end;gap:5px;flex:none}.crew-cl-count{font-size:11px;font-weight:1000;color:#475467;font-variant-numeric:tabular-nums}.crew-cl-bar{width:74px;height:6px;border-radius:999px;background:#eef1f5;overflow:hidden}.crew-cl-bar i{display:block;height:100%;border-radius:999px;background:#12b76a;transition:width .45s cubic-bezier(.22,1,.36,1)}
    .crew-cl-meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}
    .crew-cl-items{margin-top:10px;display:grid;gap:8px}.crew-cl-item{border:1px solid var(--crew-line);border-radius:14px;background:#fff;transition:border-color .2s,background .25s}.crew-cl-item.done{background:#fbfefc}.crew-cl-item.bad{border-color:#fecdca}
    .crew-cl-main{display:flex;align-items:center;gap:11px;padding:11px 12px}
    .crew-cl-check{width:24px;height:24px;flex:none;border:2px solid #d0d5dd;border-radius:8px;background:#fff;display:grid;place-items:center;color:#fff;font-size:11px;cursor:pointer;padding:0;transition:background .18s,border-color .18s,transform .12s}.crew-cl-check:active{transform:scale(.88)}.crew-cl-item.done .crew-cl-check{background:#12b76a;border-color:#12b76a}.crew-cl-check i{opacity:0;transform:scale(.4);transition:opacity .15s,transform .22s cubic-bezier(.34,1.56,.64,1)}.crew-cl-item.done .crew-cl-check i{opacity:1;transform:scale(1)}.crew-cl-check:disabled{cursor:not-allowed;opacity:.55}
    .crew-cl-item-copy{min-width:0;flex:1}.crew-cl-item-copy strong{display:block;font-size:12px;font-weight:950;transition:color .2s}.crew-cl-item.done.is-todo .crew-cl-item-copy strong{color:#98a2b3;text-decoration:line-through}.crew-cl-item-copy span{display:block;margin-top:2px;color:var(--crew-muted);font-size:9px;font-weight:850}
    .crew-cl-rate{display:inline-flex;flex:none;border:1px solid var(--crew-line);border-radius:999px;padding:3px;gap:3px;background:#f8fafc}.crew-cl-rate button{width:34px;height:28px;border:0;border-radius:999px;background:transparent;color:#98a2b3;display:grid;place-items:center;font-size:12px;cursor:pointer;padding:0;transition:background .18s,color .18s,transform .12s}.crew-cl-rate button:active{transform:scale(.9)}.crew-cl-rate button.on[data-cl-rate=good]{background:#12b76a;color:#fff}.crew-cl-rate button.on[data-cl-rate=neutral]{background:#f79009;color:#fff}.crew-cl-rate button.on[data-cl-rate=bad]{background:#d92d20;color:#fff}.crew-cl-rate button:disabled{cursor:not-allowed;opacity:.5}
    .crew-cl-note-line{display:flex;gap:7px;align-items:flex-start;margin:0 12px 10px;padding:9px 10px;border-radius:10px;background:#f8fafc;color:#475467;font-size:11px;font-weight:800;line-height:1.45;cursor:pointer}.crew-cl-item.bad .crew-cl-note-line{background:#fef3f2;color:#b42318}
    .crew-cl-drawer{display:grid;grid-template-rows:0fr;transition:grid-template-rows .28s cubic-bezier(.22,1,.36,1)}.crew-cl-drawer.open{grid-template-rows:1fr}.crew-cl-drawer>div{overflow:hidden}.crew-cl-drawer-inner{display:grid;gap:8px;padding:2px 12px 12px}.crew-cl-drawer-inner textarea{width:100%;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:11px;padding:9px 10px;font:inherit;font-size:12px;font-weight:800;min-height:64px;resize:vertical;outline:none}.crew-cl-drawer-inner textarea:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}.crew-cl-drawer-hint{color:#b42318;font-size:10px;font-weight:900}.crew-cl-drawer-actions{display:flex;justify-content:flex-end;gap:7px}
    .crew-cl-evidence{display:grid;gap:7px;margin:0 12px 10px;padding-top:2px}.crew-cl-evidence.hint{border-radius:12px;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.1)}.crew-cl-requirement{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:8px;border:1px solid #e4e7ec;border-radius:11px;background:#f8fafc;padding:7px 8px;transition:border-color .18s,background .18s}.crew-cl-requirement.met{border-color:#abefc6;background:#ecfdf3}.crew-cl-requirement.missing{border-color:#fecdca;background:#fff}.crew-cl-requirement>i{width:28px;height:28px;border-radius:8px;background:#fff;color:#667085;display:grid;place-items:center;font-size:11px;box-shadow:0 1px 2px rgba(16,24,40,.06)}.crew-cl-requirement.met>i{color:#067647}.crew-cl-requirement-copy{min-width:0}.crew-cl-requirement-copy strong{display:block;font-size:10px;font-weight:950}.crew-cl-requirement-copy span{display:block;margin-top:1px;color:#667085;font-size:8px;font-weight:850}.crew-cl-upload{min-height:29px;border:1px solid rgba(var(--primary-rgb,217,48,37),.22);border-radius:8px;background:#fff;color:var(--primary-readable,var(--primary,#d93025));padding:0 9px;display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:9px;font-weight:1000;cursor:pointer}.crew-cl-upload:disabled{opacity:.5;cursor:wait}.crew-cl-upload i{font-size:9px}.crew-cl-record{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}.crew-cl-evidence-recorder:empty{display:none}.crew-cl-evidence-recorder .fm-an-inline{margin-top:0}.crew-cl-recording-process{min-height:50px;border:1px solid #e4e7ec;border-radius:10px;background:#f8fafc;color:#475467;display:flex;align-items:center;justify-content:center;gap:7px;font-size:9px;font-weight:950}.crew-cl-recording-process i{color:var(--primary-readable,var(--primary,#d93025))}.crew-cl-evidence-hint{display:flex;align-items:center;gap:6px;color:#b42318;font-size:9px;font-weight:900}.crew-cl-evidence-files{display:flex;gap:5px;flex-wrap:wrap}.crew-cl-evidence-file{max-width:180px;border-radius:999px;background:#f2f4f7;color:#475467;padding:4px 7px;display:inline-flex;align-items:center;gap:5px;font-size:8px;font-weight:850}.crew-cl-evidence-file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .crew-cl-actions{display:flex;gap:5px;flex:none}
    .crew-cl-add{margin-top:10px;display:flex;gap:8px}.crew-cl-add input{flex:1;min-width:0;height:38px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:11px;padding:0 11px;font:inherit;font-size:12px;font-weight:850;outline:none}.crew-cl-add input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.08)}.crew-cl-add select{height:38px;border:1px solid #d0d5dd;border-radius:11px;background:#fff;font:inherit;font-size:11px;font-weight:900;padding:0 8px}
    .crew-modal-back{position:fixed;inset:0;z-index:2147483500;background:rgba(15,23,42,.58);backdrop-filter:blur(7px);display:grid;place-items:center;padding:18px}.crew-modal{position:relative;width:min(560px,100%);max-height:min(760px,calc(100dvh - 36px));overflow:auto;border-radius:24px;background:#fff;box-shadow:0 32px 90px rgba(15,23,42,.32);padding:22px;box-sizing:border-box;display:grid;gap:16px}.crew-modal-close{position:absolute;right:12px;top:12px;width:38px;height:38px;border:0;border-radius:12px;background:#f2f4f7;color:#475467;display:grid;place-items:center;cursor:pointer}.crew-modal h2{margin:0;padding-right:42px;font-size:24px}.crew-shift-hero{display:grid;justify-items:center;text-align:center;gap:8px;padding:18px 8px}.crew-shift-hero i{width:58px;height:58px;border-radius:18px;background:#ecfdf3;color:#067647;display:grid;place-items:center;font-size:24px}.crew-shift-hero strong{font-size:30px}.crew-reminders{display:grid;gap:7px}.crew-reminder{display:flex;gap:9px;align-items:flex-start;border-radius:12px;background:#fffaeb;color:#7a2e0e;padding:10px;font-size:11px;font-weight:850;line-height:1.4}
    .crew-co-lines{display:grid;gap:7px}.crew-co-line{display:grid;grid-template-columns:minmax(0,1fr) 82px 108px 34px;gap:7px;align-items:end;border:1px solid var(--crew-line);border-radius:12px;padding:9px}.crew-co-line .crew-field{min-width:0}
    .crew-earnings-breakdown{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px}.crew-earnings-breakdown span{font-size:9px;font-weight:900;color:var(--crew-muted)}.crew-earnings-note{border:1px solid #b2ddff;border-radius:13px;background:#eff8ff;color:#175cd3;padding:10px 12px;font-size:10px;font-weight:850;line-height:1.45}.crew-earning-kind{text-transform:capitalize}
    .crew-receipt-batch{display:grid;gap:7px;margin-top:12px}.crew-receipt-batch-item{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;border:1px solid var(--crew-line);border-radius:11px;background:#f8fafc;padding:9px}.crew-receipt-batch-item>i{width:28px;height:28px;border-radius:8px;background:#fff;color:#667085;display:grid;place-items:center}.crew-receipt-batch-item.ready>i{background:#ecfdf3;color:#067647}.crew-receipt-batch-item.error>i{background:#fef3f2;color:#b42318}.crew-receipt-batch-copy{min-width:0}.crew-receipt-batch-copy strong,.crew-receipt-batch-copy span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.crew-receipt-batch-copy strong{font-size:11px}.crew-receipt-batch-copy span{margin-top:2px;color:var(--crew-muted);font-size:9px;font-weight:850}.crew-receipt-batch-item .crew-btn{min-height:32px;padding:0 9px;font-size:10px}
    @media(max-width:720px){.crew-shell{padding:12px 10px calc(18px + env(safe-area-inset-bottom))}.crew-page,.crew-dashboard{gap:12px}.crew-card{border-radius:15px;padding:13px}.crew-project-tile{grid-template-columns:auto minmax(0,1fr);padding:12px}.crew-project-meta{grid-column:2;grid-row:2;justify-items:start;display:flex;align-items:center;gap:6px}.crew-project-copy strong{font-size:13px}.crew-clock{align-items:stretch;flex-wrap:wrap}.crew-clock-main{min-width:180px}.crew-clock-actions{width:100%;display:grid;grid-template-columns:1fr 1fr}.crew-clock-actions .crew-btn:only-child{grid-column:1/-1}.crew-summary-grid{grid-template-columns:1fr 1fr}.crew-summary:first-child{grid-column:1/-1}.crew-form-grid{grid-template-columns:1fr}.crew-field.wide{grid-column:auto}.crew-row.has-actions{align-items:flex-start;flex-wrap:wrap}.crew-row.has-actions .crew-row-copy{flex:1 1 180px}.crew-row.has-actions .crew-row-actions{width:100%;justify-content:flex-start}.crew-row.has-actions .crew-row-actions .crew-row-value{margin-right:auto;text-align:left}.crew-project-page{padding:10px}.crew-modal-back{padding:0}.crew-modal{width:100%;height:100dvh;max-height:none;border-radius:0;padding:calc(20px + env(safe-area-inset-top)) 16px calc(20px + env(safe-area-inset-bottom))}.crew-co-line{grid-template-columns:minmax(0,1fr) 72px}.crew-co-line .crew-field:nth-child(3){grid-column:1/-1}.crew-co-line>.crew-icon-btn{grid-column:2;grid-row:2}.crew-receipt-line{grid-template-columns:auto minmax(0,1fr)}.crew-receipt-line input[type=number]{grid-column:2}.crew-schedule-shell{padding:6px 5px calc(6px + env(safe-area-inset-bottom))}.crew-schedule-calendar .prs-wrap.list-mode .prs-list{padding:12px}}
  `;
  Portal.util?.injectCSS?.('crew_apps', css);

  function stateHtml(kind = 'loading', message = ''){
    if (kind === 'loading') return `<div class="crew-state"><div><span class="crew-spinner"></span><strong>${esc(message || 'Loading')}</strong></div></div>`;
    const icon = kind === 'error' ? 'fa-triangle-exclamation' : 'fa-calendar-check';
    return `<div class="crew-state ${kind === 'error' ? 'error' : ''}"><div><i class="fas ${icon}"></i><strong>${esc(message || 'Nothing here yet.')}</strong></div></div>`;
  }

  function receiptBatchHtml(itemsValue, options = {}){
    const items = arr(itemsValue);
    if (!items.length) return '';
    return `<div class="crew-receipt-batch">${items.map((item) => {
      const receipt = obj(item.receipt);
      const status = clean(item.status || 'queued');
      const icon = status === 'ready' ? 'fa-check' : status === 'error' ? 'fa-triangle-exclamation' : status === 'uploading' ? 'fa-circle-notch fa-spin' : 'fa-clock';
      const detail = status === 'ready' ? `${receipt.total_cents ? currency(receipt.total_cents) : 'Total needs review'} · AI categorized` : status === 'error' ? clean(item.error) : status === 'uploading' ? 'Uploading and categorizing…' : 'Waiting for an upload slot';
      const action = options.review && status === 'ready' ? ("<button type=\"button\" class=\"crew-btn\" data-crew-batch-review=\"" + String(esc(receipt.id)) + "\">" + (globalThis.PlatformLanguage?.text("crew","m_b0bb1e74e2a6d3","Review") ?? "Review") + "</button>") : '';
      return `<div class="crew-receipt-batch-item ${esc(status)}"><i class="fas ${icon}"></i><div class="crew-receipt-batch-copy"><strong>${esc(first(receipt.title, receipt.extraction?.vendor_name, item.file_name, 'Receipt'))}</strong><span>${esc(detail)}</span></div>${action}</div>`;
    }).join('')}</div>`;
  }

  function projectFields(rowValue = {}){
    const row = obj(rowValue);
    const project = obj(row.project || row.project_data || row.data);
    const source = Object.keys(project).length ? { ...row, ...project } : row;
    const scope = obj(source.scope || source.scope_summary || arr(source.scopes)[0]);
    // API tiles include both the raw work event and a normalized schedule. Keep
    // the raw-event fallbacks, but let normalized schedule fields (including
    // computed day_number/total_days) win when both shapes are present.
    const assignment = { ...obj(source.event), ...obj(source.assignment), ...obj(source.schedule) };
    const day = obj(source.day || source.day_progress);
    const visibleProjectNotes = window.Portal?.ProjectNotes?.visible?.(source, { groups:['crew'] }) || [];
    const projectNoteText = visibleProjectNotes.map((note) => clean(note.text)).filter(Boolean).join('\n\n');
    return {
      raw:source,
      id:clean(first(source.project_id, source.id, project.id)),
      title:clean(first(source.title, source.project_title, source.project_name, source.customer_name, source.address, 'Project')),
      address:clean(first(source.address, source.project_address)),
      customer:clean(first(source.customer_name, source.primary_contact_name, obj(arr(source.contacts)[0]).name)),
      phone:clean(first(source.customer_phone, source.primary_contact_phone, obj(arr(source.contacts)[0]).phone)),
      notes:clean(first(projectNoteText, source.notes, typeof source.project_notes === 'string' ? source.project_notes : '', source.internal_notes, source.description)),
      scopeName:clean(first(scope.name, scope.title, source.scope_name, source.project_type, 'Project')),
      scopeIcon:clean(first(scope.icon, source.scope_icon, 'fa-hammer')).replace(/^fas?\s+/, ''),
      scopeColor:clean(first(scope.color, source.scope_color, '#667085')),
      overdue:source.overdue === true || assignment.overdue === true || clean(source.bucket) === 'overdue',
      hasTime:source.has_specific_time === true || assignment.has_specific_time === true || assignment.specific_time === true || (!source.all_day && assignment.all_day !== true && !!first(source.start_at, assignment.start_at)),
      startAt:clean(first(source.start_at, assignment.start_at, source.starts_at)),
      endAt:clean(first(source.end_at, assignment.end_at)),
      dayIndex:Math.max(0, Number(first(source.day_index, source.current_day, assignment.day_number, day.current, day.index)) || 0),
      dayTotal:Math.max(0, Number(first(source.day_total, source.total_days, assignment.total_days, day.total)) || 0),
      status:clean(first(source.status, assignment.status)),
      payoutCents:Number(first(source.payout_cents, source.projected_cents, source.amount_cents)) || 0
    };
  }

  function projectTile(rowValue, options = {}){
    const row = projectFields(rowValue);
    const dayIndex = row.dayIndex || 1;
    const dayTotal = row.dayTotal || 1;
    const meta = row.hasTime && row.startAt
      ? `<span class="crew-project-time">${esc(timeText(row.startAt))}</span>`
      : `<span class="crew-day-count"><span class="${String(row.overdue || dayIndex > dayTotal ? 'late' : '')}">${String(esc(dayIndex))}</span>${((v2) => globalThis.PlatformLanguage?.text("crew","m_3b067069408773",`/${v2} days`,{v2}) ?? `/${v2} days`)(esc(dayTotal))}</span>`;
    return `<button type="button" class="crew-project-tile ${row.overdue ? 'overdue' : ''}" data-crew-project="${esc(row.id)}" style="--scope-color:${esc(row.scopeColor)}">
      <span class="crew-project-icon"><i class="fas ${esc(row.scopeIcon)}"></i></span>
      <span class="crew-project-copy"><strong>${esc(row.title)}</strong><span>${esc(row.address || row.scopeName)}</span></span>
      <span class="crew-project-meta">${meta}${row.overdue ? `<span class="crew-overdue-label">${(globalThis.PlatformLanguage?.text("crew","m_cda60f7c71e465","Overdue") ?? "Overdue")}</span>` : ''}${options.showPayout && row.payoutCents ? `<span class="crew-pill good">${esc(currency(row.payoutCents))}</span>` : ''}</span>
    </button>`;
  }

  function openProject(rowValue, tab = 'crew_overview'){
    const row = projectFields(rowValue);
    const project = { ...row.raw, id:row.id, title:row.title, address:row.address, customer_name:row.customer, customer_phone:row.phone, notes:row.notes };
    Portal.modules?.request?.openProject?.(project, { tab });
  }

  function bindProjectTiles(root, rows, tab = 'crew_overview'){
    root.querySelectorAll('[data-crew-project]').forEach((button) => button.addEventListener('click', () => {
      const row = rows.find((item) => projectFields(item).id === button.dataset.crewProject);
      if (row) openProject(row, tab);
    }));
  }

  function modal(content, onClose){
    const back = document.createElement('div');
    back.className = 'crew-modal-back';
    back.innerHTML = `<div class="crew-modal" role="dialog" aria-modal="true">${String(content)}<button type="button" class="crew-modal-close" aria-label="${(globalThis.PlatformLanguage?.text("crew","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></div>`;
    const close = () => { back.remove(); onClose?.(); };
    back.querySelector('.crew-modal-close')?.addEventListener('click', close);
    back.addEventListener('click', (event) => { if (event.target === back) close(); });
    document.body.appendChild(back);
    return { el:back, close };
  }

  function activeShiftSeconds(clockValue = {}){
    const clock = obj(clockValue);
    const status = clean(clock.status).toLowerCase();
    const active = clock.active === true || ['active','clocked_in','working','on_break','break'].includes(status);
    const onBreak = ['on_break','break'].includes(status) || clock.on_break === true || !!clock.active_break_started_at;
    const observedAt = Number(clock._client_observed_at || 0);
    const observedWorked = Number(clock._client_worked_seconds);
    if (active && Number.isFinite(observedWorked) && observedAt > 0) {
      const liveSeconds = onBreak ? 0 : Math.max(0, Math.floor((Date.now() - observedAt) / 1000));
      return Math.max(0, observedWorked + liveSeconds);
    }
    if (Number.isFinite(Number(clock.worked_seconds))) return Math.max(0, Number(clock.worked_seconds));
    if (Number.isFinite(Number(clock.active_seconds))) return Math.max(0, Number(clock.active_seconds));
    const start = dateValue(first(clock.clock_in_at, clock.clocked_in_at, clock.started_at, clock.start_at));
    if (!start) return 0;
    const ended = dateValue(first(clock.clock_out_at, clock.clocked_out_at, clock.ended_at)) || new Date();
    const breakSeconds = Number(clock.break_seconds || clock.total_break_seconds || 0);
    return Math.max(0, Math.floor((ended.getTime() - start.getTime()) / 1000) - breakSeconds);
  }

  function clockState(result = {}){
    const container = obj(result.time_clock || result.clock || result.active_shift || result.shift || result.summary || result);
    const shift = obj(container.current_shift || container.shift || container.latest_shift);
    const state = Object.keys(shift).length ? { ...container, ...shift, active:container.active ?? shift.status === 'active' } : { ...container };
    const worked = Number(first(state.worked_seconds, state.active_seconds, 0));
    return {
      ...state,
      _client_observed_at:Date.now(),
      _client_worked_seconds:Number.isFinite(worked) ? Math.max(0, worked) : 0
    };
  }

  function shiftSummaryModal(result = {}){
    const summary = clockState(result);
    const reminders = responseRows(result, 'reminders', 'incomplete_items', 'pending_items');
    const worked = Number(summary.worked_seconds || summary.active_seconds || activeShiftSeconds(summary));
    const length = Number(summary.shift_seconds || summary.duration_seconds || worked + Number(summary.break_seconds || 0));
    return modal(`<div class="crew-shift-hero"><i class="fas fa-check"></i><h2>${(globalThis.PlatformLanguage?.text("crew","m_2c6d91b557af39","You have clocked out") ?? "You have clocked out")}</h2><strong>${String(esc(durationText(worked)))}</strong><span class="crew-sub">${(globalThis.PlatformLanguage?.text("crew","m_2a5410f131a4ba","Nice work today.") ?? "Nice work today.")}</span></div>
      <div class="crew-summary-grid"><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_d53ec0c2edba2d","Shift length") ?? "Shift length")}</span><strong>${String(esc(durationText(length)))}</strong></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_410d93bf32f6bb","Clocked in") ?? "Clocked in")}</span><strong>${String(esc(timeText(first(summary.clock_in_at, summary.clocked_in_at, summary.started_at), '-')))}</strong></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_f6e32dfe019e40","Clocked out") ?? "Clocked out")}</span><strong>${String(esc(timeText(first(summary.clock_out_at, summary.clocked_out_at, summary.ended_at), '-')))}</strong></div></div>
      ${String(reminders.length ? `<div><div class="crew-card-title"><h3>Before you finish</h3></div><div class="crew-reminders">${reminders.map((item) => `<div class="crew-reminder"><i class="fas fa-circle-exclamation"></i><span>${esc(item.title || item.label || item)}</span></div>`).join('')}</div></div>` : '')}`);
  }

  function crewTodos(result = {}){ return responseRows(result, 'todos', 'items'); }
  function todoDueMeta(todo = {}){
    const due = dateValue(todo.due_at);
    if (!due) return { text:'', past:false };
    const todayKey = nowDate();
    const key = localDateKey(due);
    if (key === todayKey) return { text: timeText(todo.due_at) || 'Today', past:false };
    return { text: shortDate(todo.due_at), past: key < todayKey };
  }
  function todoRowHtml(todo = {}, options = {}){
    const done = clean(todo.status) === 'completed';
    const priority = Number(todo.priority) > 0 && !done;
    const meta = todoDueMeta(todo);
    const sub = [
      options.showProject ? clean(first(todo.project_title, todo.project_address)) : '',
      clean(first(todo.description, todo.body))
    ].filter(Boolean).join(' · ');
    return `<div class="crew-todo-item ${String(done ? 'done' : '')} ${String(priority ? 'priority' : '')}" data-crew-todo="${String(esc(clean(todo.project_id)))}::${String(esc(clean(todo.id)))}">
      <button type="button" class="crew-cl-check" data-todo-toggle aria-label="${(globalThis.PlatformLanguage?.text("crew","m_e2ee136f98850f","Complete to-do") ?? "Complete to-do")}"><i class="fas fa-check"></i></button>
      <div class="crew-todo-copy"><strong>${String(priority ? '<i class="fas fa-flag crew-todo-flag"></i>' : '')}${String(esc(first(todo.title, 'To-do')))}</strong>${String(sub ? `<span>${esc(sub)}</span>` : '')}</div>
      ${String(meta.text ? `<span class="crew-todo-due ${meta.past && !done ? 'past' : ''}">${esc(meta.text)}</span>` : '')}
    </div>`;
  }
  function bindTodoRows(scope, todos, context, reload){
    scope.querySelectorAll('[data-crew-todo]').forEach((row) => {
      const [todoProjectId, nodeId] = String(row.dataset.crewTodo).split('::');
      const todo = todos.find((item) => clean(item.id) === nodeId);
      row.querySelector('[data-todo-toggle]')?.addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        try {
          const payload = { completed: clean(todo?.status) !== 'completed' };
          if (todoProjectId) await window.CrewAPI.projects.completeTodo(orgId(context), todoProjectId, nodeId, payload);
          else await window.CrewAPI.me.completeTodo(orgId(context), nodeId, payload);
          await reload();
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("crew","m_1dad46c8777063","To-do") ?? "To-do"), statusError(error), false);
          event.currentTarget.disabled = false;
        }
      });
    });
  }

  function mountCrewOverview(root, context = {}){
    let destroyed = false;
    let dashboard = null;
    let clock = {};
    let timer = null;
    const timeClockEnabled = context.params?.time_clock_enabled === true;
    const supervisorVariant = clean(context.params?.variant) === 'supervisor';
    root.innerHTML = `<div class="crew-shell"><div class="crew-page"><div class="crew-head"><div><div class="crew-eyebrow">${String(supervisorVariant ? 'Supervisor overview' : 'Crew overview')}</div><h1 class="crew-title">${(globalThis.PlatformLanguage?.text("crew","m_23929ba4ba84dd","Today") ?? "Today")}</h1><p class="crew-sub">${String(esc(new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })))}</p></div></div><div class="crew-dashboard" data-dashboard>${String(stateHtml('loading','Loading your projects'))}</div><div data-my-todos></div><div data-clock></div></div></div>`;
    const dashboardRoot = root.querySelector('[data-dashboard]');
    const clockRoot = root.querySelector('[data-clock]');
    const todosRoot = root.querySelector('[data-my-todos]');
    let myTodos = [];
    const renderMyTodos = () => {
      if (!todosRoot) return;
      if (!myTodos.length) { todosRoot.innerHTML = ''; return; }
      todosRoot.innerHTML = `<section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_99f046ad5a9f1f","Your to-dos") ?? "Your to-dos")}</h3><small>${String(myTodos.length)}</small></div><div class="crew-todo-list">${String(myTodos.map((todo) => todoRowHtml(todo, { showProject:true })).join(''))}</div></section>`;
      bindTodoRows(todosRoot, myTodos, context, loadMyTodos);
    };
    const loadMyTodos = async () => {
      if (!todosRoot || typeof window.CrewAPI?.me?.todos !== 'function') return;
      try {
        const result = await window.CrewAPI.me.todos(orgId(context));
        if (destroyed) return;
        myTodos = crewTodos(result);
        renderMyTodos();
      } catch (_) { /* the to-do feed is additive; the dashboard still works */ }
    };
    const rows = () => responseRows(dashboard, 'projects', 'assignments', 'items');
    const renderClock = () => {
      if (!clockRoot) return;
      const status = clean(clock.status || (clock.clock_in_at || clock.started_at ? 'active' : 'clocked_out')).toLowerCase();
      const active = ['active','clocked_in','working','on_break','break'].includes(status);
      const onBreak = ['on_break','break'].includes(status) || clock.on_break === true || !!clock.active_break || !!clock.active_break_started_at;
      const clockProjects = rows().filter((item) => !projectFields(item).overdue);
      const selectedProjectId = clean(obj(clock.metadata).project_id || (clockProjects.length === 1 ? projectFields(clockProjects[0]).id : ''));
      const projectPicker = !active && clockProjects.length > 1 ? `<select class="crew-btn" data-clock-project aria-label="${(globalThis.PlatformLanguage?.text("crew","m_c31bee40ee256a","Project for this shift") ?? "Project for this shift")}"><option value="">${(globalThis.PlatformLanguage?.text("crew","m_18844f001f61f9","General labor") ?? "General labor")}</option>${String(clockProjects.map((item) => { const fields = projectFields(item); return `<option value="${esc(fields.id)}" ${fields.id === selectedProjectId ? 'selected' : ''}>${esc(fields.title)}</option>`; }).join(''))}</select>` : '';
      clockRoot.innerHTML = `<div class="crew-clock"><div class="crew-clock-main">${active ? `<span class="crew-clock-dot ${onBreak ? 'break' : ''}"></span>` : '<span class="crew-project-icon" style="width:38px;height:38px"><i class="fas fa-clock"></i></span>'}<div class="crew-clock-copy"><strong>${active ? (onBreak ? 'On break' : 'Clocked in') : 'Ready to start?'}</strong><span>${active ? `Started ${esc(timeText(first(clock.clock_in_at, clock.clocked_in_at, clock.started_at)))}` : 'Your time will be added to today\'s shift.'}</span></div></div>${active ? `<div class="crew-clock-time" data-clock-elapsed>${esc(durationText(activeShiftSeconds(clock)))}</div>` : ''}<div class="crew-clock-actions">${projectPicker}${active ? `<button class="crew-btn" type="button" data-clock-action="${String(onBreak ? 'break_end' : 'break_start')}"><i class="fas ${String(onBreak ? 'fa-play' : 'fa-mug-hot')}"></i>${String(onBreak ? 'Resume' : 'Break')}</button><button class="crew-btn danger" type="button" data-clock-action="clock_out"><i class="fas fa-right-from-bracket"></i>${(globalThis.PlatformLanguage?.text("crew","m_a955f5181dc29d","Clock out") ?? "Clock out")}</button>` : `<button class="crew-btn primary" type="button" data-clock-action="clock_in"><i class="fas fa-play"></i>${(globalThis.PlatformLanguage?.text("crew","m_98d45878b887ff"," Clock in") ?? " Clock in")}</button>`}</div></div>`;
      clockRoot.querySelectorAll('[data-clock-action]').forEach((button) => button.addEventListener('click', async () => {
        const action = button.dataset.clockAction;
        button.disabled = true;
        try {
          const captureLocation = action === 'clock_in' || action === 'clock_out';
          const location = captureLocation ? await clockLocationEvidence() : null;
          const projectIdForShift = clean(obj(clock.metadata).project_id || clockRoot.querySelector('[data-clock-project]')?.value || (clockProjects.length === 1 ? projectFields(clockProjects[0]).id : ''));
          const result = await window.CrewAPI.me.timeAction(orgId(context), action, {
            metadata:{
              ...(location ? { location } : {}),
              ...(projectIdForShift ? { project_id:projectIdForShift } : {}),
              timezone:Intl.DateTimeFormat(globalThis.PlatformLanguage?.formatLocale?.()).resolvedOptions().timeZone,
              client_path:window.location.pathname
            }
          });
          clock = clockState(result);
          renderClock();
          if (action === 'clock_out') shiftSummaryModal(result);
          window.dispatchEvent(new CustomEvent('fm:crew:time-updated', { detail:result }));
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("crew","m_dbf79908eea881","Time clock") ?? "Time clock"), statusError(error, 'Could not update your shift.'), false);
          button.disabled = false;
        }
      }));
    };
    // "My equipment today": units riding on today's assigned events. Meter
    // logging appears when the org runs meters with field entry enabled and
    // the user can act (permission-checked server-side on save).
    const fieldMeterEntryOn = () => window.PlatformAPI?.appFlags?.has?.('equipment', 'meters') === true;
    const equipmentTodayHtml = (projects) => {
      const seen = new Set();
      const units = [];
      projects.forEach((project) => {
        (Array.isArray(project.equipment) ? project.equipment : []).forEach((unit) => {
          const id = clean(unit?.id);
          if (!id || seen.has(id)) return;
          seen.add(id);
          units.push({ id, name: clean(unit?.name) || id, project: projectFields(project).title });
        });
      });
      if (!units.length) return '';
      return `<section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_df3b05b5b01d4b","My equipment today") ?? "My equipment today")}</h3><small>${String(units.length)}</small></div><div class="crew-row-list">${String(units.map((unit) => `
        <div class="crew-row has-actions"><div class="crew-row-copy"><strong><i class="fas fa-truck-pickup" style="margin-right:7px;color:var(--primary,#d93025)"></i>${esc(unit.name)}</strong><span>${esc(unit.project || '')}</span></div>
        ${fieldMeterEntryOn() && window.EquipmentAPI ? `<div class="crew-row-actions"><button class="crew-btn" type="button" data-equipment-meter="${esc(unit.id)}" data-equipment-meter-name="${esc(unit.name)}"><i class="fas fa-gauge-high"></i> Log hours</button></div>` : ''}</div>`).join(''))}</div></section>`;
    };
    const bindEquipmentToday = (mount) => {
      mount.querySelectorAll('[data-equipment-meter]').forEach((button) => button.addEventListener('click', async () => {
        const value = Number(clean(window.prompt(((v0) => globalThis.PlatformLanguage?.text("crew","m_5052f31096e229",`Current meter hours for ${v0}:`,{v0}) ?? `Current meter hours for ${v0}:`)(clean(button.dataset.equipmentMeterName)))));
        if (!Number.isFinite(value) || value <= 0) return;
        try {
          await window.EquipmentAPI.recordMeterEntry(orgId(context), clean(button.dataset.equipmentMeter), { kind:'hours', value, source:'assignment' });
          showToast((globalThis.PlatformLanguage?.text("crew","m_2813f320a63b94","Equipment") ?? "Equipment"), (globalThis.PlatformLanguage?.text("crew","m_fd6df01df05391","Meter reading logged.") ?? "Meter reading logged."), true);
        } catch (error) {
          showToast((globalThis.PlatformLanguage?.text("crew","m_2813f320a63b94","Equipment") ?? "Equipment"), statusError(error, 'The reading could not be saved.'), false);
        }
      }));
    };
    const renderDashboard = () => {
      const projects = rows();
      const emptyMessage = supervisorVariant ? 'No projects are being worked on today.' : 'You have no assigned projects today.';
      if (!projects.length) dashboardRoot.innerHTML = stateHtml('empty', emptyMessage);
      else {
        const active = projects.filter((item) => !projectFields(item).overdue);
        const overdue = projects.filter((item) => projectFields(item).overdue);
        const heading = supervisorVariant ? 'Ongoing projects' : 'Assigned today';
        dashboardRoot.innerHTML = `<section class="crew-card"><div class="crew-card-title"><h3>${String(heading)}</h3><small>${((v1,v2) => globalThis.PlatformLanguage?.text("crew","m_46453ef0cafea3",`${v1} project${v2}`,{v1,v2}) ?? `${v1} project${v2}`)(active.length,active.length === 1 ? '' : 's')}</small></div><div class="crew-project-list">${String(active.map(projectTile).join('') || `<div class="crew-sub">${supervisorVariant ? 'No projects are running today.' : 'No projects scheduled for today.'}</div>`)}</div></section>${String(overdue.length ? `<section class="crew-card"><div class="crew-card-title"><h3>Still needs attention</h3><small>${overdue.length} overdue</small></div><div class="crew-project-list">${overdue.map(projectTile).join('')}</div></section>` : '')}${String(equipmentTodayHtml(projects))}`;
        bindProjectTiles(dashboardRoot, projects);
        bindEquipmentToday(dashboardRoot);
      }
      clock = clockState(dashboard);
      if (timeClockEnabled) renderClock();
      else if (clockRoot) clockRoot.innerHTML = '';
    };
    const load = async () => {
      dashboardRoot.innerHTML = stateHtml('loading','Loading your projects');
      try {
        dashboard = await window.CrewAPI.me.dashboard(orgId(context), nowDate());
        if (!destroyed) renderDashboard();
      } catch (error) {
        if (!destroyed) dashboardRoot.innerHTML = stateHtml('error', statusError(error, 'Could not load your day.'));
      }
      void loadMyTodos();
    };
    timer = timeClockEnabled ? setInterval(() => {
      const node = root.querySelector('[data-clock-elapsed]');
      if (node) node.textContent = durationText(activeShiftSeconds(clock));
    }, 1000) : null;
    load();
    return { destroy(){ destroyed = true; clearInterval(timer); root.innerHTML = ''; } };
  }

  function receiptCard(receiptValue = {}){
    const receipt = obj(receiptValue);
    const extraction = obj(receipt.extraction);
    const effective = obj(receipt.effective);
    const total = Number(first(receipt.total_cents, effective.total_cents, extraction.total_cents)) || 0;
    const status = clean(receipt.status || extraction.status || 'processing');
    const reimbursement = obj(receipt.reimbursement_request);
    const reimbursementStatus = clean(reimbursement.status);
    const detail = reimbursementStatus ? `${reimbursement.funding_source === 'company_card' ? 'Company card' : 'Reimbursement'} · ${reimbursementStatus.replace(/_/g,' ')}` : shortDate(first(receipt.purchase_date, effective.purchase_date, receipt.uploaded_at), 'Uploaded recently');
    return `<div class="crew-row"><div class="crew-row-copy"><strong>${esc(first(receipt.title, effective.title, extraction.vendor_name, extraction.vendor, obj(receipt.file).file_name, 'Receipt'))}</strong><span>${esc(detail)}${receipt.purchase_time && !reimbursementStatus ? ` at ${esc(receipt.purchase_time)}` : ''}</span></div><div class="crew-row-value">${esc(total ? currency(total) : 'Review')}<small><span class="crew-pill ${['paid','approved','not_required','applied','ready'].includes(reimbursementStatus || status) ? 'good' : ['submitted','needs_clarification','processing'].includes(reimbursementStatus || status) ? 'warn' : ''}">${esc((reimbursementStatus || status).replace(/_/g,' '))}</span></small></div></div>`;
  }

  function mountCrewReceipts(root, context = {}){
    let destroyed = false;
    let receipts = [];
    let batchItems = [];
    const canUpload = context.params?.can_upload === true;
    const canRequest = context.params?.can_request_reimbursement === true;
    root.innerHTML = `<div class="crew-shell"><div class="crew-page narrow"><div class="crew-head"><div><div class="crew-eyebrow">${(globalThis.PlatformLanguage?.text("crew","m_0cda4b1788c220","Expense evidence") ?? "Expense evidence")}</div><h1 class="crew-title">${(globalThis.PlatformLanguage?.text("crew","m_fc54001a0cc000","Receipts") ?? "Receipts")}</h1><p class="crew-sub">${(globalThis.PlatformLanguage?.text("crew","m_fab0626eca778a","Photograph or upload receipts. FirstMate reads and categorizes every file independently.") ?? "Photograph or upload receipts. FirstMate reads and categorizes every file independently.")}</p></div></div>${String(canUpload ? `<section class="crew-card"><div class="crew-card-title"><h3>Upload receipts</h3><small>Mixed formats supported</small></div>${canRequest ? `<div class="crew-form-grid"><label class="crew-field"><span>How was this paid?</span><select data-funding-source><option value="company_card">Company card — no reimbursement</option><option value="personal">Personal funds — request reimbursement</option></select></label><label class="crew-field"><span>Project (optional)</span><select data-reimbursement-project><option value="">Office / unassigned</option></select></label><label class="crew-field wide"><span>Note (optional)</span><input data-reimbursement-note placeholder="What was purchased and why?"></label></div>` : ''}<div class="crew-form-actions" style="justify-content:flex-start"><button class="crew-btn primary" type="button" data-camera><i class="fas fa-camera"></i> Take photo</button><button class="crew-btn" type="button" data-file><i class="fas fa-upload"></i> Choose files</button><input hidden type="file" accept="image/*" capture="environment" data-camera-input><input hidden type="file" multiple accept="${RECEIPT_ACCEPT}" data-file-input></div><div class="crew-sub" data-upload-status></div><div data-upload-batch></div></section>` : '')}<section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_59338e296bcca9","Recent receipts") ?? "Recent receipts")}</h3><small data-receipt-count>${String(receipts.length)}</small></div><div data-receipts>${String(stateHtml())}</div></section></div></div>`;
    const listRoot = root.querySelector('[data-receipts]');
    const status = root.querySelector('[data-upload-status]');
    const render = () => {
      const count = root.querySelector('[data-receipt-count]');
      if (count) count.textContent = String(receipts.length);
      listRoot.innerHTML = receipts.length ? `<div class="crew-row-list">${receipts.map(receiptCard).join('')}</div>` : stateHtml('empty','No receipts uploaded yet.');
    };
    const load = async () => {
      try {
        const [result, projectsResult] = await Promise.all([
          window.PaymentsAPI?.receipts?.listFor?.(orgId(context), { kind:'organization_user', id:userId(context) }),
          canRequest ? window.CrewAPI?.me?.projects?.(orgId(context), { limit:1000 }).catch(() => ({ projects:[] })) : Promise.resolve({ projects:[] })
        ]);
        receipts = responseRows(result, 'receipts', 'items');
        const projectSelect = root.querySelector('[data-reimbursement-project]');
        if (projectSelect) responseRows(projectsResult, 'projects', 'assignments', 'items').forEach((project) => projectSelect.insertAdjacentHTML('beforeend', `<option value="${esc(first(project.id, project.project_id))}">${esc(first(project.title, project.name, project.project_title, 'Project'))}</option>`));
        if (!destroyed) render();
      } catch (error) {
        if (!destroyed) listRoot.innerHTML = stateHtml('error', statusError(error, 'Could not load receipts.'));
      }
    };
    const renderBatch = () => {
      const mount = root.querySelector('[data-upload-batch]');
      if (mount) mount.innerHTML = receiptBatchHtml(batchItems);
    };
    const upload = async (filesValue) => {
      const files = Array.from(filesValue || []).filter(Boolean);
      if (!files.length || !window.PaymentsAPI?.receipts?.uploadBatchFor) return;
      if (status) status.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("crew","m_25017a22ce1314",`Processing ${v0} receipt${v1} in parallel...`,{v0,v1}) ?? `Processing ${v0} receipt${v1} in parallel...`)(files.length,files.length === 1 ? '' : 's');
      try {
        const result = await window.PaymentsAPI.receipts.uploadBatchFor(orgId(context), files, {
          concurrency:4,
          owner:{ kind:'organization_user', id:userId(context) },
          associations:[{ kind:'organization_user', id:userId(context) }],
          idempotency_key:`crew-${userId(context)}-${Date.now()}`,
          metadata:{ source:'crew_receipts_app' },
          onUpdate:(_item, items) => { if (!destroyed) { batchItems = items; renderBatch(); } }
        });
        if (canRequest && window.PaymentsAPI?.reimbursements?.submit) {
          const fundingSource = clean(root.querySelector('[data-funding-source]')?.value || 'company_card');
          const projectId = clean(root.querySelector('[data-reimbursement-project]')?.value);
          const note = clean(root.querySelector('[data-reimbursement-note]')?.value);
          for (const receipt of result.receipts || []) {
            const response = await window.PaymentsAPI.reimbursements.submit(orgId(context), receipt.id, { funding_source:fundingSource, project_id:projectId, note, amount_cents:Number(receipt.total_cents || receipt.effective?.total_cents || 0) });
            Object.assign(receipt, response?.receipt || {});
          }
        }
        if (status) status.textContent = ((v0,v1) => globalThis.PlatformLanguage?.text("crew","m_053b929ef18104",`${v0} ready${v1}. Review them from a project to append line items.`,{v0,v1}) ?? `${v0} ready${v1}. Review them from a project to append line items.`)(result.succeeded,result.failed ? `, ${result.failed} failed` : '');
        receipts.unshift(...result.receipts);
        render();
      } catch (error) {
        if (status) status.textContent = statusError(error, 'Upload failed.');
      }
    };
    const cameraInput = root.querySelector('[data-camera-input]');
    const fileInput = root.querySelector('[data-file-input]');
    root.querySelector('[data-camera]')?.addEventListener('click', () => cameraInput?.click());
    root.querySelector('[data-file]')?.addEventListener('click', () => fileInput?.click());
    cameraInput?.addEventListener('change', () => { const files = Array.from(cameraInput.files || []); cameraInput.value = ''; void upload(files); });
    fileInput?.addEventListener('change', () => { const files = Array.from(fileInput.files || []); fileInput.value = ''; void upload(files); });
    load();
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  function earningsReport(result = {}){
    return obj(result.earnings || result.report || result);
  }

  function loadMyEarnings(context = {}, options = {}){
    const client = window.PayrollAPI?.earnings;
    if (!client?.me) return Promise.reject(new Error('The payroll earnings library is unavailable.'));
    return client.me(orgId(context), options);
  }

  function earningsProjectCard(itemValue = {}){
    const item = obj(itemValue);
    const totals = obj(item.totals);
    const owed = Math.max(0, Number(totals.owed_cents || 0));
    const inPayroll = Number(totals.in_payroll_cents || 0);
    const accrued = Number(totals.accrued_cents || 0);
    const projected = Math.max(0, Number(totals.projected_cents || 0));
    const paid = Math.max(0, Number(totals.paid_cents || 0));
    const status = owed > 0 ? (inPayroll > 0 ? 'in payroll' : 'owed') : (projected > 0 ? 'projected' : (paid > 0 ? 'paid' : 'settled'));
    const amount = owed > 0 ? owed : (projected > 0 ? projected : paid);
    return `<div class="crew-row"><div class="crew-row-copy"><strong>${esc(first(item.title,item.project_title,item.project_id,'Other earnings'))}</strong><span>${owed > 0 ? `${esc(currency(owed))} currently owed` : (projected > 0 ? `${esc(currency(projected))} projected` : `${esc(currency(paid))} paid`)}</span><div class="crew-earnings-breakdown">${accrued ? `<span>${((v0) => globalThis.PlatformLanguage?.text("crew","m_326110f5babd31",`${v0} accrued`,{v0}) ?? `${v0} accrued`)(esc(currency(accrued)))}</span>` : ''}${inPayroll ? `<span>${((v0) => globalThis.PlatformLanguage?.text("crew","m_a0f499807b61d8",`${v0} in payroll`,{v0}) ?? `${v0} in payroll`)(esc(currency(inPayroll)))}</span>` : ''}${paid ? `<span>${((v0) => globalThis.PlatformLanguage?.text("crew","m_6acae344e57858",`${v0} paid`,{v0}) ?? `${v0} paid`)(esc(currency(paid)))}</span>` : ''}</div></div><div class="crew-row-value">${esc(currency(amount))}<small><span class="crew-pill ${status === 'paid' || status === 'settled' ? 'good' : 'warn'}">${esc(status)}</span></small></div></div>`;
  }

  function earningEntryCard(entryValue = {}){
    const entry = obj(entryValue);
    const kind = clean(entry.kind || 'earning').replace(/_/g,' ');
    const status = Number(entry.remaining_cents || 0) === 0 && Number(entry.applied_cents || 0) !== 0 ? 'in payroll' : clean(entry.state || 'accrued');
    return `<div class="crew-row"><div class="crew-row-copy"><strong class="crew-earning-kind">${esc(first(entry.description,kind))}</strong><span>${esc(first(entry.project_title,shortDate(entry.eligible_at),'Payroll earning'))}</span></div><div class="crew-row-value">${esc(currency(Number(entry.amount_cents || 0)))}<small><span class="crew-pill ${status === 'paid' ? 'good' : 'warn'}">${esc(status.replace(/_/g,' '))}</span></small></div></div>`;
  }

  function renderEarningsPage(root, result = {}, title = 'Earnings by project', options = {}){
    const report = earningsReport(result);
    const projects = arr(report.projects);
    const entries = arr(report.entries);
    const totals = obj(report.totals);
    const owed = Math.max(0, Number(totals.owed_cents || 0));
    const paid = Math.max(0, Number(totals.paid_cents || 0));
    const projected = Math.max(0, Number(totals.projected_cents || 0));
    const details = options.details === true && entries.length
      ? `<section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_5807fca7eb02a0","Earning details") ?? "Earning details")}</h3><small>${String(entries.length)}</small></div><div class="crew-row-list">${String(entries.slice(0,100).map(earningEntryCard).join(''))}</div></section>`
      : '';
    root.innerHTML = `<div class="crew-summary-grid"><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_5f59818bf1cb7d","Owed") ?? "Owed")}</span><strong>${String(esc(currency(owed)))}</strong><small>${(globalThis.PlatformLanguage?.text("crew","m_3d6345f45141a8","Accrued and currently in payroll") ?? "Accrued and currently in payroll")}</small></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_956173c8527121","Paid") ?? "Paid")}</span><strong>${String(esc(currency(paid)))}</strong><small>${(globalThis.PlatformLanguage?.text("crew","m_192360a7033431","Completed payroll") ?? "Completed payroll")}</small></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_929d3bd2149645","Projected") ?? "Projected")}</span><strong>${String(esc(currency(projected)))}</strong><small>${(globalThis.PlatformLanguage?.text("crew","m_047c1d69a096b3","Not owed until accrued") ?? "Not owed until accrued")}</small></div></div>${String(result.truncated ? '<div class="crew-earnings-note">Showing the newest payroll records. Choose a narrower date range to review older earnings.</div>' : '')}<section class="crew-card"><div class="crew-card-title"><h3>${String(esc(title))}</h3><small>${String(projects.length)}</small></div>${String(projects.length ? `<div class="crew-row-list">${projects.map(earningsProjectCard).join('')}</div>` : stateHtml('empty','No payroll earnings are available yet.'))}</section>${String(details)}`;
  }

  function mountCrewPayouts(root, context = {}){
    let destroyed = false;
    root.innerHTML = `<div class="crew-shell"><div class="crew-page"><div class="crew-head"><div><div class="crew-eyebrow">${(globalThis.PlatformLanguage?.text("crew","m_af7280e8ac9efa","My payroll") ?? "My payroll")}</div><h1 class="crew-title">${(globalThis.PlatformLanguage?.text("crew","m_685ff0ff145929","Earnings") ?? "Earnings")}</h1><p class="crew-sub">${(globalThis.PlatformLanguage?.text("crew","m_97d70e1d5cb7d4","What you are owed, what is in payroll, and what has been paid—organized by project.") ?? "What you are owed, what is in payroll, and what has been paid—organized by project.")}</p></div></div><div data-earnings>${String(stateHtml('loading','Loading your earnings'))}</div></div></div>`;
    const mount = root.querySelector('[data-earnings]');
    loadMyEarnings(context).then((result) => { if (!destroyed) renderEarningsPage(mount, result); }).catch((error) => { if (!destroyed) mount.innerHTML = stateHtml('error', statusError(error,'Could not load earnings.')); });
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  let activeCrewScheduleHandle = null;
  const crewScheduleViews = ['list','day','4day','week','month'];

  function crewScheduleRange(view, anchorValue){
    const anchor = dateValue(anchorValue) || new Date();
    if (view === 'list') return {};
    if (view === 'month') {
      const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      monthStart.setDate(monthStart.getDate() - monthStart.getDay());
      return { from:localDateKey(monthStart), to:addLocalDays(localDateKey(monthStart), 41) };
    }
    if (view === 'week') {
      const weekStart = new Date(anchor);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      return { from:localDateKey(weekStart), to:addLocalDays(localDateKey(weekStart), 6) };
    }
    return { from:localDateKey(anchor), to:addLocalDays(localDateKey(anchor), view === '4day' ? 3 : 0) };
  }

  function crewScheduleEvents(projects){
    return arr(projects).flatMap((project) => {
      const row = projectFields(project);
      return arr(project.assigned_events).map((eventValue, index) => {
        const event = obj(eventValue);
        const timed = event.all_day === false || clean(event.schedule_granularity).toLowerCase() === 'time';
        const start = dateValue(first(event.start_at, event.start, event.start_date));
        if (!start) return null;
        const explicitEndDate = clean(event.end_date);
        let endValue = dateValue(first(event.end_at, event.end, explicitEndDate));
        if (!timed && explicitEndDate) endValue = dateValue(addLocalDays(explicitEndDate, 1));
        else if (!timed && (!endValue || endValue <= start)) endValue = dateValue(addLocalDays(localDateKey(start), 1));
        if (!endValue) endValue = new Date(start.getTime() + (timed ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
        return {
          ...event,
          id:`crew:${row.id}:${clean(event.id || event.event_id || index)}`,
          event_id:clean(event.id || event.event_id),
          project_id:row.id,
          project_title:row.title,
          project_address:row.address,
          customer_name:row.customer,
          scope_color:row.scopeColor,
          start_at:start.toISOString(),
          end_at:endValue.toISOString(),
          all_day:!timed,
          schedule_granularity:timed ? 'time' : 'date',
          __crewProject:project
        };
      }).filter(Boolean);
    });
  }

  function mountCrewSchedule(root, context = {}){
    let destroyed = false;
    let projects = [];
    let requestVersion = 0;
    let loaded = false;
    const initialRoute = Portal.navigation?.read?.() || {};
    let view = crewScheduleViews.includes(initialRoute.crewScheduleView) ? initialRoute.crewScheduleView : 'week';
    let anchor = dateValue(initialRoute.crewScheduleDate) || new Date();
    root.innerHTML = `<div class="crew-shell crew-schedule-shell"><div class="crew-page crew-schedule-page"><div class="crew-schedule-calendar" data-schedule>${stateHtml('loading','Loading your schedule')}</div></div></div>`;
    const mount = root.querySelector('[data-schedule]');
    const isMobile = () => window.matchMedia?.('(max-width:720px)')?.matches === true;
    const writeRoute = (method, patchValue, options) => {
      if (Portal.navigation?.applying) return;
      Portal.navigation?.[method]?.(patchValue, options);
    };
    const render = () => {
      if (!window.PlatformScheduleView?.renderProjectRangeScheduler || !window.PlatformScheduling) {
        mount.innerHTML = stateHtml('error','The shared schedule view is unavailable.');
        return;
      }
      window.PlatformScheduleView.renderProjectRangeScheduler(mount, {
        Scheduling:window.PlatformScheduling,
        events:crewScheduleEvents(projects),
        readOnly:true,
        allowCreate:false,
        allowEdit:false,
        mode:view,
        modes:crewScheduleViews,
        modeLabels:{ '4day':isMobile() ? '3 Day' : '4 Day' },
        date:anchor,
        shortRangeDayCount:isMobile() ? 3 : 4,
        mobileLayout:isMobile(),
        touchSwipeNavigation:true,
        initialScrollMinute:7 * 60,
        showListLabel:false,
        emptyMessage:(globalThis.PlatformLanguage?.text("crew","m_7c5d42d19a8cfd","No assigned work is scheduled in this view.") ?? "No assigned work is scheduled in this view."),
        onModeChange(nextView){
          if (!crewScheduleViews.includes(nextView)) return;
          view = nextView;
          writeRoute('push', { crewScheduleView:view }, { source:'crew-schedule-view', ownedKeys:['crewScheduleView'] });
          void load();
        },
        onNavigate(nextDate){
          anchor = dateValue(nextDate) || new Date();
          writeRoute('replace', { crewScheduleDate:localDateKey(anchor) }, { source:'crew-schedule-date', ownedKeys:['crewScheduleDate'] });
          void load();
        },
        onEventClick(item){
          if (item?.__crewProject) openProject(item.__crewProject);
        }
      });
    };
    const load = async () => {
      const version = ++requestVersion;
      if (!loaded && mount) mount.innerHTML = stateHtml('loading','Loading your schedule');
      try {
        const result = await window.CrewAPI.me.projects(orgId(context), {
          ...crewScheduleRange(view, anchor),
          date:localDateKey(anchor),
          limit:1000
        });
        if (destroyed || version !== requestVersion) return;
        projects = responseRows(result, 'projects', 'assignments', 'items');
        loaded = true;
        render();
      } catch (error) {
        if (!destroyed && version === requestVersion && mount) mount.innerHTML = stateHtml('error',statusError(error,'Could not load your assigned schedule.'));
      }
    };
    const handle = {
      applyRoute(route = {}){
        if (route.tab !== 'crew_schedule' || destroyed) return;
        const nextView = crewScheduleViews.includes(route.crewScheduleView) ? route.crewScheduleView : 'week';
        const nextAnchor = dateValue(route.crewScheduleDate) || anchor;
        const changed = nextView !== view || localDateKey(nextAnchor) !== localDateKey(anchor);
        view = nextView;
        anchor = nextAnchor;
        if (changed) void load();
      },
      destroy(){
        destroyed = true;
        requestVersion += 1;
        window.removeEventListener('resize', onResize);
        if (activeCrewScheduleHandle === handle) activeCrewScheduleHandle = null;
        root.innerHTML = '';
      }
    };
    const onResize = () => { if (!destroyed && loaded) render(); };
    activeCrewScheduleHandle = handle;
    window.addEventListener('resize', onResize);
    void load();
    return handle;
  }

  const crewAccess = { applicationsAny:['field'], devices:['mobile','desktop'], requireEntitlement:true };
  function registerPortal(definition){
    Portal.apps?.registerPortalApp?.({ ...definition, access:crewAccess });
  }
  registerPortal({ id:'portal.crew_overview', tabId:'crew_overview', title:(globalThis.PlatformLanguage?.text("crew","m_23929ba4ba84dd","Today") ?? "Today"), icon:'fa-house', order:1, defaultHome:true, mount:mountCrewOverview });
  registerPortal({ id:'portal.crew_receipts', tabId:'crew_receipts', title:(globalThis.PlatformLanguage?.text("crew","m_fc54001a0cc000","Receipts") ?? "Receipts"), icon:'fa-receipt', order:12, mount:mountCrewReceipts });
  registerPortal({ id:'portal.crew_payouts', tabId:'crew_payouts', title:(globalThis.PlatformLanguage?.text("crew","m_685ff0ff145929","Earnings") ?? "Earnings"), icon:'fa-wallet', order:14, mount:mountCrewPayouts });
  registerPortal({ id:'portal.crew_schedule', tabId:'crew_schedule', title:(globalThis.PlatformLanguage?.text("crew","m_fc05a804bd034c","Schedule") ?? "Schedule"), icon:'fa-calendar-days', order:18, fullBleed:true, params:{ mode:'crew', crewMode:true, assignedOnly:true }, mount:mountCrewSchedule });
  Portal.navigation?.registerHandler?.('crew-schedule-route', {
    priority:410,
    immediate:true,
    apply(route){ activeCrewScheduleHandle?.applyRoute?.(route); }
  });

  const projectPresentation = { projectModal:{ desktopLeft:'none', mobileLeft:'none', mobileInfo:'none', mobileTabs:'icons', mobileFullscreenControl:false } };
  function projectPanel(kind){ return `<div class="crew-project-app" data-crew-project-app="${esc(kind)}"></div>`; }
  function projectMountRoot(context, kind){
    const outer = context.roots?.main || context.mainRoot || context.root;
    return outer?.querySelector?.(`[data-crew-project-app="${kind}"]`) || outer;
  }

  function mountProjectOverviewLegacy(context = {}){
    const root = projectMountRoot(context, 'overview');
    let destroyed = false;
    let project = { ...obj(context.project) };
    let todos = [];
    const loadTodos = async () => {
      if (typeof window.CrewAPI?.projects?.todos !== 'function' || !projectId(context)) return;
      try {
        const result = await window.CrewAPI.projects.todos(orgId(context), projectId(context));
        if (destroyed) return;
        todos = crewTodos(result);
        render();
      } catch (_) { /* the to-do feed is additive */ }
    };
    const render = () => {
      const row = projectFields(project);
      const customer = row.customer || clean(first(project.customer?.name, project.contact?.name));
      const phone = row.phone || clean(first(project.customer?.phone, project.contact?.phone));
      // A compact, full-width strip right under the modal title: address and
      // customer contact only -- no repeated title, no oversized hero.
      const chips = [
        row.address ? `<a class="crew-strip-chip" href="https://maps.google.com/?q=${String(encodeURIComponent(row.address))}" target="_blank" rel="noopener"><i class="fas fa-location-dot"></i><div class="crew-strip-copy"><span>${(globalThis.PlatformLanguage?.text("crew","m_53d803cdbe9ab1","Address") ?? "Address")}</span><strong>${String(esc(row.address))}</strong></div></a>` : '',
        customer ? `<div class="crew-strip-chip"><i class="fas fa-user"></i><div class="crew-strip-copy"><span>${(globalThis.PlatformLanguage?.text("crew","m_ae8e4953e07d70","Customer") ?? "Customer")}</span><strong>${String(esc(customer))}</strong></div></div>` : '',
        phone ? `<a class="crew-strip-chip" href="tel:${String(esc(phone.replace(/[^0-9+]/g,'')))}"><i class="fas fa-phone"></i><div class="crew-strip-copy"><span>${(globalThis.PlatformLanguage?.text("crew","m_ed04c65845180f","Phone") ?? "Phone")}</span><strong>${String(esc(phone))}</strong></div></a>` : ''
      ].filter(Boolean).join('');
      const openTodos = todos.filter((todo) => clean(todo.status) !== 'completed');
      const doneTodos = todos.filter((todo) => clean(todo.status) === 'completed');
      const todoSection = todos.length
        ? `<section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_a6534938817ec3","To-dos") ?? "To-dos")}</h3><small>${((v0) => globalThis.PlatformLanguage?.text("crew","m_6c4162aa600d83",`${v0} open`,{v0}) ?? `${v0} open`)(openTodos.length)}</small></div><div class="crew-todo-list">${String([...openTodos, ...doneTodos].map((todo) => todoRowHtml(todo)).join(''))}</div></section>`
        : '';
      root.innerHTML = `<div class="crew-project-page"><div class="crew-page">${String(chips ? `<div class="crew-overview-strip">${chips}</div>` : '')}${String(todoSection)}<section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_d6113dda50d96c","Project notes") ?? "Project notes")}</h3></div><div class="crew-notes">${String(esc(row.notes || 'No project notes have been added.'))}</div></section></div></div>`;
      bindTodoRows(root, todos, context, loadTodos);
    };
    render();
    if (window.CrewAPI?.projects?.get && projectId(context)) {
      window.CrewAPI.projects.get(orgId(context), projectId(context)).then((result) => {
        project = { ...project, ...obj(result.project || result.data || result) };
        if (!destroyed) render();
      }).catch(() => null);
    }
    void loadTodos();
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  function mountProjectOverview(context = {}){
    const root = projectMountRoot(context, 'overview');
    if (!window.FMFieldVisit?.mount) return mountProjectOverviewLegacy(context);
    return window.FMFieldVisit.mount(root, context, { onUnavailable:() => mountProjectOverviewLegacy(context) });
  }

  function materialLists(result = {}){
    return responseRows(result, 'material_lists', 'lists', 'materials');
  }
  function materialItems(listValue = {}){
    const list = obj(listValue);
    return arr(list.current_items || list.items || list.line_items);
  }
  function itemDescription(itemValue = {}){
    const item = obj(itemValue);
    return clean(first(item.description, item.name, item.title, item.label, 'Material'));
  }
  function itemTotalCents(itemValue = {}){
    const item = obj(itemValue);
    if (Number.isFinite(Number(item.total_cents))) return Number(item.total_cents);
    if (Number.isFinite(Number(item.amount_cents))) return Number(item.amount_cents);
    if (Number.isFinite(Number(item.paid_total_cents))) return Number(item.paid_total_cents);
    if (Number.isFinite(Number(item.paid_total))) return Math.round(Number(item.paid_total) * 100);
    const amount = Number(first(item.total, item.amount, 0));
    if (amount) return Math.round(amount * 100);
    const qty = Number(item.quantity || item.qty || 1) || 1;
    const unitCents = Number(item.unit_price_cents || item.paid_unit_price_cents || 0);
    if (Number.isFinite(unitCents) && unitCents) return Math.round(qty * unitCents);
    const unit = Number(first(item.unit_price, item.paid_unit_price, item.price, 0)) || 0;
    return Math.round(qty * unit * 100);
  }
  // Human delivery timing: all-day deliveries (or windows stored as midnight)
  // show only the date -- nothing is really arriving "at 12:00 AM".
  function deliveryWhen(value, windowValue = {}){
    if (!clean(value)) return '';
    const date = shortDate(value);
    if (!date) return '';
    const window = obj(windowValue);
    const allDay = window.all_day === true || clean(window.schedule_granularity).toLowerCase() === 'date';
    const time = timeText(value);
    if (allDay || !time || /^12:00\s?AM$/i.test(time)) return date;
    return `${date} at ${time}`;
  }
  function materialListHtml(listValue = {}){
    const list = obj(listValue);
    const items = materialItems(list);
    const orders = arr(list.orders);
    const deliveries = orders.flatMap((order) => arr(order.deliveries).map((delivery) => ({ ...delivery, order })));
    const latestDelivery = obj(deliveries[0]);
    const latestOrder = obj(orders[0]);
    const delivery = obj(list.delivery || list.schedule || latestDelivery.estimated_window || latestOrder.scheduled_window);
    const deliveryStatus = clean(first(latestDelivery.status, latestOrder.delivery_status, list.delivery_status));
    const deliveryStart = first(delivery.start_at, delivery.start, delivery.from, latestDelivery.actual_delivered_at);
    const deliveryLabel = first(deliveryWhen(deliveryStart, delivery), deliveryStatus.replace(/_/g, ' '), 'Not scheduled');
    const deliveryRows = orders.map((order) => {
      const windowValue = obj(order.scheduled_window);
      const start = first(windowValue.start_at, windowValue.start, windowValue.from);
      const status = clean(order.delivery_status || 'ordered').replace(/_/g, ' ');
      return `<div class="crew-row"><div class="crew-row-copy"><strong>${esc(first(order.title,obj(order.vendor).name,'Material delivery'))}</strong><span>${esc(deliveryWhen(start, windowValue) || 'Delivery date not set')}</span></div><span class="crew-pill ${status === 'delivered' ? 'good' : 'warn'}">${esc(status)}</span></div>`;
    }).join('');
    return `<section class="crew-card"><div class="crew-material-head"><div><h3>${String(esc(first(list.title, list.name, 'Materials')))}</h3><span class="crew-sub">${String(esc(deliveryLabel))}</span></div><span class="crew-pill ${String(deliveryStatus === 'delivered' ? 'good' : '')}">${((v3,v4) => globalThis.PlatformLanguage?.text("crew","m_87d55382163ac0",`${v3} item${v4}`,{v3,v4}) ?? `${v3} item${v4}`)(items.length,items.length === 1 ? '' : 's')}</span></div>${String(deliveryRows ? `<div class="crew-material-label">Deliveries</div><div class="crew-row-list" style="margin-top:8px">${deliveryRows}</div>` : '')}<div class="crew-material-label">${(globalThis.PlatformLanguage?.text("crew","m_0732999aff5fb0","Items") ?? "Items")}</div><div class="crew-material-items" style="margin-top:8px">${String(items.length ? items.map((item) => `<div class="crew-material-item"><div><strong>${esc(itemDescription(item))}</strong><span>${esc(`${Number(item.quantity || item.qty || 1)} ${first(item.unit, '')}`)}</span></div><b>${esc(itemTotalCents(item) ? currency(itemTotalCents(item)) : '')}</b></div>`).join('') : '<div class="crew-state" style="min-height:90px">No items yet.</div>')}</div></section>`;
  }

  function mountProjectMaterials(context = {}){
    const root = projectMountRoot(context, 'materials');
    let destroyed = false;
    let result = null;
    let reviewReceipt = null;
    let receiptBatchItems = [];
    const canAppend = context.params?.can_append === true;
    const canUploadReceipt = canAppend && context.params?.can_upload_receipt === true;
    const render = () => {
      const lists = materialLists(result);
      const defaultListLabel = lists.length ? 'Use default project list' : 'Create Crew Added Materials list';
      root.innerHTML = `<div class="crew-project-page"><div class="crew-page"><div class="crew-head"><div><div class="crew-eyebrow">${(globalThis.PlatformLanguage?.text("crew","m_4de5ecee190da3","Project materials") ?? "Project materials")}</div><h2 class="crew-title" style="font-size:26px">${(globalThis.PlatformLanguage?.text("crew","m_691187e28aba8e","Materials") ?? "Materials")}</h2><p class="crew-sub">${(globalThis.PlatformLanguage?.text("crew","m_24901b36a1137d","Delivery lists and items added in the field.") ?? "Delivery lists and items added in the field.")}</p></div><div class="crew-toolbar"><button class="crew-btn" type="button" data-material-receipt><i class="fas fa-receipt"></i>${(globalThis.PlatformLanguage?.text("crew","m_42e6bde19da3c1"," Receipts") ?? " Receipts")}</button><button class="crew-btn primary" type="button" data-material-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("crew","m_f512a53a38a9b7"," Add item") ?? " Add item")}</button><input hidden type="file" multiple accept="${String(RECEIPT_ACCEPT)}" data-material-receipt-input></div></div><section class="crew-card crew-inline-form" data-material-form><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_a13e9871c5ffa9","Add a material") ?? "Add a material")}</h3></div><div class="crew-form"><div class="crew-form-grid"><label class="crew-field wide">${(globalThis.PlatformLanguage?.text("crew","m_fd0199dc45d261","Material list") ?? "Material list")}<select data-material-list><option value="">${String(esc(defaultListLabel))}</option>${String(lists.map((list) => `<option value="${esc(list.id)}">${esc(first(list.title,list.name,list.id))}</option>`).join(''))}</select></label><label class="crew-field wide">${(globalThis.PlatformLanguage?.text("crew","m_5be12a31e41de3","Item") ?? "Item")}<input data-material-description placeholder="${(globalThis.PlatformLanguage?.text("crew","m_5b79f2667269d3","e.g. 1 box coil nails") ?? "e.g. 1 box coil nails")}"></label><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_9c689ddee2f502","Quantity") ?? "Quantity")}<input data-material-quantity type="number" min="0" step="0.01" value="1"></label><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_4b91b73dae1ff3","Unit") ?? "Unit")}<input data-material-unit placeholder="${(globalThis.PlatformLanguage?.text("crew","m_e23846736f670a","box, each, roll") ?? "box, each, roll")}"></label><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_bc7b189271d609","Unit price") ?? "Unit price")}<input data-material-price inputmode="decimal" placeholder="0.00"></label></div><div class="crew-form-actions"><button class="crew-btn ghost" type="button" data-material-cancel>${(globalThis.PlatformLanguage?.text("crew","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="crew-btn primary" type="button" data-material-save>${(globalThis.PlatformLanguage?.text("crew","m_355f235735b2c7","Save item") ?? "Save item")}</button></div><div class="crew-sub" data-material-status></div></div></section><div data-material-receipt-batch>${String(receiptBatchHtml(receiptBatchItems, { review:true }))}</div><div data-receipt-review></div><div data-material-lists>${String(lists.length ? lists.map(materialListHtml).join('') : stateHtml('empty','No material lists are available for this project.'))}</div></div></div>`;
      if (!canAppend) {
        root.querySelector('[data-material-add]')?.remove();
        root.querySelector('[data-material-form]')?.remove();
      }
      if (!canUploadReceipt) {
        root.querySelector('[data-material-receipt]')?.remove();
        root.querySelector('[data-material-receipt-input]')?.remove();
      }
      const form = root.querySelector('[data-material-form]');
      root.querySelector('[data-material-add]')?.addEventListener('click', () => form?.classList.add('open'));
      root.querySelector('[data-material-cancel]')?.addEventListener('click', () => form?.classList.remove('open'));
      root.querySelector('[data-material-save]')?.addEventListener('click', async (event) => {
        const description = clean(root.querySelector('[data-material-description]')?.value);
        if (!description) return showToast((globalThis.PlatformLanguage?.text("crew","m_77b18743e2525b","Material required") ?? "Material required"),(globalThis.PlatformLanguage?.text("crew","m_ced422ab51cd13","Enter an item description.") ?? "Enter an item description."),false);
        const button = event.currentTarget;
        const quantity = Math.max(0, Number(root.querySelector('[data-material-quantity]')?.value) || 1);
        const unitPriceCents = Math.max(0, Math.round((Number(root.querySelector('[data-material-price]')?.value) || 0) * 100));
        button.disabled = true;
        try {
          result = await window.CrewAPI.projects.addMaterialItem(orgId(context), projectId(context), {
            list_id:root.querySelector('[data-material-list]')?.value || '',
            item:{ description, name:description, quantity, unit:clean(root.querySelector('[data-material-unit]')?.value), unit_price_cents:unitPriceCents, total_cents:Math.round(quantity * unitPriceCents) }
          });
          showToast((globalThis.PlatformLanguage?.text("crew","m_00905f312f31ee","Material added") ?? "Material added"),(globalThis.PlatformLanguage?.text("crew","m_d0db763422a3c8","The project material list was updated.") ?? "The project material list was updated."),true);
          await load();
        } catch (error) {
          root.querySelector('[data-material-status]').textContent = statusError(error,'Could not add the item.');
          button.disabled = false;
        }
      });
      const fileInput = root.querySelector('[data-material-receipt-input]');
      root.querySelector('[data-material-receipt]')?.addEventListener('click', () => fileInput?.click());
      fileInput?.addEventListener('change', () => { const files = Array.from(fileInput.files || []); fileInput.value = ''; void uploadReceipts(files); });
      root.querySelectorAll('[data-crew-batch-review]').forEach((button) => {
        button.addEventListener('click', () => {
          reviewReceipt = receiptBatchItems.find((item) => clean(item.receipt?.id) === clean(button.dataset.crewBatchReview))?.receipt || null;
          renderReceiptReview();
        });
      });
      if (reviewReceipt) renderReceiptReview();
    };
    const renderReceiptReview = () => {
      const receipt = obj(reviewReceipt);
      const extraction = obj(receipt.extraction);
      const lines = arr(extraction.line_items || receipt.line_items);
      const mount = root.querySelector('[data-receipt-review]');
      if (!mount) return;
      const lists = materialLists(result);
      const defaultListLabel = lists.length ? 'Use default project list' : 'Create Crew Added Materials list';
      mount.innerHTML = `<section class="crew-card"><div class="crew-card-title"><div><h3>${(globalThis.PlatformLanguage?.text("crew","m_673543e917499c","Review receipt items") ?? "Review receipt items")}</h3><small>${String(esc(first(extraction.vendor_name,extraction.vendor,receipt.title,obj(receipt.file).file_name,'Receipt')))}</small></div><span class="crew-pill warn">${(globalThis.PlatformLanguage?.text("crew","m_b0bb1e74e2a6d3","Review") ?? "Review")}</span></div><div class="crew-summary-grid"><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_9403c7637d4905","Total") ?? "Total")}</span><strong>${String(esc(currency(Number(receipt.total_cents || extraction.total_cents || 0))))}</strong></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_16adeee1c6af56","Purchased") ?? "Purchased")}</span><strong style="font-size:15px">${String(esc(shortDate(first(receipt.purchase_date,extraction.purchase_date),'Unknown')))}</strong></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_727840a47c2e4c","Time") ?? "Time")}</span><strong style="font-size:15px">${String(esc(first(receipt.purchase_time,extraction.purchase_time,'Unknown')))}</strong></div></div><div class="crew-receipt-review" style="margin-top:12px">${String(lines.length ? lines.map((line,index) => `<div class="crew-receipt-line" data-receipt-line="${index}"><input type="checkbox" checked aria-label="Include item"><input type="text" value="${esc(itemDescription(line))}" aria-label="Item description"><input type="number" inputmode="decimal" step="0.01" value="${esc((itemTotalCents(line)/100).toFixed(2))}" aria-label="Item total"></div>`).join('') : '<div class="crew-sub">No line items were found. You can still keep the receipt and add items manually.</div>')}</div><label class="crew-field" style="margin-top:10px">${(globalThis.PlatformLanguage?.text("crew","m_3504dc9d7f7408","Append to") ?? "Append to")}<select data-receipt-list><option value="">${String(esc(defaultListLabel))}</option>${String(lists.map((list) => `<option value="${esc(list.id)}">${esc(first(list.title,list.name,list.id))}</option>`).join(''))}</select></label><div class="crew-form-actions" style="margin-top:12px"><button class="crew-btn ghost" type="button" data-receipt-dismiss>${(globalThis.PlatformLanguage?.text("crew","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="crew-btn primary" type="button" data-receipt-append ${String(lines.length ? '' : 'disabled')}><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("crew","m_3a147f783ac4bf"," Add selected items") ?? " Add selected items")}</button></div><div class="crew-sub" data-receipt-status></div></section>`;
      mount.querySelector('[data-receipt-dismiss]')?.addEventListener('click', () => { reviewReceipt = null; mount.innerHTML = ''; });
      mount.querySelector('[data-receipt-append]')?.addEventListener('click', async (event) => {
        const items = Array.from(mount.querySelectorAll('[data-receipt-line]')).filter((row) => row.querySelector('input[type=checkbox]')?.checked).map((row,index) => {
          const inputs = row.querySelectorAll('input');
          const source = lines[Number(row.dataset.receiptLine || index)] || {};
          const totalCents = Math.max(0, Math.round((Number(inputs[2]?.value) || 0) * 100));
          return { ...source, description:clean(inputs[1]?.value), name:clean(inputs[1]?.value), total_cents:totalCents, amount_cents:totalCents };
        });
        if (!items.length) return;
        event.currentTarget.disabled = true;
        try {
          await window.CrewAPI.projects.addMaterialsFromReceipt(orgId(context), projectId(context), {
            receipt_id:receipt.id,
            list_id:mount.querySelector('[data-receipt-list]')?.value || '',
            items,
            total_cents:Number(receipt.total_cents || extraction.total_cents || 0),
            purchase_date:first(receipt.purchase_date, extraction.purchase_date),
            purchase_time:first(receipt.purchase_time, extraction.purchase_time)
          });
          reviewReceipt = null;
          showToast((globalThis.PlatformLanguage?.text("crew","m_ed27b962a40601","Receipt added") ?? "Receipt added"),((v0,v1) => globalThis.PlatformLanguage?.text("crew","m_4505f54b272990",`${v0} receipt item${v1} added to the project.`,{v0,v1}) ?? `${v0} receipt item${v1} added to the project.`)(items.length,items.length === 1 ? '' : 's'),true);
          await load();
        } catch (error) {
          mount.querySelector('[data-receipt-status]').textContent = statusError(error,'Could not append receipt items.');
          event.currentTarget.disabled = false;
        }
      });
    };
    const uploadReceipts = async (filesValue) => {
      const files = Array.from(filesValue || []).filter(Boolean);
      if (!files.length || !window.PaymentsAPI?.receipts?.batch) return;
      const mount = root.querySelector('[data-receipt-review]');
      if (mount) mount.innerHTML = '';
      const batchMount = () => root.querySelector('[data-material-receipt-batch]');
      try {
        await window.PaymentsAPI.receipts.batch(files, async (file, batchOptions) => {
          const options = {
            ...batchOptions,
            project_id:projectId(context),
            associations:[{ kind:'project', id:projectId(context) },{ kind:'organization_user', id:userId(context) }],
            owner:{ kind:'organization_user', id:userId(context) },
            metadata:{ ...(batchOptions.metadata || {}), source:'crew_project_materials' }
          };
          try {
            return await window.PaymentsAPI.receipts.uploadFor(orgId(context), file, options);
          } catch (error) {
            if (Number(error?.status) !== 403) throw error;
            return window.PaymentsAPI.receipts.uploadFor(orgId(context), file, { ...options, project_id:'', associations:[{ kind:'organization_user', id:userId(context) }] });
          }
        }, {
          concurrency:4,
          idempotency_key:`crew-project-${projectId(context)}-${Date.now()}`,
          onUpdate:(_item, items) => {
            receiptBatchItems = items;
            const target = batchMount();
            if (target) target.innerHTML = receiptBatchHtml(receiptBatchItems, { review:true });
            target?.querySelectorAll('[data-crew-batch-review]').forEach((button) => button.addEventListener('click', () => {
              reviewReceipt = receiptBatchItems.find((item) => clean(item.receipt?.id) === clean(button.dataset.crewBatchReview))?.receipt || null;
              renderReceiptReview();
            }));
          }
        });
      } catch (error) {
        if (mount) mount.innerHTML = stateHtml('error',statusError(error,'Could not read the receipts.'));
      }
    };
    const load = async () => {
      const listRoot = root.querySelector('[data-material-lists]');
      if (!result && listRoot) listRoot.innerHTML = stateHtml();
      try {
        result = await window.CrewAPI.projects.materials(orgId(context), projectId(context));
        if (!destroyed) render();
      } catch (error) {
        if (!destroyed) root.innerHTML = `<div class="crew-project-page">${stateHtml('error',statusError(error,'Could not load materials.'))}</div>`;
      }
    };
    root.innerHTML = `<div class="crew-project-page">${stateHtml()}</div>`;
    load();
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  function mountProjectPayouts(context = {}){
    const root = projectMountRoot(context, 'payouts');
    let destroyed = false;
    root.innerHTML = `<div class="crew-project-page"><div class="crew-page" data-project-earnings>${stateHtml('loading','Loading project earnings')}</div></div>`;
    const mount = root.querySelector('[data-project-earnings]');
    loadMyEarnings(context, { project_id:projectId(context) }).then((result) => { if (!destroyed) renderEarningsPage(mount,result,'This project',{ details:true }); }).catch((error) => { if (!destroyed) mount.innerHTML = stateHtml('error',statusError(error,'Could not load your earnings for this project.')); });
    return { destroy(){ destroyed = true; root.innerHTML = ''; } };
  }

  function paymentData(result = {}){
    const source = obj(result.payment_summary || result.summary || result);
    const obligations = responseRows(source,'obligations','payment_obligations');
    const payments = responseRows(source,'payments','transactions','history');
    const summary = obj(source.summary || source.money_summary || source.totals || source);
    const total = Number(first(summary.total_cents,summary.contract_total_cents,source.total_cents,obligations.reduce((sum,item)=>sum+Number(item.amount_cents||0),0))) || 0;
    const paid = Number(first(summary.paid_cents,summary.collected_cents,source.paid_cents,payments.filter((item)=>clean(item.status)==='settled').reduce((sum,item)=>sum+Number(item.amount_cents||0),0))) || 0;
    const due = Number(first(summary.due_cents,summary.remaining_cents,source.due_cents,Math.max(0,total-paid))) || 0;
    const next = obj(source.next_payment || source.next_obligation || obligations.find((item) => !['paid','void'].includes(clean(item.status))));
    return { obligations,payments,summary,total,paid,due,next };
  }

  function mountProjectPayments(context = {}){
    const root = projectMountRoot(context, 'payments');
    let destroyed = false;
    let result = null;
    const canTakePayment = context.params?.can_take_payment === true;
    const showPaymentForm = () => root.querySelector('[data-payment-form]')?.classList.add('open');
    const syncHeaderAction = () => { if (context.active !== false) context.setHeaderAction?.(canTakePayment ? { label:(globalThis.PlatformLanguage?.text("crew","m_6bde9831b8d0ff","Record Payment") ?? "Record Payment"), icon:'fa-plus', onClick:showPaymentForm } : null); };
    const render = () => {
      const data = paymentData(result);
      root.innerHTML = `<div class="crew-project-page"><div class="crew-page"><div class="crew-summary-grid"><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_59d1f6f44b2d3a","Amount due") ?? "Amount due")}</span><strong>${String(esc(currency(data.due)))}</strong></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_2e84162dfa6e1d","Next payment") ?? "Next payment")}</span><strong>${String(esc(currency(Number(data.next.amount_cents || 0))))}</strong><small>${String(esc(shortDate(data.next.due_at,'Not scheduled')))}</small></div><div class="crew-summary"><span>${(globalThis.PlatformLanguage?.text("crew","m_21a721f5fdec30","Project total") ?? "Project total")}</span><strong>${String(esc(currency(data.total)))}</strong><small>${String(esc(`${currency(data.paid)} collected`))}</small></div></div><section class="crew-card crew-inline-form" data-payment-form><div class="crew-card-title"><div><h3>${(globalThis.PlatformLanguage?.text("crew","m_cf2e333ad7c693","Record an on-site payment") ?? "Record an on-site payment")}</h3><small>${(globalThis.PlatformLanguage?.text("crew","m_9dfda30a653c48","This records money already received; it does not process a card or bank transfer.") ?? "This records money already received; it does not process a card or bank transfer.")}</small></div></div><div class="crew-form"><div class="crew-form-grid"><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_2b8c3448fa87a1","Amount") ?? "Amount")}<input data-payment-amount inputmode="decimal" value="${String(esc(((Number(data.next.amount_cents)||data.due)/100).toFixed(2)))}"></label><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_6952fe71f8dc85","Method") ?? "Method")}<select data-payment-method><option value="check">${(globalThis.PlatformLanguage?.text("crew","m_cc74e4e6c905ec","Check") ?? "Check")}</option><option value="cash">${(globalThis.PlatformLanguage?.text("crew","m_f758b041cf8d5c","Cash") ?? "Cash")}</option></select></label><label class="crew-field wide">${(globalThis.PlatformLanguage?.text("crew","m_963906ea70bf9a","Note") ?? "Note")}<input data-payment-note placeholder="${(globalThis.PlatformLanguage?.text("crew","m_303cd92e76c991","Check number or optional note") ?? "Check number or optional note")}"></label></div><div class="crew-form-actions"><button class="crew-btn ghost" type="button" data-payment-cancel>${(globalThis.PlatformLanguage?.text("crew","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="crew-btn primary" type="button" data-payment-save>${(globalThis.PlatformLanguage?.text("crew","m_3b7bc8bf145411","Record received payment") ?? "Record received payment")}</button></div><div class="crew-sub" data-payment-status></div></div></section><section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_5b23b718776ab9","Past payments") ?? "Past payments")}</h3><small>${String(data.payments.length)}</small></div>${String(data.payments.length ? `<div class="crew-row-list">${data.payments.map((payment) => `<div class="crew-row"><div class="crew-row-copy"><strong>${esc(first(obj(payment.method).label,obj(payment.method).type,obj(payment.method).kind,payment.kind,'Payment'))}</strong><span>${esc(shortDate(first(payment.received_at,payment.created_at)))} &middot; ${esc(clean(payment.status||'settled'))}</span></div><div class="crew-row-value">${esc(currency(Number(payment.amount_cents||0)))}</div></div>`).join('')}</div>` : stateHtml('empty','No payments have been recorded.'))}</section></div></div>`;
      if (!canTakePayment) {
        root.querySelector('[data-payment-add]')?.remove();
        root.querySelector('[data-payment-form]')?.remove();
      }
      const form = root.querySelector('[data-payment-form]');
      syncHeaderAction();
      root.querySelector('[data-payment-cancel]')?.addEventListener('click', () => form?.classList.remove('open'));
      root.querySelector('[data-payment-save]')?.addEventListener('click', async (event) => {
        const cents = Math.max(0,Math.round((Number(root.querySelector('[data-payment-amount]')?.value)||0)*100));
        if (!cents) return showToast((globalThis.PlatformLanguage?.text("crew","m_8c6b93a6f46da8","Amount required") ?? "Amount required"),(globalThis.PlatformLanguage?.text("crew","m_a2ae9e22e3c024","Enter a payment amount.") ?? "Enter a payment amount."),false);
        event.currentTarget.disabled = true;
        try {
          const method = root.querySelector('[data-payment-method]')?.value || 'check';
          await window.CrewAPI.projects.takePayment(orgId(context),projectId(context),{ amount_cents:cents, method:{ type:method, kind:method, label:method === 'cash' ? 'Cash' : 'Check' }, notes:clean(root.querySelector('[data-payment-note]')?.value), obligation_id:data.next.id||'', status:'settled' });
          showToast((globalThis.PlatformLanguage?.text("crew","m_e14ce2b0e5f1e9","Payment recorded") ?? "Payment recorded"),((v0,v1) => globalThis.PlatformLanguage?.text("crew","m_77ac2cdca888e2",`${v0} received by ${v1} was added to the project.`,{v0,v1}) ?? `${v0} received by ${v1} was added to the project.`)(currency(cents),method),true);
          await load();
        } catch (error) {
          root.querySelector('[data-payment-status]').textContent = statusError(error,'Could not record the payment.');
          event.currentTarget.disabled = false;
        }
      });
    };
    const load = async () => {
      try { result = await window.CrewAPI.projects.payments(orgId(context),projectId(context)); if (!destroyed) render(); }
      catch (error) { if (!destroyed) root.innerHTML = `<div class="crew-project-page">${stateHtml('error',statusError(error,'Could not load payments.'))}</div>`; }
    };
    root.innerHTML = `<div class="crew-project-page">${stateHtml()}</div>`;
    load();
    return {
      activate(nextContext = {}){ context = { ...context, ...nextContext, active:true }; syncHeaderAction(); },
      deactivate(){ context.active = false; },
      destroy(){ destroyed=true; root.innerHTML=''; }
    };
  }

  function changeOrders(result = {}) { return responseRows(result,'change_orders','proposals','items'); }
  function changeOrderTotal(order = {}){
    const explicit = Number(first(order.total_cents,order.amount_cents,obj(order.editable).pricing?.total_cents));
    if (Number.isFinite(explicit) && explicit) return explicit;
    return arr(order.items || obj(order.editable).scope?.root_items).reduce((sum,item)=>sum+itemTotalCents(item),0);
  }
  function publicToken(order = {}){
    return clean(first(order.public_token,obj(order.delivery).current_public_token,obj(order.delivery).public_token,obj(order.snapshot).delivery?.public_token));
  }
  function changeOrderStatusLabel(order = {}){
    const status = clean(order.status || 'draft').replace(/_/g, ' ');
    const recipients = arr(obj(order.delivery).recipients);
    return status === 'sent' && !recipients.length ? 'link ready' : status;
  }

  function mountProjectChangeOrders(context = {}){
    const root = projectMountRoot(context,'change_orders');
    let destroyed=false;
    let result=null;
    const canManage = context.params?.can_manage === true;
    const line = () => `<div class="crew-co-line" data-co-line><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_5be12a31e41de3","Item") ?? "Item")}<input data-co-description placeholder="${(globalThis.PlatformLanguage?.text("crew","m_d274affab502e2","Additional work") ?? "Additional work")}"></label><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_1a29aea570fbc4","Qty") ?? "Qty")}<input data-co-quantity type="number" step="0.01" value="1"></label><label class="crew-field">${(globalThis.PlatformLanguage?.text("crew","m_bc7b189271d609","Unit price") ?? "Unit price")}<input data-co-price inputmode="decimal" placeholder="0.00"></label><button class="crew-icon-btn danger" type="button" data-co-remove aria-label="${(globalThis.PlatformLanguage?.text("crew","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-trash"></i></button></div>`;
    const render = () => {
      const orders=changeOrders(result);
      root.innerHTML=`<div class="crew-project-page"><div class="crew-page"><div class="crew-head"><div><div class="crew-eyebrow">${(globalThis.PlatformLanguage?.text("crew","m_a7e3569f7a7d11","Project amendments") ?? "Project amendments")}</div><h2 class="crew-title" style="font-size:26px">${(globalThis.PlatformLanguage?.text("crew","m_9b66c8f287b44d","Change orders") ?? "Change orders")}</h2><p class="crew-sub">${(globalThis.PlatformLanguage?.text("crew","m_9f6e73064d4fa1","Add work and prepare a customer signing and payment link.") ?? "Add work and prepare a customer signing and payment link.")}</p></div><button class="crew-btn primary" type="button" data-co-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("crew","m_d80ab804f02b15"," New change order") ?? " New change order")}</button></div><section class="crew-card crew-inline-form" data-co-form><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_530a38e148745f","New change order") ?? "New change order")}</h3></div><div class="crew-form"><div class="crew-form-grid"><label class="crew-field wide">${(globalThis.PlatformLanguage?.text("crew","m_29dbd3d8b69f55","Title") ?? "Title")}<input data-co-title value="Change order"></label><label class="crew-field wide">${(globalThis.PlatformLanguage?.text("crew","m_b3ecc234f63212","Details") ?? "Details")}<textarea data-co-details placeholder="${(globalThis.PlatformLanguage?.text("crew","m_9a2af7162eb5c6","Describe why this work is being added") ?? "Describe why this work is being added")}"></textarea></label></div><div class="crew-co-lines" data-co-lines>${String(line())}</div><button class="crew-btn ghost" type="button" data-co-line-add style="justify-self:start"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.text("crew","m_e10157c757b2aa"," Add line") ?? " Add line")}</button><div class="crew-form-actions"><button class="crew-btn ghost" type="button" data-co-cancel>${(globalThis.PlatformLanguage?.text("crew","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="crew-btn primary" type="button" data-co-save>${(globalThis.PlatformLanguage?.text("crew","m_657d2fe886023d","Create change order") ?? "Create change order")}</button></div><div class="crew-sub" data-co-status></div></div></section><section class="crew-card"><div class="crew-card-title"><h3>${(globalThis.PlatformLanguage?.text("crew","m_9b66c8f287b44d","Change orders") ?? "Change orders")}</h3><small>${String(orders.length)}</small></div>${String(orders.length?`<div class="crew-row-list">${orders.map((order)=>{const token=publicToken(order);const hasRecipient=arr(order.contacts).some((contact)=>clean(contact?.email));return `<div class="crew-row has-actions"><div class="crew-row-copy"><strong>${esc(first(order.title,'Change order'))}</strong><span>${esc(changeOrderStatusLabel(order))} &middot; ${esc(shortDate(order.updated_at||order.created_at))}</span></div><div class="crew-row-actions"><div class="crew-row-value">${esc(currency(changeOrderTotal(order)))}</div>${clean(order.status)==='draft'?`<button class="crew-btn" type="button" data-co-send="${esc(order.id)}">${hasRecipient?'Send':'Prepare link'}</button>`:''}${token?`<button class="crew-btn primary" type="button" data-co-open="${esc(order.id)}">Sign & pay</button>`:''}</div></div>`}).join('')}</div>`:stateHtml('empty','No change orders have been created.'))}</section></div></div>`;
      if (!canManage) {
        root.querySelector('[data-co-add]')?.remove();
        root.querySelector('[data-co-form]')?.remove();
        root.querySelectorAll('[data-co-send]').forEach((button) => button.remove());
      }
      const form=root.querySelector('[data-co-form]');
      const lines=root.querySelector('[data-co-lines]');
      const bindLines=()=>lines?.querySelectorAll('[data-co-remove]').forEach((button)=>{button.onclick=()=>{if(lines.querySelectorAll('[data-co-line]').length>1)button.closest('[data-co-line]')?.remove();};});
      bindLines();
      root.querySelector('[data-co-add]')?.addEventListener('click',()=>form?.classList.add('open'));
      root.querySelector('[data-co-cancel]')?.addEventListener('click',()=>form?.classList.remove('open'));
      root.querySelector('[data-co-line-add]')?.addEventListener('click',()=>{lines?.insertAdjacentHTML('beforeend',line());bindLines();});
      root.querySelector('[data-co-save]')?.addEventListener('click',async(event)=>{
        const items=Array.from(root.querySelectorAll('[data-co-line]')).map((row,index)=>{const description=clean(row.querySelector('[data-co-description]')?.value);const quantity=Math.max(0,Number(row.querySelector('[data-co-quantity]')?.value)||1);const unitPriceCents=Math.max(0,Math.round((Number(row.querySelector('[data-co-price]')?.value)||0)*100));const unitPrice=unitPriceCents/100;const totalCents=Math.round(quantity*unitPriceCents);return{id:`change_${index+1}`,description,name:description,quantity,unit_price:unitPrice,base_price:unitPrice,amount:totalCents/100,total:totalCents/100,unit_price_cents:unitPriceCents,total_cents:totalCents};}).filter((item)=>item.description);
        if(!items.length)return showToast((globalThis.PlatformLanguage?.text("crew","m_a5b3a55e6096a0","Line item required") ?? "Line item required"),(globalThis.PlatformLanguage?.text("crew","m_4b3d60129b3730","Add at least one change-order item.") ?? "Add at least one change-order item."),false);
        event.currentTarget.disabled=true;
        try{const totalCents=items.reduce((sum,item)=>sum+Number(item.total_cents||0),0);await window.CrewAPI.projects.createChangeOrder(orgId(context),projectId(context),{title:clean(root.querySelector('[data-co-title]')?.value)||'Change order',description:clean(root.querySelector('[data-co-details]')?.value),items,pricing:{subtotal:totalCents/100,total:totalCents/100,subtotal_cents:totalCents,total_cents:totalCents}});showToast((globalThis.PlatformLanguage?.text("crew","m_13965faaabf3ee","Change order created") ?? "Change order created"),(globalThis.PlatformLanguage?.text("crew","m_ae016ab3a69eef","The change order is ready for a signing link.") ?? "The change order is ready for a signing link."),true);await load();}
        catch(error){root.querySelector('[data-co-status]').textContent=statusError(error,'Could not create the change order.');event.currentTarget.disabled=false;}
      });
      root.querySelectorAll('[data-co-send]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;try{const prepared=await window.CrewAPI.projects.sendChangeOrder(orgId(context),projectId(context),button.dataset.coSend,{include_pdf:true,include_portal:true});const delivery=obj(prepared?.delivery_result||prepared?.portal);showToast(delivery.delivered===true?'Change order sent':'Signing link ready',delivery.delivered===true?'The customer received the signing link.':'Open Sign & pay to review it with the customer.',true);result=prepared?.change_orders?prepared:await window.CrewAPI.projects.changeOrders(orgId(context),projectId(context));render();}catch(error){showToast((globalThis.PlatformLanguage?.text("crew","m_5d89b963e4f999","Could not prepare link") ?? "Could not prepare link"),statusError(error),false);button.disabled=false;}}));
      root.querySelectorAll('[data-co-open]').forEach((button)=>button.addEventListener('click',()=>{const order=orders.find((item)=>clean(item.id)===button.dataset.coOpen);const token=publicToken(order);if(!token)return;const url=window.ProposalsAPI?.public?.appUrl?.(token);if(url)window.open(url,'_blank','noopener');}));
    };
    const load=async()=>{try{result=await window.CrewAPI.projects.changeOrders(orgId(context),projectId(context));if(!destroyed)render();}catch(error){if(!destroyed)root.innerHTML=`<div class="crew-project-page">${stateHtml('error',statusError(error,'Could not load change orders.'))}</div>`;}};
    root.innerHTML=`<div class="crew-project-page">${stateHtml()}</div>`;load();
    return{destroy(){destroyed=true;root.innerHTML='';}};
  }

  const RATING_ICONS = { good:'fa-check', neutral:'fa-minus', bad:'fa-xmark' };
  const RATING_WORDS = { good:'Good', neutral:'Okay', bad:'Needs work' };
  function mountProjectChecklist(context={}){
    const root=projectMountRoot(context,'checklists');
    let destroyed=false;
    let data=null;
    const noteState={}; // itemId -> note and evidence interaction state
    const checklists=()=>arr(data?.checklists);
    const state=(id)=>noteState[id]||(noteState[id]={open:false,draft:null,pendingRating:'',hint:false,focus:false,evidenceHint:false,uploading:''});
    const itemSubtitle=(item)=>{
      if(!item.completed)return '';
      const label=item.item_type==='rating'?(RATING_WORDS[item.rating]||'Rated'):'Done';
      return [label,clean(item.completed_by_name),shortDate(item.completed_at)].filter(Boolean).join(' · ');
    };
    const evidenceKindMatches=(requiredKind,attachment,allowedKinds=[])=>{
      const kind=clean(attachment.kind).toLowerCase();
      const contentType=clean(attachment.content_type).toLowerCase();
      const fileName=clean(attachment.file_name).toLowerCase();
      if(allowedKinds.length)return allowedKinds.some((allowed)=>evidenceKindMatches(allowed,attachment));
      if(requiredKind==='any')return true;
      if(requiredKind==='media')return ['photo','video','audio'].includes(kind)||contentType.startsWith('image/')||contentType.startsWith('video/')||contentType.startsWith('audio/');
      if(requiredKind==='photo')return kind==='photo'||contentType.startsWith('image/');
      if(requiredKind==='video')return kind==='video'||contentType.startsWith('video/');
      if(requiredKind==='audio')return kind==='audio'||contentType.startsWith('audio/');
      if(requiredKind==='email')return kind==='email'||contentType==='message/rfc822'||/\.(eml|msg)$/.test(fileName);
      if(requiredKind==='document')return ['document','email'].includes(kind)||(!contentType.startsWith('image/')&&!contentType.startsWith('video/')&&!contentType.startsWith('audio/'));
      return false;
    };
    const evidenceRequirements=(item)=>{
      const metadata=obj(item.metadata);
      const attachments=arr(metadata.attachments);
      return arr(metadata.required_attachments).map((value,index)=>{
        const requirement=obj(value);
        const kind=clean(requirement.kind).toLowerCase()||'any';
        const allowed=arr(requirement.allowed_kinds).map((entry)=>clean(entry).toLowerCase()).filter(Boolean);
        const minimum=Math.max(1,Math.min(20,Math.round(Number(requirement.min_count)||1)));
        const id=clean(requirement.id);
        const matches=attachments.filter((attachment)=>(!id||!clean(attachment.requirement_id)||clean(attachment.requirement_id)===id)&&evidenceKindMatches(kind,attachment,allowed));
        const displayKind=kind==='media'&&allowed.length===1?allowed[0]:kind;
        const defaults={media:'Media file',photo:'Photo',video:'Video',audio:'Audio recording',document:'Document',email:'Email file',any:'Attachment'};
        const icons={media:'fa-camera',photo:'fa-camera',video:'fa-video',audio:'fa-microphone',document:'fa-file-arrow-up',email:'fa-envelope',any:'fa-paperclip'};
        const accepts={media:'image/*,video/*,audio/*',photo:'image/*',video:'video/*',audio:'audio/*',document:'.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.eml,.msg,message/rfc822',email:'.eml,.msg,message/rfc822',any:'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.eml,.msg,message/rfc822'};
        const accept=[...new Set((allowed.length?allowed:[kind]).flatMap((entry)=>clean(accepts[entry]||accepts.any).split(',')))].join(',');
        const defaultLabel=kind==='media'&&allowed.length&&allowed.every((entry)=>['photo','video'].includes(entry))?'Photo or video':defaults[displayKind]||defaults[kind];
        return{...requirement,id,key:id||`requirement_${index}`,kind,allowed,minimum,matches,met:matches.length>=minimum,label:first(requirement.label,defaultLabel,'Required evidence'),icon:icons[displayKind]||icons[kind]||icons.any,accept,recordOnly:kind==='audio'||(allowed.length===1&&allowed[0]==='audio')};
      });
    };
    const applyItemResult=(checklistId,itemId,resultItem)=>{
      const list=checklists().find((entry)=>entry.id===checklistId);
      const index=arr(list?.items).findIndex((entry)=>entry.id===itemId);
      if(!list||index<0)return;
      const previous=list.items[index];
      const updated={...obj(resultItem)};
      updated.completed_by_name=updated.completed_by_user_id&&updated.completed_by_user_id===userId(context)
        ?clean(first(Portal.currentUser?.name,Portal.currentUser?.display_name,'You'))
        :(updated.completed_by_user_id===previous.completed_by_user_id?previous.completed_by_name:'');
      list.items[index]=updated;
      list.completed_items=list.items.filter((entry)=>entry.completed).length;
    };
    const patchItem=async(checklistId,itemId,patch)=>{
      const result=await window.CrewAPI.projects.updateItemInChecklist(orgId(context),projectId(context),checklistId,itemId,patch);
      applyItemResult(checklistId,itemId,result.item);
      render();
    };
    const itemHtml=(checklist,item)=>{
      const rating=item.item_type==='rating';
      const drawer=state(item.id);
      const canComplete=checklist.can_complete===true;
      const canEdit=checklist.can_edit===true;
      const classes=['crew-cl-item',item.completed?'done':'',rating?(item.rating==='bad'?'bad':''):'is-todo'].filter(Boolean).join(' ');
      const control=rating
        ?`<div class="crew-cl-rate">${['good','neutral','bad'].map((value)=>`<button type="button" data-cl-rate="${value}" class="${item.rating===value?'on':''}" ${canComplete?'':'disabled'} aria-label="${esc(RATING_WORDS[value])}"><i class="fas ${RATING_ICONS[value]}"></i></button>`).join('')}</div>`
        :'';
      const check=rating?'':`<button type="button" class="crew-cl-check" data-cl-toggle ${String(canComplete?'':'disabled')} aria-label="${(globalThis.PlatformLanguage?.text("crew","m_892c2703c8b0d7","Complete item") ?? "Complete item")}"><i class="fas fa-check"></i></button>`;
      const actions=canEdit?`<span class="crew-cl-actions"><button class="crew-icon-btn" type="button" data-cl-edit aria-label="${(globalThis.PlatformLanguage?.text("crew","m_5b9378df7220c1","Edit") ?? "Edit")}"><i class="fas fa-pen"></i></button><button class="crew-icon-btn danger" type="button" data-cl-delete aria-label="${(globalThis.PlatformLanguage?.text("crew","m_4fc60207629a44","Delete") ?? "Delete")}"><i class="fas fa-trash"></i></button></span>`:'';
      const noteButton=rating?("<button class=\"crew-icon-btn\" type=\"button\" data-cl-note-open aria-label=\"" + (globalThis.PlatformLanguage?.text("crew","m_963906ea70bf9a","Note") ?? "Note") + "\" style=\"" + String(item.note?'color:#175cd3;':'') + "\"><i class=\"fas fa-comment" + String(item.note?'':'-medical') + "\"></i></button>"):'';
      const noteLine=rating&&item.note&&!drawer.open?`<div class="crew-cl-note-line" data-cl-note-open><i class="fas fa-comment"></i><span>${esc(item.note)}</span></div>`:'';
      const requireNote=(drawer.pendingRating||item.rating)==='bad';
      const drawerHtml=rating?`<div class="crew-cl-drawer ${String(drawer.open?'open':'')}"><div><div class="crew-cl-drawer-inner"><textarea data-cl-note placeholder="${String(requireNote?'Describe what needs attention…':'Add a note for this item…')}">${String(esc(drawer.draft??item.note))}</textarea>${String(drawer.hint?'<div class="crew-cl-drawer-hint">A note is required before this item can be marked bad.</div>':'')}<div class="crew-cl-drawer-actions"><button class="crew-btn ghost" type="button" data-cl-note-cancel>${(globalThis.PlatformLanguage?.text("crew","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="crew-btn primary" type="button" data-cl-note-save>${String(drawer.pendingRating?'Save rating':'Save note')}</button></div></div></div></div>`:'';
      const requirements=evidenceRequirements(item);
      const attachmentRows=arr(obj(item.metadata).attachments);
      const evidenceHtml=requirements.length?`<div class="crew-cl-evidence ${drawer.evidenceHint?'hint':''}" data-cl-evidence>
        ${requirements.map((requirement)=>`<div class="crew-cl-requirement ${String(requirement.met?'met':'missing')}"><i class="fas ${String(requirement.met?'fa-check':requirement.icon)}"></i><div class="crew-cl-requirement-copy"><strong>${String(esc(requirement.label))}</strong><span>${((v3,v4,v5) => globalThis.PlatformLanguage?.text("crew","m_c35ccba2063e20",`${v3}/${v4} attached${v5}`,{v3,v4,v5}) ?? `${v3}/${v4} attached${v5}`)(requirement.matches.length,requirement.minimum,requirement.met?' · Ready':'')}</span></div>${String(canComplete?(requirement.recordOnly?`<button class="crew-cl-upload crew-cl-record" type="button" data-cl-evidence-record="${esc(requirement.key)}" ${drawer.uploading?'disabled':''}><i class="fas fa-microphone"></i>Record</button>`:`<button class="crew-cl-upload" type="button" data-cl-evidence-add="${esc(requirement.key)}" ${drawer.uploading?'disabled':''}><i class="fas ${drawer.uploading===requirement.key?'fa-spinner fa-spin':'fa-arrow-up-from-bracket'}"></i>${drawer.uploading===requirement.key?'Uploading':'Add'}</button><input type="file" hidden multiple data-cl-evidence-input="${esc(requirement.key)}" accept="${esc(requirement.accept)}">`):'')}</div>${String(canComplete&&requirement.recordOnly?`<div class="crew-cl-evidence-recorder" data-cl-evidence-recorder="${esc(requirement.key)}"></div>`:'')}`).join('')}
        ${drawer.evidenceHint&&requirements.some((entry)=>!entry.met)?`<div class="crew-cl-evidence-hint"><i class="fas fa-circle-exclamation"></i>${(globalThis.PlatformLanguage?.text("crew","m_b84b57a4a1d9f6"," Add the required files before completing this item.") ?? " Add the required files before completing this item.")}</div>`:''}
        ${attachmentRows.length?`<div class="crew-cl-evidence-files">${attachmentRows.map((attachment)=>`<span class="crew-cl-evidence-file"><i class="fas fa-paperclip"></i><span>${esc(first(attachment.file_name,attachment.kind,'Attachment'))}</span></span>`).join('')}</div>`:''}
      </div>`:'';
      return `<div class="${classes}" data-cl-item="${esc(checklist.id)}::${esc(item.id)}"><div class="crew-cl-main">${check}<div class="crew-cl-item-copy"><strong>${esc(first(item.title,item.label,'Checklist item'))}</strong>${itemSubtitle(item)?`<span>${esc(itemSubtitle(item))}</span>`:''}</div>${control}${noteButton}${actions}</div>${evidenceHtml}${noteLine}${drawerHtml}</div>`;
    };
    const checklistHtml=(checklist)=>{
      const items=arr(checklist.items);
      const total=items.length;
      const doneCount=items.filter((item)=>item.completed).length;
      const percent=total?Math.round((doneCount/total)*100):0;
      const supervisor=checklist.audience==='supervisor';
      const quality=checklist.kind==='quality';
      const accessPill=checklist.can_edit?`<span class="crew-pill good">${(globalThis.PlatformLanguage?.text("crew","m_d9e27fdaa430b5","Editable") ?? "Editable")}</span>`:checklist.can_complete?`<span class="crew-pill">${quality?'Rate items':'Check off'}</span>`:`<span class="crew-pill warn">${(globalThis.PlatformLanguage?.text("crew","m_65ed6dd2cd3755","Read only") ?? "Read only")}</span>`;
      const assignedCount=arr(checklist.assigned_user_ids).length+arr(checklist.assigned_role_ids).length+arr(checklist.assigned_resource_group_ids).length;
      const assignmentPill=checklist.assignment_required?`<span class="crew-pill warn">${(globalThis.PlatformLanguage?.text("crew","m_4bde5430c931ff","Needs assignment") ?? "Needs assignment")}</span>`:assignedCount?`<span class="crew-pill good"><i class="fas fa-user-check"></i>${(globalThis.PlatformLanguage?.text("crew","m_5a1e07a6bc5770"," Assigned") ?? " Assigned")}</span>`:Object.keys(obj(checklist.assignment_policy)).length?`<span class="crew-pill"><i class="fas fa-users"></i>${(globalThis.PlatformLanguage?.text("crew","m_c1297bb46922d3"," Any eligible") ?? " Any eligible")}</span>`:'';
      return `<section class="crew-card" data-cl-list="${esc(checklist.id)}"><div class="crew-cl-head"><span class="crew-cl-icon ${supervisor?'supervisor':''}"><i class="fas ${esc(first(checklist.icon,quality?'fa-clipboard-check':'fa-list-check'))}"></i></span><div class="crew-cl-copy"><h3>${esc(checklist.title)}</h3></div><div class="crew-cl-progress"><span class="crew-cl-count">${doneCount}/${total}</span><span class="crew-cl-bar"><i style="width:${percent}%"></i></span></div></div><div class="crew-cl-meta">${supervisor?`<span class="crew-pill" style="background:#eff8ff;color:#175cd3">${(globalThis.PlatformLanguage?.text("crew","m_80a95b33172678","Supervisor") ?? "Supervisor")}</span>`:`<span class="crew-pill">${(globalThis.PlatformLanguage?.text("crew","m_5b8ee9e9110e54","Crew") ?? "Crew")}</span>`}${quality?`<span class="crew-pill" style="background:#fdf4ff;color:#9f1ab1">${(globalThis.PlatformLanguage?.text("crew","m_c2c285ec01b1b5","Quality review") ?? "Quality review")}</span>`:''}${assignmentPill}${accessPill}</div><div class="crew-cl-items">${items.length?items.map((item)=>itemHtml(checklist,item)).join(''):`<div class="crew-sub">${(globalThis.PlatformLanguage?.text("crew","m_bfe2f5665c1cf0","No items on this checklist yet.") ?? "No items on this checklist yet.")}</div>`}</div>${checklist.can_edit?`<div class="crew-cl-add"><input data-cl-new placeholder="${(globalThis.PlatformLanguage?.text("crew","m_7b2113cc856add","Add an item…") ?? "Add an item…")}"><select data-cl-new-type><option value="todo" ${String(quality?'':'selected')}>${(globalThis.PlatformLanguage?.text("crew","m_dc3195e2b61dfc","Check item") ?? "Check item")}</option><option value="rating" ${String(quality?'selected':'')}>${(globalThis.PlatformLanguage?.text("crew","m_98cd0b14518eb3","Rating item") ?? "Rating item")}</option></select><button class="crew-btn primary" type="button" data-cl-add><i class="fas fa-plus"></i></button></div>`:''}</section>`;
    };
    const render=()=>{
      const lists=checklists();
      root.innerHTML=`<div class="crew-project-page"><div class="crew-page narrow"><div class="crew-cl-stack">${lists.length?lists.map(checklistHtml).join(''):stateHtml('empty','No checklists are available for this project.')}</div></div></div>`;
      bind();
      const focused=Object.entries(noteState).find(([,value])=>value.focus);
      if(focused){
        const node=root.querySelector(`[data-cl-item$="::${focused[0]}"] [data-cl-note]`);
        noteState[focused[0]].focus=false;
        if(node){node.focus();node.setSelectionRange(node.value.length,node.value.length);}
      }
    };
    const bind=()=>{
      root.querySelectorAll('[data-cl-item]').forEach((row)=>{
        const [checklistId,itemId]=String(row.dataset.clItem).split('::');
        const list=checklists().find((entry)=>entry.id===checklistId);
        const item=arr(list?.items).find((entry)=>entry.id===itemId);
        if(!list||!item)return;
        const drawer=state(itemId);
        const blockForEvidence=()=>{
          drawer.evidenceHint=true;
          showToast((globalThis.PlatformLanguage?.text("crew","m_998cedfec4e568","Evidence required") ?? "Evidence required"),(globalThis.PlatformLanguage?.text("crew","m_802fda24f54002","Add the required files before completing this item.") ?? "Add the required files before completing this item."),false);
          render();
        };
        row.querySelector('[data-cl-toggle]')?.addEventListener('click',async(event)=>{
          if(!item.completed&&evidenceRequirements(item).some((requirement)=>!requirement.met)){blockForEvidence();return;}
          event.currentTarget.disabled=true;
          try{await patchItem(checklistId,itemId,{completed:!item.completed});}
          catch(error){showToast((globalThis.PlatformLanguage?.text("crew","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"),statusError(error),false);render();}
        });
        row.querySelectorAll('[data-cl-rate]').forEach((button)=>button.addEventListener('click',async()=>{
          const value=button.dataset.clRate;
          try{
            if(item.rating===value){await patchItem(checklistId,itemId,{rating:''});return;}
            if(value==='bad'&&!clean(drawer.draft??item.note)){
              drawer.open=true;drawer.pendingRating='bad';drawer.hint=false;drawer.focus=true;render();return;
            }
            if(evidenceRequirements(item).some((requirement)=>!requirement.met)){blockForEvidence();return;}
            await patchItem(checklistId,itemId,{rating:value});
          }catch(error){showToast((globalThis.PlatformLanguage?.text("crew","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"),statusError(error),false);render();}
        }));
        row.querySelectorAll('[data-cl-evidence-record]').forEach((button)=>button.addEventListener('click',async()=>{
          const requirement=evidenceRequirements(item).find((entry)=>entry.key===button.dataset.clEvidenceRecord);
          const mount=[...row.querySelectorAll('[data-cl-evidence-recorder]')].find((candidate)=>candidate.dataset.clEvidenceRecorder===button.dataset.clEvidenceRecord);
          const audioNotes=window.FirstMateAudioNotes;
          if(!requirement||!mount||!audioNotes?.recordInline||!audioNotes?.toWavFile){
            showToast((globalThis.PlatformLanguage?.text("crew","m_a512b58093caca","Voice explanation") ?? "Voice explanation"),(globalThis.PlatformLanguage?.text("crew","m_fef30846cdd0c5","Audio recording is not available in this browser.") ?? "Audio recording is not available in this browser."),false);
            return;
          }
          button.disabled=true;
          try{
            const recording=await audioNotes.recordInline({mount,maxSeconds:600,submitStyle:true,confirmPlayback:true});
            mount.innerHTML=`<div class="crew-cl-recording-process"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.text("crew","m_0960411ba118b7","Attaching voice explanation…") ?? "Attaching voice explanation…")}</span></div>`;
            const wav=await audioNotes.toWavFile(recording.file,16_000);
            const result=await window.CrewAPI.projects.attachChecklistEvidence(orgId(context),projectId(context),checklistId,itemId,wav,requirement.id||'');
            applyItemResult(checklistId,itemId,result.item);
            drawer.evidenceHint=false;
            showToast((globalThis.PlatformLanguage?.text("crew","m_afdaac801f33b2","Voice explanation added") ?? "Voice explanation added"),(globalThis.PlatformLanguage?.text("crew","m_2248816e66e03b","The recording is attached and ready.") ?? "The recording is attached and ready."));
            render();
          }catch(error){
            button.disabled=false;
            if(!/cancelled/i.test(clean(error?.message)))showToast((globalThis.PlatformLanguage?.text("crew","m_4b0fb378761bed","Recording failed") ?? "Recording failed"),statusError(error,'Could not attach the voice explanation.'),false);
            if(mount)mount.innerHTML='';
          }
        }));
        row.querySelectorAll('[data-cl-evidence-add]').forEach((button)=>button.addEventListener('click',()=>{
          const input=[...row.querySelectorAll('[data-cl-evidence-input]')].find((candidate)=>candidate.dataset.clEvidenceInput===button.dataset.clEvidenceAdd);
          input?.click();
        }));
        row.querySelectorAll('[data-cl-evidence-input]').forEach((input)=>input.addEventListener('change',async(event)=>{
          const files=[...(event.currentTarget.files||[])];
          if(!files.length)return;
          const requirement=evidenceRequirements(item).find((entry)=>entry.key===event.currentTarget.dataset.clEvidenceInput);
          drawer.uploading=requirement?.key||event.currentTarget.dataset.clEvidenceInput||'upload';
          drawer.evidenceHint=false;
          render();
          try{
            for(const file of files){
              const result=await window.CrewAPI.projects.attachChecklistEvidence(orgId(context),projectId(context),checklistId,itemId,file,requirement?.id||'');
              applyItemResult(checklistId,itemId,result.item);
            }
            drawer.uploading='';
            showToast((globalThis.PlatformLanguage?.text("crew","m_3875327ce17b1a","Evidence added") ?? "Evidence added"),files.length===1?'The file is ready.':`${files.length} files are ready.`);
            render();
          }catch(error){
            drawer.uploading='';
            drawer.evidenceHint=true;
            showToast((globalThis.PlatformLanguage?.text("crew","m_eba695c553b0b3","Upload failed") ?? "Upload failed"),statusError(error,'Could not attach that file.'),false);
            render();
          }
        }));
        row.querySelectorAll('[data-cl-note-open]').forEach((button)=>button.addEventListener('click',()=>{
          drawer.open=!drawer.open;drawer.pendingRating='';drawer.hint=false;drawer.focus=drawer.open;render();
        }));
        row.querySelector('[data-cl-note]')?.addEventListener('input',(event)=>{drawer.draft=event.currentTarget.value;});
        row.querySelector('[data-cl-note-cancel]')?.addEventListener('click',()=>{
          drawer.open=false;drawer.draft=null;drawer.pendingRating='';drawer.hint=false;render();
        });
        row.querySelector('[data-cl-note-save]')?.addEventListener('click',async(event)=>{
          const note=clean(drawer.draft??item.note);
          if((drawer.pendingRating||item.rating)==='bad'&&!note){drawer.hint=true;render();return;}
          if(drawer.pendingRating&&evidenceRequirements(item).some((requirement)=>!requirement.met)){blockForEvidence();return;}
          event.currentTarget.disabled=true;
          try{
            const patch={note};
            if(drawer.pendingRating)patch.rating=drawer.pendingRating;
            drawer.open=false;drawer.draft=null;drawer.pendingRating='';drawer.hint=false;
            await patchItem(checklistId,itemId,patch);
          }catch(error){drawer.open=true;showToast((globalThis.PlatformLanguage?.text("crew","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"),statusError(error),false);render();}
        });
        row.querySelector('[data-cl-edit]')?.addEventListener('click',async()=>{
          const title=await(Portal.ui?.prompt?.((globalThis.PlatformLanguage?.text("crew","m_0ee54a84be9c87","Edit checklist item") ?? "Edit checklist item"),item.title)||Promise.resolve(window.prompt((globalThis.PlatformLanguage?.text("crew","m_0ee54a84be9c87","Edit checklist item") ?? "Edit checklist item"),item.title)));
          if(!clean(title))return;
          try{await patchItem(checklistId,itemId,{title:clean(title)});}
          catch(error){showToast((globalThis.PlatformLanguage?.text("crew","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"),statusError(error),false);}
        });
        row.querySelector('[data-cl-delete]')?.addEventListener('click',async()=>{
          const approved=await(Portal.ui?.confirm?.((globalThis.PlatformLanguage?.text("crew","m_3dd0af0b6f7be5","Delete this checklist item?") ?? "Delete this checklist item?"))||Promise.resolve(window.confirm((globalThis.PlatformLanguage?.text("crew","m_3dd0af0b6f7be5","Delete this checklist item?") ?? "Delete this checklist item?"))));
          if(!approved)return;
          try{
            await window.CrewAPI.projects.removeItemFromChecklist(orgId(context),projectId(context),checklistId,itemId);
            await load();
          }catch(error){showToast((globalThis.PlatformLanguage?.text("crew","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"),statusError(error),false);}
        });
      });
      root.querySelectorAll('[data-cl-list]').forEach((section)=>{
        const checklistId=section.dataset.clList;
        section.querySelector('[data-cl-add]')?.addEventListener('click',async(event)=>{
          const input=section.querySelector('[data-cl-new]');
          const title=clean(input?.value);
          if(!title)return;
          event.currentTarget.disabled=true;
          try{
            await window.CrewAPI.projects.addItemToChecklist(orgId(context),projectId(context),checklistId,{
              title,
              item_type:section.querySelector('[data-cl-new-type]')?.value||'todo'
            });
            await load();
          }catch(error){showToast((globalThis.PlatformLanguage?.text("crew","m_c0e1c0020eb1c5","Checklist") ?? "Checklist"),statusError(error),false);event.currentTarget.disabled=false;}
        });
        section.querySelector('[data-cl-new]')?.addEventListener('keydown',(event)=>{
          if(event.key==='Enter')section.querySelector('[data-cl-add]')?.click();
        });
      });
    };
    const load=async()=>{
      try{
        data=await window.CrewAPI.projects.checklists(orgId(context),projectId(context));
        if(!destroyed)render();
      }catch(error){
        if(!destroyed)root.innerHTML=`<div class="crew-project-page">${stateHtml('error',statusError(error,'Could not load the checklists.'))}</div>`;
      }
    };
    root.innerHTML=`<div class="crew-project-page">${stateHtml()}</div>`;load();
    return{destroy(){destroyed=true;root.innerHTML='';}};
  }

  function registerProject({id,title,icon,kind,mount,terminologyKey}){
    runtime.registerApp({id,kind:'project_modal_app',title,label:title,icon,...(terminologyKey !== undefined ? { terminologyKey } : {}),visible:true,surfaces:['project_modal'],regions:['main'],requiresContext:['project'],access:crewAccess,presentation:projectPresentation,panelHtml:()=>projectPanel(kind),mount});
  }
  registerProject({id:'project.crew_overview',title:(globalThis.PlatformLanguage?.text("crew","m_d8d2e84c5e4d8b","Visit") ?? "Visit"),icon:'fa-house',kind:'overview',mount:mountProjectOverview});
  registerProject({id:'project.crew_materials',title:(globalThis.PlatformLanguage?.text("crew","m_691187e28aba8e","Materials") ?? "Materials"),icon:'fa-boxes-stacked',kind:'materials',mount:mountProjectMaterials});
  registerProject({id:'project.crew_payouts',title:(globalThis.PlatformLanguage?.text("crew","m_685ff0ff145929","Earnings") ?? "Earnings"),icon:'fa-wallet',kind:'payouts',mount:mountProjectPayouts});
  registerProject({id:'project.crew_payments',title:(globalThis.PlatformLanguage?.text("crew","m_5842802f6c8cbb","Payments") ?? "Payments"),icon:'fa-credit-card',kind:'payments',mount:mountProjectPayments});
  registerProject({id:'project.crew_change_orders',title:(globalThis.PlatformLanguage?.text("crew","m_9b66c8f287b44d","Change orders") ?? "Change orders"),icon:'fa-file-signature',kind:'change_orders',mount:mountProjectChangeOrders});
  registerProject({id:'project.crew_checklists',title:(globalThis.PlatformLanguage?.text("crew","m_4890d3d11dc3eb","Checklists") ?? "Checklists"),icon:'fa-list-check',kind:'checklists',mount:mountProjectChecklist,terminologyKey:''});
})();
