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

  function datetimeLocalValue(value){
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
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

  function isFollowUpItem(item){
    const tags = Array.isArray(item?.type_tags) ? item.type_tags : (Array.isArray(item?.metadata?.type_tags) ? item.metadata.type_tags : []);
    return cleanText(item?.kind) === 'follow_up' || tags.map(cleanText).includes('follow_up');
  }

  function automatedCompletionTrigger(item){
    const triggers = Array.isArray(item?.external_triggers) ? item.external_triggers : [];
    return triggers.find((trigger) => {
      const transition = cleanText(trigger?.transition || 'completed').toLowerCase();
      return transition === 'completed';
    }) || null;
  }

  function manualCompletionAllowed(item){
    if (typeof item?.manual_completion === 'boolean') return item.manual_completion;
    if (typeof item?.metadata?.manual_completion === 'boolean') return item.metadata.manual_completion;
    return !automatedCompletionTrigger(item);
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

  function itemWorkflowStatus(item){
    return cleanText(item?.workflow_status || item?.work_status || item?.node_status || item?.status).toLowerCase();
  }

  function itemIsFuture(item){
    return item?.is_future === true || itemWorkflowStatus(item) === 'blocked';
  }

  function displayText(item, options = {}){
    const project = projectLabel(item);
    const title = itemTitle(item);
    const stub = itemStub(item);
    const description = stub && stub !== title && stub !== renderLabel(item) ? stub : '';
    const showProjectContext = options.showProjectContext !== false;
    return {
      title,
      stub: showProjectContext && project && project !== title ? project : description
    };
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

  function prioritySortValue(item){
    return Number(item?.priority) || 0;
  }

  function sortItems(items, mode = 'due'){
    return [...items].sort((a, b) => {
      // Priority items always float to the top of their bucket.
      const priority = prioritySortValue(b) - prioritySortValue(a);
      if (priority) return priority;
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
    const future = [];

    (Array.isArray(items) ? items : []).forEach((item) => {
      const due = parseDue(item?.due_at);
      if (isCompleted(item)) {
        if (completedBelongsToToday(item, now)) completed.push(item);
        return;
      }
      const key = due.date ? localDateKey(due.date) : '';
      const dateIsFuture = !!key && key > bounds.key;
      if (itemIsFuture(item) || dateIsFuture) {
        future.push(item);
        return;
      }
      if (!due.date) {
        unassigned.push(item);
        return;
      }
      if (key < bounds.key) pastDue.push(item);
      else if (key === bounds.key && due.hasTime && due.date > now) upcoming.push(item);
      else if (key === bounds.key) current.push(item);
    });

    return {
      past_due: sortItems(pastDue, 'due'),
      current: sortItems([...current, ...unassigned], 'kind'),
      upcoming: sortItems(upcoming, 'due'),
      future: sortItems(future, 'due'),
      completed: sortItems(completed, 'due'),
      visible_count: pastDue.length + current.length + upcoming.length + unassigned.length + future.length,
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
    root.dispatchEvent(new CustomEvent('fm:work:updated', { detail:{ nodeId:actionItemId, action:'patch' } }));
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result?.document || result;
  }

  async function complete(orgId, actionItemId, payload = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.complete(orgId, actionItemId, payload);
    root.dispatchEvent(new CustomEvent('fm:work:updated', { detail:{ nodeId:actionItemId, action:'complete' } }));
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result;
  }

  async function reopen(orgId, actionItemId, status = 'ready', payload = {}, options = {}){
    if (!PlatformAPI?.actionItems?.reopen || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.reopen(orgId, actionItemId, status || 'ready', payload);
    root.dispatchEvent(new CustomEvent('fm:work:updated', { detail:{ nodeId:actionItemId, action:'reopen' } }));
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result;
  }

  async function claim(orgId, actionItemId, payload = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.claim(orgId, actionItemId, payload);
    root.dispatchEvent(new CustomEvent('fm:work:updated', { detail:{ nodeId:actionItemId, action:'claim' } }));
    if (options.reload !== false) await load(orgId, options);
    return result?.action_item || result;
  }

  async function cancel(orgId, actionItemId, payload = {}, options = {}){
    if (!PlatformAPI?.actionItems || !orgId || !actionItemId) return null;
    const result = await PlatformAPI.actionItems.cancel(orgId, actionItemId, payload);
    root.dispatchEvent(new CustomEvent('fm:work:updated', { detail:{ nodeId:actionItemId, action:'cancel' } }));
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
    const contactId = firstText(options.contactId, options.contact_id);
    const contactName = firstText(options.contactName, options.contact_name);
    const contactEmail = firstText(options.contactEmail, options.contact_email);
    const contactPhone = firstText(options.contactPhone, options.contact_phone);
    if (contactId || contactName || contactEmail || contactPhone) {
      item.contact_id = contactId;
      item.contact_name = contactName;
      item.contact_email = contactEmail;
      item.contact_phone = contactPhone;
      if (!projectId && contactName) item.context_title = contactName;
    }
    if (Number(options.priority) > 0) item.priority = Math.max(0, Math.round(Number(options.priority)));
    if (Array.isArray(options.assigned_role_ids) && options.assigned_role_ids.length) {
      item.assigned_role_ids = options.assigned_role_ids.map(cleanText).filter(Boolean);
    }
    if (Array.isArray(options.assigned_user_ids) && options.assigned_user_ids.length) {
      item.assigned_user_ids = options.assigned_user_ids.map(cleanText).filter(Boolean);
    }
    if (Array.isArray(options.assigned_resource_group_ids) && options.assigned_resource_group_ids.length) {
      item.assigned_resource_group_ids = options.assigned_resource_group_ids.map(cleanText).filter(Boolean);
    }
    // Project to-dos default to unassigned (they show for the whole office on
    // desktop); personal-list to-dos with no project stay assigned to self so
    // they keep appearing in the creator's own Today list.
    if (!item.assigned_role_ids && !item.assigned_user_ids && !item.assigned_resource_group_ids && !projectId && userId) {
      item.assigned_user_ids = [userId];
    }
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
    return firstText(
      action.project_id,
      action.projectId,
      item?.project_id,
      item?.projectId,
      Array.isArray(item?.project_ids) ? item.project_ids[0] : ''
    );
  }

  const projectTabAliases = new Map([
    ['scheduling', 'schedule'],
    ['scope', 'materials'],
    ['material', 'materials'],
    ['material_list', 'materials'],
    ['material_lists', 'materials'],
    ['overview', 'map']
  ]);

  const workflowProjectTabs = new Map([
    ['finalize_material_lists', 'materials'],
    ['order_materials', 'materials'],
    ['schedule_with_customer', 'schedule'],
    ['schedule_material_deliveries', 'schedule'],
    ['schedule_dry_in_delivery', 'schedule'],
    ['schedule_shingle_delivery', 'schedule'],
    ['schedule_crew_arrival', 'schedule'],
    ['schedule_disposal_equipment', 'schedule'],
    ['schedule_service', 'schedule'],
    ['schedule_sold_project', 'schedule'],
    ['complete_sales_appointment', 'schedule'],
    ['start_project', 'schedule'],
    ['finish_project', 'schedule'],
    ['service_arrival', 'schedule'],
    ['sign_proposal', 'proposal'],
    ['send_proposal', 'proposal'],
    ['sign_sales_proposal', 'proposal'],
    ['collect_sales_deposit', 'money'],
    ['deposit_paid', 'money'],
    ['progress_payment', 'money'],
    ['final_payment', 'money'],
    ['service_paid', 'money']
  ]);

  function normalizeProjectTab(value){
    const tab = cleanText(value).toLowerCase().replace(/[\s-]+/g, '_');
    return projectTabAliases.get(tab) || tab;
  }

  function projectTabForItem(item, action = {}, fallbackTab = 'map'){
    const explicit = normalizeProjectTab(firstText(action.tab, action.project_tab, action.projectTab));
    if (explicit) return explicit;
    const workflowTab = [
      item?.template_node_id,
      item?.templateNodeId,
      item?.metadata?.template_node_id,
      item?.metadata?.kind,
      item?.kind
    ].map((value) => workflowProjectTabs.get(cleanText(value).toLowerCase())).find(Boolean);
    return workflowTab || normalizeProjectTab(fallbackTab) || 'map';
  }

  async function openProjectAction(item, action = {}, fallbackTab = 'map'){
    const projectId = projectIdForAction(item, action);
    if (!projectId) return null;
    const tab = projectTabForItem(item, action, fallbackTab);
    const proposalId = firstText(action.proposal_id, action.proposalId, item?.proposal_id, item?.proposalId);
    const openOptions = {
      tab,
      history: 'push',
      source: 'project-todo',
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
      .pai-today-list.pai-items-scroll{height:100%;flex:1 1 auto;overflow:hidden}
      .pai-items{display:contents}
      .pai-today-list.pai-items-scroll .pai-items{display:flex;flex:1 1 auto;flex-direction:column;gap:3px;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:4px}
      .pai-today-list.pai-docked-deferred{height:100%;flex:1 1 auto;overflow:hidden}
      .pai-today-list.pai-docked-deferred .pai-items{display:flex;flex:1 1 auto;flex-direction:column;gap:3px;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding-right:4px}
      .pai-active-items{display:flex;flex:0 0 auto;flex-direction:column;gap:3px;min-height:0;overflow:visible}
      .pai-active-items.is-empty{min-height:88px}
      .pai-deferred-spacer{flex:1 1 auto;min-height:18px;transition:flex-grow .24s cubic-bezier(.22,1,.36,1),flex-basis .24s cubic-bezier(.22,1,.36,1),min-height .24s cubic-bezier(.22,1,.36,1)}
      .pai-deferred-sections{flex:0 0 auto;display:flex;flex-direction:column;border-top:1px solid rgba(15,23,42,.08)}
      .pai-deferred-group + .pai-deferred-group{border-top:1px solid rgba(15,23,42,.06)}
      .pai-deferred-toggle{width:100%;min-height:30px;border:0;background:transparent;color:#667085;padding:6px 2px;display:flex;align-items:center;justify-content:space-between;font-size:10.5px;font-weight:1000;text-align:left;cursor:pointer}
      .pai-deferred-toggle:hover{color:#344054;background:rgba(15,23,42,.025)}
      .pai-deferred-toggle i{font-size:9px;transition:transform .2s ease}
      .pai-deferred-toggle[aria-expanded="true"] i{transform:rotate(90deg)}
      .pai-deferred-panel{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .24s cubic-bezier(.22,1,.36,1),opacity .16s ease}
      .pai-deferred-panel.is-open{grid-template-rows:1fr;opacity:1}
      .pai-deferred-panel-inner{min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:3px}
      .pai-deferred-panel.is-open .pai-deferred-panel-inner{padding-bottom:4px}
      .pai-today-list.pai-docked-deferred.has-open-deferred .pai-deferred-spacer{flex-grow:0;flex-basis:0;min-height:0}
      .pai-composer{display:grid;grid-template-columns:20px minmax(0,1fr) 26px 26px 26px;align-items:center;gap:7px;border:1px solid rgba(15,23,42,.10);border-left:3px solid var(--primary-readable, var(--primary, #d93025));border-radius:8px;background:#fff;padding:7px;margin-bottom:7px}
      .pai-composer-icon{width:18px;height:18px;border-radius:999px;border:1.5px solid rgba(15,23,42,.22);display:grid;place-items:center;color:#6b7280;font-size:10px}
      .pai-composer input{width:100%;border:0;outline:none;background:transparent;color:#202124;font-size:11px;font-weight:850;line-height:1.2;min-width:0}
      .pai-composer input::placeholder{color:#8b95a1}
      .pai-add,.pai-schedule-toggle,.pai-assign-toggle{width:26px;height:26px;min-width:26px;min-height:26px;aspect-ratio:1;border:1px solid currentColor;border-radius:50%;background:color-mix(in srgb, var(--primary-readable, var(--primary, #d93025)) 8%, #fff);color:var(--primary-readable, var(--primary, #d93025));display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease;padding:0;line-height:1}
      .pai-schedule-toggle,.pai-assign-toggle{background:#fff;color:#64748b}
      .pai-add:hover,.pai-schedule-toggle:hover,.pai-schedule-toggle.active,.pai-assign-toggle:hover,.pai-assign-toggle.active{background:var(--primary-readable, var(--primary, #d93025));border-color:var(--primary-readable, var(--primary, #d93025));color:#fff}
      .pai-add i,.pai-schedule-toggle i,.pai-assign-toggle i{font-size:11px;line-height:1;display:block;width:1em;text-align:center}
      .pai-schedule-panel{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center;padding-top:2px}
      .pai-schedule-panel[hidden]{display:none}
      .pai-assign-panel{grid-column:1/-1;display:grid;gap:8px;padding:8px 2px 2px}
      .pai-assign-panel[hidden]{display:none}
      .pai-assign-label{font-size:9px;font-weight:1000;letter-spacing:.07em;text-transform:uppercase;color:#667085}
      .pai-assign-row{display:flex;flex-wrap:wrap;gap:5px}
      .pai-assign-chip{border:1px solid #d0d5dd;border-radius:999px;background:#fff;color:#475467;padding:5px 10px;font:inherit;font-size:10px;font-weight:950;cursor:pointer;transition:.14s ease}
      .pai-assign-chip.on{border-color:var(--primary-readable, var(--primary, #d93025));background:color-mix(in srgb, var(--primary-readable, var(--primary, #d93025)) 9%, #fff);color:var(--primary-readable, var(--primary, #d93025))}
      .pai-assign-chip:disabled{opacity:.42;cursor:not-allowed;text-decoration:line-through}
      .pai-assign-chip.pai-chip-priority.on{border-color:#d92d20;background:#fef3f2;color:#b42318}
      .pai-assignee-search{border:1px solid #d0d5dd!important;border-radius:7px!important;background:#fff!important;padding:6px 8px!important;font-size:10px!important;font-weight:800!important;margin:2px 0}
      .pai-assign-subgroup{display:grid;gap:4px}
      .pai-assign-subgroup + .pai-assign-subgroup{margin-top:7px}
      .pai-assign-sublabel{font-size:9px;font-weight:950;color:#667085}
      .pai-assign-note{font-size:9px;line-height:1.35;color:#667085;background:#f8fafc;border-radius:6px;padding:6px 7px}
      .pai-row.pai-priority{border-left:3px solid #d92d20;background:linear-gradient(90deg,#fff7f6,#fff 42%)}
      .pai-follow-up-icon{display:inline-block;margin-right:5px;color:inherit;font-size:9px;vertical-align:1px}
      .pai-flag{color:#d92d20;font-size:9px;margin-right:4px;vertical-align:1px}
      .pai-schedule-panel input{border:1px solid rgba(15,23,42,.12);border-radius:7px;padding:6px 8px;font-size:11px;font-weight:850;color:#202124;background:#fff;min-height:30px}
      .pai-schedule-clear{border:1px solid rgba(15,23,42,.12);border-radius:7px;background:#fff;color:#64748b;min-height:30px;padding:0 8px;font-size:10px;font-weight:950;cursor:pointer}
      .pai-schedule-clear:hover{color:var(--primary-readable, var(--primary, #d93025));border-color:rgba(var(--primary-rgb,217,48,37),.24)}
      .pai-composer.is-saving{opacity:.65;pointer-events:none}
      .pai-state{padding:14px 10px;border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#f8fafc;color:#64748b;font-size:11px;font-weight:850;line-height:1.35;text-align:center}
      .pai-section{display:flex;flex-direction:column;gap:3px}
      .pai-section.pai-upcoming{margin-top:1px}
      .pai-row{--pai-tone-color:#5a9f6c;width:100%;box-sizing:border-box;border:0;background:transparent;border-radius:6px;padding:2px 1px;display:grid;grid-template-columns:34px minmax(0,1fr) auto 24px;align-items:center;gap:6px;text-align:left;cursor:pointer;min-height:38px;max-height:52px;opacity:1;transform:translateY(0);overflow:hidden;transition:max-height .2s ease, opacity .16s ease, transform .16s ease, padding .18s ease, margin .18s ease, background .14s ease}
      .pai-row:focus{outline:none}.pai-row:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--pai-tone-color) 42%,transparent)}
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
      .pai-status-zone,.pai-leading-action{align-self:center;width:34px;height:34px;border:0;border-radius:6px;display:grid;place-items:center;color:var(--pai-tone-color);padding:0}
      .pai-status-zone{background:transparent;cursor:default}
      .pai-status-zone i{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--pai-tone-color) 9%,#fff);font-size:10px}
      .pai-leading-action{background:transparent;cursor:pointer;transition:background .14s ease}
      .pai-leading-action:hover{background:color-mix(in srgb,var(--pai-tone-color) 11%,transparent)}
      .pai-leading-action i{font-size:13px}
      .pai-text{min-width:0;line-height:1.18}
      .pai-title,.pai-stub{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .pai-title{font-size:11px;font-weight:950;color:var(--pai-tone-color)}
      .pai-stub{margin-top:2px;font-size:11px;font-weight:800;color:#53606e}
      .pai-completed .pai-title,.pai-completed .pai-stub{color:#7a828e}
      .pai-future-label{margin:8px 2px 2px;font-size:9px;font-weight:1000;letter-spacing:.08em;text-transform:uppercase;color:#98a2b3}
      .pai-row.pai-future{opacity:.58;background:#f8fafc;cursor:default}
      .pai-row.pai-future .pai-title,.pai-row.pai-future .pai-stub,.pai-row.pai-future .pai-meta{color:#7a828e}
      .pai-row.pai-future .pai-check-zone{pointer-events:none}.pai-row.pai-future .pai-circle{stroke-dasharray:3 3;fill:#f8fafc}
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
      .pai-item-stack{width:100%;min-width:0;border:1px solid transparent;border-radius:10px;transition:border-color .2s ease,background .2s ease,box-shadow .2s ease,margin .2s ease}
      .pai-item-stack.is-outcome-open{margin:3px 0 7px;border-color:rgba(15,23,42,.10);background:#fff;box-shadow:0 8px 22px rgba(15,23,42,.055)}
      .pai-item-stack.is-outcome-open>.pai-row{border-radius:9px 9px 0 0;background:#f8fafc;padding-left:7px;padding-right:7px;border-bottom:1px solid rgba(15,23,42,.07)}
      .pai-dispo{width:100%;box-sizing:border-box;max-height:0;margin:0;padding:0 12px;overflow:hidden;opacity:0;transform:translateY(-8px);pointer-events:none;background:#fff;border-radius:0 0 9px 9px;display:grid;gap:7px;transition:max-height .3s cubic-bezier(.22,1,.36,1),padding .3s cubic-bezier(.22,1,.36,1),opacity .18s ease,transform .3s cubic-bezier(.22,1,.36,1)}
      .pai-dispo[hidden]{display:none}.pai-dispo.is-open{max-height:360px;padding:9px 12px 10px;opacity:1;transform:translateY(0);pointer-events:auto}
      .pai-dispo-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.pai-dispo-row.pai-dispo-quick{grid-template-columns:repeat(4,minmax(0,1fr))}
      .pai-dispo button{min-width:0;min-height:29px;border:1px solid color-mix(in srgb,var(--choice,#64748b) 34%,#d0d5dd);background:color-mix(in srgb,var(--choice,#64748b) 6%,#fff);color:color-mix(in srgb,var(--choice,#64748b) 80%,#111827);border-radius:7px;padding:4px 6px;font:inherit;font-size:9.5px;line-height:1.1;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;outline:none;transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,transform .15s ease}
      .pai-dispo button:hover{background:color-mix(in srgb,var(--choice,#64748b) 11%,#fff);border-color:color-mix(in srgb,var(--choice,#64748b) 58%,#d0d5dd);transform:translateY(-1px)}
      .pai-dispo button:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--choice,#64748b) 16%,transparent)}
      .pai-dispo button.is-selected{background:color-mix(in srgb,var(--choice,#64748b) 14%,#fff);border-color:color-mix(in srgb,var(--choice,#64748b) 70%,#d0d5dd);box-shadow:0 0 0 2px color-mix(in srgb,var(--choice,#64748b) 12%,transparent)}
      .pai-dispo-next{max-height:0;margin-top:-3px;padding-top:0;border-top:1px solid transparent;overflow:hidden;opacity:0;transform:translateY(-6px);display:grid;gap:6px;transition:max-height .28s cubic-bezier(.22,1,.36,1),margin .28s ease,padding .28s ease,border-color .2s ease,opacity .18s ease,transform .28s cubic-bezier(.22,1,.36,1)}
      .pai-dispo-next[hidden]{display:none}.pai-dispo-next.is-open{max-height:190px;margin-top:1px;padding-top:8px;border-top-color:rgba(15,23,42,.08);opacity:1;transform:translateY(0)}
      .pai-dispo-custom{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px}.pai-dispo-date-control{display:grid;grid-template-columns:minmax(0,1fr) 30px;gap:5px}.pai-dispo-custom input{width:100%;box-sizing:border-box;min-width:0;min-height:30px;border:1px solid #d0d5dd;border-radius:7px;padding:4px 8px;font:inherit;font-size:9.5px;font-weight:800;color:#344054;background:#fff;outline:none}.pai-dispo-custom input:focus{border-color:var(--primary-readable,var(--primary,#64748b));box-shadow:0 0 0 2px color-mix(in srgb,var(--primary-readable,var(--primary,#64748b)) 12%,transparent)}.pai-dispo-custom button{min-width:82px}.pai-dispo-custom .pai-add-time{min-width:30px;width:30px;padding:0}.pai-add-time[hidden]{display:none}
      .pai-dispo-label{font-size:9px;font-weight:1000;letter-spacing:.07em;text-transform:uppercase;color:#667085}
      @media (prefers-reduced-motion:reduce){.pai-item-stack,.pai-dispo,.pai-dispo-next,.pai-dispo button{transition:none!important}}
      .fm-tooltip .pai-tip-row{grid-template-columns:72px minmax(0,1fr)}
      .fm-tooltip .pai-tip-value{white-space:normal;overflow-wrap:anywhere;text-align:left;line-height:1.35}
    `;
    document.head.appendChild(style);
  }

  function renderRow(item, options = {}){
    const completed = isCompleted(item);
    const future = !completed && itemIsFuture(item);
    const meta = dueMeta(item, options.now);
    const text = displayText(item, options);
    const row = document.createElement('div');
    row.setAttribute('role', completed || future ? 'presentation' : 'button');
    if (!completed && !future) row.tabIndex = 0;
    const followUp = isFollowUpItem(item);
    const outcomeAction = followUp || cleanText(item?.kind) === 'sales_contact';
    const completionTrigger = automatedCompletionTrigger(item);
    const canCompleteManually = manualCompletionAllowed(item);
    const completionExplainer = cleanText(completionTrigger?.explainer) || 'This item checks itself off when the linked work is completed.';
    const leadingControl = completed ? `
      <span class="pai-status-zone pai-check is-done" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_3c4d2141b2fa1c","Completed") ?? "Completed")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_3c4d2141b2fa1c","Completed") ?? "Completed")}">
        <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
          <circle class="pai-circle" cx="10" cy="10" r="8"></circle>
          <path class="pai-tick" d="M6 10.4l2.5 2.5L14.5 7"></path>
        </svg>
      </span>` : future ? `
      <span class="pai-status-zone" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_46b1b5fde99446","Not due yet") ?? "Not due yet")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_46b1b5fde99446","Not due yet") ?? "Not due yet")}"><i class="fas fa-clock" aria-hidden="true"></i></span>` : outcomeAction ? `
      <button type="button" class="pai-leading-action" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_b6a83faf8a56e9","Choose an outcome") ?? "Choose an outcome")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_b6a83faf8a56e9","Choose an outcome") ?? "Choose an outcome")}"><i class="fas fa-ellipsis" aria-hidden="true"></i></button>` : canCompleteManually ? `
      <button type="button" class="pai-check-zone pai-check" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_a0f832de9e5de8","Mark complete") ?? "Mark complete")}">
        <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
          <circle class="pai-circle" cx="10" cy="10" r="8"></circle>
          <path class="pai-tick" d="M6 10.4l2.5 2.5L14.5 7"></path>
        </svg>
      </button>` : `
      <span class="pai-status-zone pai-automatic" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_97537c9c543ff9","Completes automatically") ?? "Completes automatically")}" title="${String(escapeHtml(completionExplainer))}"><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i></span>`;
    row.className = `pai-row pai-tone-${meta.tone || 'current'}${completed ? ' pai-completed' : ''}${future ? ' pai-future' : ''}${!completed && !future && itemIsActionable(item) ? ' pai-actionable' : ''}${!completed && prioritySortValue(item) > 0 ? ' pai-priority' : ''}${followUp ? ' pai-follow-up' : ''}`;
    row.dataset.actionItemId = itemId(item);
    row.setAttribute('data-fm-tooltip-html', tooltipHtml(item, text));
    row.innerHTML = `
      ${leadingControl}
      <span class="pai-text">
        <span class="pai-title">${followUp ? ("<i class=\"fas fa-phone pai-follow-up-icon\" title=\"" + (globalThis.PlatformLanguage?.text("platform-action-items","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up") + "\" aria-label=\"" + (globalThis.PlatformLanguage?.text("platform-action-items","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up") + "\"></i>") : ''}${!completed && prioritySortValue(item) > 0 ? ("<i class=\"fas fa-flag pai-flag\" title=\"" + (globalThis.PlatformLanguage?.text("platform-action-items","m_6484e03a4531ae","Priority") ?? "Priority") + "\"></i>") : ''}${escapeHtml(text.title)}</span>
        ${text.stub ? `<span class="pai-stub">${escapeHtml(text.stub)}</span>` : ''}
      </span>
      <span class="pai-meta">${escapeHtml(meta.text)}</span>
      ${completed || future ? '<span></span>' : `<button type="button" class="pai-snooze" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_00124fa0ee7fe9","Snooze until tomorrow") ?? "Snooze until tomorrow")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_00124fa0ee7fe9","Snooze until tomorrow") ?? "Snooze until tomorrow")}"><i class="fas fa-clock"></i></button>`}
    `;
    return row;
  }

  function createTodayListController(container, options = {}){
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    const orgId = cleanText(options.orgId || options.org_id);
    const branchId = cleanText(options.branchId || options.branch_id);
    let destroyed = false;
    let completedOpen = options.completedOpen !== false;
    let futureOpen = options.futureOpen === true;
    let lastItems = [];
    let loading = false;
    let followUpConfig = null;

    function queryOptions(){
      const result = todayListOptions({ ...(options.query || {}) });
      if (branchId) result.branchId = branchId;
      if (options.projectId || options.project_id) result.projectId = options.projectId || options.project_id;
      const projectIds = options.projectIds || options.project_ids;
      if (Array.isArray(projectIds) && projectIds.length) result.projectIds = projectIds;
      if (options.contactId || options.contact_id) result.contactId = options.contactId || options.contact_id;
      if (options.contactName || options.contact_name) result.contactName = options.contactName || options.contact_name;
      if (options.contactEmail || options.contact_email) result.contactEmail = options.contactEmail || options.contact_email;
      if (options.contactPhone || options.contact_phone) result.contactPhone = options.contactPhone || options.contact_phone;
      if (options.contact) result.contact = options.contact;
      return result;
    }

    function renderState(message){
      if (!el) return;
      injectListStyles();
      const shell = document.createElement('div');
      shell.className = `pai-today-list${options.scrollItemsOnly === true ? ' pai-items-scroll' : ''}`;
      appendComposer(shell);
      const items = document.createElement('div');
      items.className = 'pai-items';
      const stateEl = document.createElement('div');
      stateEl.className = 'pai-state';
      stateEl.textContent = message;
      items.appendChild(stateEl);
      shell.appendChild(items);
      el.replaceChildren(shell);
    }

    function appendComposer(shell){
      if (options.allowManualCreate === false || !shell) return null;
      const form = document.createElement('form');
      form.className = 'pai-composer';
      form.innerHTML = `
        <span class="pai-composer-icon"><i class="fas fa-plus"></i></span>
        <input type="text" autocomplete="off" placeholder="${(globalThis.PlatformLanguage?.text("platform-action-items","m_99aa399be5ef57","Add to-do...") ?? "Add to-do...")}" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_0fbb6615830f2d","Add manual to-do") ?? "Add manual to-do")}">
        <button type="button" class="pai-assign-toggle" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_becde4a265e4c2","Assignment and priority") ?? "Assignment and priority")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_becde4a265e4c2","Assignment and priority") ?? "Assignment and priority")}"><i class="fas fa-sliders"></i></button>
        <button type="button" class="pai-schedule-toggle" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_84435836397992","Schedule to-do") ?? "Schedule to-do")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_84435836397992","Schedule to-do") ?? "Schedule to-do")}"><i class="fas fa-calendar-days"></i></button>
        <button type="submit" class="pai-add" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_5736de5170b8a5","Add to-do") ?? "Add to-do")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_5736de5170b8a5","Add to-do") ?? "Add to-do")}"><i class="fas fa-arrow-up"></i></button>
        <div class="pai-assign-panel" hidden>
          <div>
            <div class="pai-assign-label">${(globalThis.PlatformLanguage?.text("platform-action-items","m_6484e03a4531ae","Priority") ?? "Priority")}</div>
            <div class="pai-assign-row" data-priority-row>
              <button type="button" class="pai-assign-chip on" data-priority="0">${(globalThis.PlatformLanguage?.text("platform-action-items","m_9a27adafe8f638","Normal") ?? "Normal")}</button>
              <button type="button" class="pai-assign-chip pai-chip-priority" data-priority="1"><i class="fas fa-flag"></i>${(globalThis.PlatformLanguage?.text("platform-action-items","m_2f5dce6dd5abb0"," High priority") ?? " High priority")}</button>
            </div>
          </div>
          <div>
            <div class="pai-assign-label">${(globalThis.PlatformLanguage?.text("platform-action-items","m_334a6fae05444b","Assigned to") ?? "Assigned to")}</div>
            <div class="pai-assign-row" data-role-row>
              <button type="button" class="pai-assign-chip on" data-role="">${(globalThis.PlatformLanguage?.text("platform-action-items","m_8a993ed9b573b4","Unassigned") ?? "Unassigned")}</button>
            </div>
            <input class="pai-assignee-search" data-assignee-search type="search" autocomplete="off" placeholder="${(globalThis.PlatformLanguage?.text("platform-action-items","m_93a044cd065fd4","Search people or crews...") ?? "Search people or crews...")}" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_0edeaf49de7716","Search people or crews") ?? "Search people or crews")}">
            <div class="pai-assign-subgroup">
              <div class="pai-assign-sublabel">${(globalThis.PlatformLanguage?.text("platform-action-items","m_57420a03b49adf","People") ?? "People")}</div>
              <div class="pai-assign-row" data-user-row><span class="pai-assign-note">${(globalThis.PlatformLanguage?.text("platform-action-items","m_14bf07579f8840","Loading people...") ?? "Loading people...")}</span></div>
            </div>
            <div class="pai-assign-subgroup">
              <div class="pai-assign-sublabel">${(globalThis.PlatformLanguage?.text("platform-action-items","m_997047322274fa","Crews") ?? "Crews")}</div>
              <div class="pai-assign-row" data-crew-row><span class="pai-assign-note">${(globalThis.PlatformLanguage?.text("platform-action-items","m_27fbbc1be46b70","Loading crews...") ?? "Loading crews...")}</span></div>
            </div>
            <div class="pai-assign-note" data-access-note></div>
          </div>
        </div>
        <div class="pai-schedule-panel" hidden>
          <input type="datetime-local" aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_9379697cb7f619","Due date and time") ?? "Due date and time")}">
          <button type="button" class="pai-schedule-clear">${(globalThis.PlatformLanguage?.text("platform-action-items","m_506191e24dd383","Clear") ?? "Clear")}</button>
        </div>
      `;
      const scheduleToggle = form.querySelector('.pai-schedule-toggle');
      const schedulePanel = form.querySelector('.pai-schedule-panel');
      const dueInput = schedulePanel?.querySelector('input');
      const assignToggle = form.querySelector('.pai-assign-toggle');
      const assignPanel = form.querySelector('.pai-assign-panel');
      const roleRow = form.querySelector('[data-role-row]');
      const userRow = form.querySelector('[data-user-row]');
      const crewRow = form.querySelector('[data-crew-row]');
      const assigneeSearch = form.querySelector('[data-assignee-search]');
      const accessNote = form.querySelector('[data-access-note]');
      const composerState = {
        priority: 0,
        roles: new Set(),
        users: new Set(),
        crews: new Set(),
        assignmentsLoaded: false,
        choices: { roles:[], users:[], crews:[] }
      };
      const assignmentCount = () => composerState.roles.size + composerState.users.size + composerState.crews.size;
      const syncAssignToggle = () => {
        assignToggle?.classList.toggle('active', composerState.priority > 0 || assignmentCount() > 0);
      };
      const clearAssignments = () => {
        composerState.roles.clear();
        composerState.users.clear();
        composerState.crews.clear();
      };
      const choiceButton = (kind, choice, selected) => {
        const unavailable = choice.available === false;
        const title = unavailable ? `Schedule ${choice.name} on this project before assigning a to-do.` : choice.detail || '';
        return `<button type="button" class="pai-assign-chip${selected ? ' on' : ''}" data-${kind}="${escapeHtml(choice.id)}" data-assignee-label="${escapeHtml(`${choice.name} ${choice.detail || ''}`.toLowerCase())}" title="${escapeHtml(title)}" ${unavailable ? 'disabled' : ''}>${escapeHtml(choice.name)}</button>`;
      };
      const applyAssigneeSearch = () => {
        const query = cleanText(assigneeSearch?.value).toLowerCase();
        form.querySelectorAll('[data-assignee-label]').forEach((chip) => {
          chip.hidden = !!query && !cleanText(chip.dataset.assigneeLabel).includes(query);
        });
      };
      const renderAssignmentChoices = () => {
        const { roles, users, crews } = composerState.choices;
        if (!roleRow) return;
        const roleChoices = [{ id: 'office', name: 'Office' }, ...roles];
        roleRow.innerHTML = ("<button type=\"button\" class=\"pai-assign-chip" + String(assignmentCount() ? '' : ' on') + "\" data-role=\"\">" + (globalThis.PlatformLanguage?.text("platform-action-items","m_8a993ed9b573b4","Unassigned") ?? "Unassigned") + "</button>" + String(roleChoices.map((role) => choiceButton('role', role, composerState.roles.has(role.id))).join('')));
        if (userRow) userRow.innerHTML = users.length
          ? users.map((user) => choiceButton('user', user, composerState.users.has(user.id))).join('')
          : `<span class="pai-assign-note">${(globalThis.PlatformLanguage?.text("platform-action-items","m_57d7a573615c64","No active people found.") ?? "No active people found.")}</span>`;
        if (crewRow) crewRow.innerHTML = crews.length
          ? crews.map((crew) => choiceButton('crew', crew, composerState.crews.has(crew.id))).join('')
          : `<span class="pai-assign-note">${(globalThis.PlatformLanguage?.text("platform-action-items","m_bd6b0cd48d012c","No active crews found.") ?? "No active crews found.")}</span>`;
        roleRow.querySelectorAll('[data-role]').forEach((chip) => chip.addEventListener('click', () => {
          const roleId = chip.dataset.role || '';
          if (!roleId) clearAssignments();
          else if (composerState.roles.has(roleId)) composerState.roles.delete(roleId);
          else composerState.roles.add(roleId);
          renderAssignmentChoices();
          syncAssignToggle();
        }));
        userRow?.querySelectorAll('[data-user]').forEach((chip) => chip.addEventListener('click', () => {
          const userId = chip.dataset.user || '';
          if (composerState.users.has(userId)) composerState.users.delete(userId);
          else composerState.users.add(userId);
          renderAssignmentChoices();
          syncAssignToggle();
        }));
        crewRow?.querySelectorAll('[data-crew]').forEach((chip) => chip.addEventListener('click', () => {
          const crewId = chip.dataset.crew || '';
          if (composerState.crews.has(crewId)) composerState.crews.delete(crewId);
          else composerState.crews.add(crewId);
          renderAssignmentChoices();
          syncAssignToggle();
        }));
        applyAssigneeSearch();
      };
      const loadAssignmentChoices = async () => {
        if (composerState.assignmentsLoaded) return;
        composerState.assignmentsLoaded = true;
        let roles = [], users = [], crews = [], project = null;
        try {
          const [catalog, usersResult, crewsResult, projectData] = await Promise.all([
            root.PlatformAPI?.workforce?.accessCatalog?.(orgId),
            root.PlatformAPI?.workforce?.users?.(orgId, branchId || 'default', { includeDisabled:false }),
            root.PlatformAPI?.workforce?.resourceGroups?.(orgId, branchId || 'default'),
            (options.projectId || options.project_id) && root.PlatformAPI?.documents?.getData
              ? root.PlatformAPI.documents.getData(orgId, 'projects', options.projectId || options.project_id).catch(() => null)
              : Promise.resolve(null)
          ]);
          roles = (Array.isArray(catalog?.roles) ? catalog.roles : [])
            .filter((role) => {
              const applications = Array.isArray(role.application_ids) ? role.application_ids : [role.application_id];
              return applications.includes('field') && cleanText(role.status || 'active') === 'active';
            })
            .map((role) => ({ id: cleanText(role.id), name: cleanText(role.name) || cleanText(role.id) }))
            .filter((role) => role.id);
          users = (Array.isArray(usersResult?.users) ? usersResult.users : [])
            .filter((user) => !['disabled','deleted'].includes(cleanText(user.status).toLowerCase()))
            .map((user) => ({
              id: cleanText(user.id || user.user_id),
              name: cleanText(user.name || user.display_name || user.email) || 'Crew member',
              detail: cleanText(user.email)
            }))
            .filter((user) => user.id);
          crews = (Array.isArray(crewsResult?.resource_groups) ? crewsResult.resource_groups : Array.isArray(crewsResult?.groups) ? crewsResult.groups : [])
            .filter((crew) => cleanText(crew.status || 'active').toLowerCase() === 'active')
            .map((crew) => ({
              id: cleanText(crew.id),
              name: cleanText(crew.name) || 'Crew',
              memberIds: (Array.isArray(crew.members) ? crew.members : []).map((member) => cleanText(member.user_id || member.id)).filter(Boolean)
            }))
            .filter((crew) => crew.id);
          project = projectData;
        } catch (_) {
          roles = [
            { id: 'supervisor', name: 'Supervisor' },
            { id: 'crew_foreman', name: 'Crew Foreman' },
            { id: 'crew_member', name: 'Crew Member' }
          ];
        }
        if (project) {
          const workEvents = (Array.isArray(project.events) ? project.events : []).filter((event) => {
            const kind = cleanText(event.kind).toLowerCase();
            const type = cleanText(event.event_type_default_id || event.type_id || event.event_type_id).toLowerCase();
            const itemKind = cleanText(event.schedule_item_kind).toLowerCase();
            return kind === 'project_work' || type === 'project_work' || type.startsWith('project_work_') || itemKind === 'production' || itemKind === 'labor';
          });
          const scheduledCrewIds = new Set(workEvents.map((event) => cleanText(event.work_resource_ref?.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id)).filter(Boolean));
          const scheduledUserIds = new Set(workEvents.flatMap((event) => [
            ...(Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : []),
            ...(Array.isArray(event.user_ids) ? event.user_ids : []),
            event.assigned_user_id,
            event.user_id,
            ...(Array.isArray(event.assigned_users) ? event.assigned_users.map((user) => user?.id || user?.user_id) : [])
          ].map(cleanText).filter(Boolean)));
          crews.forEach((crew) => {
            crew.available = scheduledCrewIds.has(crew.id);
            if (crew.available) crew.memberIds.forEach((id) => scheduledUserIds.add(id));
          });
          users.forEach((user) => { user.available = scheduledUserIds.has(user.id); });
          if (accessNote) accessNote.textContent = workEvents.length
            ? 'People and crews must already be scheduled on this project. Unavailable choices are disabled.'
            : 'Schedule a person or crew on this project before assigning field to-dos to them.';
        } else if (accessNote) {
          accessNote.textContent = (globalThis.PlatformLanguage?.text("platform-action-items","m_a2bdb608677061","Crew members see assigned to-dos in their personal feed and inside accessible projects.") ?? "Crew members see assigned to-dos in their personal feed and inside accessible projects.");
        }
        composerState.choices = { roles, users, crews };
        renderAssignmentChoices();
      };
      assigneeSearch?.addEventListener('input', applyAssigneeSearch);
      assignToggle?.addEventListener('click', () => {
        const nextHidden = !assignPanel?.hidden ? true : false;
        if (assignPanel) assignPanel.hidden = nextHidden;
        if (!nextHidden) {
          if (schedulePanel) schedulePanel.hidden = true;
          void loadAssignmentChoices();
        }
      });
      form.querySelector('[data-priority-row]')?.addEventListener('click', (event) => {
        const chip = event.target.closest?.('[data-priority]');
        if (!chip) return;
        composerState.priority = Number(chip.dataset.priority) || 0;
        form.querySelectorAll('[data-priority]').forEach((button) => {
          button.classList.toggle('on', Number(button.dataset.priority) === composerState.priority);
        });
        syncAssignToggle();
      });
      scheduleToggle?.addEventListener('click', () => {
        const nextHidden = !schedulePanel?.hidden ? true : false;
        if (schedulePanel) schedulePanel.hidden = nextHidden;
        if (!nextHidden) {
          if (assignPanel) assignPanel.hidden = true;
          dueInput?.focus();
        }
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
            priority: composerState.priority,
            ...(composerState.roles.size ? { assigned_role_ids: [...composerState.roles] } : {}),
            ...(composerState.users.size ? { assigned_user_ids: [...composerState.users] } : {}),
            ...(composerState.crews.size ? { assigned_resource_group_ids: [...composerState.crews] } : {}),
            source: 'today_list',
            reload: false
          });
          if (input) input.value = '';
          if (dueInput) dueInput.value = '';
          composerState.priority = 0;
          clearAssignments();
          form.querySelectorAll('[data-priority]').forEach((button) => {
            button.classList.toggle('on', Number(button.dataset.priority) === 0);
          });
          if (assigneeSearch) assigneeSearch.value = '';
          renderAssignmentChoices();
          syncAssignToggle();
          scheduleToggle?.classList.remove('active');
          if (schedulePanel) schedulePanel.hidden = true;
          if (assignPanel) assignPanel.hidden = true;
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

    function configuredFollowUps(){
      return followUpConfig || { label:(globalThis.PlatformLanguage?.text("platform-action-items","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"), default_time:'', quick_options:[{id:'one_day',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_8441977801a24a","1 day") ?? "1 day"),amount:1,unit:'days'},{id:'two_days',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_7a359eeea665a9","2 days") ?? "2 days"),amount:2,unit:'days'},{id:'one_week',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_54b3cb847f34e8","1 week") ?? "1 week"),amount:1,unit:'weeks'},{id:'one_month',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_48052eca696251","1 month") ?? "1 month"),amount:1,unit:'months'}], retry_policy:{enabled:true,triggers:['voicemail','no_answer','manual_follow_up'],after_last:'repeat_last',steps:[{id:'day_1',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_77908544a07e3e","Day 1") ?? "Day 1"),amount:1,unit:'days'},{id:'day_2',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_a384a1eab38925","Day 2") ?? "Day 2"),amount:1,unit:'days'},{id:'day_3',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_c2feb613d465e8","Day 3") ?? "Day 3"),amount:1,unit:'days'},{id:'day_5',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_db418c4e25b6f4","Day 5") ?? "Day 5"),amount:2,unit:'days'},{id:'weekly',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_d66730452e144d","Then weekly") ?? "Then weekly"),amount:1,unit:'weeks'}]}, outcomes:[{id:'follow_up',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_d9420394906975","Follow up again") ?? "Follow up again"),action:'reschedule',color:'#2e90fa'},{id:'scheduled',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_da42e64e20d9f0","Appointment scheduled") ?? "Appointment scheduled"),action:'scheduled',color:'#12b76a'},{id:'lost',label:(globalThis.PlatformLanguage?.text("platform-action-items","m_235d86f4916a45","Lost") ?? "Lost"),action:'lost',color:'#f04438'}] };
    }

    function quickFollowUpDate(option){
      const config=configuredFollowUps();
      const date=new Date();
      const amount=Math.max(1,Number(option?.amount)||1);
      if(option?.unit==='months')date.setMonth(date.getMonth()+amount);
      else date.setDate(date.getDate()+(option?.unit==='weeks'?amount*7:amount));
      const defaultTime=cleanText(config.default_time);
      if(defaultTime){const [hours,minutes]=defaultTime.split(':').map(Number);date.setHours(hours,minutes,0,0);}
      return date;
    }

    function followUpDueValue(date){
      return cleanText(configuredFollowUps().default_time)?date.toISOString():todayDateValue(date);
    }

    function followUpInputValue(value){
      const raw=cleanText(value);
      return /^\d{4}-\d{2}-\d{2}$/.test(raw)?raw:datetimeLocalToIso(raw);
    }

    function followUpDateControlMarkup(inputAttribute,value='',label='Follow-up date'){
      const raw=cleanText(value),hasTime=/T\d{2}:\d{2}/.test(raw);
      const shown=hasTime?datetimeLocalValue(raw):raw;
      return `<div class="pai-dispo-date-control"><input type="${String(hasTime?'datetime-local':'date')}" ${String(inputAttribute)} value="${String(escapeHtml(shown))}" aria-label="${String(escapeHtml(label))}"><button type="button" class="pai-add-time" data-follow-add-time ${String(hasTime?'hidden':'')} aria-label="${(globalThis.PlatformLanguage?.text("platform-action-items","m_5330278adebb5f","Add a time") ?? "Add a time")}" title="${(globalThis.PlatformLanguage?.text("platform-action-items","m_5330278adebb5f","Add a time") ?? "Add a time")}"><i class="fas fa-clock"></i></button></div>`;
    }

    function bindFollowUpAddTime(scope,inputSelector){
      const input=scope.querySelector(inputSelector),button=scope.querySelector('[data-follow-add-time]');
      button?.addEventListener('click',()=>{if(!input)return;const date=cleanText(input.value)||todayDateValue();input.type='datetime-local';input.value=`${date.slice(0,10)}T09:00`;button.hidden=true;input.focus();});
    }

    function policyFollowUpDate(item){
      const config=configuredFollowUps(),policy=config.retry_policy||{},steps=Array.isArray(policy.steps)?policy.steps:[];
      if(policy.enabled===false||!(policy.triggers||[]).includes('manual_follow_up')||!steps.length)return null;
      const followUp=item?.metadata?.follow_up||{};
      const currentIndex=Number.isInteger(Number(followUp.policy_step_index))?Number(followUp.policy_step_index):-1;
      let index=currentIndex+1;if(index>=steps.length){if(policy.after_last==='stop')return null;index=steps.length-1;}
      const date=quickFollowUpDate(steps[index]);
      return {date,dueAt:followUpDueValue(date),step:steps[index]};
    }

    function animateNextFrame(callback){
      if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(callback);
      else setTimeout(callback, 0);
    }

    function setDispositionOpen(disposition, open){
      if (!disposition) return;
      const stack=disposition.closest('.pai-item-stack');
      clearTimeout(disposition._paiCloseTimer);
      if (open) {
        disposition.closest('.pai-today-list')?.querySelectorAll('.pai-dispo.is-open').forEach((other)=>{if(other!==disposition)setDispositionOpen(other,false);});
        disposition.hidden=false;
        disposition.setAttribute('aria-hidden','false');
        animateNextFrame(()=>{disposition.classList.add('is-open');stack?.classList.add('is-outcome-open');});
        return;
      }
      disposition.classList.remove('is-open');
      disposition.setAttribute('aria-hidden','true');
      stack?.classList.remove('is-outcome-open');
      disposition._paiCloseTimer=setTimeout(()=>{if(!disposition.classList.contains('is-open'))disposition.hidden=true;},310);
    }

    function openDispositionNext(next){
      if (!next) return;
      clearTimeout(next._paiCloseTimer);
      next.hidden=false;
      next.setAttribute('aria-hidden','false');
      animateNextFrame(()=>next.classList.add('is-open'));
    }

    function followUpOutcomeMarkup(){
      const config=configuredFollowUps();
      return `<div class="pai-dispo-label">${((v0) => globalThis.PlatformLanguage?.text("platform-action-items","m_a9f7741cb25d8c",`${v0} outcome`,{v0}) ?? `${v0} outcome`)(escapeHtml(config.label||'Follow-up'))}</div><div class="pai-dispo-row pai-dispo-outcomes">${String((config.outcomes||[]).map((outcome)=>`<button style="--choice:${escapeHtml(outcome.color||'#64748b')}" data-follow-outcome="${escapeHtml(outcome.id)}" data-follow-action="${escapeHtml(outcome.action)}">${escapeHtml(outcome.label)}</button>`).join(''))}</div><div class="pai-dispo-next" data-dispo-next hidden aria-hidden="true"></div>`;
    }

    function bindFollowUpOutcome(disposition,item,controller){
      const next=disposition.querySelector('[data-dispo-next]');
      disposition.querySelectorAll('[data-follow-outcome]').forEach((button)=>button.addEventListener('click',async()=>{
        disposition.querySelectorAll('[data-follow-outcome]').forEach((choice)=>choice.classList.toggle('is-selected',choice===button));
        const action=button.dataset.followAction;
        if(action==='scheduled'){
          await openProjectAction(item,{project_id:projectIdForAction(item),tab:'scheduling'},'scheduling');
          return;
        }
        if(action==='lost'){
          button.disabled=true;
          await PlatformAPI.actionItems.followUpOutcome(orgId,itemId(item),{outcome:button.dataset.followOutcome});
          await controller.load({quiet:true});
          return;
        }
        const config=configuredFollowUps();
        const policy=policyFollowUpDate(item);
        next.innerHTML=`<div class="pai-dispo-label">${((v0) => globalThis.PlatformLanguage?.text("platform-action-items","m_60e2d51aed36ce",`Schedule next ${v0}`,{v0}) ?? `Schedule next ${v0}`)(escapeHtml(config.label||'follow-up'))}</div><div class="pai-dispo-row pai-dispo-quick">${String((config.quick_options||[]).map((option)=>`<button data-follow-quick="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`).join(''))}</div><div class="pai-dispo-custom">${String(followUpDateControlMarkup('data-follow-custom',policy?.dueAt||'','Custom follow-up date'))}<button data-follow-custom-save>${(globalThis.PlatformLanguage?.text("platform-action-items","m_fc05a804bd034c","Schedule") ?? "Schedule")}</button></div>`;
        openDispositionNext(next);
        bindFollowUpAddTime(next,'[data-follow-custom]');
        next.querySelectorAll('[data-follow-quick]').forEach((quickButton)=>quickButton.addEventListener('click',async()=>{const option=(config.quick_options||[]).find((entry)=>entry.id===quickButton.dataset.followQuick);quickButton.disabled=true;await PlatformAPI.actionItems.followUpOutcome(orgId,itemId(item),{outcome:button.dataset.followOutcome,due_at:followUpDueValue(quickFollowUpDate(option)),policy_trigger:'manual_follow_up'});await controller.load({quiet:true});}));
        next.querySelector('[data-follow-custom-save]')?.addEventListener('click',async(event)=>{const dueAt=followUpInputValue(next.querySelector('[data-follow-custom]')?.value);if(!dueAt)return;event.currentTarget.disabled=true;await PlatformAPI.actionItems.followUpOutcome(orgId,itemId(item),{outcome:button.dataset.followOutcome,due_at:dueAt,policy_trigger:'manual_follow_up'});await controller.load({quiet:true});});
      }));
    }

    function appendRows(section, items, toneOptions = {}){
      items.forEach((item) => {
        const row = renderRow(item, { showProjectContext: options.showProjectContext, ...toneOptions, now: new Date() });
        const hasDisposition = cleanText(item?.kind) === 'sales_contact';
        const followUpDisposition = isFollowUpItem(item);
        const disposition = hasDisposition || followUpDisposition ? document.createElement('div') : null;
        if (disposition) {
          disposition.className = 'pai-dispo';
          disposition.hidden = true;
          disposition.setAttribute('aria-hidden','true');
          disposition.innerHTML = followUpDisposition ? followUpOutcomeMarkup() : `<div class="pai-dispo-label">${(globalThis.PlatformLanguage?.text("platform-action-items","m_8ea60ad82dc43f","Call result") ?? "Call result")}</div><div class="pai-dispo-row"><button style="--choice:#12b76a" data-dispo="answered">${(globalThis.PlatformLanguage?.text("platform-action-items","m_1462617901ae73","Answered") ?? "Answered")}</button><button style="--choice:#f79009" data-dispo="voicemail">${(globalThis.PlatformLanguage?.text("platform-action-items","m_44ac4ae97ee5aa","Left voicemail") ?? "Left voicemail")}</button><button style="--choice:#f04438" data-dispo="no_answer">${(globalThis.PlatformLanguage?.text("platform-action-items","m_15b84e02e4bb08","No voicemail") ?? "No voicemail")}</button></div><div class="pai-dispo-next" data-dispo-next hidden aria-hidden="true"></div>`;
          disposition.addEventListener('click', (event) => event.stopPropagation());
        }
        row.addEventListener('click', async () => {
          if (isCompleted(item) || itemIsFuture(item)) return;
          if (disposition) { setDispositionOpen(disposition,!disposition.classList.contains('is-open')); return; }
          await open(item, { orgId, source: 'today_list', controller });
        });
        row.addEventListener('keydown', async (event) => {
          if (isCompleted(item) || itemIsFuture(item) || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          await open(item, { orgId, source: 'today_list', controller });
        });
        const leadingAction = row.querySelector('.pai-check-zone, .pai-leading-action');
        if (leadingAction) {
          leadingAction.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isCompleted(item)) return;
            if (disposition) { setDispositionOpen(disposition,!disposition.classList.contains('is-open')); return; }
            if (!manualCompletionAllowed(item)) return;
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
        const stack=document.createElement('div');
        stack.className='pai-item-stack';
        stack.appendChild(row);
        section.appendChild(stack);
        if (disposition) {
          stack.appendChild(disposition);
          if (followUpDisposition) { bindFollowUpOutcome(disposition,item,controller); return; }
          const next = disposition.querySelector('[data-dispo-next]');
          const followUpChoices = () => {
            const config=configuredFollowUps();
            next.innerHTML = `<div class="pai-dispo-label">${((v0) => globalThis.PlatformLanguage?.text("platform-action-items","m_f6c680ed795324",`Schedule ${v0}`,{v0}) ?? `Schedule ${v0}`)(escapeHtml(config.label||'follow-up'))}</div><div class="pai-dispo-row pai-dispo-quick">${String((config.quick_options||[]).map((option)=>`<button data-followup="${escapeHtml(option.id)}">${escapeHtml(option.label)}</button>`).join(''))}</div><div class="pai-dispo-custom">${String(followUpDateControlMarkup('data-followup-time','','Custom follow-up date'))}<button data-followup="custom">${(globalThis.PlatformLanguage?.text("platform-action-items","m_fc05a804bd034c","Schedule") ?? "Schedule")}</button></div>`;
            openDispositionNext(next);
            bindFollowUpAddTime(next,'[data-followup-time]');
            next.querySelectorAll('[data-followup]').forEach((button) => button.addEventListener('click', async () => {
              const option=(config.quick_options||[]).find((entry)=>entry.id===button.dataset.followup);
              const dueAt=button.dataset.followup==='custom'?followUpInputValue(next.querySelector('[data-followup-time]')?.value):followUpDueValue(quickFollowUpDate(option));
              const projectId = projectIdForAction(item);
              if (!projectId || !dueAt) return;
              button.disabled = true;
              await PlatformAPI.actionItems.create(orgId,{kind:'follow_up',title:config.default_title||'Follow-up call',due_at:dueAt,project_id:projectId,assigned_user_ids:item.assigned_user_ids||[],assigned_role_ids:item.assigned_role_ids||[],metadata:{type_tags:['follow_up'],follow_up:{channel:'call',origin:'sales_contact'}}});
              await complete(orgId,itemId(item),{reason:'follow_up_scheduled',outcome:'follow_up'},{reload:false});
              await controller.load({ quiet:true });
            }));
          };
          disposition.querySelectorAll('[data-dispo]').forEach((button) => button.addEventListener('click', async () => {
            const value = button.dataset.dispo;
            disposition.querySelectorAll('[data-dispo]').forEach((choice)=>choice.classList.toggle('is-selected',choice===button));
            if (value !== 'answered') { followUpChoices(); return; }
            next.innerHTML = `<div class="pai-dispo-label">${(globalThis.PlatformLanguage?.text("platform-action-items","m_d31e1c334cc33e","What happens next?") ?? "What happens next?")}</div><div class="pai-dispo-row"><button data-outcome="appointment">${(globalThis.PlatformLanguage?.text("platform-action-items","m_837936705cf1ab","Appointment booked") ?? "Appointment booked")}</button><button data-outcome="follow_up">${(globalThis.PlatformLanguage?.text("platform-action-items","m_0307a1de90a6aa","Follow up") ?? "Follow up")}</button><button style="--choice:#f04438" data-outcome="lost">${(globalThis.PlatformLanguage?.text("platform-action-items","m_235d86f4916a45","Lost") ?? "Lost")}</button></div>`;
            openDispositionNext(next);
            next.querySelector('[data-outcome="appointment"]')?.addEventListener('click', () => openProjectAction(item, { project_id:projectIdForAction(item), tab:'scheduling' }, 'scheduling'));
            next.querySelector('[data-outcome="follow_up"]')?.addEventListener('click', followUpChoices);
            next.querySelector('[data-outcome="lost"]')?.addEventListener('click', async () => { const projectId=projectIdForAction(item); if (!projectId) return; await PlatformAPI.work.markProjectLost(orgId,projectId,{reason:'lead_lost'}); await complete(orgId,itemId(item),{reason:'lead_lost',disposition:'answered',outcome:'lost'},{reload:false}); await controller.load({quiet:true}); });
          }));
        }
      });
    }

    function renderItems(items){
      if (!el || destroyed) return;
      injectListStyles();
      lastItems = Array.isArray(items) ? items : [];
      const prepared = prepareTodayList(lastItems, { now: new Date() });
      const shell = document.createElement('div');
      const dockDeferred = options.dockDeferredSections === true;
      shell.className = `pai-today-list${options.scrollItemsOnly === true ? ' pai-items-scroll' : ''}${dockDeferred ? ' pai-docked-deferred' : ''}`;
      appendComposer(shell);
      const itemsContainer = document.createElement('div');
      itemsContainer.className = 'pai-items';
      const activeItems = document.createElement('div');
      activeItems.className = 'pai-active-items';
      const activeMount = dockDeferred ? activeItems : itemsContainer;

      appendRows(activeMount, prepared.past_due);
      appendRows(activeMount, prepared.current);

      const upcomingSection = document.createElement('div');
      upcomingSection.className = 'pai-section pai-upcoming';
      appendRows(upcomingSection, prepared.upcoming);
      if (prepared.upcoming.length && options.showUpcoming !== false) activeMount.appendChild(upcomingSection);

      if (!dockDeferred && prepared.future.length && options.showFuture === true) {
        const futureLabel = document.createElement('div');
        futureLabel.className = 'pai-future-label';
        futureLabel.textContent = (globalThis.PlatformLanguage?.text("platform-action-items","m_9113d886525c5a","Future") ?? "Future");
        itemsContainer.appendChild(futureLabel);
        const futureSection = document.createElement('div');
        futureSection.className = 'pai-section pai-future-section';
        appendRows(futureSection, prepared.future);
        itemsContainer.appendChild(futureSection);
      }

      const activeVisibleCount = prepared.past_due.length + prepared.current.length
        + (options.showUpcoming === false ? 0 : prepared.upcoming.length);
      const visibleCount = activeVisibleCount + (options.showFuture === true ? prepared.future.length : 0);
      if (dockDeferred && !activeVisibleCount) activeItems.classList.add('is-empty');
      if ((dockDeferred && !activeVisibleCount) || (!dockDeferred && !visibleCount && !prepared.completed_count)) {
        const stateEl = document.createElement('div');
        stateEl.className = 'pai-state';
        stateEl.textContent = (globalThis.PlatformLanguage?.text("platform-action-items","m_2f88ace536253f","Hooray, you are all caught up.") ?? "Hooray, you are all caught up.");
        activeMount.appendChild(stateEl);
      }

      if (!dockDeferred && prepared.completed_count) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pai-completed-toggle';
        toggle.setAttribute('aria-expanded', completedOpen ? 'true' : 'false');
        toggle.innerHTML = `<span>${((v0) => globalThis.PlatformLanguage?.text("platform-action-items","m_ecd6a5898cb5f6",`Completed (${v0})`,{v0}) ?? `Completed (${v0})`)(prepared.completed_count)}</span><i class="fas fa-chevron-right"></i>`;
        const panel = document.createElement('div');
        panel.className = 'pai-completed-panel';
        panel.hidden = !completedOpen;
        appendRows(panel, prepared.completed);
        toggle.addEventListener('click', () => {
          completedOpen = !completedOpen;
          toggle.setAttribute('aria-expanded', completedOpen ? 'true' : 'false');
          panel.hidden = !completedOpen;
        });
        itemsContainer.appendChild(toggle);
        itemsContainer.appendChild(panel);
      }

      if (dockDeferred) {
        itemsContainer.appendChild(activeItems);
        const spacer = document.createElement('div');
        spacer.className = 'pai-deferred-spacer';
        itemsContainer.appendChild(spacer);
        const deferredSections = document.createElement('div');
        deferredSections.className = 'pai-deferred-sections';
        const syncDeferredLayout = () => shell.classList.toggle('has-open-deferred', futureOpen || completedOpen);

        const appendDeferredGroup = (label, items, isOpen, onToggle) => {
          const group = document.createElement('div');
          group.className = 'pai-deferred-group';
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'pai-deferred-toggle';
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          toggle.innerHTML = `<span>${escapeHtml(label)} (${items.length})</span><i class="fas fa-chevron-right" aria-hidden="true"></i>`;
          const panel = document.createElement('div');
          panel.className = `pai-deferred-panel${isOpen ? ' is-open' : ''}`;
          const panelInner = document.createElement('div');
          panelInner.className = 'pai-deferred-panel-inner';
          appendRows(panelInner, items);
          panel.appendChild(panelInner);
          toggle.addEventListener('click', () => {
            const open = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            panel.classList.toggle('is-open', open);
            onToggle(open);
          });
          group.append(toggle, panel);
          deferredSections.appendChild(group);
        };

        appendDeferredGroup('Future', options.showFuture === true ? prepared.future : [], futureOpen, (open) => {
          futureOpen = open;
          syncDeferredLayout();
        });
        appendDeferredGroup('Completed', prepared.completed, completedOpen, (open) => {
          completedOpen = open;
          syncDeferredLayout();
        });
        syncDeferredLayout();
        itemsContainer.appendChild(deferredSections);
      }

      shell.appendChild(itemsContainer);
      el.replaceChildren(shell);
      shell.querySelectorAll('.pai-row').forEach((row) => row.classList.add('pai-row-enter'));
    }

    async function completeWithAnimation(row, item){
      const id = itemId(item);
      if (!id || row.classList.contains('pai-completing')) return;
      const previousStatus = itemWorkflowStatus(item) || 'ready';
      const label = itemTitle(item);
      row.querySelector('.pai-check')?.classList.add('is-done');
      row.classList.add('pai-completing');
      await new Promise((resolve) => setTimeout(resolve, 190));
      await complete(orgId, id, { reason: 'manual' }, { reload: false }).catch((error) => {
        row.classList.remove('pai-completing');
        row.querySelector('.pai-check')?.classList.remove('is-done');
        throw error;
      });
      root.PlatformUndo?.record?.({
        label: ((v0) => globalThis.PlatformLanguage?.text("platform-action-items","m_602613817a5979",`marking “${v0}” complete`,{v0}) ?? `marking “${v0}” complete`)(label),
        scope: `work:${orgId}`,
        metadata: { entityType:'work_node', entityId:id, action:'complete' },
        undo: async () => {
          const result = await reopen(orgId, id, previousStatus, { reason:'undo_manual_completion' }, { reload:false });
          await controller.load({ quiet:true });
          return result;
        },
        redo: async () => {
          const result = await complete(orgId, id, { reason:'redo_manual_completion' }, { reload:false });
          await controller.load({ quiet:true });
          return result;
        }
      });
      await controller.load({ quiet: true });
    }

    async function snoozeWithAnimation(row, item){
      const id = itemId(item);
      if (!id || row.classList.contains('pai-completing')) return;
      const previousDueAt = cleanText(item?.due_at);
      const nextDueAt = tomorrowDueValue(item);
      const label = itemTitle(item);
      row.classList.add('pai-completing');
      await new Promise((resolve) => setTimeout(resolve, 140));
      await patch(orgId, id, { due_at:nextDueAt }, { ...queryOptions(), reload: false }).catch((error) => {
        row.classList.remove('pai-completing');
        throw error;
      });
      root.PlatformUndo?.record?.({
        label: ((v0) => globalThis.PlatformLanguage?.text("platform-action-items","m_8c439bc025de60",`rescheduling “${v0}”`,{v0}) ?? `rescheduling “${v0}”`)(label),
        scope: `work:${orgId}`,
        metadata: { entityType:'work_node', entityId:id, action:'reschedule' },
        undo: async () => {
          const result = await patch(orgId, id, { due_at:previousDueAt }, { ...queryOptions(), reload:false });
          await controller.load({ quiet:true });
          return result;
        },
        redo: async () => {
          const result = await patch(orgId, id, { due_at:nextDueAt }, { ...queryOptions(), reload:false });
          await controller.load({ quiet:true });
          return result;
        }
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
          const [result,configurationResult] = await Promise.all([
            loadToday(orgId, queryOptions()),
            followUpConfig ? Promise.resolve(null) : PlatformAPI?.work?.configuration?.(orgId, branchId || 'default').catch?.(() => null)
          ]);
          if (configurationResult?.configuration?.follow_ups) followUpConfig=configurationResult.configuration.follow_ups;
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
    label: (globalThis.PlatformLanguage?.text("platform-action-items","m_653b5e6fc32812","Schedule project") ?? "Schedule project"),
    open(item){
      const action = item?.frontend_action || {};
      return openProjectAction(item, action, 'schedule');
    }
  });
  registerKind('open_customer_call', {
    label:(globalThis.PlatformLanguage?.text("platform-action-items","m_cd5cbbc6f5ac2b","Call contact") ?? "Call contact"),
    orderKey:'05_follow_up',
    open(item){
      const action=item?.frontend_action||{},nodeId=item.work_node_id||item.node_id||item.payload?.work_node_id||item.id;
      return window.Portal?.Communications?.open?.({...action,source_node_ids:nodeId?[String(nodeId)]:[]});
    }
  });

  registerKind('open_project', {
    label: (globalThis.PlatformLanguage?.text("platform-action-items","m_27136d1254783a","Open project") ?? "Open project"),
    open(item){
      return openProjectAction(item, item?.frontend_action || {}, 'map');
    }
  });

  registerKind('send_project_proposal', {
    label: (globalThis.PlatformLanguage?.text("platform-action-items","m_ab162bd2087399","Send proposal") ?? "Send proposal"),
    orderKey: '10_proposal',
    open(item){
      return openProjectAction(item, item?.frontend_action || {}, 'proposal');
    }
  });

  registerKind('manual', {
    label: (globalThis.PlatformLanguage?.text("platform-action-items","m_4f9d237d6a773d","Manual to-do") ?? "Manual to-do"),
    orderKey: '00_manual',
    open(item){
      if (!projectIdForAction(item)) return null;
      return openProjectAction(item, { ...(item?.frontend_action || {}), kind: 'open_project', tab: 'map' }, 'map');
    }
  });

  registerKind('follow_up', {
    label: (globalThis.PlatformLanguage?.text("platform-action-items","m_cfc813aecc8dd9","Follow-up") ?? "Follow-up"),
    orderKey: '05_follow_up',
    open(item){
      return openProjectAction(item, item?.frontend_action || {}, 'map');
    }
  });

  root.PlatformActionItems = {
    subscribe,
    getState,
    load,
    loadToday,
    todayListOptions,
    prepareTodayList,
    manualCompletionAllowed,
    renderTodayList: createTodayListController,
    registerKind,
    kindDefinition,
    renderLabel,
    displayText,
    dueMeta,
    projectTabForItem,
    open,
    claim,
    complete,
    reopen,
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
