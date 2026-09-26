/* public/libraries/apps/contacts/app.js
 * My Contacts portal tab.
 */
(function(){
  const Portal = window.Portal || {};
  const util = Portal.util || {};
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const showToast = Portal.ui?.showToast || (() => {});

  const TILE_PROJECT_LIMIT = 6;
  const LS_VIEW_KEY = 'fm_contacts_view_v2';
  const LS_SORT_KEY = 'fm_contacts_sort_v1';
  const initialRoute = Portal.navigation?.read?.() || {};
  const state = {
    root: null,
    workspace: ['import','settings'].includes(initialRoute.contactsWorkspace) ? initialRoute.contactsWorkspace : 'list',
    settingsHandle: null,
    projects: [],
    contacts: [],
    query: '',
    view: localStorage.getItem(LS_VIEW_KEY) === 'tiles' ? 'tiles' : 'list',
    sort: localStorage.getItem(LS_SORT_KEY) || 'name',
    loading: false,
    loadedAt: 0,
    error: ''
  };

  function cleanText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function objectValue(source, ...keys){
    if (!source || typeof source !== 'object' || Array.isArray(source)) return '';
    for (const key of keys) {
      const text = cleanText(source[key]);
      if (text) return text;
    }
    return '';
  }

  function orgId(){
    return cleanText(Portal.cfg?.userOrgId, Portal.cfg?.orgId, window.__APP?.userOrgId, window.__APP?.orgId);
  }

  function projectFromDocument(document){
    const data = document?.data && typeof document.data === 'object' ? document.data : null;
    if (!data) return null;
    const documentId = cleanText(document.id);
    const id = cleanText(data.platform_project_id, data.base_project_id, data.id, documentId);
    const title = cleanText(data.title, data.project_title, data.project_name, data.projectName, data.name);
    return {
      ...data,
      id,
      platform_project_id: cleanText(data.platform_project_id, id),
      base_project_id: cleanText(data.base_project_id, id),
      title: title || cleanText(data.address, id),
      project_title: cleanText(data.project_title, title),
      contacts: Array.isArray(data.contacts) ? data.contacts : [],
      events: Array.isArray(data.events) ? data.events : []
    };
  }

  function projectId(project = {}){
    return cleanText(project.platform_project_id, project.base_project_id, project.id);
  }

  function projectTitle(project = {}){
    return cleanText(project.title, project.project_title, project.project_name, project.projectName, project.name, project.address, 'Project');
  }

  function projectAddress(project = {}){
    const address = cleanText(project.address, project.customer_address, project.primary_contact_address);
    if (address) return address;
    const parts = [
      project.street,
      project.city,
      project.state,
      project.zip || project.postal_code
    ].map(cleanText).filter(Boolean);
    return parts.join(', ');
  }

  function normalizeKey(value){
    return cleanText(value).toLowerCase().replace(/\s+/g, ' ');
  }

  function phoneDigits(value){
    return cleanText(value).replace(/[^\d]/g, '');
  }

  function contactKey(contact = {}){
    const email = normalizeKey(contact.email);
    if (email) return `email:${email}`;
    const digits = phoneDigits(contact.phone);
    if (digits.length >= 7) return `phone:${digits}`;
    const id = cleanText(contact.id, contact.contact_id, contact.primary_contact_id);
    if (id) return `id:${id}`;
    const name = normalizeKey(contact.name);
    return name ? `name:${name}` : '';
  }

  function contactHasInfo(contact = {}){
    return !!cleanText(contact.name, contact.email, contact.phone);
  }

  function contactCandidates(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const candidates = contacts
      .filter((contact) => contact && typeof contact === 'object')
      .map((contact) => ({
        id: cleanText(contact.id, contact.contact_id),
        contact_id: cleanText(contact.contact_id, contact.id),
        name: cleanText(contact.name, contact.full_name, contact.display_name),
        email: cleanText(contact.email, contact.email_address),
        phone: cleanText(contact.phone, contact.phone_number, contact.mobile),
        address: cleanText(contact.address, contact.default_address),
        tags: Array.isArray(contact.tags) ? contact.tags.map((tag) => cleanText(tag)).filter(Boolean) : [],
        imported_at: cleanText(contact.imported_at),
        import_source: cleanText(contact.import_source)
      }));
    candidates.push({
      id: cleanText(project.contact_id, project.primary_contact_id, customer.id, resident.id),
      contact_id: cleanText(project.contact_id, project.primary_contact_id, customer.id, resident.id),
      name: cleanText(
        project.customer_name,
        project.customerName,
        project.primary_contact_name,
        project.resident_name,
        project.residentName,
        typeof project.resident === 'string' ? project.resident : '',
        objectValue(customer, 'name', 'full_name', 'display_name'),
        objectValue(resident, 'name', 'full_name', 'display_name')
      ),
      email: cleanText(
        project.customer_email,
        project.customerEmail,
        project.primary_contact_email,
        project.resident_email,
        project.residentEmail,
        objectValue(customer, 'email', 'email_address'),
        objectValue(resident, 'email', 'email_address')
      ),
      phone: cleanText(
        project.customer_phone,
        project.customerPhone,
        project.primary_contact_phone,
        project.resident_phone,
        project.residentPhone,
        objectValue(customer, 'phone', 'phone_number', 'mobile'),
        objectValue(resident, 'phone', 'phone_number', 'mobile')
      ),
      address: cleanText(project.contact_address, project.customer_address, project.primary_contact_address, objectValue(customer, 'address'), objectValue(resident, 'address'))
    });

    const seen = new Set();
    return candidates.filter(contactHasInfo).filter((contact) => {
      const key = contactKey(contact);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseDate(...values){
    const text = cleanText(...values);
    if (!text) return null;
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function projectDate(project = {}){
    return parseDate(
      project.updated_at,
      project.completed_at,
      project.created_at,
      project.appointment_at,
      project.scheduled_at,
      project.measurement?.submitted_at,
      project.measurement_project?.submitted_at
    ) || new Date(0);
  }

  function dateLabel(date){
    if (!(date instanceof Date) || !Number.isFinite(date.getTime()) || date.getTime() === 0) return 'No date';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function stageLabel(project = {}){
    const projection = project.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    const active = Array.isArray(projection.active_instances)
      ? projection.active_instances
      : (Array.isArray(projection.instances) ? projection.instances.filter((instance) => instance && (instance.status === 'active' || instance.status === 'pending')) : []);
    const primary = active.find((instance) => instance?.kind === 'pipeline') || active[0] || null;
    const label = cleanText(primary?.stage_title, primary?.title);
    if (label) return label;
    const lifecycle = projection.lifecycle && typeof projection.lifecycle === 'object'
      ? projection.lifecycle
      : (project.lifecycle && typeof project.lifecycle === 'object' ? project.lifecycle : {});
    const status = cleanText(lifecycle.status).toLowerCase();
    if (status === 'lost') return 'Lost';
    if (status === 'completed') return 'Completed';
    if (status === 'canceled' || status === 'cancelled') return 'Cancelled';
    return 'No stage';
  }

  function projectSummary(project = {}){
    const date = projectDate(project);
    return {
      id: projectId(project),
      title: projectTitle(project),
      address: projectAddress(project),
      stage: stageLabel(project),
      date,
      dateMs: date.getTime(),
      dateLabel: dateLabel(date),
      project
    };
  }

  function mergeContact(target, source){
    if (!target.name || source.name.length > target.name.length) target.name = source.name || target.name;
    if (!target.email) target.email = source.email || '';
    if (!target.phone) target.phone = source.phone || '';
    if (!target.address) target.address = source.address || '';
    if (!target.id) target.id = cleanText(source.id, source.contact_id);
    (Array.isArray(source.tags) ? source.tags : []).forEach((tag) => {
      if (!target.tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) target.tags.push(tag);
    });
    if (!target.imported_at) target.imported_at = cleanText(source.imported_at);
    if (!target.import_source) target.import_source = cleanText(source.import_source);
  }

  function buildContacts(projects = []){
    const byKey = new Map();
    projects.forEach((project) => {
      const projectRef = projectSummary(project);
      const perProjectKeys = new Set();
      contactCandidates(project).forEach((candidate) => {
        const key = contactKey(candidate);
        if (!key || perProjectKeys.has(key)) return;
        perProjectKeys.add(key);
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            id: cleanText(candidate.id, candidate.contact_id),
            name: cleanText(candidate.name, candidate.email, candidate.phone, 'Unknown contact'),
            email: cleanText(candidate.email),
            phone: cleanText(candidate.phone),
            address: cleanText(candidate.address),
            tags: [],
            imported_at: '',
            import_source: '',
            projects: [],
            projectIds: new Set(),
            latestDateMs: 0
          });
        }
        const record = byKey.get(key);
        mergeContact(record, candidate);
        if (!record.projectIds.has(projectRef.id)) {
          record.projectIds.add(projectRef.id);
          record.projects.push(projectRef);
          record.latestDateMs = Math.max(record.latestDateMs, projectRef.dateMs || 0);
        }
      });
    });
    return Array.from(byKey.values()).map((contact) => {
      contact.projects.sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0) || a.title.localeCompare(b.title));
      contact.projectCount = contact.projects.length;
      contact.latestDateLabel = dateLabel(new Date(contact.latestDateMs || 0));
      contact.searchText = [
        contact.name,
        contact.email,
        contact.phone,
        contact.address,
        ...contact.tags,
        ...contact.projects.flatMap((project) => [project.title, project.address, project.stage])
      ].join(' ').toLowerCase();
      return contact;
    });
  }

  function sortedFilteredContacts(){
    const query = normalizeKey(state.query);
    const filtered = state.contacts.filter((contact) => !query || contact.searchText.includes(query));
    if (state.sort === 'recent') {
      filtered.sort((a, b) => (b.latestDateMs || 0) - (a.latestDateMs || 0) || a.name.localeCompare(b.name));
    } else if (state.sort === 'projects') {
      filtered.sort((a, b) => (b.projectCount || 0) - (a.projectCount || 0) || a.name.localeCompare(b.name));
    } else {
      filtered.sort((a, b) => a.name.localeCompare(b.name) || (b.latestDateMs || 0) - (a.latestDateMs || 0));
    }
    return filtered;
  }

  function contactAvatar(contact = {}){
    const letter = cleanText(contact.name, contact.email, contact.phone).charAt(0).toUpperCase() || '?';
    return `<span class="ct-avatar">${escapeHtml(letter)}</span>`;
  }

  function projectRows(contact, limit = TILE_PROJECT_LIMIT){
    const usesOverflowSlot = contact.projects.length > limit;
    const visibleLimit = usesOverflowSlot ? Math.max(0, limit - 1) : limit;
    const visible = contact.projects.slice(0, visibleLimit);
    const more = Math.max(0, contact.projects.length - visible.length);
    const slots = [
      ...visible.map((project) => ({ type: 'project', project })),
      ...(more ? [{ type: 'more', more }] : [])
    ];
    while (slots.length < limit) slots.push({ type: 'empty' });
    return `
      <div class="ct-project-list">
        ${slots.map((slot) => {
          if (slot.type === 'more') {
            return `
              <div class="ct-project-slot ct-more">
                <strong>${((v0) => globalThis.PlatformLanguage?.htmlText("contacts","m_bdd2018a2c9640",`... ${v0} more`,{v0}) ?? `... ${v0} more`)(escapeHtml(String(slot.more)))}</strong>
                <small>${((v1) => globalThis.PlatformLanguage?.htmlText("contacts","m_1ef3679187884e",`${v1} total projects`,{v1}) ?? `${v1} total projects`)(escapeHtml(String(contact.projectCount)))}</small>
              </div>
            `;
          }
          if (slot.type === 'empty') return '<div class="ct-project-slot empty" aria-hidden="true"></div>';
          const project = slot.project;
          return `
            <button type="button" class="ct-project-row ct-project-slot" data-ct-project="${escapeHtml(project.id)}" data-fm-tooltip="Open project">
              <span class="ct-project-main">
                <span>${escapeHtml(project.title)}</span>
                <small>${escapeHtml(project.address || project.stage)}</small>
              </span>
              <span class="ct-project-meta">${escapeHtml(project.dateLabel)}</span>
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  function tagChips(contact = {}, limit = 4){
    const tags = Array.isArray(contact.tags) ? contact.tags : [];
    if (!tags.length) return '';
    const visible = tags.slice(0, limit);
    const more = tags.length - visible.length;
    return `
      <div class="ct-tags">
        ${visible.map((tag) => `<span class="ct-tag">${escapeHtml(tag)}</span>`).join('')}
        ${more > 0 ? `<span class="ct-tag ct-tag-more">+${escapeHtml(String(more))}</span>` : ''}
      </div>
    `;
  }

  function contactLine(contact = {}){
    const items = [
      contact.email ? `<a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>` : '',
      contact.phone ? `<a href="tel:${escapeHtml(phoneDigits(contact.phone))}">${escapeHtml(contact.phone)}</a>` : ''
    ].filter(Boolean);
    return items.length ? items.join('<span class="ct-dot"></span>') : `<span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_c0b046415d9560","No email or phone") ?? "No email or phone")}</span>`;
  }

  function renderTile(contact){
    return `
      <article class="ct-card" data-ct-contact="${String(escapeHtml(contact.key))}">
        <div class="ct-card-head">
          ${String(contactAvatar(contact))}
          <div class="ct-contact-title">
            <h3>${String(escapeHtml(contact.name))}</h3>
            <div class="ct-contact-line">${String(contactLine(contact))}</div>
          </div>
          <button type="button" class="ct-open-contact" data-ct-open-contact="${String(escapeHtml(contact.key))}" data-fm-tooltip="Open contact">
            <i class="fas fa-address-card"></i>
          </button>
        </div>
        <div class="ct-card-meta">
          <span><i class="fas fa-folder-open"></i>${((v5,v6) => globalThis.PlatformLanguage?.htmlText("contacts","m_b51be3af96e69d",`${v5} project${v6}`,{v5,v6}) ?? `${v5} project${v6}`)(escapeHtml(String(contact.projectCount)),contact.projectCount === 1 ? '' : 's')}</span>
          <span>${String(escapeHtml(contact.latestDateLabel))}</span>
        </div>
        ${String(tagChips(contact))}
        ${String(projectRows(contact))}
      </article>
    `;
  }

  function renderListRow(contact){
    const projects = contact.projects.slice(0, 3);
    const more = Math.max(0, contact.projects.length - projects.length);
    return `
      <div class="ct-table-row" data-ct-contact="${escapeHtml(contact.key)}">
        <button type="button" class="ct-list-contact" data-ct-open-contact="${escapeHtml(contact.key)}">
          ${contactAvatar(contact)}
          <span>
            <strong>${escapeHtml(contact.name)}</strong>
            <small>${contactLine(contact)}</small>
            ${tagChips(contact, 3)}
          </span>
        </button>
        <div class="ct-list-projects">
          ${projects.map((project) => `
            <button type="button" class="ct-chip" data-ct-project="${escapeHtml(project.id)}">
              <span>${escapeHtml(project.title)}</span>
              <small>${escapeHtml(project.address || project.stage)}</small>
            </button>
          `).join('')}
          ${more ? `<span class="ct-chip-more">${((v0) => globalThis.PlatformLanguage?.htmlText("contacts","m_bdd2018a2c9640",`... ${v0} more`,{v0}) ?? `... ${v0} more`)(escapeHtml(String(more)))}</span>` : ''}
        </div>
        <div class="ct-list-count">${escapeHtml(String(contact.projectCount))}</div>
        <div class="ct-list-date">${escapeHtml(contact.latestDateLabel)}</div>
      </div>
    `;
  }

  function renderResults(){
    const root = state.root?.querySelector('[data-ct-results]');
    if (!root) return;
    if (state.loading) {
      root.innerHTML = `<div class="ct-state"><i class="fas fa-circle-notch fa-spin"></i><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_88be2693eb38c7","Loading contacts...") ?? "Loading contacts...")}</span></div>`;
      return;
    }
    if (state.error) {
      root.innerHTML = `<div class="ct-state error"><i class="fas fa-triangle-exclamation"></i><span>${escapeHtml(state.error)}</span></div>`;
      return;
    }
    const contacts = sortedFilteredContacts();
    if (!contacts.length) {
      root.innerHTML = `<div class="ct-state"><i class="fas fa-address-book"></i><span>${state.query ? 'No contacts match this search.' : 'No contacts found yet.'}</span></div>`;
      return;
    }
    root.innerHTML = state.view === 'list'
      ? `
        <div class="ct-table">
          <div class="ct-table-head">
            <span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_46c8aea84388c3","Contact") ?? "Contact")}</span><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_19156e80fc8a6e","Projects") ?? "Projects")}</span><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_0e8e453211814c","Count") ?? "Count")}</span><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_125610f2e7ebc8","Latest") ?? "Latest")}</span>
          </div>
          ${String(contacts.map(renderListRow).join(''))}
        </div>
      `
      : `<div class="ct-grid">${contacts.map(renderTile).join('')}</div>`;
    bindResultActions(root);
  }

  function render(){
    if (!state.root) return;
    if (state.settingsHandle?.destroy) state.settingsHandle.destroy();
    state.settingsHandle = null;
    if (state.workspace !== 'list') {
      const isImport = state.workspace === 'import';
      state.root.innerHTML = `
        <div class="ct-shell">
          <header class="ct-workspace-head">
            <button class="ct-back" type="button" data-ct-workspace-back><i class="fas fa-arrow-left"></i><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_41f0654d7535f1","Back to contacts") ?? "Back to contacts")}</span></button>
            <div><h2>${String(isImport ? 'Import contacts' : 'Contact settings')}</h2><p>${String(isImport ? 'Bring contacts into FirstMate without leaving your contact list.' : 'Manage contact imports and review their history.')}</p></div>
          </header>
          <main class="ct-body ct-workspace-body"><div data-ct-settings-host></div></main>
        </div>`;
      state.root.querySelector('[data-ct-workspace-back]')?.addEventListener('click', closeWorkspace);
      const host = state.root.querySelector('[data-ct-settings-host]');
      if (!window.FirstMateContactsSettings?.mount) {
        host.innerHTML = `<div class="ct-state error"><i class="fas fa-triangle-exclamation"></i><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_015c3ba3975f3f","Contact tools could not be loaded.") ?? "Contact tools could not be loaded.")}</span></div>`;
        return;
      }
      state.settingsHandle = window.FirstMateContactsSettings.mount(host, {
        orgId:orgId(),
        showToast,
        routeScope:'contacts',
        workspace:state.workspace,
        initialSubtab:isImport ? 'import' : 'history',
        instanceId:'contacts-tab'
      }) || null;
      return;
    }
    const visibleCount = sortedFilteredContacts().length;
    state.root.innerHTML = `
      <div class="ct-shell">
        <header class="ct-top">
          <div class="ct-title">
            <h2>${(globalThis.PlatformLanguage?.htmlText("contacts","m_2bf043c3cce511","My Contacts") ?? "My Contacts")}</h2>
            <span>${((v0,v1,v2,v3) => globalThis.PlatformLanguage?.htmlText("contacts","m_afe03e23d17afb",`${v0} contact${v1} from ${v2} project${v3}`,{v0,v1,v2,v3}) ?? `${v0} contact${v1} from ${v2} project${v3}`)(escapeHtml(String(visibleCount)),visibleCount === 1 ? '' : 's',escapeHtml(String(state.projects.length)),state.projects.length === 1 ? '' : 's')}</span>
          </div>
          <div class="ct-tools">
            <label class="ct-search">
              <i class="fas fa-search"></i>
              <input id="ctSearch" type="search" value="${String(escapeHtml(state.query))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("contacts","m_978eee3aa943f8","Search contacts or projects") ?? "Search contacts or projects")}">
              ${String(state.query ? `<button id="ctClearSearch" type="button" class="ct-clear" data-fm-tooltip="Clear search"><i class="fas fa-xmark"></i></button>` : '')}
            </label>
            <select id="ctSort" class="ct-select" aria-label="${(globalThis.PlatformLanguage?.htmlText("contacts","m_05b258030f62ea","Sort contacts") ?? "Sort contacts")}">
              <option value="name" ${String(state.sort === 'name' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("contacts","m_8cf345002184e5","Name") ?? "Name")}</option>
              <option value="recent" ${String(state.sort === 'recent' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("contacts","m_fec172c2f71d24","Recent") ?? "Recent")}</option>
              <option value="projects" ${String(state.sort === 'projects' ? 'selected' : '')}>${(globalThis.PlatformLanguage?.htmlText("contacts","m_6e3f0973d60412","Project count") ?? "Project count")}</option>
            </select>
            <div class="ct-segment" aria-label="${(globalThis.PlatformLanguage?.htmlText("contacts","m_0a1d4f60d2434b","View mode") ?? "View mode")}">
              <button id="ctViewTiles" type="button" class="${String(state.view === 'tiles' ? 'active' : '')}" data-fm-tooltip="Tile view"><i class="fas fa-grip"></i></button>
              <button id="ctViewList" type="button" class="${String(state.view === 'list' ? 'active' : '')}" data-fm-tooltip="List view"><i class="fas fa-list"></i></button>
            </div>
            <button type="button" class="ct-action" data-ct-open-import><i class="fas fa-file-import"></i><span>${(globalThis.PlatformLanguage?.htmlText("contacts","m_f1f14ba348face","Import") ?? "Import")}</span></button>
            <button id="ctRefresh" type="button" class="ct-icon" data-fm-tooltip="Refresh"><i class="fas fa-rotate-right"></i></button>
          </div>
        </header>
        <main class="ct-body" data-ct-results></main>
      </div>
    `;
    bindChrome();
    renderResults();
  }

  function bindChrome(){
    const search = state.root?.querySelector('#ctSearch');
    search?.addEventListener('input', (event) => {
      state.query = event.target.value || '';
      render();
      const next = state.root?.querySelector('#ctSearch');
      next?.focus();
      try { next?.setSelectionRange(state.query.length, state.query.length); } catch (error) {}
    });
    state.root?.querySelector('#ctSort')?.addEventListener('change', (event) => {
      state.sort = event.target.value || 'name';
      localStorage.setItem(LS_SORT_KEY, state.sort);
      render();
    });
    state.root?.querySelector('#ctClearSearch')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.query = '';
      render();
      state.root?.querySelector('#ctSearch')?.focus();
    });
    state.root?.querySelector('#ctViewTiles')?.addEventListener('click', () => setView('tiles'));
    state.root?.querySelector('#ctViewList')?.addEventListener('click', () => setView('list'));
    state.root?.querySelector('[data-ct-open-import]')?.addEventListener('click', () => setWorkspace('import'));
    state.root?.querySelector('#ctRefresh')?.addEventListener('click', () => loadData({ force: true }));
  }

  function setWorkspace(workspace, options = {}){
    const next = ['import','settings'].includes(workspace) ? workspace : 'list';
    if (next === state.workspace) return;
    state.workspace = next;
    render();
    if (options.updateRoute !== false && !window.Portal?.navigation?.applying) {
      window.Portal?.navigation?.push?.({
        tab:'contacts',
        contactsWorkspace:next === 'list' ? null : next,
        contactsSettingsView:next === 'import' ? 'import' : next === 'settings' ? 'history' : null
      }, { source:'contacts-workspace', ownedKeys:['contactsWorkspace','contactsSettingsView'] });
    }
  }

  function closeWorkspace(){
    if (window.Portal?.navigation?.backOrClose) {
      window.Portal.navigation.backOrClose(
        ['contactsWorkspace'],
        { contactsWorkspace:null, contactsSettingsView:null },
        { source:'contacts-workspace-close' }
      );
      return;
    }
    setWorkspace('list', { updateRoute:false });
  }

  function bindResultActions(root){
    root.querySelectorAll('[data-ct-open-contact]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openContact(button.dataset.ctOpenContact || '');
      });
    });
    root.querySelectorAll('[data-ct-project]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openProjectById(button.dataset.ctProject || '');
      });
    });
  }

  function setView(view){
    state.view = view === 'list' ? 'list' : 'tiles';
    localStorage.setItem(LS_VIEW_KEY, state.view);
    if (!window.Portal?.navigation?.applying) window.Portal?.navigation?.replace?.({ contactView:state.view }, { source:'contacts-view', ownedKeys:['contactView'] });
    render();
  }

  function contactByKey(key){
    return state.contacts.find((contact) => contact.key === key) || null;
  }

  function projectById(id){
    const key = cleanText(id);
    if (!key) return null;
    return state.projects.find((project) => projectId(project) === key) || null;
  }

  function openContact(key, options = {}){
    const contact = contactByKey(key) || state.contacts.find((entry) => cleanText(entry.id) === cleanText(key));
    if (!contact) return;
    const modalContact = {
      id: contact.id,
      contact_id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      address: contact.address,
      tags: Array.isArray(contact.tags) ? [...contact.tags] : [],
      imported_at: contact.imported_at || '',
      import_source: contact.import_source || ''
    };
    const projects = contact.projects.map((entry) => entry.project).filter(Boolean);
    if (Portal.modules?.contacts?.open) {
      Portal.modules.contacts.open(modalContact, { projects, projectsComplete: true, ...options });
      return;
    }
    showToast((globalThis.PlatformLanguage?.text("contacts","m_13f30a7658f842","Contact unavailable") ?? "Contact unavailable"), (globalThis.PlatformLanguage?.text("contacts","m_718ab1c0aa9b50","Contact details are still loading.") ?? "Contact details are still loading."), false);
  }

  function openProjectById(id){
    const project = projectById(id);
    if (!project) return;
    if (Portal.modules?.request?.openProject) {
      Portal.modules.request.openProject(project);
      return;
    }
    if (Portal.modules?.viewer?.openProject) {
      Portal.modules.viewer.openProject(project);
      return;
    }
    window.dispatchEvent(new CustomEvent('fm:projects:open', { detail: { project } }));
  }

  async function loadData(options = {}){
    const force = options.force === true;
    if (state.loading) return;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < 30000) {
      render();
      return;
    }
    const oid = orgId();
    if (!oid || !window.PlatformAPI?.projects?.list) {
      state.projects = [];
      state.contacts = [];
      state.error = 'Project data is not available yet.';
      render();
      return;
    }
    state.loading = true;
    state.error = '';
    render();
    try {
      const result = await window.PlatformAPI.projects.list(oid);
      const docs = Array.isArray(result?.documents) ? result.documents : [];
      state.projects = docs.map(projectFromDocument).filter(Boolean);
      state.contacts = buildContacts(state.projects);
      state.loadedAt = Date.now();
    } catch (error) {
      console.warn('My Contacts load failed', error);
      state.error = error?.message || 'Could not load contacts.';
      state.projects = [];
      state.contacts = [];
    } finally {
      state.loading = false;
      render();
      restoreContactRoute();
    }
  }

  function restoreContactRoute(){
    const route = window.Portal?.navigation?.read?.() || window.Portal?.routeState?.get?.() || {};
    const routedView = route.contactView === 'tiles' ? 'tiles' : route.contactView === 'list' ? 'list' : '';
    if (routedView && routedView !== state.view) { state.view = routedView; localStorage.setItem(LS_VIEW_KEY, state.view); render(); }
    const contactId = cleanText(route.contact);
    if (!contactId) {
      if (window.Portal?.modules?.contacts && document.getElementById('fmContactOverlay')?.classList.contains('active')) {
        window.Portal.modules.contacts.close({ fromRoute:true });
      }
      return;
    }
    const match = state.contacts.find((entry) => entry.key === contactId || cleanText(entry.id) === contactId);
    if (match && !document.getElementById('fmContactOverlay')?.classList.contains('active')) openContact(match.key, { fromRoute:true });
  }

  function injectCss(){
    const css = `
      .ct-shell{height:100%;min-height:0;display:flex;flex-direction:column;background:#f6f7f9;color:#101828}
      .ct-top{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 22px;border-bottom:1px solid #e5e7eb;background:#fbfcfd}
      .ct-title{min-width:0;display:grid;gap:3px}
      .ct-title h2{margin:0;color:#101828;font-size:18px;font-weight:1000;letter-spacing:0;line-height:1.2}
      .ct-title span{font-size:12px;font-weight:850;color:#667085;white-space:nowrap}
      .ct-tools{display:flex;align-items:center;gap:9px;min-width:0}
      .ct-search{height:36px;min-width:270px;max-width:420px;display:flex;align-items:center;gap:8px;padding:0 11px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#667085}
      .ct-search:focus-within{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.10)}
      .ct-search input{border:0;outline:0;background:transparent;color:#101828;font:inherit;font-size:13px;font-weight:850;width:100%;min-width:0}
      .ct-clear{appearance:none;border:0;background:transparent;color:#98a2b3;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;cursor:pointer;flex:0 0 auto}
      .ct-clear:hover{background:#f2f4f7;color:#344054}
      .ct-select{height:36px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:13px;font-weight:900;padding:0 10px}
      .ct-segment{height:36px;display:flex;border:1px solid #d0d5dd;border-radius:8px;background:#fff;overflow:hidden}
      .ct-segment button,.ct-icon,.ct-open-contact{appearance:none;border:0;background:#fff;color:#475467;display:grid;place-items:center;cursor:pointer}
      .ct-segment button{width:37px;border-right:1px solid #eaecf0}
      .ct-segment button:last-child{border-right:0}
      .ct-segment button.active{background:#111827;color:#fff}
      .ct-action{height:36px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;padding:0 11px;display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:11px;font-weight:950;cursor:pointer}.ct-action:hover{border-color:rgba(var(--primary-rgb,217,48,37),.3);color:var(--primary-readable,var(--primary,#d93025))}
      .ct-icon{width:36px;height:36px;border:1px solid #d0d5dd;border-radius:8px}
      .ct-icon:hover,.ct-open-contact:hover,.ct-project-row:hover,.ct-chip:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);color:var(--primary-readable,var(--primary,#d93025))}
      .ct-body{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 22px}
      .ct-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;align-items:start}
      .ct-card{border:1px solid #e5e7eb;border-radius:8px;background:#fff;box-shadow:0 8px 22px rgba(15,23,42,.045);padding:12px;display:flex;flex-direction:column;gap:11px;min-width:0}
      .ct-card:hover{border-color:#d0d5dd;box-shadow:0 12px 28px rgba(15,23,42,.07)}
      .ct-card-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
      .ct-avatar{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;flex:0 0 auto;background:#eef2f7;color:#182230;font-size:14px;font-weight:1000}
      .ct-contact-title{min-width:0;display:grid;gap:3px;flex:1}
      .ct-contact-title h3{margin:0;color:#101828;font-size:14px;font-weight:1000;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-contact-line{font-size:12px;font-weight:800;color:#667085;display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden}
      .ct-contact-line a{color:#475467;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-contact-line a:hover{text-decoration:underline}
      .ct-dot{width:3px;height:3px;border-radius:50%;background:#cbd5e1;flex:0 0 auto}
      .ct-open-contact{width:32px;height:32px;border:1px solid #e5e7eb;border-radius:8px;flex:0 0 auto}
      .ct-card-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#667085;font-size:11px;font-weight:900}
      .ct-card-meta span{display:inline-flex;align-items:center;gap:6px;min-width:0}
      .ct-project-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:64px;gap:6px;min-width:0}
      .ct-project-slot{min-width:0;min-height:0;border:1px solid #eef2f7;border-radius:8px;background:#f8fafc;padding:7px 8px}
      .ct-project-slot.empty{background:linear-gradient(180deg,#fbfcfd,#f8fafc);border-style:dashed;opacity:.65}
      .ct-project-row{appearance:none;width:100%;color:#344054;display:flex;flex-direction:column;align-items:stretch;justify-content:space-between;gap:4px;text-align:left;cursor:pointer}
      .ct-project-main{min-width:0;display:grid;gap:2px}
      .ct-project-main span,.ct-chip span{font-size:12px;font-weight:1000;color:#182230;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-project-main small,.ct-chip small{font-size:11px;font-weight:800;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-project-meta{font-size:10px;font-weight:900;color:#667085;white-space:nowrap}
      .ct-more{display:flex;flex-direction:column;justify-content:center;gap:2px;color:#667085}
      .ct-more strong{font-size:12px;font-weight:1000;color:#344054}
      .ct-more small{font-size:10px;font-weight:850;color:#667085;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-chip-more{font-size:12px;font-weight:900;color:#667085;padding:2px 4px}
      .ct-tags{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
      .ct-tag{display:inline-flex;align-items:center;border:1px solid #e4e7ec;border-radius:999px;background:#f8fafc;color:#475467;font-size:10px;font-weight:900;padding:2px 8px;line-height:1.4;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-tag-more{color:#98a2b3}
      .ct-table{min-width:860px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;overflow:hidden}
      .ct-table-head,.ct-table-row{display:grid;grid-template-columns:minmax(250px,1.15fr) minmax(360px,1.8fr) 78px 118px;gap:12px;align-items:center}
      .ct-table-head{position:sticky;top:-16px;z-index:1;background:#f9fafb;border-bottom:1px solid #e5e7eb;padding:10px 12px;color:#667085;font-size:11px;font-weight:1000;text-transform:uppercase}
      .ct-table-row{padding:10px 12px;border-bottom:1px solid #f0f2f5}
      .ct-table-row:last-child{border-bottom:0}
      .ct-list-contact{appearance:none;border:0;background:transparent;padding:0;display:flex;align-items:center;gap:10px;text-align:left;min-width:0;cursor:pointer}
      .ct-list-contact span{display:grid;gap:3px;min-width:0}
      .ct-list-contact strong{font-size:13px;font-weight:1000;color:#101828;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .ct-list-contact small{font-size:12px;font-weight:800;color:#667085;display:flex;gap:7px;min-width:0;overflow:hidden}
      .ct-list-projects{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden}
      .ct-chip{appearance:none;border:1px solid #eef2f7;border-radius:8px;background:#f8fafc;padding:6px 8px;display:grid;gap:1px;min-width:0;max-width:190px;text-align:left;cursor:pointer}
      .ct-list-count,.ct-list-date{font-size:12px;font-weight:900;color:#475467}
      .ct-state{height:100%;min-height:280px;display:grid;place-items:center;align-content:center;gap:10px;color:#667085;font-size:13px;font-weight:900;text-align:center}
      .ct-state i{font-size:22px;color:#98a2b3}
      .ct-state.error{color:#b42318}
      .ct-workspace-head{flex:0 0 auto;display:flex;align-items:center;gap:16px;padding:14px 22px;border-bottom:1px solid #e5e7eb;background:#fbfcfd}.ct-workspace-head h2{margin:0;font-size:18px;font-weight:1000}.ct-workspace-head p{margin:3px 0 0;color:#667085;font-size:11px;font-weight:800}.ct-back{height:36px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;padding:0 11px;display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:11px;font-weight:950;cursor:pointer}.ct-back:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.3)}.ct-workspace-body{background:#f6f7f9}.ct-workspace-body>[data-ct-settings-host]{width:min(1120px,100%);margin:0 auto}
      @media(max-width:960px){
        .ct-top{align-items:stretch;flex-direction:column;padding:12px 16px}
        .ct-tools{flex-wrap:wrap}
        .ct-search{min-width:0;flex:1 1 240px}
        .ct-body{padding:14px 16px}
        .ct-grid{grid-template-columns:1fr}
      }
    `;
    if (util.injectCSS) util.injectCSS('contacts_tab', css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    }
  }

  function mount(root){
    state.root = root;
    injectCss();
    render();
    loadData().catch(() => null);
    return {
      destroy(){
        if (state.settingsHandle?.destroy) state.settingsHandle.destroy();
        state.settingsHandle = null;
        state.root = null;
      }
    };
  }

  let tabRegistered = false;
  let syncTimer = null;

  function appsReady(){
    return !!window.Portal?.apps?.registerPortalApp && !!window.Portal?.tabs?.renderTabs && !!document.getElementById('mainPanels');
  }

  function queueSync(delay = 0){
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncContactsTab().catch(() => null);
    }, delay);
  }

  function featureEnabled(){
    const flags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (!flags?.current?.()) return false;
    if (flags.has?.('platform', 'contacts')) return true;
    const value = flags.value?.('platform', 'contacts', undefined);
    return typeof value === 'boolean' ? value : false;
  }

  function registerContactsTab(){
    if (tabRegistered) return;
    if (!appsReady()) {
      queueSync(100);
      return;
    }
    tabRegistered = true;
    window.Portal.apps.registerPortalApp({
      id: 'portal.contacts',
      tabId: 'contacts',
      title: (globalThis.PlatformLanguage?.text("contacts","m_2bf043c3cce511","My Contacts") ?? "My Contacts"),
      icon: 'fa-address-book',
      order: 11,
      fullBleed: true,
      mount,
      onShow: () => loadData().catch(() => null)
    });
    window.Portal.tabs.renderTabs?.();
    const requestedTab = cleanText(window.__FM_INITIAL_PORTAL_TAB, window.Portal?.routeState?.get?.().tab);
    if (requestedTab === 'contacts') {
      window.setTimeout(() => window.Portal.tabs.activateTab?.('contacts'), 0);
    }
  }

  window.Portal?.navigation?.registerSchema?.('contact', { history:'push' });
  window.Portal?.navigation?.registerHandler?.('contacts-workspace', {
    priority:250,
    apply:(route) => {
      if (route.tab !== 'contacts') return;
      const next = ['import','settings'].includes(route.contactsWorkspace) ? route.contactsWorkspace : 'list';
      if (next === state.workspace) return;
      state.workspace = next;
      if (state.root) render();
    }
  });
  window.Portal?.navigation?.registerHandler?.('contact-modal', {
    priority:300,
    immediate:true,
    apply: async (route) => {
      if (!route.contact) {
        restoreContactRoute();
        return;
      }
      if (!state.loadedAt && !state.loading) await loadData();
      restoreContactRoute();
    }
  });

  function unregisterContactsTab(){
    if (!tabRegistered || !window.Portal?.apps?.unregisterPortalApp) return;
    tabRegistered = false;
    state.root = null;
    window.Portal.apps.unregisterPortalApp('contacts');
  }

  async function syncContactsTab(){
    if (!orgId()) {
      queueSync(150);
      return;
    }
    if (window.Portal?.appFlags?.load) await window.Portal.appFlags.load().catch(() => null);
    if (featureEnabled()) registerContactsTab();
    else unregisterContactsTab();
  }

  window.addEventListener('fm:platform-session:updated', () => queueSync());
  window.addEventListener('fm:app-flags:updated', () => queueSync());
  window.addEventListener('fm:projects:refresh', () => {
    state.loadedAt = 0;
    if (state.root) loadData({ force: true }).catch(() => null);
  });
  document.addEventListener('DOMContentLoaded', () => queueSync());
  queueSync();
})();
