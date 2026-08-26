/* libraries/platform-action-items/platform-action-items.js
 * Browser helper for Platform action items, frontend kind handlers, and reusable to-do lists.
 */
(function(){
  const root = window;
  const PlatformAPI = root.PlatformAPI;
  const listeners = new Set();
  const kinds = new Map();
  let state = { action_items: [], items: [], active_count: 0, unread_count: 0, overdue_count: 0, loaded_at: null };

  function cleanText(value){
    return String(value ?? '').trim();
  }

  function firstText(...values){
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function escapeHtml(value){
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function notify(){
    const snapshot = getState();
    listeners.forEach((fn) => {
      try { fn(snapshot); } catch (error) {}
    });
  }

  function getState(){
    return {
      ...state,
      action_items: [...state.action_items],
      items: [...state.items]
    };
  }

  function registerKind(kind, definition = {}){
    const key = cleanText(kind);
    if (!key) return null;
    const current = kinds.get(key) || {};
    const next = { ...current, ...definition, kind: key };
    kinds.set(key, next);
    return next;
  }

  function kindDefinition(itemOrKind){
    const key = cleanText(typeof itemOrKind === 'string' ? itemOrKind : itemOrKind?.kind);
    return key ? kinds.get(key) || null : null;
  }

  function dateParts(date){
    return {
      year: date.getFullYear(),
      month: String(date.getMonth() + 1).padStart(2, '0'),
      day: String(date.getDate()).padStart(2, '0')
    };
  }

  function todayDateValue(now = new Date()){
    const parts = dateParts(now);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function datetimeLocalToIso(value){
    const raw = cleanText(value);
    if (!raw) return '';
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  function randomIdPart(){
    if (root.crypto?.randomUUID) return root.crypto.randomUUID().replace(/-/g, '').slice(0, 18);
    if (root.crypto?.getRandomValues) {
      const bytes = new Uint8Array(9);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function localDateKey(date){
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    const parts = dateParts(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function parseDue(value){
    const raw = cleanText(value);
    if (!raw) return { raw, date: null, hasTime: false };
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
      return {
        raw,
        date: new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0, 0),
        hasTime: false
      };
    }
    const hasTime = /[T\s]\d{1,2}:\d{2}/.test(raw);
    const parsed = new Date(raw);
    return {
      raw,
      date: Number.isNaN(parsed.getTime()) ? null : parsed,
      hasTime
    };
  }

  function todayBounds(now = new Date()){
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setMilliseconds(end.getMilliseconds() - 1);
    return { start, end, key: localDateKey(start) };
  }

  function addDays(date, days){
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  function itemId(item){
    return cleanText(item?.id || item?.action_item_id || item?.document_id);
  }

  function isCompleted(item){
    return cleanText(item?.status || 'open').toLowerCase() === 'completed' || !!cleanText(item?.completed_at);
  }

  function actionKind(item){
    const action = item?.frontend_action || item?.action || {};
    return cleanText(action.kind || action.type);
  }

  function itemIsActionable(item){
    const kind = actionKind(item);
    return !!kind && (kind !== 'manual' || projectIdForAction(item));
  }

  function renderLabel(item){
    const definition = kindDefinition(item);
    if (definition?.label) return typeof definition.label === 'function' ? definition.label(item) : definition.label;
    return cleanText(item?.title || item?.kind || 'Action item');
  }

  function projectLabel(item){
    const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
    const firstProjectId = Array.isArray(item?.project_ids) ? cleanText(item.project_ids[0]) : '';
    return firstText(
      item?.project_title ||
      item?.project_name ||
      item?.project_address ||
      payload.project_title ||
      payload.project_name ||
      payload.project_address ||
      payload.address ||
      item?.context_title ||
      (firstProjectId ? 'Project' : '')
    );
  }

  function projectAddress(item){
    const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
    return firstText(
      item?.project_address,
      item?.address,
      payload.project_address,
      payload.address,
      item?.context_address
    );
  }

  function itemTitle(item){
    return cleanText(item?.title || renderLabel(item) || 'Action item');
  }

  function itemStub(item){
    const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
    return cleanText(item?.stub || item?.body || item?.description || payload.stub || payload.body || payload.description || renderLabel(item));
  }

  function displayText(item){
    const project = projectLabel(item);
    const title = itemTitle(item);
    const stub = itemStub(item);
    if (cleanText(item?.kind || item?.type) === 'manual' && project) return { title, stub: project };
    if (project) return { title: project, stub: stub || title };
    return { title, stub: stub && stub !== title ? stub : cleanText(item?.kind || '') };
  }

  function tooltipHtml(item, text){
    const rows = [];
    const fullTitle = itemTitle(item);
    const description = itemStub(item);
    const project = projectLabel(item);
    const address = projectAddress(item);
    if (fullTitle && fullTitle !== text.title) rows.push(['Item', fullTitle]);
    if (description && description !== fullTitle && description !== text.stub) rows.push(['Description', description]);
    if (project) rows.push(['Project', project]);
    if (address && address !== project) rows.push(['Address', address]);
    if (!rows.length) {
      if (text.title) rows.push(['Item', text.title]);
      if (text.stub) rows.push(['Description', text.stub]);
    }
    const title = escapeHtml(text.title || fullTitle || renderLabel(item));
    const body = rows
      .filter(([, value]) => cleanText(value))
      .map(([name, value]) => `
        <div class="fm-tooltip-row pai-tip-row">
          <span class="fm-tooltip-name">${escapeHtml(name)}</span>
          <span class="fm-tooltip-value pai-tip-value">${escapeHtml(value)}</span>
        </div>
      `)
      .join('');
    return `<div class="fm-tooltip-title">${title}</div>${body}`;
  }

  function kindSortKey(item){
    const definition = kindDefinition(item);
    const kind = cleanText(item?.kind || item?.type);
    if (kind === 'manual') return '00_manual';
    return cleanText(definition?.orderKey || item?.sort_kind || kind || 'zz').toLowerCase();
  }

  function issuedSortValue(item){
    return Date.parse(cleanText(item?.issued_at || item?.created_at || item?.updated_at)) || 0;
  }

  function dueSortValue(item){
    const due = parseDue(item?.due_at);
    return due.date ? due.date.getTime() : Number.MAX_SAFE_INTEGER;
  }

  function sortItems(items, mode = 'due'){
    return [...items].sort((a, b) => {
      if (mode === 'kind') {
        const kind = kindSortKey(a).localeCompare(kindSortKey(b));
        if (kind) return kind;
      }
      const due = dueSortValue(a) - dueSortValue(b);
      if (due) return due;
      const type = kindSortKey(a).localeCompare(kindSortKey(b));
      if (type) return type;
      return issuedSortValue(a) - issuedSortValue(b);
    });
  }

  function dueMeta(item, now = new Date()){
    const due = parseDue(item?.due_at);
    if (!due.date) return { text: '', tone: '', hasTime: false, due };
    const bounds = todayBounds(now);
    const key = localDateKey(due.date);
    if (key < bounds.key) {
      return {
        text: due.date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        tone: 'past',
        hasTime: due.hasTime,
        due
      };
    }
    if (key > bounds.key) {
      return {
        text: due.hasTime
          ? due.date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : due.date.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        tone: 'upcoming',
        hasTime: due.hasTime,
        due
      };
    }
    if (due.hasTime) {
      return {
        text: due.date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        tone: due.date > now ? 'upcoming' : 'current',
        hasTime: true,
        due
      };
    }
    return { text: '', tone: 'current', hasTime: false, due };
  }

  function tomorrowDueValue(item, now = new Date()){
    const due = parseDue(item?.due_at);
    const next = addDays(now, 1);
    if (!due.hasTime) {
      const parts = dateParts(next);
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
    if (due.date) {
      next.setHours(due.date.getHours(), due.date.getMinutes(), due.date.getSeconds(), due.date.getMilliseconds());
    }
    return next.toISOString();
  }

  function todayListOptions(options = {}){
    const bounds = todayBounds(options.now instanceof Date ? options.now : new Date());
    const {
      now,
      serverFilterDueBefore,
      dueBefore,
      due_before,
      ...rest
    } = options || {};
    const next = {
      ...rest,
      includeCompleted: true,
    };
    if (serverFilterDueBefore === true) {
      next.dueBefore = dueBefore || due_before || bounds.end.toISOString();
    }
    return next;
  }

  function isDueTodayOrEarlier(item, now = new Date()){
    const due = parseDue(item?.due_at);
    if (!due.date) return false;
    return due.date.getTime() <= todayBounds(now).end.getTime();
  }

  function completedBelongsToToday(item, now = new Date()){
    const bounds = todayBounds(now);
    const completedAt = parseDue(item?.completed_at || item?.updated_at);
    const due = parseDue(item?.due_at);
    return (completedAt.date && localDateKey(completedAt.date) === bounds.key)
      || (due.date && localDateKey(due.date) === bounds.key);
  }

  function prepareTodayList(items = [], options = {}){
    const now = options.now instanceof Date ? options.now : new Date();
    const bounds = todayBounds(now);
    const pastDue = [];
    const current = [];
    const upcoming = [];
    const completed = [];
    const unassigned = [];

    (Array.isArray(items) ? items : []).forEach((item) => {
      const due = parseDue(item?.due_at);
      if (isCompleted(item)) {
        if (completedBelongsToToday(item, now)) completed.push(item);
        return;
      }
      if (!due.date) {
        unassigned.push(item);
        return;
      }
      const key = localDateKey(due.date);
      if (key < bounds.key) pastDue.push(item);
      else if (key > bounds.key || (key === bounds.key && due.hasTime && due.date > now)) upcoming.push(item);
      else if (key === bounds.key) current.push(item);
    });

    return {
      past_due: sortItems(pastDue, 'due'),
      current: sortItems([...current, ...unassigned], 'kind'),
      upcoming: sortItems(upcoming, 'due'),
      completed: sortItems(completed, 'due'),
      visible_count: pastDue.length + current.length + upcoming.length + unassigned.length,
      completed_count: completed.length
    };
  }

  async function load(orgId, options = {}){
    if (!PlatformAPI?.actionItems || !orgId) return getState();
    const data = await PlatformAPI.actionItems.list(orgId, options);
    const items = Array.isArray(data.action_items) ? data.action_items : (Array.isArray(data.items) ? data.items : []);
    state = {
      action_items: items,
      items,
      active_count: Number(data.active_count ?? items.length) || items.length,
      unread_count: Number(data.unread_count ?? items.filter((item) => !item?.user_state?.seen_at).length) || 0,
      overdue_count: Number(data.overdue_count ?? 0) || 0,
      loaded_at: new Date().toISOString()
    };
    notify();
    return getState();
  }

  function loadToday(orgId, options = {}){
    return load(orgId, todayListOptions(options));
  }

  async function setState(orgId, actionItemId, patch = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.setUserState(orgId, actionItemId, patch);
    if (options.reload !== false) await load(orgId, options);
    return result?.state || result;
  }

  async function patch(orgId, actionItemId, data = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.patch(orgId, actionItemId, data || {});
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result?.document || result;
  }

  async function complete(orgId, actionItemId, payload = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.complete(orgId, actionItemId, payload);
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result;
  }

  async function claim(orgId, actionItemId, payload = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.claim(orgId, actionItemId, payload);
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result;
  }

  async function cancel(orgId, actionItemId, payload = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.cancel(orgId, actionItemId, payload);
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result;
  }

  function currentUserId(options = {}){
    return cleanText(
      options.userId,
      options.user_id,
      root.__APP?.userId,
      root.__APP?.user_id,
      root.Portal?.currentUser?.id,
      root.Portal?.currentUser?.user_id
    );
  }

  async function createManual(orgId, title, options = {}){
    const text = cleanText(title);
    if (!PlatformAPI?.actionItems || !orgId || !text) return null;
    const userId = currentUserId(options);
    const projectId = firstText(options.projectId, options.project_id);
    const projectTitle = firstText(options.projectTitle, options.project_title, options.contextTitle, options.context_title);
    const projectAddress = firstText(options.projectAddress, options.project_address, options.contextAddress, options.context_address);
    const item = {
      id: cleanText(options.id) || `action_item_manual_${Date.now().toString(36)}_${randomIdPart()}`,
      kind: 'manual',
      title: text,
      body: cleanText(options.body || options.description),
      due_at: cleanText(options.due_at || options.dueAt),
      branch_id: cleanText(options.branchId || options.branch_id || root.__APP?.userBranchId || root.__APP?.branchId || 'default') || 'default',
      source: 'manual',
      frontend_action: { kind: 'manual' },
      metadata: { created_from: cleanText(options.source || 'today_list') || 'today_list', ...(options.metadata || {}) }
    };
    if (projectId) {
      item.project_ids = [projectId];
      item.project_id = projectId;
      item.context_title = projectTitle || 'Project';
      if (projectTitle) item.project_title = projectTitle;
      if (projectAddress) {
        item.project_address = projectAddress;
        item.context_address = projectAddress;
      }
      item.payload = {
        ...(item.payload || {}),
        project_id: projectId,
        ...(projectTitle ? { project_title: projectTitle } : {}),
        ...(projectAddress ? { project_address: projectAddress, address: projectAddress } : {})
      };
    }
    if (userId) item.assigned_user_ids = [userId];
    const result = await PlatformAPI.actionItems.create(orgId, item);
    if (options.reload !== false) await loadToday(orgId, options);
    return result?.action_item || result;
  }

  async function snoozeToTomorrow(orgId, actionItemOrId, options = {}){
    const item = typeof actionItemOrId === 'object' ? actionItemOrId : null;
    const actionItemId = item ? itemId(item) : cleanText(actionItemOrId);
    const due_at = cleanText(options.due_at || options.dueAt || (item ? tomorrowDueValue(item, options.now) : addDays(new Date(), 1).toISOString()));
    return await patch(orgId, actionItemId, { due_at }, options);
  }

  async function open(item, context = {}){
    const definition = kindDefinition(item);
    if (definition?.open) return await definition.open(item, context);
    const action = item?.frontend_action || item?.action || {};
    const actionKind = cleanText(action.kind || action.type);
    const actionDefinition = actionKind ? kinds.get(actionKind) : null;
    if (actionDefinition?.open) return await actionDefinition.open(item, context);
    return null;
  }

  function projectIdForAction(item, action = {}){
    return cleanText(
      action.project_id,
      action.projectId,
      item?.project_id,
      item?.projectId,
      Array.isArray(item?.project_ids) ? item.project_ids[0] : ''
    );
  }

  async function openProjectAction(item, action = {}, fallbackTab = 'map'){
    const projectId = projectIdForAction(item, action);
    if (!projectId) return null;
    const tab = cleanText(action.tab || action.project_tab || action.projectTab || fallbackTab) || fallbackTab;
    const proposalId = cleanText(action.proposal_id || action.proposalId || item?.proposal_id || item?.proposalId);
    const openOptions = {
      tab,
      ...(proposalId ? { proposalId, proposal_id: proposalId } : {})
    };
    let project = {
      id: projectId,
      platform_project_id: projectId,
      ...(proposalId ? { active_proposal_id: proposalId, proposal_id: proposalId } : {})
    };
    if (root.Portal?.routeState?.resolveProject) {
      const resolved = await root.Portal.routeState.resolveProject(projectId).catch(() => null);
      if (resolved && typeof resolved === 'object') {
        project = {
          ...resolved,
          id: resolved.id || projectId,
          platform_project_id: resolved.platform_project_id || projectId,
          ...(proposalId ? { active_proposal_id: proposalId, proposal_id: proposalId } : {})
        };
      }
    }
    if (root.Portal?.modules?.request?.openProject) {
      return root.Portal.modules.request.openProject(project, openOptions);
    }
    if (root.Portal?.ProjectModal?.open) {
      return root.Portal.ProjectModal.open(projectId, openOptions);
    }
    root.dispatchEvent?.(new CustomEvent('platform-action-item-open-project', {
      detail: { item, project_id: projectId, platform_project_id: projectId, tab, proposal_id: proposalId }
    }));
    return { project_id: projectId, tab, proposal_id: proposalId };
  }

  function subscribe(fn){
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    fn(getState());
    return () => listeners.delete(fn);
  }

  function injectListStyles(){
    if (document.getElementById('platform_action_items_today_styles')) return;
    const style = document.createElement('style');
    style.id = 'platform_action_items_today_styles';
    style.textContent = `
      .pai-today-list{display:flex;flex-direction:column;gap:3px;min-height:0;color:#202124;font-size:11px}
      .pai-composer{display:grid;grid-template-columns:20px minmax(0,1fr) 26px 26px;align-items:center;gap:7px;border:1px solid rgba(15,23,42,.10);border-left:3px solid var(--primary-readable, var(--primary, #d93025));border-radius:8px;background:#fff;padding:7px;margin-bottom:7px}
      .pai-composer-icon{width:18px;height:18px;border-radius:999px;border:1.5px solid rgba(15,23,42,.22);display:grid;place-items:center;color:#6b7280;font-size:10px}
      .pai-composer input{width:100%;border:0;outline:none;background:transparent;color:#202124;font-size:11px;font-weight:850;line-height:1.2;min-width:0}
      .pai-composer input::placeholder{color:#8b95a1}
      .pai-add,.pai-schedule-toggle{width:26px;height:26px;min-width:26px;min-height:26px;aspect-ratio:1;border:1px solid currentColor;border-radius:50%;background:color-mix(in srgb, var(--primary-readable, var(--primary, #d93025)) 8%, #fff);color:var(--primary-readable, var(--primary, #d93025));display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease;padding:0;line-height:1}
      .pai-schedule-toggle{background:#fff;color:#64748b}
      .pai-add:hover,.pai-schedule-toggle:hover,.pai-schedule-toggle.active{background:var(--primary-readable, var(--primary, #d93025));border-color:var(--primary-readable, var(--primary, #d93025));color:#fff}
      .pai-add i,.pai-schedule-toggle i{font-size:11px;line-height:1;display:block;width:1em;text-align:center}
      .pai-schedule-panel{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center;padding-top:2px}
      .pai-schedule-panel[hidden]{display:none}
      .pai-schedule-panel input{border:1px solid rgba(15,23,42,.12);border-radius:7px;padding:6px 8px;font-size:11px;font-weight:850;color:#202124;background:#fff;min-height:30px}
      .pai-schedule-clear{border:1px solid rgba(15,23,42,.12);border-radius:7px;background:#fff;color:#64748b;min-height:30px;padding:0 8px;font-size:10px;font-weight:950;cursor:pointer}
      .pai-schedule-clear:hover{color:var(--primary-readable, var(--primary, #d93025));border-color:rgba(var(--primary-rgb,217,48,37),.24)}
      .pai-composer.is-saving{opacity:.65;pointer-events:none}
      .pai-state{padding:14px 10px;border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#f8fafc;color:#64748b;font-size:11px;font-weight:850;line-height:1.35;text-align:center}
      .pai-section{display:flex;flex-direction:column;gap:3px}
      .pai-section.pai-upcoming{margin-top:1px}
      .pai-row{--pai-tone-color:#5a9f6c;width:100%;border:0;background:transparent;border-radius:6px;padding:2px 1px;display:grid;grid-template-columns:34px minmax(0,1fr) auto 24px;align-items:center;gap:6px;text-align:left;cursor:pointer;min-height:38px;max-height:52px;opacity:1;transform:translateY(0);overflow:hidden;transition:max-height .2s ease, opacity .16s ease, transform .16s ease, padding .18s ease, margin .18s ease, background .14s ease}
      .pai-row:hover{background:rgba(90,159,108,.075)}
      .pai-row.pai-actionable{--pai-tone-color:#18864a}
      .pai-row.pai-actionable .pai-title{text-decoration:underline;text-decoration-color:color-mix(in srgb, var(--pai-tone-color) 34%, transparent);text-underline-offset:2px}
      .pai-row.pai-actionable:hover{background:rgba(24,134,74,.115)}
      .pai-row.pai-tone-past{--pai-tone-color:#b3261e}
      .pai-row.pai-tone-past.pai-actionable{--pai-tone-color:#a83228}
      .pai-row.pai-tone-past:hover{background:rgba(179,38,30,.075)}
      .pai-row.pai-tone-upcoming{--pai-tone-color:#9a6700}
      .pai-row.pai-tone-upcoming.pai-actionable{--pai-tone-color:#8a5d00}
      .pai-row.pai-tone-upcoming:hover{background:rgba(154,103,0,.08)}
      .pai-row.pai-completed{--pai-tone-color:#7a828e;color:#7a828e;cursor:default}
      .pai-row.pai-completed:hover{background:rgba(107,114,128,.07)}
      .pai-row.pai-completed .pai-text{text-decoration:line-through;text-decoration-thickness:1px;text-decoration-color:rgba(107,114,128,.7)}
      .pai-row.pai-completing{max-height:0;opacity:0;transform:translateY(-6px);padding-top:0;padding-bottom:0;margin-top:-6px;border-width:0}
      .pai-row.pai-row-enter{animation:paiRowEnter .22s ease both}
      @keyframes paiRowEnter{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
      .pai-check-zone{align-self:center;min-height:34px;height:34px;border:0;background:transparent;border-radius:6px;display:grid;place-items:center;cursor:pointer;transition:background .14s ease;padding:0}
      .pai-row:not(.pai-completed) .pai-check-zone:hover{background:color-mix(in srgb, var(--pai-tone-color) 11%, transparent)}
      .pai-check{width:34px;height:34px;border:0;background:transparent;border-radius:6px;padding:0;display:grid;place-items:center;cursor:pointer;color:var(--pai-tone-color)}
      .pai-check svg{width:22px;height:22px;display:block}
      .pai-check .pai-circle{fill:#fff;stroke:currentColor;stroke-width:2}
      .pai-check .pai-tick{fill:none;stroke:currentColor;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:16;stroke-dashoffset:16;transition:stroke-dashoffset .18s ease}
      .pai-check-zone:hover .pai-circle,.pai-check:hover .pai-circle{fill:color-mix(in srgb, var(--pai-tone-color) 8%, #fff)}
      .pai-check.is-done .pai-circle{fill:var(--pai-tone-color);stroke:var(--pai-tone-color)}
      .pai-check.is-done .pai-tick{stroke:#fff;stroke-dashoffset:0}
      .pai-text{min-width:0;line-height:1.18}
      .pai-title,.pai-stub{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pai-title{font-size:11px;font-weight:950;color:var(--pai-tone-color)}
      .pai-stub{margin-top:2px;font-size:11px;font-weight:800;color:#53606e}
      .pai-completed .pai-title,.pai-completed .pai-stub{color:#7a828e}
      .pai-meta{font-size:10px;font-weight:950;color:var(--pai-tone-color);white-space:nowrap;align-self:center}
      .pai-snooze{width:24px;height:24px;min-width:24px;min-height:24px;aspect-ratio:1;border:1px solid currentColor;border-radius:50%;background:transparent;color:var(--pai-tone-color);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease;padding:0;line-height:1}
      .pai-snooze:hover{background:currentColor;box-shadow:0 4px 10px rgba(15,23,42,.12)}
      .pai-snooze:hover i{color:#fff}
      .pai-snooze i{font-size:11px;line-height:1;display:block;width:1em;text-align:center}
      .pai-completed-toggle{margin-top:6px;width:100%;border:0;background:transparent;color:#6b7280;font-size:11px;font-weight:950;display:flex;align-items:center;justify-content:space-between;padding:6px 2px;cursor:pointer}
      .pai-completed-toggle i{font-size:10px;transition:transform .16s ease}
      .pai-completed-toggle[aria-expanded="true"] i{transform:rotate(90deg)}
      .pai-completed-panel{display:flex;flex-direction:column;gap:6px}
      .pai-completed-panel[hidden]{display:none}
      .fm-tooltip .pai-tip-row{grid-template-columns:72px minmax(0,1fr)}
      .fm-tooltip .pai-tip-value{white-space:normal;overflow-wrap:anywhere;text-align:left;line-height:1.35}
    `;
    document.head.appendChild(style);
  }

  function renderRow(item, options = {}){
    const completed = isCompleted(item);
    const meta = dueMeta(item, options.now);
    const text = displayText(item);
    const row = document.createElement('div');
    row.setAttribute('role', completed ? 'presentation' : 'button');
    if (!completed) row.tabIndex = 0;
    row.className = `pai-row pai-tone-${meta.tone || 'current'}${completed ? ' pai-completed' : ''}${!completed && itemIsActionable(item) ? ' pai-actionable' : ''}`;
    row.dataset.actionItemId = itemId(item);
    row.setAttribute('data-fm-tooltip-html', tooltipHtml(item, text));
    row.innerHTML = `
      <button type="button" class="pai-check-zone pai-check" aria-label="Mark complete">
        <svg viewBox="0 0 20 20" focusable="false">
          <circle class="pai-circle" cx="10" cy="10" r="8"></circle>
          <path class="pai-tick" d="M6 10.4l2.5 2.5L14.5 7"></path>
        </svg>
      </button>
      <span class="pai-text">
        <span class="pai-title">${escapeHtml(text.title)}</span>
        <span class="pai-stub">${escapeHtml(text.stub)}</span>
      </span>
      <span class="pai-meta">${escapeHtml(meta.text)}</span>
      ${completed ? '<span></span>' : '<button type="button" class="pai-snooze" aria-label="Snooze until tomorrow" title="Snooze until tomorrow"><i class="fas fa-clock"></i></button>'}
    `;
    return row;
  }

  function createTodayListController(container, options = {}){
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    const orgId = cleanText(options.orgId || options.org_id);
    const branchId = cleanText(options.branchId || options.branch_id);
    let destroyed = false;
    let completedOpen = options.completedOpen !== false;
    let lastItems = [];
    let loading = false;

    function queryOptions(){
      const result = todayListOptions({ ...(options.query || {}) });
      if (branchId) result.branchId = branchId;
      if (options.projectId || options.project_id) result.projectId = options.projectId || options.project_id;
      if (options.contact) result.contact = options.contact;
      return result;
    }

    function renderState(message){
      if (!el) return;
      injectListStyles();
      const shell = document.createElement('div');
      shell.className = 'pai-today-list';
      appendComposer(shell);
      const stateEl = document.createElement('div');
      stateEl.className = 'pai-state';
      stateEl.textContent = message;
      shell.appendChild(stateEl);
      el.replaceChildren(shell);
    }

    function appendComposer(shell){
      if (options.allowManualCreate === false || !shell) return null;
      const form = document.createElement('form');
      form.className = 'pai-composer';
      form.innerHTML = `
        <span class="pai-composer-icon"><i class="fas fa-plus"></i></span>
        <input type="text" autocomplete="off" placeholder="Add to-do..." aria-label="Add manual to-do">
        <button type="button" class="pai-schedule-toggle" aria-label="Schedule to-do" title="Schedule to-do"><i class="fas fa-calendar-days"></i></button>
        <button type="submit" class="pai-add" aria-label="Add to-do" title="Add to-do"><i class="fas fa-arrow-up"></i></button>
        <div class="pai-schedule-panel" hidden>
          <input type="datetime-local" aria-label="Due date and time">
          <button type="button" class="pai-schedule-clear">Clear</button>
        </div>
      `;
      const scheduleToggle = form.querySelector('.pai-schedule-toggle');
      const schedulePanel = form.querySelector('.pai-schedule-panel');
      const dueInput = schedulePanel?.querySelector('input');
      scheduleToggle?.addEventListener('click', () => {
        const nextHidden = !schedulePanel?.hidden ? true : false;
        if (schedulePanel) schedulePanel.hidden = nextHidden;
        if (!nextHidden) dueInput?.focus();
      });
      dueInput?.addEventListener('input', () => {
        scheduleToggle?.classList.toggle('active', !!cleanText(dueInput.value));
      });
      form.querySelector('.pai-schedule-clear')?.addEventListener('click', () => {
        if (dueInput) dueInput.value = '';
        scheduleToggle?.classList.remove('active');
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = form.querySelector('input');
        const text = cleanText(input?.value);
        if (!text || form.classList.contains('is-saving')) return;
        form.classList.add('is-saving');
        try {
          await createManual(orgId, text, {
            ...queryOptions(),
            userId: options.userId || options.user_id,
            due_at: datetimeLocalToIso(dueInput?.value),
            source: 'today_list',
            reload: false
          });
          if (input) input.value = '';
          if (dueInput) dueInput.value = '';
          scheduleToggle?.classList.remove('active');
          if (schedulePanel) schedulePanel.hidden = true;
          await controller.load({ quiet: true });
        } catch (error) {
          form.classList.remove('is-saving');
          if (input) input.focus();
          return null;
        }
      });
      shell.appendChild(form);
      return form;
    }

    function appendRows(section, items, toneOptions = {}){
      items.forEach((item) => {
        const row = renderRow(item, { ...toneOptions, now: new Date() });
        row.addEventListener('click', async () => {
          if (isCompleted(item)) return;
          await open(item, { orgId, source: 'today_list', controller });
        });
        row.addEventListener('keydown', async (event) => {
          if (isCompleted(item) || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          await open(item, { orgId, source: 'today_list', controller });
        });
        const checkZone = row.querySelector('.pai-check-zone');
        if (checkZone) {
          checkZone.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isCompleted(item)) return;
            await completeWithAnimation(row, item);
          });
        }
        const snoozeButton = row.querySelector('.pai-snooze');
        if (snoozeButton) {
          snoozeButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await snoozeWithAnimation(row, item);
          });
        }
        section.appendChild(row);
      });
    }

    function renderItems(items){
      if (!el || destroyed) return;
      injectListStyles();
      lastItems = Array.isArray(items) ? items : [];
      const prepared = prepareTodayList(lastItems, { now: new Date() });
      const shell = document.createElement('div');
      shell.className = 'pai-today-list';
      appendComposer(shell);

      appendRows(shell, prepared.past_due);
      appendRows(shell, prepared.current);

      const upcomingSection = document.createElement('div');
      upcomingSection.className = 'pai-section pai-upcoming';
      appendRows(upcomingSection, prepared.upcoming);
      if (prepared.upcoming.length) shell.appendChild(upcomingSection);

      if (!prepared.visible_count && !prepared.completed_count) {
        const stateEl = document.createElement('div');
        stateEl.className = 'pai-state';
        stateEl.textContent = 'Hooray, you are all caught up.';
        shell.appendChild(stateEl);
      }

      if (prepared.completed_count) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pai-completed-toggle';
        toggle.setAttribute('aria-expanded', completedOpen ? 'true' : 'false');
        toggle.innerHTML = `<span>Completed (${prepared.completed_count})</span><i class="fas fa-chevron-right"></i>`;
        const panel = document.createElement('div');
        panel.className = 'pai-completed-panel';
        panel.hidden = !completedOpen;
        appendRows(panel, prepared.completed);
        toggle.addEventListener('click', () => {
          completedOpen = !completedOpen;
          toggle.setAttribute('aria-expanded', completedOpen ? 'true' : 'false');
          panel.hidden = !completedOpen;
        });
        shell.appendChild(toggle);
        shell.appendChild(panel);
      }

      el.replaceChildren(shell);
      shell.querySelectorAll('.pai-row').forEach((row) => row.classList.add('pai-row-enter'));
    }

    async function completeWithAnimation(row, item){
      const id = itemId(item);
      if (!id || row.classList.contains('pai-completing')) return;
      row.querySelector('.pai-check')?.classList.add('is-done');
      row.classList.add('pai-completing');
      await new Promise((resolve) => setTimeout(resolve, 190));
      await complete(orgId, id, { reason: 'manual' }, { reload: false }).catch((error) => {
        row.classList.remove('pai-completing');
        row.querySelector('.pai-check')?.classList.remove('is-done');
        throw error;
      });
      await controller.load({ quiet: true });
    }

    async function snoozeWithAnimation(row, item){
      const id = itemId(item);
      if (!id || row.classList.contains('pai-completing')) return;
      row.classList.add('pai-completing');
      await new Promise((resolve) => setTimeout(resolve, 140));
      await snoozeToTomorrow(orgId, item, { ...queryOptions(), reload: false }).catch((error) => {
        row.classList.remove('pai-completing');
        throw error;
      });
      await controller.load({ quiet: true });
    }

    const controller = {
      async load(loadOptions = {}){
        if (!el || destroyed || loading) return { items: lastItems };
        if (!orgId || !PlatformAPI?.actionItems) {
          renderState('To-dos are not available.');
          return { items: [] };
        }
        loading = true;
        if (!loadOptions.quiet) renderState('Loading...');
        try {
          const result = await loadToday(orgId, queryOptions());
          renderItems(result.items || result.action_items || []);
          return result;
        } catch (error) {
          renderState('To-dos are taking a minute to load.');
          if (options.throwOnError === true || loadOptions.throwOnError === true) throw error;
          return { ok: false, items: [], action_items: [], error };
        } finally {
          loading = false;
        }
      },
      render(items = lastItems){ renderItems(items); },
      destroy(){
        destroyed = true;
        if (el) el.innerHTML = '';
      }
    };

    if (options.autoLoad !== false) controller.load().catch(() => null);
    return controller;
  }

  registerKind('open_project_scheduling', {
    label: 'Schedule project',
    open(item){
      const action = item?.frontend_action || {};
      return openProjectAction(item, action, 'scheduling');
    }
  });

  registerKind('open_project', {
    label: 'Open project',
    open(item){
      return openProjectAction(item, item?.frontend_action || {}, 'map');
    }
  });

  registerKind('send_project_proposal', {
    label: 'Send proposal',
    orderKey: '10_proposal',
    open(item){
      return openProjectAction(item, item?.frontend_action || {}, 'proposal');
    }
  });

  registerKind('manual', {
    label: 'Manual to-do',
    orderKey: '00_manual',
    open(item){
      if (!projectIdForAction(item)) return null;
      return openProjectAction(item, { ...(item?.frontend_action || {}), kind: 'open_project', tab: 'map' }, 'map');
    }
  });

  root.PlatformActionItems = {
    subscribe,
    getState,
    load,
    loadToday,
    todayListOptions,
    prepareTodayList,
    renderTodayList: createTodayListController,
    registerKind,
    kindDefinition,
    renderLabel,
    displayText,
    dueMeta,
    open,
    claim,
    complete,
    cancel,
    patch,
    createManual,
    snoozeToTomorrow,
    create(orgId, item){ return PlatformAPI.actionItems.create(orgId, item); },
    markSeen(orgId, actionItemId, options = {}){ return setState(orgId, actionItemId, { seen: true }, options); },
    hide(orgId, actionItemId, options = {}){ return setState(orgId, actionItemId, { hidden: true }, options); },
    dismiss(orgId, actionItemId, options = {}){ return setState(orgId, actionItemId, { dismissed: true }, options); },
    pin(orgId, actionItemId, pinned = true, options = {}){ return setState(orgId, actionItemId, { pinned }, options); },
    snooze(orgId, actionItemId, snoozedUntil, options = {}){ return setState(orgId, actionItemId, { snoozed_until: snoozedUntil || '' }, options); },
  };
})();
