/* libraries/platform-schedule-view/platform-schedule-view.js
 * Reusable scheduling calendar surfaces.
 *
 * renderDailyTeam(container, options) draws a Google-Calendar-like daily team grid.
 * It can be read-only, or placement-enabled by passing placementProject and onDraftChange.
 */
(function(){
  const root = window;
  const STYLE_ID = 'platform_schedule_view_css';
  const POINTER_DRAG_THRESHOLD = 8;
  const TIMED_MOVE_CURSOR_OFFSET_MINUTES = 7.5;
  const TIMED_HEADER_DURATION_MS = 60 * 60 * 1000;
  const TIMED_PLACED_RIGHT_GUTTER_PX = 20;
  const MONTH_ITEM_TOP_PX = 23;
  const MONTH_ITEM_STEP_PX = 28;
  const MONTH_VISIBLE_ITEM_COUNT = 3;
  const MONTH_COLLAPSED_ITEMS_HEIGHT_PX = 105;
  const WEEK_ALL_DAY_ITEM_TOP_PX = 6;
  const WEEK_ALL_DAY_ITEM_STEP_PX = 28;
  const WEEK_ALL_DAY_ITEM_HEIGHT_PX = 24;
  const WEEK_ALL_DAY_VISIBLE_ITEM_COUNT = 3;
  const WEEK_ALL_DAY_COLLAPSED_HEIGHT_PX = 110;
  const travelCache = new Map();

  function monthWeekRowCount(value = new Date()){
    const anchor = new Date(value);
    if (!Number.isFinite(anchor.getTime())) return 5;
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Math.ceil((firstWeekday + daysInMonth) / 7);
  }

  /* Classic calendar column packing. Cluster events that transitively
   * overlap in time, then greedily assign each event (chronological order)
   * to the LEFTMOST lane whose previous occupant has already ended. Lane
   * widths divide the day column by the cluster's lane count — the peak
   * concurrency for that stretch of the day — so an event only moves right
   * when it genuinely cannot fit further left, and a later event happily
   * reuses lane 0 once it frees up. */
  function layoutTimedOverlapEntries(entries = []){
    const normalized = entries.map((entry, sourceIndex) => {
      const start = Number(new Date(entry?.start));
      const end = Number(new Date(entry?.end));
      return { ...entry, start, end, sourceIndex };
    }).filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start)
      .sort((a, b) => a.start - b.start || a.end - b.end || a.sourceIndex - b.sourceIndex);
    const clusters = [];
    let current = null;
    let currentEnd = -Infinity;
    normalized.forEach((entry) => {
      // Sorted by start, so a cluster closes when the next event starts at or
      // after everything seen so far has ended.
      if (!current || entry.start >= currentEnd) {
        current = [];
        clusters.push(current);
        currentEnd = entry.end;
      } else {
        currentEnd = Math.max(currentEnd, entry.end);
      }
      current.push(entry);
    });
    const layouts = [];
    clusters.forEach((members) => {
      const laneEnds = [];
      members.forEach((entry) => {
        let lane = laneEnds.findIndex((laneEnd) => laneEnd <= entry.start);
        if (lane < 0) lane = laneEnds.length;
        laneEnds[lane] = entry.end;
        entry.columnIndex = lane;
      });
      members.forEach((entry) => {
        layouts.push({
          ...entry,
          stackDepth:laneEnds.length - 1,
          insetLeft:0,
          insetRight:0,
          stackOrder:entry.columnIndex,
          columnIndex:entry.columnIndex,
          columnCount:laneEnds.length,
        });
      });
    });
    return layouts.sort((a, b) => a.sourceIndex - b.sourceIndex);
  }

  function timedOverlapColumnGeometry(layout = {}, rightGutter = 0){
    const columnCount = Math.max(1, Number(layout.columnCount || 1));
    const columnIndex = Math.max(0, Math.min(columnCount - 1, Number(layout.columnIndex || 0)));
    const insetLeft = Math.max(0, Number(layout.insetLeft || 0));
    const insetRight = Math.max(0, Number(layout.insetRight || 0));
    const gutter = Math.max(0, Number(rightGutter || 0));
    const reservedWidth = insetLeft + insetRight + gutter;
    const leftFraction = columnIndex / columnCount;
    const rightFraction = 1 - ((columnIndex + 1) / columnCount);
    return {
      leftFraction,
      rightFraction,
      leftPixels:insetLeft - leftFraction * reservedWidth,
      rightPixels:insetRight + gutter - rightFraction * reservedWidth,
    };
  }

  function packPreviewLaneSegments(previewSegments = [], existingSegments = []){
    const overlaps = (left, right) => left.startCol < right.endCol && right.startCol < left.endCol;
    const assignments = { previews:[], existing:[] };
    const rowKeys = new Set([...previewSegments, ...existingSegments].map((entry) => String(entry.rowKey || '')));
    rowKeys.forEach((rowKey) => {
      const previewByLane = [];
      previewSegments.filter((entry) => String(entry.rowKey || '') === rowKey).forEach((entry) => {
        let lane = 0;
        while ((previewByLane[lane] || []).some((placed) => overlaps(entry, placed))) lane += 1;
        previewByLane[lane] = [...(previewByLane[lane] || []), entry];
        assignments.previews.push({ ...entry, lane });
      });
      const occupiedByLane = previewByLane.map((entries) => [...(entries || [])]);
      existingSegments.filter((entry) => String(entry.rowKey || '') === rowKey)
        .sort((left, right) => Number(left.originalLane || 0) - Number(right.originalLane || 0) || left.startCol - right.startCol)
        .forEach((entry) => {
          let lane = Math.max(0, Number(entry.originalLane || 0));
          while ((occupiedByLane[lane] || []).some((placed) => overlaps(entry, placed))) lane += 1;
          occupiedByLane[lane] = [...(occupiedByLane[lane] || []), entry];
          assignments.existing.push({ ...entry, lane });
        });
    });
    return assignments;
  }

  function prioritizePrimaryPlacementDraft(primary = {}, derivedDrafts = []){
    const drafts = (Array.isArray(derivedDrafts) && derivedDrafts.length ? derivedDrafts : [primary]).filter((draft) => draft?.start && draft?.end);
    const primaryId = String(primary.id || primary.event_id || '');
    const primaryIndex = drafts.findIndex((draft) => String(draft.id || draft.event_id || '') === primaryId);
    if (primaryIndex < 0 && primary?.start && primary?.end) drafts.unshift(primary);
    else if (primaryIndex > 0) drafts.unshift(...drafts.splice(primaryIndex, 1));
    return drafts;
  }

  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[match]));
  }
  function clean(value){ return String(value ?? '').trim(); }
  function objectValue(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function eventTypeId(event = {}){ return clean(event.event_type_default_id || event.type_id || event.event_type_id || event.type).toLowerCase(); }
  function eventKind(event = {}){
    const presentation = objectValue(event.schedule_presentation || event.presentation);
    return clean(event.kind || event.event_kind || event.category || event.schedule_category || presentation.kind || presentation.category).toLowerCase();
  }
  function isMaterialDeliveryEvent(event = {}){
    const typeId = eventTypeId(event).replace(/[\s-]+/g, '_');
    const kind = eventKind(event).replace(/[\s-]+/g, '_');
    const scheduleItemKind = clean(event.schedule_item_kind || event.scheduleItemKind).toLowerCase().replace(/[\s-]+/g, '_');
    const metadata = objectValue(event.metadata);
    const resourceType = clean(event.resource_type || metadata.resource_type).toLowerCase().replace(/[\s-]+/g, '_');
    if (['labor', 'equipment'].includes(resourceType)
      || ['labor', 'equipment'].includes(scheduleItemKind)
      || clean(event.labor_list_id || event.equipment_list_id)) return false;
    const source = objectValue(event.source_ref || event.source);
    const sourceType = clean(source.type || event.source_type).toLowerCase().replace(/[\s-]+/g, '_');
    return kind === 'material_delivery'
      || kind === 'materials_delivery'
      || scheduleItemKind === 'material_delivery'
      || scheduleItemKind === 'materials_delivery'
      || typeId === 'material_delivery'
      || typeId.startsWith('material_delivery_')
      || typeId.startsWith('materials_delivery_')
      || !!clean(event.material_list_id || event.materialListId)
      || ['material_list', 'materials_list'].includes(sourceType);
  }
  /* Confirmation state for chip styling, or null when the feature is off for
   * this appointment or hidden from this viewer. Delegates to PlatformScheduling
   * so the visibility rule lives in exactly one place. */
  function confirmationStateFor(event = {}){
    const scheduling = root.PlatformScheduling;
    if (!scheduling || typeof scheduling.visibleConfirmationState !== 'function') return null;
    try {
      return scheduling.visibleConfirmationState(event);
    } catch {
      return null;
    }
  }

  function eventIsLocked(event = {}){
    const lock = event.schedule_lock ?? event.scheduling_lock ?? event.scheduleLock;
    if (typeof lock === 'boolean') return lock;
    if (lock && typeof lock === 'object' && !Array.isArray(lock)) {
      if (typeof lock.locked === 'boolean') return lock.locked;
      if (typeof lock.is_locked === 'boolean') return lock.is_locked;
      if (typeof lock.isLocked === 'boolean') return lock.isLocked;
      const state = clean(lock.status || lock.state).toLowerCase();
      if (['unlocked', 'open', 'movable'].includes(state)) return false;
      if (['locked', 'sealed', 'immutable'].includes(state)) return true;
      if (clean(lock.unlocked_at)) return false;
      if (clean(lock.locked_at)) return true;
    }
    return event.schedule_locked === true
      || event.scheduleLocked === true
      || event.is_schedule_locked === true
      || event.scheduling_locked === true
      || event.locked === true
      || ['locked', 'sealed', 'immutable'].includes(clean(event.schedule_lock_status || event.lock_state).toLowerCase());
  }
  function materialDeliveryIsOrdered(event = {}){
    if (event.ordered === true || event.is_ordered === true) return true;
    if (event.ordered === false || event.is_ordered === false) return false;
    const order = objectValue(event.material_order || event.order);
    const status = clean(event.material_order_status || event.order_status || order.status).toLowerCase();
    if (['draft', 'planned', 'planning', 'pending', 'not_ordered', 'unordered', 'cancelled', 'canceled', 'void'].includes(status)) return false;
    if (['ordered', 'submitted', 'confirmed', 'processing', 'scheduled', 'delivering', 'partially_delivered', 'delivered'].includes(status)) return true;
    return !!clean(event.material_order_id || event.order_id || order.id || event.ordered_at || order.ordered_at);
  }
  function safeCssColor(value){
    const color = clean(value);
    if (!color) return '';
    if (/^#[0-9a-f]{3,4}$/i.test(color) || /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)) return color;
    if (/^(?:rgb|hsl)a?\(\s*[-+0-9.%\s,/]+\)$/i.test(color)) return color;
    if (/^var\(--[a-z0-9_-]+(?:\s*,\s*#[0-9a-f]{3,8})?\)$/i.test(color)) return color;
    return '';
  }
  function safeIconClass(value, fallback = 'fa-truck'){
    const match = clean(value).match(/(?:^|\s)(fa-[a-z0-9-]+)(?:\s|$)/i);
    return match?.[1] || fallback;
  }
  function materialDeliveryPresentation(event = {}){
    const presentation = {
      ...objectValue(event.presentation),
      ...objectValue(event.material_presentation),
      ...objectValue(event.schedule_presentation),
    };
    const list = objectValue(event.material_list);
    const listColor = safeCssColor(
      event.material_list_color
      || event.list_color
      || event.group_color
      || event.accent_color
      || presentation.accent_color
      || presentation.list_color
      || list.color
    );
    const categoryColor = safeCssColor(
      event.material_delivery_color
      || event.delivery_color
      || event.category_color
      || event.event_category_color
      || presentation.main_color
      || presentation.category_color
      || presentation.color
      || event.color
    );
    const identityColor = listColor || categoryColor || '#64748b';
    return {
      // The material list is the event's visual identity. Category is conveyed
      // by the truck icon, not by introducing a competing calendar color.
      mainColor: identityColor,
      accentColor: identityColor,
      categoryColor,
      icon: safeIconClass(event.material_delivery_icon || presentation.icon || event.icon, 'fa-truck'),
      label: clean(event.material_list_title || event.material_list_name || event.group_label || presentation.label || list.title || list.name),
    };
  }
  function materialDeliveryTitle(event = {}){
    const presentation = materialDeliveryPresentation(event);
    const configuredTitle = clean(event.material_list_title || event.material_list_name || presentation.label || event.title || event.project_title);
    return configuredTitle.replace(/\s+delivery$/i, '').trim() || 'Materials';
  }
  function eventPassesEditPredicate(options = {}, event = {}){
    if (event.__draft === true || event.id === '__draft') return true;
    const predicate = typeof options.canEditEvent === 'function'
      ? options.canEditEvent
      : (typeof options.eventIsEditable === 'function' ? options.eventIsEditable : null);
    if (options.canEditEvent === false || options.eventIsEditable === false) return false;
    if (!predicate) return true;
    try {
      return predicate(event, { locked: eventIsLocked(event), materialDelivery: isMaterialDeliveryEvent(event) }) !== false;
    } catch (error) {
      console.warn('Schedule event edit predicate failed.', error);
      return false;
    }
  }
  function bindEventLockControl(chip, options = {}, resolveEvent = null){
    const control = chip?.querySelector?.('[data-prs-lock-toggle]');
    if (!control || control.dataset.prsLockBound === '1') return;
    control.dataset.prsLockBound = '1';
    const currentEvent = () => (typeof resolveEvent === 'function' ? resolveEvent() : null);
    const callback = typeof options.onEventLockToggle === 'function' ? options.onEventLockToggle : null;
    const initial = currentEvent();
    if (!callback) {
      if (!eventIsLocked(initial || {})) {
        control.remove();
        chip.classList.remove('has-lock-control');
      } else {
        control.disabled = true;
        control.classList.add('passive');
        control.setAttribute('aria-disabled', 'true');
      }
      return;
    }
    control.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    control.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = currentEvent();
      if (!item) return;
      const locked = eventIsLocked(item);
      try {
        const result = callback(item, !locked, { element: control, locked, source: 'schedule_tile' });
        if (result && typeof result.catch === 'function') result.catch((error) => console.warn('Schedule lock toggle failed.', error));
      } catch (error) {
        console.warn('Schedule lock toggle failed.', error);
      }
    });
  }
  function addressKey(value){
    return clean(value).toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s#-]/g, '').trim();
  }
  function travelKey(origin, destination){
    return `${addressKey(origin)}=>${addressKey(destination)}`;
  }
  function routableAddress(item = {}){
    const value = clean(item.project_address || item.address);
    if (!value || /^(?:no|missing|unknown)\b.*\baddress\b/i.test(value)) return '';
    return value;
  }
  function travelSegmentLayout(travelMinutes = 0, gapMinutes = 0, slotMinutes = 30, spanSlots = 1){
    const travel = Math.max(0, Number(travelMinutes) || 0);
    const gap = Math.max(0, Number(gapMinutes) || 0);
    const slot = Math.max(1, Number(slotMinutes) || 30);
    const capacity = Math.max(1, Number(spanSlots) || 1) * slot;
    const actualMinutes = travel > 0 ? Math.min(travel, gap) : Math.min(slot, gap);
    // Never draw shorter than 15 minutes of width: a 5-minute hop still needs
    // room for the clock icon and the number to stay legible.
    const displayedMinutes = Math.min(capacity, Math.max(actualMinutes, 15));
    return {
      bridge:travel > 0 && travel >= gap,
      insufficient:travel > gap,
      widthPercent:Math.min(100, Math.max(1, (displayedMinutes / capacity) * 100))
    };
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
    const hasMinutes = Number(String(time || '').split(':')[1] || 0) !== 0;
    return new Date(`2026-01-01T${time}:00`).toLocaleTimeString([], hasMinutes ? { hour:'numeric', minute:'2-digit' } : { hour:'numeric' });
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
  function dailyEventSlotPlacement(startValue, windowStartMinute = 8 * 60, slotMinutes = 30){
    const start = new Date(startValue);
    const slot = Math.max(1, Number(slotMinutes) || 30);
    if (!Number.isFinite(start.getTime())) return { time:'', offset:0 };
    const eventMinute = (start.getHours() * 60) + start.getMinutes() + (start.getSeconds() / 60);
    const slotIndex = Math.floor((eventMinute - windowStartMinute) / slot);
    const anchorMinute = windowStartMinute + (slotIndex * slot);
    return {
      time:timeString(anchorMinute),
      offset:Math.max(0, Math.min(0.999, (eventMinute - anchorMinute) / slot))
    };
  }
  function eventsForDate(Scheduling, projects, dateValue, userId = null, sourceEvents = null){
    const events = Array.isArray(sourceEvents) ? sourceEvents : (Scheduling?.eventsFromProjects?.(projects) || []);
    return events.filter((event) => {
      const scheduled = Scheduling?.eventIsScheduled
        ? Scheduling.eventIsScheduled(event)
        : !['unscheduled', 'cancelled', 'canceled'].includes(clean(event.status).toLowerCase()) && !!clean(event.start_at || event.start);
      if (!scheduled) return false;
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
      .psv-scroll{flex:1;min-width:0;min-height:0;overflow:auto;background:#eef2f6}
      .psv-scroll.smart-scroll-active{scroll-behavior:auto}
      .psv-grid{--psv-slot-width:58px;display:grid;grid-template-columns:repeat(var(--slot-count,16),var(--psv-slot-width));gap:1px;width:max-content;min-width:100%;min-height:100%;isolation:isolate;align-content:start;position:relative;overflow:visible;background:#eef2f6}
      .psv-grid.psv-resource-grid{grid-template-columns:150px repeat(var(--slot-count,16),var(--psv-slot-width));grid-template-rows:38px var(--psv-row-template,repeat(var(--psv-resources,1),56px))}
      .psv-grid.psv-resource-grid:before{content:"";position:sticky;left:0;grid-column:1;grid-row:1/-1;background:#f8fafc;border-right:1px solid rgba(15,23,42,.08);z-index:1;min-height:100%}
      .psv-person{min-height:var(--psv-row-height,56px);border:0;background:#f8fafc;padding:8px 9px;font-size:11px;font-weight:1000;color:#101828;box-shadow:none;overflow:hidden}
      .psv-person-head{min-height:38px;padding:0 9px}
      .psv-person small{display:block;margin-top:3px;color:#667085;font-size:10px;font-weight:900}
      .psv-grid.psv-resource-grid .psv-person{position:sticky;left:0;z-index:6;grid-column:1;border-right:1px solid rgba(15,23,42,.06);box-sizing:border-box;display:flex;flex-direction:column;justify-content:center}
      .psv-grid.psv-resource-grid .psv-person-head{top:0;left:0;z-index:8;border-bottom:1px solid rgba(15,23,42,.08)}
      .psv-person.unassigned,.psv-slot.unassigned{box-shadow:0 6px 0 #eef2f6}
      .psv-hour{min-height:38px;border:0;background:#f8fafc;padding:7px 5px;font-size:11px;font-weight:1000;color:#344054;text-align:center;line-height:1.05}.psv-hour span,.psv-hour small{display:block}.psv-hour small{margin-top:2px;font-size:9px;letter-spacing:.03em}
      .psv-grid.psv-resource-grid .psv-hour{position:sticky;top:0;z-index:7;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.08);box-sizing:border-box}
      .psv-hour.overflow{background:#eef2f6;color:#98a2b3}
      .psv-slot{--appt-height:46px;--appt-gap:6px;position:relative;min-height:var(--psv-row-height,56px);border:0;background:#fff;cursor:pointer;overflow:visible}
      .psv-grid.psv-resource-grid .psv-slot{border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
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
      .psv-appt{position:absolute;left:calc(5px + (var(--slot-offset,0) * 100%));top:calc(5px + (var(--stack-index,0) * (var(--appt-height) + var(--appt-gap))));width:calc((var(--span,1) * 100%) - 10px);height:var(--appt-height);border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.30);border:1px solid rgba(var(--primary-rgb,217,48,37),.42);color:#101828;padding:7px 8px;font-size:10px;font-weight:950;line-height:1.25;overflow:hidden;z-index:20;box-sizing:border-box;box-shadow:0 10px 20px rgba(15,23,42,.14)}
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
      .psv-draft-confirm:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
      .psv-draft-confirm:active{transform:translateY(-50%) scale(.92)}
      .psv-draft-confirm.saving{cursor:wait;pointer-events:none;opacity:.72}
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
      .prs-surface{position:relative;flex:1;min-height:0;overflow:auto;overflow-anchor:none;border:1px solid rgba(15,23,42,.04);border-radius:18px;background:#eef2f6;box-shadow:0 14px 34px rgba(15,23,42,.05);touch-action:none}
      .prs-month{min-width:840px;min-height:100%;display:flex;flex-direction:column;overflow-anchor:none}
      .prs-month-head-row{display:grid;grid-template-columns:repeat(7,minmax(108px,1fr));height:34px;flex:0 0 auto}
      .prs-month-head{height:34px;background:#f8fafc;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:center;color:#667085;font-size:11px;font-weight:1000}
      .prs-month-week{position:relative;display:grid;grid-template-columns:repeat(7,minmax(108px,1fr));min-height:124px;flex:1 1 124px;overflow:hidden;overflow-anchor:none;transition:height .3s cubic-bezier(.25,.1,.25,1),min-height .3s cubic-bezier(.25,.1,.25,1),flex-basis .3s cubic-bezier(.25,.1,.25,1)}
      .prs-month-week.expanded{min-height:var(--prs-month-expanded-height,124px);flex-basis:var(--prs-month-expanded-height,124px)}
      .prs-day{position:relative;min-height:104px;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);padding:5px;background:#fff;cursor:crosshair;overflow:hidden}
      .prs-month-week .prs-day{grid-row:1;min-height:124px;padding:3px 5px 5px}
      .prs-wrap.readonly .prs-day{cursor:default}
      .prs-day.muted{background:#f8fafc;color:#98a2b3}
      .prs-day.past{background:linear-gradient(135deg,rgba(148,163,184,.10),rgba(248,250,252,.74));color:#64748b}
      .prs-day.past:after,.prs-resource-cell.past:after,.prs-slot.past:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(100,116,139,.055) 0,rgba(100,116,139,.055) 1px,transparent 1px,transparent 9px);pointer-events:none}
      .prs-day.today{background:rgba(var(--primary-rgb,217,48,37),.055);box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.22)}
      .prs-day.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-day.drag-over{box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.32)}
      .prs-day-num{font-size:11px;font-weight:1000;line-height:18px;color:#344054;margin-bottom:2px}
      .prs-day.muted .prs-day-num{color:#98a2b3}
      .prs-day.today .prs-day-num{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:0 5px}
      .prs-work-chip{position:relative;width:100%;min-height:30px;border:1px solid rgba(100,116,139,.42);border-left:4px solid #64748b;border-radius:10px;background:#e8eef6;color:#101828;padding:4px 8px 4px 10px;font-size:11px;font-weight:950;line-height:1.2;overflow:hidden;text-align:left;cursor:grab;box-sizing:border-box;box-shadow:0 10px 20px rgba(15,23,42,.14);transition:transform .14s ease,box-shadow .14s ease,opacity .14s ease}
      .prs-wrap.events-click-only .prs-work-chip:not(.draft):not(.live-preview){cursor:pointer}
      .prs-work-chip.type-sales-appointment,.prs-work-chip.type-sales-follow-up{border-color:rgba(22,163,74,.42);border-left-color:#16a34a;background:#dcfce7;color:#14532d}
      .prs-work-chip.type-project-work{border-color:rgba(202,138,4,.42);border-left-color:#ca8a04;background:#fef3c7}
      .prs-work-chip.type-delivery{border-color:rgba(249,115,22,.42);border-left-color:#f97316;background:#ffedd5}
      .prs-work-chip.material-delivery{--prs-material-main:#64748b;border-color:color-mix(in srgb,var(--prs-material-main) 44%,transparent);border-left-width:1px;background:color-mix(in srgb,var(--prs-material-main) 10%,white);color:#101828}
      .prs-work-chip.material-delivery.material-unordered{border-style:dotted;border-width:2px}
      .prs-work-chip.material-delivery.material-ordered{border-style:solid}
      .prs-work-chip.untyped{border-color:rgba(100,116,139,.34);border-left-color:#64748b;background:#e8eef6}
      .prs-work-chip.unsaved{border-style:dotted}
      .prs-work-chip.unconfirmed{border-style:dashed;border-width:2px;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.5) 0,rgba(255,255,255,.5) 6px,transparent 6px,transparent 12px)}
      .prs-work-chip.confirmation-declined{border-style:dashed;border-width:2px;border-color:rgba(220,38,38,.6);border-left-color:#dc2626}
      .prs-confirm-marker{display:inline-flex;align-items:center;margin-right:4px;font-size:9.5px;vertical-align:baseline}
      .prs-confirm-marker.warn{color:#b45309}
      .prs-confirm-marker.bad{color:#b42318}
      .prs-requirement-warning{position:absolute;left:5px;bottom:4px;z-index:5;display:inline-grid;place-items:center;width:15px;height:15px;color:#dc2626;font-size:12px;filter:drop-shadow(0 1px 1px rgba(255,255,255,.9));cursor:pointer}
      .prs-work-chip.has-requirement-warning .prs-chip-bottom{padding-left:16px}
      .prs-work-chip.continues-before{border-top-style:dashed;border-top-left-radius:5px;border-top-right-radius:5px}
      .prs-work-chip.continues-after{border-bottom-style:dashed;border-bottom-left-radius:5px;border-bottom-right-radius:5px}
      .prs-month-item-viewport{position:absolute;inset:0 0 auto;height:calc(100% - 22px);overflow:hidden;z-index:5;pointer-events:none;transition:height .3s cubic-bezier(.25,.1,.25,1)}
      .prs-month-week.expanded .prs-month-item-viewport,.prs-month-week.collapsing .prs-month-item-viewport{height:calc(100% - 22px)}
      .prs-month-week.preview-expanded .prs-month-item-viewport{height:calc(100% - 8px)}
      .prs-month-item-track{position:relative;display:grid;grid-template-columns:repeat(7,minmax(108px,1fr));height:var(--prs-month-track-height,105px);min-width:100%;pointer-events:none}
      .prs-month-bar{grid-row:1;z-index:5;align-self:start;margin:23px 4px 0;min-width:0;pointer-events:auto}
      .prs-month-bar .prs-work-chip{height:24px;min-height:24px;border-radius:8px;padding:2px 5px;font-size:10px}
      .prs-month-bar.continues-before .prs-work-chip{border-top-left-radius:3px;border-bottom-left-radius:3px;border-left-width:1px}
      .prs-month-bar.continues-after .prs-work-chip{border-top-right-radius:3px;border-bottom-right-radius:3px}
      .prs-month-bar.live-preview{z-index:8;pointer-events:none}
      .prs-month-day-peek{grid-row:1;align-self:start;z-index:6;height:82px;margin-top:23px;padding:0 4px;box-sizing:border-box;overflow:hidden;opacity:0;background:#fff;pointer-events:none;transition:height .28s cubic-bezier(.2,.75,.25,1),opacity .14s ease}
      .prs-month-day-peek.muted,.prs-month-day-peek.past{background:#f8fafc}
      .prs-month-day-peek.today{background:#fff8f7}
      .prs-month-day-peek.active{opacity:1}
      .prs-month-day-peek-track{transform:translateY(var(--prs-month-day-scroll-y,0px));transition:transform var(--prs-month-day-scroll-duration,220ms) cubic-bezier(.2,.75,.25,1);will-change:transform}
      .prs-month-week.expanded .prs-month-day-peek,.prs-month-week.collapsing .prs-month-day-peek{opacity:0;pointer-events:none}
      .prs-month-day-peek-item{height:24px;margin-bottom:4px}
      .prs-month-day-peek-item.is-gap{visibility:hidden}
      .prs-month-day-peek-item .prs-work-chip{height:24px;min-height:24px;border-radius:8px;padding:2px 5px;font-size:10px;box-shadow:0 6px 12px rgba(15,23,42,.10)}
      .prs-month-day-peek-chip.continues-from-previous-day{border-top-left-radius:3px;border-bottom-left-radius:3px;border-left-width:1px}
      .prs-month-day-peek-chip.continues-into-next-day{border-top-right-radius:3px;border-bottom-right-radius:3px}
      .prs-month-day-peek-item [data-prs-assignee]{pointer-events:auto}
      .prs-month-overflow{grid-row:1;align-self:end;justify-self:stretch;z-index:9;width:calc(100% - 8px);height:18px;max-width:none;margin:0 4px 2px;padding:0 5px;border:0;border-radius:6px;background:rgba(255,255,255,.92);color:#667085;font-size:9px;font-weight:1000;line-height:18px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;box-sizing:border-box;box-shadow:0 1px 4px rgba(15,23,42,.08);transition:color .16s ease,background .16s ease,opacity .2s ease,transform .2s ease;overflow-anchor:none}
      .prs-month-overflow:hover,.prs-month-overflow:focus-visible{background:#fff;color:var(--primary-readable,var(--primary,#d93025));outline:none;transform:translateY(-1px)}
      .prs-month-overflow-less{display:none}
      .prs-month-week.expanded .prs-month-overflow:not(.is-controller),.prs-month-week.collapsing .prs-month-overflow:not(.is-controller){opacity:0;pointer-events:none}
      .prs-month-week.expanded .prs-month-overflow.is-controller .prs-month-overflow-more{display:none}
      .prs-month-week.expanded .prs-month-overflow.is-controller .prs-month-overflow-less{display:inline}
      .prs-work-chip:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(15,23,42,.16)}
      .prs-work-chip.draft{border-style:dashed;color:#101828;opacity:.92}
      .prs-work-chip.draft.suspended{background:rgba(37,99,235,.10);border-color:rgba(37,99,235,.34);border-left-color:#2563eb;color:#1e3a8a;opacity:.82}
      .prs-work-chip.timed-month{background:#e8f1ff;border-color:rgba(37,99,235,.30);border-left-color:#2563eb;color:#1e3a8a}
      .prs-work-chip.timed-month .prs-time{color:#2563eb}
      .prs-work-chip.type-sales-appointment.timed-month,.prs-work-chip.type-sales-follow-up.timed-month{border-color:rgba(22,163,74,.42);border-left-color:#16a34a;background:#dcfce7;color:#14532d}
      .prs-work-chip.material-delivery.timed-month{border-color:color-mix(in srgb,var(--prs-material-main) 44%,transparent);background:color-mix(in srgb,var(--prs-material-main) 10%,white);color:#101828}
      .prs-work-chip.material-delivery.timed-month .prs-time{color:#475467}
      .prs-work-chip.preview{--prs-preview-color:var(--primary,#d93025);border-style:dashed;background-color:color-mix(in srgb,var(--prs-preview-color) 13%,white);background-image:repeating-linear-gradient(135deg,transparent 0 7px,color-mix(in srgb,var(--prs-preview-color) 10%,transparent) 7px 11px);border-color:color-mix(in srgb,var(--prs-preview-color) 54%,transparent);border-left-color:var(--prs-preview-color);outline:1px dashed color-mix(in srgb,var(--prs-preview-color) 58%,transparent);outline-offset:-2px;color:#101828;box-shadow:0 10px 22px color-mix(in srgb,var(--prs-preview-color) 16%,transparent);padding-right:58px!important;pointer-events:none;isolation:isolate}
      .prs-work-chip.preview::after{content:"PREVIEW";position:absolute;right:5px;top:5px;height:15px;display:inline-flex;align-items:center;border:1px solid color-mix(in srgb,var(--prs-preview-color) 48%,transparent);border-radius:5px;background:color-mix(in srgb,var(--prs-preview-color) 17%,white);color:color-mix(in srgb,var(--prs-preview-color) 78%,#101828);padding:0 4px;font-size:7px;font-weight:1000;line-height:1;letter-spacing:.06em;box-shadow:0 1px 2px rgba(15,23,42,.08)}
      .prs-month-bar .prs-work-chip.preview::after{top:4px;height:13px;font-size:6px;padding:0 3px}
      .prs-work-chip.dragging{opacity:.55;transform:scale(.99)}
      .prs-work-chip.schedule-locked{cursor:not-allowed;font-style:italic;box-shadow:0 8px 18px rgba(15,23,42,.10),inset 0 0 0 1px rgba(15,23,42,.06)}
      .prs-work-chip.schedule-locked:hover{transform:none;box-shadow:0 8px 18px rgba(15,23,42,.10),inset 0 0 0 1px rgba(15,23,42,.06)}
      .prs-work-chip.has-confirm{padding-right:54px}
      .prs-work-chip.no-start-handle{padding-left:8px}
      .prs-work-chip.no-end-handle{padding-right:8px}
      .prs-month-bar .prs-work-chip.no-start-handle{padding-left:6px}
      .prs-month-bar .prs-work-chip.no-end-handle{padding-right:6px}
      .prs-work-chip.timed{padding:6px 4px;min-height:30px}
      .prs-work-chip.timed.has-confirm{padding-right:9px;padding-bottom:34px}
      .prs-work-chip.timed.has-confirm.compact-confirm{padding-right:38px;padding-bottom:12px}
      .prs-chip-top{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,46%);gap:8px;align-items:center;min-width:0}
      .prs-work-chip.no-assignee .prs-chip-top{display:block}
      .prs-work-chip .prs-title{display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .prs-work-chip .prs-title .prs-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .prs-work-chip .prs-confirm-marker{flex:0 0 auto}
      .prs-work-chip.material-delivery .prs-title{display:flex;align-items:center;gap:5px}
      .prs-title-text{display:block;width:100%;max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .prs-material-marker{display:inline-flex;align-items:center;flex:0 0 auto;color:#475467;font-style:normal}
      .prs-material-marker i{font-size:9px;line-height:1}
      .prs-assignee{display:inline-flex;align-items:center;justify-self:end;gap:5px;max-width:100%;min-width:0;border:0;background:transparent;color:#344054;font-family:inherit;font-size:10px;font-weight:1000;white-space:nowrap;border-radius:8px;padding:2px 6px;cursor:pointer;user-select:none;box-sizing:border-box}
      .prs-assignee:hover{background:rgba(15,23,42,.08);color:#101828}
      .prs-assignee span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .prs-assignee:after{content:"";width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;opacity:.7;flex:0 0 auto}
      .prs-chip-bottom{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:3px;min-width:0;margin-top:2px}
      .prs-work-chip .prs-time{display:block;min-width:0;color:#475467;font-size:10px;font-weight:850;margin:0;padding:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-work-chip .prs-project-title,.prs-work-chip .prs-address{display:block;min-width:0;color:#475467;font-size:9px;font-weight:800;margin:0;padding:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-work-chip.timed .prs-chip-top{display:block}
      .prs-work-chip.timed .prs-title{padding-right:0}
      .prs-work-chip.timed .prs-time,.prs-work-chip.timed .prs-project-title,.prs-work-chip.timed .prs-address{padding-right:0}
      .prs-work-chip.timed .prs-assignee{display:flex;justify-self:stretch;width:max-content;max-width:calc(100% - 24px);margin-top:3px;padding-left:0}
      .prs-chip-view{position:absolute;right:19px;bottom:4px;width:22px;height:18px;color:#475467;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;z-index:24;line-height:1;border-radius:6px}
      .prs-chip-view:hover{background:rgba(255,255,255,.70);color:#101828}
      .prs-event-lock{position:static;z-index:26;width:14px;height:14px;border:0;border-radius:3px;background:transparent;color:#667085;display:flex;align-items:center;justify-content:center;justify-self:end;padding:0;cursor:pointer;font-size:8px;line-height:1;box-shadow:none}
      .prs-event-lock:hover{background:rgba(255,255,255,.72);color:#101828}
      .prs-event-lock.passive{pointer-events:none;box-shadow:none;background:rgba(255,255,255,.48)}
      .prs-chip-lock-only{position:absolute;right:3px;bottom:3px;display:flex}
      .prs-work-chip.has-lock-control.has-confirm{padding-right:38px}
      .prs-confirm{position:absolute;right:25px;top:50%;transform:translateY(-50%);width:22px;height:22px;border:0;border-radius:8px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:10px}
      .prs-work-chip.material-delivery .prs-confirm{background:var(--prs-material-main);color:#fff}
      .prs-work-chip.timed .prs-confirm{right:7px;top:auto;bottom:7px;transform:none}
      .prs-crew{display:block;color:#475467;font-size:10px;font-weight:900;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-crew.waiting{color:#92400e;font-style:italic}
      .prs-work-chip.awaiting-crew{background:#fff7ed;border-color:rgba(245,158,11,.36);border-left-color:#f59e0b;color:#78350f}
      .prs-work-chip.awaiting-crew .prs-time{color:#92400e}
      .prs-time-grid{display:grid;grid-template-columns:62px repeat(var(--prs-days,7),minmax(120px,1fr));min-width:920px;min-height:100%;align-content:start}
      .prs-time-grid.prs-time-header-grid{min-height:0;position:sticky;top:0;z-index:7;background:#f8fafc}
      .prs-time-head,.prs-day-head{height:40px;background:#f8fafc;border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:center;color:#344054;font-size:11px;font-weight:1000;position:sticky;top:0;z-index:7}
      .prs-day-head-mobile,.prs-all-day-label-mobile{display:none}
      .prs-all-day-grid{display:grid;grid-template-columns:62px repeat(var(--prs-days,7),minmax(120px,1fr));min-width:920px;background:#fff;border-bottom:1px solid rgba(15,23,42,.08);position:sticky;top:40px;z-index:6;min-height:58px}
      .prs-all-day-label-cell{grid-column:1;grid-row:1;background:#f8fafc;border-right:1px solid rgba(15,23,42,.08);color:#667085;font-size:9px;font-weight:1000;text-transform:uppercase;display:flex;align-items:center;justify-content:center;padding:6px;box-sizing:border-box}
      .prs-all-day-cell{min-height:58px;border-right:1px solid rgba(15,23,42,.06);background:#fff;box-sizing:border-box}
      .prs-all-day-cell.today{background:rgba(var(--primary-rgb,217,48,37),.018)}
      .prs-all-day-bar-top{z-index:7;align-self:start;margin:4px 3px 0;min-width:0}
      .prs-all-day-bar-top .prs-work-chip{height:42px;min-height:42px;border-radius:9px;padding-top:4px;padding-bottom:4px}
      .prs-all-day-grid.week-overflow{overflow:hidden;transition:height 300ms cubic-bezier(.22,.8,.24,1),min-height 300ms cubic-bezier(.22,.8,.24,1)}
      .prs-all-day-grid.week-overflow .prs-all-day-bar-top{transition:transform var(--prs-week-all-day-scroll-duration,180ms) cubic-bezier(.22,.8,.24,1);transform:translateY(var(--prs-week-all-day-scroll-y,0px))}
      .prs-all-day-grid.week-overflow.expanded .prs-all-day-bar-top{transform:translateY(0)}
      .prs-all-day-grid.week-overflow .prs-all-day-bar-top .prs-work-chip{height:24px;min-height:24px;border-radius:8px;padding:2px 5px;font-size:10px}
      .prs-all-day-grid.week-overflow .prs-all-day-bar-top .prs-chip-bottom{display:none}
      .prs-all-day-grid.week-overflow .prs-all-day-bar-top.continues-before .prs-work-chip{border-top-left-radius:0;border-bottom-left-radius:0}
      .prs-all-day-grid.week-overflow .prs-all-day-bar-top.continues-after .prs-work-chip{border-top-right-radius:0;border-bottom-right-radius:0}
      .prs-week-all-day-overflow{position:relative;grid-row:1;align-self:end;justify-self:stretch;z-index:10;height:14px;margin:0 1px;padding:0 3px;border:0;border-radius:0;background:#fff;box-shadow:none;color:#667085;font-family:inherit;font-size:8px;font-weight:1000;line-height:14px;cursor:pointer;text-align:left;white-space:nowrap;overflow:visible;text-overflow:clip}
      .prs-week-all-day-overflow:before{content:"";position:absolute;left:0;right:0;top:-10px;height:10px;background:linear-gradient(180deg,rgba(255,255,255,0),#fff);pointer-events:none}
      .prs-week-all-day-overflow span{position:relative;z-index:1;display:block;overflow:hidden;text-overflow:ellipsis}
      .prs-week-all-day-overflow:hover,.prs-week-all-day-overflow:focus-visible{background:#fff;color:#101828;outline:none;text-decoration:underline}
      .prs-week-all-day-overflow-less{display:none}
      .prs-all-day-grid.week-overflow.expanded .prs-week-all-day-overflow.is-controller .prs-week-all-day-overflow-more{display:none}
      .prs-all-day-grid.week-overflow.expanded .prs-week-all-day-overflow.is-controller .prs-week-all-day-overflow-less{display:inline}
      .prs-day-head.past{background:#f1f5f9;color:#94a3b8}
      .prs-day-head.today{background:rgba(var(--primary-rgb,217,48,37),.045);color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -1px 0 rgba(var(--primary-rgb,217,48,37),.32)}
      .prs-time-label{height:54px;border-right:1px solid rgba(15,23,42,.08);border-bottom:1px solid rgba(15,23,42,.045);background:#f8fafc;color:#667085;font-size:10px;font-weight:900;display:flex;align-items:flex-start;justify-content:center;padding-top:5px;box-sizing:border-box}
      .prs-slot{position:relative;height:54px;border-right:1px solid rgba(15,23,42,.045);border-bottom:1px solid rgba(15,23,42,.045);background:#fff;cursor:crosshair}.prs-slot.has-chip{z-index:4}
      .prs-slot.past{background:#f8fafc;color:#94a3b8}
      .prs-slot.today{background:rgba(var(--primary-rgb,217,48,37),.018)}
      .prs-wrap.readonly .prs-slot{cursor:default}
      .prs-slot.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-slot.drag-over{box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.32)}
      .prs-slot .prs-work-chip{position:absolute;left:0;right:20px;top:3px;width:auto;z-index:3}
      .prs-resource-scroll{flex:1;min-height:0;overflow:auto;border:1px solid rgba(15,23,42,.04);border-radius:18px;background:linear-gradient(to right,#f8fafc 0 150px,#eef2f6 150px 100%);box-shadow:0 14px 34px rgba(15,23,42,.05);touch-action:none}
      .prs-resource-grid{display:grid;grid-template-columns:150px repeat(var(--prs-days,56),minmax(86px,1fr));grid-template-rows:38px repeat(var(--prs-resources,1),56px);min-width:calc(150px + var(--prs-days,56) * 86px);min-height:100%;position:relative;isolation:isolate;background:#eef2f6}
      .prs-resource-grid:before,.prs-resource-time-grid:before{content:"";position:sticky;left:0;grid-column:1;grid-row:1/-1;background:#f8fafc;border-right:1px solid rgba(15,23,42,.08);z-index:1;min-height:100%}
      .prs-resource-corner,.prs-resource-day-head,.prs-resource-label,.prs-resource-cell{border-right:1px solid rgba(15,23,42,.06);border-bottom:1px solid rgba(15,23,42,.06);box-sizing:border-box}
      .prs-resource-corner,.prs-resource-day-head{position:sticky;top:0;z-index:7;background:#f8fafc}
      .prs-resource-corner{left:0;z-index:8;display:flex;align-items:center;padding:0 6px;font-size:11px;font-weight:1000;color:#344054}
      .prs-resource-day-head{height:38px;display:flex;align-items:center;justify-content:center;flex-direction:column;font-size:10px;font-weight:1000;color:#475467}
      .prs-resource-day-head.weekend,.prs-resource-cell.weekend{background:#f8fafc}
      .prs-resource-day-head.past{background:#f1f5f9;color:#94a3b8}
      .prs-resource-day-head.today{background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -2px 0 var(--primary,#d93025)}
      .prs-resource-day-head.today span:last-child:after{content:"Today";display:inline-flex;margin-left:5px;border-radius:999px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:1px 5px;font-size:8px;font-weight:1000;vertical-align:middle}
      .prs-resource-label{position:sticky;left:0;z-index:10;background:#f8fafc;padding:5px 6px;display:flex;flex-direction:column;justify-content:center;font-size:11px;font-weight:1000;color:#101828;overflow:hidden;border-bottom:0}
      .prs-resource-label small{font-size:10px;font-weight:850;color:#667085;margin-top:3px}
      .prs-resource-label.unassigned{background:#f8fafc;color:#475467}
      .prs-work-chip.unassigned-item{border-style:dashed;border-color:#98a2b3;background:#f8fafc;color:#475467;font-style:italic;box-shadow:0 6px 14px rgba(15,23,42,.08)}
      .prs-work-chip.unassigned-item .prs-time,.prs-work-chip.unassigned-item .prs-project-title{font-style:italic}
      .psv-resource-label-main{display:flex;align-items:center;justify-content:space-between;gap:5px;min-width:0;width:100%}
      .psv-resource-label-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .psv-resource-settings-btn{width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto;font-size:12px;padding:0}
      .psv-resource-settings-btn:hover,.psv-resource-settings-btn:focus-visible{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));outline:none}
      .psv-resource-settings-btn:focus-visible{box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.18)}
      .prs-resource-cell{background:#fff;cursor:crosshair}
      .prs-resource-cell{position:relative}
      .prs-resource-cell.past{background:#f8fafc}
      .prs-resource-cell.today{background:rgba(var(--primary-rgb,217,48,37),.035)}
      .prs-resource-cell.in-range{background:rgba(var(--primary-rgb,217,48,37),.06)}
      .prs-resource-cell.weekend.in-range{background:rgba(var(--primary-rgb,217,48,37),.09)}
      .prs-resource-bar{z-index:4;align-self:start;margin:var(--prs-bar-top,3px) 3px 0;min-width:0}
      .prs-resource-bar .prs-work-chip{height:46px;min-height:46px;border-radius:12px;padding-top:4px;padding-bottom:4px}
      .prs-resource-bar .prs-work-chip.compact-resource-item,.prs-resource-time-bar .prs-work-chip.compact-resource-item{height:24px;min-height:24px;border-radius:7px;padding:2px 6px;font-size:10px;box-shadow:0 6px 12px rgba(15,23,42,.10)}
      .prs-resource-bar.live-preview{z-index:9;pointer-events:none}
      .prs-resource-time-grid{display:grid;grid-template-columns:150px repeat(var(--prs-slots,24),minmax(60px,1fr));grid-template-rows:40px repeat(var(--prs-resources,1),72px);min-width:calc(150px + var(--prs-slots,24) * 60px);min-height:100%;position:relative;isolation:isolate;background:#eef2f6}
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
      .prs-resource-all-day-bar.material-delivery{--prs-material-main:#64748b;border-color:color-mix(in srgb,var(--prs-material-main) 44%,transparent);border-left-width:1px;background:color-mix(in srgb,var(--prs-material-main) 10%,white)}
      .prs-resource-all-day-bar.material-delivery.material-unordered{border-style:dotted;border-width:2px}
      .prs-resource-all-day-bar.material-delivery.material-ordered{border-style:solid}
      .prs-resource-all-day-bar.schedule-locked{box-shadow:0 5px 12px rgba(15,23,42,.05),inset 0 0 0 1px rgba(15,23,42,.06)}
      .prs-resource-all-day-label{z-index:6;align-self:start;position:sticky;left:150px;margin:6px 0 0 8px;width:max-content;max-width:min(420px,calc(100vw - 270px));height:22px;pointer-events:none;color:#334155}
      .prs-all-day-chip{--prs-material-main:#0f766e;position:relative;width:max-content;max-width:100%;height:22px;display:flex;align-items:center;gap:7px;min-width:0;padding:0 6px 0 10px;box-sizing:border-box;font-size:11px;font-weight:950}
      .prs-all-day-chip strong{flex:0 0 auto;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
      .prs-all-day-chip .prs-all-day-title{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .prs-all-day-chip.material-delivery{color:#101828}
      .prs-all-day-chip.schedule-locked{font-style:italic}
      .prs-all-day-chip.has-lock-control{padding-right:30px}
      .prs-all-day-chip .prs-all-day-material-marker{display:inline-flex;align-items:center;flex:0 0 auto;color:#475467;font-style:normal}
      .prs-all-day-chip .prs-all-day-material-marker i{font-size:9px;line-height:1}
      .prs-all-day-chip .prs-event-lock{position:absolute;right:2px;top:2px;width:18px;height:18px;font-size:8px;pointer-events:auto}
      .prs-resource-time-bar{z-index:4;align-self:start;margin:var(--prs-bar-top,3px) 3px 0;min-width:0}
      .prs-resource-time-bar.has-travel{margin-right:0}
      .prs-resource-time-bar.travel-destination{margin-left:0}
      .prs-resource-time-bar .prs-work-chip{height:36px;min-height:36px;border-radius:9px;padding-top:2px;padding-bottom:2px}
      .prs-resource-time-bar .prs-work-chip.travel-origin{border-top-right-radius:0;border-bottom-right-radius:0}
      .prs-resource-time-bar .prs-work-chip.travel-destination{border-top-left-radius:0;border-bottom-left-radius:0}
      .prs-resource-time-bar.live-preview{z-index:9;pointer-events:none}
      .psv-resource-label-actions{display:inline-flex;align-items:center;gap:2px;flex:0 0 auto}
      .psv-availability-toggle.active{color:#b42318;background:rgba(180,35,24,.08)}
      .prs-resource-label.unavailable-day{color:#98a2b3}
      .prs-resource-label.unavailable-day .psv-resource-label-name{text-decoration:line-through;text-decoration-thickness:1px}
      .prs-resource-time-grid .prs-resource-time-cell.unavailable-day{background:#f1f5f9;cursor:not-allowed}
      .prs-resource-time-cell.unavailable-day:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(100,116,139,.06) 0,rgba(100,116,139,.06) 6px,transparent 6px,transparent 12px);pointer-events:none}
      .prs-resource-label.unavailable-day small{display:block;margin-top:2px;color:#b42318;font-size:9px;font-weight:900;font-style:italic;letter-spacing:.02em}
      .prs-resource-time-bar .prs-work-chip.needs-reschedule{background:#fee2e2;border-color:#fca5a5;border-left-color:#ef4444;color:#b42318;font-style:italic}
      .prs-resource-time-bar .prs-work-chip.needs-reschedule .prs-project-title,.prs-resource-time-bar .prs-work-chip.needs-reschedule .prs-time{color:#b42318}
      .prs-empty{border:1px dashed rgba(15,23,42,.18);border-radius:16px;background:#fff;padding:22px;text-align:center;color:#667085;font-weight:850}
      .prs-list{flex:1;min-height:0;overflow:auto;display:grid;align-content:start;gap:16px;padding:2px}
      .prs-list-section{display:grid;gap:8px}.prs-list-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 2px}.prs-list-section-head strong{font-size:12px;font-weight:1000;color:#344054;text-transform:uppercase;letter-spacing:.06em}.prs-list-section-head span{font-size:10px;font-weight:900;color:#98a2b3}
      .prs-list-items{display:grid;gap:8px}.prs-list-item{--prs-list-color:#64748b;width:100%;display:grid;grid-template-columns:62px minmax(0,1fr) auto;align-items:center;gap:12px;border:1px solid rgba(15,23,42,.09);border-left:4px solid var(--prs-list-color);border-radius:14px;background:#fff;color:#101828;padding:11px 12px;text-align:left;cursor:pointer;box-shadow:0 6px 18px rgba(15,23,42,.04)}.prs-list-item:hover{border-color:rgba(15,23,42,.18);transform:translateY(-1px);box-shadow:0 10px 24px rgba(15,23,42,.08)}.prs-list-date{display:grid;justify-items:center;gap:1px;border-right:1px solid rgba(15,23,42,.08);padding-right:10px;color:#667085}.prs-list-date strong{font-size:18px;line-height:1;font-weight:1000;color:#101828}.prs-list-date span{font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.prs-list-copy{min-width:0}.prs-list-copy strong,.prs-list-copy span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.prs-list-copy strong{font-size:12px;font-weight:1000}.prs-list-copy span{margin-top:3px;color:#667085;font-size:10px;font-weight:850}.prs-list-meta{text-align:right;color:#475467;font-size:10px;font-weight:900;white-space:nowrap}.prs-list-meta span{display:block}.prs-list-meta small{display:block;margin-top:3px;color:#98a2b3;font-size:9px}
      .psv-wrap.no-toolbar,.prs-wrap.no-toolbar{gap:0;min-height:0}
      .psv-wrap.no-toolbar .psv-surface,.prs-wrap.no-toolbar .prs-surface,.prs-wrap.no-toolbar .prs-resource-scroll{border:0;border-radius:0;box-shadow:none}
      .prs-mobile-toolbar{display:none}
      @media(max-width:720px){
        .prs-mobile-toolbar{position:relative;z-index:40;display:flex;align-items:center;gap:2px;height:50px;padding:0 6px;background:#fff;box-sizing:border-box;white-space:nowrap}.prs-mobile-menu{position:relative;flex:0 0 auto}.prs-mobile-control{height:34px;border:0;border-radius:8px;background:transparent;color:#344054;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer}.prs-mobile-control:hover,.prs-mobile-control[aria-expanded="true"]{background:#f2f4f7}.prs-mobile-control.view{width:34px;padding:0;font-size:13px}.prs-mobile-control.view .fa-chevron-down{font-size:8px;margin-left:1px}.prs-mobile-control.month{width:112px;max-width:112px;overflow:hidden;text-overflow:ellipsis}.prs-mobile-control.month span{overflow:hidden;text-overflow:ellipsis}.prs-mobile-control.today{width:32px;padding:0;margin-left:auto;color:#475467}.prs-mobile-control.nav{width:25px;padding:0;font-size:10px}.prs-mobile-today-date{width:19px;height:20px;border:1.5px solid currentColor;border-radius:3px;display:grid;place-items:center;padding-top:5px;box-sizing:border-box;font-size:9px;line-height:1;font-weight:1000;position:relative}.prs-mobile-today-date:before{content:"";position:absolute;left:-1.5px;right:-1.5px;top:4px;border-top:1.5px solid currentColor}.prs-mobile-popover{position:absolute;top:calc(100% + 6px);left:0;width:190px;max-height:min(420px,calc(100vh - 70px));overflow:auto;padding:6px;border:1px solid rgba(15,23,42,.10);border-radius:12px;background:#fff;box-shadow:0 18px 45px rgba(15,23,42,.18);box-sizing:border-box}.prs-mobile-popover.months{width:min(334px,calc(100vw - 16px));padding:10px}.prs-mobile-month-picker{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:280px}.prs-mobile-month-picker section{min-width:0;overflow:auto;border:1px solid rgba(15,23,42,.08);border-radius:9px;padding:3px}.prs-mobile-month-picker button{height:31px;font-size:11px}.prs-mobile-popover button{width:100%;height:36px;border:0;border-radius:8px;background:transparent;color:#344054;display:flex;align-items:center;gap:10px;padding:0 9px;font:inherit;font-size:12px;font-weight:950;text-align:left;cursor:pointer}.prs-mobile-popover button:hover,.prs-mobile-popover button.active{background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025))}.prs-mobile-popover button i{width:15px;text-align:center}
        .prs-wrap.mobile-layout{min-height:0;gap:8px}.prs-wrap.mobile-layout .prs-toolbar{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:0 2px}.prs-wrap.mobile-layout .prs-nav{display:grid;grid-template-columns:34px 58px 34px minmax(0,1fr);gap:5px}.prs-wrap.mobile-layout.list-mode .prs-nav{display:block}.prs-wrap.mobile-layout .prs-range{min-width:0;font-size:12px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;align-self:center}.prs-wrap.mobile-layout .prs-view-switch{width:100%;box-sizing:border-box;overflow-x:auto;overscroll-behavior-x:contain}.prs-wrap.mobile-layout .prs-view-btn{flex:1 0 auto;min-width:54px;padding:0 7px;font-size:10px}.prs-wrap.mobile-layout .prs-surface{border:0;border-radius:0;box-shadow:none}
        .prs-wrap.mobile-layout .prs-month,.prs-wrap.mobile-layout .prs-month-head-row,.prs-wrap.mobile-layout .prs-month-week,.prs-wrap.mobile-layout .prs-month-item-track{min-width:100%!important;grid-template-columns:repeat(7,minmax(0,1fr))!important}.prs-wrap.mobile-layout .prs-month-head-row{height:28px}.prs-wrap.mobile-layout .prs-month-head{height:28px;font-size:9px}.prs-wrap.mobile-layout .prs-month-week{min-height:max(84px,calc((100dvh - 220px) / 6));flex-basis:max(84px,calc((100dvh - 220px) / 6))}.prs-wrap.mobile-layout .prs-month-week .prs-day{min-height:84px;padding:2px}.prs-wrap.mobile-layout .prs-day-num{font-size:10px;line-height:15px;margin-bottom:0}.prs-wrap.mobile-layout .prs-month-item-viewport{height:calc(100% - 17px)}.prs-wrap.mobile-layout .prs-month-bar{margin:17px 1px 0}.prs-wrap.mobile-layout .prs-month-bar .prs-work-chip,.prs-wrap.mobile-layout .prs-month-day-peek-item .prs-work-chip{height:18px;min-height:18px;border-left-width:2px;border-radius:4px;padding:1px 2px;font-size:7px;line-height:1.1;box-shadow:none}.prs-wrap.mobile-layout .prs-month-bar .prs-chip-bottom,.prs-wrap.mobile-layout .prs-month-bar .prs-assignee,.prs-wrap.mobile-layout .prs-month-bar .prs-work-chip:after{display:none}
        .prs-wrap.mobile-layout .prs-surface{width:100%;max-width:100%;overflow-x:hidden!important;touch-action:none;overscroll-behavior:contain}.prs-wrap.mobile-layout .prs-time-grid,.prs-wrap.mobile-layout .prs-all-day-grid{width:100%!important;max-width:100%!important;box-sizing:border-box;grid-template-columns:40px repeat(var(--prs-days),minmax(0,1fr));min-width:100%!important}.prs-wrap.mobile-layout .prs-time-head,.prs-wrap.mobile-layout .prs-day-head,.prs-wrap.mobile-layout .prs-all-day-cell{min-width:0;overflow:hidden}.prs-wrap.mobile-layout .prs-slot{min-width:0;overflow:visible;z-index:1}.prs-wrap.mobile-layout .prs-slot.has-chip{z-index:4}.prs-wrap.mobile-layout .prs-slot .prs-work-chip{z-index:4}.prs-wrap.mobile-layout .prs-time-grid.prs-time-header-grid{height:48px}.prs-wrap.mobile-layout .prs-time-head,.prs-wrap.mobile-layout .prs-day-head{height:48px;font-size:10px;line-height:1.1}.prs-wrap.mobile-layout .prs-day-head{flex-direction:column;gap:2px}.prs-wrap.mobile-layout .prs-day-head-desktop{display:none}.prs-wrap.mobile-layout .prs-day-head-mobile{display:flex;flex-direction:column;align-items:center;line-height:1.05}.prs-wrap.mobile-layout .prs-day-head-mobile strong{font-size:12px;color:#101828}.prs-wrap.mobile-layout .prs-all-day-grid{top:48px;min-height:48px!important;height:48px!important;grid-template-rows:48px!important}.prs-wrap.mobile-layout .prs-all-day-label-cell{font-size:8px;line-height:1.05;text-align:center;text-transform:uppercase;padding:3px}.prs-wrap.mobile-layout .prs-all-day-label-desktop{display:none}.prs-wrap.mobile-layout .prs-all-day-label-mobile{display:block}.prs-wrap.mobile-layout .prs-time-label{font-size:8px}.prs-wrap.mobile-layout .prs-work-chip{font-size:9px}.prs-wrap.mobile-layout .prs-list{padding:1px}.prs-wrap.mobile-layout .prs-list-item{grid-template-columns:48px minmax(0,1fr);gap:9px;padding:10px}.prs-wrap.mobile-layout .prs-list-date{padding-right:7px}.prs-wrap.mobile-layout .prs-list-date strong{font-size:16px}.prs-wrap.mobile-layout .prs-list-meta{grid-column:2;text-align:left;display:flex;gap:6px;align-items:center}.prs-wrap.mobile-layout .prs-list-meta span,.prs-wrap.mobile-layout .prs-list-meta small{display:inline;margin:0}
        .prs-wrap.mobile-layout .prs-slot .prs-work-chip[data-prs-mode="week"]{left:1px;right:1px;border-left-width:2px;border-radius:6px;font-size:7px;line-height:1.08;box-shadow:0 4px 9px rgba(15,23,42,.10)}
        .prs-wrap.mobile-layout .prs-slot .prs-work-chip[data-prs-mode="week"]:not(.has-confirm){padding:3px 2px}
        .prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-title,.prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-title-text{white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
        .prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-title-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden}
        .prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-chip-bottom{margin-top:1px}
        .prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-project-title,.prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-time{font-size:6px;line-height:1.05}
        .prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-assignee,.prs-wrap.mobile-layout .prs-work-chip[data-prs-mode="week"] .prs-chip-view{display:none}
      }
      .prs-resource-travel{position:relative;left:auto;top:auto;z-index:3;align-self:start;justify-self:start;margin:var(--prs-bar-top,3px) 0 0;width:var(--prs-travel-width,100%);height:36px;display:flex;align-items:center;justify-content:center;gap:4px;border:1px solid #cbd5e1;border-left:0;border-radius:0 9px 9px 0;color:#475467;padding:0 4px;font-size:11px;font-weight:1000;background:#e2e8f0;pointer-events:none;box-sizing:border-box;overflow:hidden;white-space:nowrap}
      .prs-resource-travel.bridge{border-radius:0;border-right:0}
      .prs-resource-travel.insufficient{border-color:#f87171;color:#b42318;background:#fee2e2}
      .prs-resource-travel.pending{visibility:hidden}
      .psv-gantt-wrap{display:flex;flex-direction:column;gap:10px;min-height:0;height:100%;--psv-gantt-left:248px}
      .psv-gantt-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .psv-gantt-toolbar .psv-pill{margin-right:auto}
      .psv-gantt-zoom{display:flex;align-items:center;gap:4px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#fff;padding:3px}
      .psv-gantt-zoom-btn{height:28px;border:0;border-radius:7px;background:transparent;color:#475467;padding:0 10px;font:inherit;font-size:11px;font-weight:1000;cursor:pointer}
      .psv-gantt-zoom-btn:hover{background:#f2f4f7}
      .psv-gantt-zoom-btn.active{background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
      .psv-gantt-slider{width:132px;accent-color:var(--primary,#d93025)}
      .psv-gantt-today-btn{height:34px;border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#fff;color:#344054;padding:0 12px;font:inherit;font-size:11px;font-weight:1000;cursor:pointer}
      .psv-gantt-today-btn:hover{background:#f2f4f7}
      .psv-gantt-scroll{flex:1;min-height:0;overflow:auto;border:1px solid rgba(15,23,42,.09);border-radius:14px;background:#fff;position:relative;overscroll-behavior:contain}
      .psv-gantt-inner{position:relative;width:max-content;min-width:100%}
      .psv-gantt-head{position:sticky;top:0;z-index:20;display:flex;background:#fff;border-bottom:1px solid rgba(15,23,42,.10)}
      .psv-gantt-corner{position:sticky;left:0;z-index:21;flex:0 0 var(--psv-gantt-left);width:var(--psv-gantt-left);background:#fff;border-right:1px solid rgba(15,23,42,.10);display:flex;align-items:end;padding:0 10px 6px;box-sizing:border-box;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3}
      .psv-gantt-ticks{position:relative;height:46px;flex:0 0 auto}
      .psv-gantt-tick-major{position:absolute;top:3px;height:18px;font-size:10px;font-weight:1000;color:#475467;white-space:nowrap;padding-left:6px;border-left:1px solid rgba(15,23,42,.10);box-sizing:border-box;overflow:hidden}
      .psv-gantt-tick-minor{position:absolute;bottom:0;height:24px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;color:#98a2b3;border-left:1px solid rgba(15,23,42,.06);box-sizing:border-box;overflow:hidden}
      .psv-gantt-tick-minor.weekend{background:rgba(15,23,42,.035)}
      .psv-gantt-body{position:relative}
      .psv-gantt-row{display:flex;height:32px;border-bottom:1px solid rgba(15,23,42,.05);box-sizing:border-box}
      .psv-gantt-row.section{height:28px;background:#f8fafc}
      .psv-gantt-row.project-row{height:36px;background:#f8fafc;border-top:1px solid rgba(15,23,42,.10)}
      .psv-gantt-row.project-row .psv-gantt-label{background:#f8fafc}
      .psv-gantt-row.add-row{height:20px;border:0;background:#fff}
      .psv-gantt-row.add-row .psv-gantt-label{justify-content:center;gap:4px;background:#fff;border-right-color:rgba(15,23,42,.06)}
      .psv-gantt-add{width:22px;height:16px;border:1px solid rgba(15,23,42,.12);border-radius:999px;background:#fff;color:#667085;display:grid;place-items:center;padding:0;font-size:8px;cursor:pointer;opacity:.72}
      .psv-gantt-add:hover,.psv-gantt-add:focus-visible{opacity:1;border-color:var(--primary,#d93025);color:var(--primary,#d93025);outline:none;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}
      .psv-gantt-label{position:sticky;left:0;z-index:12;flex:0 0 var(--psv-gantt-left);width:var(--psv-gantt-left);display:flex;align-items:center;gap:7px;padding:0 10px;background:#fff;border-right:1px solid rgba(15,23,42,.10);box-sizing:border-box;min-width:0}
      .psv-gantt-row.section .psv-gantt-label{background:#f8fafc;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
      .psv-gantt-row.group-row .psv-gantt-label{font-weight:1000}
      .psv-gantt-label .psv-gantt-caret{flex:0 0 auto;width:20px;height:20px;border:0;border-radius:6px;background:transparent;color:#667085;display:grid;place-items:center;font-size:9px;cursor:pointer;padding:0}
      .psv-gantt-label .psv-gantt-caret:hover{background:#f2f4f7}
      .psv-gantt-label .psv-gantt-dot{flex:0 0 auto;width:10px;height:10px;border-radius:4px;background:var(--psv-gantt-color,#64748b);display:grid;place-items:center;color:#fff;font-size:6px}
      .psv-gantt-label .psv-gantt-dot i{font-size:6px;line-height:1}
      .psv-gantt-label-title{min-width:0;font-size:12px;font-weight:900;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
      .psv-gantt-label-title:hover{text-decoration:underline}
      .psv-gantt-label-meta{flex:0 0 auto;margin-left:auto;font-size:9px;font-weight:900;color:#98a2b3;white-space:nowrap;max-width:90px;overflow:hidden;text-overflow:ellipsis}
      .psv-gantt-label.child{padding-left:22px}
      .psv-gantt-label.grandchild{padding-left:38px}
      .psv-gantt-lane{position:relative;flex:0 0 auto;box-sizing:border-box}
      .psv-gantt-lane.unscheduled-lane{cursor:copy}
      .psv-gantt-lane.unscheduled-lane:hover:after{content:'Drag to schedule';position:sticky;left:calc(var(--psv-gantt-left) + 14px);display:inline-block;margin-top:11px;font-size:9px;font-weight:1000;color:#98a2b3;text-transform:uppercase;letter-spacing:.05em;pointer-events:none}
      .psv-gantt-bar{position:absolute;top:5px;height:22px;border-radius:7px;display:flex;align-items:center;gap:6px;padding:0 8px;font-size:10px;font-weight:950;color:#fff;box-sizing:border-box;cursor:grab;overflow:visible;white-space:nowrap;box-shadow:0 3px 8px rgba(15,23,42,.16);background:var(--psv-gantt-color,#2563eb);touch-action:none}
      .psv-gantt-bar .psv-gantt-bar-inner{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}
      .psv-gantt-bar .psv-gantt-bar-inner i{flex:0 0 auto;font-size:10px}
      .psv-gantt-bar .psv-gantt-bar-inner span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .psv-gantt-bar.dragging{opacity:.85;cursor:grabbing;z-index:15}
      .psv-gantt-bar.overlap{outline:2px solid #ef4444;outline-offset:1px;box-shadow:0 4px 12px rgba(239,68,68,.4)}
      .psv-gantt-bar.downtime{background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.28) 0 6px,transparent 6px 12px);filter:saturate(.65)}
      .psv-gantt-bar.locked{cursor:not-allowed;filter:saturate(.55)}
      .psv-gantt-bar.locked:after{content:'\\f023';font-family:'Font Awesome 6 Free','Font Awesome 5 Free';font-weight:900;font-size:9px;margin-left:4px}
      .psv-gantt-bar.ghost{opacity:.45;pointer-events:none;box-shadow:none}
      .psv-gantt-bar.group-bar{top:11px;height:10px;border-radius:3px;padding:0;background:var(--psv-gantt-color,#334155);cursor:grab;box-shadow:none}
      .psv-gantt-row.project-row .psv-gantt-bar.group-bar{top:12px;height:11px}
      .psv-gantt-bar.group-bar.derived{cursor:default}
      .psv-gantt-bar.group-bar:before,.psv-gantt-bar.group-bar:after{content:'';position:absolute;top:0;width:0;height:0;border:6px solid transparent;border-top-color:var(--psv-gantt-color,#334155)}
      .psv-gantt-bar.group-bar:before{left:0;transform:translateY(11px)}
      .psv-gantt-bar.group-bar:after{right:0;transform:translateY(11px)}
      .psv-gantt-handle{position:absolute;top:0;bottom:0;width:8px;cursor:ew-resize;z-index:3}
      .psv-gantt-handle.start{left:-2px}
      .psv-gantt-handle.end{right:-2px}
      .psv-gantt-link-handle{position:absolute;right:-8px;top:50%;transform:translateY(-50%);width:13px;height:13px;border-radius:50%;border:2px solid #fff;background:var(--primary,#d93025);opacity:0;cursor:crosshair;z-index:4;box-sizing:border-box;touch-action:none}
      .psv-gantt-bar:hover .psv-gantt-link-handle{opacity:1}
      .psv-gantt-links{position:absolute;z-index:7;overflow:visible}
      .psv-gantt-links path.psv-gantt-link{fill:none;stroke:#94a3b8;stroke-width:1.6;pointer-events:stroke;cursor:pointer}
      .psv-gantt-links path.psv-gantt-link:hover{stroke:var(--primary,#d93025);stroke-width:2.2}
      .psv-gantt-links path.psv-gantt-link-temp{fill:none;stroke:var(--primary,#d93025);stroke-width:1.8;stroke-dasharray:4 3;pointer-events:none}
      .psv-gantt-today{position:absolute;top:0;bottom:0;width:0;border-left:2px solid rgba(217,48,37,.55);z-index:6;pointer-events:none}
      .psv-gantt-empty{padding:26px;text-align:center;color:#667085;font-weight:850;font-size:12px}
      @media(max-width:720px){.psv-gantt-wrap{--psv-gantt-left:150px}.psv-gantt-label-meta{display:none}.psv-gantt-slider{width:90px}}
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

  function apptHtml({ event, project, Scheduling, slotMinutes, draft = false, moving = false, selected = false, confirmable = false, menuHtml = '', stackIndex = 0, foreign = false, slotOffset = 0 }){
    const start = eventStart(Scheduling, event);
    const title = appointmentTitle(project, event);
    const address = event.project_address || project?.address || '';
    const span = Math.max(1, Math.ceil((Number(event.duration_minutes) || 60) / Math.max(1, Number(slotMinutes) || 30)));
    return `<div class="psv-appt ${draft ? 'draft' : ''} ${moving ? 'moving' : ''} ${selected ? 'open' : ''} ${confirmable ? 'has-confirm' : ''} ${foreign ? 'foreign' : ''}" style="--span:${span};--stack-index:${Math.max(0, Number(stackIndex) || 0)};--slot-offset:${Math.max(0, Math.min(0.999, Number(slotOffset) || 0))}" data-psv-event-id="${esc(event.id || '')}" data-psv-project-id="${esc(event.project_id || project?.id || '')}"><span class="psv-appt-title">${esc(title)}</span><div class="psv-appt-address">${esc(address)}</div>${confirmable ? `<span class="psv-draft-confirm" data-psv-draft-confirm role="button" tabindex="0" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_e36c5a08a12e11","Confirm and save appointment") ?? "Confirm and save appointment")}"><i class="fas fa-check"></i></span>` : ''}${selected ? menuHtml : ''}</div>`;
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

  function bindDraftConfirm(control, draft, onConfirm){
    if (!control || typeof onConfirm !== 'function') return;
    const confirm = (event) => {
      if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (control.classList.contains('saving')) return;
      control.classList.add('saving');
      control.setAttribute('aria-busy', 'true');
      const icon = control.querySelector('i');
      if (icon) icon.className = 'fas fa-spinner fa-spin';
      let result;
      try {
        result = onConfirm(typeof draft === 'function' ? draft() : draft);
      } catch (error) {
        control.classList.remove('saving');
        control.removeAttribute('aria-busy');
        if (icon) icon.className = 'fas fa-check';
        throw error;
      }
      const reset = () => {
        if (!control.isConnected) return;
        control.classList.remove('saving');
        control.removeAttribute('aria-busy');
        if (icon) icon.className = 'fas fa-check';
      };
      Promise.resolve(result).then(reset, reset);
    };
    control.addEventListener('click', confirm);
    control.addEventListener('keydown', confirm);
  }

  function resourceLabelHtml({ className = '', rowIndex = 0, name = '', sublabel = '', style = '', actionAttr = '', actionLabel = 'Settings', actionIcon = 'fa-gear', actionsHtml = '' } = {}){
    const css = [`grid-row:${rowIndex + 2}`, 'grid-column:1', style].filter(Boolean).join(';');
    const action = actionAttr ? `<button type="button" class="psv-resource-settings-btn" ${actionAttr} aria-label="${esc(actionLabel)}" title="${esc(actionLabel)}"><i class="fas ${esc(actionIcon)}"></i></button>` : '';
    return `<div class="${className}" style="${css}"><div class="psv-resource-label-main"><span class="psv-resource-label-name">${esc(name)}</span><span class="psv-resource-label-actions">${actionsHtml}${action}</span></div>${sublabel ? `<small>${esc(sublabel)}</small>` : ''}</div>`;
  }
  function resourceActionPresentation(resource = {}){
    const subjectType = clean(resource.subject_type || resource.resource_kind || resource.kind).toLowerCase();
    const groupKindId = clean(resource.group_kind_id || resource.kind_id).toLowerCase();
    const name = clean(resource.name || resource.label || resource.email || 'resource');
    if (subjectType === 'organization_user') {
      return { label:((v0) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_19249f53fdf270",`Open user profile for ${v0}`,{v0}) ?? `Open user profile for ${v0}`)(name), icon:'fa-user' };
    }
    const configuredIcon = safeIconClass(
      resource.icon
      || resource.group_kind_icon
      || resource.kind_icon
      || resource.group_kind?.icon
      || resource.metadata?.icon
      || resource.attributes?.icon,
      ''
    );
    if (subjectType === 'resource_group') {
      const groupLabel = clean(resource.group_kind_name || resource.kind_name || resource.group_kind?.name || 'group').toLowerCase();
      return {
        label:((v0,v1) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_a9216d3f703281",`Open ${v0} for ${v1}`,{v0,v1}) ?? `Open ${v0} for ${v1}`)(groupLabel,name),
        icon:configuredIcon || (groupKindId === 'crew' ? 'fa-helmet-safety' : 'fa-user-group')
      };
    }
    if (subjectType === 'organization_connection') {
      return { label:((v0) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_365b236bd37982",`Open organization for ${v0}`,{v0}) ?? `Open organization for ${v0}`)(name), icon:configuredIcon || 'fa-building-user' };
    }
    return { label:((v0) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_7f867384580d1f",`Open settings for ${v0}`,{v0}) ?? `Open settings for ${v0}`)(name), icon:configuredIcon || 'fa-gear' };
  }

  function resourceCornerHtml(className = '', label = ''){
    return `<div class="${className}" style="grid-row:1;grid-column:1">${label ? `<span class="psv-resource-label-name">${esc(label)}</span>` : ''}</div>`;
  }

  function resourceGridHtml({
    wrapClass = '',
    showToolbar = true,
    toolbarHtml = '',
    surfaceClass = '',
    scrollClass = '',
    gridClass = '',
    gridStyle = '',
    cornerClass = '',
    headersHtml = '',
    rowsHtml = '',
    overlaysHtml = '',
    cornerLabel = '',
    omitCorner = false
  } = {}){
    const grid = `<div class="${gridClass}" style="${gridStyle}">${omitCorner ? '' : resourceCornerHtml(cornerClass, cornerLabel)}${headersHtml}${rowsHtml}${overlaysHtml}</div>`;
    const scroll = `<div class="${scrollClass}">${grid}</div>`;
    const body = surfaceClass ? `<div class="${surfaceClass}">${scroll}</div>` : scroll;
    return `<div class="${wrapClass}">${showToolbar ? toolbarHtml : ''}${body}</div>`;
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
        return `<div class="psv-travel" style="--travel-span:${String(spanSlots)}" data-slot-minutes="${String(esc(slotMinutes))}" data-travel-key="${String(esc(key))}" data-origin="${String(esc(origin))}" data-destination="${String(esc(destination))}"><i class="far fa-clock"></i>${((v5) => globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_3bdad39ac6e905",`&nbsp;${v5}`,{v5}) ?? `&nbsp;${v5}`)(esc(cached ? cached : '...'))}</div>`;
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
      const scroll = container.querySelector('.psv-scroll,.prs-resource-scroll');
      const left = scroll?.scrollLeft || 0;
      const top = scroll?.scrollTop || 0;
      container.__psvRerenderQueued = false;
      (container.__psvRenderer || renderDailyTeam)(container, state);
      const next = container.querySelector('.psv-scroll,.prs-resource-scroll');
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
    const showToolbar = options.showToolbar !== false;
    if (!container || !Scheduling) return;
    const config = options.config || {};
    seedTravelCache(options.travelTimeCache || options.travelTimes || {});
    const eventTypeId = options.eventTypeId || 'sales_appointment';
    const eventType = options.eventType || config.event_types?.[eventTypeId] || {};
    const roleIds = [...new Set([...(eventType.required_role_ids || []), ...(eventType.allowed_role_ids || []), ...(eventType.role_ids || []), 'sales_appointments'])];
    const availabilityUsers = (options.users || []).filter((user) => roleIds.some((roleId) => Scheduling.userHasRole(user, roleId)) && user.status !== 'disabled');
    const resources = Array.isArray(options.resources) && options.resources.length
      ? options.resources.filter((resource) => resource?.id && resource.status !== 'disabled')
      : availabilityUsers;
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
    const eventSlotPlacement = (event) => dailyEventSlotPlacement(eventStart(Scheduling, event), startMinute, slotMinutes);
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
          users:availabilityUsers,
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
    const resourceIdForItem = typeof options.resourceIdForItem === 'function'
      ? options.resourceIdForItem
      : (event) => eventUserIds(event)[0] || '';
    const allDateEvents = eventsForDate(Scheduling, projects, dateValue, null, options.events);
    const resourceEventsForDate = (resourceId = '') => allDateEvents.filter((event) => String(resourceIdForItem(event) || '') === String(resourceId || ''));
    const unassignedRows = options.includeUnassigned === false ? [] : [{
      ...unassignedPlacementRow(Scheduling, projects, dateValue),
      laneEvents:allDateEvents.filter((event) => !String(resourceIdForItem(event) || ''))
    }];
    const rows = [...unassignedRows, ...resources];
    if (!resources.length) {
      container.innerHTML = `<div class="psv-empty"><i class="fas fa-user-slash"></i>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_6a7fa493544c6c"," No eligible assignees are available.") ?? " No eligible assignees are available.")}</div>`;
      return;
    }
    container.__psvOptions = { ...options, Scheduling, config, users:availabilityUsers, resources, projects, eventType, eventTypeId, duration, slotMinutes };
    const toolbarHtml = `
      <div class="psv-toolbar">
        <div class="psv-nav">
          <button type="button" data-psv-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" data-psv-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="psv-range">${String(esc(date.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })))}</div>
        </div>
        <div class="psv-toolbar-right">
          ${String(typeof options.onLockTimeToggle === 'function' ? `<button type="button" class="psv-lock-toggle ${options.lockTime ? 'active' : ''}" data-psv-lock><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_6af109c4fd5ab7"," Lock appointment time") ?? " Lock appointment time")}</button>` : '')}
          ${String(typeof options.onSmartScrollToggle === 'function' ? `<button type="button" class="psv-smart-toggle ${options.smartScroll !== false ? 'active' : ''}" data-psv-smart-scroll><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_87d3f1a9ae9c3e"," Smart scroll") ?? " Smart scroll")}</button>` : '')}
          <button type="button" class="psv-travel-toggle ${String(options.liveTravel ? 'active' : '')}" data-psv-live><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_821a653a1f79f2"," Live travel time") ?? " Live travel time")}</button>
          <span class="psv-pill"><i class="fas fa-table-cells"></i>${String(esc(options.modeLabel || 'Daily team view'))}</span>
        </div>
      </div>
    `;
    if (dayDisabled) {
      container.innerHTML = `<div class="psv-wrap ${showToolbar ? '' : 'no-toolbar'}">${showToolbar ? toolbarHtml : ''}<div class="psv-empty"><i class="fas fa-calendar-xmark"></i> ${esc(windowForDay.message || 'No slots available for this day.')}</div></div>`;
      container.querySelectorAll('[data-psv-nav]').forEach((btn) => btn.addEventListener('click', () => options.onNavigate?.(Number(btn.dataset.psvNav || 0))));
      container.querySelector('[data-psv-lock]')?.addEventListener('click', () => options.onLockTimeToggle?.(!options.lockTime));
      container.querySelector('[data-psv-smart-scroll]')?.addEventListener('click', () => options.onSmartScrollToggle?.(options.smartScroll === false));
      container.querySelector('[data-psv-live]')?.addEventListener('click', () => options.onLiveTravelToggle?.(!options.liveTravel));
      return;
    }
    const rowViews = rows.map((user, rowIndex) => {
      const rowEvents = user.unassigned ? (user.laneEvents || []) : resourceEventsForDate(user.id);
      const maxStack = maxConcurrentStack(rowEvents, Scheduling);
      const rowDraft = placementActive && options.draft?.start && (
        (user.unassigned && !options.draft.user?.id) ||
        (!user.unassigned && clean(options.draft.user?.id || '') === clean(user.id || ''))
      );
      const rowDraftStack = rowDraft
        ? overlapStackIndex({ events: rowEvents, Scheduling, start: options.draft.start, duration, excludeEventId: options.assignmentEventId || '' }) + 1
        : 0;
      const unassignedPlacementCapacity = placementActive && user.unassigned && rowEvents.length && maxStack < resources.length
        ? maxStack + 1
        : maxStack;
      const rowStackCapacity = Math.max(unassignedPlacementCapacity, rowDraftStack);
      const rowHeight = rowHeightForStack(rowStackCapacity);
      const personHtml = resourceLabelHtml({
        className: `psv-person ${user.unassigned ? 'unassigned' : ''}`,
        rowIndex,
        name: user.name || user.email || '',
        sublabel: '',
        actionAttr: (!user.unassigned && typeof options.onResourceSettings === 'function') ? `data-psv-resource-settings="${esc(user.id || '')}"` : '',
        actionLabel: `Open profile for ${user.name || user.email || 'salesperson'}`,
        actionIcon: 'fa-user',
        style: `--psv-row-height:${rowHeight}px`
      });
      const slotsHtml = times.map((timeSlot, slotIndex) => {
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
                ? Scheduling.availabilityForEventType({ users:availabilityUsers, projects, eventType, eventTypeId, start, durationMinutes: duration, excludeEventId: options.assignmentEventId || '' }).hasAvailability
                : !proposedOverlaps(start, duration, intervals)));
              const slotEvents = user.unassigned ? [] : rowEvents.filter((event) => eventSlotPlacement(event).time === time);
              const unassignedDraftMatch = user.unassigned && options.draft?.start && !options.draft.user?.id && sameSlot(options.draft.start, start);
              const assignedDraftMatch = !user.unassigned && options.draft && sameSlot(options.draft.start, start) && clean(options.draft.user?.id || '') === clean(user.id || '');
              const draft = (unassignedDraftMatch || assignedDraftMatch)
                ? { start_at: start.toISOString(), duration_minutes: duration, customer_name: options.placementProject?.customer_name, project_title: options.placementProject?.title, project_address: options.placementProject?.address }
                : null;
              const disabled = options.readOnly || (placementActive && !available);
              const blocker = user.unassigned ? null : blockerAtSlot(blockers, start, slotMinutes);
              const travel = blockerHtml(blocker, slotMinutes);
              const unassignedSlotEvents = user.unassigned ? rowEvents.filter((event) => eventSlotPlacement(event).time === time) : [];
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
              return `<button type="button" class="psv-slot ${user.unassigned ? 'unassigned' : ''} ${timeSlot.overflow ? 'overflow' : ''} ${lockActive && placementActive && !overlapsLockedWindow ? 'locked-out' : ''} ${showUnavailable ? 'unavailable' : ''} ${showUnavailable ? 'not-placeable' : ''} ${unassignedTrueBlocked ? 'true-blocked' : ''} ${draft ? 'has-draft' : ''}" style="grid-row:${rowIndex + 2};grid-column:${slotIndex + 2};--span:${span};--slot-stack-count:${hoverStackCount};--psv-row-height:${rowHeight}px" data-psv-start="${esc(start.toISOString())}" data-psv-user="${esc(user.id || '')}" data-psv-lane="${esc(user.laneIndex ?? '')}" ${disabled ? 'aria-disabled="true"' : ''}>${travel}${visibleSlotEvents.map((event, stackIndex) => {
                const project = projects.find((p) => p.id === event.project_id);
                const selected = !!options.selectedEventId && String(options.selectedEventId) === String(event.id || '');
                const moving = !!options.assignmentEventId && String(options.assignmentEventId) === String(event.id || '');
                const menuHtml = selected && typeof options.eventMenuHtml === 'function' ? options.eventMenuHtml({ event, project }) : '';
                const foreign = !!options.focusProjectId && String(event.project_id || '') !== String(options.focusProjectId);
                return apptHtml({ event, project, Scheduling, slotMinutes, selected, moving, menuHtml, stackIndex, foreign, slotOffset:eventSlotPlacement(event).offset });
              }).join('')}${draft ? apptHtml({ event: draft, project: options.placementProject, Scheduling, slotMinutes, draft: true, confirmable: typeof options.onDraftConfirm === 'function', stackIndex: draftStackIndex }) : ''}</button>`;
            }).join('');
      return { personHtml, slotsHtml, rowHeight };
    });
    const rowTemplate = rowViews.map((row) => `${row.rowHeight}px`).join(' ');
    container.innerHTML = resourceGridHtml({
      wrapClass: `psv-wrap ${placementActive ? 'placement-active' : ''} ${showToolbar ? '' : 'no-toolbar'}`,
      showToolbar,
      toolbarHtml,
      surfaceClass: 'psv-surface',
      scrollClass: 'psv-scroll',
      gridClass: 'psv-grid psv-resource-grid',
      gridStyle: `--slot-count:${times.length};--psv-resources:${rows.length};--psv-row-template:${esc(rowTemplate)}`,
      cornerClass: 'psv-person psv-person-head',
      cornerLabel: options.resourceHeader || 'Salesperson',
      headersHtml: times.map((slot, index) => { const [clock, meridiem] = displayTime(slot.time).split(/\s+/); return `<div class="psv-hour ${slot.overflow ? 'overflow' : ''}" style="grid-row:1;grid-column:${index + 2}"><span>${esc(clock)}</span>${meridiem ? `<small>${esc(meridiem)}</small>` : ''}</div>`; }).join(''),
      rowsHtml: `${rowViews.map((row) => row.personHtml).join('')}${rowViews.map((row) => row.slotsHtml).join('')}`
    });
    const rightScroller = container.querySelector('.psv-scroll');
    const grid = container.querySelector('.psv-grid');
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
    container.querySelectorAll('[data-psv-resource-settings]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const user = resources.find((item) => String(item.id || '') === String(btn.dataset.psvResourceSettings || ''));
      if (user) options.onResourceSettings?.(user, { element: btn });
    }));
    container.querySelectorAll('.psv-appt[data-psv-event-id]').forEach((node) => node.addEventListener('click', (event) => {
      if (node.classList.contains('draft')) return;
      event.preventDefault();
      event.stopPropagation();
      const item = eventsForDate(Scheduling, projects, dateValue, null, options.events).find((entry) => String(entry.id || '') === String(node.dataset.psvEventId || ''));
      const project = projects.find((entry) => String(entry.id || '') === String(node.dataset.psvProjectId || '')) || null;
      const allowedIds = new Set((options.interactiveEventIds || []).map((id) => String(id)));
      if (allowedIds.size && !allowedIds.has(String(item?.id || ''))) return;
      options.onEventClick?.({ event: item, project, element: node });
    }));
    container.querySelectorAll('[data-psv-event-action]').forEach((node) => node.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const appt = node.closest('.psv-appt');
      const item = eventsForDate(Scheduling, projects, dateValue, null, options.events).find((entry) => String(entry.id || '') === String(appt?.dataset.psvEventId || ''));
      const project = projects.find((entry) => String(entry.id || '') === String(appt?.dataset.psvProjectId || '')) || null;
      options.onEventAction?.(node.dataset.psvEventAction || '', { event: item, project, element: appt });
    }));
    container.querySelectorAll('[data-psv-start]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.classList.contains('unavailable') || btn.getAttribute('aria-disabled') === 'true') return;
      const user = resources.find((item) => item.id === btn.dataset.psvUser) || null;
      const start = new Date(btn.dataset.psvStart);
      const laneIndex = btn.dataset.psvLane === '' ? null : Number(btn.dataset.psvLane);
      const sameDraft = options.draft?.start
        && sameSlot(options.draft.start, start)
        && clean(options.draft.user?.id || '') === clean(user?.id || '');
      options.onDraftChange?.(sameDraft ? null : { start, user, laneIndex });
    }));
    container.querySelectorAll('[data-psv-draft-confirm]').forEach((control) => {
      bindDraftConfirm(control, () => options.draft || null, options.onDraftConfirm);
    });
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
      ? eventsForDate(state.Scheduling, state.projects || [], dateValue, userId, state.events)
      : eventsForDate(state.Scheduling, state.projects || [], dateValue, null, state.events).filter((event) => !eventUserIds(event).length);
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
    bindDraftConfirm(target.querySelector('[data-psv-draft-confirm]'), draft, state.onDraftConfirm);
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

  function startOfDay(date){
    const d = new Date(date);
    d.setHours(0,0,0,0);
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

  function formatRange(start, end, allDay, { timeOnly = false } = {}){
    if (allDay) {
      const endDisplay = addDays(end, -1);
      if (dateKey(start) === dateKey(endDisplay)) return start.toLocaleDateString([], { month:'short', day:'numeric' });
      return `${start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${endDisplay.toLocaleDateString([], { month:'short', day:'numeric' })}`;
    }
    if (timeOnly) return `${start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })} - ${end.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`;
    return `${start.toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })} - ${end.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`;
  }

  function workChipHtml(item, range, { draft = false, suspended = false, preview = false, confirmable = false, mode = 'month', day = '', showDetails = true, showTime = true, showSecondary = true, showAssignee = true, showStartHandle = true, showEndHandle = true, chipStyle = '', chipClass = '' } = {}){
    const id = esc(item.id || (draft ? '__draft' : ''));
    const allDay = item.all_day !== false && item.schedule_granularity !== 'time';
    const projectTitle = clean(item.project_title || item.project_name || item.project?.title || item.project?.name || item.customer_name || '');
    const materialDelivery = isMaterialDeliveryEvent(item);
    const crewLabelRaw = clean(item.assignee_label || item.assigned_user_name || item.crew_label || item.assigned_crew_name || item.crew_name || item.resource_name || item.assigned_crew?.name || item.crew?.name || '');
    const waitingForCrew = !materialDelivery && (item.awaiting_crew === true || item.__waiting_for_crew === true);
    const crewLabel = waitingForCrew ? (crewLabelRaw || 'Unassigned') : crewLabelRaw;
    const timed = mode !== 'month';
    const timedMonth = String(chipClass || '').includes('timed-month');
    // secondary_label lets the caller pick the second line (e.g. the address
    // when the title already carries the customer/project name).
    const bottomLabel = showSecondary ? (clean(item.secondary_label) || projectTitle || (showTime ? formatRange(range.start, range.end, allDay, { timeOnly: timed || timedMonth }) : '')) : '';
    const assigneeHtml = !preview && !materialDelivery && showAssignee && showDetails && crewLabel ? `<button type="button" class="prs-assignee ${String(waitingForCrew ? 'waiting' : '')}" data-prs-assignee aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_9e5fd4e73c5442",`Assign ${v1}`,{v1}) ?? `Assign ${v1}`)(esc(crewLabel))}"><span>${String(esc(crewLabel))}</span></button>` : '';
    const rawType = clean(item.event_type_default_id || item.type_id || item.event_type_id || item.type).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/_/g, '-');
    const typeClass = rawType ? `type-${rawType}` : 'untyped';
    const unsavedClass = draft || item.status === 'draft' ? 'unsaved' : '';
    const title = esc(clean(item.title || item.event_title) || (materialDelivery ? materialDeliveryTitle(item) : 'New Event'));
    const ordered = materialDelivery && materialDeliveryIsOrdered(item);
    const locked = eventIsLocked(item);
    const presentation = materialDelivery ? materialDeliveryPresentation(item) : {};
    const previewColor = preview ? safeCssColor(
      item.material_list_color || item.material_color || item.accent_color || item.category_color || item.color || presentation.mainColor
    ) : '';
    const presentationStyle = [
      materialDelivery && presentation.mainColor ? `--prs-material-main:${presentation.mainColor}` : '',
      previewColor ? `--prs-preview-color:${previewColor}` : ''
    ].filter(Boolean).join(';');
    const mergedStyle = [presentationStyle, chipStyle].filter(Boolean).join(';');
    const styleAttr = mergedStyle ? ` style="${esc(mergedStyle)}"` : '';
    const rangeStart = new Date(range?.start);
    const rangeEnd = new Date(range?.end);
    const rangeAttrs = Number.isFinite(rangeStart.getTime()) && Number.isFinite(rangeEnd.getTime())
      ? ` data-prs-range-start="${esc(rangeStart.toISOString())}" data-prs-range-end="${esc(rangeEnd.toISOString())}"`
      : '';
    const markerLabel = presentation.label ? `Material delivery for ${presentation.label}` : 'Material delivery';
    const materialMarker = materialDelivery
      ? `<span class="prs-material-marker" title="${esc(markerLabel)}"><i class="fas ${esc(presentation.icon || 'fa-truck')}" aria-hidden="true"></i></span>`
      : '';
    // An appointment still waiting on the customer draws with a dashed border;
    // one they asked to reschedule is flagged harder. Returns null entirely
    // when this viewer isn't allowed to see confirmation state, so the chip
    // renders exactly as it did before the feature existed.
    const confirmation = confirmationStateFor(item);
    const confirmationClass = confirmation
      ? `confirmation-${confirmation.status} ${confirmation.awaiting ? 'unconfirmed' : ''} ${confirmation.declined ? 'confirmation-declined' : ''}`
      : '';
    const confirmationMarker = confirmation && !preview && showDetails && (confirmation.awaiting || confirmation.declined)
      ? `<span class="prs-confirm-marker ${confirmation.declined ? 'bad' : 'warn'}" title="${esc(confirmation.label)}"><i class="fas ${esc(confirmation.icon)}" aria-hidden="true"></i></span>`
      : '';
    const requirementWarnings = Array.isArray(item.requirement_warnings)
      ? item.requirement_warnings
      : (root.PlatformScheduling?.eventRequirementWarnings?.(item, { includeEquipment:false }) || []);
    const requirementLabel = requirementWarnings.map((warning) => clean(warning?.label || warning)).filter(Boolean).join('; ');
    const requirementMarker = requirementLabel && !preview && showDetails
      ? `<span class="prs-requirement-warning" title="${esc(requirementLabel)}" aria-label="${esc(requirementLabel)}"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i></span>`
      : '';
    const showLockControl = !draft && !preview && materialDelivery && item.lock_toggle_visible !== false;
    const lockLabel = locked ? 'Unlock schedule' : 'Lock schedule';
    const lockControl = showLockControl
      ? `<button type="button" class="prs-event-lock ${locked ? 'locked' : 'unlocked'}" data-prs-lock-toggle aria-label="${lockLabel}" title="${lockLabel}"><i class="fas ${locked ? 'fa-lock' : 'fa-lock-open'}" aria-hidden="true"></i></button>`
      : '';
    const renderStartHandle = showStartHandle && !locked;
    const renderEndHandle = showEndHandle && !locked;
    return `<div class="prs-work-chip ${timed ? 'timed' : ''} ${typeClass} ${unsavedClass} ${chipClass ? esc(chipClass) : ''} ${materialDelivery ? `material-delivery ${ordered ? 'material-ordered' : 'material-unordered'}` : ''} ${locked ? 'schedule-locked' : ''} ${showLockControl ? 'has-lock-control' : ''} ${waitingForCrew ? 'awaiting-crew' : ''} ${requirementLabel ? 'has-requirement-warning' : ''} ${draft ? 'draft' : ''} ${suspended ? 'suspended' : ''} ${preview ? 'preview' : ''} ${draft && confirmable ? 'has-confirm' : ''} ${confirmationClass} ${renderStartHandle ? '' : 'no-start-handle'} ${renderEndHandle ? '' : 'no-end-handle'} ${assigneeHtml ? 'has-assignee' : 'no-assignee'}" data-prs-event-id="${id}" data-prs-day="${esc(day)}" data-prs-mode="${esc(mode)}" data-prs-locked="${locked ? '1' : '0'}"${rangeAttrs}${styleAttr}>
      <span class="prs-chip-top"><span class="prs-title">${showDetails ? `${materialMarker}${confirmationMarker}<span class="prs-title-text">${title}</span>` : '&nbsp;'}</span>${timed ? '' : assigneeHtml}</span>
      ${showDetails && bottomLabel ? `<span class="prs-chip-bottom"><span class="${projectTitle ? 'prs-project-title' : 'prs-time'}">${esc(bottomLabel)}</span>${lockControl}</span>` : ''}
      ${timed ? assigneeHtml : ''}
      ${requirementMarker}
      ${!bottomLabel && lockControl ? `<span class="prs-chip-lock-only">${lockControl}</span>` : ''}
      ${draft && confirmable ? `<button type="button" class="prs-confirm" data-prs-confirm aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_bab4540ec11ac4","Confirm New Event") ?? "Confirm New Event")}"><i class="fas fa-check"></i></button>` : ''}
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

  function resourceDayLaneRange(range = {}){
    const start = dateAt(dateKey(range.start), '00:00');
    const endDay = dateAt(dateKey(range.end), '00:00');
    return { start, end:endDay > start ? endDay : addDays(start, 1) };
  }

  function packResourceLanes(entries = [], resourceIdForEntry = () => ''){
    const laneByItem = new Map();
    const laneCountByResource = new Map();
    const groups = new Map();
    entries.forEach((entry) => {
      if (!entry?.item || !entry?.range?.start || !entry?.range?.end) return;
      const resourceId = String(resourceIdForEntry(entry.item) || '');
      if (!groups.has(resourceId)) groups.set(resourceId, []);
      groups.get(resourceId).push(entry);
    });
    groups.forEach((items, resourceId) => {
      const laneEnds = [];
      items
        .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)
        .forEach(({ item, range }) => {
          let lane = laneEnds.findIndex((end) => end <= range.start);
          if (lane < 0) {
            lane = laneEnds.length;
            laneEnds.push(range.end);
          } else {
            laneEnds[lane] = range.end;
          }
          laneByItem.set(item, lane);
        });
      laneCountByResource.set(resourceId, Math.max(1, laneEnds.length));
    });
    return { laneByItem, laneCountByResource };
  }

  function resizeEdgeAtPointer(chip, event){
    if (!chip || chip.classList.contains('schedule-locked')) return 'move';
    const rect = chip.getBoundingClientRect();
    const timed = chip.classList.contains('timed');
    const position = timed ? event.clientY - rect.top : event.clientX - rect.left;
    const size = timed ? rect.height : rect.width;
    const edgeSize = Math.min(10, Math.max(5, size / 3));
    if (position <= edgeSize && !chip.classList.contains('no-start-handle')) return 'start';
    if (position >= size - edgeSize && !chip.classList.contains('no-end-handle')) return 'end';
    return 'move';
  }

  function bindEdgeResizeCursor(chip, canEdit){
    if (!chip || chip.dataset.prsResizeCursorBound === '1') return;
    chip.dataset.prsResizeCursorBound = '1';
    chip.addEventListener('pointermove', (event) => {
      if (chip.classList.contains('dragging')) {
        chip.style.cursor = 'grabbing';
        return;
      }
      if (!canEdit() || event.target.closest('[data-prs-confirm],[data-prs-assignee],[data-prs-view],[data-prs-lock-toggle]')) {
        chip.style.cursor = '';
        return;
      }
      const edge = resizeEdgeAtPointer(chip, event);
      chip.style.cursor = edge === 'move' ? 'grab' : (chip.classList.contains('timed') ? 'ns-resize' : 'ew-resize');
    });
    chip.addEventListener('pointerleave', () => { chip.style.cursor = ''; });
  }

  function timedMonthRange(range){
    const start = dateAt(dateKey(range.start), '00:00');
    return { start, end: addDays(start, 1) };
  }

  function renderProjectRangeScheduler(container, options = {}){
    if (!container) return;
    if (container.__prsPlacementKeyHandler) {
      document.removeEventListener('keydown', container.__prsPlacementKeyHandler);
      container.__prsPlacementKeyHandler = null;
    }
    injectCss();
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    const mode = ['list','day','4day','week','month'].includes(options.mode) ? options.mode : 'month';
    const anchor = new Date(options.date || Date.now());
    const workEvents = (options.events || []).map((event) => Scheduling?.normalizeEvent ? Scheduling.normalizeEvent(event, options.config || null, options.project || null) : event);
    const legacyReadOnly = options.readOnly === true;
    const allowCreate = options.allowCreate !== undefined ? options.allowCreate !== false : !legacyReadOnly;
    const allowEdit = options.allowEdit !== undefined ? options.allowEdit !== false : !legacyReadOnly;
    const allowEventDrag = allowEdit && options.allowEventDrag !== false;
    const clickPlacement = allowCreate && options.placementMode === 'click';
    const readOnly = !allowCreate && !allowEdit;
    const rawDrafts = Array.isArray(options.drafts) ? options.drafts : (options.draft ? [options.draft] : []);
    const requestedActiveDraftId = Object.prototype.hasOwnProperty.call(options, 'activeDraftId')
      ? options.activeDraftId
      : (options.draft?.id || rawDrafts[rawDrafts.length - 1]?.id || '');
    const activeDraftId = String(requestedActiveDraftId || '');
    const activeDraft = rawDrafts.find((entry) => String(entry?.id || '') === activeDraftId) || options.draft || null;
    const showModeSwitch = options.showModeSwitch !== false;
    const showToolbar = options.showToolbar !== false;
    const modeChoices = (Array.isArray(options.modes) && options.modes.length ? options.modes : ['day','4day','week','month'])
      .filter((id) => ['list','day','4day','week','month'].includes(id));
    const modeLabels = objectValue(options.modeLabels);
    const modeLabel = (id) => clean(modeLabels[id]) || (id === '4day' ? '4 Day' : id[0].toUpperCase() + id.slice(1));
    const draftEvents = rawDrafts.filter((entry) => entry?.start).map((entry, index) => {
      const id = String(entry.id || `__draft_${index}`);
      return {
        ...entry,
        id,
        event_id: entry.event_id || '',
        __draft: true,
        __activeDraft: id === activeDraftId,
        title: entry.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end || addDays(new Date(entry.start), 1)).toISOString(),
        start: entry.start,
        end: entry.end || addDays(new Date(entry.start), 1),
        all_day: entry.all_day !== false,
        schedule_granularity: entry.schedule_granularity || (entry.all_day === false ? 'time' : 'date'),
        status: entry.status || 'draft'
      };
    });
    const draftIds = new Set(draftEvents.map((entry) => String(entry.id || '')));
    const visibleItems = [
      ...workEvents.filter((event) => !draftIds.has(String(event.id || ''))),
      ...draftEvents
    ];
    const localItemOverrides = new Map();
    const eventByRenderedId = (id) => {
      const key = String(id || '');
      if (!key) return null;
      return (String(localActiveDraft?.id || '') === key ? localActiveDraft : null)
        || localItemOverrides.get(key)
        || visibleItems.find((entry) => String(entry.id || '') === key)
        || null;
    };
    const editableEventIds = Array.isArray(options.editableEventIds) ? new Set(options.editableEventIds.map((id) => String(id || '')).filter(Boolean)) : null;
    const itemIsEditable = (item = {}) => {
      if (item.__draft === true || item.id === '__draft') return true;
      const allowedById = !editableEventIds || editableEventIds.has(String(item.id || item.event_id || ''));
      return allowedById && eventPassesEditPredicate(options, item);
    };
    const itemCanAdjustRange = (item = {}) => itemIsEditable(item) && !eventIsLocked(item);
    const shortRangeDayCount = Math.max(2, Math.min(4, Number(options.shortRangeDayCount || 4) || 4));
    const timedDayCount = mode === 'day' ? 1 : (mode === '4day' ? shortRangeDayCount : 7);
    const timedStartDay = mode === 'week' ? startOfWeek(anchor) : startOfDay(anchor);
    const viewLabel = mode === 'list'
      ? clean(options.listLabel || 'All assigned work')
      : mode === 'month'
      ? anchor.toLocaleDateString([], { month:'long', year:'numeric' })
      : timedDayCount > 1
        ? `${timedStartDay.toLocaleDateString([], { month:'short', day:'numeric' })} - ${addDays(timedStartDay, timedDayCount - 1).toLocaleDateString([], { month:'short', day:'numeric' })}`
        : anchor.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
    const navDayCount = mode === 'week' ? 7 : (mode === '4day' ? shortRangeDayCount : 1);
    const snapMinutes = Math.max(5, Number(options.slotMinutes || 15) || 15);
    const renderSlotMinutes = Math.max(snapMinutes, Number(options.renderSlotMinutes || 60) || 60);
    const slotHeight = Math.max(24, Number(options.renderSlotHeight || 54) || 54);
    const workStart = Math.max(0, Number(options.workStartMinute ?? 0) || 0);
    const workEnd = Math.min(24 * 60, Number(options.workEndMinute ?? (24 * 60)) || (24 * 60));
    const rowStartMinute = (date) => {
      const minute = date.getHours() * 60 + date.getMinutes();
      return Math.max(workStart, Math.min(workEnd - renderSlotMinutes, workStart + Math.floor((minute - workStart) / renderSlotMinutes) * renderSlotMinutes));
    };
    const chipOffsetTop = (date) => {
      const minute = date.getHours() * 60 + date.getMinutes();
      const offsetMinutes = Math.max(0, Math.min(renderSlotMinutes - snapMinutes, minute - rowStartMinute(date)));
      return 4 + (offsetMinutes / renderSlotMinutes) * slotHeight;
    };
    const chipHeightForRange = (start, end) => Math.max(30, ((end.getTime() - start.getTime()) / 60000 / renderSlotMinutes) * slotHeight - 8);
    const timedSegments = (item, range, visibleStart = null, visibleEnd = null) => {
      if (!range?.start || !range?.end || range.end <= range.start) return [];
      const segments = [];
      let cursor = startOfDay(range.start);
      const limit = startOfDay(range.end);
      while (cursor <= limit) {
        const dayStart = new Date(cursor);
        const dayEnd = addDays(dayStart, 1);
        const segmentStart = range.start > dayStart ? range.start : dayStart;
        const segmentEnd = range.end < dayEnd ? range.end : dayEnd;
        if (segmentStart < segmentEnd && (!visibleStart || segmentEnd > visibleStart) && (!visibleEnd || segmentStart < visibleEnd)) {
          segments.push({
            item,
            range,
            segmentRange: { start: segmentStart, end: segmentEnd },
            continuesBefore: range.start < segmentStart,
            continuesAfter: range.end > segmentEnd,
            beginsHere: Math.abs(range.start.getTime() - segmentStart.getTime()) < 1000,
          });
        }
        cursor = dayEnd;
      }
      return segments;
    };
    const toolbar = `
      <div class="prs-toolbar">
        ${mode === 'list' ? (options.showListLabel === false ? '' : `<div class="prs-nav"><div class="prs-range">${esc(viewLabel)}</div></div>`) : `<div class="prs-nav"><button type="button" class="prs-icon-btn" data-prs-nav="-1"><i class="fas fa-chevron-left"></i></button><button type="button" class="prs-icon-btn" data-prs-today>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_23929ba4ba84dd","Today") ?? "Today")}</button><button type="button" class="prs-icon-btn" data-prs-nav="1"><i class="fas fa-chevron-right"></i></button><div class="prs-range">${String(esc(viewLabel))}</div></div>`}
        ${showModeSwitch && modeChoices.length > 1 ? `<div class="prs-view-switch">${modeChoices.map((id) => `<button type="button" class="prs-view-btn ${mode === id ? 'active' : ''}" data-prs-mode="${id}">${esc(modeLabel(id))}</button>`).join('')}</div>` : ''}
      </div>
    `;
    const renderList = () => {
      const today = startOfDay(new Date());
      const normalized = visibleItems.map(normalizeRangeItem).filter(({ range }) => range?.start && range?.end);
      const upcoming = normalized.filter(({ range }) => range.end > today).sort((left, right) => left.range.start - right.range.start);
      const past = normalized.filter(({ range }) => range.end <= today).sort((left, right) => right.range.start - left.range.start);
      const itemHtml = ({ item, range }) => {
        const title = clean(item.project_title || item.project_name || item.project?.title || item.title || item.customer_name || 'Project');
        const eventTitle = clean(item.title || item.event_title);
        const address = clean(item.project_address || item.address || item.project?.address);
        const timed = rangeItemIsTimed(item);
        const startLabel = range.start.toLocaleDateString([], { month:'short' });
        const detail = eventTitle && eventTitle !== title ? eventTitle : address;
        const rangeLabel = timed
          ? `${range.start.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })} - ${range.end.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}`
          : (dateKey(range.start) === dateKey(addDays(range.end, -1)) || dateKey(range.start) === dateKey(range.end)
            ? range.start.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' })
            : `${range.start.toLocaleDateString([], { month:'short', day:'numeric' })} - ${addDays(range.end, -1).toLocaleDateString([], { month:'short', day:'numeric' })}`);
        const color = safeCssColor(item.scope_color || item.color || item.schedule_color || item.presentation?.color) || '#64748b';
        return `<button type="button" class="prs-list-item" data-prs-list-event-id="${esc(item.id || item.event_id || '')}" style="--prs-list-color:${esc(color)}"><span class="prs-list-date"><span>${esc(startLabel)}</span><strong>${esc(range.start.getDate())}</strong></span><span class="prs-list-copy"><strong>${esc(title)}</strong><span>${esc(detail || address || 'Assigned project')}</span></span><span class="prs-list-meta"><span>${esc(rangeLabel)}</span>${address && detail !== address ? `<small>${esc(address)}</small>` : ''}</span></button>`;
      };
      const section = (label, items) => items.length ? `<section class="prs-list-section"><div class="prs-list-section-head"><strong>${esc(label)}</strong><span>${items.length}</span></div><div class="prs-list-items">${items.map(itemHtml).join('')}</div></section>` : '';
      return upcoming.length || past.length
        ? `<div class="prs-list">${section('Today & upcoming', upcoming)}${section('Past', past)}</div>`
        : `<div class="prs-empty">${esc(options.emptyMessage || 'No assigned projects match this view.')}</div>`;
    };
    const expandedMonthDates = new Set((Array.isArray(options.expandedMonthDates) ? options.expandedMonthDates : []).map(String));
    const renderMonth = () => {
      const month = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const start = startOfWeek(month);
      const weekCount = monthWeekRowCount(month);
      const days = Array.from({ length: weekCount * 7 }, (_, i) => addDays(start, i));
      const weeks = Array.from({ length: weekCount }, (_, weekIndex) => days.slice(weekIndex * 7, weekIndex * 7 + 7));
      const normalized = visibleItems.map(normalizeRangeItem).map((entry) => ({
        ...entry,
        displayRange: rangeItemIsTimed(entry.item) ? timedMonthRange(entry.range) : entry.range
      }));
      const weekBars = (weekDays) => {
        const weekStart = weekDays[0];
        const weekEnd = addDays(weekStart, 7);
        const lanes = [];
        const dayItems = weekDays.map(() => []);
        const html = normalized
          .filter(({ displayRange }) => displayRange.start < weekEnd && displayRange.end > weekStart)
          .sort((a, b) => a.displayRange.start - b.displayRange.start || a.displayRange.end - b.displayRange.end)
          .map(({ item, range, displayRange }) => {
            const timedMonth = rangeItemIsTimed(item);
            const barRange = displayRange || range;
            const segmentStart = barRange.start > weekStart ? barRange.start : weekStart;
            const segmentEnd = barRange.end < weekEnd ? barRange.end : weekEnd;
            const startCol = Math.max(1, Math.min(7, dayDiff(weekStart, segmentStart) + 1));
            const endCol = Math.max(startCol + 1, Math.min(8, dayDiff(weekStart, segmentEnd) + 1));
            let laneIndex = lanes.findIndex((laneEndCol) => laneEndCol <= startCol);
            if (laneIndex < 0) {
              laneIndex = lanes.length;
              lanes.push(endCol);
            } else {
              lanes[laneIndex] = endCol;
            }
            const beginsHere = barRange.start >= weekStart && barRange.start < weekEnd;
            const continuesBefore = barRange.start < weekStart;
            const continuesAfter = barRange.end > weekEnd;
            const segmentRange = timedMonth ? range : { start: segmentStart, end: segmentEnd };
            for (let dayIndex = startCol - 1; dayIndex < endCol - 1; dayIndex += 1) {
              const itemDayStart = weekDays[dayIndex];
              const itemDayEnd = addDays(itemDayStart, 1);
              dayItems[dayIndex][laneIndex] = {
                item,
                range:timedMonth ? range : {
                  start:barRange.start > itemDayStart ? barRange.start : itemDayStart,
                  end:barRange.end < itemDayEnd ? barRange.end : itemDayEnd,
                },
                timedMonth,
                beginsHere:barRange.start >= itemDayStart && barRange.start < itemDayEnd,
                continuesBefore:barRange.start < itemDayStart,
                continuesAfter:barRange.end > itemDayEnd,
              };
            }
            return `<div class="prs-month-bar ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}" style="grid-column:${startCol}/${endCol};margin-top:${MONTH_ITEM_TOP_PX + laneIndex * MONTH_ITEM_STEP_PX}px" data-prs-date="${esc(dateKey(segmentStart))}" data-prs-month-lane="${laneIndex}">
              ${workChipHtml(item, segmentRange, {
                draft: item.__draft === true || item.id === '__draft',
                suspended: item.__draft === true && item.__activeDraft !== true,
                confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function' && !continuesAfter,
                mode,
                day: dateKey(segmentStart),
                chipClass: timedMonth ? 'timed-month' : '',
                showDetails: beginsHere,
                showTime: false,
                showSecondary: false,
                showStartHandle: timedMonth ? false : !continuesBefore,
                showEndHandle: timedMonth ? false : !continuesAfter
              })}
            </div>`;
          }).join('');
        const overflowByDay = dayItems.map((items, dayIndex) => {
          const count = items.slice(MONTH_VISIBLE_ITEM_COUNT).filter(Boolean).length;
          const dayTrackHeight = Math.max(82, items.length * MONTH_ITEM_STEP_PX - 4);
          const peekHtml = Array.from({ length:items.length }, (_, laneIndex) => items[laneIndex]).map((entry) => {
            if (!entry) return '<div class="prs-month-day-peek-item is-gap" aria-hidden="true"></div>';
            const { item, range, timedMonth, beginsHere, continuesBefore, continuesAfter } = entry;
            return `<div class="prs-month-day-peek-item">${workChipHtml(item, range, {
            draft:item.__draft === true || item.id === '__draft',
            suspended:item.__draft === true && item.__activeDraft !== true,
            confirmable:false,
            mode:'month',
            day:dateKey(weekDays[dayIndex]),
            chipClass:`prs-month-day-peek-chip ${timedMonth ? 'timed-month' : ''} ${continuesBefore ? 'continues-from-previous-day' : ''} ${continuesAfter ? 'continues-into-next-day' : ''}`,
            showDetails:beginsHere,
            showTime:false,
            showSecondary:false,
            showAssignee:true,
            showStartHandle:false,
            showEndHandle:false,
          })}</div>`;
          }).join('');
          const scrollSteps = Math.max(0, items.length - MONTH_VISIBLE_ITEM_COUNT);
          return {
            count,
            scroll:scrollSteps * MONTH_ITEM_STEP_PX,
            scrollSteps,
            dayTrackHeight,
            expandedHeight:Math.max(124, MONTH_ITEM_TOP_PX + dayTrackHeight + 22),
            peekHtml,
          };
        });
        const trackHeight = Math.max(MONTH_COLLAPSED_ITEMS_HEIGHT_PX, MONTH_ITEM_TOP_PX + Math.max(0, lanes.length - 1) * MONTH_ITEM_STEP_PX + 24);
        const expandedHeight = Math.max(124, trackHeight + 22);
        overflowByDay.forEach((overflow) => { overflow.expandedHeight = expandedHeight; });
        return { html, laneCount:lanes.length, overflowByDay, trackHeight };
      };
      return `<div class="prs-surface"><div class="prs-month">
        <div class="prs-month-head-row">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<div class="prs-month-head">${day}</div>`).join('')}</div>
        ${weeks.map((weekDays) => {
          const layout = weekBars(weekDays);
          const expandedDayIndex = layout.overflowByDay.findIndex((overflow, dayIndex) => overflow.count > 0 && expandedMonthDates.has(dateKey(weekDays[dayIndex])));
          const expandedOverflow = expandedDayIndex >= 0 ? layout.overflowByDay[expandedDayIndex] : null;
          return `<div class="prs-month-week ${expandedDayIndex >= 0 ? 'expanded' : ''}" style="--prs-month-expanded-height:${expandedOverflow ? expandedOverflow.expandedHeight : 124}px">
            ${weekDays.map((day, index) => `<div class="prs-day ${day.getMonth() === month.getMonth() ? '' : 'muted'} ${dayTemporalClass(day)}" style="grid-column:${index + 1}" data-prs-date="${esc(dateKey(day))}">
              <div class="prs-day-num">${day.getDate()}</div>
            </div>`).join('')}
            <div class="prs-month-item-viewport"><div class="prs-month-item-track" style="--prs-month-track-height:${layout.trackHeight}px">${layout.html}</div></div>
            ${layout.overflowByDay.map((overflow, dayIndex) => overflow.count > 0 ? `<div class="prs-month-day-peek ${weekDays[dayIndex].getMonth() === month.getMonth() ? '' : 'muted'} ${dayTemporalClass(weekDays[dayIndex])}" style="grid-column:${dayIndex + 1};--prs-month-day-track-height:${overflow.dayTrackHeight}px" data-prs-month-day-peek="${dayIndex}"><div class="prs-month-day-peek-track">${overflow.peekHtml}</div></div>` : '').join('')}
            ${layout.overflowByDay.map((overflow, dayIndex) => overflow.count > 0 ? `<button type="button" class="prs-month-overflow ${String(dayIndex === expandedDayIndex ? 'is-controller' : '')}" style="grid-column:${String(dayIndex + 1)}" data-prs-month-overflow data-prs-month-day="${String(dayIndex)}" data-prs-month-date="${String(esc(dateKey(weekDays[dayIndex])))}" data-prs-month-count="${String(overflow.count)}" data-prs-month-scroll="${String(overflow.scroll)}" data-prs-month-scroll-steps="${String(overflow.scrollSteps)}" data-prs-month-expanded-height="${String(overflow.expandedHeight)}" aria-expanded="${String(dayIndex === expandedDayIndex ? 'true' : 'false')}" aria-label="${String(dayIndex === expandedDayIndex ? 'Show fewer items' : `Show ${overflow.count} more ${overflow.count === 1 ? 'item' : 'items'}`)}"><span class="prs-month-overflow-more">+ ${String(overflow.count)} ${String(overflow.count === 1 ? 'item' : 'items')}</span><span class="prs-month-overflow-less">${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_b55d24ab7e316b","Show less") ?? "Show less")}</span></button>` : '').join('')}
          </div>`;
        }).join('')}
      </div></div>`;
    };
    const renderTimed = () => {
      const startDay = new Date(timedStartDay);
      startDay.setHours(0,0,0,0);
      const days = Array.from({ length: timedDayCount }, (_, i) => addDays(startDay, i));
      const slots = [];
      for (let m = workStart; m < workEnd; m += renderSlotMinutes) slots.push(m);
      const timeLabel = (m) => {
        const hour = Math.floor(m / 60) % 24;
        const displayHour = hour % 12 || 12;
        return `${displayHour} ${hour < 12 ? 'AM' : 'PM'}`;
      };
      const viewStart = days[0];
      const viewEnd = addDays(viewStart, days.length);
      const compactWeekAllDay = mode === 'week';
      const allDayLanes = [];
      const allDayEntries = visibleItems.map(normalizeRangeItem)
        .filter(({ item, range }) => !rangeItemIsTimed(item) && range.start < viewEnd && range.end > viewStart)
        .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)
        .map(({ item, range }) => {
          const segmentStart = range.start > viewStart ? range.start : viewStart;
          const segmentEnd = range.end < viewEnd ? range.end : viewEnd;
          const startCol = Math.max(2, Math.min(days.length + 1, dayDiff(viewStart, segmentStart) + 2));
          const endCol = Math.max(startCol + 1, Math.min(days.length + 2, dayDiff(viewStart, segmentEnd) + 2));
          let laneIndex = allDayLanes.findIndex((laneEndCol) => laneEndCol <= startCol);
          if (laneIndex < 0) {
            laneIndex = allDayLanes.length;
            allDayLanes.push(endCol);
          } else {
            allDayLanes[laneIndex] = endCol;
          }
          const beginsHere = range.start >= viewStart && range.start < viewEnd;
          const continuesBefore = range.start < viewStart;
          const continuesAfter = range.end > viewEnd;
          return { item, range, segmentStart, segmentEnd, startCol, endCol, laneIndex, beginsHere, continuesBefore, continuesAfter };
        });
      const allDayTop = compactWeekAllDay ? WEEK_ALL_DAY_ITEM_TOP_PX : 6;
      const allDayStep = compactWeekAllDay ? WEEK_ALL_DAY_ITEM_STEP_PX : 48;
      const allDayBars = allDayEntries.map(({ item, segmentStart, segmentEnd, startCol, endCol, laneIndex, beginsHere, continuesBefore, continuesAfter }) => (
          `<div class="prs-all-day-bar-top ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}" style="grid-column:${startCol}/${endCol};grid-row:1;margin-top:${allDayTop + laneIndex * allDayStep}px" data-prs-date="${esc(dateKey(segmentStart))}">
            ${workChipHtml(item, { start: segmentStart, end: segmentEnd }, {
              draft: item.__draft === true || item.id === '__draft',
              suspended: item.__draft === true && item.__activeDraft !== true,
              confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function' && !continuesAfter,
              mode: 'month',
              day: dateKey(segmentStart),
              showDetails: beginsHere,
              showTime: false,
              showSecondary: !compactWeekAllDay,
              showStartHandle: !continuesBefore,
              showEndHandle: !continuesAfter
            })}
          </div>`
        )).join('');
      const allDayRows = Math.max(1, allDayLanes.length);
      const hiddenAllDayByDay = compactWeekAllDay ? days.map((day, dayIndex) => {
        const gridColumn = dayIndex + 2;
        const hiddenEntries = allDayEntries.filter((entry) => entry.laneIndex >= WEEK_ALL_DAY_VISIBLE_ITEM_COUNT && entry.startCol <= gridColumn && entry.endCol > gridColumn);
        const maximumLane = hiddenEntries.length ? Math.max(...hiddenEntries.map((entry) => entry.laneIndex)) : WEEK_ALL_DAY_VISIBLE_ITEM_COUNT - 1;
        return {
          day,
          dayIndex,
          gridColumn,
          count:hiddenEntries.length,
          scroll:Math.max(0, (maximumLane - WEEK_ALL_DAY_VISIBLE_ITEM_COUNT + 1) * WEEK_ALL_DAY_ITEM_STEP_PX),
          scrollSteps:Math.max(0, maximumLane - WEEK_ALL_DAY_VISIBLE_ITEM_COUNT + 1),
        };
      }) : [];
      const hiddenAllDayCount = hiddenAllDayByDay.reduce((count, dayOverflow) => count + dayOverflow.count, 0);
      const allDayExpansionKey = `week-all-day:${dateKey(viewStart)}`;
      const allDayExpanded = hiddenAllDayCount > 0 && expandedMonthDates.has(allDayExpansionKey);
      const initialAllDayController = hiddenAllDayByDay.findIndex((dayOverflow) => dayOverflow.count > 0);
      const compactAllDayHeight = hiddenAllDayCount > 0
        ? (allDayExpanded ? WEEK_ALL_DAY_ITEM_TOP_PX + allDayRows * WEEK_ALL_DAY_ITEM_STEP_PX + 22 : WEEK_ALL_DAY_COLLAPSED_HEIGHT_PX)
        : Math.max(54, 12 + allDayRows * WEEK_ALL_DAY_ITEM_STEP_PX);
      const allDayGridHeight = compactWeekAllDay ? compactAllDayHeight : Math.max(54, 12 + allDayRows * 48);
      const timedGridMinWidth = 62 + days.length * 120;
      const allDayOverflowButtons = hiddenAllDayByDay.map((dayOverflow) => dayOverflow.count > 0 ? `<button type="button" class="prs-week-all-day-overflow ${String(allDayExpanded && dayOverflow.dayIndex === initialAllDayController ? 'is-controller' : '')}" style="grid-column:${String(dayOverflow.gridColumn)}" data-prs-week-all-day-overflow data-prs-week-all-day-count="${String(dayOverflow.count)}" data-prs-week-all-day-scroll="${String(dayOverflow.scroll)}" data-prs-week-all-day-scroll-steps="${String(dayOverflow.scrollSteps)}" aria-expanded="${String(allDayExpanded && dayOverflow.dayIndex === initialAllDayController ? 'true' : 'false')}" aria-label="${String(allDayExpanded && dayOverflow.dayIndex === initialAllDayController ? 'Show fewer all-day items' : `Show ${dayOverflow.count} more all-day ${dayOverflow.count === 1 ? 'item' : 'items'} on ${dayOverflow.day.toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' })}`)}"><span class="prs-week-all-day-overflow-more">${((v7) => globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_ffbd4fa895be2c",`+ ${v7} more`,{v7}) ?? `+ ${v7} more`)(dayOverflow.count)}</span><span class="prs-week-all-day-overflow-less">${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_b55d24ab7e316b","Show less") ?? "Show less")}</span></button>` : '').join('');
      return `<div class="prs-surface"><div class="prs-time-grid prs-time-header-grid" style="--prs-days:${String(days.length)};min-width:${String(timedGridMinWidth)}px">
        <div class="prs-time-head"></div>
        ${String(days.map((day) => `<div class="prs-day-head ${dayTemporalClass(day)}"><span class="prs-day-head-desktop">${esc(day.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }))}</span><span class="prs-day-head-mobile"><span>${esc(day.toLocaleDateString([], { weekday:'short' }))}</span><strong>${esc(day.toLocaleDateString([], { day:'numeric' }))}</strong></span></div>`).join(''))}
      </div><div class="prs-all-day-grid ${String(compactWeekAllDay ? 'week-overflow' : '')} ${String(hiddenAllDayCount > 0 ? 'has-overflow' : '')} ${String(allDayExpanded ? 'expanded' : '')}" style="--prs-days:${String(days.length)};min-width:${String(timedGridMinWidth)}px;height:${String(allDayGridHeight)}px;min-height:${String(allDayGridHeight)}px;grid-template-rows:${String(allDayGridHeight)}px" data-prs-week-all-day-key="${String(esc(allDayExpansionKey))}" data-prs-week-all-day-collapsed-height="${String(WEEK_ALL_DAY_COLLAPSED_HEIGHT_PX)}" data-prs-week-all-day-expanded-height="${String(WEEK_ALL_DAY_ITEM_TOP_PX + allDayRows * WEEK_ALL_DAY_ITEM_STEP_PX + 22)}">
        <div class="prs-all-day-label-cell"><span class="prs-all-day-label-desktop">${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_42b02bf1587e27","All day") ?? "All day")}</span><span class="prs-all-day-label-mobile">${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_61df468d92e238","All") ?? "All")}<br>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_0cd216c9c0268f","day") ?? "day")}</span></div>
        ${String(days.map((day, index) => `<div class="prs-all-day-cell ${dayTemporalClass(day)}" style="grid-column:${index + 2};grid-row:1" data-prs-date="${esc(dateKey(day))}" data-prs-allday="1"></div>`).join(''))}
        ${String(allDayBars)}
        ${String(allDayOverflowButtons)}
      </div><div class="prs-time-grid" style="--prs-days:${String(days.length)};min-width:${String(timedGridMinWidth)}px">
        ${String(slots.map((minute) => `
          <div class="prs-time-label">${esc(timeLabel(minute))}</div>
          ${days.map((day) => {
            const key = dateKey(day);
            const time = `${String(Math.floor(minute / 60)).padStart(2,'0')}:${String(minute % 60).padStart(2,'0')}`;
            const slotStart = dateAt(key, time);
            const slotEnd = new Date(slotStart.getTime() + renderSlotMinutes * 60000);
            const chips = visibleItems.map(normalizeRangeItem).flatMap(({ item, range }) => {
              if (!rangeItemIsTimed(item)) return [];
              return timedSegments(item, range, viewStart, viewEnd).filter(({ segmentRange }) => (
                segmentRange.start < slotEnd && segmentRange.end > slotStart && dateKey(segmentRange.start) === key && rowStartMinute(segmentRange.start) === minute
              ));
            });
            return `<div class="prs-slot ${dayTemporalClass(day)} ${chips.length ? 'has-chip' : ''}" data-prs-date="${esc(key)}" data-prs-time="${esc(time)}">${chips.map(({ item, range, segmentRange, continuesBefore, continuesAfter, beginsHere }) => {
              const chipHeight = chipHeightForRange(segmentRange.start, segmentRange.end);
              return workChipHtml({ ...item, all_day:false, schedule_granularity:'time' }, range, {
                draft: item.__draft === true || item.id === '__draft',
                suspended: item.__draft === true && item.__activeDraft !== true,
                confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function',
                mode,
                day: key,
                chipClass: `${chipHeight <= 64 ? 'compact-confirm' : ''} ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`,
                chipStyle: `top:${chipOffsetTop(segmentRange.start)}px;height:${chipHeight}px;min-height:${chipHeight}px`,
                showDetails: beginsHere,
                showStartHandle: !continuesBefore,
                showEndHandle: !continuesAfter
              });
            }).join('')}</div>`;
          }).join('')}
        `).join(''))}
      </div></div>`;
    };
    const previousSurface = container.querySelector('.prs-surface');
    const previousScrollTop = previousSurface ? Number(previousSurface.scrollTop || 0) : 0;
    const previousScrollLeft = previousSurface ? Number(previousSurface.scrollLeft || 0) : 0;
    container.innerHTML = `<div class="prs-wrap ${readOnly ? 'readonly' : ''} ${allowEventDrag ? '' : 'events-click-only'} ${showToolbar ? '' : 'no-toolbar'} ${options.mobileLayout === true ? 'mobile-layout' : ''} ${mode === 'list' ? 'list-mode' : ''}">${showToolbar ? toolbar : ''}${mode === 'list' ? renderList() : mode === 'month' ? renderMonth() : renderTimed()}</div>`;
    if (!['list','month'].includes(mode) && (previousScrollTop > 0 || previousScrollLeft > 0)) {
      const scroll = container.querySelector('.prs-surface');
      if (scroll) {
        scroll.scrollTop = previousScrollTop;
        scroll.scrollLeft = previousScrollLeft;
      }
    } else if (!['list','month'].includes(mode) && Number.isFinite(Number(options.initialScrollMinute))) {
      const scroll = container.querySelector('.prs-surface');
      const timeGrid = container.querySelector('.prs-time-grid:not(.prs-time-header-grid)');
      if (scroll && timeGrid) {
        const initialMinute = Math.max(workStart, Math.min(workEnd - renderSlotMinutes, Number(options.initialScrollMinute)));
        const rowOffset = ((initialMinute - workStart) / renderSlotMinutes) * slotHeight;
        scroll.scrollTop = Math.max(0, timeGrid.offsetTop + rowOffset - 42);
      }
    }
    container.querySelectorAll('[data-prs-nav]').forEach((btn) => btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.prsNav || 0);
      const next = new Date(anchor);
      if (mode === 'month') next.setMonth(next.getMonth() + delta);
      else next.setDate(next.getDate() + delta * navDayCount);
      options.onNavigate?.(next, delta);
    }));
    container.querySelector('[data-prs-today]')?.addEventListener('click', () => options.onNavigate?.(new Date(), 0));
    container.querySelectorAll('.prs-view-btn[data-prs-mode]').forEach((btn) => btn.addEventListener('click', () => options.onModeChange?.(btn.dataset.prsMode || 'month')));
    container.querySelectorAll('[data-prs-list-event-id]').forEach((button) => button.addEventListener('click', () => {
      const item = eventByRenderedId(button.dataset.prsListEventId || '');
      if (item) options.onEventClick?.(item, { element:button, action:'view' });
    }));
    const monthWeekRows = () => [...container.querySelectorAll('.prs-month-week')];
    const setMonthWeekTrayHeight = (row, height) => {
      const pixels = `${Math.max(124, Number(height || 124))}px`;
      row.style.height = pixels;
      row.style.minHeight = pixels;
      row.style.flexBasis = pixels;
      row.style.flexGrow = '0';
      row.style.flexShrink = '0';
      if (row.__prsMonthTrayAnchorSurface) {
        void row.offsetHeight;
        row.__prsMonthTrayAnchorSurface.scrollTop = row.__prsMonthTrayAnchorScrollTop;
      }
    };
    const lockMonthWeekTrayRows = (activeWeek = null) => {
      const rows = monthWeekRows();
      const siblingHeights = rows.filter((row) => row !== activeWeek && !row.classList.contains('expanded'))
        .map((row) => row.getBoundingClientRect().height)
        .filter((height) => Number.isFinite(height) && height >= 124);
      const collapsedReference = siblingHeights.length ? Math.min(...siblingHeights) : 124;
      rows.forEach((row) => {
        const measuredHeight = row.getBoundingClientRect().height;
        if (!row.dataset.prsMonthTrayBaseHeight) {
          const baseHeight = row === activeWeek && row.classList.contains('expanded') ? collapsedReference : measuredHeight;
          row.dataset.prsMonthTrayBaseHeight = String(Math.max(124, baseHeight));
        }
        setMonthWeekTrayHeight(row, measuredHeight);
      });
    };
    const releaseMonthWeekTrayRows = () => {
      if (container.querySelector('.prs-month-week.expanded')) return;
      monthWeekRows().forEach((row) => {
        row.style.removeProperty('height');
        row.style.removeProperty('min-height');
        row.style.removeProperty('flex-basis');
        row.style.removeProperty('flex-grow');
        row.style.removeProperty('flex-shrink');
        delete row.dataset.prsMonthTrayBaseHeight;
      });
    };
    const holdMonthWeekTrayAnchor = (week, duration = 340) => {
      const surface = week.closest('.prs-surface');
      if (!surface) return;
      if (week.__prsMonthTrayAnchorFrame) cancelAnimationFrame(week.__prsMonthTrayAnchorFrame);
      const hoverAnchor = week.__prsMonthTrayHoverAnchor;
      const anchorTop = Number.isFinite(hoverAnchor?.top) ? hoverAnchor.top : week.getBoundingClientRect().top;
      const anchorScrollTop = Number.isFinite(hoverAnchor?.scrollTop) ? hoverAnchor.scrollTop : surface.scrollTop;
      surface.scrollTop = anchorScrollTop;
      const startedAt = Date.now();
      week.__prsMonthTrayAnchorSurface = surface;
      week.__prsMonthTrayAnchorScrollTop = anchorScrollTop;
      const hold = () => {
        const delta = week.getBoundingClientRect().top - anchorTop;
        if (Math.abs(delta) > 0.5) surface.scrollTop += delta;
        if (Date.now() - startedAt < duration) week.__prsMonthTrayAnchorFrame = requestAnimationFrame(hold);
        else {
          week.__prsMonthTrayAnchorFrame = null;
          week.__prsMonthTrayAnchorSurface = null;
          week.__prsMonthTrayAnchorScrollTop = null;
          week.__prsMonthTrayHoverAnchor = null;
        }
      };
      week.__prsMonthTrayAnchorFrame = requestAnimationFrame(hold);
    };
    container.querySelectorAll('[data-prs-month-overflow]').forEach((btn) => {
      const week = btn.closest('.prs-month-week');
      if (!week) return;
      const dayIndex = String(btn.dataset.prsMonthDay || '');
      const peek = week.querySelector(`[data-prs-month-day-peek="${dayIndex}"]`);
      const resetPeeks = () => {
        week.querySelectorAll('[data-prs-month-day-peek]').forEach((node) => {
          node.classList.remove('active','is-controller');
          node.style.setProperty('--prs-month-day-scroll-y', '0px');
        });
      };
      const peekAtOverflow = () => {
        if (week.classList.contains('expanded') || !peek) return;
        const surface = week.closest('.prs-surface');
        week.__prsMonthTrayHoverAnchor = {
          top:week.getBoundingClientRect().top,
          scrollTop:surface?.scrollTop || 0,
        };
        resetPeeks();
        const scroll = Math.max(0, Number(btn.dataset.prsMonthScroll || 0));
        const scrollSteps = Math.max(0, Number(btn.dataset.prsMonthScrollSteps || 0));
        const duration = scrollSteps <= 4 ? 180 : Math.min(1800, 280 + (scrollSteps - 4) * 180);
        peek.style.setProperty('--prs-month-day-scroll-duration', `${duration}ms`);
        peek.style.setProperty('--prs-month-day-scroll-y', '0px');
        peek.classList.add('active');
        void peek.offsetHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (peek.classList.contains('active') && !week.classList.contains('expanded')) {
            peek.style.setProperty('--prs-month-day-scroll-y', `${-scroll}px`);
          }
        }));
      };
      const resetOverflowPeek = () => {
        if (!week.classList.contains('expanded')) resetPeeks();
      };
      btn.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        btn.setPointerCapture?.(event.pointerId);
      });
      btn.addEventListener('pointerenter', peekAtOverflow);
      btn.addEventListener('pointerleave', resetOverflowPeek);
      btn.addEventListener('focus', peekAtOverflow);
      btn.addEventListener('blur', resetOverflowPeek);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        btn.blur();
        const expanded = week.classList.contains('expanded') && btn.classList.contains('is-controller');
        lockMonthWeekTrayRows(week);
        holdMonthWeekTrayAnchor(week);
        if (week.__prsMonthTrayTimer) clearTimeout(week.__prsMonthTrayTimer);
        resetPeeks();
        week.querySelectorAll('[data-prs-month-overflow]').forEach((control) => {
          const count = Math.max(0, Number(control.dataset.prsMonthCount || 0));
          control.classList.remove('is-controller');
          control.setAttribute('aria-expanded', 'false');
          control.setAttribute('aria-label', ((v0,v1) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_38fb2efd2cc400",`Show ${v0} more ${v1}`,{v0,v1}) ?? `Show ${v0} more ${v1}`)(count,count === 1 ? 'item' : 'items'));
        });
        if (!expanded) {
          const expandedHeight = Math.max(124, Number(btn.dataset.prsMonthExpandedHeight || 124));
          week.style.setProperty('--prs-month-expanded-height', `${expandedHeight}px`);
          week.classList.remove('collapsing');
          week.classList.add('expanded');
          btn.classList.add('is-controller');
          btn.setAttribute('aria-expanded', 'true');
          btn.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("platform-schedule-view","m_4c1e003542095e","Show fewer items") ?? "Show fewer items"));
          void week.offsetHeight;
          requestAnimationFrame(() => setMonthWeekTrayHeight(week, expandedHeight));
        } else {
          const collapsedHeight = Math.max(124, Number(week.dataset.prsMonthTrayBaseHeight || 124));
          week.style.setProperty('--prs-month-expanded-height', '124px');
          week.classList.add('collapsing');
          week.classList.remove('expanded');
          void week.offsetHeight;
          requestAnimationFrame(() => setMonthWeekTrayHeight(week, collapsedHeight));
          week.__prsMonthTrayTimer = setTimeout(() => {
            week.classList.remove('collapsing');
            week.__prsMonthTrayTimer = null;
            releaseMonthWeekTrayRows();
          }, 320);
        }
        options.onMonthExpansionChange?.([...container.querySelectorAll('[data-prs-month-overflow].is-controller')].map((control) => control.dataset.prsMonthDate).filter(Boolean));
      });
    });
    container.querySelectorAll('[data-prs-week-all-day-overflow]').forEach((btn) => {
      const band = btn.closest('.prs-all-day-grid.week-overflow');
      if (!band) return;
      const resetPeek = () => {
        band.style.setProperty('--prs-week-all-day-scroll-y', '0px');
      };
      const previewOverflow = () => {
        if (band.classList.contains('expanded')) return;
        const scroll = Math.max(0, Number(btn.dataset.prsWeekAllDayScroll || 0));
        const steps = Math.max(0, Number(btn.dataset.prsWeekAllDayScrollSteps || 0));
        const duration = steps <= 4 ? 180 : Math.min(1800, 280 + (steps - 4) * 180);
        band.style.setProperty('--prs-week-all-day-scroll-duration', `${duration}ms`);
        resetPeek();
        void band.offsetHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!band.classList.contains('expanded')) band.style.setProperty('--prs-week-all-day-scroll-y', `${-scroll}px`);
        }));
      };
      btn.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        btn.setPointerCapture?.(event.pointerId);
      });
      btn.addEventListener('pointerenter', previewOverflow);
      btn.addEventListener('pointerleave', resetPeek);
      btn.addEventListener('focus', previewOverflow);
      btn.addEventListener('blur', resetPeek);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetPeek();
        const expanded = !band.classList.contains('expanded') || !btn.classList.contains('is-controller');
        band.classList.toggle('expanded', expanded);
        band.querySelectorAll('[data-prs-week-all-day-overflow]').forEach((control) => {
          const count = Math.max(0, Number(control.dataset.prsWeekAllDayCount || 0));
          control.classList.remove('is-controller');
          control.setAttribute('aria-expanded', 'false');
          control.setAttribute('aria-label', ((v0,v1) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_df608fef6e546a",`Show ${v0} more all-day ${v1}`,{v0,v1}) ?? `Show ${v0} more all-day ${v1}`)(count,count === 1 ? 'item' : 'items'));
        });
        if (expanded) {
          btn.classList.add('is-controller');
          btn.setAttribute('aria-expanded', 'true');
          btn.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("platform-schedule-view","m_3935fe13124b65","Show fewer all-day items") ?? "Show fewer all-day items"));
        }
        const height = Math.max(54, Number(expanded ? band.dataset.prsWeekAllDayExpandedHeight : band.dataset.prsWeekAllDayCollapsedHeight));
        band.style.height = `${height}px`;
        band.style.minHeight = `${height}px`;
        band.style.gridTemplateRows = `${height}px`;
        const weekKey = String(band.dataset.prsWeekAllDayKey || '');
        const nextExpanded = new Set((Array.isArray(options.expandedMonthDates) ? options.expandedMonthDates : []).map(String));
        if (expanded && weekKey) nextExpanded.add(weekKey);
        else nextExpanded.delete(weekKey);
        options.onMonthExpansionChange?.([...nextExpanded]);
      });
    });

    let drag = null;
    const touchHoldToPlace = options.touchHoldToPlace === true;
    const touchSwipeNavigation = mode !== 'list' && (options.touchSwipeNavigation === true || touchHoldToPlace);
    const touchHoldDelayMs = Math.max(250, Number(options.touchHoldDelayMs || 360) || 360);
    let pendingTouchHold = null;
    let suppressTouchClickUntil = 0;
    let suppressTouchGestureClickUntil = 0;
    let touchGesture = null;
    const touchGestureScroller = container.querySelector('.prs-surface');
    const cancelTouchHold = () => {
      if (!pendingTouchHold) return;
      window.clearTimeout(pendingTouchHold.timer);
      pendingTouchHold = null;
    };
    const armTouchHold = (event, activate) => {
      if (!touchHoldToPlace || event.pointerType !== 'touch') return false;
      cancelTouchHold();
      suppressTouchClickUntil = Date.now() + 700;
      const pending = {
        pointerId:event.pointerId,
        startX:event.clientX,
        startY:event.clientY,
        timer:null
      };
      pending.timer = window.setTimeout(() => {
        if (pendingTouchHold !== pending) return;
        pendingTouchHold = null;
        activate();
      }, touchHoldDelayMs);
      pendingTouchHold = pending;
      return true;
    };
    const cancelTouchHoldForMovement = (event) => {
      if (!pendingTouchHold || pendingTouchHold.pointerId !== event.pointerId) return;
      const dx = Number(event.clientX) - pendingTouchHold.startX;
      const dy = Number(event.clientY) - pendingTouchHold.startY;
      if (Math.hypot(dx, dy) > POINTER_DRAG_THRESHOLD) cancelTouchHold();
    };
    const beginTouchGesture = (event) => {
      if (!touchSwipeNavigation || event.pointerType !== 'touch') return;
      touchGesture = {
        pointerId:event.pointerId,
        startX:event.clientX,
        startY:event.clientY,
        lastY:event.clientY,
        startedAt:Date.now(),
        startScrollTop:Number(touchGestureScroller?.scrollTop || 0),
        intent:''
      };
    };
    const updateTouchGesture = (event) => {
      if (!touchGesture || touchGesture.pointerId !== event.pointerId) return;
      if (drag?.touchHeld) {
        touchGesture.intent = 'drag';
        event.preventDefault();
        return;
      }
      const dx = Number(event.clientX) - touchGesture.startX;
      const dy = Number(event.clientY) - touchGesture.startY;
      if (!touchGesture.intent && Math.hypot(dx, dy) > POINTER_DRAG_THRESHOLD) {
        touchGesture.intent = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'navigate' : 'scroll';
        suppressTouchGestureClickUntil = Date.now() + 350;
        if (touchGesture.intent !== 'navigate') cancelTouchHold();
      }
      if (touchGesture.intent === 'scroll') {
        if (touchGestureScroller) touchGestureScroller.scrollTop = Math.max(0, touchGesture.startScrollTop - dy);
        touchGesture.lastY = event.clientY;
        event.preventDefault();
      } else if (touchGesture.intent === 'navigate') {
        cancelTouchHold();
        event.preventDefault();
      }
    };
    const finishTouchGesture = (event) => {
      if (!touchGesture || touchGesture.pointerId !== event.pointerId) return false;
      const gesture = touchGesture;
      touchGesture = null;
      if (gesture.intent !== 'navigate' || drag) return false;
      const dx = Number(event.clientX) - gesture.startX;
      const dy = Number(event.clientY) - gesture.startY;
      if (Date.now() - gesture.startedAt > 700 || Math.abs(dx) < 52 || Math.abs(dx) <= Math.abs(dy) * 1.15) return false;
      const delta = dx < 0 ? 1 : -1;
      const next = new Date(anchor);
      if (mode === 'month') next.setMonth(next.getMonth() + delta);
      else next.setDate(next.getDate() + delta * navDayCount);
      options.onNavigate?.(next, delta, { source:'swipe' });
      return true;
    };
    const pointRange = (target, pointerEvent = null) => {
      const cell = target.closest?.('.prs-day[data-prs-date],.prs-all-day-cell[data-prs-date],.prs-slot[data-prs-date]');
      if (!cell) return null;
      const day = cell.dataset.prsDate;
      if (mode === 'month' || cell.dataset.prsAllday === '1') return { start: dateAt(day, '00:00'), end: addDays(dateAt(day, '00:00'), 1), allDay: true, granularity: 'date' };
      const time = cell.dataset.prsTime || '08:00';
      const rowStart = dateAt(day, time);
      let snapOffsetMinutes = 0;
      if (pointerEvent) {
        const rect = cell.getBoundingClientRect();
        const y = Math.max(0, Math.min(rect.height, Number(pointerEvent.clientY || 0) - rect.top));
        const rawOffset = (y / Math.max(1, rect.height)) * renderSlotMinutes;
        snapOffsetMinutes = Math.min(renderSlotMinutes - snapMinutes, Math.max(0, Math.floor(rawOffset / snapMinutes) * snapMinutes));
      }
      const start = new Date(rowStart.getTime() + snapOffsetMinutes * 60000);
      return { start, end: new Date(start.getTime() + snapMinutes * 60000), allDay: false, granularity: 'time' };
    };
    const quickClickRange = (target, pointerEvent) => {
      const pointerSlot = pointerEvent ? Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((node) => {
        const rect = node.getBoundingClientRect();
        const x = Number(pointerEvent.clientX);
        const y = Number(pointerEvent.clientY);
        return Number.isFinite(x) && Number.isFinite(y) && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      }) : null;
      const cell = target.closest?.('.prs-slot[data-prs-date][data-prs-time]') || pointerSlot;
      const base = cell ? pointRange(cell, null) : pointRange(target, null);
      if (!base || base.allDay) return base;
      if (!cell) return base;
      const rect = cell.getBoundingClientRect();
      const y = Math.max(0, Math.min(rect.height, Number(pointerEvent?.clientY || 0) - rect.top));
      const minute = base.start.getHours() * 60 + base.start.getMinutes() + (y >= rect.height / 2 ? 30 : 0);
      const start = dateAt(cell.dataset.prsDate, timeString(minute));
      return { start, end: new Date(start.getTime() + 60 * 60000), allDay: false, granularity: 'time' };
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
      const allDayCell = Array.from(container.querySelectorAll('.prs-all-day-cell[data-prs-date]')).find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (allDayCell) return pointRange(allDayCell, event);
      const slot = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      return slot ? pointRange(slot, event) : null;
    };
    const rangeFromPointer = (event) => {
      const geometricRange = mode === 'month' ? rangeFromMonthPointer(event) : rangeFromTimedPointer(event);
      if (geometricRange) return geometricRange;
      const node = document.elementFromPoint?.(event.clientX, event.clientY);
      return node ? pointRange(node, event) : null;
    };
    const eventForDragTarget = (event, activeDrag = drag) => {
      if (mode === 'month' || activeDrag?.kind !== 'move' || !rangeItemIsTimed(activeDrag?.item)) return event;
      const x = Number(event.clientX);
      const y = Number(event.clientY);
      const slot = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((node) => {
        const rect = node.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      });
      if (!slot) return event;
      const rect = slot.getBoundingClientRect();
      const pixelsPerMinute = rect.height / Math.max(1, renderSlotMinutes);
      return { clientX:x, clientY:y - TIMED_MOVE_CURSOR_OFFSET_MINUTES * pixelsPerMinute, target:event.target };
    };
    const rangeForDragTarget = (event, activeDrag = drag) => {
      const adjustedEvent = eventForDragTarget(event, activeDrag);
      return rangeFromPointer(adjustedEvent) || pointRange(event.target, adjustedEvent);
    };
    let localActiveDraft = activeDraft;
    const composeDraft = (range, extra = {}) => {
      if (!range) return;
      const defaultPayload = typeof options.defaultDraftPayload === 'function'
        ? (options.defaultDraftPayload(range) || {})
        : (options.defaultDraftPayload || {});
      const resetExisting = extra.resetExisting === true;
      const baseDraft = resetExisting ? {} : (localActiveDraft || activeDraft || {});
      const activeBase = resetExisting ? {} : (activeDraft || {});
      const durationMs = extra.useDefaultDuration === true ? Math.max(0, Number(defaultPayload.default_duration_ms || 0)) : 0;
      const resolvedEnd = durationMs > 0 ? new Date(new Date(range.start).getTime() + durationMs) : range.end;
      const nextDraft = {
        ...baseDraft,
        ...defaultPayload,
        ...extra,
        id: extra.id || defaultPayload.id || baseDraft.id || activeBase.id || activeDraftId || '__draft',
        title: extra.title || defaultPayload.title || baseDraft.title || activeBase.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        start: range.start,
        end: resolvedEnd,
        all_day: range.allDay,
        schedule_granularity: range.granularity,
      };
      delete nextDraft.resetExisting;
      delete nextDraft.useDefaultDuration;
      return nextDraft;
    };
    const publishDraft = (range, extra = {}) => {
      const nextDraft = composeDraft(range, extra);
      if (!nextDraft) return;
      const rendered = upsertDraft(nextDraft);
      options.onDraftChange?.(nextDraft);
      return rendered || nextDraft;
    };
    const pointerDistance = (event, activeDrag = drag) => {
      if (!activeDrag) return 0;
      return Math.hypot(Number(event.clientX || 0) - Number(activeDrag.startX || 0), Number(event.clientY || 0) - Number(activeDrag.startY || 0));
    };
    const reflowTimedOverlaps = () => {
      if (mode === 'month') return;
      const compactMobileWeek = options.mobileLayout === true && mode === 'week';
      const placedLeftInset = compactMobileWeek ? 1 : 0;
      const placedRightGutter = compactMobileWeek ? 1 : TIMED_PLACED_RIGHT_GUTTER_PX;
      const chips = Array.from(container.querySelectorAll('.prs-time-grid:not(.prs-time-header-grid) .prs-work-chip.timed'));
      chips.forEach((chip) => {
        const preview = chip.classList.contains('live-preview');
        chip.style.left = preview ? '0px' : `${placedLeftInset}px`;
        chip.style.right = preview ? '0px' : `${placedRightGutter}px`;
        chip.style.width = 'auto';
        chip.style.zIndex = '3';
        delete chip.dataset.prsOverlapDepth;
        delete chip.dataset.prsOverlapInsetLeft;
        delete chip.dataset.prsOverlapInsetRight;
        delete chip.dataset.prsColumnRightGutter;
        delete chip.dataset.prsOverlapColumn;
        delete chip.dataset.prsOverlapColumns;
      });
      const entriesByDay = new Map();
      chips.filter((chip) => !chip.classList.contains('dragging')).forEach((chip, sourceIndex) => {
        const day = clean(chip.dataset.prsDay);
        const rangeStart = new Date(chip.dataset.prsRangeStart || '');
        const rangeEnd = new Date(chip.dataset.prsRangeEnd || '');
        if (!day || !Number.isFinite(rangeStart.getTime()) || !Number.isFinite(rangeEnd.getTime()) || rangeEnd <= rangeStart) return;
        const dayStart = dateAt(day, '00:00');
        const dayEnd = addDays(dayStart, 1);
        const segmentStart = rangeStart > dayStart ? rangeStart : dayStart;
        const segmentEnd = rangeEnd < dayEnd ? rangeEnd : dayEnd;
        if (segmentEnd <= segmentStart) return;
        const headerEnd = new Date(Math.min(rangeEnd.getTime(), rangeStart.getTime() + TIMED_HEADER_DURATION_MS));
        const headerVisible = rangeStart < dayEnd && headerEnd > dayStart;
        if (!entriesByDay.has(day)) entriesByDay.set(day, []);
        entriesByDay.get(day).push({
          chip,
          sourceIndex,
          start:segmentStart,
          end:segmentEnd,
          preview:chip.classList.contains('live-preview'),
          headerStart:headerVisible ? rangeStart : null,
          headerEnd:headerVisible ? headerEnd : null,
        });
      });
      const edgePosition = (fraction, pixels) => {
        const percent = Math.round(fraction * 1000000) / 10000;
        pixels = Math.round(pixels * 10000) / 10000;
        if (!percent) return `${pixels}px`;
        if (!pixels) return `${percent}%`;
        return `calc(${percent}% ${pixels < 0 ? '-' : '+'} ${Math.abs(pixels)}px)`;
      };
      entriesByDay.forEach((entries) => {
        layoutTimedOverlapEntries(entries).forEach((layout) => {
          const insetLeft = Number(layout.insetLeft || 0);
          const insetRight = Number(layout.insetRight || 0);
          const leftInset = layout.preview ? 0 : placedLeftInset;
          const rightGutter = layout.preview ? 0 : placedRightGutter;
          const geometry = timedOverlapColumnGeometry(layout, rightGutter);
          layout.chip.style.left = edgePosition(geometry.leftFraction, geometry.leftPixels + leftInset);
          layout.chip.style.right = edgePosition(geometry.rightFraction, geometry.rightPixels);
          layout.chip.style.zIndex = String(3 + layout.stackOrder);
          layout.chip.dataset.prsOverlapDepth = String(layout.stackDepth);
          layout.chip.dataset.prsOverlapInsetLeft = String(insetLeft);
          layout.chip.dataset.prsOverlapInsetRight = String(insetRight);
          layout.chip.dataset.prsColumnRightGutter = String(rightGutter);
          layout.chip.dataset.prsOverlapColumn = String(layout.columnIndex);
          layout.chip.dataset.prsOverlapColumns = String(layout.columnCount);
        });
      });
    };
    const restorePreviewLaneLayout = () => {
      container.querySelectorAll('[data-prs-preview-original-margin]').forEach((node) => {
        node.style.marginTop = node.getAttribute('data-prs-preview-original-margin') || '';
        node.removeAttribute('data-prs-preview-original-margin');
      });
      container.querySelectorAll('[data-prs-preview-original-min-height]').forEach((node) => {
        node.style.minHeight = node.getAttribute('data-prs-preview-original-min-height') || '';
        node.removeAttribute('data-prs-preview-original-min-height');
      });
      container.querySelectorAll('[data-prs-preview-original-rows]').forEach((node) => {
        node.style.gridTemplateRows = node.getAttribute('data-prs-preview-original-rows') || '';
        node.style.height = node.getAttribute('data-prs-preview-original-height') || '';
        node.style.minHeight = node.getAttribute('data-prs-preview-original-min-height-band') || '';
        node.removeAttribute('data-prs-preview-original-rows');
        node.removeAttribute('data-prs-preview-original-height');
        node.removeAttribute('data-prs-preview-original-min-height-band');
      });
      container.querySelectorAll('.prs-month-week.preview-expanded').forEach((node) => node.classList.remove('preview-expanded'));
    };
    const clearLivePreview = () => {
      container.querySelectorAll('.live-preview').forEach((node) => node.remove());
      restorePreviewLaneLayout();
      reflowTimedOverlaps();
    };
    const clearDragMarkers = () => {
      container.querySelectorAll('.in-range,.drag-over').forEach((node) => node.classList.remove('in-range','drag-over'));
      clearLivePreview();
    };
    const previewTitle = (activeDrag = drag) => activeDrag?.item?.title || activeDraft?.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event");
    const renderMonthPreview = (start, end, activeDrag = drag, clear = true) => {
      if (clear) clearLivePreview();
      if (mode !== 'month' || !start || !end || end <= start) return;
      const timedMonth = activeDrag?.item && rangeItemIsTimed(activeDrag.item);
      const displayStart = timedMonth ? dateAt(dateKey(start), '00:00') : start;
      const displayEnd = timedMonth ? addDays(displayStart, 1) : end;
      const previewItem = {
        ...objectValue(activeDrag?.item),
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
        node.style.zIndex = activeDrag?.item?.__previewPrimary === true ? '12' : '11';
        node.style.gridColumn = `${startCol}/${endCol}`;
        const rowKey = dateKey(weekStart);
        const previewLane = Number(activeDrag?.item?.__previewLaneByRow?.[rowKey]);
        node.style.marginTop = Number.isFinite(previewLane) ? `${MONTH_ITEM_TOP_PX + previewLane * MONTH_ITEM_STEP_PX}px` : (activeDrag?.wrapper?.style?.marginTop || activeDrag?.node?.closest?.('.prs-month-bar')?.style?.marginTop || `${MONTH_ITEM_TOP_PX}px`);
        node.dataset.prsDate = dateKey(segmentStart);
        node.innerHTML = workChipHtml(previewItem, timedMonth ? { start, end } : { start: segmentStart, end: segmentEnd }, {
          draft: false,
          preview: true,
          mode,
          day: dateKey(segmentStart),
          chipClass: timedMonth ? 'timed-month' : '',
          showDetails: beginsHere,
          showTime: false,
          showSecondary: false,
          showStartHandle: false,
          showEndHandle: false
        });
        (weekEl.querySelector('.prs-month-item-track') || weekEl).appendChild(node);
      });
    };
    const renderTimedPreview = (start, end, activeDrag = drag, clear = true) => {
      if (clear) clearLivePreview();
      if (mode === 'month' || !start || !end || end <= start) return;
      const previewItem = {
        ...objectValue(activeDrag?.item),
        id: '__preview',
        title: previewTitle(activeDrag),
        all_day: false,
        schedule_granularity: 'time',
      };
      timedSegments(previewItem, { start, end }).forEach(({ segmentRange, continuesBefore, continuesAfter, beginsHere }) => {
        const day = dateKey(segmentRange.start);
        const time = timeString(rowStartMinute(segmentRange.start));
        const target = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((slot) => slot.dataset.prsDate === day && slot.dataset.prsTime === time);
        if (!target) return;
        const holder = document.createElement('div');
        holder.innerHTML = workChipHtml(previewItem, { start, end }, {
          draft: false,
          preview: true,
          mode,
          day,
          showDetails: beginsHere,
          showTime: true,
          showStartHandle: false,
          showEndHandle: false,
          chipClass: `${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`,
          chipStyle: `top:${chipOffsetTop(segmentRange.start)}px;height:${chipHeightForRange(segmentRange.start, segmentRange.end)}px;min-height:${chipHeightForRange(segmentRange.start, segmentRange.end)}px`
        });
        const chip = holder.firstElementChild;
        if (!chip) return;
        chip.classList.add('live-preview');
        target.appendChild(chip);
      });
      reflowTimedOverlaps();
    };
    const renderAllDayBandPreview = (start, end, activeDrag = drag, clear = true) => {
      if (clear) clearLivePreview();
      if (mode === 'month' || !start || !end || end <= start) return;
      const band = container.querySelector('.prs-all-day-grid');
      const firstDay = band?.querySelector?.('.prs-all-day-cell[data-prs-date]');
      if (!band || !firstDay) return;
      const dayCells = Array.from(band.querySelectorAll('.prs-all-day-cell[data-prs-date]'));
      const bandStart = dateAt(firstDay.dataset.prsDate, '00:00');
      const bandEnd = addDays(bandStart, dayCells.length || 1);
      const displayStart = start > bandStart ? start : bandStart;
      const displayEnd = end < bandEnd ? end : bandEnd;
      if (displayStart >= bandEnd || displayEnd <= bandStart) return;
      const startCol = Math.max(1, Math.min(dayCells.length || 1, dayDiff(bandStart, displayStart) + 1));
      const gridStartCol = startCol + 1;
      const endCol = Math.max(gridStartCol + 1, Math.min((dayCells.length || 1) + 2, dayDiff(bandStart, displayEnd) + 2));
      const continuesBefore = start < bandStart;
      const continuesAfter = end > bandEnd;
      const beginsHere = start >= bandStart && start < bandEnd;
      const previewItem = {
        ...objectValue(activeDrag?.item),
        id: '__preview',
        title: previewTitle(activeDrag),
        all_day: true,
        schedule_granularity: 'date',
      };
      const node = document.createElement('div');
      node.className = `prs-all-day-bar-top live-preview ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`;
      node.style.zIndex = activeDrag?.item?.__previewPrimary === true ? '12' : '11';
      node.style.gridColumn = `${gridStartCol}/${endCol}`;
      node.style.gridRow = '1';
      const rowKey = dateKey(bandStart);
      const previewLane = Number(activeDrag?.item?.__previewLaneByRow?.[rowKey]);
      const previewTop = mode === 'week' ? WEEK_ALL_DAY_ITEM_TOP_PX : 6;
      const previewStep = mode === 'week' ? WEEK_ALL_DAY_ITEM_STEP_PX : 48;
      node.style.marginTop = Number.isFinite(previewLane) ? `${previewTop + previewLane * previewStep}px` : (activeDrag?.wrapper?.style?.marginTop || activeDrag?.node?.closest?.('.prs-all-day-bar-top')?.style?.marginTop || `${previewTop}px`);
      node.dataset.prsDate = dateKey(displayStart);
      node.innerHTML = workChipHtml(previewItem, { start: displayStart, end: displayEnd }, {
        draft: false,
        preview: true,
        mode: 'month',
        day: dateKey(displayStart),
        showDetails: beginsHere,
        showTime: false,
        showStartHandle: false,
        showEndHandle: false
      });
      band.appendChild(node);
    };
    const renderRangePreview = (start, end, activeDrag = drag, clear = true) => {
      if (mode === 'month') renderMonthPreview(start, end, activeDrag, clear);
      else if (activeDrag?.anchor?.allDay === true || (activeDrag?.item && !rangeItemIsTimed(activeDrag.item))) renderAllDayBandPreview(start, end, activeDrag, clear);
      else renderTimedPreview(start, end, activeDrag, clear);
    };
    const placementDraftsForRange = (range) => {
      const primary = composeDraft(range, { resetExisting:true, useDefaultDuration:true });
      if (!primary) return [];
      const derived = typeof options.derivePlacementDrafts === 'function' ? options.derivePlacementDrafts(primary) : [primary];
      return prioritizePrimaryPlacementDraft(primary, derived);
    };
    const layoutClickPlacementPreviews = (drafts = []) => {
      const rows = mode === 'month'
        ? Array.from(container.querySelectorAll('.prs-month-week')).map((node) => {
            const firstDay = node.querySelector('.prs-day[data-prs-date]');
            const start = firstDay ? dateAt(firstDay.dataset.prsDate, '00:00') : null;
            return start ? { key:dateKey(start), node, start, end:addDays(start, 7), firstColumn:1, base:MONTH_ITEM_TOP_PX, step:MONTH_ITEM_STEP_PX, chipHeight:24, wrapperSelector:'.prs-month-bar:not(.live-preview)' } : null;
          }).filter(Boolean)
        : (() => {
            const node = container.querySelector('.prs-all-day-grid');
            const cells = Array.from(node?.querySelectorAll?.('.prs-all-day-cell[data-prs-date]') || []);
            const start = cells[0] ? dateAt(cells[0].dataset.prsDate, '00:00') : null;
            const compactAllDay = mode === 'week';
            return node && start ? [{ key:dateKey(start), node, start, end:addDays(start, cells.length || 1), firstColumn:2, base:compactAllDay ? WEEK_ALL_DAY_ITEM_TOP_PX : 6, step:compactAllDay ? WEEK_ALL_DAY_ITEM_STEP_PX : 48, chipHeight:compactAllDay ? WEEK_ALL_DAY_ITEM_HEIGHT_PX : 42, wrapperSelector:'.prs-all-day-bar-top:not(.live-preview)' }] : [];
          })();
      const previewSegments = [];
      drafts.forEach((draft, draftIndex) => {
        const start = new Date(draft.start);
        const end = new Date(draft.end);
        rows.forEach((row) => {
          if (start >= row.end || end <= row.start) return;
          const segmentStart = start > row.start ? start : row.start;
          const segmentEnd = end < row.end ? end : row.end;
          previewSegments.push({
            id:`preview:${draftIndex}:${row.key}`,
            draftIndex,
            rowKey:row.key,
            startCol:Math.max(row.firstColumn, dayDiff(row.start, segmentStart) + row.firstColumn),
            endCol:Math.max(row.firstColumn + 1, dayDiff(row.start, segmentEnd) + row.firstColumn)
          });
        });
      });
      const existingSegments = [];
      rows.forEach((row) => {
        Array.from(row.node.querySelectorAll(row.wrapperSelector)).forEach((node, nodeIndex) => {
          const columns = String(node.style.gridColumn || '').split('/').map((value) => Number.parseInt(value, 10));
          if (!Number.isFinite(columns[0]) || !Number.isFinite(columns[1])) return;
          const margin = Number.parseFloat(node.style.marginTop || String(row.base));
          existingSegments.push({
            id:`existing:${row.key}:${nodeIndex}`,
            node,
            rowKey:row.key,
            startCol:columns[0],
            endCol:columns[1],
            originalLane:Math.max(0, Math.round((margin - row.base) / row.step))
          });
        });
      });
      const packed = packPreviewLaneSegments(previewSegments, existingSegments);
      const laneByDraft = drafts.map(() => ({}));
      packed.previews.forEach((entry) => { laneByDraft[entry.draftIndex][entry.rowKey] = entry.lane; });
      packed.existing.forEach((entry) => {
        if (!entry.node.hasAttribute('data-prs-preview-original-margin')) entry.node.setAttribute('data-prs-preview-original-margin', entry.node.style.marginTop || '');
        const row = rows.find((item) => item.key === entry.rowKey);
        if (row) entry.node.style.marginTop = `${row.base + entry.lane * row.step}px`;
      });
      rows.forEach((row) => {
        const rowLanes = [...packed.previews, ...packed.existing].filter((entry) => entry.rowKey === row.key).map((entry) => entry.lane);
        const maxLane = rowLanes.length ? Math.max(...rowLanes) : 0;
        if (mode === 'month') {
          if (!row.node.hasAttribute('data-prs-preview-original-min-height')) row.node.setAttribute('data-prs-preview-original-min-height', row.node.style.minHeight || '');
          row.node.style.minHeight = `${Math.max(124, row.base + maxLane * row.step + row.chipHeight + 8)}px`;
          row.node.classList.add('preview-expanded');
        } else {
          if (!row.node.hasAttribute('data-prs-preview-original-rows')) {
            row.node.setAttribute('data-prs-preview-original-rows', row.node.style.gridTemplateRows || '');
            row.node.setAttribute('data-prs-preview-original-height', row.node.style.height || '');
            row.node.setAttribute('data-prs-preview-original-min-height-band', row.node.style.minHeight || '');
          }
          const previewHeight = Math.max(54, 12 + (maxLane + 1) * row.step);
          row.node.style.gridTemplateRows = `${previewHeight}px`;
          row.node.style.height = `${previewHeight}px`;
          row.node.style.minHeight = `${previewHeight}px`;
        }
      });
      return laneByDraft;
    };
    const placementChromeTarget = (target) => target?.closest?.('.prs-toolbar,.prs-view-switch,[data-prs-month-overflow],[data-prs-week-all-day-overflow]');
    const renderClickPlacementPreview = (event) => {
      if (!clickPlacement || drag || placementChromeTarget(event.target)) return;
      const range = rangeFromPointer(event) || pointRange(event.target, event);
      const drafts = placementDraftsForRange(range);
      if (!drafts.length) { clearLivePreview(); return; }
      clearLivePreview();
      const laneByDraft = layoutClickPlacementPreviews(drafts);
      drafts.forEach((draft, index) => renderRangePreview(new Date(draft.start), new Date(draft.end), {
        item:{ ...draft, __previewPrimary:index === 0, __previewLaneByRow:laneByDraft[index] || {} },
        anchor:{ allDay:draft.all_day !== false }
      }, false));
    };
    const removeRenderedDraft = (draftId = '') => {
      const id = String(draftId || localActiveDraft?.id || activeDraftId || '');
      if (!id) return;
      const affectedSlots = new Set();
      container.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => {
        const monthBar = chip.closest('.prs-month-bar,.prs-all-day-bar-top');
        if (monthBar) monthBar.remove();
        else {
          const slot = chip.closest('.prs-slot');
          if (slot) affectedSlots.add(slot);
          chip.remove();
        }
      });
      affectedSlots.forEach((slot) => slot.classList.toggle('has-chip', !!slot.querySelector('.prs-work-chip')));
    };
    const attachLocalDraftConfirm = (rootNode) => {
      rootNode.querySelectorAll?.('[data-prs-confirm]')?.forEach((btn) => btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.onDraftConfirm?.(localActiveDraft || null);
      }));
    };
    const appendTimedItemSegments = (item, start, end, { draft = false, confirmable = false } = {}) => {
      let appended = false;
      timedSegments(item, { start, end }).forEach(({ segmentRange, continuesBefore, continuesAfter, beginsHere }) => {
        const day = dateKey(segmentRange.start);
        const time = timeString(rowStartMinute(segmentRange.start));
        const target = Array.from(container.querySelectorAll('.prs-slot[data-prs-date][data-prs-time]')).find((slot) => slot.dataset.prsDate === day && slot.dataset.prsTime === time);
        if (!target) return;
        const chipHeight = chipHeightForRange(segmentRange.start, segmentRange.end);
        const holder = document.createElement('div');
        holder.innerHTML = workChipHtml({ ...item, all_day:false, schedule_granularity:'time' }, { start, end }, {
          draft,
          confirmable,
          mode,
          day,
          showDetails: beginsHere,
          showTime: true,
          showStartHandle: !continuesBefore,
          showEndHandle: !continuesAfter,
          chipClass: `${chipHeight <= 64 ? 'compact-confirm' : ''} ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`,
          chipStyle: `top:${chipOffsetTop(segmentRange.start)}px;height:${chipHeight}px;min-height:${chipHeight}px`
        });
        const chip = holder.firstElementChild;
        if (!chip) return;
        target.appendChild(chip);
        target.classList.add('has-chip');
        if (draft) attachLocalDraftConfirm(chip);
        bindProjectChip(chip);
        appended = true;
      });
      reflowTimedOverlaps();
      return appended;
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
      if (mode === 'month' || allDay) {
        const weekSelector = mode === 'month' ? '.prs-month-week' : '.prs-all-day-grid';
        const displayStart = allDay ? start : dateAt(dateKey(start), '00:00');
        const displayEnd = allDay ? end : addDays(displayStart, 1);
        container.querySelectorAll(weekSelector).forEach((weekEl) => {
          const firstDay = weekEl.querySelector(mode === 'month' ? '.prs-day[data-prs-date]' : '.prs-all-day-cell[data-prs-date]');
          if (!firstDay) return;
          const weekStart = dateAt(firstDay.dataset.prsDate, '00:00');
          const weekEnd = addDays(weekStart, mode === 'month' ? 7 : (container.querySelectorAll('.prs-all-day-cell[data-prs-date]').length || 1));
          if (displayStart >= weekEnd || displayEnd <= weekStart) return;
          const segmentStart = displayStart > weekStart ? displayStart : weekStart;
          const segmentEnd = displayEnd < weekEnd ? displayEnd : weekEnd;
          const dayCountForBand = mode === 'month' ? 7 : (container.querySelectorAll('.prs-all-day-cell[data-prs-date]').length || 1);
          const startCol = Math.max(1, Math.min(dayCountForBand, dayDiff(weekStart, segmentStart) + 1));
          const offset = mode === 'month' ? 0 : 1;
          const maxCol = dayCountForBand + 1 + offset;
          const gridStartCol = startCol + offset;
          const endCol = Math.max(gridStartCol + 1, Math.min(maxCol, dayDiff(weekStart, segmentEnd) + 1 + offset));
          const beginsHere = displayStart >= weekStart && displayStart < weekEnd;
          const continuesBefore = displayStart < weekStart;
          const continuesAfter = displayEnd > weekEnd;
          const node = document.createElement('div');
          node.className = `${mode === 'month' ? 'prs-month-bar' : 'prs-all-day-bar-top'} ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`;
          node.style.gridColumn = `${gridStartCol}/${endCol}`;
          node.style.gridRow = '1';
          node.style.marginTop = draft.__monthMarginTop || (mode === 'month' ? `${MONTH_ITEM_TOP_PX}px` : `${mode === 'week' ? WEEK_ALL_DAY_ITEM_TOP_PX : 6}px`);
          node.dataset.prsDate = dateKey(segmentStart);
          node.dataset.prsLocalDraft = '1';
          node.innerHTML = workChipHtml(next, allDay ? { start: segmentStart, end: segmentEnd } : { start, end }, {
            draft: true,
            confirmable: typeof options.onDraftConfirm === 'function' && !continuesAfter,
            mode: allDay ? 'month' : mode,
            day: dateKey(segmentStart),
            chipClass: allDay ? '' : 'timed-month',
            showDetails: beginsHere,
            showTime: mode === 'month' ? false : !allDay,
            showSecondary: mode !== 'month' && mode !== 'week',
            showStartHandle: allDay && !continuesBefore,
            showEndHandle: allDay && !continuesAfter
          });
          (mode === 'month' ? (weekEl.querySelector('.prs-month-item-track') || weekEl) : weekEl).appendChild(node);
          attachLocalDraftConfirm(node);
          bindProjectChip(node.querySelector('.prs-work-chip'));
        });
        return next;
      }
      appendTimedItemSegments(next, start, end, { draft: true, confirmable: typeof options.onDraftConfirm === 'function' });
      return next;
    };
    const removeRenderedItem = (itemId = '') => {
      const id = String(itemId || '');
      if (!id) return;
      container.querySelectorAll(`.prs-work-chip[data-prs-event-id="${cssEscape(id)}"]`).forEach((chip) => {
        const monthBar = chip.closest('.prs-month-bar,.prs-all-day-bar-top');
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
      localItemOverrides.set(id, next);
      removeRenderedItem(id);
      const allDay = next.all_day !== false && next.schedule_granularity !== 'time';
      if (mode === 'month' || allDay) {
        const weekSelector = mode === 'month' ? '.prs-month-week' : '.prs-all-day-grid';
        const displayStart = allDay ? start : dateAt(dateKey(start), '00:00');
        const displayEnd = allDay ? end : addDays(displayStart, 1);
        container.querySelectorAll(weekSelector).forEach((weekEl) => {
          const firstDay = weekEl.querySelector(mode === 'month' ? '.prs-day[data-prs-date]' : '.prs-all-day-cell[data-prs-date]');
          if (!firstDay) return;
          const weekStart = dateAt(firstDay.dataset.prsDate, '00:00');
          const weekEnd = addDays(weekStart, mode === 'month' ? 7 : (container.querySelectorAll('.prs-all-day-cell[data-prs-date]').length || 1));
          if (displayStart >= weekEnd || displayEnd <= weekStart) return;
          const segmentStart = displayStart > weekStart ? displayStart : weekStart;
          const segmentEnd = displayEnd < weekEnd ? displayEnd : weekEnd;
          const dayCountForBand = mode === 'month' ? 7 : (container.querySelectorAll('.prs-all-day-cell[data-prs-date]').length || 1);
          const startCol = Math.max(1, Math.min(dayCountForBand, dayDiff(weekStart, segmentStart) + 1));
          const offset = mode === 'month' ? 0 : 1;
          const maxCol = dayCountForBand + 1 + offset;
          const gridStartCol = startCol + offset;
          const endCol = Math.max(gridStartCol + 1, Math.min(maxCol, dayDiff(weekStart, segmentEnd) + 1 + offset));
          const beginsHere = displayStart >= weekStart && displayStart < weekEnd;
          const continuesBefore = displayStart < weekStart;
          const continuesAfter = displayEnd > weekEnd;
          const node = document.createElement('div');
          node.className = `${mode === 'month' ? 'prs-month-bar' : 'prs-all-day-bar-top'} ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`;
          node.style.gridColumn = `${gridStartCol}/${endCol}`;
          node.style.gridRow = '1';
          node.style.marginTop = optionsForItem.monthMarginTop || (mode === 'month' ? `${MONTH_ITEM_TOP_PX}px` : `${mode === 'week' ? WEEK_ALL_DAY_ITEM_TOP_PX : 6}px`);
          node.dataset.prsDate = dateKey(segmentStart);
          node.innerHTML = workChipHtml(next, allDay ? { start: segmentStart, end: segmentEnd } : { start, end }, {
            draft: false,
            mode: allDay ? 'month' : mode,
            day: dateKey(segmentStart),
            chipClass: allDay ? '' : 'timed-month',
            showDetails: beginsHere,
            showTime: mode === 'month' ? false : !allDay,
            showSecondary: mode !== 'month' && mode !== 'week',
            showStartHandle: allDay && !continuesBefore,
            showEndHandle: allDay && !continuesAfter
          });
          (mode === 'month' ? (weekEl.querySelector('.prs-month-item-track') || weekEl) : weekEl).appendChild(node);
          bindProjectChip(node.querySelector('.prs-work-chip'));
        });
        return next;
      }
      appendTimedItemSegments(next, start, end, { draft: false });
      return next;
    };
    const markRange = (start, end) => {
      clearDragMarkers();
      renderRangePreview(start, end);
      container.querySelectorAll('[data-prs-date]').forEach((cell) => {
        const key = cell.dataset.prsDate;
        const time = cell.dataset.prsTime;
        const cellStart = time ? dateAt(key, time) : dateAt(key, '00:00');
        const cellEnd = time ? new Date(cellStart.getTime() + renderSlotMinutes * 60000) : addDays(cellStart, 1);
        if (start < cellEnd && end > cellStart) cell.classList.add('in-range');
      });
    };
    const minimumSpan = () => mode === 'month' ? 86400000 : snapMinutes * 60000;
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
    const updateCreateDrag = (event, preferredRange = null) => {
      if (!drag || drag.kind !== 'create') return;
      const range = preferredRange || rangeFromPointer(event);
      if (!range) return;
      if (pointerDistance(event) > POINTER_DRAG_THRESHOLD) drag.moved = true;
      if (Math.abs(drag.anchor.start.getTime() - range.start.getTime()) > 1000
        || Math.abs(drag.anchor.end.getTime() - range.end.getTime()) > 1000) {
        drag.moved = true;
      }
      drag.current = range;
      const start = drag.anchor.start < range.start ? drag.anchor.start : range.start;
      const end = drag.anchor.end > range.end ? drag.anchor.end : range.end;
      markRange(start, end);
    };
    const finishCreateDrag = (event) => {
      if (!drag || drag.kind !== 'create') return;
      let range = rangeFromPointer(event) || pointRange(event.target, event) || drag.current || drag.anchor;
      const hasDraggedRange = drag.current && (
        Math.abs(drag.anchor.start.getTime() - drag.current.start.getTime()) > 1000
        || Math.abs(drag.anchor.end.getTime() - drag.current.end.getTime()) > 1000
      );
      if (hasDraggedRange && Math.abs(drag.anchor.start.getTime() - range.start.getTime()) < 1000
        && Math.abs(drag.anchor.end.getTime() - range.end.getTime()) < 1000) {
        range = drag.current;
      }
      if (hasDraggedRange) drag.moved = true;
      if (!drag.moved) range = quickClickRange(event.target, event) || range;
      const allDay = mode === 'month' || range.allDay === true;
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
      const draft = publishDraft({ start, end, allDay, granularity: allDay ? 'date' : 'time' }, { resetExisting: !canExtendDraft });
      if (draft) {
        const chip = container.querySelector(`.prs-work-chip[data-prs-event-id="${cssEscape(draft.id || '')}"]`);
        options.onDraftCreateComplete?.(draft, { element: chip, sourceEvent: event });
      }
    };
    container.addEventListener('pointerdown', (event) => {
      if (!event.target.closest?.('.prs-surface')) return;
      beginTouchGesture(event);
    }, true);
    container.addEventListener('click', (event) => {
      if (Date.now() >= suppressTouchGestureClickUntil) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    if (allowCreate && !clickPlacement) container.querySelectorAll('.prs-day,.prs-all-day-cell,.prs-slot').forEach((cell) => {
      cell.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.prs-work-chip,[data-prs-month-overflow]')) return;
        const range = rangeFromPointer(event) || pointRange(event.target, event);
        if (!range) return;
        const startCreateDrag = () => {
          drag = { kind: 'create', anchor: range, current: range, startX: event.clientX, startY: event.clientY, moved: false, touchHeld:event.pointerType === 'touch' };
          cell.setPointerCapture?.(event.pointerId);
          markRange(range.start, range.end);
        };
        if (armTouchHold(event, startCreateDrag)) return;
        event.preventDefault();
        startCreateDrag();
      });
      cell.addEventListener('pointerenter', (event) => {
        if (!drag || drag.kind !== 'create') return;
        updateCreateDrag(event, rangeFromPointer(event) || pointRange(event.target, event));
      });
      cell.addEventListener('pointermove', (event) => {
        if (!drag || drag.kind !== 'create') return;
        updateCreateDrag(event);
      });
      cell.addEventListener('pointerup', (event) => {
        finishCreateDrag(event);
      });
    });
    if (allowCreate && !clickPlacement) container.addEventListener('pointerdown', (event) => {
      if (drag || event.target.closest('.prs-work-chip,.prs-toolbar,.prs-view-switch,[data-prs-month-overflow]')) return;
      const range = rangeFromPointer(event) || pointRange(event.target, event);
      if (!range) return;
      const startCreateDrag = () => {
        drag = { kind: 'create', anchor: range, current: range, startX: event.clientX, startY: event.clientY, moved: false, touchHeld:event.pointerType === 'touch' };
        container.setPointerCapture?.(event.pointerId);
        markRange(range.start, range.end);
      };
      if (armTouchHold(event, startCreateDrag)) return;
      event.preventDefault();
      startCreateDrag();
    });
    if (clickPlacement) {
      const commitClickPlacement = (event, preferredRange = null) => {
        if (placementChromeTarget(event.target)) return;
        const range = preferredRange || rangeFromPointer(event) || pointRange(event.target, event);
        if (!range) return;
        event.preventDefault();
        event.stopPropagation();
        clearLivePreview();
        const draft = publishDraft(range, { resetExisting:true, useDefaultDuration:true });
        if (!draft) return;
        const drafts = typeof options.derivePlacementDrafts === 'function' ? options.derivePlacementDrafts(draft) : [draft];
        options.onDraftCreateComplete?.(draft, { element:null, sourceEvent:event, drafts });
        options.onDraftConfirm?.(draft, { sourceEvent:event, drafts });
      };
      if (touchHoldToPlace) container.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch' || placementChromeTarget(event.target)) return;
        const range = rangeFromPointer(event) || pointRange(event.target, event);
        if (!range) return;
        armTouchHold(event, () => commitClickPlacement(event, range));
      }, true);
      container.addEventListener('click', (event) => {
        if (touchHoldToPlace && Date.now() < suppressTouchClickUntil) return;
        commitClickPlacement(event);
      }, true);
      container.__prsPlacementKeyHandler = (event) => {
        if (event.key !== 'Escape') return;
        clearLivePreview();
        options.onPlacementCancel?.();
      };
      document.addEventListener('keydown', container.__prsPlacementKeyHandler);
      container.addEventListener('pointerleave', () => clearLivePreview());
    }
    function bindProjectChip(chip){
      if (!chip || chip.dataset.prsBound === '1') return;
      chip.dataset.prsBound = '1';
      bindEdgeResizeCursor(chip, () => allowEventDrag);
      bindEventLockControl(chip, options, () => eventByRenderedId(chip.dataset.prsEventId || ''));
      chip.addEventListener('click', (event) => {
        if (chip.dataset.prsSuppressClick === '1') return;
        if (event.target.closest('[data-prs-confirm],[data-prs-lock-toggle]')) return;
        const id = chip.dataset.prsEventId || '';
        const item = eventByRenderedId(id);
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.target.closest('[data-prs-view]')) {
          event.preventDefault();
          event.stopPropagation();
          options.onEventClick?.(item, { element: event.target.closest('[data-prs-view]'), action: 'view' });
          return;
        }
        const assignee = event.target.closest('[data-prs-assignee]');
        if (assignee) {
          event.preventDefault();
          event.stopPropagation();
          options.onEventClick?.(item, { element: assignee, action: 'assignee' });
          return;
        }
        if (item.__draft === true || id === '__draft') options.onDraftSelect?.(item, { element: chip });
        else options.onEventClick?.(item, { element: chip });
      });
      if (allowEventDrag) chip.addEventListener('pointerdown', (event) => {
        if (clickPlacement) return;
        if (event.target.closest('[data-prs-confirm],[data-prs-assignee],[data-prs-view],[data-prs-lock-toggle]')) return;
        const id = chip.dataset.prsEventId || '';
        const item = eventByRenderedId(id);
        if (!item || !itemCanAdjustRange(item)) return;
        const startItemDrag = () => {
          const base = normalizeRangeItem(item).range;
          const handle = resizeEdgeAtPointer(chip, event);
          drag = { kind: handle, item, node: chip, base, anchor: pointRange(chip.closest('[data-prs-date]'), event), startX: event.clientX, startY: event.clientY, moved: false, touchHeld:event.pointerType === 'touch' };
          chip.setPointerCapture?.(event.pointerId);
        };
        if (armTouchHold(event, startItemDrag)) return;
        startItemDrag();
      });
    }
    container.querySelectorAll('.prs-work-chip:not(.prs-month-day-peek-chip)').forEach(bindProjectChip);
    container.querySelectorAll('.prs-month-day-peek-chip [data-prs-assignee]').forEach((assignee) => {
      assignee.addEventListener('pointerdown', (event) => event.stopPropagation());
      assignee.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const chip = assignee.closest('.prs-month-day-peek-chip');
        const item = eventByRenderedId(chip?.dataset.prsEventId || '');
        if (item) options.onEventClick?.(item, { element:assignee, action:'assignee' });
      });
    });
    reflowTimedOverlaps();
    container.addEventListener('pointermove', (event) => {
      updateTouchGesture(event);
      cancelTouchHoldForMovement(event);
      if (!drag) {
        renderClickPlacementPreview(event);
        return;
      }
      if (drag.kind === 'create') {
        updateCreateDrag(event);
        return;
      }
      if (pointerDistance(event) <= POINTER_DRAG_THRESHOLD && !drag.moved) return;
      drag.moved = true;
      drag.node?.classList.add('dragging');
      if (drag.node) drag.node.style.cursor = 'grabbing';
      event.preventDefault();
      const targetRange = rangeForDragTarget(event, drag);
      const next = dragRange(drag, targetRange);
      if (next) renderRangePreview(next.start, next.end, drag);
    });
    container.addEventListener('pointerup', (event) => {
      if (pendingTouchHold?.pointerId === event.pointerId) cancelTouchHold();
      if (finishTouchGesture(event)) return;
      if (!drag) return;
      if (drag.kind === 'create') {
        finishCreateDrag(event);
        return;
      }
      const activeDrag = drag;
      const targetRange = rangeForDragTarget(event, activeDrag);
      const { item } = activeDrag;
      container.querySelectorAll('.prs-work-chip.dragging').forEach((node) => node.classList.remove('dragging'));
      if (activeDrag.node) activeDrag.node.style.cursor = '';
      drag = null;
      clearLivePreview();
      if (!activeDrag.moved && pointerDistance(event, activeDrag) <= POINTER_DRAG_THRESHOLD) {
        if (activeDrag.touchHeld) {
          activeDrag.node?.setAttribute('data-prs-suppress-click', '1');
          setTimeout(() => activeDrag.node?.removeAttribute('data-prs-suppress-click'), 160);
        }
        return;
      }
      if (!itemCanAdjustRange(item)) return;
      const next = dragRange(activeDrag, targetRange);
      if (!next) return;
      activeDrag.node?.setAttribute('data-prs-suppress-click', '1');
      setTimeout(() => activeDrag.node?.removeAttribute('data-prs-suppress-click'), 80);
      const { start: nextStart, end: nextEnd } = next;
      const allDay = !rangeItemIsTimed(item);
      const payload = { start: nextStart, end: nextEnd, all_day: allDay, schedule_granularity: allDay ? 'date' : 'time' };
      if (item.__draft === true || item.id === '__draft') {
        const nextDraft = { ...item, ...payload };
        const renderedDraft = upsertDraft(nextDraft) || nextDraft;
        options.onDraftChange?.(renderedDraft);
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
        const monthMarginTop = mode === 'month' ? '' : (activeDrag.node?.closest?.('.prs-month-bar,.prs-all-day-bar-top')?.style?.marginTop || '6px');
        upsertCalendarItem(updatedItem, monthMarginTop ? { monthMarginTop } : {});
        options.onEventRangeChange?.(updatedItem, payload);
      }
    });
    container.addEventListener('pointercancel', (event) => {
      if (pendingTouchHold?.pointerId === event.pointerId) cancelTouchHold();
      if (touchGesture?.pointerId === event.pointerId) touchGesture = null;
      if (drag?.touchHeld) {
        drag = null;
        clearDragMarkers();
        clearLivePreview();
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
    const showToolbar = options.showToolbar !== false;
    const mobileResourceRows = options.mobileResourceRows === true;
    const mobileCompactResourceHeaders = options.mobileCompactResourceHeaders === true;
    const mode = options.mode === 'day' ? 'day' : 'week';
    const anchor = new Date(options.date || Date.now());
    anchor.setHours(0,0,0,0);
    const dayCount = mode === 'day' ? 1 : Math.max(21, Math.min(365, Number(options.dayCount || 70) || 70));
    const pastDays = mode === 'day' ? 0 : Math.max(0, Math.min(dayCount - 7, Number(options.pastDays ?? 14) || 0));
    const start = mode === 'day' ? new Date(anchor) : addDays(anchor, -pastDays);
    const days = Array.from({ length: dayCount }, (_, i) => addDays(start, i));
    const resources = (options.resources || []).map(normalizeResource);
    const rows = [normalizeResource({ id:'', name:options.unassignedLabel || 'Unassigned', unassigned:true }), ...resources.filter((item) => !item.unassigned)];
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
        title: entry.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end || addDays(new Date(entry.start), 1)).toISOString(),
        all_day: entry.all_day !== false,
        schedule_granularity: entry.schedule_granularity || (entry.all_day === false ? 'time' : 'date'),
        assigned_crew_id: typeof options.resourceIdForItem === 'function' ? clean(options.resourceIdForItem(entry)) : resourceIdForItem(entry),
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
    const itemIsEditable = (item = {}) => {
      if (item.__draft === true || item.id === '__draft') return true;
      const allowedById = !editableEventIds || editableEventIds.has(String(item.id || item.event_id || ''));
      return allowedById && eventPassesEditPredicate(options, item);
    };
    const itemCanAdjustRange = (item = {}) => itemIsEditable(item) && !eventIsLocked(item);
    const itemResourceId = (item) => typeof options.resourceIdForItem === 'function' ? clean(options.resourceIdForItem(item)) : resourceIdForItem(item);
    const findResource = (id) => rows.find((row) => String(row.id || '') === String(id || '')) || rows[0];
    const compactResourceIds = new Set((options.compactResourceIds || []).map((id) => clean(id)).filter(Boolean));
    const resourceIsCompact = (resourceOrId) => compactResourceIds.has(clean(typeof resourceOrId === 'object' ? resourceOrId?.id : resourceOrId));
    const canPlaceItemInResource = (item, resource) => typeof options.canPlaceItemInResource !== 'function' || options.canPlaceItemInResource(item || {}, resource || rows[0]) !== false;
    const renderedResourceIdForItem = (item) => clean(findResource(itemResourceId(item))?.id);
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
    const resourceMetrics = (resourceOrId) => resourceIsCompact(resourceOrId) ? { chipHeight:24, chipGap:4 } : { chipHeight:46, chipGap:6 };
    const laneEntries = normalized
      .filter(({ range }) => range.start < viewEnd && range.end > start)
      .map(({ item, range }) => ({ item, range:resourceDayLaneRange(range) }));
    const { laneByItem, laneCountByResource } = packResourceLanes(laneEntries, renderedResourceIdForItem);
    rows.forEach((row) => {
      const id = String(row.id || '');
      if (!laneCountByResource.has(id)) laneCountByResource.set(id, 1);
    });
    const rowHeightForResource = (resource) => {
      const laneCount = Math.max(1, laneCountByResource.get(String(resource.id || '')) || 1);
      const { chipHeight, chipGap } = resourceMetrics(resource);
      return `${10 + (laneCount * chipHeight) + (Math.max(0, laneCount - 1) * chipGap)}px`;
    };
    const gridRowForResource = (rowIndex) => mobileResourceRows ? rowIndex * 2 + 3 : rowIndex + 2;
    const gridColumnForDay = (dayIndex) => mobileResourceRows ? dayIndex + 1 : dayIndex + 2;
    const gridStartColumn = mobileResourceRows ? 1 : 2;
    const gridEndColumn = mobileResourceRows ? dayCount + 1 : dayCount + 2;
    const barTopForItem = (item) => {
      const { chipHeight, chipGap } = resourceMetrics(renderedResourceIdForItem(item));
      return `${5 + (Number(laneByItem.get(item) || 0) * (chipHeight + chipGap))}px`;
    };
    const chipForItem = (item, range, segmentStart, segmentEnd, rowIndex) => {
      const timed = rangeItemIsTimed(item);
      const beginsHere = range.start >= start && range.start <= segmentStart;
      const continuesBefore = range.start < segmentStart;
      const continuesAfter = range.end > segmentEnd;
      const startCol = Math.max(gridStartColumn, Math.min(gridEndColumn - 1, dayDiff(start, segmentStart) + gridStartColumn));
      const endCol = Math.max(startCol + 1, Math.min(gridEndColumn, dayDiff(start, segmentEnd) + gridStartColumn));
      return `<div class="prs-resource-bar ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}" style="grid-row:${gridRowForResource(rowIndex)};grid-column:${startCol}/${endCol};--prs-bar-top:${barTopForItem(item)}" data-prs-date="${esc(dateKey(segmentStart))}" data-prs-lane="${Number(laneByItem.get(item) || 0)}">
        ${workChipHtml(item, { start: segmentStart, end: segmentEnd }, {
          draft: item.__draft === true || item.id === '__draft',
          suspended: item.__draft === true && item.__activeDraft !== true,
          confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function',
          mode: 'month',
          day: dateKey(segmentStart),
          chipClass: [timed ? 'timed-month' : '', resourceIsCompact(renderedResourceIdForItem(item)) ? 'compact-resource-item' : '', renderedResourceIdForItem(item) ? '' : 'unassigned-item'].filter(Boolean).join(' '),
          showDetails: beginsHere,
          showTime: timed,
          showAssignee: false,
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
          <button type="button" class="prs-icon-btn" data-prs-today>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_23929ba4ba84dd","Today") ?? "Today")}</button>
          <button type="button" class="prs-icon-btn" data-prs-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="prs-range">${String(esc(viewLabel))}</div>
        </div>
        <span class="psv-pill"><i class="fas fa-helmet-safety"></i>${String(esc(options.modeLabel || 'Crew day view'))}</span>
    </div>
    `;
    container.innerHTML = resourceGridHtml({
      wrapClass: `prs-wrap ${options.readOnly ? 'readonly' : ''} ${showToolbar ? '' : 'no-toolbar'}`,
      showToolbar,
      toolbarHtml: toolbar,
      scrollClass: 'prs-resource-scroll',
      gridClass: `prs-resource-grid ${mobileResourceRows ? 'mobile-resource-rows' : ''}`,
      gridStyle: `--prs-days:${dayCount};--prs-resources:${rows.length};grid-template-columns:${mobileResourceRows ? `repeat(${dayCount},minmax(44px,1fr))` : ''};grid-template-rows:38px ${mobileResourceRows ? rows.flatMap((resource) => ['34px', rowHeightForResource(resource)]).join(' ') : rows.map(rowHeightForResource).join(' ')}`,
      cornerClass: 'prs-resource-corner',
      cornerLabel: options.resourceHeader || options.resourceLabel || 'Resource',
      omitCorner:mobileResourceRows,
      headersHtml: days.map((day, index) => `<div class="prs-resource-day-head ${[0,6].includes(day.getDay()) ? 'weekend' : ''} ${dayTemporalClass(day)}" style="grid-row:1;grid-column:${gridColumnForDay(index)}"><span>${esc(day.toLocaleDateString([], { weekday:'short' }))}</span><span>${esc(mobileCompactResourceHeaders ? String(day.getDate()) : day.toLocaleDateString([], { month:'short', day:'numeric' }))}</span></div>`).join(''),
      rowsHtml: rows.map((resource, rowIndex) => `
        ${resourceLabelHtml({ className: `prs-resource-label ${resource.unassigned ? 'unassigned' : ''}`, rowIndex:mobileResourceRows ? rowIndex * 2 : rowIndex, name: resource.name, sublabel: '', style:mobileResourceRows ? 'grid-column:1/-1' : '', actionAttr: (!resource.unassigned && resource.settings_disabled !== true && typeof options.onResourceSettings === 'function') ? `data-prs-resource-settings="${esc(resource.id || '')}"` : '', actionLabel: resourceActionPresentation(resource).label, actionIcon: resourceActionPresentation(resource).icon })}
        ${days.map((day, dayIndex) => `<div class="prs-resource-cell ${[0,6].includes(day.getDay()) ? 'weekend' : ''} ${dayTemporalClass(day)}" style="grid-row:${gridRowForResource(rowIndex)};grid-column:${gridColumnForDay(dayIndex)}" data-prs-date="${esc(dateKey(day))}" data-prs-resource="${esc(resource.id || '')}"></div>`).join('')}
      `).join(''),
      overlaysHtml: bars
    });
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
    container.querySelectorAll('[data-prs-resource-settings]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const resource = rows.find((item) => String(item.id || '') === String(btn.dataset.prsResourceSettings || ''));
      if (resource) options.onResourceSettings?.(resource, { element: btn });
    }));
    let horizonTimer = 0;
    if (options.autoNavigateOnScroll === true) {
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
    }
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
    const appendPreview = (startDate, endDate, resource, previewItem = {}, primary = true) => {
      if (!startDate || !endDate || endDate <= startDate) return;
      const rowIndex = rowForResource(resource?.id || '');
      const segmentStart = startDate > start ? startDate : start;
      const segmentEnd = endDate < viewEnd ? endDate : viewEnd;
      if (segmentStart >= viewEnd || segmentEnd <= start) return;
      const startCol = Math.max(gridStartColumn, Math.min(gridEndColumn - 1, dayDiff(start, segmentStart) + gridStartColumn));
      const endCol = Math.max(startCol + 1, Math.min(gridEndColumn, dayDiff(start, segmentEnd) + gridStartColumn));
      const node = document.createElement('div');
      node.className = 'prs-resource-bar live-preview';
      node.style.zIndex = primary ? '12' : '11';
      node.style.gridRow = String(gridRowForResource(rowIndex));
      node.style.gridColumn = `${startCol}/${endCol}`;
      node.innerHTML = workChipHtml({
        ...previewItem,
        id: '__preview',
        title: previewItem?.title || activeDraft?.title || (globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        all_day: true,
        schedule_granularity: 'date'
      }, { start: segmentStart, end: segmentEnd }, {
        preview: true,
        mode: 'month',
        showTime: false,
        showAssignee: false,
        showStartHandle: false,
        showEndHandle: false
      });
      container.querySelector('.prs-resource-grid')?.appendChild(node);
    };
    const renderPreview = (startDate, endDate, resource, activeDrag = drag) => {
      clearLivePreview();
      appendPreview(startDate, endDate, resource, activeDrag?.item || activeDraft || {}, true);
    };
    const renderHoverPlacementPreview = (target) => {
      const base = localActiveDraft || activeDraft;
      if (!target || !base || base.start || !canPlaceItemInResource(base, target.resource)) {
        clearMarkers();
        return;
      }
      const durationDays = Math.max(1, base.start && base.end ? dayDiff(new Date(base.start), new Date(base.end)) : 1);
      const primary = {
        ...base,
        ...resourcePayload(target.resource),
        start:target.start,
        end:addDays(target.start, durationDays),
        all_day:true,
        schedule_granularity:'date'
      };
      const previews = typeof options.derivePlacementDrafts === 'function' ? options.derivePlacementDrafts(primary) : [primary];
      clearLivePreview();
      (Array.isArray(previews) && previews.length ? previews : [primary]).forEach((preview, index) => {
        const previewStart = new Date(preview.start || primary.start);
        const previewEnd = new Date(preview.end || addDays(previewStart, 1));
        const previewResource = findResource(itemResourceId(preview) || (index === 0 ? target.resource?.id : ''));
        appendPreview(previewStart, previewEnd, previewResource, preview, index === 0);
      });
    };
    let localActiveDraft = activeDraft;
    const reflowResourceLanes = () => {
      const grid = container.querySelector('.prs-resource-grid');
      if (!grid) return;
      const rendered = [];
      container.querySelectorAll('.prs-resource-bar:not(.live-preview)').forEach((wrapper) => {
        const chip = wrapper.querySelector('.prs-work-chip[data-prs-event-id]');
        const item = eventByRenderedId(chip?.dataset.prsEventId || '');
        if (!item) return;
        const range = normalizeRangeItem(item).range;
        if (range.start >= viewEnd || range.end <= start) return;
        rendered.push({ item, range:resourceDayLaneRange(range), wrapper });
      });
      const packed = packResourceLanes(rendered, renderedResourceIdForItem);
      rows.forEach((row) => {
        const id = String(row.id || '');
        if (!packed.laneCountByResource.has(id)) packed.laneCountByResource.set(id, 1);
      });
      grid.style.gridTemplateRows = `38px ${rows.map((row) => {
        const lanes = Math.max(1, packed.laneCountByResource.get(String(row.id || '')) || 1);
        const { chipHeight, chipGap } = resourceMetrics(row);
        return `${10 + (lanes * chipHeight) + (Math.max(0, lanes - 1) * chipGap)}px`;
      }).join(' ')}`;
      rendered.forEach(({ item, wrapper }) => {
        const lane = Number(packed.laneByItem.get(item) || 0);
        const { chipHeight, chipGap } = resourceMetrics(renderedResourceIdForItem(item));
        wrapper.dataset.prsLane = String(lane);
        wrapper.style.setProperty('--prs-bar-top', `${5 + (lane * (chipHeight + chipGap))}px`);
      });
    };
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
      const resource = findResource(itemResourceId(draft));
      const segmentStart = range.start > start ? range.start : start;
      const segmentEnd = range.end < viewEnd ? range.end : viewEnd;
      if (segmentStart >= viewEnd || segmentEnd <= start) return;
      const item = {
        ...draft,
        id,
        __draft: true,
        __activeDraft: true,
        title: draft.title || localActiveDraft?.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
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
      reflowResourceLanes();
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
      if (activeDrag.item) {
        Object.assign(activeDrag.item, resourcePayload(next.resource));
        activeDrag.item.start_at = next.start.toISOString();
        activeDrag.item.start = next.start.toISOString();
        activeDrag.item.end_at = next.end.toISOString();
        activeDrag.item.end = next.end.toISOString();
        activeDrag.item.all_day = next.all_day !== false;
        activeDrag.item.schedule_granularity = next.schedule_granularity || (next.all_day === false ? 'time' : 'date');
      }
      const rowIndex = rowForResource(next.resource?.id || '');
      const segmentStart = next.start > start ? next.start : start;
      const segmentEnd = next.end < viewEnd ? next.end : viewEnd;
      if (segmentStart >= viewEnd || segmentEnd <= start) return;
      const startCol = Math.max(gridStartColumn, Math.min(gridEndColumn - 1, dayDiff(start, segmentStart) + gridStartColumn));
      const endCol = Math.max(startCol + 1, Math.min(gridEndColumn, dayDiff(start, segmentEnd) + gridStartColumn));
      activeDrag.wrapper.style.gridRow = String(gridRowForResource(rowIndex));
      activeDrag.wrapper.style.gridColumn = `${startCol}/${endCol}`;
    };
    if (options.allowCreate !== false) container.querySelectorAll('.prs-resource-cell').forEach((cell) => {
      cell.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.prs-work-chip')) return;
        const range = pointRange(event);
        if (!range) return;
        if (!canPlaceItemInResource(localActiveDraft || activeDraft || {}, range.resource)) return;
        event.preventDefault();
        drag = { kind:'create', anchor: range, current: range, startX:event.clientX, startY:event.clientY, moved:false };
        cell.setPointerCapture?.(event.pointerId);
        markRange(range.start, range.end, range.resource);
      });
    });
    container.addEventListener('pointermove', (event) => {
      if (!drag) {
        if (options.allowCreate !== false) renderHoverPlacementPreview(pointRange(event));
        return;
      }
      nudgeScrollForPointer(event);
      const target = pointRange(event);
      if (!target) return;
      if (!canPlaceItemInResource(drag.item || localActiveDraft || activeDraft || {}, target.resource)) return;
      if (pointerDistance(event) > POINTER_DRAG_THRESHOLD) {
        drag.moved = true;
        if (drag.kind !== 'create') drag.node?.classList.add('dragging');
        event.preventDefault();
      }
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
    container.addEventListener('pointerleave', () => { if (!drag) clearMarkers(); });
    container.addEventListener('pointerup', (event) => {
      if (!drag) return;
      const target = pointRange(event) || drag.current || drag.anchor;
      const activeDrag = drag;
      container.querySelectorAll('.prs-work-chip.dragging').forEach((node) => node.classList.remove('dragging'));
      drag = null;
      clearMarkers();
      if (!canPlaceItemInResource(activeDrag.item || localActiveDraft || activeDraft || {}, target.resource)) return;
      if (activeDrag.kind === 'create') {
        const startDate = activeDrag.anchor.start < target.start ? activeDrag.anchor.start : target.start;
        const endDate = activeDrag.anchor.end > target.end ? activeDrag.anchor.end : target.end;
        const nextDraft = {
          ...(localActiveDraft || activeDraft || {}),
          ...resourcePayload(target.resource),
          id: localActiveDraft?.id || activeDraft?.id || '__draft',
          title: localActiveDraft?.title || activeDraft?.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
          start: startDate,
          end: endDate,
          all_day: true,
          schedule_granularity: 'date'
        };
        upsertDraftBar(nextDraft);
        options.onDraftChange?.(nextDraft);
        return;
      }
      if (!activeDrag.moved && pointerDistance(event, activeDrag) <= POINTER_DRAG_THRESHOLD) return;
      if (!itemCanAdjustRange(activeDrag.item)) return;
      const next = dragRange(activeDrag, target);
      if (!next) return;
      activeDrag.node?.setAttribute('data-prs-suppress-click', '1');
      setTimeout(() => activeDrag.node?.removeAttribute('data-prs-suppress-click'), 80);
      const payload = { ...resourcePayload(next.resource), start: next.start, end: next.end, all_day: next.all_day !== false, schedule_granularity: next.schedule_granularity || (next.all_day === false ? 'time' : 'date') };
      if (activeDrag.item.__draft === true || activeDrag.item.id === '__draft') {
        applyCommittedRange(activeDrag, next);
        localActiveDraft = { ...activeDrag.item, ...payload, __draft: true, __activeDraft: true };
        reflowResourceLanes();
        options.onDraftChange?.(localActiveDraft);
      } else {
        applyCommittedRange(activeDrag, next);
        reflowResourceLanes();
        options.onEventRangeChange?.(activeDrag.item, payload);
      }
    });
    function bindResourceChip(chip){
      if (!chip || chip.dataset.prsBound === '1') return;
      chip.dataset.prsBound = '1';
      bindEdgeResizeCursor(chip, () => options.allowEdit !== false);
      bindEventLockControl(chip, options, () => eventByRenderedId(chip.dataset.prsEventId || ''));
      chip.addEventListener('click', (event) => {
        if (chip.dataset.prsSuppressClick === '1') return;
        if (event.target.closest('[data-prs-confirm],[data-prs-lock-toggle]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item) return;
        if (event.target.closest('[data-prs-view]')) {
          event.preventDefault();
          event.stopPropagation();
          if (itemIsEditable(item)) options.onEventClick?.(item, { element: event.target.closest('[data-prs-view]'), action: 'view' });
          return;
        }
        const assignee = event.target.closest('[data-prs-assignee]');
        if (assignee) {
          event.preventDefault();
          event.stopPropagation();
          if (itemIsEditable(item)) options.onEventClick?.(item, { element: assignee, action: 'assignee' });
          return;
        }
        if (item.__draft === true || item.id === '__draft') options.onDraftSelect?.(item);
        else if (itemIsEditable(item)) options.onEventClick?.(item, { element: chip });
      });
      if (options.allowEdit !== false) chip.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-prs-confirm],[data-prs-assignee],[data-prs-view],[data-prs-lock-toggle]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item || !itemCanAdjustRange(item)) return;
        const handle = resizeEdgeAtPointer(chip, event);
        drag = { kind: handle, item, node: chip, wrapper: chip.closest('.prs-resource-bar'), base: normalizeRangeItem(item).range, startX:event.clientX, startY:event.clientY, moved:false };
        chip.setPointerCapture?.(event.pointerId);
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
    seedTravelCache(options.travelTimeCache);
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    const showToolbar = options.showToolbar !== false;
    const anchor = new Date(options.date || Date.now());
    anchor.setHours(0,0,0,0);
    const dateValue = dateKey(anchor);
    const slotMinutes = Math.max(5, Number(options.slotMinutes || 30) || 30);
    const workStart = Number(options.workStartMinutes ?? 7 * 60);
    const workEnd = Number(options.workEndMinutes ?? 19 * 60);
    const slots = [];
    for (let minute = workStart; minute < workEnd; minute += slotMinutes) slots.push(minute);
    const resources = (options.resources || []).map(normalizeResource);
    const rows = [normalizeResource({ id:'', name:options.unassignedLabel || 'Unassigned', unassigned:true }), ...resources.filter((item) => !item.unassigned)];
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
        title: entry.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"),
        start_at: new Date(entry.start).toISOString(),
        end_at: new Date(entry.end || new Date(new Date(entry.start).getTime() + slotMinutes * 60000)).toISOString(),
        all_day: false,
        schedule_granularity: 'time',
        assigned_crew_id: typeof options.resourceIdForItem === 'function' ? clean(options.resourceIdForItem(entry)) : resourceIdForItem(entry),
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
    const itemIsEditable = (item = {}) => {
      if (item.__draft === true || item.id === '__draft') return true;
      const allowedById = !editableEventIds || editableEventIds.has(String(item.id || item.event_id || ''));
      return allowedById && eventPassesEditPredicate(options, item);
    };
    const itemCanAdjustRange = (item = {}) => itemIsEditable(item) && !eventIsLocked(item);
    const itemResourceId = (item) => typeof options.resourceIdForItem === 'function' ? clean(options.resourceIdForItem(item)) : resourceIdForItem(item);
    const findResource = (id) => rows.find((row) => String(row.id || '') === String(id || '')) || rows[0];
    const compactResourceIds = new Set((options.compactResourceIds || []).map((id) => clean(id)).filter(Boolean));
    const resourceIsCompact = (resourceOrId) => compactResourceIds.has(clean(typeof resourceOrId === 'object' ? resourceOrId?.id : resourceOrId));
    const canPlaceItemInResource = (item, resource) => typeof options.canPlaceItemInResource !== 'function' || options.canPlaceItemInResource(item || {}, resource || rows[0]) !== false;
    const renderedResourceIdForItem = (item) => clean(findResource(itemResourceId(item))?.id);
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
        const materialDelivery = isMaterialDeliveryEvent(item);
        const title = materialDelivery ? materialDeliveryTitle(item) : (item.project_title || item.project_name || item.customer_name || item.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"));
        const address = clean(item.project_address || item.address || '');
        const label = address ? `${title} - ${address}` : title;
        const ordered = materialDelivery && materialDeliveryIsOrdered(item);
        const locked = eventIsLocked(item);
        const presentation = materialDeliveryPresentation(item);
        const stateClasses = [
          materialDelivery ? 'material-delivery' : '',
          materialDelivery ? (ordered ? 'material-ordered' : 'material-unordered') : '',
          locked ? 'schedule-locked' : '',
        ].filter(Boolean).join(' ');
        const presentationStyle = materialDelivery ? [
          presentation.mainColor ? `--prs-material-main:${presentation.mainColor}` : '',
        ].filter(Boolean).join(';') : '';
        const marker = materialDelivery
          ? `<span class="prs-all-day-material-marker" aria-label="${esc(presentation.label || 'Material delivery')}"><i class="fas ${esc(presentation.icon)}" aria-hidden="true"></i></span>`
          : '';
        const showLock = materialDelivery && item.lock_toggle_visible !== false;
        const lockControl = showLock
          ? `<button type="button" class="prs-event-lock" data-prs-lock-toggle aria-label="${esc(locked ? 'Unlock schedule item' : 'Lock schedule item')}" title="${esc(locked ? 'Unlock schedule item' : 'Lock schedule item')}"><i class="fas ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>`
          : '';
        return `<div class="prs-resource-all-day-bar ${String(stateClasses)}" style="grid-row:${String(rowIndex + 2)};grid-column:2/${String(slots.length + 2)};${String(esc(presentationStyle))}" aria-label="${String(esc(`All day ${label}`))}"></div>
          <div class="prs-resource-all-day-label" style="grid-row:${String(rowIndex + 2)};grid-column:2/${String(slots.length + 2)}">
            <div class="prs-all-day-chip ${String(stateClasses)} ${String(showLock ? 'has-lock-control' : '')}" data-prs-event-id="${String(esc(item.id || item.event_id || ''))}" style="${String(esc(presentationStyle))}"><strong>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_6566b47a5b176f","All Day") ?? "All Day")}</strong>${String(marker)}<span class="prs-all-day-title">${String(esc(label))}</span>${String(lockControl)}</div>
          </div>`;
      }).join('');
    const visibleForDay = normalizedVisibleItems.filter(({ item, range }) => rangeItemIsTimed(item) && dateKey(range.start) === dateValue);
    const laneUnitForResource = (resourceOrId) => resourceIsCompact(resourceOrId) ? 12 : 18;
    const { laneByItem, laneCountByResource } = packResourceLanes(visibleForDay, renderedResourceIdForItem);
    rows.forEach((row) => {
      const id = String(row.id || '');
      if (!laneCountByResource.has(id)) laneCountByResource.set(id, 1);
    });
    // Row = stacked chips (2 lane-units each) plus symmetric 6px top/bottom
    // padding — no phantom extra lane, so single-appointment rows stay short.
    const rowHeightForResource = (resource) => `${(laneCountByResource.get(String(resource.id || '')) || 1) * 2 * laneUnitForResource(resource) + 12}px`;
    const barTopForItem = (item) => `${(resourceIsCompact(renderedResourceIdForItem(item)) ? 3 : 6) + (Number(laneByItem.get(item) || 0) * laneUnitForResource(renderedResourceIdForItem(item)) * 2)}px`;
    const travelConnections = options.liveTravel !== true ? [] : rows.flatMap((resource, rowIndex) => {
      if (!clean(resource.id)) return [];
      const rowEvents = visibleForDay
        // A moved stop is represented as a draft until the routing change is
        // confirmed. Keep it in the route so both adjacent travel segments are
        // rebuilt from its previewed time/resource instead of the old schedule.
        .filter(({ item }) => renderedResourceIdForItem(item) === String(resource.id || '') && routableAddress(item))
        .sort((a, b) => a.range.start - b.range.start);
      const connections = [];
      for (let index = 1; index < rowEvents.length; index += 1) {
        const prev = rowEvents[index - 1];
        const next = rowEvents[index];
        const origin = routableAddress(prev.item);
        const destination = routableAddress(next.item);
        if (!origin || !destination || addressKey(origin) === addressKey(destination)) continue;
        const startMinute = Math.max(workStart, minuteForDate(prev.range.end));
        const nextStartMinute = Math.min(workEnd, minuteForDate(next.range.start));
        if (nextStartMinute <= startMinute || startMinute >= workEnd) continue;
        const gapMinutes = nextStartMinute - startMinute;
        const key = travelKey(origin, destination);
        const cached = Number(travelCache.get(key)) || 0;
        const sourceStartMinute = Math.max(workStart, minuteForDate(prev.range.start));
        const sourceStartCol = Math.max(2, Math.min(slots.length + 1, Math.floor((sourceStartMinute - workStart) / slotMinutes) + 2));
        const sourceSpan = Math.max(1, Math.ceil((Math.max(sourceStartMinute + slotMinutes, startMinute) - sourceStartMinute) / slotMinutes));
        const startCol = Math.min(slots.length + 1, sourceStartCol + sourceSpan);
        const nextStartCol = Math.max(startCol + 1, Math.min(slots.length + 2, Math.floor((nextStartMinute - workStart) / slotMinutes) + 2));
        const spanSlots = Math.max(1, nextStartCol - startCol);
        const endCol = Math.min(slots.length + 2, startCol + spanSlots);
        if (endCol <= startCol) continue;
        const travelLayout = travelSegmentLayout(cached, gapMinutes, slotMinutes, endCol - startCol);
        connections.push({
          prev,
          next,
          rowIndex,
          origin,
          destination,
          key,
          cached,
          gapMinutes,
          bridge:travelLayout.bridge,
          insufficient:travelLayout.insufficient,
          startCol,
          endCol,
          widthPercent:travelLayout.widthPercent
        });
      }
      return connections;
    });
    const outgoingTravelByItem = new Map(travelConnections.filter((connection) => connection.cached > 0).map((connection) => [connection.prev.item, connection]));
    const incomingTravelByItem = new Map(travelConnections.filter((connection) => connection.cached > 0 && connection.bridge).map((connection) => [connection.next.item, connection]));
    const bars = visibleForDay.map(({ item, range }) => {
      const rowIndex = rowForResource(itemResourceId(item));
      const startMinute = Math.max(workStart, minuteForDate(range.start));
      const endMinute = Math.min(workEnd, minuteForDate(range.end));
      if (endMinute <= workStart || startMinute >= workEnd) return '';
      const startCol = Math.max(2, Math.min(slots.length + 1, Math.floor((startMinute - workStart) / slotMinutes) + 2));
      const span = Math.max(1, Math.ceil((Math.max(startMinute + slotMinutes, endMinute) - startMinute) / slotMinutes));
      const endCol = Math.min(slots.length + 2, startCol + span);
      const outgoingTravel = outgoingTravelByItem.get(item);
      const incomingTravel = incomingTravelByItem.get(item);
      // An appointment sitting on an unavailable member's row needs a human
      // to reschedule or reassign it — flag the chip itself.
      const rowResource = findResource(itemResourceId(item));
      const needsReschedule = !!rowResource && !rowResource.unassigned && rowResource.unavailable === true;
      return `<div class="prs-resource-time-bar ${outgoingTravel ? 'has-travel' : ''} ${incomingTravel ? 'travel-destination' : ''}" style="grid-row:${rowIndex + 2};grid-column:${startCol}/${endCol};--prs-bar-top:${barTopForItem(item)}" data-prs-date="${esc(dateValue)}">
        ${workChipHtml({ ...item, all_day:false, schedule_granularity:'time' }, range, {
          draft: item.__draft === true || item.id === '__draft',
          suspended: item.__draft === true && item.__activeDraft !== true,
          confirmable: item.__activeDraft === true && typeof options.onDraftConfirm === 'function',
          mode:'month',
          day: dateValue,
          chipClass:`timed-month${resourceIsCompact(renderedResourceIdForItem(item)) ? ' compact-resource-item' : ''}${renderedResourceIdForItem(item) ? '' : ' unassigned-item'}${outgoingTravel ? ' travel-origin' : ''}${incomingTravel ? ' travel-destination' : ''}${needsReschedule ? ' needs-reschedule' : ''}`,
          showTime:true,
          showAssignee:false,
          showStartHandle:true,
          showEndHandle:true
        })}
      </div>`;
    }).join('');
    // Assigned rows form an ordered route. Each resolved travel segment is
    // visually attached to the stop it departs from; pending nodes stay hidden
    // while still allowing the distance service to resolve and cache them.
    const travelBars = travelConnections.map((connection) => {
      const label = connection.cached > 0 ? `${connection.cached} minute travel time` : 'Calculating travel time';
      const stateClass = connection.cached > 0
        ? `${connection.bridge ? 'bridge' : ''} ${connection.insufficient ? 'insufficient' : ''}`
        : 'pending';
      return `<div class="psv-travel prs-resource-travel ${stateClass}" style="grid-row:${connection.rowIndex + 2};grid-column:${connection.startCol}/${connection.endCol};--prs-bar-top:${barTopForItem(connection.prev.item)};--prs-travel-width:${connection.widthPercent}%" data-slot-minutes="${esc(slotMinutes)}" data-travel-key="${esc(connection.key)}" data-origin="${esc(connection.origin)}" data-destination="${esc(connection.destination)}" title="${esc(connection.cached > 0 ? `${label}: ${connection.origin} to ${connection.destination}` : label)}" aria-label="${esc(label)}"><i class="far fa-clock"></i>${connection.cached > 0 ? `<span>${esc(connection.cached)}</span>` : ''}</div>`;
    }).join('');
    const toolbar = `
      <div class="prs-toolbar">
        <div class="prs-nav">
          <button type="button" class="prs-icon-btn" data-prs-nav="-1"><i class="fas fa-chevron-left"></i></button>
          <button type="button" class="prs-icon-btn" data-prs-today>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_23929ba4ba84dd","Today") ?? "Today")}</button>
          <button type="button" class="prs-icon-btn" data-prs-nav="1"><i class="fas fa-chevron-right"></i></button>
          <div class="prs-range">${String(esc(anchor.toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' })))}</div>
        </div>
        <div class="prs-nav">
          ${String(typeof options.onSmartScrollToggle === 'function' ? `<button type="button" class="psv-smart-toggle ${options.smartScroll ? 'active' : ''}" data-prs-smart><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_87d3f1a9ae9c3e"," Smart scroll") ?? " Smart scroll")}</button>` : '')}
          ${String(typeof options.onLiveTravelToggle === 'function' ? `<button type="button" class="psv-travel-toggle ${options.liveTravel ? 'active' : ''}" data-psv-live><span class="dot"></span>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_821a653a1f79f2"," Live travel time") ?? " Live travel time")}</button>` : '')}
          <span class="psv-pill"><i class="fas fa-clock"></i>${String(esc(options.modeLabel || 'Crew daily view'))}</span>
        </div>
      </div>`;
    container.innerHTML = resourceGridHtml({
      wrapClass: `prs-wrap ${showToolbar ? '' : 'no-toolbar'}`,
      showToolbar,
      toolbarHtml: toolbar,
      scrollClass: 'prs-resource-scroll',
      gridClass: `prs-resource-time-grid ${dayTemporalClass(anchor)}`,
      gridStyle: `--prs-slots:${slots.length};--prs-resources:${rows.length};grid-template-rows:40px ${rows.map(rowHeightForResource).join(' ')}`,
      cornerClass: 'prs-resource-corner',
      cornerLabel: options.resourceHeader || options.resourceLabel || 'Resource',
      headersHtml: slots.map((minute, index) => `<div class="prs-resource-time-head" style="grid-row:1;grid-column:${index + 2}">${esc(timeLabel(minute))}</div>`).join(''),
      rowsHtml: rows.map((resource, rowIndex) => `
        ${resourceLabelHtml({
          className: `prs-resource-label ${resource.unassigned ? 'unassigned' : ''} ${resource.unavailable ? 'unavailable-day' : ''}`,
          rowIndex,
          name: resource.name,
          sublabel: resource.unavailable ? 'Team member unavailable' : '',
          actionAttr: (!resource.unassigned && resource.settings_disabled !== true && typeof options.onResourceSettings === 'function') ? `data-prs-resource-settings="${esc(resource.id || '')}"` : '',
          actionLabel: resourceActionPresentation(resource).label,
          actionIcon: resourceActionPresentation(resource).icon,
          actionsHtml: (!resource.unassigned && typeof options.onResourceAvailabilityToggle === 'function')
            ? `<button type="button" class="psv-resource-settings-btn psv-availability-toggle ${resource.unavailable ? 'active' : ''}" data-prs-availability="${esc(resource.id || '')}" aria-pressed="${resource.unavailable ? 'true' : 'false'}" aria-label="${resource.unavailable ? 'Mark available for this day' : 'Mark unavailable for this day'}" title="${resource.unavailable ? 'Mark available for this day' : 'Mark unavailable for this day'}"><i class="fas ${resource.unavailable ? 'fa-user-slash' : 'fa-user-check'}"></i></button>`
            : ''
        })}
        ${slots.map((minute, slotIndex) => `<div class="prs-resource-time-cell ${resource.unavailable ? 'unavailable-day' : ''}" style="grid-row:${rowIndex + 2};grid-column:${slotIndex + 2}" data-prs-minute="${minute}" data-prs-resource="${esc(resource.id || '')}"></div>`).join('')}
      `).join(''),
      overlaysHtml: `${allDayBars}${travelBars}${bars}`
    });
    container.__psvOptions = options;
    container.__psvRenderer = renderResourceTimeScheduler;
    hydrateTravelLabels(container, options.liveTravel === true);
    container.querySelectorAll('[data-prs-nav]').forEach((btn) => btn.addEventListener('click', () => {
      const delta = Number(btn.dataset.prsNav || 0);
      options.onNavigate?.(addDays(anchor, delta), delta);
    }));
    container.querySelector('[data-prs-today]')?.addEventListener('click', () => options.onNavigate?.(new Date(), 0));
    container.querySelector('[data-prs-smart]')?.addEventListener('click', () => options.onSmartScrollToggle?.(!options.smartScroll));
    container.querySelector('[data-psv-live]')?.addEventListener('click', () => options.onLiveTravelToggle?.(!options.liveTravel));
    container.querySelectorAll('[data-prs-resource-settings]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const resource = rows.find((item) => String(item.id || '') === String(btn.dataset.prsResourceSettings || ''));
      if (resource) options.onResourceSettings?.(resource, { element: btn });
    }));
    container.querySelectorAll('[data-prs-availability]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const resource = rows.find((item) => String(item.id || '') === String(btn.dataset.prsAvailability || ''));
      if (resource) options.onResourceAvailabilityToggle?.(resource, { date: dateValue, element: btn });
    }));
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
      if (timeLabelNode) timeLabelNode.textContent = formatRange(next.start, next.end, false, { timeOnly: true });
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
      node.innerHTML = workChipHtml({ id:'__preview', title: activeDrag?.item?.title || activeDraft?.title || (globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"), all_day:false, schedule_granularity:'time' }, { start:startDate, end:endDate }, {
        preview:true,
        mode:'month',
        chipClass:'timed-month',
        showTime:true,
        showAssignee:false,
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
      const resource = findResource(itemResourceId(draft));
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
        showAssignee:false,
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
        if (!canPlaceItemInResource(localActiveDraft || activeDraft || {}, range.resource)) return;
        event.preventDefault();
        drag = { kind:'create', anchor:range, current:range, startX:event.clientX, startY:event.clientY, moved:false };
        cell.setPointerCapture?.(event.pointerId);
        renderPreview(range.start, range.end, range.resource);
      });
    });
    container.addEventListener('pointermove', (event) => {
      if (!drag) {
        const target = rangeFromPointer(event);
        const base = localActiveDraft || activeDraft;
        if (options.allowCreate !== false && target && base && !base.start && canPlaceItemInResource(base, target.resource)) {
          const endDate = fixedEndFor(target.start, target.end);
          renderPreview(target.start, endDate, target.resource, { item:base });
        } else {
          clearPreview();
        }
        return;
      }
      const target = rangeFromPointer(event);
      if (!target) return;
      if (!canPlaceItemInResource(drag.item || localActiveDraft || activeDraft || {}, target.resource)) return;
      if (pointerDistance(event) > POINTER_DRAG_THRESHOLD) {
        drag.moved = true;
        if (drag.kind !== 'create') drag.node?.classList.add('dragging');
        event.preventDefault();
      }
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
    container.addEventListener('pointerleave', () => { if (!drag) clearPreview(); });
    container.addEventListener('pointerup', (event) => {
      if (!drag) return;
      const target = rangeFromPointer(event) || drag.current || drag.anchor;
      const activeDrag = drag;
      drag = null;
      clearPreview();
      container.querySelectorAll('.prs-work-chip.dragging').forEach((node) => node.classList.remove('dragging'));
      if (!canPlaceItemInResource(activeDrag.item || localActiveDraft || activeDraft || {}, target.resource)) return;
      const payloadBase = { ...resourcePayload(target.resource), all_day:false, schedule_granularity:'time' };
      if (activeDrag.kind === 'create') {
        const startDate = activeDrag.anchor.start < target.start ? activeDrag.anchor.start : target.start;
        const draggedEnd = activeDrag.anchor.end > target.end ? activeDrag.anchor.end : target.end;
        const endDate = fixedEndFor(startDate, draggedEnd);
        const nextDraft = { ...(localActiveDraft || activeDraft || {}), ...payloadBase, id: localActiveDraft?.id || activeDraft?.id || '__draft', title: localActiveDraft?.title || activeDraft?.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2ac9ecd66d638b","New Event") ?? "New Event"), start:startDate, end:endDate };
        upsertDraftBar(nextDraft);
        options.onDraftChange?.(nextDraft);
        return;
      }
      if (!activeDrag.moved && pointerDistance(event, activeDrag) <= POINTER_DRAG_THRESHOLD) return;
      if (!itemCanAdjustRange(activeDrag.item)) return;
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
        applyCommittedRange(activeDrag, next);
        options.onEventRangeChange?.(activeDrag.item, payload);
      }
    });
    function bindResourceTimeChip(chip){
      if (!chip || chip.dataset.prsBound === '1') return;
      chip.dataset.prsBound = '1';
      bindEdgeResizeCursor(chip, () => options.allowEdit !== false);
      bindEventLockControl(chip, options, () => eventByRenderedId(chip.dataset.prsEventId || ''));
      chip.addEventListener('click', (event) => {
        if (chip.dataset.prsSuppressClick === '1') return;
        if (event.target.closest('[data-prs-confirm],[data-prs-lock-toggle]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item) return;
        if (event.target.closest('[data-prs-view]')) {
          event.preventDefault();
          event.stopPropagation();
          if (itemIsEditable(item)) options.onEventClick?.(item, { element: event.target.closest('[data-prs-view]'), action: 'view' });
          return;
        }
        const assignee = event.target.closest('[data-prs-assignee]');
        if (assignee) {
          event.preventDefault();
          event.stopPropagation();
          if (itemIsEditable(item)) options.onEventClick?.(item, { element: assignee, action: 'assignee' });
          return;
        }
        if (item.__draft === true || item.id === '__draft') options.onDraftSelect?.(item);
        else if (itemIsEditable(item)) options.onEventClick?.(item, { element: chip });
      });
      if (options.allowEdit !== false) chip.addEventListener('pointerdown', (event) => {
        if (event.target.closest('[data-prs-confirm],[data-prs-assignee],[data-prs-view],[data-prs-lock-toggle]')) return;
        const item = eventByRenderedId(chip.dataset.prsEventId || '');
        if (!item || !itemCanAdjustRange(item)) return;
        const handle = resizeEdgeAtPointer(chip, event);
        drag = { kind: handle, item, node: chip, wrapper: chip.closest('.prs-resource-time-bar'), base: normalizeRangeItem(item).range, startX:event.clientX, startY:event.clientY, moved:false };
        chip.setPointerCapture?.(event.pointerId);
      });
    }
    container.querySelectorAll('.prs-work-chip').forEach(bindResourceTimeChip);
    container.querySelectorAll('.prs-all-day-chip[data-prs-event-id]').forEach((chip) => {
      bindEventLockControl(chip, options, () => eventByRenderedId(chip.dataset.prsEventId || ''));
    });
    container.querySelectorAll('[data-prs-confirm]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onDraftConfirm?.(localActiveDraft || activeDraft || null);
    }));
  }

  const GANTT_ZOOM_PRESETS = { hour:1440, day:240, week:60, month:16 };
  const GANTT_ZOOM_MIN = 8;
  const GANTT_ZOOM_MAX = 2400;
  const GANTT_ROW_H = 32;
  const GANTT_SECTION_H = 28;
  const GANTT_PROJECT_H = 36;
  const GANTT_ADD_H = 20;

  function ganttZoomFromSlider(value){
    const ratio = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
    return GANTT_ZOOM_MIN * Math.pow(GANTT_ZOOM_MAX / GANTT_ZOOM_MIN, ratio);
  }

  function ganttSliderFromZoom(pxPerDay){
    const clamped = Math.max(GANTT_ZOOM_MIN, Math.min(GANTT_ZOOM_MAX, Number(pxPerDay) || GANTT_ZOOM_PRESETS.week));
    return Math.round(100 * Math.log(clamped / GANTT_ZOOM_MIN) / Math.log(GANTT_ZOOM_MAX / GANTT_ZOOM_MIN));
  }

  function ganttPresentation(Scheduling, event){
    if (Scheduling?.eventPresentation) return Scheduling.eventPresentation(event);
    return { kind:eventKind(event), color:clean(event.color), icon:clean(event.icon), locked:eventIsLocked(event) };
  }

  function ganttDefaultColor(kind){
    if (kind === 'material_delivery') return '#f97316';
    if (kind === 'equipment') return '#0f766e';
    if (kind === 'sales_appointment') return '#2563eb';
    if (kind === 'project_work') return '#16a34a';
    return '#64748b';
  }

  function ganttDefaultIcon(kind){
    if (kind === 'material_delivery') return 'fa-truck-ramp-box';
    if (kind === 'equipment') return 'fa-truck-pickup';
    if (kind === 'sales_appointment') return 'fa-handshake';
    return '';
  }

  // Full-project Gantt: grouped rows with rollup parents, dependency links,
  // continuous hour→month zoom, drag move/resize, drag-to-link.  Separate
  // surface from the routing schedulers; same option/callback conventions.
  function renderGanttScheduler(container, options = {}){
    if (!container) return;
    injectCss();
    const Scheduling = options.Scheduling || root.PlatformScheduling;
    container.__psvGanttOptions = options;
    const readOnly = options.readOnly === true || options.allowEdit === false;
    const pxPerDay = Math.max(GANTT_ZOOM_MIN, Math.min(GANTT_ZOOM_MAX, Number(container.__psvGanttPxPerDay || options.pxPerDay || GANTT_ZOOM_PRESETS[clean(options.zoom).toLowerCase()] || GANTT_ZOOM_PRESETS.week)));
    container.__psvGanttPxPerDay = pxPerDay;
    const collapsed = container.__psvGanttCollapsed instanceof Set
      ? container.__psvGanttCollapsed
      : new Set((options.collapsedGroupIds || []).map((id) => String(id || '')));
    container.__psvGanttCollapsed = collapsed;

    const rawEvents = (options.events || [])
      .map((event) => Scheduling?.normalizeEvent ? Scheduling.normalizeEvent(event, options.config || null, options.project || null) : event);
    const events = Scheduling?.applyGroupRollups ? Scheduling.applyGroupRollups(rawEvents) : rawEvents;
    const eventById = new Map(events.map((event) => [String(event.id || ''), event]));
    const evStart = (event) => eventStart(Scheduling, event);
    const evEnd = (event) => eventEnd(Scheduling, event);
    const isScheduled = (event) => Scheduling?.eventIsScheduled ? Scheduling.eventIsScheduled(event) : !!evStart(event);
    const parentIdOf = (event) => Scheduling?.eventParentId ? Scheduling.eventParentId(event) : clean(event.parent_event_id);
    const isGroup = (event) => Scheduling?.eventIsGroup ? Scheduling.eventIsGroup(event) : event.is_schedule_group === true;
    const dependenciesOf = (event) => Scheduling?.eventDependencies ? Scheduling.eventDependencies(event) : [];

    // Build display rows: optional per-project sections, then groups with
    // children, then ungrouped items.
    const projects = Array.isArray(options.projects) && options.projects.length ? options.projects : null;
    const rows = [];
    const pushEventRows = (list, projectChildren = false) => {
      const groups = list.filter((event) => isGroup(event));
      const childrenOf = (groupId) => list.filter((event) => parentIdOf(event) === String(groupId || '') && !isGroup(event));
      const grouped = new Set();
      groups.forEach((group) => {
        const children = childrenOf(group.id);
        children.forEach((child) => grouped.add(String(child.id || '')));
        const isCollapsed = collapsed.has(String(group.id || ''));
        rows.push({ type:'event', event:group, group:true, child:projectChildren, hasChildren:children.length > 0, collapsed:isCollapsed });
        if (!isCollapsed) children.forEach((child) => rows.push({ type:'event', event:child, child:true, grandchild:projectChildren }));
      });
      list.filter((event) => !isGroup(event) && !grouped.has(String(event.id || ''))).forEach((event) => {
        rows.push({ type:'event', event, child:projectChildren });
      });
    };
    // groupBy:'resource' — one section per resource (crew, person, or
    // equipment unit); child rows are that resource's events, an Unassigned
    // section closes the board, and bars that overlap on one lane are flagged.
    const groupByResource = clean(options.groupBy).toLowerCase() === 'resource';
    if (groupByResource) {
      const refKey = (kind, id) => `${clean(kind).toLowerCase()}:${clean(id).toLowerCase()}`;
      const eventResourceKeys = (event) => {
        const keys = [];
        const workRef = event.work_resource_ref && typeof event.work_resource_ref === 'object' ? event.work_resource_ref : {};
        if (clean(workRef.id)) keys.push(refKey(workRef.kind || 'resource_group', workRef.id));
        (Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : []).forEach((id) => {
          if (clean(id)) keys.push(refKey('organization_user', id));
        });
        (Array.isArray(event.resource_refs) ? event.resource_refs : []).forEach((ref) => {
          if (ref && clean(ref.id)) keys.push(refKey(ref.kind || 'resource_group', ref.id));
        });
        return [...new Set(keys)];
      };
      const suppliedResources = (Array.isArray(options.resources) ? options.resources : [])
        .map((resource) => ({
          key: refKey(resource.kind || resource.subject_type || resource.resource_kind || 'resource_group', resource.id),
          id: clean(resource.id),
          name: clean(resource.name) || clean(resource.id),
          icon: clean(resource.icon)
        }))
        .filter((resource) => resource.id);
      const derivedResources = [];
      if (!suppliedResources.length) {
        const seenKeys = new Set();
        events.filter((event) => !isGroup(event)).forEach((event) => {
          const workRef = event.work_resource_ref && typeof event.work_resource_ref === 'object' ? event.work_resource_ref : {};
          const candidates = [
            ...(clean(workRef.id) ? [{ kind:workRef.kind || 'resource_group', id:workRef.id, name:workRef.name || event.assigned_crew_name }] : []),
            ...(Array.isArray(event.resource_refs) ? event.resource_refs : [])
          ];
          candidates.forEach((ref) => {
            if (!ref || !clean(ref.id)) return;
            const key = refKey(ref.kind || 'resource_group', ref.id);
            if (seenKeys.has(key)) return;
            seenKeys.add(key);
            derivedResources.push({ key, id:clean(ref.id), name:clean(ref.name) || clean(ref.id), icon:clean(ref.kind) === 'equipment_unit' ? 'fa-truck-pickup' : '' });
          });
        });
      }
      const laneResources = suppliedResources.length ? suppliedResources : derivedResources;
      const laneEvents = events.filter((event) => !isGroup(event));
      const flagOverlaps = (list) => {
        const scheduled = list.filter((event) => isScheduled(event) && evStart(event));
        const overlapping = new Set();
        for (let a = 0; a < scheduled.length; a += 1) {
          for (let b = a + 1; b < scheduled.length; b += 1) {
            const aStart = evStart(scheduled[a]); const aEnd = evEnd(scheduled[a]) || aStart;
            const bStart = evStart(scheduled[b]); const bEnd = evEnd(scheduled[b]) || bStart;
            if (aStart < bEnd && bStart < aEnd) {
              overlapping.add(String(scheduled[a].id || ''));
              overlapping.add(String(scheduled[b].id || ''));
            }
          }
        }
        return overlapping;
      };
      const laneAssigned = new Set();
      laneResources.forEach((resource) => {
        const resourceEvents = laneEvents.filter((event) => eventResourceKeys(event).includes(resource.key));
        if (!resourceEvents.length && options.showEmptyResources !== true) return;
        resourceEvents.forEach((event) => laneAssigned.add(String(event.id || '')));
        const overlapping = flagOverlaps(resourceEvents);
        rows.push({ type:'section', label:resource.name, resource });
        resourceEvents.forEach((event) => rows.push({ type:'event', event, child:true, overlap:overlapping.has(String(event.id || '')) }));
      });
      const unassigned = laneEvents.filter((event) => !laneAssigned.has(String(event.id || '')));
      if (unassigned.length) {
        rows.push({ type:'section', label:clean(options.unassignedLabel) || 'Unassigned' });
        unassigned.forEach((event) => rows.push({ type:'event', event, child:true }));
      }
    } else if (projects) {
      projects.forEach((project) => {
        const projectEvents = events.filter((event) => String(event.project_id || '') === String(project.id || ''));
        if (!projectEvents.length) return;
        const scheduledChildren = projectEvents.filter((event) => !isGroup(event) && isScheduled(event) && evStart(event));
        const childStarts = scheduledChildren.map(evStart).filter(Boolean);
        const childEnds = scheduledChildren.map((event) => evEnd(event) || evStart(event)).filter(Boolean);
        const rollupId = `__project__${project.id}`;
        const projectCollapsed = collapsed.has(rollupId);
        const rollup = {
          id:rollupId,
          project_id:String(project.id || ''),
          title:clean(project.display_name || project.name || project.title || project.address || 'Project'),
          start_at:childStarts.length ? new Date(Math.min(...childStarts.map((date) => date.getTime()))).toISOString() : '',
          end_at:childEnds.length ? new Date(Math.max(...childEnds.map((date) => date.getTime()))).toISOString() : '',
          status:childStarts.length ? 'scheduled' : 'unscheduled',
          all_day:true,
          schedule_granularity:'date',
          is_schedule_group:true,
          __project_rollup:true,
          __project_child_ids:projectEvents.map((event) => String(event.id || '')).filter(Boolean),
        };
        eventById.set(rollupId, rollup);
        rows.push({ type:'event', event:rollup, group:true, projectRollup:true, hasChildren:projectEvents.length > 0, collapsed:projectCollapsed, project });
        if (!projectCollapsed) pushEventRows(projectEvents, true);
        if (!projectCollapsed && (typeof options.onProjectAddItem === 'function' || typeof options.onProjectAddGroup === 'function')) rows.push({ type:'add', project, rollup });
      });
    } else {
      pushEventRows(events);
    }

    if (!rows.length) {
      const emptyZoomButtons = Object.entries(GANTT_ZOOM_PRESETS).map(([key, value]) => `<button type="button" class="psv-gantt-zoom-btn" data-psv-gantt-zoom="${value}">${key[0].toUpperCase()}${key.slice(1)}</button>`).join('');
      container.innerHTML = `<div class="psv-gantt-wrap">
        ${options.showToolbar === false ? '' : `<div class="psv-gantt-toolbar">${String(options.toolbarLeadingHtml || '')}<button type="button" class="psv-gantt-today-btn" data-psv-gantt-today>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_23929ba4ba84dd","Today") ?? "Today")}</button><div class="psv-gantt-zoom">${String(emptyZoomButtons)}<input type="range" class="psv-gantt-slider" min="0" max="100" step="1" value="${String(ganttSliderFromZoom(pxPerDay))}" data-psv-gantt-slider aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_2e8f0246df6a69","Timeline zoom") ?? "Timeline zoom")}"></div></div>`}
        <div class="psv-gantt-empty">${esc(options.emptyLabel || 'Nothing to schedule yet. Scheduled items from the scope will appear here.')}</div>
      </div>`;
      return;
    }

    // Time range: min start → max end across scheduled events, padded.
    const starts = events.map(evStart).filter(Boolean).map((d) => d.getTime());
    const ends = events.map(evEnd).filter(Boolean).map((d) => d.getTime());
    const anchor = new Date(options.date || Date.now());
    anchor.setHours(0, 0, 0, 0);
    const padDays = pxPerDay >= 960 ? 1 : pxPerDay >= 90 ? 3 : 14;
    let rangeStart = new Date(starts.length ? Math.min(...starts, anchor.getTime()) : anchor.getTime());
    rangeStart.setHours(0, 0, 0, 0);
    rangeStart = addDays(rangeStart, -padDays);
    let rangeEnd = new Date(ends.length ? Math.max(...ends, anchor.getTime()) : anchor.getTime());
    rangeEnd.setHours(0, 0, 0, 0);
    rangeEnd = addDays(rangeEnd, padDays + 1);
    const totalDays = Math.max(7, dayDiff(rangeStart, rangeEnd));
    rangeEnd = addDays(rangeStart, totalDays);
    const totalWidth = Math.round(totalDays * pxPerDay);
    const xForTime = (time) => ((time - rangeStart.getTime()) / 86400000) * pxPerDay;
    const timeForX = (x) => rangeStart.getTime() + (x / pxPerDay) * 86400000;

    // Header ticks adapt to zoom.
    const minorTicks = [];
    const majorTicks = [];
    if (pxPerDay >= 960) {
      const hourStep = pxPerDay >= 1900 ? 1 : 3;
      for (let day = 0; day < totalDays; day += 1) {
        const dayDate = addDays(rangeStart, day);
        majorTicks.push({ x:day * pxPerDay, width:pxPerDay, label:dayDate.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' }) });
        for (let hour = 0; hour < 24; hour += hourStep) {
          const tickDate = new Date(dayDate); tickDate.setHours(hour);
          minorTicks.push({ x:(day + hour / 24) * pxPerDay, width:(hourStep / 24) * pxPerDay, label:tickDate.toLocaleTimeString([], { hour:'numeric' }), weekend:[0,6].includes(dayDate.getDay()) });
        }
      }
    } else if (pxPerDay >= 24) {
      let monthStart = 0;
      for (let day = 0; day < totalDays; day += 1) {
        const dayDate = addDays(rangeStart, day);
        minorTicks.push({ x:day * pxPerDay, width:pxPerDay, label:pxPerDay >= 60 ? dayDate.toLocaleDateString([], { weekday:'narrow', day:'numeric' }) : String(dayDate.getDate()), weekend:[0,6].includes(dayDate.getDay()) });
        const next = addDays(dayDate, 1);
        if (next.getMonth() !== dayDate.getMonth() || day === totalDays - 1) {
          majorTicks.push({ x:monthStart * pxPerDay, width:(day + 1 - monthStart) * pxPerDay, label:dayDate.toLocaleDateString([], { month:'long', year:'numeric' }) });
          monthStart = day + 1;
        }
      }
    } else {
      let monthStart = 0;
      const weekAnchor = startOfWeek(rangeStart);
      for (let time = weekAnchor.getTime(); time < rangeEnd.getTime(); time += 7 * 86400000) {
        const weekDate = new Date(time);
        const x = Math.max(0, xForTime(time));
        minorTicks.push({ x, width:7 * pxPerDay, label:weekDate.toLocaleDateString([], { month:'numeric', day:'numeric' }), weekend:false });
      }
      for (let day = 0; day < totalDays; day += 1) {
        const dayDate = addDays(rangeStart, day);
        const next = addDays(dayDate, 1);
        if (next.getMonth() !== dayDate.getMonth() || day === totalDays - 1) {
          majorTicks.push({ x:monthStart * pxPerDay, width:(day + 1 - monthStart) * pxPerDay, label:dayDate.toLocaleDateString([], { month:'short', year:'2-digit' }) });
          monthStart = day + 1;
        }
      }
    }

    const rowOffsets = [];
    let bodyHeight = 0;
    rows.forEach((row) => {
      rowOffsets.push(bodyHeight);
      bodyHeight += row.type === 'section' ? GANTT_SECTION_H : row.type === 'add' ? GANTT_ADD_H : row.projectRollup ? GANTT_PROJECT_H : GANTT_ROW_H;
    });
    const rowIndexByEventId = new Map();
    rows.forEach((row, index) => {
      if (row.type === 'event') rowIndexByEventId.set(String(row.event.id || ''), index);
    });

    const laneBackground = (() => {
      if (pxPerDay >= 24) {
        const weekendStart = ((8 - rangeStart.getDay()) % 7) * pxPerDay;
        return `background-image:repeating-linear-gradient(90deg,rgba(15,23,42,.06) 0 1px,transparent 1px ${pxPerDay}px),repeating-linear-gradient(90deg,rgba(15,23,42,.03) 0 ${2 * pxPerDay}px,transparent ${2 * pxPerDay}px ${7 * pxPerDay}px);background-position:0 0,${weekendStart - pxPerDay}px 0;`;
      }
      const weekOffset = -((rangeStart.getTime() - startOfWeek(rangeStart).getTime()) / 86400000) * pxPerDay;
      return `background-image:repeating-linear-gradient(90deg,rgba(15,23,42,.05) 0 1px,transparent 1px ${7 * pxPerDay}px);background-position:${weekOffset}px 0;`;
    })();

    const barHtml = (row) => {
      const event = row.event;
      const start = evStart(event);
      if (!isScheduled(event) || !start) return '';
      const end = evEnd(event) || new Date(start.getTime() + 86400000);
      const left = xForTime(start.getTime());
      const width = Math.max(6, xForTime(end.getTime()) - left);
      const presentation = ganttPresentation(Scheduling, event);
      const kind = presentation.kind || eventKind(event);
      const color = safeCssColor(presentation.color) || ganttDefaultColor(kind);
      const icon = safeIconClass(presentation.icon || ganttDefaultIcon(kind), '');
      const locked = presentation.locked === true;
      const derived = event.__rollup_derived === true && !row.projectRollup;
      const showLabel = width >= 56;
      const downtime = clean(event.kind).toLowerCase() === 'equipment_downtime';
      const canLink = !readOnly && (!row.group || row.projectRollup) && !groupByResource && typeof options.onDependencyCreate === 'function';
      return `<div class="psv-gantt-bar ${row.group ? `group-bar ${derived ? 'derived' : ''}` : ''} ${locked ? 'locked' : ''} ${row.overlap ? 'overlap' : ''} ${downtime ? 'downtime' : ''}" style="left:${left}px;width:${width}px;--psv-gantt-color:${color}" data-psv-gantt-bar="${esc(event.id || '')}" title="${esc(`${event.title || ''} · ${formatRange(start, end, event.all_day !== false)}`)}">
        ${!readOnly && !locked && !(row.group && derived) ? '<span class="psv-gantt-handle start" data-psv-gantt-handle="start"></span><span class="psv-gantt-handle end" data-psv-gantt-handle="end"></span>' : ''}
        ${row.group ? '' : `<span class="psv-gantt-bar-inner">${icon ? `<i class="fas ${icon}"></i>` : ''}${showLabel ? `<span>${esc(event.title || '')}</span>` : ''}</span>`}
        ${canLink ? ("<span class=\"psv-gantt-link-handle\" data-psv-gantt-link title=\"" + (globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_02f3d713657baf","Drag to another item to make it follow this one") ?? "Drag to another item to make it follow this one") + "\"></span>") : ''}
      </div>`;
    };

    const labelHtml = (row) => {
      if (row.type === 'section') return `<div class="psv-gantt-label">${esc(row.label)}</div>`;
      if (row.type === 'add') return `<div class="psv-gantt-label">${typeof options.onProjectAddItem === 'function' ? `<button type="button" class="psv-gantt-add" data-psv-gantt-add="${String(esc(row.project?.id || ''))}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_1371f530e8450b",`Add work item to ${v1}`,{v1}) ?? `Add work item to ${v1}`)(esc(row.rollup?.title || 'project'))}" title="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_5615a483a3982f","Add work item") ?? "Add work item")}"><i class="fas fa-plus"></i></button>` : ''}${typeof options.onProjectAddGroup === 'function' ? `<button type="button" class="psv-gantt-add" data-psv-gantt-add-group="${String(esc(row.project?.id || ''))}" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_cb322b4f3abe82",`Add section to ${v1}`,{v1}) ?? `Add section to ${v1}`)(esc(row.rollup?.title || 'project'))}" title="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_29c41c89d5fb81","Add section") ?? "Add section")}"><i class="fas fa-layer-group"></i></button>` : ''}</div>`;
      const event = row.event;
      const presentation = ganttPresentation(Scheduling, event);
      const kind = presentation.kind || eventKind(event);
      const color = safeCssColor(presentation.color) || ganttDefaultColor(kind);
      const icon = safeIconClass(presentation.icon || ganttDefaultIcon(kind), '');
      const assignee = clean(event.assigned_crew_name || event.assigned_user_name || (event.assigned_users || [])[0]?.name);
      const caret = row.group && row.hasChildren
        ? ("<button type=\"button\" class=\"psv-gantt-caret\" data-psv-gantt-toggle=\"" + String(esc(event.id || '')) + "\" aria-label=\"" + ((v1) => globalThis.PlatformLanguage?.text("platform-schedule-view","m_bc0ff2f99b0574",`${v1} group`,{v1}) ?? `${v1} group`)(row.collapsed ? 'Expand' : 'Collapse') + "\"><i class=\"fas fa-chevron-" + String(row.collapsed ? 'right' : 'down') + "\"></i></button>")
        : (row.child ? '' : '<span style="width:0"></span>');
      return `<div class="psv-gantt-label ${row.child ? 'child' : ''} ${row.grandchild ? 'grandchild' : ''}">
        ${caret}
        <span class="psv-gantt-dot" style="--psv-gantt-color:${color}">${icon && !row.group ? `<i class="fas ${icon}"></i>` : ''}</span>
        <span class="psv-gantt-label-title" data-psv-gantt-open="${esc(event.id || '')}">${esc(event.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_05017f54f07448","Untitled") ?? "Untitled"))}</span>
        <span class="psv-gantt-label-meta">${esc(!isScheduled(event) ? 'Unscheduled' : assignee)}</span>
      </div>`;
    };

    const rowsHtml = rows.map((row) => {
      if (row.type === 'section') return `<div class="psv-gantt-row section">${labelHtml(row)}<div class="psv-gantt-lane" style="width:${totalWidth}px;${laneBackground}"></div></div>`;
      if (row.type === 'add') return `<div class="psv-gantt-row add-row">${labelHtml(row)}<div class="psv-gantt-lane" style="width:${totalWidth}px"></div></div>`;
      const unscheduled = !isScheduled(row.event);
      const laneClasses = ['psv-gantt-lane', unscheduled && !readOnly && !row.projectRollup ? 'unscheduled-lane' : ''].filter(Boolean).join(' ');
      return `<div class="psv-gantt-row ${row.group ? 'group-row' : ''} ${row.projectRollup ? 'project-row' : ''}">${labelHtml(row)}<div class="${laneClasses}" style="width:${totalWidth}px;${laneBackground}" data-psv-gantt-lane="${esc(row.event.id || '')}">${barHtml(row)}</div></div>`;
    }).join('');

    // Dependency connectors (drawn only between visible scheduled rows).
    const linkPaths = [];
    rows.forEach((row) => {
      // Resource lanes may repeat one event on several rows; connectors would mislead.
      if (groupByResource) return;
      if (row.type !== 'event') return;
      dependenciesOf(row.event).forEach((dep) => {
        const from = eventById.get(dep.event_id);
        const toIndex = rowIndexByEventId.get(String(row.event.id || ''));
        const fromIndex = rowIndexByEventId.get(dep.event_id);
        if (!from || fromIndex === undefined || toIndex === undefined) return;
        if (!isScheduled(from) || !isScheduled(row.event)) return;
        const fromAnchor = dep.type === 'start_to_start' ? evStart(from) : evEnd(from);
        const toStart = evStart(row.event);
        if (!fromAnchor || !toStart) return;
        const x1 = xForTime(fromAnchor.getTime());
        const x2 = xForTime(toStart.getTime());
        const y1 = rowOffsets[fromIndex] + (rows[fromIndex].projectRollup ? GANTT_PROJECT_H / 2 : GANTT_ROW_H / 2);
        const y2 = rowOffsets[toIndex] + (rows[toIndex].projectRollup ? GANTT_PROJECT_H / 2 : GANTT_ROW_H / 2);
        const d = x2 >= x1 + 18
          ? `M${x1},${y1} L${x1 + 8},${y1} L${x1 + 8},${y2} L${x2 - 4},${y2}`
          : `M${x1},${y1} L${x1 + 8},${y1} L${x1 + 8},${y1 + (y2 > y1 ? GANTT_ROW_H / 2 : -GANTT_ROW_H / 2)} L${x2 - 12},${y1 + (y2 > y1 ? GANTT_ROW_H / 2 : -GANTT_ROW_H / 2)} L${x2 - 12},${y2} L${x2 - 4},${y2}`;
        linkPaths.push(`<path class="psv-gantt-link" d="${d}" marker-end="url(#psvGanttArrow)" data-psv-gantt-dep="${esc(`${row.event.id}::${dep.id}`)}"><title>${esc(`${from.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_5be12a31e41de3","Item") ?? "Item")} drives ${row.event.title || (globalThis.PlatformLanguage?.text("platform-schedule-view","m_2960d6240e6f28","item") ?? "item")}${dep.lag_minutes ? ` (+${Math.round(dep.lag_minutes / 60)}h lag)` : ''} — click to unlink`)}</title></path>`);
      });
    });

    const todayX = xForTime(Date.now());
    const zoomButtons = Object.entries(GANTT_ZOOM_PRESETS).map(([key, value]) => {
      const active = Math.abs(ganttSliderFromZoom(value) - ganttSliderFromZoom(pxPerDay)) <= 4;
      return `<button type="button" class="psv-gantt-zoom-btn ${active ? 'active' : ''}" data-psv-gantt-zoom="${value}">${key[0].toUpperCase()}${key.slice(1)}</button>`;
    }).join('');

    container.innerHTML = `<div class="psv-gantt-wrap">
      ${options.showToolbar === false ? '' : `<div class="psv-gantt-toolbar">
        ${String(options.toolbarLeadingHtml || '')}
        <button type="button" class="psv-gantt-today-btn" data-psv-gantt-today>${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_23929ba4ba84dd","Today") ?? "Today")}</button>
        <div class="psv-gantt-zoom">${String(zoomButtons)}<input type="range" class="psv-gantt-slider" min="0" max="100" step="1" value="${String(ganttSliderFromZoom(pxPerDay))}" data-psv-gantt-slider aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_2e8f0246df6a69","Timeline zoom") ?? "Timeline zoom")}"></div>
      </div>`}
      <div class="psv-gantt-scroll">
        <div class="psv-gantt-inner" style="--psv-gantt-left:${Math.max(120, Number(options.leftWidth) || 248)}px">
          <div class="psv-gantt-head">
            <div class="psv-gantt-corner">${esc(options.resourceHeader || 'Work Item')}</div>
            <div class="psv-gantt-ticks" style="width:${totalWidth}px">
              ${majorTicks.map((tick) => `<div class="psv-gantt-tick-major" style="left:${tick.x}px;width:${tick.width}px">${esc(tick.label)}</div>`).join('')}
              ${minorTicks.map((tick) => `<div class="psv-gantt-tick-minor ${tick.weekend ? 'weekend' : ''}" style="left:${tick.x}px;width:${tick.width}px">${esc(tick.label)}</div>`).join('')}
            </div>
          </div>
          <div class="psv-gantt-body">
            ${rowsHtml}
            <svg class="psv-gantt-links" style="left:var(--psv-gantt-left);top:0;width:${totalWidth}px;height:${bodyHeight}px" viewBox="0 0 ${totalWidth} ${bodyHeight}" preserveAspectRatio="none">
              <defs><marker id="psvGanttArrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" fill="#94a3b8"></path></marker></defs>
              ${linkPaths.join('')}
            </svg>
            ${todayX >= 0 && todayX <= totalWidth ? `<div class="psv-gantt-today" style="left:calc(var(--psv-gantt-left) + ${todayX}px)"></div>` : ''}
          </div>
        </div>
      </div>
    </div>`;

    const scroll = container.querySelector('.psv-gantt-scroll');
    const body = container.querySelector('.psv-gantt-body');
    const svg = container.querySelector('.psv-gantt-links');
    const leftWidth = Math.max(120, Number(options.leftWidth) || 248);

    const rerender = (anchorTime = null) => {
      const viewportCenterTime = anchorTime ?? (scroll ? timeForX(scroll.scrollLeft + (scroll.clientWidth - leftWidth) / 2) : null);
      const top = scroll?.scrollTop || 0;
      renderGanttScheduler(container, container.__psvGanttOptions || options);
      const nextScroll = container.querySelector('.psv-gantt-scroll');
      if (nextScroll && viewportCenterTime) {
        const nextOptions = container.__psvGanttOptions || options;
        const nextPx = container.__psvGanttPxPerDay || pxPerDay;
        void nextOptions;
        const nextInner = container.querySelector('.psv-gantt-inner');
        void nextInner;
        // Recompute using the fresh range rendered above.
        const marker = container.__psvGanttRangeStart || rangeStart.getTime();
        nextScroll.scrollLeft = Math.max(0, ((viewportCenterTime - marker) / 86400000) * nextPx - (nextScroll.clientWidth - leftWidth) / 2);
        nextScroll.scrollTop = top;
      }
    };
    container.__psvGanttRangeStart = rangeStart.getTime();

    if (container.__psvGanttInitialScroll !== true && scroll) {
      container.__psvGanttInitialScroll = true;
      const firstStart = starts.length ? Math.min(...starts) : anchor.getTime();
      scroll.scrollLeft = Math.max(0, xForTime(Math.min(firstStart, Date.now())) - pxPerDay);
    }

    container.querySelector('[data-psv-gantt-today]')?.addEventListener('click', () => {
      if (!scroll) return;
      scroll.scrollTo({ left:Math.max(0, todayX - (scroll.clientWidth - leftWidth) / 3), behavior:'smooth' });
    });
    container.querySelectorAll('[data-psv-gantt-zoom]').forEach((btn) => btn.addEventListener('click', () => {
      container.__psvGanttPxPerDay = Number(btn.dataset.psvGanttZoom) || GANTT_ZOOM_PRESETS.week;
      options.onZoomChange?.(container.__psvGanttPxPerDay);
      rerender();
    }));
    const slider = container.querySelector('[data-psv-gantt-slider]');
    const liveZoom = () => {
      container.__psvGanttPxPerDay = ganttZoomFromSlider(slider.value);
      options.onZoomChange?.(container.__psvGanttPxPerDay);
      rerender();
    };
    slider?.addEventListener('input', liveZoom);
    container.querySelectorAll('[data-psv-gantt-toggle]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const id = String(btn.dataset.psvGanttToggle || '');
      if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
      options.onGroupToggle?.(id, collapsed.has(id));
      rerender();
    }));
    container.querySelectorAll('[data-psv-gantt-open]').forEach((node) => node.addEventListener('click', () => {
      const item = eventById.get(String(node.dataset.psvGanttOpen || ''));
      if (item) options.onEventClick?.(item, { element:node, action:'open' });
    }));
    container.querySelectorAll('[data-psv-gantt-add]').forEach((node) => node.addEventListener('click', () => {
      const project = projects?.find((item) => String(item.id || '') === String(node.dataset.psvGanttAdd || ''));
      if (project) options.onProjectAddItem?.(project, { element:node });
    }));
    container.querySelectorAll('[data-psv-gantt-add-group]').forEach((node) => node.addEventListener('click', () => {
      const project = projects?.find((item) => String(item.id || '') === String(node.dataset.psvGanttAddGroup || ''));
      if (project) options.onProjectAddGroup?.(project, { element:node });
    }));
    if (typeof options.onDependencyRemove === 'function' && !readOnly) {
      container.querySelectorAll('[data-psv-gantt-dep]').forEach((path) => path.addEventListener('click', () => {
        const [eventId, depId] = String(path.dataset.psvGanttDep || '').split('::');
        const item = eventById.get(eventId);
        const dep = item ? dependenciesOf(item).find((entry) => entry.id === depId) : null;
        if (item && dep) options.onDependencyRemove(item, dep);
      }));
    }

    if (readOnly) return;

    const snapMsFor = (event) => {
      if (event.all_day !== false || clean(event.schedule_granularity) === 'date') return 86400000;
      if (pxPerDay >= 960) return 15 * 60000;
      if (pxPerDay >= 240) return 60 * 60000;
      return 86400000;
    };
    const snapTime = (time, snapMs) => Math.round(time / snapMs) * snapMs;
    const rangePayload = (event, startMs, endMs) => ({
      start:new Date(startMs),
      end:new Date(endMs),
      all_day:event.all_day !== false,
      schedule_granularity:clean(event.schedule_granularity) || (event.all_day !== false ? 'date' : 'time'),
    });
    let drag = null;
    const laneX = (clientX) => {
      const rect = body.getBoundingClientRect();
      return clientX - rect.left - leftWidth;
    };
    const clearGhosts = () => container.querySelectorAll('.psv-gantt-bar.ghost, .psv-gantt-link-temp').forEach((node) => node.remove());
    const ghostForCascade = (drafts) => {
      clearGhosts();
      drafts.forEach((draft) => {
        const index = rowIndexByEventId.get(String(draft.id || ''));
        if (index === undefined) return;
        const lane = container.querySelector(`[data-psv-gantt-lane="${cssEscape(String(draft.id || ''))}"]`);
        const start = new Date(draft.start_at || draft.start);
        const end = new Date(draft.end_at || draft.end);
        if (!lane || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
        const ghost = document.createElement('div');
        ghost.className = 'psv-gantt-bar ghost';
        ghost.style.left = `${xForTime(start.getTime())}px`;
        ghost.style.width = `${Math.max(6, xForTime(end.getTime()) - xForTime(start.getTime()))}px`;
        lane.appendChild(ghost);
      });
    };

    container.querySelectorAll('[data-psv-gantt-bar]').forEach((bar) => {
      bar.addEventListener('click', (clickEvent) => {
        if (bar.__psvGanttDragged || clickEvent.target.closest('[data-psv-gantt-handle],[data-psv-gantt-link]')) {
          bar.__psvGanttDragged = false;
          return;
        }
        const item = eventById.get(String(bar.dataset.psvGanttBar || ''));
        if (item) options.onEventClick?.(item, { element:bar, action:'open' });
      });
      bar.addEventListener('pointerdown', (pointerEvent) => {
        const item = eventById.get(String(bar.dataset.psvGanttBar || ''));
        if (!item || eventIsLocked(item)) return;
        if (pointerEvent.target.closest('[data-psv-gantt-link]')) {
          pointerEvent.preventDefault();
          drag = { kind:'link', from:item, fromBar:bar, startX:pointerEvent.clientX, startY:pointerEvent.clientY };
          bar.setPointerCapture?.(pointerEvent.pointerId);
          return;
        }
        const groupDerived = isGroup(item) && item.__rollup_derived === true;
        if (groupDerived) return;
        const handle = pointerEvent.target.closest('[data-psv-gantt-handle]')?.dataset.psvGanttHandle || 'move';
        const start = evStart(item); const end = evEnd(item);
        if (!start || !end) return;
        pointerEvent.preventDefault();
        drag = {
          kind:handle, item, bar,
          startX:pointerEvent.clientX,
          baseStart:start.getTime(), baseEnd:end.getTime(),
          snapMs:snapMsFor(item), moved:false,
        };
        bar.setPointerCapture?.(pointerEvent.pointerId);
      });
    });

    container.querySelectorAll('.psv-gantt-lane.unscheduled-lane').forEach((lane) => {
      lane.addEventListener('pointerdown', (pointerEvent) => {
        if (pointerEvent.target.closest('.psv-gantt-bar')) return;
        const item = eventById.get(String(lane.dataset.psvGanttLane || ''));
        if (!item) return;
        pointerEvent.preventDefault();
        const startMs = snapTime(timeForX(laneX(pointerEvent.clientX)), 86400000);
        drag = { kind:'create', item, lane, startMs, endMs:startMs + 86400000, snapMs:86400000, moved:false, startX:pointerEvent.clientX };
        lane.setPointerCapture?.(pointerEvent.pointerId);
        const ghost = document.createElement('div');
        ghost.className = 'psv-gantt-bar ghost';
        ghost.dataset.psvGanttCreateGhost = '1';
        lane.appendChild(ghost);
        drag.ghost = ghost;
        ghost.style.left = `${xForTime(startMs)}px`;
        ghost.style.width = `${pxPerDay}px`;
      });
    });

    container.addEventListener('pointermove', (pointerEvent) => {
      if (!drag) return;
      pointerEvent.preventDefault();
      if (Math.abs(pointerEvent.clientX - drag.startX) > 2) drag.moved = true;
      if (drag.moved && drag.bar) drag.bar.__psvGanttDragged = true;
      if (drag.kind === 'link') {
        const fromRect = drag.fromBar.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const x1 = fromRect.right - bodyRect.left - leftWidth;
        const y1 = fromRect.top + fromRect.height / 2 - bodyRect.top;
        const x2 = pointerEvent.clientX - bodyRect.left - leftWidth;
        const y2 = pointerEvent.clientY - bodyRect.top;
        let temp = svg.querySelector('.psv-gantt-link-temp');
        if (!temp) {
          temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          temp.setAttribute('class', 'psv-gantt-link-temp');
          svg.appendChild(temp);
        }
        temp.setAttribute('d', `M${x1},${y1} L${x2},${y2}`);
        return;
      }
      if (drag.kind === 'create') {
        const currentMs = snapTime(timeForX(laneX(pointerEvent.clientX)), drag.snapMs);
        drag.endMs = Math.max(drag.startMs + drag.snapMs, currentMs + drag.snapMs);
        drag.ghost.style.width = `${Math.max(6, xForTime(drag.endMs) - xForTime(drag.startMs))}px`;
        return;
      }
      const deltaMs = ((pointerEvent.clientX - drag.startX) / pxPerDay) * 86400000;
      let nextStart = drag.baseStart;
      let nextEnd = drag.baseEnd;
      if (drag.kind === 'move') {
        nextStart = snapTime(drag.baseStart + deltaMs, drag.snapMs);
        nextEnd = nextStart + (drag.baseEnd - drag.baseStart);
      } else if (drag.kind === 'start') {
        nextStart = Math.min(snapTime(drag.baseStart + deltaMs, drag.snapMs), drag.baseEnd - drag.snapMs);
      } else {
        nextEnd = Math.max(snapTime(drag.baseEnd + deltaMs, drag.snapMs), drag.baseStart + drag.snapMs);
      }
      drag.nextStart = nextStart;
      drag.nextEnd = nextEnd;
      drag.bar.classList.add('dragging');
      drag.bar.style.left = `${xForTime(nextStart)}px`;
      drag.bar.style.width = `${Math.max(6, xForTime(nextEnd) - xForTime(nextStart))}px`;
      if (drag.kind === 'move' && Scheduling?.cascadeDependentDrafts) {
        ghostForCascade(Scheduling.cascadeDependentDrafts(events, drag.item.id, rangePayload(drag.item, nextStart, nextEnd)));
      }
    });

    container.addEventListener('pointerup', (pointerEvent) => {
      if (!drag) return;
      const activeDrag = drag;
      drag = null;
      clearGhosts();
      activeDrag.bar?.classList.remove('dragging');
      if (activeDrag.kind === 'link') {
        const target = document.elementsFromPoint(pointerEvent.clientX, pointerEvent.clientY)
          .map((node) => node.closest?.('[data-psv-gantt-bar]')).find(Boolean);
        const toItem = target ? eventById.get(String(target.dataset.psvGanttBar || '')) : null;
        if (toItem && String(toItem.id) !== String(activeDrag.from.id)) options.onDependencyCreate?.(activeDrag.from, toItem);
        return;
      }
      if (activeDrag.kind === 'create') {
        activeDrag.ghost?.remove();
        // A plain click (no drag) schedules a one-day block on that day.
        const payload = { ...rangePayload(activeDrag.item, activeDrag.startMs, activeDrag.endMs), status:'scheduled' };
        (options.onEventSchedule || options.onEventRangeChange)?.(activeDrag.item, payload, { action:'schedule' });
        return;
      }
      if (!activeDrag.moved || activeDrag.nextStart === undefined) return;
      const payload = rangePayload(activeDrag.item, activeDrag.nextStart, activeDrag.nextEnd);
      const cascade = Scheduling?.cascadeDependentDrafts
        ? Scheduling.cascadeDependentDrafts(events, activeDrag.item.id, payload).filter((draft) => String(draft.id) !== String(activeDrag.item.id))
        : [];
      options.onEventRangeChange?.(activeDrag.item, payload, { cascade });
    });
  }

  function mobileCalendarToolbarHtml(options = {}){
    const date = new Date(options.date || Date.now());
    const viewChoices = Array.isArray(options.viewChoices) && options.viewChoices.length
      ? options.viewChoices
      : [['day','Day','fa-calendar-day'],['4day','3 Day','fa-calendar-week'],['week','Week','fa-table-columns'],['month','Month','fa-calendar-days']];
    const view = clean(options.view) || 'month';
    const active = viewChoices.find(([id]) => id === view) || viewChoices[0];
    const pickerMonth = Number.isInteger(options.pickerMonth) ? options.pickerMonth : date.getMonth();
    const pickerYear = Number.isFinite(Number(options.pickerYear)) ? Number(options.pickerYear) : date.getFullYear();
    const years = Array.isArray(options.years) && options.years.length ? options.years : Array.from({ length:11 }, (_, index) => date.getFullYear() - 5 + index);
    const months = Array.from({ length:12 }, (_, month) => new Date(2000, month, 1).toLocaleDateString([], { month:'long' }));
    const attrs = {
      viewMenu:'data-prs-mobile-view-menu',
      view:'data-prs-mobile-view',
      monthMenu:'data-prs-mobile-month-menu',
      month:'data-prs-mobile-month',
      year:'data-prs-mobile-year',
      today:'data-prs-mobile-today',
      nav:'data-prs-mobile-nav',
      ...(options.attributes || {})
    };
    return `<div class="prs-mobile-toolbar" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_4a6c30daa4c9b8","Schedule controls") ?? "Schedule controls")}">
      <span class="prs-mobile-menu"><button type="button" class="prs-mobile-control view" ${String(attrs.viewMenu)} aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_8fb1111b363b9a","Choose calendar view") ?? "Choose calendar view")}" aria-expanded="${String(options.viewMenuOpen ? 'true' : 'false')}"><i class="fas ${String(esc(active[2]))}"></i><i class="fas fa-chevron-down"></i></button>${String(options.viewMenuOpen ? `<div class="prs-mobile-popover" role="menu">${viewChoices.map(([id, label, icon]) => `<button type="button" class="${view === id ? 'active' : ''}" ${attrs.view}="${esc(id)}" role="menuitem"><i class="fas ${esc(icon)}"></i>${esc(label)}</button>`).join('')}</div>` : '')}</span>
      <span class="prs-mobile-menu"><button type="button" class="prs-mobile-control month" ${String(attrs.monthMenu)} aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_048b624b01eed1","Choose month") ?? "Choose month")}" aria-expanded="${String(options.monthMenuOpen ? 'true' : 'false')}"><span>${String(esc(date.toLocaleDateString([], { month:'long', year:'numeric' })))}</span><i class="fas fa-chevron-down"></i></button>${String(options.monthMenuOpen ? `<div class="prs-mobile-popover months" role="dialog" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_c59e80991af608","Choose month and year") ?? "Choose month and year")}"><div class="prs-mobile-month-picker"><section aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_f9835510940421","Month") ?? "Month")}">${months.map((label, month) => `<button type="button" class="${month === pickerMonth ? 'active' : ''}" ${attrs.month}="${month}">${esc(label)}</button>`).join('')}</section><section aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_844068116c424b","Year") ?? "Year")}">${years.map((year) => `<button type="button" class="${year === pickerYear ? 'active' : ''}" ${attrs.year}="${year}">${esc(year)}</button>`).join('')}</section></div></div>` : '')}</span>
      <button type="button" class="prs-mobile-control today" ${String(attrs.today)} aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_c7c9d0d1ba2803","Go to today") ?? "Go to today")}"><span class="prs-mobile-today-date">${String(date.getDate())}</span></button>
      <button type="button" class="prs-mobile-control nav" ${String(attrs.nav)}="-1" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_bb31fd73cbfe3b","Previous") ?? "Previous")}"><i class="fas fa-chevron-left"></i></button><button type="button" class="prs-mobile-control nav" ${String(attrs.nav)}="1" aria-label="${(globalThis.PlatformLanguage?.htmlText("platform-schedule-view","m_5e03a7c216f500","Next") ?? "Next")}"><i class="fas fa-chevron-right"></i></button>${String(options.trailingHtml || '')}
    </div>`;
  }

  root.PlatformScheduleView = {
    mobileCalendarToolbarHtml,
    travelSegmentLayout,
    renderDailyTeam,
    renderProjectRangeScheduler,
    renderResourceDayScheduler,
    renderResourceTimeScheduler,
    renderGanttScheduler,
    monthWeekRowCount,
    layoutTimedOverlapEntries,
    timedOverlapColumnGeometry,
    dailyEventSlotPlacement,
    packPreviewLaneSegments,
    prioritizePrimaryPlacementDraft,
    isMaterialDeliveryEvent,
    eventIsLocked,
    materialDeliveryIsOrdered,
    installPointerSmartScroll,
    installWheelHorizontalScroll,
    updateDraft,
    clearTravelCache(){ travelCache.clear(); },
  };
})();
