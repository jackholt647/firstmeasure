/* scripts/topbar.js
 * Thin content top bar with search and notifications.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { escapeHtml } = window.Portal.util;

  const orgId = () => String(cfg.userOrgId || cfg.orgId || '').trim();
  const branchId = () => window.Portal.branchModules?.currentBranchId?.() || cfg.userBranchId || cfg.branchId || 'default';
  let searchData = { loaded: false, projects: [], contacts: [], customers: [] };
  let searchTimer = null;
  let searchRequest = null;
  let searchSequence = 0;
  const searchResultCache = new Map();
  let notificationTimer = null;

  function $(sel){ return document.querySelector(sel); }
  function cleanText(value){ return String(value ?? '').trim(); }
  function firstText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function notificationMenus(){
    return Array.from(document.querySelectorAll('#platformNotificationMenu, #mobilePlatformNotificationMenu'));
  }

  function closeNotificationMenus(){
    notificationMenus().forEach((menu) => menu.classList.remove('visible'));
    document.body.classList.remove('mobile-notifications-open');
  }

  function setMobileNotificationsVisible(visible){
    const mobileTopbar = $('.mobile-topbar');
    const notifications = $('#mobilePlatformNotifications');
    mobileTopbar?.classList.toggle('topbar-enabled', !!visible);
    if (notifications) notifications.hidden = !visible;
  }

  function setTopbarVisible(visible){
    const topbar = $('#platformTopbar');
    if (topbar) topbar.style.display = visible ? '' : 'none';
    setMobileNotificationsVisible(visible);
  }

  async function topbarEnabled(){
    if (!orgId()) return false;
    if (!window.PlatformAPI?.appFlags?.current?.()) {
      await window.Portal?.appFlags?.load?.().catch(() => null);
    }
    const current = window.PlatformAPI?.appFlags?.current?.();
    if (!current) return false;
    return !!window.PlatformAPI?.appFlags?.has?.('platform', 'top_bar');
  }

  async function loadSearchData(){
    if (searchData.loaded || !window.PlatformAPI || !orgId()) return searchData;
    const customerPromise = window.PlatformAPI.customers?.list
      ? window.PlatformAPI.customers.list(orgId()).catch(() => ({ documents: [] }))
      : Promise.resolve({ documents: [] });
    const [projectResult, customerResult] = await Promise.all([
      window.PlatformAPI.projects.list(orgId()).catch(() => ({ documents: [] })),
      customerPromise,
    ]);
    const projects = (projectResult.documents || []).map((doc) => {
      const data = doc?.data && typeof doc.data === 'object' ? doc.data : {};
      const id = firstText(data.platform_project_id, data.base_project_id, data.id, doc?.id);
      return { id, ...data, id, _type: 'project' };
    });
    const customers = (customerResult.documents || []).map((doc) => ({ id: doc.id, ...(doc.data || {}), _type: 'customer' }));
    const contacts = projects.flatMap((project) => {
      const rows = Array.isArray(project.contacts) ? project.contacts : [];
      const embedded = rows.map((contact, index) => ({
        id: `${project.id || 'project'}:${index}`,
        project_id: project.id,
        project,
        name: contact?.name || '',
        email: contact?.email || '',
        phone: contact?.phone || '',
        address: contact?.address || contact?.default_address || project.contact_address || project.customer_address || project.primary_contact_address || '',
        _type: 'contact'
      })).filter((contact) => contact.name || contact.email || contact.phone);
      const aliases = [{
        id: `${project.id || 'project'}:primary`,
        project_id: project.id,
        project,
        name: firstText(project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === 'string' ? project.resident : ''),
        email: firstText(project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail),
        phone: firstText(project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone),
        address: firstText(project.contact_address, project.customer_address, project.primary_contact_address, project.workflow_state === 'contact_only' ? project.address : ''),
        _type: 'contact'
      }].filter((contact) => contact.name || contact.email || contact.phone);
      return [...embedded, ...aliases];
    });
    const customerContacts = customers.map((customer) => ({
      id: `customer:${customer.id}`,
      customer,
      project_id: firstText(customer.primary_project_id, customer.project_id, Array.isArray(customer.project_ids) ? customer.project_ids[0] : ''),
      project_ids: Array.isArray(customer.project_ids) ? customer.project_ids : [],
      name: customer.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customer.address || customer.default_address || '',
      _type: 'customer'
    })).filter((contact) => contact.name || contact.email || contact.phone);
    searchData = {
      loaded: true,
      projects,
      contacts: [...contacts, ...customerContacts],
      customers,
    };
    return searchData;
  }

  function openProject(project){
    if (!project?.id) return;
    if (window.Portal.modules?.request?.openProject) window.Portal.modules.request.openProject(project);
    else window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project } }));
  }

  async function openContact(contact = {}){
    if (window.Portal.modules?.contacts?.open) {
      window.Portal.modules.contacts.open(contact, {
        projects: contact.project?.id ? [contact.project] : []
      });
      return;
    }
    if (contact.project?.id) {
      openProject(contact.project);
      return;
    }
    const ids = [
      contact.project_id,
      contact.primary_project_id,
      ...(Array.isArray(contact.project_ids) ? contact.project_ids : [])
    ].map(cleanText).filter(Boolean);
    const local = searchData.projects.find((project) => ids.includes(cleanText(project.id)));
    if (local) {
      openProject(local);
      return;
    }
    const matched = searchData.projects.find((project) => {
      const haystack = contactNeedlesForProject(project);
      return [contact.name, contact.email, contact.phone]
        .map((value) => cleanText(value).toLowerCase())
        .filter(Boolean)
        .some((value) => haystack.includes(value));
    });
    if (matched) {
      openProject(matched);
      return;
    }
    const id = ids[0];
    if (id && window.PlatformAPI?.projects?.get) {
      const result = await window.PlatformAPI.projects.get(orgId(), id).catch(() => null);
      const data = result?.document?.data;
      if (data) openProject({ id, ...data });
    }
  }

  function contactNeedlesForProject(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    return [
      project.customer_name,
      project.customerName,
      project.primary_contact_name,
      project.customer_email,
      project.primary_contact_email,
      project.customer_phone,
      project.primary_contact_phone,
      project.resident_name,
      project.residentName,
      typeof project.resident === 'string' ? project.resident : '',
      ...contacts.flatMap((contact) => [contact?.name, contact?.email, contact?.phone])
    ].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  }

  function projectSearchText(project = {}){
    return [
      project.address,
      project.project_address,
      project.property_address,
      project.title,
      project.project_title,
      project.project_name,
      project.projectName,
      project.name,
      project.project_type,
      project.stage,
      project.stage_id,
      project.status,
      contactNeedlesForProject(project)
    ].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  }

  function contactSearchText(contact = {}){
    return [contact.name, contact.email, contact.phone].map((value) => cleanText(value).toLowerCase()).filter(Boolean).join(' ');
  }

  function isLeadNotification(item = {}){
    const title = String(item.title || '').toLowerCase();
    const source = String(item.source || item.context?.lead_source || '').toLowerCase();
    return !!(item.context?.project_id || item.data?.project_id) && (
      title.includes('lead') || source.includes('lead') || source.includes('email') || source.includes('canvassing')
    );
  }

  function leadTitle(item = {}){
    return isLeadNotification(item) ? 'Contact new lead' : (item.title || 'Notification');
  }

  async function openNotificationProject(item = {}){
    const projectId = String(item.context?.project_id || item.data?.project_id || '').trim();
    if (!projectId || !window.PlatformAPI?.projects?.get || !orgId()) return false;
    try {
      const result = await window.PlatformAPI.projects.get(orgId(), projectId);
      const data = result?.document?.data || null;
      if (!data) return false;
      const project = { id: projectId, ...data };
      openProject(project);
      searchData.loaded = false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function searchBoxForInput(input){
    return input?.closest?.('.platform-search')?.querySelector?.('.ptb-search-results') || $('#platformSearchResults');
  }

  function closeSearchResults(){
    document.querySelectorAll('.ptb-search-results.visible').forEach((box) => box.classList.remove('visible'));
  }

  async function projectForSearchResult(result = {}){
    const projectId = cleanText(result.project_id || result.id);
    if (!projectId) return null;
    const local = searchData.projects.find((project) => cleanText(project.id) === projectId);
    if (local) return local;
    if (window.PlatformAPI?.projects?.get) {
      const data = await window.PlatformAPI.projects.get(orgId(), projectId).catch(() => null);
      const doc = data?.document;
      if (doc?.data) return { id: doc.id || projectId, ...doc.data };
    }
    return { id: projectId, title: result.title || '', address: result.subtitle || '' };
  }

  async function openSearchResult(result = {}){
    if (result.type === 'contact') {
      const contact = {
        ...(result.contact || {}),
        id: result.id,
        project_id: result.project_id || result.contact?.project_id || '',
        project_ids: Array.isArray(result.contact?.project_ids) ? result.contact.project_ids : [],
        name: result.contact?.name || result.title || '',
        email: result.contact?.email || '',
        phone: result.contact?.phone || ''
      };
      await openContact(contact);
      return;
    }
    const project = await projectForSearchResult(result);
    openProject(project);
  }

  function resultIcon(type){
    return type === 'contact' ? 'fa-user' : 'fa-folder-open';
  }

  function resultLabel(type){
    return type === 'contact' ? 'Contact' : 'Project';
  }

  function renderApiSearchResults(box, results = []){
    if (!box) return;
    searchResultCache.clear();
    const html = results.map((result, index) => {
      const type = result.type === 'contact' ? 'contact' : 'project';
      const key = `${type}:${result.id || index}`;
      searchResultCache.set(key, result);
      return `
        <button type="button" class="ptb-search-item ${type}" data-search-result="${escapeHtml(key)}">
          <i class="fas ${resultIcon(type)} ptb-search-kind" aria-hidden="true"></i>
          <span><strong>${escapeHtml(result.title || resultLabel(type))}</strong><small><b>${escapeHtml(resultLabel(type))}</b>${result.subtitle ? ` &middot; ${escapeHtml(result.subtitle)}` : ''}</small></span>
        </button>
      `;
    }).join('');
    box.innerHTML = html || `<div class="ptb-empty">No matches</div>`;
    box.classList.add('visible');
    box.querySelectorAll('[data-search-result]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const result = searchResultCache.get(btn.dataset.searchResult);
        closeSearchResults();
        openSearchResult(result).catch(() => null);
      });
    });
  }

  function renderLocalSearchResults(query, box = $('#platformSearchResults')){
    if (!box) return;
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) {
      box.classList.remove('visible');
      box.innerHTML = '';
      return;
    }
    const projects = searchData.projects.filter((project) => projectSearchText(project).includes(needle)).slice(0, 6);
    const contacts = searchData.contacts.filter((contact) => contactSearchText(contact).includes(needle)).slice(0, 4);
    const html = [
      ...projects.map((project) => `
        <button type="button" class="ptb-search-item project" data-search-type="project" data-id="${escapeHtml(project.id)}">
          <i class="fas fa-folder-open ptb-search-kind"></i>
          <span><strong>${escapeHtml(firstText(project.title, project.project_title, project.project_name, project.customer_name, project.primary_contact_name, project.address, 'Project'))}</strong><small><b>Project</b>${firstText(project.address, project.project_type, project.stage) ? ` &middot; ${escapeHtml(firstText(project.address, project.project_type, project.stage))}` : ''}</small></span>
        </button>
      `),
      ...contacts.map((contact) => `
        <button type="button" class="ptb-search-item contact" data-search-type="contact" data-id="${escapeHtml(contact.id)}">
          <i class="fas fa-user ptb-search-kind"></i>
          <span><strong>${escapeHtml(contact.name || contact.email || 'Contact')}</strong><small><b>Contact</b>${firstText(contact.email, contact.phone) ? ` &middot; ${escapeHtml(firstText(contact.email, contact.phone))}` : ''}</small></span>
        </button>
      `),
    ].join('');
    box.innerHTML = html || `<div class="ptb-empty">No matches</div>`;
    box.classList.add('visible');
    box.querySelectorAll('[data-search-type="project"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const project = searchData.projects.find((item) => item.id === btn.dataset.id);
        box.classList.remove('visible');
        openProject(project);
      });
    });
    box.querySelectorAll('[data-search-type="contact"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const contact = searchData.contacts.find((item) => item.id === btn.dataset.id);
        box.classList.remove('visible');
        openContact(contact).catch(() => null);
      });
    });
  }

  async function runSearch(input){
    const box = searchBoxForInput(input);
    const query = cleanText(input?.value);
    if (!box) return;
    if (!query) {
      box.classList.remove('visible');
      box.innerHTML = '';
      return;
    }
    const sequence = ++searchSequence;
    if (searchRequest) searchRequest.abort();
    searchRequest = window.AbortController ? new AbortController() : null;
    box.innerHTML = `<div class="ptb-empty">Searching...</div>`;
    box.classList.add('visible');
    if (window.PlatformAPI?.search?.projectsAndContacts) {
      try {
        const result = await window.PlatformAPI.search.projectsAndContacts(orgId(), {
          query,
          types: 'projects,contacts',
          limit: 100,
          ...(searchRequest ? { signal: searchRequest.signal } : {})
        });
        if (sequence !== searchSequence) return;
        renderApiSearchResults(box, Array.isArray(result?.results) ? result.results : []);
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    await loadSearchData();
    if (sequence !== searchSequence) return;
    renderLocalSearchResults(query, box);
  }

  function renderNotifications(snapshot = window.PlatformNotifications?.getState?.() || {}){
    const count = $('#platformNotificationCount');
    const list = $('#platformNotificationList');
    const menuHead = $('#platformNotificationMenu .ptb-menu-head');
    const mobileCount = $('#mobilePlatformNotificationCount');
    const mobileList = $('#mobilePlatformNotificationList');
    const mobileMenuHead = $('#mobilePlatformNotificationMenu .ptb-menu-head');
    const unread = Number(snapshot.unread_count || 0);
    const total = Number(snapshot.active_count || 0);
    if (count) {
      count.textContent = total > 99 ? '99+' : String(total || 0);
      count.title = unread ? `${unread} unread, ${total} total` : `${total} total`;
      count.classList.toggle('visible', total > 0);
      count.classList.toggle('has-unread', unread > 0);
    }
    if (mobileCount) {
      mobileCount.textContent = total > 99 ? '99+' : String(total || 0);
      mobileCount.title = unread ? `${unread} unread, ${total} total` : `${total} total`;
      mobileCount.classList.toggle('visible', total > 0);
      mobileCount.classList.toggle('has-unread', unread > 0);
    }
    if (menuHead) {
      menuHead.innerHTML = `<span>Notifications</span><small>${unread} unread &middot; ${total} total</small>`;
    }
    if (mobileMenuHead && menuHead) mobileMenuHead.innerHTML = menuHead.innerHTML;
    if (!list) return;
    const notifications = Array.isArray(snapshot.notifications) ? snapshot.notifications : [];
    list.innerHTML = notifications.length ? notifications.map((item) => `
      <div class="ptb-note ${item.user_state?.seen_at ? 'seen' : 'unread'} ${isLeadNotification(item) ? 'lead-note' : ''}" data-note-id="${escapeHtml(item.id)}">
        <div class="ptb-note-main">
          <strong>${escapeHtml(leadTitle(item))}</strong>
          <span>${escapeHtml(item.body || '')}</span>
        </div>
        ${item.manual_dismissible && !isLeadNotification(item) ? `<button type="button" class="ptb-note-dismiss" data-dismiss-note="${escapeHtml(item.id)}">Done</button>` : ''}
      </div>
    `).join('') : `<div class="ptb-empty">No notifications</div>`;
    if (mobileList) mobileList.innerHTML = list.innerHTML;
    list.querySelectorAll('[data-note-id]').forEach((node) => {
      node.addEventListener('click', async () => {
        const item = notifications.find((entry) => String(entry.id) === String(node.dataset.noteId));
        window.PlatformNotifications?.markSeen(orgId(), node.dataset.noteId, { branchId: branchId(), reload: true }).catch(() => null);
        if (isLeadNotification(item)) {
          await openNotificationProject(item);
          closeNotificationMenus();
        }
      });
    });
    list.querySelectorAll('[data-dismiss-note]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        window.PlatformNotifications?.dismiss(orgId(), btn.dataset.dismissNote, { branchId: branchId(), reload: true }).catch(() => null);
      });
    });
    if (mobileList) {
      mobileList.querySelectorAll('[data-note-id]').forEach((node) => {
        node.addEventListener('click', async () => {
          const item = notifications.find((entry) => String(entry.id) === String(node.dataset.noteId));
          window.PlatformNotifications?.markSeen(orgId(), node.dataset.noteId, { branchId: branchId(), reload: true }).catch(() => null);
          if (isLeadNotification(item)) {
            await openNotificationProject(item);
            closeNotificationMenus();
          }
        });
      });
      mobileList.querySelectorAll('[data-dismiss-note]').forEach((btn) => {
        btn.addEventListener('click', (evt) => {
          evt.stopPropagation();
          window.PlatformNotifications?.dismiss(orgId(), btn.dataset.dismissNote, { branchId: branchId(), reload: true }).catch(() => null);
        });
      });
    }
  }

  async function bind(){
    if (!(await topbarEnabled())) {
      setTopbarVisible(false);
      return;
    }
    setTopbarVisible(true);
    document.querySelectorAll('[data-platform-search-input]').forEach((search) => {
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(search).catch(() => null), 120);
      });
      search.addEventListener('focus', () => {
        if (cleanText(search.value)) runSearch(search).catch(() => null);
      });
      search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          search.value = '';
          closeSearchResults();
        }
      });
    });
    document.addEventListener('click', (event) => {
      if (!event.target.closest('.platform-search')) closeSearchResults();
      if (!event.target.closest('.platform-notifications')) closeNotificationMenus();
    });
    [
      { bell: '#platformBell', menu: '#platformNotificationMenu' },
      { bell: '#mobilePlatformBell', menu: '#mobilePlatformNotificationMenu' }
    ].forEach(({ bell, menu }) => {
      $(bell)?.addEventListener('click', async (event) => {
        event.stopPropagation();
        await window.PlatformNotifications?.load(orgId(), { branchId: branchId() }).catch(() => null);
        const targetMenu = $(menu);
        const opening = !targetMenu?.classList.contains('visible');
        closeNotificationMenus();
        targetMenu?.classList.toggle('visible', opening);
        document.body.classList.toggle('mobile-notifications-open', opening && menu === '#mobilePlatformNotificationMenu');
      });
    });
    window.PlatformNotifications?.subscribe(renderNotifications);
    window.PlatformNotifications?.load(orgId(), { branchId: branchId() }).catch(() => null);
    if (!notificationTimer) {
      notificationTimer = setInterval(() => window.PlatformNotifications?.load(orgId(), { branchId: branchId() }).catch(() => null), 60000);
    }
  }

  document.addEventListener('DOMContentLoaded', () => bind().catch(() => setTopbarVisible(true)));
  window.addEventListener('fm:app-flags:updated', () => {
    topbarEnabled()
      .then((enabled) => setTopbarVisible(enabled))
      .catch(() => setTopbarVisible(true));
  });
})();
