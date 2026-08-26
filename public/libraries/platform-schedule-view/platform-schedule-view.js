/* libraries/platform-schedule-view/platform-schedule-view.js
 * Reusable scheduling calendar surfaces.
 *
 * renderDailyTeam(container, options) draws a Google-Calendar-like daily team grid.
 * It can be read-only, or placement-enabled by passing placementProject and onDraftChange.
 */
(function(){
  const root = window;
  const STYLE_ID = 'platform_schedule_view_css';
  const travelCache = new Map();

  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[match]));
  }
  function clean(value){ return String(value ?? '').trim(); }
  function addressKey(value){
    return clean(value).toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s#-]/g, '').trim();
  }
  function travelKey(origin, destination){
    return `${addressKey(origin)}=>${addressKey(destination)}`;
  }
  function seedTravelCache(cache = {}){
    Object.entries(cache || {}).forEach(([key, value]) => {
      const minutes = Number(typeof value === 'object' && value ? value.minutes : value);
      if (!key || !Number.isFinite(minutes) || minutes <= 0) return;
      travelCache.set(key, Math.max(1, Math.ceil(minutes)));
    });
  }
  function localDate(date){
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function minutes(time){
    const [h, m] = String(time || '09:00').split(':').map((part) => Number(part) || 0);
    return h * 60 + m;
  }
  function timeString(total){
    const value = Math.max(0, Math.min(23 * 60 + 59, Number(total) || 0));
    return `${String(Math.floor(value / 60)).padStart(2,'0')}:${String(value % 60).padStart(2,'0')}`;
  }
  function displayTime(time){
    return new Date(`2026-01-01T${time}:00`).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  }
  function sameSlot(a, b){
    return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1000;
  }
  function projectContact(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    return contacts.find((contact) => contact?.primary) || contacts[0] || {};
  }
  function looksLikeEventTypeTitle(value, event = {}){
    const text = clean(value).toLowerCase().replace(/[_-]+/g, ' ');
    if (!text) return false;
    const typeText = clean(event.title || event.mapped_type?.label || event.event_type_id || event.type_id).toLowerCase().replace(/[_-]+/g, ' ');
    return text === 'sales appointment' || (!!typeText && text === typeText);
  }
  function appointmentTitle(project = {}, event = {}){
    const contact = projectContact(project);
    const candidates = [
      project.title,
      project.name,
      contact.name,
      project.customer_name,
      project.customer?.name,
      project.primary_contact_name,
      event.customer_name,
      event.project_title,
      project.address,
      event.project_address,
    ];
    return clean(candidates.find((value) => clean(value) && !looksLikeEventTypeTitle(value, event))) || 'Appointment';
  }
  function eventStart(Scheduling, event){
    return Scheduling?.eventStart?.(event) || new Date(event.start_at || event.start || Date.now());
  }
  function eventEnd(Scheduling, event){
    return Scheduling?.eventEnd?.(event) || new Date(event.end_at || event.end || eventStart(Scheduling, event).getTime() + (Number(event.duration_minutes) || 60) * 60000);
  }
  function eventsForDate(Scheduling, projects, dateValue, userId = null){
    const events = Scheduling?.eventsFromProjects?.(projects) || [];
    return events.filter((event) => {
      if (localDate(eventStart(Scheduling, event)) !== dateValue) return false;
      if (!userId) return true;
      const ids = new Set([...(event.assigned_user_ids || []), ...(event.assigned_users || []).map((user) => user.id)].filter(Boolean));
      return ids.has(userId);
    });
  }
  function eventUserIds(event){
    return [...(event.assigned_user_ids || []), ...(event.assigned_users || []).map((user) => user.id)].filter(Boolean).map(String);
  }
  function unassignedPlacementRow(Scheduling, projects, dateValue){
    const unassignedEvents = eventsForDate(Scheduling, projects, dateValue).filter((event) => !eventUserIds(event).length);
    return {
      id: '',
      name: 'Unassigned',
      unassigned: true,
      laneIndex: 0,
      laneEvents: unassignedEvents,
      placementLane: true,
    };
  }
  function cssEscape(value){
    if (root.CSS?.escape) return root.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function injectCss(){
    const cssText = `
      .psv-wrap{height:100%;display:flex;flex-direction:column;gap:14px;min-height:420px}
      .psv-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .psv-nav{display:flex;align-items:center;gap:8px}
      .psv-nav button{width:36px;height:36px;border-radius:12px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#344054;cursor:pointer;font-weight:1000}
      .psv-range{font-size:14px;font-weight:1000;color:#101828}
      .psv-toolbar-right{display:flex;align-items:center;gap:10px}
      .psv-pill{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(var(--primary-rgb,217,48,37),.2);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));border-radius:999px;padding:8px 11px;font-size:11px;font-weight:1000}
      .psv-travel-toggle,.psv-lock-toggle,.psv-smart-toggle{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:999px;height:34px;padding:0 10px;font-size:11px;font-weight:1000;color:#344054;cursor:pointer}
      .psv-travel-toggle .dot,.psv-lock-toggle .dot,.psv-smart-toggle .dot{width:22px;height:12px;border-radius:999px;background:#cbd5e1;position:relative;transition:.16s ease}
      .psv-travel-toggle .dot:after,.psv-lock-toggle .dot:after,.psv-smart-toggle .dot:after{content:"";position:absolute;width:8px;height:8px;border-radius:999px;left:2px;top:2px;background:#fff;transition:.16s ease}
      .psv-travel-toggle.active,.psv-lock-toggle.active,.psv-smart-toggle.active{border-color:rgba(var(--primary-rgb,217,48,37),.22);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.06)}
      .psv-travel-toggle.active .dot,.psv-lock-toggle.active .dot,.psv-smart-toggle.active .dot{background:var(--primary,#d93025)}
      .psv-travel-toggle.active .dot:after,.psv-lock-toggle.active .dot:after,.psv-smart-toggle.active .dot:after{left:12px}
      .psv-surface{flex:1;min-height:0;display:flex;border:1px solid rgba(15,23,42,.04);border-radius:18px;background:#eef2f6;box-shadow:0 14px 34px rgba(15,23,42,.05);overflow:hidden}
      .psv-left-rail{width:150px;flex:0 0 150px;overflow:hidden;background:#f8fafc;border-right:1px solid rgba(15,23,42,.08)}
      .psv-left-inner{will-change:transform}
      .psv-scroll{flex:1;min-width:0;min-height:0;overflow:auto;background:#eef2f6}
      .psv-scroll.smart-scroll-active{scroll-behavior:auto}
      .psv-grid{display:grid;grid-template-columns:repeat(var(--slot-count,16),minmax(70px,1fr));gap:1px;min-width:900px;min-height:100%;isolation:isolate;align-content:start;position:relative;overflow:visible;background:#eef2f6}
      .psv-person{min-height:var(--psv-row-height,56px);border:0;background:#f8fafc;padding:12px;font-size:12px;font-weight:1000;color:#101828;box-shadow:none;overflow:hidden}
      .psv-person-head{min-height:38px;padding:0}
      .psv-person small{display:block;margin-top:3px;color:#667085;font-size:10px;font-weight:900}
      .psv-person.unassigned,.psv-slot.unassigned{box-shadow:0 6px 0 #eef2f6}
      .psv-hour{min-height:38px;border:0;background:#f8fafc;padding:10px 8px;font-size:11px;font-weight:1000;color:#344054;text-align:center}
      .psv-hour.overflow{background:#eef2f6;color:#98a2b3}
      .psv-slot{--appt-height:46px;--appt-gap:6px;position:relative;min-height:var(--psv-row-height,56px);border:0;background:#fff;cursor:pointer;overflow:visible}
      .psv-slot:hover{background:rgba(var(--primary-rgb,217,48,37),.055)}
      .psv-slot.unavailable{cursor:not-allowed}
      .psv-slot.locked-out{background:#f1f5f9;cursor:not-allowed}
      .psv-slot.locked-out:hover{background:#f1f5f9}
      .psv-slot.locked-out:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(100,116,139,.05) 0,rgba(100,116,139,.05) 6px,rgba(100,116,139,.09) 6px,rgba(100,116,139,.09) 12px);pointer-events:none}
      .psv-slot.unassigned.unavailable,.psv-slot.unassigned.not-placeable{background:#fff!important;cursor:not-allowed}
      .psv-slot.unassigned.unavailable:hover,.psv-slot.unassigned.not-placeable:hover{background:#fff!important}
      .psv-slot.unassigned.overflow,.psv-slot.unassigned.overflow.unavailable,.psv-slot.unassigned.overflow.not-placeable{background:#f1f5f9!important}
      .psv-slot.unassigned.overflow:hover,.psv-slot.unassigned.overflow.unavailable:hover,.psv-slot.unassigned.overflow.not-placeable:hover{background:#f1f5f9!important}
      .psv-slot.unassigned.true-blocked{background:#eef2f6!important}
      .psv-slot.unassigned.true-blocked:hover{background:#eef2f6!important}
      .psv-slot.unassigned.true-blocked:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(71,85,105,.055) 0,rgba(71,85,105,.055) 7px,rgba(71,85,105,.12) 7px,rgba(71,85,105,.12) 14px);pointer-events:none}
      .psv-slot.overflow{background:#f1f5f9;cursor:not-allowed}
      .psv-slot.overflow:hover{background:#f1f5f9}
      .psv-wrap.placement-active .psv-slot:hover{background:#fff}
      .psv-wrap.placement-active .psv-slot.true-blocked:hover{background:#eef2f6!important}
      .psv-wrap.placement-active .psv-slot.overflow:hover{background:#f1f5f9}
      .psv-wrap.placement-active .psv-slot:not(.unavailable):hover:after{content:"";position:absolute;left:5px;top:calc(5px + (var(--slot-stack-count,0) * (var(--appt-height) + var(--appt-gap))));height:var(--appt-height);width:calc((var(--span,1) * 100%) - 10px);border-radius:11px;background:rgba(var(--primary-rgb,217,48,37),.13);border:1px dashed rgba(var(--primary-rgb,217,48,37),.42);z-index:2;pointer-events:none;box-sizing:border-box}
      .psv-wrap.placement-active .psv-slot.has-draft:hover:after{content:none}
      .psv-appt{position:absolute;left:5px;top:calc(5px + (var(--stack-index,0) * (var(--appt-height) + var(--appt-gap))));width:calc((var(--span,1) * 100%) - 10px);height:var(--appt-height);border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.30);border:1px solid rgba(var(--primary-rgb,217,48,37),.42);color:#101828;padding:7px 8px;font-size:10px;font-weight:950;line-height:1.25;overflow:hidden;z-index:20;box-sizing:border-box;box-shadow:0 10px 20px rgba(15,23,42,.14)}
      .psv-appt:not(.draft){cursor:pointer}
      .psv-appt.open{overflow:visible;z-index:50}
      .psv-appt.draft,.psv-appt.moving{border-style:dashed;background:rgba(var(--primary-rgb,217,48,37),.10);border-color:rgba(var(--primary-rgb,217,48,37),.54);box-shadow:none;opacity:.78}
      .psv-appt.draft{pointer-events:none}
      .psv-appt.foreign{background:rgba(100,116,139,.12);border-color:rgba(100,116,139,.18);color:#475467;box-shadow:none}
      .psv-appt.foreign .psv-appt-address{color:#667085}
      .psv-appt.has-confirm{padding-right:38px}
      .psv-draft-confirm{position:absolute;right:7px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:0;border-radius:9px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 18px rgba(var(--primary-rgb,217,48,37),.22)}
      .psv-appt.draft .psv-draft-confirm{pointer-events:auto}
      .psv-draft-confirm:hover{filter:brightness(.96)}
      .psv-appt-title{display:block;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .psv-appt-address{margin-top:3px;color:#475467;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .psv-travel{position:absolute;left:5px;top:5px;width:calc((var(--travel-span,1) * 100%) - 10px);height:calc(100% - 10px);border-radius:10px;background:rgba(100,116,139,.10);border:1px dashed rgba(100,116,139,.18);display:flex;align-items:center;justify-content:center;color:#64748b;font-size:10px;font-weight:1000;z-index:10;pointer-events:none;box-sizing:border-box}
      .psv-travel.no-label{color:transparent}
      .psv-event-menu{position:absolute;left:0;top:calc(100% + 7px);min-width:160px;background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:13px;box-shadow:0 18px 45px rgba(15,23,42,.18);padding:6px;z-index:60;color:#344054}
      .psv-event-action{height:34px;border-radius:9px;display:flex;align-items:center;gap:8px;padding:0 9px;font-size:12px;font-weight:950;cursor:pointer;white-space:nowrap}
      .psv-event-action:hover{background:#f8fafc}
      .psv-event-action.danger{color:#b42318}
      .psv-event-action i{width:14px;text-align:center}
      .psv-empty{border:1px dashed rgba(15,23,42,.18);border-radius:18px;background:#fff;padding:22px;text-align:center;color:#667085;font-weight:850}
      .prs-wrap{height:100%;min-height:420px;display:flex;flex-direction:column;gap:12px;color:#101828}
      .prs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .prs-nav,.prs-view-switch{display:flex;align-items:center;gap:7px}
      .prs-icon-btn{width:34px;height:34px;border-radius:10px;border:1px solid rgba(15,23,42,.10);background:#fff;color:#344054;cursor:pointer;font-weight:1000;display:inline-flex;align-items:center;justify-content:center}
      .prs-icon-btn[data-prs-today]{width:auto;min-width:58px;padding:0 11px}
      .prs-icon-btn:hover,.prs-view-btn:hover{background:#f8fafc;border-color:rgba(15,23,42,.20)}
      .prs-range{font-size:14px;font-weight:1000;color:#101828}
      .prs-view-switch{padding:3px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.10)}
      .prs-view-btn{height:28px;border:0;border-radius:9px;background:transparent;color:#667085;padding:0 9px;font-size:11px;font-weight:1000;cursor:pointer}
      .prs-view-btn.active{background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .prs-surface{position:relative;flex:1;min-height:0;overflow:auto;border:1px solid rgba(15,23,42,.06);border-radius:16px;background:#fff;box-shadow:0 14px 34px rgba(15,23,42,.05);touch-action:none}
      .prs-month{min-width:840px;min-height:100%;display:flex;flex-direction:column}
      .prs-month-head-row{display:grid;grid-template-columns:repeat(7,minmax(108px,1fr));height:34px;flex:0 0 auto}
      .prs-month-head{height:34px;background:#f8fafc;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:center;color:#667085;font-size:11px;font-weight:1000}
      .prs-month-week{position:relative;display:grid;grid-template-columns:repeat(7,minmax(108px,1fr));min-height:146px;flex:1 1 146px}
      .prs-day{position:relative;min-height:104px;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);padding:8px;background:#fff;cursor:crosshair;overflow:hidden}
      .prs-month-week .prs-day{grid-row:1;min-height:146px;padding-top:8px}
      .prs-wrap.readonly .prs-day{cursor:default}
      .prs-day.muted{background:#f8fafc;color:#98a2b3}
      .prs-day.past{background:linear-gradient(135deg,rgba(148,163,184,.10),rgba(248,250,252,.74));color:#64748b}
      .prs-day.past:after,.prs-resource-cell.past:after,.prs-slot.past:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(100,116,139,.055) 0,rgba(100,116,139,.055) 1px,transparent 1px,transparent 9px);pointer-events:none}
      .prs-day.today{background:rgba(var(--primary-rgb,217,48,37),.055);box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.22)}
      .prs-day.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-day.drag-over{box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.32)}
      .prs-day-num{font-size:12px;font-weight:1000;color:#344054;margin-bottom:7px}
      .prs-day.muted .prs-day-num{color:#98a2b3}
      .prs-day.today .prs-day-num{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:0 6px}
      .prs-work-chip{position:relative;width:100%;min-height:30px;border:1px solid rgba(22,163,74,.28);border-left:4px solid #16a34a;border-radius:10px;background:#eaf8ef;color:#14532d;padding:5px 26px;font-size:11px;font-weight:950;line-height:1.2;overflow:hidden;text-align:left;cursor:grab;box-sizing:border-box;box-shadow:0 8px 16px rgba(22,163,74,.10);transition:transform .14s ease,box-shadow .14s ease,opacity .14s ease}
      .prs-month-bar{grid-row:1;z-index:5;align-self:start;margin:34px 4px 0;min-width:0}
      .prs-month-bar .prs-work-chip{height:48px;min-height:48px;border-radius:9px}
      .prs-month-bar.continues-before .prs-work-chip{border-top-left-radius:3px;border-bottom-left-radius:3px;border-left-width:1px}
      .prs-month-bar.continues-after .prs-work-chip{border-top-right-radius:3px;border-bottom-right-radius:3px}
      .prs-month-bar.live-preview{z-index:8;pointer-events:none}
      .prs-work-chip:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(22,163,74,.14)}
      .prs-work-chip.draft{border-style:dashed;background:rgba(var(--primary-rgb,217,48,37),.10);border-color:rgba(var(--primary-rgb,217,48,37),.42);border-left-color:var(--primary,#d93025);color:#101828;opacity:.92}
      .prs-work-chip.draft.suspended{background:rgba(37,99,235,.10);border-color:rgba(37,99,235,.34);border-left-color:#2563eb;color:#1e3a8a;opacity:.82}
      .prs-work-chip.timed-month{background:#e8f1ff;border-color:rgba(37,99,235,.30);border-left-color:#2563eb;color:#1e3a8a}
      .prs-work-chip.timed-month .prs-time{color:#2563eb}
      .prs-work-chip.preview{border-style:dashed;background:rgba(var(--primary-rgb,217,48,37),.13);border-color:rgba(var(--primary-rgb,217,48,37),.50);border-left-color:var(--primary,#d93025);color:#101828;box-shadow:0 10px 22px rgba(var(--primary-rgb,217,48,37),.12);pointer-events:none}
      .prs-work-chip.dragging{opacity:.55;transform:scale(.99)}
      .prs-work-chip.has-confirm{padding-right:54px}
      .prs-work-chip.timed{padding:12px 9px;min-height:30px}
      .prs-work-chip.timed.has-confirm{padding-right:9px;padding-bottom:34px}
      .prs-work-chip.timed.compact-confirm{padding-right:38px;padding-bottom:12px}
      .prs-work-chip .prs-title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-work-chip .prs-time{display:block;color:#475467;font-weight:850;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-handle{position:absolute;top:4px;bottom:4px;width:16px;border:0;background:transparent;color:rgba(20,83,45,.72);cursor:ew-resize;display:flex;align-items:center;justify-content:center}
      .prs-handle.start{left:4px}.prs-handle.end{right:4px}
      .prs-handle:before{content:"";width:3px;height:16px;border-radius:999px;background:currentColor;box-shadow:5px 0 0 currentColor}
      .prs-work-chip.timed .prs-handle{left:6px;right:6px;width:auto;height:10px;bottom:auto;cursor:ns-resize}
      .prs-work-chip.timed .prs-handle.start{top:2px}
      .prs-work-chip.timed .prs-handle.end{top:auto;bottom:2px}
      .prs-work-chip.timed .prs-handle:before{width:24px;height:3px;box-shadow:none}
      .prs-confirm{position:absolute;right:25px;top:50%;transform:translateY(-50%);width:22px;height:22px;border:0;border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px}
      .prs-work-chip.timed .prs-confirm{right:7px;top:auto;bottom:7px;transform:none}
      .prs-crew{display:block;color:#166534;font-size:10px;font-weight:900;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-crew.waiting{color:#92400e;font-style:italic}
      .prs-work-chip.awaiting-crew{background:#fff7ed;border-color:rgba(245,158,11,.36);border-left-color:#f59e0b;color:#78350f}
      .prs-work-chip.awaiting-crew .prs-time{color:#92400e}
      .prs-time-grid{display:grid;grid-template-columns:62px repeat(var(--prs-days,7),minmax(120px,1fr));min-width:920px;min-height:100%;align-content:start}
      .prs-time-head,.prs-day-head{height:40px;background:#f8fafc;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:center;color:#344054;font-size:11px;font-weight:1000;position:sticky;top:0;z-index:4}
      .prs-day-head.past{background:#f1f5f9;color:#94a3b8}
      .prs-day-head.today{background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -2px 0 var(--primary,#d93025)}
      .prs-time-label{height:36px;border-right:1px solid rgba(15,23,42,.08);border-bottom:1px solid rgba(15,23,42,.045);background:#f8fafc;color:#667085;font-size:10px;font-weight:900;display:flex;align-items:flex-start;justify-content:center;padding-top:5px;box-sizing:border-box}
      .prs-slot{position:relative;height:36px;border-right:1px solid rgba(15,23,42,.045);border-bottom:1px solid rgba(15,23,42,.045);background:#fff;cursor:crosshair}
      .prs-slot.past{background:#f8fafc;color:#94a3b8}
      .prs-slot.today{background:rgba(var(--primary-rgb,217,48,37),.035)}
      .prs-wrap.readonly .prs-slot{cursor:default}
      .prs-slot.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-slot.drag-over{box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.32)}
      .prs-slot .prs-work-chip{position:absolute;left:5px;right:5px;top:4px;width:auto;z-index:3}
      .prs-resource-scroll{flex:1;min-height:0;overflow:auto;border:1px solid rgba(15,23,42,.06);border-radius:16px;background:#fff;box-shadow:0 14px 34px rgba(15,23,42,.05);touch-action:none}
      .prs-resource-grid{display:grid;grid-template-columns:150px repeat(var(--prs-days,56),minmax(86px,1fr));grid-template-rows:40px repeat(var(--prs-resources,1),72px);min-width:calc(150px + var(--prs-days,56) * 86px);position:relative;isolation:isolate}
      .prs-resource-corner,.prs-resource-day-head,.prs-resource-label,.prs-resource-cell{border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
      .prs-resource-corner,.prs-resource-day-head{position:sticky;top:0;z-index:7;background:#f8fafc}
      .prs-resource-corner{left:0;z-index:8}
      .prs-resource-day-head{height:40px;display:flex;align-items:center;justify-content:center;flex-direction:column;font-size:10px;font-weight:1000;color:#475467}
      .prs-resource-day-head.weekend,.prs-resource-cell.weekend{background:#f4f6f8}
      .prs-resource-day-head.past{background:#f1f5f9;color:#94a3b8}
      .prs-resource-day-head.today{background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -2px 0 var(--primary,#d93025)}
      .prs-resource-day-head.today span:last-child:after{content:"Today";display:inline-flex;margin-left:5px;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:1px 5px;font-size:8px;font-weight:1000;vertical-align:middle}
      .prs-resource-label{position:sticky;left:0;z-index:6;background:#fff;padding:12px;display:flex;flex-direction:column;justify-content:center;font-size:12px;font-weight:1000;color:#101828}
      .prs-resource-label small{font-size:10px;font-weight:850;color:#667085;margin-top:3px}
      .prs-resource-label.unassigned{background:#f8fafc;color:#475467}
      .prs-resource-cell{background:#fff;cursor:crosshair}
      .prs-resource-cell{position:relative}
      .prs-resource-cell.past{background:#f8fafc}
      .prs-resource-cell.today{background:rgba(var(--primary-rgb,217,48,37),.035)}
      .prs-resource-cell.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-resource-cell.weekend.in-range{background:rgba(var(--primary-rgb,217,48,37),.09)}
      .prs-resource-bar{z-index:4;align-self:start;margin:34px 4px 0;min-width:0}
      .prs-resource-bar .prs-work-chip{height:30px;min-height:30px;border-radius:9px}
      .prs-resource-bar.live-preview{z-index:9;pointer-events:none}
      .prs-resource-time-grid{display:grid;grid-template-columns:150px repeat(var(--prs-slots,24),minmax(70px,1fr));grid-template-rows:40px repeat(var(--prs-resources,1),72px);min-width:calc(150px + var(--prs-slots,24) * 70px);position:relative;isolation:isolate}
      .prs-resource-time-head,.prs-resource-time-cell{border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
      .prs-resource-time-head{position:sticky;top:0;z-index:7;background:#f8fafc;display:flex;align-items:center;justify-content:center;color:#667085;font-size:10px;font-weight:1000}
      .prs-resource-time-cell{position:relative;background:#fff;cursor:crosshair}
      .prs-resource-time-grid.today .prs-resource-time-head{background:rgba(var(--primary-rgb,217,48,37),.085);color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -2px 0 var(--primary,#d93025)}
      .prs-resource-time-grid.past .prs-resource-time-head{background:#f1f5f9;color:#94a3b8}
      .prs-resource-time-grid.past .prs-resource-time-cell{background:#f8fafc}
      .prs-resource-time-grid.past .prs-resource-time-cell:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(100,116,139,.055) 0,rgba(100,116,139,.055) 1px,transparent 1px,transparent 9px);pointer-events:none}
      .prs-resource-time-grid.today .prs-resource-time-cell{background:rgba(var(--primary-rgb,217,48,37),.025)}
      .prs-resource-time-cell.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-resource-all-day-bar{z-index:3;align-self:start;margin:5px 5px 0;min-width:0;height:24px;border:1px solid rgba(71,85,105,.20);border-left:4px solid #64748b;border-radius:8px;background:#f1f5f9;color:#334155;box-sizing:border-box;box-shadow:0 6px 14px rgba(15,23,42,.06);pointer-events:none;overflow:hidden}
      .prs-resource-all-day-label{z-index:6;align-self:start;position:sticky;left:150px;margin:6px 0 0 8px;width:max-content;max-width:min(420px,calc(100vw - 270px));height:22px;pointer-events:none;color:#334155}
      .prs-all-day-chip{width:max-content;max-width:100%;height:22px;display:flex;align-items:center;gap:8px;min-width:0;padding:0 6px 0 10px;box-sizing:border-box;font-size:11px;font-weight:950}
      .prs-all-day-chip strong{flex:0 0 auto;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
      .prs-all-day-chip span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-resource-time-bar{z-index:4;align-self:start;margin:34px 4px 0;min-width:0}
      .prs-resource-time-bar .prs-work-chip{height:30px;min-height:30px;border-radius:9px}
      .prs-resource-time-bar.live-preview{z-index:9;pointer-events:none}
      .prs-empty{border:1px dashed rgba(15,23,42,.18);border-radius:16px;background:#fff;padding:22px;text-align:center;color:#667085;font-weight:850}
    `;
    const existing = document.getElementById(STYLE_ID);
    if (existing) {
      existing.textContent = cssText;
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  function apptHtml({ event, project, Scheduling, slotMinutes, draft = false, moving = false, selected = false, confirmable = false, menuHtml = '', stackIndex = 0, foreign = false }){
    const start = eventStart(Scheduling, event);
    const title = appointmentTitle(project, event);
    const address = event.project_address || project?.address || '';
    const span = Math.max(1, Math.ceil((Number(event.duration_minutes) || 60) / Math.max(1, Number(slotMinutes) || 30)));
    return `<div class="psv-appt ${draft ? 'draft' : ''} ${moving ? 'moving' : ''} ${selected ? 'open' : ''} ${confirmable ? 'has-confirm' : ''} ${foreign ? 'foreign' : ''}" style="--span:${span};--stack-index:${Math.max(0, Number(stackIndex) || 0)}" data-psv-event-id="${esc(event.id || '')}" data-psv-project-id="${esc(event.project_id || project?.id || '')}"><span class="psv-appt-title">${esc(title)}</span><div class="psv-appt-address">${esc(address)}</div>${confirmable ? `<button type="button" class="psv-draft-confirm" data-psv-draft-confirm aria-label="Confirm appointment"><i class="fas fa-check"></i></button>` : ''}${selected ? menuHtml : ''}</div>`;
  }

  function draftHtml({ draft, placementProject, Scheduling, slotMinutes, duration, confirmable = false, stackIndex = 0 }){
    if (!draft?.start) return '';
    return apptHtml({
      event: {
        start_at: new Date(draft.start).toISOString(),
        duration_minutes: duration,
        customer_name: placementProject?.customer_name,
        project_title: placementProject?.title,
        project_address: placementProject?.address,
      },
      project: placementProject,
      Scheduling,
      slotMinutes,
      draft: true,
      confirmable,
      stackIndex,
    });
  }

  function roundedTravelSpanMinutes(rawMinutes, slotMinutes){
    const slot = Math.max(1, Number(slotMinutes) || 30);
    return Math.max(slot, Math.ceil(Math.max(0, Number(rawMinutes) || 0) / slot) * slot);
  }

  function travelHtml({ enabled, events, start, bufferMinutes, slotMinutes, currentAddress, Scheduling }){
    if (!enabled || !events?.length || !currentAddress || !bufferMinutes) return '';
    const slotStart = start.getTime();
    const slotEnd = slotStart + (Number(slotMinutes) || 30) * 60000;
    for (const event of events) {
      const evStart = eventStart(Scheduling, event).getTime();
      const evEnd = eventEnd(Scheduling, event).getTime();
      const before = slotEnd <= evStart && slotStart >= evStart - bufferMinutes * 60000;
      const after = slotStart >= evEnd && slotEnd <= evEnd + bufferMinutes * 60000;
      const otherAddress = event.project_address || '';
      if ((before || after) && otherAddress) {
        const slotMs = (Number(slotMinutes) || 30) * 60000;
        const origin = before ? currentAddress : otherAddress;
        const destination = before ? otherAddress : currentAddress;
        const key = travelKey(origin, destination);
        const cached = travelCache.get(key);
        const spanMinutes = roundedTravelSpanMinutes(cached || bufferMinutes, slotMinutes);
        const spanSlots = Math.max(1, Math.ceil(spanMinutes / Math.max(1, Number(slotMinutes) || 30)));
        const blockStart = after ? evEnd : evStart - spanMinutes * 60000;
        if (slotStart < blockStart || slotStart >= blockStart + slotMs) return '';
        return `<div class="psv-travel" style="--travel-span:${spanSlots}" data-slot-minutes="${esc(slotMinutes)}" data-travel-key="${esc(key)}" data-origin="${esc(origin)}" data-destination="${esc(destination)}"><i class="far fa-clock"></i>&nbsp;${esc(cached ? cached : '...')}</div>`;
      }
    }
    return '';
  }

  function rowBlockers({ events, slotMinutes, duration, currentAddress, Scheduling, liveTravel, bufferMinutes = 0 }){
    const slot = Math.max(1, Number(slotMinutes) || 30);
    const blockers = [];
    const sorted = (events || []).slice().sort((a, b) => eventStart(Scheduling, a) - eventStart(Scheduling, b));
    sorted.forEach((event, index) => {
      const prev = sorted[index - 1] || null;
      const start = eventStart(Scheduling, event);
      const end = eventEnd(Scheduling, event);
      const next = sorted[index + 1] || null;
      const prevEnd = prev ? eventEnd(Scheduling, prev) : null;
      const nextStart = next ? eventStart(Scheduling, next) : null;
      let afterEnd = null;
      if (currentAddress && event.project_address) {
        const afterKey = travelKey(event.project_address, currentAddress);
        const rawAfter = liveTravel ? travelCache.get(afterKey) : 0;
        const afterMinutes = roundedTravelSpanMinutes(rawAfter || bufferMinutes, slot);
        afterEnd = new Date(end.getTime() + afterMinutes * 60000);
        if (afterMinutes && (!nextStart || afterEnd.getTime() <= nextStart.getTime())) {
          blockers.push({ start: end, end: afterEnd, label: liveTravel && rawAfter ? `${rawAfter}` : '', key: liveTravel ? afterKey : '', origin: event.project_address, destination: currentAddress });
        }
        const beforeKey = travelKey(currentAddress, event.project_address);
        const rawBefore = liveTravel ? travelCache.get(beforeKey) : 0;
        const beforeMinutes = roundedTravelSpanMinutes(rawBefore || bufferMinutes, slot);
        const beforeStart = new Date(start.getTime() - beforeMinutes * 60000);
        if (beforeMinutes && (!prevEnd || beforeStart.getTime() >= prevEnd.getTime())) {
          blockers.push({ start: beforeStart, end: start, label: liveTravel && rawBefore ? `${rawBefore}` : '', key: liveTravel ? beforeKey : '', origin: currentAddress, destination: event.project_address });
        }
      }
      if (next) {
        const gapStart = end;
        const gapEnd = nextStart;
        const gapMs = gapEnd.getTime() - gapStart.getTime();
        const travelOverlapsNext = afterEnd && afterEnd.getTime() > gapEnd.getTime();
        if (gapMs > 0 && (gapMs < (Number(duration) || 60) * 60000 || travelOverlapsNext)) {
          blockers.push({ start: gapStart, end: gapEnd, label: '' });
        }
      }
    });
    return blockers;
  }

  function blockerAtSlot(blockers, start, slotMinutes){
    const slotMs = Math.max(1, Number(slotMinutes) || 30) * 60000;
    const slotStart = start.getTime();
    return (blockers || []).find((blocker) => {
      const blockStart = blocker.start.getTime();
      return slotStart >= blockStart && slotStart < blockStart + slotMs;
    }) || null;
  }

  function proposedOverlaps(start, duration, intervals){
    const s = start.getTime();
    const e = s + (Number(duration) || 60) * 60000;
    return (intervals || []).some((item) => s < item.end.getTime() && item.start.getTime() < e);
  }

  function overlapStackIndex({ events = [], Scheduling, start, duration, excludeEventId = '' } = {}){
    const s = new Date(start).getTime();
    const e = s + (Number(duration) || 60) * 60000;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 0;
    return (events || []).filter((event) => {
      if (excludeEventId && clean(event?.id || '') === clean(excludeEventId)) return false;
      const eventS = eventStart(Scheduling, event).getTime();
      const eventE = eventEnd(Scheduling, event).getTime();
      return Number.isFinite(eventS) && Number.isFinite(eventE) && s < eventE && eventS < e;
    }).length;
  }

  function maxConcurrentStack(events = [], Scheduling){
    if (!events.length) return 1;
    return Math.max(1, ...events.map((event) => overlapStackIndex({
      events,
      Scheduling,
      start: eventStart(Scheduling, event),
      duration: Math.max(15, (eventEnd(Scheduling, event) - eventStart(Scheduling, event)) / 60000),
      excludeEventId: event.id || ''
    }) + 1));
  }

  function blockerHtml(blocker, slotMinutes){
    if (!blocker) return '';
    const spanMinutes = Math.max(Number(slotMinutes) || 30, Math.ceil((blocker.end - blocker.start) / 60000));
    const spanSlots = Math.max(1, Math.ceil(spanMinutes / Math.max(1, Number(slotMinutes) || 30)));
    const label = blocker.label || '';
    return `<div class="psv-travel ${label ? '' : 'no-label'}" style="--travel-span:${spanSlots}" data-slot-minutes="${esc(slotMinutes)}" ${blocker.key ? `data-travel-key="${esc(blocker.key)}" data-origin="${esc(blocker.origin)}" data-destination="${esc(blocker.destination)}"` : ''}>${label ? `<i class="far fa-clock"></i>&nbsp;${esc(label)}` : ''}</div>`;
  }

  function installPointerSmartScroll({
    scroller,
    content = null,
    itemSelector = '',
    axis = 'x',
    deadZoneItems = 1,
    smoothing = 0.24,
    enabled = true
  } = {}){
    if (!scroller || !enabled) return () => {};
    const horizontal = axis !== 'y';
    const scrollProp = horizontal ? 'scrollLeft' : 'scrollTop';
    const sizeProp = horizontal ? 'clientWidth' : 'clientHeight';
    const scrollSizeProp = horizontal ? 'scrollWidth' : 'scrollHeight';
    const startProp = horizontal ? 'left' : 'top';
    const lengthProp = horizontal ? 'width' : 'height';
    const pointerCoord = horizontal ? 'clientX' : 'clientY';
    let target = scroller[scrollProp] || 0;
    let frame = 0;
    let active = false;
    let stopWhenSettled = false;

    const maxScroll = () => Math.max(0, Number(scroller[scrollSizeProp] || 0) - Number(scroller[sizeProp] || 0));
    const firstItemSize = () => {
      const rootEl = content || scroller;
      const item = itemSelector ? rootEl.querySelector?.(itemSelector) : null;
      const rect = item?.getBoundingClientRect?.();
      const size = Number(rect?.[lengthProp] || 0);
      return size > 0 ? size : Math.max(0, Number(scroller[sizeProp] || 0) * 0.12);
    };
    const stop = () => {
      active = false;
      stopWhenSettled = false;
      scroller.classList.remove('smart-scroll-active');
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const tick = () => {
      frame = 0;
      if (!active) return;
      const max = maxScroll();
      if (max <= 0) {
        stop();
        return;
      }
      const current = Number(scroller[scrollProp] || 0);
      const next = current + ((target - current) * smoothing);
      const settled = Math.abs(target - next) < 0.5;
      scroller[scrollProp] = settled ? target : next;
      if (settled && stopWhenSettled) {
        stop();
        return;
      }
      if (Math.abs(target - scroller[scrollProp]) >= 0.5) frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const updateTarget = (event) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      const max = maxScroll();
      if (max <= 0) {
        stop();
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const dead = Math.min(firstItemSize() * Math.max(0, Number(deadZoneItems) || 0), Math.max(0, rect[lengthProp] / 2));
      const start = rect[startProp] + dead;
      const end = rect[startProp] + rect[lengthProp] - dead;
      const travel = Math.max(1, end - start);
      const raw = Number(event[pointerCoord] || 0);
      const ratio = raw <= start ? 0 : (raw >= end ? 1 : (raw - start) / travel);
      target = ratio * max;
      active = true;
      stopWhenSettled = false;
      scroller.classList.add('smart-scroll-active');
      schedule();
    };
    const glideToExitEdge = (event) => {
      if (event.pointerType && event.pointerType !== 'mouse') {
        stop();
        return;
      }
      const max = maxScroll();
      if (max <= 0) {
        stop();
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const raw = Number(event[pointerCoord] || 0);
      if (raw <= rect[startProp]) target = 0;
      else if (raw >= rect[startProp] + rect[lengthProp]) target = max;
      else {
        stop();
        return;
      }
      active = true;
      stopWhenSettled = true;
      scroller.classList.add('smart-scroll-active');
      schedule();
    };

    scroller.addEventListener('pointerenter', updateTarget, { passive: true });
    scroller.addEventListener('pointermove', updateTarget, { passive: true });
    scroller.addEventListener('pointerleave', glideToExitEdge, { passive: true });
    scroller.addEventListener('pointercancel', stop, { passive: true });
    return () => {
      stop();
      scroller.removeEventListener('pointerenter', updateTarget);
      scroller.removeEventListener('pointermove', updateTarget);
      scroller.removeEventListener('pointerleave', glideToExitEdge);
      scroller.removeEventListener('pointercancel', stop);
    };
  }

  function installWheelHorizontalScroll({ scroller, enabled = true, speed = 1 } = {}){
    if (!scroller || !enabled) return () => {};
    const onWheel = (event) => {
      const max = Math.max(0, Number(scroller.scrollWidth || 0) - Number(scroller.clientWidth || 0));
      if (max <= 0) return;
      const delta = Math.abs(Number(event.deltaX || 0)) > Math.abs(Number(event.deltaY || 0))
        ? Number(event.deltaX || 0)
        : Number(event.deltaY || 0);
      if (!delta) return;
      event.preventDefault();
      scroller.scrollLeft = Math.max(0, Math.min(max, Number(scroller.scrollLeft || 0) + (delta * Number(speed || 1))));
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }

  function hydrateTravelLabels(container, enabled){
    if (!enabled || !root.google?.maps?.DistanceMatrixService || !container) return;
    const state = container.__psvOptions || {};
    const nodes = Array.from(container.querySelectorAll('.psv-travel[data-travel-key]'));
    const pending = nodes.filter((node) => !travelCache.has(node.dataset.travelKey));
    const service = new root.google.maps.DistanceMatrixService();
    pending.slice(0, 16).forEach((node) => {
      const key = node.dataset.travelKey;
      service.getDistanceMatrix({
        origins: [node.dataset.origin],
        destinations: [node.dataset.destination],
        travelMode: root.google.maps.TravelMode.DRIVING,
      }, (response, status) => {
        const seconds = response?.rows?.[0]?.elements?.[0]?.duration?.value;
        if (status === 'OK' && Number.isFinite(seconds)) {
          travelCache.set(key, Math.max(1, Math.ceil(seconds / 60)));
          state?.onTravelTimeResolved?.({
            key,
            origin: node.dataset.origin || '',
            destination: node.dataset.destination || '',
            minutes: travelCache.get(key),
          });
          rerenderWithScroll(container);
        }
      });
    });
  }

  function rerenderWithScroll(container){
    const state = container?.__psvOptions;
    if (!container || !state) return;
    if (container.__psvRerenderQueued) return;
    container.__psvRerenderQueued = true;
    requestAnimationFrame(() => {
      const scroll = container.querySelector('.psv-scroll');
      const left = scroll?.scrollLeft || 0;
      const top = scroll?.scrollTop || 0;
      container.__psvRerenderQueued = false;
      renderDailyTeam(container, state);
      const next = container.querySelector('.psv-scroll');
      if (next) {
        next.scrollLeft = left;
        next.scrollTop = top;
      }
    });
  }

  function renderDailyTeam(container, options = {}){
    injectCss();
    if (container.__psvOutsideHandler) {
      document.removeEventListener('click', container.__psvOutsideHandler);
      container.__psvOutsideHandler = null;
    }
    if (container.__psvSmartScrollCleanup) {
      container.__psvSmartScrollCleanup();
      container.__psvSmartScrollCleanup = null;
    }
    if (container.__psvWheelHorizontalCleanup) {
      container.__psvWheelHorizontalCleanup();
      container.__psvWheelHorizontalCleanup = null;
    }
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    if (!container || !Scheduling) return;
    const config = options.config || {};
    seedTravelCache(options.travelTimeCache || options.travelTimes || {});
    const eventTypeId = options.eventTypeId || 'sales_appointment';
    const eventType = options.eventType || config.event_types?.[eventTypeId] || {};
    const roleIds = [...new Set([...(eventType.required_role_ids || []), ...(eventType.allowed_role_ids || []), ...(eventType.role_ids || []), 'sales_appointments'])];
    const users = (options.users || []).filter((user) => roleIds.some((roleId) => Scheduling.userHasRole(user, roleId)) && user.status !== 'disabled');
    const projects = options.projects || [];
    const date = new Date(options.date || Date.now());
    date.setHours(0,0,0,0);
    const dateValue = localDate(date);
    const duration = Number(eventType.duration_minutes || options.durationMinutes || 60);
    const slotMinutes = Number(eventType.slot_minutes || config?.availability?.sales_appointment_slot_minutes || options.slotMinutes || 30);
    const bufferMinutes = Number(eventType.buffer_minutes || config?.availability?.sales_appointment_buffer_minutes || options.bufferMinutes || 30);
    const span = Math.max(1, Math.ceil(duration / Math.max(1, slotMinutes)));
    const windowForDay = typeof options.windowForDate === 'function'
      ? options.windowForDate(dateValue)
      : { start: options.workdayStart || '08:00', end: options.workdayEnd || '18:00' };
    const times = [];
    const startMinute = minutes(windowForDay.start || '08:00');
    const endMinute = minutes(windowForDay.end || '18:00');
    const dayDisabled = !!windowForDay.disabled || endMinute <= startMinute;
    const placementActive = !!options.placementProject;
    if (!dayDisabled) {
      for (let m = startMinute; m < endMinute; m += slotMinutes) times.push({ time: timeString(m), overflow: false });
      for (let i = 0; i < Math.max(0, span - 1); i += 1) times.push({ time: timeString(endMinute + i * slotMinutes), overflow: true });
    }
    const apptHeight = 46;
    const apptGap = 6;
    const rowHeightForStack = (count) => 10 + (Math.max(1, count) * apptHeight) + (Math.max(0, count - 1) * apptGap);
    const eventSlotKey = (event) => timeString(minutes(eventStart(Scheduling, event).toTimeString().slice(0,5)));
    const unassignedVisualCache = new Map();
    const canUnassignedAppointmentCoverSlot = (slotStart, lockedStart = null, lockActive = false) => {
      const slotMs = Math.max(1, slotMinutes) * 60000;
      const slotEnd = new Date(slotStart.getTime() + slotMs);
      const key = `${slotStart.toISOString()}::${lockActive ? lockedStart?.toISOString?.() || '' : 'free'}`;
      if (unassignedVisualCache.has(key)) return unassignedVisualCache.get(key);
      const result = times.some((candidateSlot) => {
        if (candidateSlot.overflow) return false;
        const candidateStart = new Date(`${dateValue}T${candidateSlot.time}:00`);
        const candidateEnd = new Date(candidateStart.getTime() + duration * 60000);
        if (candidateStart.getTime() >= slotEnd.getTime() || candidateEnd.getTime() <= slotStart.getTime()) return false;
        if (lockActive && !sameSlot(candidateStart, lockedStart)) return false;
        return Scheduling.availabilityForEventType({
          users,
          projects,
          eventType,
          eventTypeId,
          start: candidateStart,
          durationMinutes: duration,
          excludeEventId: options.assignmentEventId || ''
        }).hasAvailability;
      });
      unassignedVisualCache.set(key, result);
      return result;
    };
    const unassignedRows = options.includeUnassigned === false ? [] : [unassignedPlacementRow(Scheduling, projects, dateValue)];
    const rows = [...unassignedRows, ...users];
    if (!users.length) {
      container.innerHTML = `<div class="psv-empty"><i class="fas fa-user-slash"></i> No sales appointment users are available.</div>`;
      return;
    }
    container.__psvOptions = { ...options, Scheduling, config, users, projects, eventType, eventTypeId, duration, slotMinutes };
    const toolbarHtml = `
      <div class="psv-toolbar">
        <div class="psv-nav">
          <button type="button" data-psv-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" data-psv-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="psv-range">${esc(date.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }))}</div>
        </div>
        <div class="psv-toolbar-right">
          ${typeof options.onLockTimeToggle === 'function' ? `<button type="button" class="psv-lock-toggle ${options.lockTime ? 'active' : ''}" data-psv-lock><span class="dot"></span> Lock appointment time</button>` : ''}
          ${typeof options.onSmartScrollToggle === 'function' ? `<button type="button" class="psv-smart-toggle ${options.smartScroll !== false ? 'active' : ''}" data-psv-smart-scroll><span class="dot"></span> Smart scroll</button>` : ''}
          <button type="button" class="psv-travel-toggle ${options.liveTravel ? 'active' : ''}" data-psv-live><span class="dot"></span> Live travel time</button>
          <span class="psv-pill"><i class="fas fa-table-cells"></i>${esc(options.modeLabel || 'Daily team view')}</span>
        </div>
      </div>
    `;
    if (dayDisabled) {
      container.innerHTML = `<div class="psv-wrap">${toolbarHtml}<div class="psv-empty"><i class="fas fa-calendar-xmark"></i> ${esc(windowForDay.message || 'No slots available for this day.')}</div></div>`;
      container.querySelectorAll('[data-psv-nav]').forEach((btn) => btn.addEventListener('click', () => options.onNavigate?.(Number(btn.dataset.psvNav || 0))));
      container.querySelector('[data-psv-lock]')?.addEventListener('click', () => options.onLockTimeToggle?.(!options.lockTime));
      container.querySelector('[data-psv-smart-scroll]')?.addEventListener('click', () => options.onSmartScrollToggle?.(options.smartScroll === false));
      container.querySelector('[data-psv-live]')?.addEventListener('click', () => options.onLiveTravelToggle?.(!options.liveTravel));
      return;
    }
    const rowViews = rows.map((user) => {
      const rowEvents = user.unassigned ? (user.laneEvents || []) : eventsForDate(Scheduling, projects, dateValue, user.id);
      const maxStack = maxConcurrentStack(rowEvents, Scheduling);
      const rowDraft = placementActive && options.draft?.start && (
        (user.unassigned && !options.draft.user?.id) ||
        (!user.unassigned && clean(options.draft.user?.id || '') === clean(user.id || ''))
      );
      const rowDraftStack = rowDraft
        ? overlapStackIndex({ events: rowEvents, Scheduling, start: options.draft.start, duration, excludeEventId: options.assignmentEventId || '' }) + 1
        : 0;
      const unassignedPlacementCapacity = placementActive && user.unassigned && rowEvents.length && maxStack < users.length
        ? maxStack + 1
        : maxStack;
      const rowStackCapacity = Math.max(unassignedPlacementCapacity, rowDraftStack);
      const rowHeight = rowHeightForStack(rowStackCapacity);
      const personHtml = `<div class="psv-person ${user.unassigned ? 'unassigned' : ''}" style="--psv-row-height:${rowHeight}px">${esc(user.name || user.email || '')}<small>${user.unassigned ? 'Unassigned placement' : 'Assigned directly'}</small></div>`;
      const slotsHtml = times.map((timeSlot) => {
              const { time } = timeSlot;
              const start = new Date(`${dateValue}T${time}:00`);
              const assignmentEventId = clean(options.assignmentEventId || '');
              const blockingRowEvents = assignmentEventId
                ? rowEvents.filter((event) => clean(event.id || '') !== assignmentEventId)
                : rowEvents;
              const blockers = !placementActive || user.unassigned ? [] : rowBlockers({ events: blockingRowEvents, slotMinutes, duration, currentAddress: options.placementProject?.address || '', Scheduling, liveTravel: options.liveTravel, bufferMinutes });
              const intervals = [
                ...blockingRowEvents.map((event) => ({ start: eventStart(Scheduling, event), end: eventEnd(Scheduling, event) })),
                ...blockers,
              ];
              const lockedStart = options.lockPlacementStart ? new Date(options.lockPlacementStart) : null;
              const lockedEnd = options.lockPlacementEnd ? new Date(options.lockPlacementEnd) : null;
              const lockActive = lockedStart && Number.isFinite(lockedStart.getTime());
              const lockEndValue = lockedEnd && Number.isFinite(lockedEnd.getTime())
                ? lockedEnd
                : (lockActive ? new Date(lockedStart.getTime() + duration * 60000) : null);
              const slotEnd = new Date(start.getTime() + slotMinutes * 60000);
              const overlapsLockedWindow = !lockActive || (slotEnd.getTime() > lockedStart.getTime() && start.getTime() < lockEndValue.getTime());
              const matchesLockedStart = !lockActive || sameSlot(start, lockedStart);
              const available = !placementActive ? !timeSlot.overflow : (!timeSlot.overflow && overlapsLockedWindow && matchesLockedStart && !(lockActive && user.unassigned) && (user.unassigned
                ? Scheduling.availabilityForEventType({ users, projects, eventType, eventTypeId, start, durationMinutes: duration, excludeEventId: options.assignmentEventId || '' }).hasAvailability
                : !proposedOverlaps(start, duration, intervals)));
              const slotEvents = user.unassigned ? [] : rowEvents.filter((event) => eventSlotKey(event) === time);
              const unassignedDraftMatch = user.unassigned && options.draft?.start && !options.draft.user?.id && sameSlot(options.draft.start, start);
              const assignedDraftMatch = !user.unassigned && options.draft && sameSlot(options.draft.start, start) && clean(options.draft.user?.id || '') === clean(user.id || '');
              const draft = (unassignedDraftMatch || assignedDraftMatch)
                ? { start_at: start.toISOString(), duration_minutes: duration, customer_name: options.placementProject?.customer_name, project_title: options.placementProject?.title, project_address: options.placementProject?.address }
                : null;
              const disabled = options.readOnly || (placementActive && !available);
              const blocker = user.unassigned ? null : blockerAtSlot(blockers, start, slotMinutes);
              const travel = blockerHtml(blocker, slotMinutes);
              const unassignedSlotEvents = user.unassigned ? rowEvents.filter((event) => eventSlotKey(event) === time) : [];
              const visibleSlotEvents = [...slotEvents, ...unassignedSlotEvents];
              const candidateStackIndex = placementActive && user.unassigned
                ? overlapStackIndex({ events: rowEvents, Scheduling, start, duration, excludeEventId: options.assignmentEventId || '' })
                : visibleSlotEvents.length;
              const draftStackIndex = draft ? candidateStackIndex : visibleSlotEvents.length;
              const hoverStackCount = draft ? draftStackIndex : candidateStackIndex;
              const unassignedTrueBlocked = placementActive
                && user.unassigned
                && !timeSlot.overflow
                && !canUnassignedAppointmentCoverSlot(start, lockedStart, lockActive);
              const showUnavailable = placementActive && !available;
              return `<button type="button" class="psv-slot ${user.unassigned ? 'unassigned' : ''} ${timeSlot.overflow ? 'overflow' : ''} ${lockActive && placementActive && !overlapsLockedWindow ? 'locked-out' : ''} ${showUnavailable ? 'unavailable' : ''} ${showUnavailable ? 'not-placeable' : ''} ${unassignedTrueBlocked ? 'true-blocked' : ''} ${draft ? 'has-draft' : ''}" style="--span:${span};--slot-stack-count:${hoverStackCount};--psv-row-height:${rowHeight}px" data-psv-start="${esc(start.toISOString())}" data-psv-user="${esc(user.id || '')}" data-psv-lane="${esc(user.laneIndex ?? '')}" ${disabled ? 'aria-disabled="true"' : ''}>${travel}${visibleSlotEvents.map((event, stackIndex) => {
                const project = projects.find((p) => p.id === event.project_id);
                const selected = !!options.selectedEventId && String(options.selectedEventId) === String(event.id || '');
                const moving = !!options.assignmentEventId && String(options.assignmentEventId) === String(event.id || '');
                const menuHtml = selected && typeof options.eventMenuHtml === 'function' ? options.eventMenuHtml({ event, project }) : '';
                const foreign = !!options.focusProjectId && String(event.project_id || '') !== String(options.focusProjectId);
                return apptHtml({ event, project, Scheduling, slotMinutes, selected, moving, menuHtml, stackIndex, foreign });
              }).join('')}${draft ? apptHtml({ event: draft, project: options.placementProject, Scheduling, slotMinutes, draft: true, confirmable: typeof options.onDraftConfirm === 'function', stackIndex: draftStackIndex }) : ''}</button>`;
            }).join('');
      return { personHtml, slotsHtml };
    });
    container.innerHTML = `
      <div class="psv-wrap ${placementActive ? 'placement-active' : ''}">
        ${toolbarHtml}
        <div class="psv-surface">
          <div class="psv-left-rail"><div class="psv-left-inner">
            <div class="psv-person psv-person-head"></div>
            ${rowViews.map((row) => row.personHtml).join('')}
          </div></div>
          <div class="psv-scroll"><div class="psv-grid" style="--slot-count:${times.length}">
            ${times.map((slot) => `<div class="psv-hour ${slot.overflow ? 'overflow' : ''}">${esc(displayTime(slot.time))}</div>`).join('')}
            ${rowViews.map((row) => row.slotsHtml).join('')}
          </div></div>
        </div>
      </div>
    `;
    const rightScroller = container.querySelector('.psv-scroll');
    const grid = container.querySelector('.psv-grid');
    const leftInner = container.querySelector('.psv-left-inner');
    const syncLeftRail = () => {
      if (leftInner && rightScroller) leftInner.style.transform = `translateY(${-rightScroller.scrollTop}px)`;
    };
    rightScroller?.addEventListener('scroll', syncLeftRail, { passive: true });
    syncLeftRail();
    container.__psvSmartScrollCleanup = installPointerSmartScroll({
      scroller: rightScroller,
      content: grid,
      itemSelector: '.psv-hour',
      axis: 'x',
      deadZoneItems: options.smartScrollDeadZoneItems ?? 1,
      smoothing: options.smartScrollSmoothing ?? 0.24,
      enabled: options.smartScroll !== false
    });
    container.__psvWheelHorizontalCleanup = installWheelHorizontalScroll({
      scroller: rightScroller,
      enabled: placementActive && options.smartScroll === false
    });
    container.querySelectorAll('[data-psv-nav]').forEach((btn) => btn.addEventListener('click', () => options.onNavigate?.(Number(btn.dataset.psvNav || 0))));
    container.querySelector('[data-psv-lock]')?.addEventListener('click', () => options.onLockTimeToggle?.(!options.lockTime));
    container.querySelector('[data-psv-smart-scroll]')?.addEventListener('click', () => options.onSmartScrollToggle?.(options.smartScroll === false));
    container.querySelector('[data-psv-live]')?.addEventListener('click', () => options.onLiveTravelToggle?.(!options.liveTravel));
    container.querySelectorAll('.psv-appt[data-psv-event-id]').forEach((node) => node.addEventListener('click', (event) => {
      if (node.classList.contains('draft')) return;
      event.preventDefault();
      event.stopPropagation();
      const item = eventsForDate(Scheduling, projects, dateValue).find((entry) => String(entry.id || '') === String(node.dataset.psvEventId || ''));
      const project = projects.find((entry) => String(entry.id || '') === String(node.dataset.psvProjectId || '')) || null;
      const allowedIds = new Set((options.interactiveEventIds || []).map((id) => String(id)));
      if (allowedIds.size && !allowedIds.has(String(item?.id || ''))) return;
      options.onEventClick?.({ event: item, project, element: node });
    }));
    container.querySelectorAll('[data-psv-event-action]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const appt = node.closest('.psv-appt');
      const item = eventsForDate(Scheduling, projects, dateValue).find((entry) => String(entry.id || '') === String(appt?.dataset.psvEventId || ''));
      const project = projects.find((entry) => String(entry.id || '') === String(appt?.dataset.psvProjectId || '')) || null;
      options.onEventAction?.(node.dataset.psvEventAction || '', { event: item, project, element: appt });
    }));
    container.querySelectorAll('[data-psv-start]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.classList.contains('unavailable') || btn.getAttribute('aria-disabled') === 'true') return;
      const user = users.find((item) => item.id === btn.dataset.psvUser) || null;
      const start = new Date(btn.dataset.psvStart);
      const laneIndex = btn.dataset.psvLane === '' ? null : Number(btn.dataset.psvLane);
      const sameDraft = options.draft?.start
        && sameSlot(options.draft.start, start)
        && clean(options.draft.user?.id || '') === clean(user?.id || '');
      options.onDraftChange?.(sameDraft ? null : { start, user, laneIndex });
    }));
    container.querySelectorAll('[data-psv-draft-confirm]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onDraftConfirm?.(options.draft || null);
    }));
    container.__psvOutsideHandler = (event) => {
      if (!container.contains(event.target)) {
        const hadMenu = !!container.querySelector('.psv-event-menu,.psv-appt.open');
        container.querySelectorAll('.psv-event-menu').forEach((node) => node.remove());
        container.querySelectorAll('.psv-appt.open').forEach((node) => node.classList.remove('open'));
        if (hadMenu) options.onEventMenuClose?.();
        return;
      }
      if (event.target.closest('.psv-event-menu,.psv-appt')) return;
      const hadMenu = !!container.querySelector('.psv-event-menu,.psv-appt.open');
      container.querySelectorAll('.psv-event-menu').forEach((node) => node.remove());
      container.querySelectorAll('.psv-appt.open').forEach((node) => node.classList.remove('open'));
      if (hadMenu) options.onEventMenuClose?.();
    };
    document.addEventListener('click', container.__psvOutsideHandler);
    hydrateTravelLabels(container, !!options.liveTravel);
  }

  function updateDraft(container, draft){
    const state = container?.__psvOptions;
    if (!container || !state) return false;
    container.querySelectorAll('.psv-appt.draft').forEach((node) => node.remove());
    container.querySelectorAll('.psv-slot[data-psv-start]').forEach((slot) => {
      slot.classList.remove('has-draft');
      slot.style.setProperty('--slot-stack-count', String(slot.querySelectorAll('.psv-appt:not(.draft)').length));
    });
    if (!draft?.start) return true;
    const startIso = new Date(draft.start).toISOString();
    const userId = clean(draft.user?.id || '');
    const target = Array.from(container.querySelectorAll('.psv-slot[data-psv-start]')).find((slot) => {
      if (Math.abs(new Date(slot.dataset.psvStart).getTime() - new Date(startIso).getTime()) >= 1000) return false;
      if (clean(slot.dataset.psvUser || '') !== userId) return false;
      return true;
    });
    if (!target) return false;
    const dateValue = localDate(draft.start);
    const rowEvents = userId
      ? eventsForDate(state.Scheduling, state.projects || [], dateValue, userId)
      : eventsForDate(state.Scheduling, state.projects || [], dateValue).filter((event) => !eventUserIds(event).length);
    const stackIndex = overlapStackIndex({
      events: rowEvents,
      Scheduling: state.Scheduling,
      start: draft.start,
      duration: state.duration,
      excludeEventId: state.assignmentEventId || ''
    });
    target.style.setProperty('--slot-stack-count', String(stackIndex + 1));
    target.insertAdjacentHTML('beforeend', draftHtml({
      draft,
      placementProject: state.placementProject,
      Scheduling: state.Scheduling,
      slotMinutes: state.slotMinutes,
      duration: state.duration,
      confirmable: typeof state.onDraftConfirm === 'function',
      stackIndex,
    }));
    target.querySelector('[data-psv-draft-confirm]')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.onDraftConfirm?.(draft);
    });
    target.classList.add('has-draft');
    return true;
  }

  function addDays(date, days){
    const d = new Date(date);
    d.setDate(d.getDate() + Number(days || 0));
    return d;
  }

  function startOfWeek(date){
    const d = new Date(date);
    d.setHours(0,0,0,0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  function dateKey(date){
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function dayTemporalClass(day){
    const key = dateKey(day);
    const today = dateKey(new Date());
    if (key === today) return 'today';
    return key < today ? 'past' : '';
  }

  function dateAt(dateValue, time = '00:00'){
    return new Date(`${dateValue}T${time}:00`);
  }

  function clampRange(start, end){
    const s = new Date(start);
    const e = new Date(end);
    if (!Number.isFinite(s.getTime())) return null;
    if (!Number.isFinite(e.getTime()) || e <= s) return { start: s, end: addDays(s, 1) };
    return { start: s, end: e };
  }

  function rangeOverlapsDay(start, end, day){
    const dayStart = dateAt(day, '00:00');
    const dayEnd = addDays(dayStart, 1);
    return start < dayEnd && end > dayStart;
  }

  function dayDiff(a, b){
    return Math.round((dateAt(dateKey(b), '00:00').getTime() - dateAt(dateKey(a), '00:00').getTime()) / 86400000);
  }

  function formatRange(start, end, allDay){
    if (allDay) {
      const endDisplay = addDays(end, -1);
      if (dateKey(start) === dateKey(endDisplay)) return start.toLocaleDateString([], { month:'short', day:'numeric' });
      return `${start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${endDisplay.toLocaleDateString([], { month:'short', day:'numeric' })}`;
    }
    return `${start.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })} - ${end.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`;
  }

  function workChipHtml(item, range, { draft = false, suspended = false, preview = false, confirmable = false, mode = 'month', day = '', showDetails = true, showTime = true, showStartHandle = true, showEndHandle = true, chipStyle = '', chipClass = '' } = {}){
    const id = esc(item.id || (draft ? '__draft' : ''));
    const title = esc(item.title || 'Work Section');
    const allDay = item.all_day !== false && item.schedule_granularity !== 'time';
    const crewLabelRaw = clean(item.crew_label || item.assigned_crew_name || item.crew_name || item.resource_name || item.assigned_crew?.name || item.crew?.name || '');
    const waitingForCrew = item.awaiting_crew === true || item.__waiting_for_crew === true;
    const crewLabel = waitingForCrew ? 'Waiting for crew' : crewLabelRaw;
    const timed = mode !== 'month';
    const styleAttr = chipStyle ? ` style="${esc(chipStyle)}"` : '';
    return `<div class="prs-work-chip ${timed ? 'timed' : ''} ${chipClass ? esc(chipClass) : ''} ${waitingForCrew ? 'awaiting-crew' : ''} ${draft ? 'draft' : ''} ${suspended ? 'suspended' : ''} ${preview ? 'preview' : ''} ${draft && confirmable ? 'has-confirm' : ''}" data-prs-event-id="${id}" data-prs-day="${esc(day)}" data-prs-mode="${esc(mode)}"${styleAttr}>
      ${showStartHandle ? `<button type="button" class="prs-handle start" data-prs-handle="start" aria-label="Resize start"></button>` : ''}
      <span class="prs-title">${showDetails ? title : '&nbsp;'}</span>
      ${showDetails && crewLabel ? `<span class="prs-crew ${waitingForCrew ? 'waiting' : ''}">${esc(crewLabel)}</span>` : ''}
      ${showDetails && showTime ? `<span class="prs-time">${esc(formatRange(range.start, range.end, allDay))}</span>` : ''}
      ${showEndHandle ? `<button type="button" class="prs-handle end" data-prs-handle="end" aria-label="Resize end"></button>` : ''}
      ${draft && confirmable ? `<button type="button" class="prs-confirm" data-prs-confirm aria-label="Confirm work section"><i class="fas fa-check"></i></button>` : ''}
    </div>`;
  }

  function normalizeRangeItem(item = {}){
    const start = eventStart(root.PlatformScheduling, item) || new Date(item.start_at || item.start || Date.now());
    const end = eventEnd(root.PlatformScheduling, item) || new Date(start.getTime() + Math.max(1, Number(item.duration_minutes || 480)) * 60000);
    return { item, range: clampRange(start, end) || { start, end } };
  }

  function rangeItemIsTimed(item = {}){
    return item.all_day === false || item.schedule_granularity === 'time';
  }

  function timedMonthRange(range){
    const start = dateAt(dateKey(range.start), '00:00');
    return { start, end: addDays(start, 1) };
  }

  function renderProjectRangeScheduler(container, options = {}){
    if (!container) return;
    injectCss();
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    const mode = ['day','week','month'].includes(options.mode) ? options.mode : 'month';
    const anchor = new Date(options.date || Date.now());
    const workEvents = (options.events || []).map((event) => Scheduling?.normalizeEvent ? Scheduling.normalizeEvent(event, options.config || null, options.project || null) : event);
    const legacyReadOnly = options.readOnly === true;
    const allowCreate = options.allowCreate !== undefined ? options.allowCreate !== false : !legacyReadOnly;
    const allowEdit = options.allowEdit !== undefined ? options.allowEdit !== false : !legacyReadOnly;
    const readOnly = !allowCreate && !allowEdit;
    const rawDrafts = Array.isArray(options.drafts) ? options.drafts : (options.draft ? [options.draft] : []);
    const requestedActiveDraftId = Object.prototype.hasOwnProperty.call(options, 'activeDraftId')
      ? options.activeDraftId
      : (options.draft?.id || rawDrafts[rawDrafts.length - 1]?.id || '');
    const activeDraftId = String(requestedActiveDraftId || '');
    const activeDraft = rawDrafts.find((entry) => String(entry?.id || '') === activeDraftId) || options.draft || null;
    const showModeSwitch = options.showModeSwitch !== false;
    const modeChoices = (Array.isArray(options.modes) && options.modes.length ? options.modes : ['month','week','day'])
      .filter((id) => ['month','week','day'].includes(id));
    const draftEvents = rawDrafts.filter((entry) => entry?.start).map((entry, index) => {
      const id = String(entry.id || `__draft_${index}`);
      return {
        id,
        event_id: entry.event_id || '',
        __draft: true,
        __activeDraft: id === activeDraftId,
        title: entry.title || 'Work Section',
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end || addDays(new Date(entry.start), 1)).toISOString(),
        all_day: entry.all_day !== false,
        schedule_granularity: entry.schedule_granularity || (entry.all_day === false ? 'time' : 'date')
      };
    });
    const draftIds = new Set(draftEvents.map((entry) => String(entry.id || '')));
    const visibleItems = [
      ...workEvents.filter((event) => !draftIds.has(String(event.id || ''))),
      ...draftEvents
    ];
    const eventByRenderedId = (id) => {
      const key = String(id || '');
      if (!key) return null;
      return visibleItems.find((entry) => String(entry.id || '') === key) || (String(localActiveDraft?.id || '') === key ? localActiveDraft : null) || null;
    };
    const viewLabel = mode === 'month'
      ? anchor.toLocaleDateString([], { month:'long', year:'numeric' })
      : mode === 'week'
        ? `${startOfWeek(anchor).toLocaleDateString([], { month:'short', day:'numeric' })} - ${addDays(startOfWeek(anchor), 6).toLocaleDateString([], { month:'short', day:'numeric' })}`
        : anchor.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
    const navStep = mode === 'month' ? 'month' : (mode === 'week' ? 'week' : 'day');
    const toolbar = `
      <div class="prs-toolbar">
        <div class="prs-nav">
          <button type="button" class="prs-icon-btn" data-prs-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" class="prs-icon-btn" data-prs-today>Today</button>
          <button type="button" class="prs-icon-btn" data-prs-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="prs-range">${esc(viewLabel)}</div>
        </div>
        ${showModeSwitch && modeChoices.length > 1 ? `<div class="prs-view-switch">${modeChoices.map((id) => `<button type="button" class="prs-view-btn ${mode === id ? 'active' : ''}" data-prs-mode="${id}">${esc(id[0].toUpperCase() + id.slice(1))}</button>`).join('')}</div>` : ''}
      </div>
    `;
    const renderMonth = () => {
      const month = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const start = startOfWeek(month);
      const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
      const weeks = Array.from({ length: 6 }, (_, weekIndex) => days.slice(weekIndex * 7, weekIndex * 7 + 7));
      const normalized = visibleItems.map(normalizeRangeItem).map((entry) => ({
        ...entry,
        displayRange: rangeItemIsTimed(entry.item) ? timedMonthRange(entry.range) : entry.range
      }));
      const weekBars = (weekDays) => {
        const weekStart = weekDays[0];
        const weekEnd = addDays(weekStart, 7);
        return normalized
          .filter(({ displayRange }) => displayRange.start < weekEnd && displayRange.end > weekStart)
          .sort((a, b) => a.displayRange.start - b.displayRange.start || a.displayRange.end - b.displayRange.end)
          .map(({ item, range, displayRange }, stackIndex) => {
            const timedMonth = rangeItemIsTimed(item);
            const barRange = displayRange || range;
            const segmentStart = barRange.start > weekStart ? barRange.start : weekStart;
            const segmentEnd = barRange.end < weekEnd ? barRange.end : weekEnd;
            const startCol = Math.max(1, Math.min(7, dayDiff(weekStart, segmentStart) + 1));
            const endCol = Math.max(startCol + 1, Math.min(8, dayDiff(weekStart, segmentEnd) + 1));
            const beginsHere = barRange.start >= weekStart && barRange.start < weekEnd;
            const continuesBefore = barRange.start < weekStart;
            const continuesAfter = barRange.end > weekEnd;
            const segmentRange = timedMonth ? range : { start: segmentStart, end: segmentEnd };
            return `<div class="prs-month-bar ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}" style="grid-column:${startCol}/${endCol};margin-top:${34 + stackIndex * 52}px" data-prs-date="${esc(dateKey(segmentStart))}">
              ${workChipHtml(item, segmentRange, {
                draft: item.__draft === true || item.id === '__draft',
                suspended: item.__draft === true && item.__activeDraft !== true,
                confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function' && !continuesAfter,
                mode,
                day: dateKey(segmentStart),
                chipClass: timedMonth ? 'timed-month' : '',
                showDetails: beginsHere,
                showTime: timedMonth,
                showStartHandle: timedMonth ? false : !continuesBefore,
                showEndHandle: timedMonth ? false : !continuesAfter
              })}
            </div>`;
          }).join('');
      };
      return `<div class="prs-surface"><div class="prs-month">
        <div class="prs-month-head-row">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<div class="prs-month-head">${day}</div>`).join('')}</div>
        ${weeks.map((weekDays) => `<div class="prs-month-week">
          ${weekDays.map((day, index) => `<div class="prs-day ${day.getMonth() === month.getMonth() ? '' : 'muted'} ${dayTemporalClass(day)}" style="grid-column:${index + 1}" data-prs-date="${esc(dateKey(day))}">
            <div class="prs-day-num">${day.getDate()}</div>
          </div>`).join('')}
          ${weekBars(weekDays)}
        </div>`).join('')}
      </div></div>`;
    };
    const renderTimed = () => {
      const startDay = mode === 'day' ? new Date(anchor) : startOfWeek(anchor);
      startDay.setHours(0,0,0,0);
      const days = Array.from({ length: mode === 'day' ? 1 : 7 }, (_, i) => addDays(startDay, i));
      const slotMinutes = Number(options.slotMinutes || 30);
      const workStart = 7 * 60;
      const workEnd = 19 * 60;
      const slots = [];
      for (let m = workStart; m < workEnd; m += slotMinutes) slots.push(m);
      const timeLabel = (m) => new Date(`2026-01-01T${String(Math.floor(m / 60)).padStart(2,'0')}:${String(m % 60).padStart(2,'0')}:00`).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
      return `<div class="prs-surface"><div class="prs-time-grid" style="--prs-days:${days.length}">
        <div class="prs-time-head"></div>
        ${days.map((day) => `<div class="prs-day-head ${dayTemporalClass(day)}">${esc(day.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }))}</div>`).join('')}
        ${slots.map((minute) => `
          <div class="prs-time-label">${esc(timeLabel(minute))}</div>
          ${days.map((day) => {
            const key = dateKey(day);
            const time = `${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`;
            const slotStart = dateAt(key, time);
            const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60000);
            const chips = visibleItems.map(normalizeRangeItem).map(({ item, range }) => {
              if (!rangeItemIsTimed(item)) {
                const dayStart = dateAt(key, '00:00');
                const dayEnd = addDays(dayStart, 1);
                if (minute !== workStart || range.start >= dayEnd || range.end <= dayStart) return null;
                return { item, range: { start: slotStart, end: dateAt(key, timeString(workEnd)) } };
              }
              if (range.start < slotEnd && range.end > slotStart && dateKey(range.start) === key && Math.abs(range.start.getTime() - slotStart.getTime()) < 1000) return { item, range };
              return null;
            }).filter(Boolean);
            return `<div class="prs-slot ${dayTemporalClass(day)}" data-prs-date="${esc(key)}" data-prs-time="${esc(time)}">${chips.map(({ item, range }) => {
              const span = Math.max(1, Math.ceil((range.end - range.start) / (slotMinutes * 60000)));
              const chipHeight = Math.max(30, span * 36 - 8);
              return workChipHtml({ ...item, all_day:false, schedule_granularity:'time' }, range, {
                draft: item.__draft === true || item.id === '__draft',
                suspended: item.__draft === true && item.__activeDraft !== true,
                confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function',
                mode,
                day: key,
                chipClass: chipHeight <= 64 ? 'compact-confirm' : '',
                chipStyle: `height:${chipHeight}px;min-height:${chipHeight}px`
              });
            }).join('')}</div>`;
          }).join('')}
        `).join('')}
      </div></div>`;
    };
    container.innerHTML = `<div class="prs-wrap ${readOnly ? 'readonly' : ''}">${toolbar}${mode === 'month' ? renderMonth() : renderTimed()}</div>`;
    container.querySelectorAll('[data-prs-nav]').forEach((btn) => btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.prsNav || 0);
      const next = new Date(anchor);
      if (navStep === 'month') next.setMonth(next.getMonth() + delta);
      else next.setDate(next.getDate() + delta * (navStep === 'week' ? 7 : 1));
      options.onNavigate?.(next, delta);
    }));
    container.querySelector('[data-prs-today]')?.addEventListener('click', () => options.onNavigate?.(new Date(), 0));
    container.querySelectorAll('.prs-view-btn[data-prs-mode]').forEach((btn) => btn.addEventListener('click', () => options.onModeChange?.(btn.dataset.prsMode || 'month')));

    let drag = null;
    const pointRange = (target) => {
      const cell = target.closest?.('.prs-day[data-prs-date],.prs-slot[data-prs-date]');
      if (!cell) return null;
      const day = cell.dataset.prsDate;
      if (mode === 'month') return { start: dateAt(day, '00:00'), end: addDays(dateAt(day, '00:00'), 1), allDay: true, granularity: 'date' };
      const time = cell.dataset.prsTime || '08:00';
      const start = dateAt(day, time);
      return { start, end: new Date(start.getTime() + Number(options.slotMinutes || 30) * 60000), allDay: false, granularity: 'time' };
    };
    const rangeFromMonthPointer = (event) => {
      const x = Number(event.clientX);
      const y = Number(event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const week = Array.from(container.querySelectorAll('.prs-month-week')).find((weekEl) => {
        const rect = weekEl.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (!week) return null;
      const firstDay = week.querySelector('.prs-day[data-prs-date]');
      if (!firstDay) return null;
      const rect = week.getBoundingClientRect();
      const col = Math.max(0, Math.min(6, Math.floor(((x - rect.left) / Math.max(1, rect.width)) * 7)));
      const day = dateKey(addDays(dateAt(firstDay.dataset.prsDate, '00:00'), col));
      return { start: dateAt(day, '00:00'), end: addDays(dateAt(day, '00:00'), 1), allDay: true, granularity: 'date' };
    };
    const rangeFromTimedPointer = (event) => {
      const x = Number(event.clientX);
      const y = Number(event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const slot = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      return slot ? pointRange(slot) : null;
    };
    const rangeFromPointer = (event) => {
      const geometricRange = mode === 'month' ? rangeFromMonthPointer(event) : rangeFromTimedPointer(event);
      if (geometricRange) return geometricRange;
      const node = document.elementFromPoint?.(event.clientX, event.clientY);
      return node ? pointRange(node) : null;
    };
    let localActiveDraft = activeDraft;
    const publishDraft = (range, extra = {}) => {
      if (!range) return;
      const defaultPayload = typeof options.defaultDraftPayload === 'function'
        ? (options.defaultDraftPayload(range) || {})
        : (options.defaultDraftPayload || {});
      const nextDraft = {
        ...(localActiveDraft || activeDraft || {}),
        ...defaultPayload,
        ...extra,
        id: extra.id || localActiveDraft?.id || activeDraft?.id || activeDraftId || '__draft',
        title: extra.title || localActiveDraft?.title || activeDraft?.title || 'Work Section',
        start: range.start,
        end: range.end,
        all_day: range.allDay,
        schedule_granularity: range.granularity,
      };
      upsertDraft(nextDraft);
      options.onDraftChange?.(nextDraft);
    };
    const pointerDistance = (event, activeDrag = drag) => {
      if (!activeDrag) return 0;
      return Math.hypot(Number(event.clientX || 0) - Number(activeDrag.startX || 0), Number(event.clientY || 0) - Number(activeDrag.startY || 0));
    };
    const clearLivePreview = () => container.querySelectorAll('.live-preview').forEach((node) => node.remove());
    const clearDragMarkers = () => {
      container.querySelectorAll('.in-range,.drag-over').forEach((node) => node.classList.remove('in-range','drag-over'));
      clearLivePreview();
    };
    const previewTitle = (activeDrag = drag) => activeDrag?.item?.title || activeDraft?.title || 'Work Section';
    const renderMonthPreview = (start, end, activeDrag = drag) => {
      clearLivePreview();
      if (mode !== 'month' || !start || !end || end <= start) return;
      const timedMonth = activeDrag?.item && rangeItemIsTimed(activeDrag.item);
      const displayStart = timedMonth ? dateAt(dateKey(start), '00:00') : start;
      const displayEnd = timedMonth ? addDays(displayStart, 1) : end;
      const previewItem = {
        id: '__preview',
        title: previewTitle(activeDrag),
        all_day: !timedMonth,
        schedule_granularity: timedMonth ? 'time' : 'date',
      };
      container.querySelectorAll('.prs-month-week').forEach((weekEl) => {
        const firstDay = weekEl.querySelector('.prs-day[data-prs-date]');
        if (!firstDay) return;
        const weekStart = dateAt(firstDay.dataset.prsDate, '00:00');
        const weekEnd = addDays(weekStart, 7);
        if (displayStart >= weekEnd || displayEnd <= weekStart) return;
        const segmentStart = displayStart > weekStart ? displayStart : weekStart;
        const segmentEnd = displayEnd < weekEnd ? displayEnd : weekEnd;
        const startCol = Math.max(1, Math.min(7, dayDiff(weekStart, segmentStart) + 1));
        const endCol = Math.max(startCol + 1, Math.min(8, dayDiff(weekStart, segmentEnd) + 1));
        const beginsHere = displayStart >= weekStart && displayStart < weekEnd;
        const continuesBefore = displayStart < weekStart;
        const continuesAfter = displayEnd > weekEnd;
        const node = document.createElement('div');
        node.className = `prs-month-bar live-preview ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`;
        node.style.gridColumn = `${startCol}/${endCol}`;
        node.style.marginTop = activeDrag?.wrapper?.style?.marginTop || activeDrag?.node?.closest?.('.prs-month-bar')?.style?.marginTop || '34px';
        node.dataset.prsDate = dateKey(segmentStart);
        node.innerHTML = workChipHtml(previewItem, timedMonth ? { start, end } : { start: segmentStart, end: segmentEnd }, {
          draft: false,
          preview: true,
          mode,
          day: dateKey(segmentStart),
          chipClass: timedMonth ? 'timed-month' : '',
          showDetails: beginsHere,
          showTime: timedMonth,
          showStartHandle: false,
          showEndHandle: false
        });
        weekEl.appendChild(node);
      });
    };
    const renderTimedPreview = (start, end, activeDrag = drag) => {
      clearLivePreview();
      if (mode === 'month' || !start || !end || end <= start) return;
      const day = dateKey(start);
      const time = timeString(start.getHours() * 60 + start.getMinutes());
      const target = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((slot) => slot.dataset.prsDate === day && slot.dataset.prsTime === time);
      if (!target) return;
      const previewItem = {
        id: '__preview',
        title: previewTitle(activeDrag),
        all_day: false,
        schedule_granularity: 'time',
      };
      const slotMs = Number(options.slotMinutes || 30) * 60000;
      const span = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / slotMs));
      const holder = document.createElement('div');
      holder.innerHTML = workChipHtml(previewItem, { start, end }, {
        draft: false,
        preview: true,
        mode,
        day,
        showDetails: true,
        showTime: true,
        showStartHandle: false,
        showEndHandle: false,
        chipStyle: `height:${Math.max(30, span * 36 - 8)}px;min-height:${Math.max(30, span * 36 - 8)}px`
      });
      const chip = holder.firstElementChild;
      if (!chip) return;
      chip.classList.add('live-preview');
      target.appendChild(chip);
    };
    const renderRangePreview = (start, end, activeDrag = drag) => {
      if (mode === 'month') renderMonthPreview(start, end, activeDrag);
      else renderTimedPreview(start, end, activeDrag);
    };
    const removeRenderedDraft = (draftId = '') => {
      const id = String(draftId || localActiveDraft?.id || activeDraftId || '');
      if (!id) return;
      container.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => {
        const monthBar = chip.closest('.prs-month-bar');
        if (monthBar) monthBar.remove();
        else chip.remove();
      });
    };
    const attachLocalDraftConfirm = (rootNode) => {
      rootNode.querySelectorAll?.('[data-prs-confirm]')?.forEach((btn) => btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onDraftConfirm?.(localActiveDraft || null);
      }));
    };
    const upsertDraft = (draft) => {
      if (!draft?.start || !draft?.end) return null;
      const id = String(draft.id || localActiveDraft?.id || activeDraftId || '__draft');
      const start = new Date(draft.start);
      const end = new Date(draft.end);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
      const next = { ...draft, id, __draft: true, __activeDraft: true };
      localActiveDraft = next;
      removeRenderedDraft(id);
      const allDay = next.all_day !== false && next.schedule_granularity !== 'time';
      if (mode === 'month') {
        const displayStart = allDay ? start : dateAt(dateKey(start), '00:00');
        const displayEnd = allDay ? end : addDays(displayStart, 1);
        container.querySelectorAll('.prs-month-week').forEach((weekEl) => {
          const firstDay = weekEl.querySelector('.prs-day[data-prs-date]');
          if (!firstDay) return;
          const weekStart = dateAt(firstDay.dataset.prsDate, '00:00');
          const weekEnd = addDays(weekStart, 7);
          if (displayStart >= weekEnd || displayEnd <= weekStart) return;
          const segmentStart = displayStart > weekStart ? displayStart : weekStart;
          const segmentEnd = displayEnd < weekEnd ? displayEnd : weekEnd;
          const startCol = Math.max(1, Math.min(7, dayDiff(weekStart, segmentStart) + 1));
          const endCol = Math.max(startCol + 1, Math.min(8, dayDiff(weekStart, segmentEnd) + 1));
          const beginsHere = displayStart >= weekStart && displayStart < weekEnd;
          const continuesBefore = displayStart < weekStart;
          const continuesAfter = displayEnd > weekEnd;
          const node = document.createElement('div');
          node.className = `prs-month-bar ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`;
          node.style.gridColumn = `${startCol}/${endCol}`;
          node.style.marginTop = draft.__monthMarginTop || '34px';
          node.dataset.prsDate = dateKey(segmentStart);
          node.dataset.prsLocalDraft = '1';
          node.innerHTML = workChipHtml(next, allDay ? { start: segmentStart, end: segmentEnd } : { start, end }, {
            draft: true,
            confirmable: typeof options.onDraftConfirm === 'function' && !continuesAfter,
            mode,
            day: dateKey(segmentStart),
            chipClass: allDay ? '' : 'timed-month',
            showDetails: beginsHere,
            showTime: !allDay,
            showStartHandle: allDay && !continuesBefore,
            showEndHandle: allDay && !continuesAfter
          });
          weekEl.appendChild(node);
          attachLocalDraftConfirm(node);
          bindProjectChip(node.querySelector('.prs-work-chip'));
        });
        return next;
      }
      const day = dateKey(start);
      const time = timeString(start.getHours() * 60 + start.getMinutes());
      const target = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((slot) => slot.dataset.prsDate === day && slot.dataset.prsTime === time);
      if (!target) return next;
      const slotMs = Number(options.slotMinutes || 30) * 60000;
      const span = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / slotMs));
      const holder = document.createElement('div');
      holder.innerHTML = workChipHtml({ ...next, all_day:false, schedule_granularity:'time' }, { start, end }, {
        draft: true,
        confirmable: typeof options.onDraftConfirm === 'function',
        mode,
        day,
        showDetails: true,
        showTime: true,
        showStartHandle: true,
        showEndHandle: true,
        chipClass: span <= 2 ? 'compact-confirm' : '',
        chipStyle: `height:${Math.max(30, span * 36 - 8)}px;min-height:${Math.max(30, span * 36 - 8)}px`
      });
      const chip = holder.firstElementChild;
      if (!chip) return next;
      target.appendChild(chip);
      attachLocalDraftConfirm(chip);
      bindProjectChip(chip);
      return next;
    };
    const removeRenderedItem = (itemId = '') => {
      const id = String(itemId || '');
      if (!id) return;
      container.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => {
        const monthBar = chip.closest('.prs-month-bar');
        if (monthBar) monthBar.remove();
        else chip.remove();
      });
    };
    const upsertCalendarItem = (item, optionsForItem = {}) => {
      if (!item?.id || !item?.start || !item?.end) return null;
      const id = String(item.id || '');
      const start = new Date(item.start);
      const end = new Date(item.end);
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
      const next = {
        ...item,
        id,
        start_at: start.toISOString(),
        end_at: end.toISOString()
      };
      removeRenderedItem(id);
      const allDay = next.all_day !== false && next.schedule_granularity !== 'time';
      if (mode === 'month') {
        const displayStart = allDay ? start : dateAt(dateKey(start), '00:00');
        const displayEnd = allDay ? end : addDays(displayStart, 1);
        container.querySelectorAll('.prs-month-week').forEach((weekEl) => {
          const firstDay = weekEl.querySelector('.prs-day[data-prs-date]');
          if (!firstDay) return;
          const weekStart = dateAt(firstDay.dataset.prsDate, '00:00');
          const weekEnd = addDays(weekStart, 7);
          if (displayStart >= weekEnd || displayEnd <= weekStart) return;
          const segmentStart = displayStart > weekStart ? displayStart : weekStart;
          const segmentEnd = displayEnd < weekEnd ? displayEnd : weekEnd;
          const startCol = Math.max(1, Math.min(7, dayDiff(weekStart, segmentStart) + 1));
          const endCol = Math.max(startCol + 1, Math.min(8, dayDiff(weekStart, segmentEnd) + 1));
          const beginsHere = displayStart >= weekStart && displayStart < weekEnd;
          const continuesBefore = displayStart < weekStart;
          const continuesAfter = displayEnd > weekEnd;
          const node = document.createElement('div');
          node.className = `prs-month-bar ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`;
          node.style.gridColumn = `${startCol}/${endCol}`;
          node.style.marginTop = optionsForItem.monthMarginTop || '34px';
          node.dataset.prsDate = dateKey(segmentStart);
          node.innerHTML = workChipHtml(next, allDay ? { start: segmentStart, end: segmentEnd } : { start, end }, {
            draft: false,
            mode,
            day: dateKey(segmentStart),
            chipClass: allDay ? '' : 'timed-month',
            showDetails: beginsHere,
            showTime: !allDay,
            showStartHandle: allDay && !continuesBefore,
            showEndHandle: allDay && !continuesAfter
          });
          weekEl.appendChild(node);
          bindProjectChip(node.querySelector('.prs-work-chip'));
        });
        return next;
      }
      const day = dateKey(start);
      const time = timeString(start.getHours() * 60 + start.getMinutes());
      const target = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((slot) => slot.dataset.prsDate === day && slot.dataset.prsTime === time);
      if (!target) return next;
      const slotMs = Number(options.slotMinutes || 30) * 60000;
      const span = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / slotMs));
      const holder = document.createElement('div');
      holder.innerHTML = workChipHtml({ ...next, all_day:false, schedule_granularity:'time' }, { start, end }, {
        draft: false,
        mode,
        day,
        showDetails: true,
        showTime: true,
        showStartHandle: true,
        showEndHandle: true,
        chipClass: span <= 2 ? 'compact-confirm' : '',
        chipStyle: `height:${Math.max(30, span * 36 - 8)}px;min-height:${Math.max(30, span * 36 - 8)}px`
      });
      const chip = holder.firstElementChild;
      if (!chip) return next;
      target.appendChild(chip);
      bindProjectChip(chip);
      return next;
    };
    const markRange = (start, end) => {
      clearDragMarkers();
      renderRangePreview(start, end);
      container.querySelectorAll('[data-prs-date]').forEach((cell) => {
        const key = cell.dataset.prsDate;
        const time = cell.dataset.prsTime;
        const cellStart = time ? dateAt(key, time) : dateAt(key, '00:00');
        const cellEnd = time ? new Date(cellStart.getTime() + Number(options.slotMinutes || 30) * 60000) : addDays(cellStart, 1);
        if (start < cellEnd && end > cellStart) cell.classList.add('in-range');
      });
    };
    const minimumSpan = () => mode === 'month' ? 86400000 : Number(options.slotMinutes || 30) * 60000;
    const dragRange = (activeDrag, targetRange) => {
      if (!activeDrag || !targetRange) return null;
      const { base, kind } = activeDrag;
      let nextStart = base.start;
      let nextEnd = base.end;
      if (kind === 'start') {
        nextStart = targetRange.start < base.end ? targetRange.start : new Date(base.end.getTime() - minimumSpan());
        nextEnd = base.end;
      } else if (kind === 'end') {
        nextStart = base.start;
        nextEnd = targetRange.end > base.start ? targetRange.end : new Date(base.start.getTime() + minimumSpan());
      } else {
        const duration = base.end.getTime() - base.start.getTime();
        if (mode === 'month' && rangeItemIsTimed(activeDrag.item)) {
          nextStart = new Date(targetRange.start);
          nextStart.setHours(base.start.getHours(), base.start.getMinutes(), base.start.getSeconds(), base.start.getMilliseconds());
        } else {
          nextStart = targetRange.start;
        }
        nextEnd = new Date(nextStart.getTime() + duration);
      }
      return { start: nextStart, end: nextEnd };
    };
    if (allowCreate) container.querySelectorAll('.prs-day,.prs-slot').forEach((cell) => {
      cell.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.prs-work-chip')) return;
        const range = pointRange(event.target);
        if (!range) return;
        event.preventDefault();
        drag = { kind: 'create', anchor: range, current: range, startX: event.clientX, startY: event.clientY, moved: false };
        cell.setPointerCapture?.(event.pointerId);
        markRange(range.start, range.end);
      });
      cell.addEventListener('pointerenter', (event) => {
        if (!drag || drag.kind !== 'create') return;
        const range = pointRange(event.target);
        if (!range) return;
        drag.current = range;
        const start = drag.anchor.start < range.start ? drag.anchor.start : range.start;
        const end = drag.anchor.end > range.end ? drag.anchor.end : range.end;
        markRange(start, end);
      });
      cell.addEventListener('pointermove', (event) => {
        if (!drag || drag.kind !== 'create') return;
        const range = rangeFromPointer(event);
        if (!range) return;
        if (pointerDistance(event) > 4) drag.moved = true;
        drag.current = range;
        const start = drag.anchor.start < range.start ? drag.anchor.start : range.start;
        const end = drag.anchor.end > range.end ? drag.anchor.end : range.end;
        markRange(start, end);
      });
      cell.addEventListener('pointerup', (event) => {
        if (!drag || drag.kind !== 'create') return;
        const range = rangeFromPointer(event) || pointRange(event.target) || drag.current || drag.anchor;
        const allDay = mode === 'month';
        const clickedSingleSlot = Math.abs(drag.anchor.start.getTime() - range.start.getTime()) < 1000
          && Math.abs(drag.anchor.end.getTime() - range.end.getTime()) < 1000;
        const canExtendDraft = clickedSingleSlot
          && !drag.moved
          && activeDraft?.start
          && !activeDraft?.event_id
          && (activeDraft.schedule_granularity || (activeDraft.all_day === false ? 'time' : 'date')) === (allDay ? 'date' : 'time');
        const anchorStart = canExtendDraft ? new Date(activeDraft.start) : drag.anchor.start;
        const anchorEnd = canExtendDraft ? new Date(activeDraft.end || activeDraft.start) : drag.anchor.end;
        const start = anchorStart < range.start ? anchorStart : range.start;
        const end = anchorEnd > range.end ? anchorEnd : range.end;
        drag = null;
        clearDragMarkers();
        publishDraft({ start, end, allDay, granularity: allDay ? 'date' : 'time' });
      });
    });
    function bindProjectChip(chip){
      if (!chip || chip.dataset.prsBound === '1') return;
      chip.dataset.prsBound = '1';
      chip.addEventListener('click', (event) => {
        if (chip.dataset.prsSuppressClick === '1') return;
        if (event.target.closest('[data-prs-handle],[data-prs-confirm]')) return;
        const id = chip.dataset.prsEventId || '';
        const item = eventByRenderedId(id);
        if (!item) return;
        if (item.__draft === true || id === '__draft') options.onDraftSelect?.(item);
        else options.onEventClick?.(item);
      });
      if (allowEdit) chip.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-prs-confirm]')) return;
        const id = chip.dataset.prsEventId || '';
        const item = eventByRenderedId(id);
        if (!item) return;
        const base = normalizeRangeItem(item).range;
        const handle = event.target.closest('[data-prs-handle]')?.dataset.prsHandle || 'move';
        chip.classList.add('dragging');
        drag = { kind: handle, item, node: chip, base, anchor: pointRange(chip.closest('[data-prs-date]')), startX: event.clientX, startY: event.clientY, moved: false };
        chip.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
    }
    container.querySelectorAll('.prs-work-chip').forEach(bindProjectChip);
    container.addEventListener('pointermove', (event) => {
      if (!drag || drag.kind === 'create') return;
      if (pointerDistance(event) <= 4 && !drag.moved) return;
      drag.moved = true;
      const targetRange = rangeFromPointer(event) || pointRange(event.target);
      const next = dragRange(drag, targetRange);
      if (next) renderRangePreview(next.start, next.end, drag);
    });
    container.addEventListener('pointerup', (event) => {
      if (!drag || drag.kind === 'create') return;
      const targetRange = rangeFromPointer(event) || pointRange(event.target);
      const activeDrag = drag;
      const { item } = activeDrag;
      container.querySelectorAll('.prs-work-chip.dragging').forEach((node) => node.classList.remove('dragging'));
      drag = null;
      clearLivePreview();
      if (!activeDrag.moved && pointerDistance(event, activeDrag) <= 4) {
        return;
      }
      const next = dragRange(activeDrag, targetRange);
      if (!next) return;
      activeDrag.node?.setAttribute('data-prs-suppress-click', '1');
      setTimeout(() => activeDrag.node?.removeAttribute('data-prs-suppress-click'), 80);
      const { start: nextStart, end: nextEnd } = next;
      const allDay = mode === 'month' && !rangeItemIsTimed(item);
      const payload = { start: nextStart, end: nextEnd, all_day: allDay, schedule_granularity: allDay ? 'date' : 'time' };
      if (item.__draft === true || item.id === '__draft') {
        const nextDraft = { ...item, ...payload };
        upsertDraft(nextDraft);
        options.onDraftChange?.(nextDraft);
      }
      else {
        const updatedItem = {
          ...item,
          ...payload,
          start: nextStart,
          end: nextEnd,
          start_at: nextStart.toISOString(),
          end_at: nextEnd.toISOString(),
          __start: nextStart,
          __end: nextEnd
        };
        Object.assign(item, updatedItem);
        const monthMarginTop = activeDrag.node?.closest?.('.prs-month-bar')?.style?.marginTop || '34px';
        upsertCalendarItem(updatedItem, { monthMarginTop });
        options.onEventRangeChange?.(updatedItem, payload);
      }
    });
    container.querySelectorAll('[data-prs-confirm]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onDraftConfirm?.(localActiveDraft || activeDraft || null);
    }));
  }

  function normalizeResource(resource = {}, index = 0){
    const id = clean(resource.id || resource.crew_id || resource.user_id || (resource.unassigned ? '' : `resource_${index}`));
    return {
      ...resource,
      id,
      name: clean(resource.name || resource.label || resource.title || resource.email || (resource.unassigned ? 'Unassigned' : `Crew ${index + 1}`)),
      unassigned: resource.unassigned === true || !id
    };
  }

  function resourceIdForItem(item = {}){
    if (Object.prototype.hasOwnProperty.call(item, 'assigned_crew_id')) return clean(item.assigned_crew_id);
    if (Object.prototype.hasOwnProperty.call(item, 'crew_id')) return clean(item.crew_id);
    if (Object.prototype.hasOwnProperty.call(item, 'resource_id')) return clean(item.resource_id);
    return clean(item.assigned_resource_id);
  }

  function renderResourceDayScheduler(container, options = {}){
    if (!container) return;
    injectCss();
    if (container.__prsSmartCleanup) {
      container.__prsSmartCleanup();
      container.__prsSmartCleanup = null;
    }
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    const mode = options.mode === 'day' ? 'day' : 'week';
    const anchor = new Date(options.date || Date.now());
    anchor.setHours(0,0,0,0);
    const dayCount = mode === 'day' ? 1 : Math.max(21, Math.min(365, Number(options.dayCount || 70) || 70));
    const pastDays = mode === 'day' ? 0 : Math.max(0, Math.min(dayCount - 7, Number(options.pastDays ?? 14) || 0));
    const start = mode === 'day' ? new Date(anchor) : addDays(anchor, -pastDays);
    const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i));
    const resources = (options.resources || []).map(normalizeResource);
    const rows = [normalizeResource({ id:'', name:'Unassigned', unassigned:true }), ...resources.filter((item) => !item.unassigned)];
    const rawDrafts = Array.isArray(options.drafts) ? options.drafts : (options.draft ? [options.draft] : []);
    const activeDraftId = String(Object.prototype.hasOwnProperty.call(options, 'activeDraftId') ? (options.activeDraftId || '') : (rawDrafts[rawDrafts.length - 1]?.id || ''));
    const activeDraft = rawDrafts.find((entry) => String(entry?.id || '') === activeDraftId) || null;
    const draftEvents = rawDrafts.filter((entry) => entry?.start).map((entry, index) => {
      const id = String(entry.id || `__draft_${index}`);
      return {
        ...entry,
        id,
        event_id: entry.event_id || '',
        __draft: true,
        __activeDraft: id === activeDraftId,
        title: entry.title || 'Work Section',
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end || addDays(new Date(entry.start), 1)).toISOString(),
        all_day: entry.all_day !== false,
        schedule_granularity: entry.schedule_granularity || (entry.all_day === false ? 'time' : 'date'),
        assigned_crew_id: resourceIdForItem(entry),
        assigned_crew_name: Object.prototype.hasOwnProperty.call(entry, 'assigned_crew_name') ? clean(entry.assigned_crew_name) : clean(entry.crew_name || entry.resource_name)
      };
    });
    const draftIds = new Set(draftEvents.map((entry) => String(entry.id || '')));
    const workEvents = (options.events || []).map((event) => Scheduling?.normalizeEvent ? Scheduling.normalizeEvent(event, options.config || null, options.project || null) : event);
    const visibleItems = [
      ...workEvents.filter((event) => !draftIds.has(String(event.id || ''))),
      ...draftEvents
    ];
    const normalized = visibleItems.map(normalizeRangeItem);
    const eventByRenderedId = (id) => {
      const key = String(id || '');
      if (!key) return null;
      if (localActiveDraft && String(localActiveDraft.id || '') === key) return localActiveDraft;
      return visibleItems.find((entry) => String(entry.id || '') === key) || null;
    };
    const editableEventIds = Array.isArray(options.editableEventIds) ? new Set(options.editableEventIds.map((id) => String(id || '')).filter(Boolean)) : null;
    const itemIsEditable = (item = {}) => item.__draft === true || item.id === '__draft' || !editableEventIds || editableEventIds.has(String(item.id || item.event_id || ''));
    const itemResourceId = (item) => typeof options.resourceIdForItem === 'function' ? clean(options.resourceIdForItem(item)) : resourceIdForItem(item);
    const findResource = (id) => rows.find((row) => String(row.id || '') === String(id || '')) || rows[0];
    const resourcePayload = (resource) => typeof options.resourcePayload === 'function' ? (options.resourcePayload(resource) || {}) : ({
      resource_id: resource?.id || '',
      resource_name: resource?.name || '',
      crew_id: resource?.id || '',
      crew_name: resource?.name || '',
      assigned_crew_id: resource?.id || '',
      assigned_crew_name: resource?.name || '',
      assigned_crew: resource?.id ? { id: resource.id, name: resource.name } : null
    });
    const viewEnd = addDays(start, dayCount);
    const viewLabel = mode === 'day'
      ? days[0].toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })
      : `${days[0].toLocaleDateString([], { month:'short', day:'numeric' })} - ${days[days.length - 1].toLocaleDateString([], { month:'short', day:'numeric' })}`;
    const rowForResource = (resourceId) => Math.max(0, rows.findIndex((row) => String(row.id || '') === String(resourceId || '')));
    const chipForItem = (item, range, segmentStart, segmentEnd, rowIndex) => {
      const timed = rangeItemIsTimed(item);
      const beginsHere = range.start >= start && range.start <= segmentStart;
      const continuesBefore = range.start < segmentStart;
      const continuesAfter = range.end > segmentEnd;
      const startCol = Math.max(2, Math.min(dayCount + 1, dayDiff(start, segmentStart) + 2));
      const endCol = Math.max(startCol + 1, Math.min(dayCount + 2, dayDiff(start, segmentEnd) + 2));
      return `<div class="prs-resource-bar ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}" style="grid-row:${rowIndex + 2};grid-column:${startCol}/${endCol}" data-prs-date="${esc(dateKey(segmentStart))}">
        ${workChipHtml(item, { start: segmentStart, end: segmentEnd }, {
          draft: item.__draft === true || item.id === '__draft',
          suspended: item.__draft === true && item.__activeDraft !== true,
          confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function',
          mode: 'month',
          day: dateKey(segmentStart),
          chipClass: timed ? 'timed-month' : '',
          showDetails: beginsHere,
          showTime: timed,
          showStartHandle: timed ? false : !continuesBefore,
          showEndHandle: timed ? false : !continuesAfter
        })}
      </div>`;
    };
    const bars = normalized
      .filter(({ range }) => range.start < viewEnd && range.end > start)
      .sort((a, b) => rowForResource(itemResourceId(a.item)) - rowForResource(itemResourceId(b.item)) || a.range.start - b.range.start)
      .map(({ item, range }) => {
        const segmentStart = range.start > start ? range.start : start;
        const segmentEnd = range.end < viewEnd ? range.end : viewEnd;
        return chipForItem(item, range, segmentStart, segmentEnd, rowForResource(itemResourceId(item)));
      }).join('');
    const toolbar = `
      <div class="prs-toolbar">
        <div class="prs-nav">
          <button type="button" class="prs-icon-btn" data-prs-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" class="prs-icon-btn" data-prs-today>Today</button>
          <button type="button" class="prs-icon-btn" data-prs-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="prs-range">${esc(viewLabel)}</div>
        </div>
        <span class="psv-pill"><i class="fas fa-people-group"></i>${esc(options.modeLabel || 'Crew day view')}</span>
    </div>
    `;
    container.innerHTML = `<div class="prs-wrap ${options.readOnly ? 'readonly' : ''}">${toolbar}<div class="prs-resource-scroll"><div class="prs-resource-grid" style="--prs-days:${dayCount};--prs-resources:${rows.length}">
      <div class="prs-resource-corner" style="grid-row:1;grid-column:1"></div>
      ${days.map((day, index) => `<div class="prs-resource-day-head ${[0,6].includes(day.getDay()) ? 'weekend' : ''} ${dayTemporalClass(day)}" style="grid-row:1;grid-column:${index + 2}"><span>${esc(day.toLocaleDateString([], { weekday:'short' }))}</span><span>${esc(day.toLocaleDateString([], { month:'short', day:'numeric' }))}</span></div>`).join('')}
      ${rows.map((resource, rowIndex) => `
        <div class="prs-resource-label ${resource.unassigned ? 'unassigned' : ''}" style="grid-row:${rowIndex + 2};grid-column:1">${esc(resource.name)}<small>${resource.unassigned ? esc(options.unassignedLabel || 'Assign later') : esc(options.resourceLabel || 'Assigned crew')}</small></div>
        ${days.map((day, dayIndex) => `<div class="prs-resource-cell ${[0,6].includes(day.getDay()) ? 'weekend' : ''} ${dayTemporalClass(day)}" style="grid-row:${rowIndex + 2};grid-column:${dayIndex + 2}" data-prs-date="${esc(dateKey(day))}" data-prs-resource="${esc(resource.id || '')}"></div>`).join('')}
      `).join('')}
      ${bars}
    </div></div></div>`;
    const scroll = container.querySelector('.prs-resource-scroll');
    if (scroll) {
      const grid = container.querySelector('.prs-resource-grid');
      const firstCell = grid?.querySelector?.('.prs-resource-day-head');
      const cellWidth = firstCell?.getBoundingClientRect?.().width || 86;
      scroll.scrollLeft = Math.max(0, Math.round(cellWidth * pastDays));
    }
    container.querySelectorAll('[data-prs-nav]').forEach((btn) => btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.prsNav || 0);
      options.onNavigate?.(addDays(anchor, delta * (mode === 'day' ? 1 : 28)), delta);
    }));
    container.querySelector('[data-prs-today]')?.addEventListener('click', () => options.onNavigate?.(new Date(), 0));
    let horizonTimer = 0;
    scroll?.addEventListener('scroll', () => {
      if (mode === 'day' || horizonTimer) return;
      const max = Math.max(0, Number(scroll.scrollWidth || 0) - Number(scroll.clientWidth || 0));
      if (max <= 0) return;
      if (scroll.scrollLeft > max - 260) {
        horizonTimer = window.setTimeout(() => { horizonTimer = 0; options.onNavigate?.(addDays(anchor, 28), 1); }, 180);
      } else if (scroll.scrollLeft < 260) {
        horizonTimer = window.setTimeout(() => { horizonTimer = 0; options.onNavigate?.(addDays(anchor, -28), -1); }, 180);
      }
    }, { passive:true });
    if (scroll && options.smartScroll !== false && root.PlatformScheduleView?.installPointerSmartScroll) {
      container.__prsSmartCleanup = root.PlatformScheduleView.installPointerSmartScroll({
        scroller: scroll,
        content: container.querySelector('.prs-resource-grid'),
        itemSelector: '.prs-resource-day-head',
        axis: 'x',
        deadZoneItems: 1
      });
    }
    let drag = null;
    const clearLivePreview = () => container.querySelectorAll('.live-preview').forEach((node) => node.remove());
    const clearMarkers = () => {
      container.querySelectorAll('.in-range').forEach((node) => node.classList.remove('in-range'));
      clearLivePreview();
    };
    const pointRange = (event) => {
      const x = Number(event.clientX);
      const y = Number(event.clientY);
      const cell = Array.from(container.querySelectorAll('.prs-resource-cell[data-prs-date]')).find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (!cell) return null;
      const day = dateAt(cell.dataset.prsDate, '00:00');
      const resource = findResource(cell.dataset.prsResource || '');
      return { start: day, end: addDays(day, 1), allDay: true, granularity: 'date', resource };
    };
    const renderPreview = (startDate, endDate, resource, activeDrag = drag) => {
      clearLivePreview();
      if (!startDate || !endDate || endDate <= startDate) return;
      const rowIndex = rowForResource(resource?.id || '');
      const segmentStart = startDate > start ? startDate : start;
      const segmentEnd = endDate < viewEnd ? endDate : viewEnd;
      if (segmentStart >= viewEnd || segmentEnd <= start) return;
      const startCol = Math.max(2, Math.min(dayCount + 1, dayDiff(start, segmentStart) + 2));
      const endCol = Math.max(startCol + 1, Math.min(dayCount + 2, dayDiff(start, segmentEnd) + 2));
      const node = document.createElement('div');
      node.className = 'prs-resource-bar live-preview';
      node.style.gridRow = String(rowIndex + 2);
      node.style.gridColumn = `${startCol}/${endCol}`;
      node.innerHTML = workChipHtml({
        id: '__preview',
        title: activeDrag?.item?.title || activeDraft?.title || 'Work Section',
        all_day: true,
        schedule_granularity: 'date'
      }, { start: segmentStart, end: segmentEnd }, {
        preview: true,
        mode: 'month',
        showTime: false,
        showStartHandle: false,
        showEndHandle: false
      });
      container.querySelector('.prs-resource-grid')?.appendChild(node);
    };
    let localActiveDraft = activeDraft;
    const removeRenderedDraft = (draftId = '') => {
      const id = String(draftId || localActiveDraft?.id || activeDraftId || '');
      if (!id) return;
      container.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => chip.closest('.prs-resource-bar')?.remove());
    };
    const upsertDraftBar = (draft) => {
      if (!draft?.start || !draft?.end) return;
      const id = String(draft.id || activeDraftId || '__draft');
      localActiveDraft = { ...draft, id, __draft: true, __activeDraft: true };
      removeRenderedDraft(id);
      const range = { start: new Date(draft.start), end: new Date(draft.end) };
      const resource = findResource(draft.assigned_crew_id || draft.crew_id || draft.resource_id || '');
      const segmentStart = range.start > start ? range.start : start;
      const segmentEnd = range.end < viewEnd ? range.end : viewEnd;
      if (segmentStart >= viewEnd || segmentEnd <= start) return;
      const item = {
        ...draft,
        id,
        __draft: true,
        __activeDraft: true,
        title: draft.title || localActiveDraft?.title || 'Work Section',
        all_day: draft.all_day !== false,
        schedule_granularity: draft.schedule_granularity || (draft.all_day === false ? 'time' : 'date')
      };
      const wrapper = document.createElement('div');
      wrapper.innerHTML = chipForItem(item, range, segmentStart, segmentEnd, rowForResource(resource?.id || ''));
      const node = wrapper.firstElementChild;
      if (!node) return;
      node.dataset.prsLocalDraft = '1';
      container.querySelector('.prs-resource-grid')?.appendChild(node);
      node.querySelector('[data-prs-confirm]')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onDraftConfirm?.(localActiveDraft || null);
      });
      bindResourceChip(node.querySelector('.prs-work-chip'));
    };
    const markRange = (startDate, endDate, resource) => {
      clearMarkers();
      renderPreview(startDate, endDate, resource);
      container.querySelectorAll(`.prs-resource-cell[data-prs-resource="${cssEscape(resource?.id || '')}"]`).forEach((cell) => {
        const cellStart = dateAt(cell.dataset.prsDate, '00:00');
        if (startDate < addDays(cellStart, 1) && endDate > cellStart) cell.classList.add('in-range');
      });
    };
    const pointerDistance = (event, activeDrag = drag) => activeDrag ? Math.hypot(Number(event.clientX || 0) - Number(activeDrag.startX || 0), Number(event.clientY || 0) - Number(activeDrag.startY || 0)) : 0;
    const nudgeScrollForPointer = (event) => {
      if (!scroll || mode === 'day') return;
      const rect = scroll.getBoundingClientRect();
      const edge = 84;
      if (event.clientX > rect.right - edge) scroll.scrollLeft += Math.max(4, Math.round((edge - (rect.right - event.clientX)) * 0.18));
      else if (event.clientX < rect.left + edge) scroll.scrollLeft -= Math.max(4, Math.round((edge - (event.clientX - rect.left)) * 0.18));
    };
    const dragRange = (activeDrag, target) => {
      if (!activeDrag || !target) return null;
      const base = activeDrag.base;
      const timed = rangeItemIsTimed(activeDrag.item);
      let nextStart = base.start;
      let nextEnd = base.end;
      if (timed) {
        const duration = base.end.getTime() - base.start.getTime();
        nextStart = new Date(target.start);
        nextStart.setHours(base.start.getHours(), base.start.getMinutes(), base.start.getSeconds(), base.start.getMilliseconds());
        nextEnd = new Date(nextStart.getTime() + duration);
      } else if (activeDrag.kind === 'start') {
        nextStart = target.start < base.end ? target.start : addDays(base.end, -1);
      } else if (activeDrag.kind === 'end') {
        nextEnd = target.end > base.start ? target.end : addDays(base.start, 1);
      } else {
        const span = Math.max(1, dayDiff(base.start, base.end));
        nextStart = target.start;
        nextEnd = addDays(nextStart, span);
      }
      return { start: nextStart, end: nextEnd, resource: target.resource, all_day: !timed, schedule_granularity: timed ? 'time' : 'date' };
    };
    const applyCommittedRange = (activeDrag, next) => {
      if (!activeDrag?.wrapper || !next?.start || !next?.end) return;
      const rowIndex = rowForResource(next.resource?.id || '');
      const segmentStart = next.start > start ? next.start : start;
      const segmentEnd = next.end < viewEnd ? next.end : viewEnd;
      if (segmentStart >= viewEnd || segmentEnd <= start) return;
      const startCol = Math.max(2, Math.min(dayCount + 1, dayDiff(start, segmentStart) + 2));
      const endCol = Math.max(startCol + 1, Math.min(dayCount + 2, dayDiff(start, segmentEnd) + 2));
      activeDrag.wrapper.style.gridRow = String(rowIndex + 2);
      activeDrag.wrapper.style.gridColumn = `${startCol}/${endCol}`;
      if (activeDrag.item) {
        activeDrag.item.start_at = next.start.toISOString();
        activeDrag.item.start = next.start.toISOString();
        activeDrag.item.end_at = next.end.toISOString();
        activeDrag.item.end = next.end.toISOString();
        activeDrag.item.all_day = next.all_day !== false;
        activeDrag.item.schedule_granularity = next.schedule_granularity || (next.all_day === false ? 'time' : 'date');
      }
    };
    if (options.allowCreate !== false) container.querySelectorAll('.prs-resource-cell').forEach((cell) => {
      cell.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.prs-work-chip')) return;
        const range = pointRange(event);
        if (!range) return;
        event.preventDefault();
        drag = { kind:'create', anchor: range, current: range, startX:event.clientX, startY:event.clientY, moved:false };
        cell.setPointerCapture?.(event.pointerId);
        markRange(range.start, range.end, range.resource);
      });
    });
    container.addEventListener('pointermove', (event) => {
      if (!drag) return;
      nudgeScrollForPointer(event);
      const target = pointRange(event);
      if (!target) return;
      if (pointerDistance(event) > 4) drag.moved = true;
      if (drag.kind === 'create') {
        drag.current = target;
        const startDate = drag.anchor.start < target.start ? drag.anchor.start : target.start;
        const endDate = drag.anchor.end > target.end ? drag.anchor.end : target.end;
        markRange(startDate, endDate, target.resource);
        return;
      }
      const next = dragRange(drag, target);
      if (next) renderPreview(next.start, next.end, next.resource, drag);
    });
    container.addEventListener('pointerup', (event) => {
      if (!drag) return;
      const target = pointRange(event) || drag.current || drag.anchor;
      const activeDrag = drag;
      container.querySelectorAll('.prs-work-chip.dragging').forEach((node) => node.classList.remove('dragging'));
      drag = null;
      clearMarkers();
      if (activeDrag.kind === 'create') {
        const startDate = activeDrag.anchor.start < target.start ? activeDrag.anchor.start : target.start;
        const endDate = activeDrag.anchor.end > target.end ? activeDrag.anchor.end : target.end;
        const nextDraft = {
          ...(localActiveDraft || activeDraft || {}),
          ...resourcePayload(target.resource),
          id: localActiveDraft?.id || activeDraft?.id || '__draft',
          title: localActiveDraft?.title || activeDraft?.title || 'Work Section',
          start: startDate,
          end: endDate,
          all_day: true,
          schedule_granularity: 'date'
        };
        upsertDraftBar(nextDraft);
        options.onDraftChange?.(nextDraft);
        return;
      }
      if (!activeDrag.moved && pointerDistance(event, activeDrag) <= 4) return;
      const next = dragRange(activeDrag, target);
      if (!next) return;
      activeDrag.node?.setAttribute('data-prs-suppress-click', '1');
      setTimeout(() => activeDrag.node?.removeAttribute('data-prs-suppress-click'), 80);
      const payload = { ...resourcePayload(next.resource), start: next.start, end: next.end, all_day: next.all_day !== false, schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date') };
      if (activeDrag.item.__draft === true || activeDrag.item.id === '__draft') {
        applyCommittedRange(activeDrag, next);
        localActiveDraft = { ...activeDrag.item, ...payload, __draft: true, __activeDraft: true };
        options.onDraftChange?.(localActiveDraft);
      } else {
        options.onEventRangeChange?.(activeDrag.item, payload);
        applyCommittedRange(activeDrag, next);
      }
    });
    function bindResourceChip(chip){
      if (!chip || chip.dataset.prsBound === '1') return;
      chip.dataset.prsBound = '1';
      chip.addEventListener('click', (event) => {
        if (chip.dataset.prsSuppressClick === '1') return;
        if (event.target.closest('[data-prs-handle],[data-prs-confirm]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item) return;
        if (item.__draft === true || item.id === '__draft') options.onDraftSelect?.(item);
        else if (itemIsEditable(item)) options.onEventClick?.(item);
      });
      if (options.allowEdit !== false) chip.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-prs-confirm]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item || !itemIsEditable(item)) return;
        const handle = event.target.closest('[data-prs-handle]')?.dataset.prsHandle || 'move';
        chip.classList.add('dragging');
        drag = { kind: handle, item, node: chip, wrapper: chip.closest('.prs-resource-bar'), base: normalizeRangeItem(item).range, startX:event.clientX, startY:event.clientY, moved:false };
        chip.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
    }
    container.querySelectorAll('.prs-work-chip').forEach(bindResourceChip);
    container.querySelectorAll('[data-prs-confirm]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onDraftConfirm?.(localActiveDraft || activeDraft || null);
    }));
  }

  function renderResourceTimeScheduler(container, options = {}){
    if (!container) return;
    injectCss();
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    const anchor = new Date(options.date || Date.now());
    anchor.setHours(0,0,0,0);
    const dateValue = dateKey(anchor);
    const slotMinutes = Math.max(5, Number(options.slotMinutes || 30) || 30);
    const workStart = Number(options.workStartMinutes ?? 7 * 60);
    const workEnd = Number(options.workEndMinutes ?? 19 * 60);
    const slots = [];
    for (let minute = workStart; minute < workEnd; minute += slotMinutes) slots.push(minute);
    const resources = (options.resources || []).map(normalizeResource);
    const rows = [normalizeResource({ id:'', name:'Unassigned', unassigned:true }), ...resources.filter((item) => !item.unassigned)];
    const rawDrafts = Array.isArray(options.drafts) ? options.drafts : (options.draft ? [options.draft] : []);
    const activeDraftId = String(Object.prototype.hasOwnProperty.call(options, 'activeDraftId') ? (options.activeDraftId || '') : (rawDrafts[rawDrafts.length - 1]?.id || ''));
    const activeDraft = rawDrafts.find((entry) => String(entry?.id || '') === activeDraftId) || null;
    const draftEvents = rawDrafts.filter((entry) => entry?.start).map((entry, index) => {
      const id = String(entry.id || `__draft_time_${index}`);
      return {
        ...entry,
        id,
        event_id: entry.event_id || '',
        __draft: true,
        __activeDraft: id === activeDraftId,
        title: entry.title || 'Work Section',
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end || new Date(new Date(entry.start).getTime() + slotMinutes * 60000)).toISOString(),
        all_day: false,
        schedule_granularity: 'time',
        assigned_crew_id: resourceIdForItem(entry),
        assigned_crew_name: Object.prototype.hasOwnProperty.call(entry, 'assigned_crew_name') ? clean(entry.assigned_crew_name) : clean(entry.crew_name || entry.resource_name)
      };
    });
    const draftIds = new Set(draftEvents.map((entry) => String(entry.id || '')));
    const events = (options.events || []).map((event) => Scheduling?.normalizeEvent ? Scheduling.normalizeEvent(event, options.config || null, options.project || null) : event);
    const visibleItems = [
      ...events.filter((event) => !draftIds.has(String(event.id || ''))),
      ...draftEvents
    ];
    const eventByRenderedId = (id) => {
      const key = String(id || '');
      if (!key) return null;
      if (localActiveDraft && String(localActiveDraft.id || '') === key) return localActiveDraft;
      return visibleItems.find((entry) => String(entry.id || '') === key) || null;
    };
    const editableEventIds = Array.isArray(options.editableEventIds) ? new Set(options.editableEventIds.map((id) => String(id || '')).filter(Boolean)) : null;
    const itemIsEditable = (item = {}) => item.__draft === true || item.id === '__draft' || !editableEventIds || editableEventIds.has(String(item.id || item.event_id || ''));
    const itemResourceId = (item) => typeof options.resourceIdForItem === 'function' ? clean(options.resourceIdForItem(item)) : resourceIdForItem(item);
    const findResource = (id) => rows.find((row) => String(row.id || '') === String(id || '')) || rows[0];
    const rowForResource = (resourceId) => Math.max(0, rows.findIndex((row) => String(row.id || '') === String(resourceId || '')));
    const resourcePayload = (resource) => typeof options.resourcePayload === 'function' ? (options.resourcePayload(resource) || {}) : ({
      resource_id: resource?.id || '',
      resource_name: resource?.name || '',
      crew_id: resource?.id || '',
      crew_name: resource?.name || '',
      assigned_crew_id: resource?.id || '',
      assigned_crew_name: resource?.name || '',
      assigned_crew: resource?.id ? { id: resource.id, name: resource.name } : null
    });
    const fixedDurationMinutes = Math.max(0, Number(options.fixedDurationMinutes || 0) || 0);
    const fixedEndFor = (startDate, fallbackEnd = null) => fixedDurationMinutes
      ? new Date(startDate.getTime() + fixedDurationMinutes * 60000)
      : (fallbackEnd || new Date(startDate.getTime() + slotMinutes * 60000));
    const slotStartDate = (minute) => dateAt(dateValue, timeString(minute));
    const slotRange = (minute) => {
      const start = slotStartDate(minute);
      return { start, end: new Date(start.getTime() + slotMinutes * 60000), allDay:false, granularity:'time' };
    };
    const timeLabel = (minute) => slotStartDate(minute).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
    const minuteForDate = (date) => date.getHours() * 60 + date.getMinutes();
    const dayStart = dateAt(dateValue, '00:00');
    const dayEnd = addDays(dayStart, 1);
    const normalizedVisibleItems = visibleItems.map(normalizeRangeItem);
    const allDayBars = normalizedVisibleItems
      .filter(({ item, range }) => !rangeItemIsTimed(item) && range.start < dayEnd && range.end > dayStart)
      .map(({ item }) => {
        const rowIndex = rowForResource(itemResourceId(item));
        const title = item.project_title || item.project_name || item.customer_name || item.title || 'Work Section';
        const address = clean(item.project_address || item.address || '');
        const label = address ? `${title} - ${address}` : title;
        return `<div class="prs-resource-all-day-bar" style="grid-row:${rowIndex + 2};grid-column:2/${slots.length + 2}" aria-label="${esc(`All day ${label}`)}"></div>
          <div class="prs-resource-all-day-label" style="grid-row:${rowIndex + 2};grid-column:2/${slots.length + 2}">
            <div class="prs-all-day-chip"><strong>All Day</strong><span>${esc(label)}</span></div>
          </div>`;
      }).join('');
    const visibleForDay = normalizedVisibleItems.filter(({ item, range }) => rangeItemIsTimed(item) && dateKey(range.start) === dateValue);
    const bars = visibleForDay.map(({ item, range }) => {
      const rowIndex = rowForResource(itemResourceId(item));
      const startMinute = Math.max(workStart, minuteForDate(range.start));
      const endMinute = Math.min(workEnd, minuteForDate(range.end));
      if (endMinute <= workStart || startMinute >= workEnd) return '';
      const startCol = Math.max(2, Math.min(slots.length + 1, Math.floor((startMinute - workStart) / slotMinutes) + 2));
      const span = Math.max(1, Math.ceil((Math.max(startMinute + slotMinutes, endMinute) - startMinute) / slotMinutes));
      const endCol = Math.min(slots.length + 2, startCol + span);
      return `<div class="prs-resource-time-bar" style="grid-row:${rowIndex + 2};grid-column:${startCol}/${endCol}" data-prs-date="${esc(dateValue)}">
        ${workChipHtml({ ...item, all_day:false, schedule_granularity:'time' }, range, {
          draft: item.__draft === true || item.id === '__draft',
          suspended: item.__draft === true && item.__activeDraft !== true,
          confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function',
          mode:'month',
          day: dateValue,
          chipClass:'timed-month',
          showTime:true,
          showStartHandle:true,
          showEndHandle:true
        })}
      </div>`;
    }).join('');
    const toolbar = `
      <div class="prs-toolbar">
        <div class="prs-nav">
          <button type="button" class="prs-icon-btn" data-prs-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" class="prs-icon-btn" data-prs-today>Today</button>
          <button type="button" class="prs-icon-btn" data-prs-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="prs-range">${esc(anchor.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' }))}</div>
        </div>
        <div class="prs-nav">
          ${typeof options.onSmartScrollToggle === 'function' ? `<button type="button" class="psv-smart-toggle ${options.smartScroll ? 'active' : ''}" data-prs-smart><span class="dot"></span> Smart scroll</button>` : ''}
          <span class="psv-pill"><i class="fas fa-clock"></i>${esc(options.modeLabel || 'Crew daily view')}</span>
        </div>
      </div>`;
    container.innerHTML = `<div class="prs-wrap">${toolbar}<div class="prs-resource-scroll"><div class="prs-resource-time-grid ${dayTemporalClass(anchor)}" style="--prs-slots:${slots.length};--prs-resources:${rows.length}">
      <div class="prs-resource-corner" style="grid-row:1;grid-column:1"></div>
      ${slots.map((minute, index) => `<div class="prs-resource-time-head" style="grid-row:1;grid-column:${index + 2}">${esc(timeLabel(minute))}</div>`).join('')}
      ${rows.map((resource, rowIndex) => `
        <div class="prs-resource-label ${resource.unassigned ? 'unassigned' : ''}" style="grid-row:${rowIndex + 2};grid-column:1">${esc(resource.name)}<small>${resource.unassigned ? esc(options.unassignedLabel || 'Assign later') : esc(options.resourceLabel || 'Assigned crew')}</small></div>
        ${slots.map((minute, slotIndex) => `<div class="prs-resource-time-cell" style="grid-row:${rowIndex + 2};grid-column:${slotIndex + 2}" data-prs-minute="${minute}" data-prs-resource="${esc(resource.id || '')}"></div>`).join('')}
      `).join('')}
      ${allDayBars}
      ${bars}
    </div></div></div>`;
    container.querySelectorAll('[data-prs-nav]').forEach((btn) => btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.prsNav || 0);
      options.onNavigate?.(addDays(anchor, delta), delta);
    }));
    container.querySelector('[data-prs-today]')?.addEventListener('click', () => options.onNavigate?.(new Date(), 0));
    container.querySelector('[data-prs-smart]')?.addEventListener('click', () => options.onSmartScrollToggle?.(!options.smartScroll));
    const scroll = container.querySelector('.prs-resource-scroll');
    if (scroll && options.smartScroll && root.PlatformScheduleView?.installPointerSmartScroll) {
      container.__prsSmartCleanup?.();
      container.__prsSmartCleanup = root.PlatformScheduleView.installPointerSmartScroll({
        scroller: scroll,
        content: container.querySelector('.prs-resource-time-grid'),
        itemSelector: '.prs-resource-time-head',
        axis: 'x',
        deadZoneItems: 1
      });
    }
    let drag = null;
    const clearPreview = () => {
      container.querySelectorAll('.prs-resource-time-bar.live-preview').forEach((node) => node.remove());
      container.querySelectorAll('.in-range').forEach((node) => node.classList.remove('in-range'));
    };
    const rangeFromPointer = (event) => {
      const x = Number(event.clientX), y = Number(event.clientY);
      const cell = Array.from(container.querySelectorAll('.prs-resource-time-cell')).find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (!cell) return null;
      const minute = Number(cell.dataset.prsMinute || workStart);
      return { ...slotRange(minute), resource: findResource(cell.dataset.prsResource || '') };
    };
    const pointerDistance = (event, activeDrag = drag) => activeDrag ? Math.hypot(Number(event.clientX || 0) - Number(activeDrag.startX || 0), Number(event.clientY || 0) - Number(activeDrag.startY || 0)) : 0;
    const dragRange = (activeDrag, target) => {
      if (!activeDrag || !target) return null;
      const base = activeDrag.base;
      let nextStart = base.start;
      let nextEnd = base.end;
      if (activeDrag.kind === 'start') {
        nextStart = target.start < base.end ? target.start : new Date(base.end.getTime() - slotMinutes * 60000);
      } else if (activeDrag.kind === 'end') {
        nextEnd = target.end > base.start ? target.end : new Date(base.start.getTime() + slotMinutes * 60000);
      } else {
        const duration = base.end.getTime() - base.start.getTime();
        nextStart = target.start;
        nextEnd = new Date(nextStart.getTime() + duration);
      }
      return { start: nextStart, end: nextEnd, resource: target.resource };
    };
    const applyCommittedRange = (activeDrag, next) => {
      if (!activeDrag?.wrapper || !next?.start || !next?.end) return;
      const rowIndex = rowForResource(next.resource?.id || '');
      const startMinute = Math.max(workStart, minuteForDate(next.start));
      const endMinute = Math.min(workEnd, minuteForDate(next.end));
      const startCol = Math.max(2, Math.min(slots.length + 1, Math.floor((startMinute - workStart) / slotMinutes) + 2));
      const span = Math.max(1, Math.ceil((Math.max(startMinute + slotMinutes, endMinute) - startMinute) / slotMinutes));
      activeDrag.wrapper.style.gridRow = String(rowIndex + 2);
      activeDrag.wrapper.style.gridColumn = `${startCol}/${Math.min(slots.length + 2, startCol + span)}`;
      activeDrag.node?.classList.remove('dragging');
      const timeLabelNode = activeDrag.node?.querySelector?.('.prs-time');
      if (timeLabelNode) timeLabelNode.textContent = formatRange(next.start, next.end, false);
      if (activeDrag.item) {
        activeDrag.item.start_at = next.start.toISOString();
        activeDrag.item.start = next.start.toISOString();
        activeDrag.item.end_at = next.end.toISOString();
        activeDrag.item.end = next.end.toISOString();
        activeDrag.item.duration_minutes = Math.max(1, Math.round((next.end.getTime() - next.start.getTime()) / 60000));
        activeDrag.item.all_day = false;
        activeDrag.item.schedule_granularity = 'time';
      }
    };
    const renderPreview = (startDate, endDate, resource, activeDrag = drag) => {
      clearPreview();
      if (!startDate || !endDate || endDate <= startDate) return;
      const rowIndex = rowForResource(resource?.id || '');
      const startMinute = Math.max(workStart, minuteForDate(startDate));
      const endMinute = Math.min(workEnd, minuteForDate(endDate));
      const startCol = Math.max(2, Math.min(slots.length + 1, Math.floor((startMinute - workStart) / slotMinutes) + 2));
      const span = Math.max(1, Math.ceil((Math.max(startMinute + slotMinutes, endMinute) - startMinute) / slotMinutes));
      const node = document.createElement('div');
      node.className = 'prs-resource-time-bar live-preview';
      node.style.gridRow = String(rowIndex + 2);
      node.style.gridColumn = `${startCol}/${Math.min(slots.length + 2, startCol + span)}`;
      node.innerHTML = workChipHtml({ id:'__preview', title: activeDrag?.item?.title || activeDraft?.title || 'Work Section', all_day:false, schedule_granularity:'time' }, { start:startDate, end:endDate }, {
        preview:true,
        mode:'month',
        chipClass:'timed-month',
        showTime:true,
        showStartHandle:false,
        showEndHandle:false
      });
      container.querySelector('.prs-resource-time-grid')?.appendChild(node);
    };
    let localActiveDraft = activeDraft;
    const removeRenderedDraft = (draftId = '') => {
      const id = String(draftId || localActiveDraft?.id || activeDraftId || '');
      if (!id) return;
      container.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => chip.closest('.prs-resource-time-bar')?.remove());
    };
    const upsertDraftBar = (draft) => {
      if (!draft?.start || !draft?.end) return;
      const id = String(draft.id || activeDraftId || '__draft');
      localActiveDraft = { ...draft, id, __draft: true, __activeDraft: true };
      removeRenderedDraft(id);
      const startDate = new Date(draft.start);
      const endDate = new Date(draft.end);
      if (dateKey(startDate) !== dateValue || endDate <= startDate) return;
      const resource = findResource(draft.assigned_crew_id || draft.crew_id || draft.resource_id || draft.assigned_user_id || '');
      const rowIndex = rowForResource(resource?.id || '');
      const startMinute = Math.max(workStart, minuteForDate(startDate));
      const endMinute = Math.min(workEnd, minuteForDate(endDate));
      if (endMinute <= workStart || startMinute >= workEnd) return;
      const startCol = Math.max(2, Math.min(slots.length + 1, Math.floor((startMinute - workStart) / slotMinutes) + 2));
      const span = Math.max(1, Math.ceil((Math.max(startMinute + slotMinutes, endMinute) - startMinute) / slotMinutes));
      const node = document.createElement('div');
      node.className = 'prs-resource-time-bar';
      node.dataset.prsLocalDraft = '1';
      node.style.gridRow = String(rowIndex + 2);
      node.style.gridColumn = `${startCol}/${Math.min(slots.length + 2, startCol + span)}`;
      node.innerHTML = workChipHtml({ ...draft, id, __draft: true, __activeDraft: true, all_day:false, schedule_granularity:'time' }, { start:startDate, end:endDate }, {
        draft: true,
        confirmable: typeof options.onDraftConfirm === 'function',
        mode:'month',
        day: dateValue,
        chipClass:'timed-month',
        showTime:true,
        showStartHandle:true,
        showEndHandle:true
      });
      container.querySelector('.prs-resource-time-grid')?.appendChild(node);
      node.querySelector('[data-prs-confirm]')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onDraftConfirm?.(localActiveDraft || null);
      });
      bindResourceTimeChip(node.querySelector('.prs-work-chip'));
    };
    if (options.allowCreate !== false) container.querySelectorAll('.prs-resource-time-cell').forEach((cell) => {
      cell.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.prs-work-chip')) return;
        const range = rangeFromPointer(event);
        if (!range) return;
        event.preventDefault();
        drag = { kind:'create', anchor:range, current:range, startX:event.clientX, startY:event.clientY, moved:false };
        cell.setPointerCapture?.(event.pointerId);
        renderPreview(range.start, range.end, range.resource);
      });
    });
    container.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const target = rangeFromPointer(event);
      if (!target) return;
      if (pointerDistance(event) > 4) drag.moved = true;
      if (drag.kind === 'create') {
        drag.current = target;
        const startDate = drag.anchor.start < target.start ? drag.anchor.start : target.start;
        const draggedEnd = drag.anchor.end > target.end ? drag.anchor.end : target.end;
        const endDate = fixedEndFor(startDate, draggedEnd);
        renderPreview(startDate, endDate, target.resource);
        return;
      }
      const next = dragRange(drag, target);
      if (next) renderPreview(next.start, next.end, next.resource, drag);
    });
    container.addEventListener('pointerup', (event) => {
      if (!drag) return;
      const target = rangeFromPointer(event) || drag.current || drag.anchor;
      const activeDrag = drag;
      drag = null;
      clearPreview();
      container.querySelectorAll('.prs-work-chip.dragging').forEach((node) => node.classList.remove('dragging'));
      const payloadBase = { ...resourcePayload(target.resource), all_day:false, schedule_granularity:'time' };
      if (activeDrag.kind === 'create') {
        const startDate = activeDrag.anchor.start < target.start ? activeDrag.anchor.start : target.start;
        const draggedEnd = activeDrag.anchor.end > target.end ? activeDrag.anchor.end : target.end;
        const endDate = fixedEndFor(startDate, draggedEnd);
        const nextDraft = { ...(localActiveDraft || activeDraft || {}), ...payloadBase, id: localActiveDraft?.id || activeDraft?.id || '__draft', title: localActiveDraft?.title || activeDraft?.title || 'Work Section', start:startDate, end:endDate };
        upsertDraftBar(nextDraft);
        options.onDraftChange?.(nextDraft);
        return;
      }
      if (!activeDrag.moved && pointerDistance(event, activeDrag) <= 4) return;
      const next = dragRange(activeDrag, target);
      if (!next) return;
      activeDrag.node?.setAttribute('data-prs-suppress-click', '1');
      setTimeout(() => activeDrag.node?.removeAttribute('data-prs-suppress-click'), 80);
      const payload = { ...payloadBase, ...resourcePayload(next.resource), start: next.start, end: next.end };
      if (activeDrag.item.__draft === true || activeDrag.item.id === '__draft') {
        applyCommittedRange(activeDrag, next);
        localActiveDraft = { ...activeDrag.item, ...payload, __draft: true, __activeDraft: true };
        options.onDraftChange?.(localActiveDraft);
      } else {
        options.onEventRangeChange?.(activeDrag.item, payload);
        applyCommittedRange(activeDrag, next);
      }
    });
    function bindResourceTimeChip(chip){
      if (!chip || chip.dataset.prsBound === '1') return;
      chip.dataset.prsBound = '1';
      chip.addEventListener('click', (event) => {
        if (chip.dataset.prsSuppressClick === '1') return;
        if (event.target.closest('[data-prs-handle],[data-prs-confirm]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item) return;
        if (item.__draft === true || item.id === '__draft') options.onDraftSelect?.(item);
        else if (itemIsEditable(item)) options.onEventClick?.(item);
      });
      if (options.allowEdit !== false) chip.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-prs-confirm]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item || !itemIsEditable(item)) return;
        const handle = event.target.closest('[data-prs-handle]')?.dataset.prsHandle || 'move';
        chip.classList.add('dragging');
        drag = { kind: handle, item, node: chip, wrapper: chip.closest('.prs-resource-time-bar'), base: normalizeRangeItem(item).range, startX:event.clientX, startY:event.clientY, moved:false };
        chip.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
    }
    container.querySelectorAll('.prs-work-chip').forEach(bindResourceTimeChip);
    container.querySelectorAll('[data-prs-confirm]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onDraftConfirm?.(localActiveDraft || activeDraft || null);
    }));
  }

  root.PlatformScheduleView = {
    renderDailyTeam,
    renderProjectRangeScheduler,
    renderResourceDayScheduler,
    renderResourceTimeScheduler,
    installPointerSmartScroll,
    installWheelHorizontalScroll,
    updateDraft,
    clearTravelCache(){ travelCache.clear(); },
  };
})();
