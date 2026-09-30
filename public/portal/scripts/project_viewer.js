/* scripts/project_viewer.js
 * Shared project modal tab controller for request and viewer flows.
 */
(function(){
  if (!window.Portal) return;

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  class ProjectViewer {
    constructor({ root, tabsEl, panelSelector, tabClass = 'pv-tab', activeClass = 'active', pendingClass = 'pending', iconOnly = false, onTabChange } = {}){
      this.root = root || null;
      this.tabsEl = tabsEl || null;
      this.panelSelector = panelSelector || '';
      this.tabClass = tabClass;
      this.activeClass = activeClass;
      this.pendingClass = pendingClass;
      this.onTabChange = onTabChange;
      this.iconOnly = iconOnly === true;
      this.tabs = [];
      this.activeTab = 'map';
    }

    setTabs(tabs){
      this.tabs = (tabs || []).filter(Boolean);
      if (!this.tabs.some((tab) => tab.id === this.activeTab)) {
        this.activeTab = this.tabs[0]?.id || 'map';
      }
      this.render();
    }

    setActiveTab(tabId){
      const tab = this.tabs.find((entry) => entry.id === tabId && !entry.disabled);
      if (!tab) return;
      this.activeTab = tab.id;
      this.render();
      this.onTabChange?.(tab.id, tab);
    }

    setPresentation(options = {}){
      const nextIconOnly = options.iconOnly === true || options.tabs === 'icons' || options.tabMode === 'icons';
      if (this.iconOnly === nextIconOnly) return;
      this.iconOnly = nextIconOnly;
      this.render();
    }

    render(){
      ProjectViewer.renderTabs(this.tabsEl, this.tabs.map((tab) => ({
        ...tab,
        active: tab.id === this.activeTab
      })), {
        tabClass: this.tabClass,
        activeClass: this.activeClass,
        pendingClass: this.pendingClass,
        iconOnly: this.iconOnly,
        onTabClick: (tab) => this.setActiveTab(tab.id)
      });
      if (!this.root || !this.panelSelector) return;
      this.root.querySelectorAll?.(this.panelSelector).forEach((panel) => {
        panel.classList.toggle(this.activeClass, panel.dataset.panel === this.activeTab);
      });
    }

    static renderTabs(tabsEl, tabs, options = {}){
      if (!tabsEl) return;
      const tabClass = options.tabClass || 'pv-tab';
      const activeClass = options.activeClass || 'active';
      const pendingClass = options.pendingClass || 'pending';
      const disabledClass = options.disabledClass || '';
      const iconOnly = options.iconOnly === true;
      const items = (tabs || []).filter(Boolean);
      tabsEl.classList.toggle('single-tab', items.length <= 1);
      tabsEl.classList.toggle('icon-only', iconOnly);
      tabsEl.innerHTML = items.map((tab) => {
        const classes = [
          tabClass,
          tab.className || '',
          tab.active ? activeClass : '',
          tab.pending ? pendingClass : '',
          tab.disabled && disabledClass ? disabledClass : ''
        ].filter(Boolean).join(' ');
        const buttonId = tab.buttonId || tab.domId || tab.idAttr || '';
        const idAttr = buttonId ? ` id="${escapeHtml(buttonId)}"` : '';
        const disabledAttr = tab.disabled ? ' disabled' : '';
        const iconHtml = tab.icon ? `<i class="fas ${escapeHtml(tab.icon)}"></i> ` : '';
        const label = tab.label || tab.id;
        const badgeHtml = tab.badge ? `<span class="pv-tab-badge">${escapeHtml(tab.badge)}</span>` : '';
        const labelHtml = (iconOnly && tab.icon && !tab.badge ? '' : `<span class="pv-tab-label">${escapeHtml(label)}</span>`) + badgeHtml;
        return `<button type="button" class="${escapeHtml(classes)}"${idAttr} data-tab="${escapeHtml(tab.id)}" aria-label="${escapeHtml(tab.badge ? label + ", " + tab.badge : label)}" title="${escapeHtml(tab.badge ? label + ", " + tab.badge : label)}"${disabledAttr}>${iconHtml}${labelHtml}</button>`;
      }).join('');
      if (options.hideWhenEmpty) {
        tabsEl.style.display = items.length ? (options.display || 'flex') : 'none';
      }
      if (typeof options.onTabClick === 'function') {
        tabsEl.querySelectorAll('[data-tab]').forEach((button) => {
          button.addEventListener('click', () => {
            const tab = items.find((entry) => String(entry.id) === String(button.dataset.tab));
            if (!tab || tab.disabled) return;
            options.onTabClick(tab, button);
          });
        });
      }
    }
  }

  window.Portal.ProjectViewer = ProjectViewer;

  const STORE_KEY = 'fm_platform_project_store_v1';

  const readStore = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      return {
        projects: parsed && typeof parsed.projects === 'object' ? parsed.projects : {},
        measurementIndex: parsed && typeof parsed.measurementIndex === 'object' ? parsed.measurementIndex : {}
      };
    } catch (e) {
      return { projects: {}, measurementIndex: {} };
    }
  };

  const writeStore = (store) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1,
        projects: store.projects || {},
        measurementIndex: store.measurementIndex || {}
      }));
    } catch (e) {}
  };

  const discardedProjectIds = new Set();

  const firstText = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  };

  const isPlatformProjectId = (value) => /^(project|base)_/i.test(String(value || '').trim());

  const isGeneratedProjectTitle = (value) => {
    const text = firstText(value).toLowerCase();
    return !text || text === 'project' || text === 'new project' || /^\d+$/.test(text) || /^(project|base|platform_project)_[a-z0-9_-]+$/i.test(text);
  };

  const firstProjectDisplayText = (...values) => {
    for (const value of values) {
      const text = firstText(value);
      if (text && !isGeneratedProjectTitle(text)) return text;
    }
    return '';
  };

  const contactIdentityKey = (contact = {}) => {
    const email = firstText(contact.email).toLowerCase();
    if (email) return `email:${email}`;
    const phone = firstText(contact.phone).replace(/\D+/g, '');
    if (phone.length >= 7) return `phone:${phone}`;
    const id = firstText(contact.id, contact.contact_id);
    if (id) return `id:${id}`;
    const name = firstText(contact.name).toLowerCase();
    return name ? `name:${name}` : '';
  };

  const dedupeProjectContacts = (contacts = []) => {
    const byKey = new Map();
    const order = [];
    (Array.isArray(contacts) ? contacts : []).forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const contact = {
        id: firstText(entry.id, entry.contact_id),
        contact_id: firstText(entry.contact_id, entry.id),
        name: firstText(entry.name, entry.full_name, entry.display_name),
        email: firstText(entry.email, entry.email_address),
        phone: firstText(entry.phone, entry.phone_number, entry.mobile),
        address: firstText(entry.address, entry.default_address),
        default_address: firstText(entry.default_address, entry.address),
        role: firstText(entry.role),
        primary: entry.primary === true
      };
      if (!firstText(contact.name, contact.email, contact.phone, contact.id, contact.contact_id)) return;
      const key = contactIdentityKey(contact);
      if (!key) return;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, contact);
        order.push(key);
        return;
      }
      byKey.set(key, {
        id: firstText(existing.id, contact.id),
        contact_id: firstText(existing.contact_id, existing.id, contact.contact_id, contact.id),
        name: firstText(existing.name, contact.name),
        email: firstText(existing.email, contact.email),
        phone: firstText(existing.phone, contact.phone),
        address: firstText(existing.address, contact.address),
        default_address: firstText(existing.default_address, contact.default_address, existing.address, contact.address),
        role: firstText(existing.role, contact.role),
        primary: existing.primary === true || contact.primary === true
      });
    });
    return order.map((key) => byKey.get(key)).filter(Boolean);
  };

  const firstMeasurementText = (...values) => {
    for (const value of values) {
      const text = firstText(value);
      if (text && !isPlatformProjectId(text)) return text;
    }
    return '';
  };

  const measurementIdFromAssetUrl = (...values) => {
    for (const value of values) {
      const text = firstText(value);
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      const id = match ? firstMeasurementText(decodeURIComponent(match[1] || '')) : '';
      if (id) return id;
    }
    return '';
  };

  const parseJson = (value, fallback) => {
    try { return JSON.parse(String(value || '')); } catch (e) { return fallback; }
  };

  const hashId = (value) => {
    const input = String(value || '');
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i += 1) {
      const ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
  };

  const generatedId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const contactSemanticKey = (contact = {}) => {
    const email = firstText(contact.email).toLowerCase();
    if (email) return `email:${email}`;
    const phone = firstText(contact.phone).replace(/\D+/g, '');
    if (phone.length >= 7) return `phone:${phone}`;
    const name = firstText(contact.name).toLowerCase().replace(/\s+/g, ' ');
    return name ? `name:${name}` : '';
  };

  const mergeProjectContact = (current = {}, incoming = {}) => {
    const id = firstText(incoming.id, incoming.contact_id, current.id, current.contact_id);
    return {
      id,
      contact_id: id,
      name: firstText(incoming.name, current.name),
      email: firstText(incoming.email, current.email),
      phone: firstText(incoming.phone, current.phone),
      address: firstText(incoming.address, incoming.default_address, current.address, current.default_address),
      default_address: firstText(incoming.default_address, incoming.address, current.default_address, current.address),
      role: firstText(incoming.role, current.role),
      primary: current.primary === true || incoming.primary === true
    };
  };

  const measurementKeys = (measurement = {}) => {
    return [
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      measurement.raw?.id,
      measurement.raw?.project_id,
      measurement.raw?.project?.id,
      measurement.raw?.folder,
      measurementIdFromAssetUrl(
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        measurement.instant_url,
        measurement.instant_pdf_url,
        measurement.raw?.report_url,
        measurement.raw?.pdf_url,
        measurement.raw?.summary_url,
        measurement.raw?.xml_url,
        measurement.raw?.instant_url,
        measurement.raw?.instant_pdf_url
      )
    ].map((value) => String(value || '').trim()).filter((value) => value && !isPlatformProjectId(value));
  };

  const isProjectLike = (project = {}) => {
    if (!project || typeof project !== 'object') return false;
    if (firstText(project.address, project.id, project.project_id, project.folder)) return true;
    return measurementKeys(project.measurement || project.measurement_project || project).length > 0;
  };

  const projectPrimaryContactAlias = (project = {}) => {
    const contacts = dedupeProjectContacts(project.contacts);
    const contact = contacts.find((entry) => firstText(entry?.name, entry?.email, entry?.phone)) || {};
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    const id = firstText(contact.id, contact.contact_id, project.contact_id, project.primary_contact_id, customer.id, customer.contact_id, resident.id, resident.contact_id);
    return {
      id,
      contact_id: id,
      name: firstText(contact.name, project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === 'string' ? project.resident : '', customer.name, resident.name),
      email: firstText(contact.email, project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail, customer.email, resident.email),
      phone: firstText(contact.phone, project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone, customer.phone, resident.phone),
      address: firstText(contact.address, contact.default_address, project.contact_address, project.customer_address, project.primary_contact_address, customer.address, resident.address),
      primary: true
    };
  };

  const normalizeProjectContacts = (project = {}) => {
    const contacts = dedupeProjectContacts(project.contacts);
    const alias = projectPrimaryContactAlias(project);
    if (firstText(alias.id, alias.name, alias.email, alias.phone, alias.address)) {
      const aliasId = firstText(alias.id, alias.contact_id);
      const aliasSemantic = contactSemanticKey(alias);
      let index = contacts.findIndex((contact) => aliasId && firstText(contact.id, contact.contact_id) === aliasId);
      if (index < 0 && aliasSemantic) {
        index = contacts.findIndex((contact) => contactSemanticKey(contact) === aliasSemantic && (!firstText(contact.id, contact.contact_id) || !aliasId));
      }
      if (index < 0 && aliasId) index = contacts.findIndex((contact) => !firstText(contact.id, contact.contact_id) && contact.primary === true);
      if (index < 0 && aliasId) index = contacts.findIndex((contact) => !firstText(contact.id, contact.contact_id));
      if (index >= 0) contacts[index] = mergeProjectContact(alias, contacts[index]);
      else contacts.unshift(alias);
    }
    const merged = [];
    contacts.forEach((contact) => {
      const id = firstText(contact.id, contact.contact_id);
      const semantic = contactSemanticKey(contact);
      const index = merged.findIndex((candidate) => {
        const candidateId = firstText(candidate.id, candidate.contact_id);
        return !!(id && candidateId && id === candidateId)
          || !!(semantic && semantic === contactSemanticKey(candidate) && (!id || !candidateId));
      });
      if (index >= 0) merged[index] = mergeProjectContact(merged[index], contact);
      else merged.push(contact);
    });
    const withIds = merged.map((contact) => {
      const id = firstText(contact.id, contact.contact_id) || generatedId('contact');
      return { ...contact, id, contact_id: id };
    });
    const topLevelId = firstText(project.contact_id, project.primary_contact_id);
    let primaryIndex = withIds.findIndex((contact) => topLevelId && contact.id === topLevelId);
    if (primaryIndex < 0) primaryIndex = withIds.findIndex((contact) => contact.primary === true);
    if (primaryIndex < 0 && withIds.length) primaryIndex = 0;
    withIds.forEach((contact, index) => { contact.primary = index === primaryIndex; });
    return withIds;
  };

  const withProjectDisplayAliases = (project = {}) => {
    const contacts = normalizeProjectContacts(project);
    const contact = contacts.find((entry) => entry.primary === true) || contacts[0] || {};
    const contactId = firstText(contact.id, contact.contact_id);
    const projectTitle = firstProjectDisplayText(project.title, project.project_title, project.project_name, project.projectName, project.name, project.address, project.customer_name, project.customerName, project.primary_contact_name, contact.name);
    return {
      ...project,
      contacts,
      contact_id: contactId,
      primary_contact_id: contactId,
      contact_ids: contacts.map((entry) => firstText(entry.id, entry.contact_id)).filter(Boolean),
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project',
      customer_name: firstText(contact.name, project.customer_name, project.customerName),
      primary_contact_name: firstText(contact.name, project.primary_contact_name),
      customer_email: firstText(contact.email, project.customer_email),
      primary_contact_email: firstText(contact.email, project.primary_contact_email),
      customer_phone: firstText(contact.phone, project.customer_phone),
      primary_contact_phone: firstText(contact.phone, project.primary_contact_phone)
    };
  };

  const projectIdFromMeasurement = (measurement = {}) => {
    const key = firstMeasurementText(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      measurement.raw?.id,
      measurement.raw?.project?.id,
      measurement.raw?.folder
    );
    if (key) return `project_${hashId(`firstmeasure:${key}`)}`;
    const raw = measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : {};
    const fallback = [
      firstText(raw.address, raw.project_address, manifest.address, manifest.project_address, measurement.address, measurement.project_address),
      firstText(raw.created_at, raw.queued_at, raw.submitted_at, raw.updated_at, measurement.submitted_at),
      firstText(raw.status, measurement.status)
    ].join('|').toLowerCase();
    return fallback.replace(/\|/g, '') ? `project_${hashId(`firstmeasure-fallback:${fallback}`)}` : generatedId('project');
  };

  const canonicalProjectId = (project = {}) => {
    const platformId = firstText(project?.platform_project_id, project?.base_project_id);
    if (platformId.startsWith('project_')) return platformId;
    const existing = firstText(project?.id);
    if (existing.startsWith('project_')) return existing;
    const measurement = project?.measurement_project || project?.measurement || project;
    const keys = measurementKeys(measurement);
    if (existing.startsWith('base_') || /^[a-f0-9]{24,64}$/i.test(existing) || keys.length) {
      return projectIdFromMeasurement(measurement);
    }
    return existing || generatedId('project');
  };

  const APP = window.__APP || {};

  async function authenticatedOrgId(){
    const configured = firstText(APP.userOrgId, APP.orgId);
    if (configured) return configured.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const session = window.PlatformAPI?.auth?.me ? await window.PlatformAPI.auth.me().catch(() => null) : null;
    const resolved = firstText(
      session?.membership?.organization_id,
      session?.membership?.org_id,
      session?.session?.organization_id,
      session?.user?.organization_id
    );
    if (resolved) {
      APP.userOrgId = resolved;
      APP.orgId = resolved;
      window.__APP = APP;
      return resolved.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    }
    throw new Error('Missing authenticated organization.');
  }

  let ensureOrgPromise = null;
  async function ensureRemoteOrganization(){
    if (ensureOrgPromise) return ensureOrgPromise;
    ensureOrgPromise = (async () => {
      const orgId = await authenticatedOrgId();
      await window.PlatformAPI.orgs.get(orgId);
      return orgId;
    })().finally(() => { ensureOrgPromise = null; });
    return ensureOrgPromise;
  }

  const cacheProject = (project) => {
    const store = readStore();
    const id = canonicalProjectId(project);
    if (discardedProjectIds.has(id)) return { ...(project || {}), id };
    const measurementProject = project?.measurement_project || project?.measurement || {};
    const next = withProjectDisplayAliases({
      ...(project || {}),
      id,
      platform_project_id: firstText(project?.platform_project_id, project?.base_project_id, id),
      base_project_id: firstText(project?.base_project_id, project?.platform_project_id, id),
      measurement: project?.measurement || measurementProject,
      measurement_project: project?.measurement_project || measurementProject,
      updated_at: new Date().toISOString()
    });
    store.projects[id] = next;
    Object.keys(store.measurementIndex).forEach((key) => {
      if (store.measurementIndex[key] === id) delete store.measurementIndex[key];
    });
    measurementKeys(next.measurement_project || next.measurement || {}).forEach((key) => { store.measurementIndex[key] = id; });
    writeStore(store);
    return next;
  };

  const removeCachedProject = (projectOrId) => {
    const store = readStore();
    const id = typeof projectOrId === 'string' ? projectOrId : canonicalProjectId(projectOrId || {});
    if (!id) return false;
    discardedProjectIds.add(id);
    delete store.projects[id];
    Object.keys(store.measurementIndex || {}).forEach((key) => {
      if (store.measurementIndex[key] === id) delete store.measurementIndex[key];
    });
    writeStore(store);
    return true;
  };

  const remoteProjectFromDocument = (document) => {
    const data = document?.data && typeof document.data === 'object' ? document.data : null;
    if (!data) return null;
    const documentId = firstText(document?.id);
    const platformId = firstText(data.platform_project_id, data.base_project_id, documentId);
    const projectTitle = firstProjectDisplayText(data.title, data.project_title, data.project_name, data.projectName, data.name, data.address, data.customer_name, data.customerName, data.primary_contact_name);
    return withProjectDisplayAliases({
      ...data,
      id: platformId || firstText(data.id, documentId),
      platform_project_id: firstText(data.platform_project_id, platformId),
      base_project_id: firstText(data.base_project_id, platformId),
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project'
    });
  };

  const projectFromMeasurement = (project = {}) => {
    const manifest = project.manifest && typeof project.manifest === 'object' ? project.manifest : {};
    const projectMeasurement = project.measurement_project && typeof project.measurement_project === 'object'
      ? project.measurement_project
      : ((project.measurement && typeof project.measurement === 'object') ? project.measurement : {});
    const projectMeasurementRaw = projectMeasurement.raw && typeof projectMeasurement.raw === 'object' ? projectMeasurement.raw : {};
    const residentObj = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const contact = {
      name: firstText(typeof project.resident === 'string' ? project.resident : '', project.resident_name, project.residentName, residentObj.name),
      phone: firstText(project.resident_phone, project.residentPhone, residentObj.phone),
      email: firstText(project.resident_email, project.residentEmail, residentObj.email)
    };
    const assetMeasurementId = measurementIdFromAssetUrl(
      project.report_url,
      project.pdf_url,
      project.summary_url,
      project.xml_url,
      project.instant_url,
      project.instant_pdf_url,
      projectMeasurement.report_url,
      projectMeasurement.pdf_url,
      projectMeasurement.summary_url,
      projectMeasurement.xml_url,
      projectMeasurementRaw.report_url,
      projectMeasurementRaw.pdf_url,
      projectMeasurementRaw.summary_url,
      projectMeasurementRaw.xml_url,
      manifest.report_url,
      manifest.pdf_url,
      manifest.summary_url,
      manifest.xml_url,
      project.artifacts?.report_url,
      project.artifacts?.pdf_url,
      project.artifacts?.summary_url,
      project.artifacts?.xml_url,
      project.assets?.report_url,
      project.assets?.pdf_url,
      project.assets?.summary_url,
      project.assets?.xml_url
    );
    const measurementId = firstMeasurementText(
      project.id,
      project.project_id,
      project.folder,
      projectMeasurement.id,
      projectMeasurement.project_id,
      projectMeasurement.folder,
      projectMeasurementRaw.id,
      projectMeasurementRaw.project_id,
      projectMeasurementRaw.folder,
      assetMeasurementId
    );
    const measurement = {
      id: measurementId,
      project_id: measurementId,
      folder: firstText(project.folder, measurementId),
      status: firstText(project.status, 'queued'),
      report_mode: firstText(project.report_mode, project.instant_enabled ? 'both' : 'full'),
      measurement_system: project.measurement_system || "imperial",
      report_language: project.report_language || "en-US",
      include_gutters: project.include_gutter_measurements === true || project.include_gutter_measurements === 1 || project.include_gutter_measurements === '1',
      include_instant: !!project.instant_enabled || String(project.report_mode || '').trim().toLowerCase() === 'both',
      report_expedite_option: firstText(project.report_expedite_option),
      report_due_window_label: firstText(project.report_due_window_label),
      submitted_at: firstText(project.created_at, project.queued_at, project.submitted_at),
      raw: project
    };
      return {
        id: projectIdFromMeasurement(measurement),
        address: firstText(project.address, project.project_address, manifest.address, manifest.project_address, projectMeasurementRaw.address, projectMeasurementRaw.project_address),
        project_type: firstText(project.project_type, 'residential'),
        lat: firstText(project.lat, project.latitude),
        lng: firstText(project.lng, project.longitude),
        pins: Array.isArray(project.pins) ? project.pins : parseJson(project.pins, []),
        contacts: (contact.name || contact.phone || contact.email) ? [contact] : [{ name: '', phone: '', email: '' }],
        project_notes: firstText(project.project_notes),
      photos: [],
      events: [],
      stage: firstText(project.stage, project.stage_id, 'contacting'),
      stage_id: firstText(project.stage, project.stage_id, 'contacting'),
      workflow_state: 'measurement_ordered',
      measurement,
      measurement_project: measurement,
      updated_at: new Date().toISOString()
    };
  };

  /* R2-EQ-5: an edit save must not revert what another session changed while
   * this window was open. Once this page has read the project from the
   * server (PlatformAPI keeps that first copy as the baseline), saves send
   * only the top-level fields that differ from it, as a PATCH the server
   * merges; saves run one at a time per project (a save requested while one
   * is in flight is coalesced into the latest copy, which carries every
   * edit) and advance the baseline only for fields that reached the server,
   * so a failed save is resent. Server-owned fields (schedule items, work
   * projection) are never written from here. Without a baseline (a
   * brand-new project) the full save stays. */
  const SERVER_OWNED_PROJECT_KEYS = new Set(['events', 'work_projection', 'lifecycle', 'claims']);
  const stableJson = (value) => JSON.stringify(value, (key, entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.keys(entry).sort().reduce((sorted, name) => { sorted[name] = entry[name]; return sorted; }, {})
      : entry
  ));
  // Representation-only differences (missing vs empty, 47.6 vs "47.6") are
  // not edits and must not be written over another session's value.
  // R4-EQ-14: values the window derives on every save (the generated
  // satellite thumbnail, a pin that is just the address point, the default
  // workflow intent, empty measurement defaults) are not edits either.
  const compactValue = (value) => {
    if (Array.isArray(value)) {
      const items = value.map(compactValue).filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    if (value && typeof value === 'object') {
      const entries = Object.keys(value).map((key) => [key, compactValue(value[key])]).filter(([, entry]) => entry !== undefined);
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    if (value === undefined || value === null || value === '' || value === false || value === 0) return undefined;
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  };
  const generatedPhoto = (photo) => !!photo && typeof photo === 'object' && (
    photo.is_top_down_thumbnail === true || photo.id === 'top_down_thumbnail' || photo.designator === 'top_down_thumbnail' || photo.source === 'google_static_map'
  );
  const coordinate = (value) => {
    const number = Number(value);
    return value === '' || value === null || value === undefined || !Number.isFinite(number) ? '' : number.toFixed(6);
  };
  const comparableProjectField = (key, value, project = {}) => {
    if (key === 'lat' || key === 'lng') return coordinate(value);
    if (key === 'workflow_intent') return value === 'project' ? '' : comparableField(value);
    if (key === 'project_type') return value === 'residential' ? '' : comparableField(value);
    // Stored photos and the window's serialized copies differ only in empty
    // or duplicated keys (mime_type "", markup {}, photo_id = id).
    const photoShape = (photo) => compactValue({ ...(photo || {}), photo_id: photo?.photo_id === photo?.id ? '' : photo?.photo_id });
    if (key === 'photos') {
      const compact = compactValue((Array.isArray(value) ? value : []).filter((photo) => !generatedPhoto(photo)).map(photoShape));
      return compact ? stableJson(compact) : '';
    }
    if (key === 'thumbnail_photo_id') return value === 'top_down_thumbnail' ? '' : comparableField(value);
    if (key === 'thumbnail_photo') {
      const compact = generatedPhoto(value) ? undefined : photoShape(value);
      return compact ? stableJson(compact) : '';
    }
    if (key === 'pins') {
      const pins = (Array.isArray(value) ? value : []).map((pin) => `${coordinate(pin?.lat)},${coordinate(pin?.lng)}`);
      const addressPoint = `${coordinate(project.lat)},${coordinate(project.lng)}`;
      return pins.length === 1 && pins[0] === addressPoint ? '' : pins.join(';');
    }
    if (key === 'measurement' || key === 'measurement_project') {
      const compact = compactValue({ ...(value && typeof value === 'object' ? value : {}), weather_report_tier: value?.weather_report_tier === 'history' ? '' : value?.weather_report_tier });
      return compact ? stableJson(compact) : '';
    }
    if (key === 'contacts') {
      const compact = compactValue((Array.isArray(value) ? value : []).map((contact) => ({ ...(contact || {}), contact_id: contact?.contact_id === contact?.id ? '' : contact?.contact_id })));
      return compact ? stableJson(compact) : '';
    }
    return comparableField(value);
  };
  const comparableField = (value) => {
    if (value === undefined || value === null || value === '') return '';
    if (Array.isArray(value) && !value.length) return '';
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return '';
    // Primitives compare by their text: 47.6 and "47.6", true and "true".
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return String(value);
    return stableJson(value);
  };
  /* R4-EQ-2: the contacts list is one top-level field, but two people may
   * edit different contacts (or different fields of one contact). Apply only
   * this window's per-contact, per-field changes (against its baseline) to
   * the server's current list instead of replacing the list wholesale. */
  const contactKey = (contact, index) => String(contact?.id || contact?.contact_id || `index:${index}`);
  const mergeContactChanges = (baseList, mineList, theirsList) => {
    const base = new Map((Array.isArray(baseList) ? baseList : []).map((contact, index) => [contactKey(contact, index), contact || {}]));
    const mine = new Map((Array.isArray(mineList) ? mineList : []).map((contact, index) => [contactKey(contact, index), contact || {}]));
    const theirs = Array.isArray(theirsList) ? theirsList : [];
    const same = (a, b) => comparableField(a) === comparableField(b);
    const merged = [];
    const seen = new Set();
    theirs.forEach((contact, index) => {
      const key = contactKey(contact, index);
      seen.add(key);
      const before = base.get(key);
      const after = mine.get(key);
      if (!before) { merged.push(contact); return; }
      // Removed here: keep it removed.
      if (!after) return;
      const next = { ...(contact || {}) };
      new Set([...Object.keys(before), ...Object.keys(after)]).forEach((field) => {
        if (!same(after[field], before[field])) next[field] = after[field];
      });
      merged.push(next);
    });
    (Array.isArray(mineList) ? mineList : []).forEach((contact, index) => {
      const key = contactKey(contact, index);
      if (seen.has(key)) return;
      const before = base.get(key);
      // Added here, or deleted elsewhere after this window changed it.
      if (!before || stableJson(compactValue(before) || {}) !== stableJson(compactValue(contact) || {})) merged.push(contact);
    });
    return merged;
  };
  const projectDeletedError = (id, cause) => {
    const error = new Error(globalThis.PlatformLanguage?.text?.('project-viewer', 'project_deleted', 'This project was deleted, so your change was not saved.') ?? 'This project was deleted, so your change was not saved.');
    error.code = 'project_deleted';
    error.deleted = true;
    error.projectId = id;
    if (cause) error.cause = cause;
    return error;
  };
  const deletedProjectIds = new Set();
  // Last "This project was deleted" toast per project: every rejected save
  // says so again, at most once every few seconds while someone types.
  const deletedProjectToasts = new Map();
  const DELETED_PROJECT_TOAST_GAP_MS = 3000;
  // The project the window shows; opening another one drops the notice.
  let shownProjectId = '';
  window.addEventListener('fm:project-modal:hydrated', (event) => {
    shownProjectId = String(event?.detail?.projectId || '').trim();
    document.querySelectorAll('.r-project-deleted-notice').forEach((notice) => {
      if (notice.dataset.projectId !== shownProjectId) notice.remove();
    });
  });
  // A lasting notice in the project window showing the deleted project, so
  // edits there are not mistaken for saved ones. Display only: nothing is
  // written or recreated.
  const showDeletedProjectNotice = (id) => {
    const overlay = document.getElementById('rOverlay');
    const pane = overlay?.querySelector('.r-right');
    if (!pane || !overlay.getClientRects().length) return;
    const shown = shownProjectId || String(window.Portal?.routeState?.get?.()?.project || '').trim();
    if (shown && id && shown !== id) return;
    if (pane.querySelector('.r-project-deleted-notice')) return;
    const notice = document.createElement('div');
    notice.className = 'r-project-deleted-notice';
    notice.setAttribute('role', 'alert');
    notice.dataset.projectId = String(id || '');
    notice.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 12px 0;padding:9px 12px;border:1px solid #fecdca;border-radius:10px;background:#fef3f2;color:#b42318;font-size:12px;font-weight:800;line-height:1.35';
    notice.innerHTML = `<i class="fas fa-triangle-exclamation" aria-hidden="true"></i><span>${escapeHtml(globalThis.PlatformLanguage?.text?.('project-viewer', 'project_deleted_notice', 'This project was deleted by someone else. Changes made here are not saved.') ?? 'This project was deleted by someone else. Changes made here are not saved.')}</span>`;
    const header = pane.querySelector('.r-modal-header');
    if (header?.parentNode === pane) header.after(notice);
    else pane.prepend(notice);
  };
  // A schedule write (project Schedule tab, calendars) found the project gone.
  window.addEventListener('fm:project:deleted', (event) => {
    const id = String(event?.detail?.projectId || '').trim();
    if (!id) return;
    deletedProjectIds.add(id);
    showDeletedProjectNotice(id);
  });
  const retryableSaveError = (error) => {
    const status = Number(error?.status || 0);
    if (error?.code === 'project_deleted') return false;
    return status === 0 || status === 409 || status >= 500;
  };
  const sendProjectPatch = async (orgId, next, metadata, baseline) => {
    const id = next.id;
    const projects = window.PlatformAPI.projects;
    const changed = {};
    Object.keys(next).forEach((key) => {
      if (SERVER_OWNED_PROJECT_KEYS.has(key)) return;
      if (comparableProjectField(key, next[key], next) !== comparableProjectField(key, baseline.data[key], baseline.data)) changed[key] = next[key];
    });
    // A moved address point moves its pin too.
    if ((changed.lat !== undefined || changed.lng !== undefined) && Array.isArray(next.pins) && next.pins.length) changed.pins = next.pins;
    // Nothing but the save stamp differs: no write (it would only bump the
    // revision other windows' saves are checked against).
    if (!Object.keys(changed).some((key) => key !== 'updated_at')) return { ok: true, document: null, unchanged: true };
    const sent = { ...changed };
    if (Object.prototype.hasOwnProperty.call(changed, 'contacts') && typeof projects.get === 'function') {
      const latest = await projects.get(orgId, id);
      if (latest?.missing || !latest?.document) throw projectDeletedError(id);
      changed.contacts = mergeContactChanges(baseline.data.contacts, next.contacts, latest.document.data?.contacts);
    }
    const result = await projects.patch(orgId, id, changed, metadata);
    // A project this window read from the server is gone: never recreate it.
    if (result?.missing) throw projectDeletedError(id);
    projects.advanceBaseline?.(id, sent);
    return result;
  };
  const sendProjectChanges = async (orgId, next, metadata) => {
    const id = next.id;
    const projects = window.PlatformAPI.projects;
    if (deletedProjectIds.has(id)) throw projectDeletedError(id);
    const baseline = typeof projects.baseline === 'function' ? projects.baseline(id) : null;
    if (!baseline || typeof projects.patch !== 'function') return projects.save(orgId, id, next, metadata);
    try {
      try {
        return await sendProjectPatch(orgId, next, metadata, baseline);
      } catch (error) {
        // R4-EQ-4: one retry for a busy project (409) or a dropped request.
        if (!retryableSaveError(error)) throw error;
        return await sendProjectPatch(orgId, next, metadata, projects.baseline(id) || baseline);
      }
    } catch (error) {
      if (error?.code === 'project_deleted' || error?.deleted) {
        deletedProjectIds.add(id);
        throw error.code === 'project_deleted' && error.projectId ? error : projectDeletedError(id, error);
      }
      throw error;
    }
  };
  const notifyProjectSaveFailed = (error) => {
    const toast = window.Portal?.ui?.showToast || window.PlatformUI?.showToast;
    if (typeof toast !== 'function') return;
    if (error?.code === 'project_deleted') {
      try { showDeletedProjectNotice(error.projectId); } catch (_) {}
      const now = Date.now();
      if (now - (deletedProjectToasts.get(error.projectId) || 0) < DELETED_PROJECT_TOAST_GAP_MS) return;
      deletedProjectToasts.set(error.projectId, now);
      toast(globalThis.PlatformLanguage?.text?.('project-viewer', 'project_deleted_title', 'This project was deleted') ?? 'This project was deleted', globalThis.PlatformLanguage?.text?.('project-viewer', 'project_deleted_body', 'Someone else deleted it, so your change was not saved.') ?? 'Someone else deleted it, so your change was not saved.', false);
      return;
    }
    const offline = !Number(error?.status || 0) && /fetch|network/i.test(String(error?.message || ''));
    toast(globalThis.PlatformLanguage?.text?.('project-viewer', 'project_save_failed', 'Project changes not saved') ?? 'Project changes not saved', offline || !error?.message
      ? (globalThis.PlatformLanguage?.text?.('project-viewer', 'project_save_retry', 'Check your connection and try again.') ?? 'Check your connection and try again.')
      : error.message, false);
  };
  const projectSaveQueues = new Map();
  const pumpProjectSaves = (id, state) => {
    if (state.running) return;
    if (!state.pending) { projectSaveQueues.delete(id); return; }
    const job = state.pending;
    state.pending = null;
    state.running = sendProjectChanges(job.orgId, job.next, job.metadata)
      .then((result) => job.waiters.forEach((waiter) => waiter.resolve(result)),
        (error) => job.waiters.forEach((waiter) => waiter.reject(error)))
      .finally(() => { state.running = null; pumpProjectSaves(id, state); });
  };
  const saveProjectChanges = (orgId, next, metadata) => new Promise((resolve, reject) => {
    const id = next.id;
    const state = projectSaveQueues.get(id) || { running: null, pending: null };
    projectSaveQueues.set(id, state);
    const waiters = state.pending ? state.pending.waiters : [];
    waiters.push({ resolve, reject });
    state.pending = { orgId, next, metadata, waiters };
    pumpProjectSaves(id, state);
  });

  window.Portal.ProjectStore = {
    cache(project){
      if (!isProjectLike(project)) return project || null;
      return cacheProject(project);
    },
    save(project){
      if (!isProjectLike(project)) return project || null;
      const next = cacheProject(project);
      void this.saveRemote(next).catch((error) => {
        console.warn('Platform project save failed', error);
        notifyProjectSaveFailed(error);
      });
      return next;
    },
    // True while this page still has an edit of the project queued or in
    // flight (its cached copy is then ahead of the server's).
    hasPendingSave(projectOrId){
      const id = typeof projectOrId === 'string' ? projectOrId : canonicalProjectId(projectOrId || {});
      return !!id && projectSaveQueues.has(id);
    },
    async saveRemote(project){
      if (!isProjectLike(project)) return null;
      const orgId = await ensureRemoteOrganization();
      const measurementProject = project?.measurement_project || project?.measurement || {};
      const nextId = canonicalProjectId(project);
      if (discardedProjectIds.has(nextId)) return null;
      const {
        platform_project_id,
        base_project_id,
        base_project,
        platform_project,
        ...persistableProject
      } = project || {};
      const next = {
        ...persistableProject,
        id: nextId,
        platform_project_id: firstText(project?.platform_project_id, project?.base_project_id, nextId),
        base_project_id: firstText(project?.base_project_id, project?.platform_project_id, nextId),
        // The pipeline stage lives in the work projection; only echo a legacy
        // stage the record already has, never invent one on an edit save.
        ...(firstText(project?.stage, project?.stage_id) ? {
          stage: firstText(project?.stage, project?.stage_id),
          stage_id: firstText(project?.stage_id, project?.stage)
        } : {}),
        measurement: project?.measurement || measurementProject,
        measurement_project: project?.measurement_project || measurementProject,
        updated_at: new Date().toISOString()
      };
      const metadata = {
        workflow_state: next.workflow_state || '',
        measurement_keys: measurementKeys(next.measurement_project || next.measurement || {})
      };
      const result = await saveProjectChanges(orgId, next, metadata);
      if (discardedProjectIds.has(next.id)) {
        await window.PlatformAPI.projects.remove(orgId, next.id).catch(() => null);
        return null;
      }
      return cacheProject(remoteProjectFromDocument(result.document) || next);
    },
    remove(projectOrId){
      return removeCachedProject(projectOrId);
    },
    cachedIds(){
      return Object.keys(readStore().projects || {});
    },
    async removeRemote(projectOrId){
      const id = typeof projectOrId === 'string' ? projectOrId : canonicalProjectId(projectOrId || {});
      if (!id) return false;
      removeCachedProject(id);
      const orgId = await ensureRemoteOrganization();
      await window.PlatformAPI.projects.remove(orgId, id);
      return true;
    },
    fromQueue(payload = {}, data = {}, options = {}){
      const contacts = parseJson(payload.contacts, []);
      const project = data.project || data.manifest || {};
      const measurementId = firstMeasurementText(data.folder, project.id, project.project_id, project.folder);
      const existingProjectId = firstText(payload.platform_project_id, payload.base_project_id);
      const existingProject = existingProjectId ? this.get(existingProjectId) : null;
      const measurement = {
        id: measurementId,
        folder: firstMeasurementText(data.folder, project.folder, measurementId),
        status: firstText(project.status, 'queued'),
        report_mode: firstText(data.report_mode, payload.report_mode, project.report_mode, 'full'),
        include_gutters: payload.include_gutter_measurements === '1' || payload.include_gutter_measurements === true,
        include_weather_report: payload.include_weather_report === '1' || payload.include_weather_report === true || project.include_weather_report === true,
        weather_report_tier: firstText(project.weather_report_tier, payload.weather_report_tier, 'history'),
        weather_report_id: firstText(project.weather_report_id),
        weather_report_pdf_url: firstText(project.weather_report_pdf_url),
        include_instant: String(payload.report_mode || data.report_mode || '').trim().toLowerCase() === 'both',
        is_expedited: payload.is_expedited === '1' || payload.is_expedited === true || project.is_expedited === true,
        report_expedite_option: firstText(payload.report_expedite_option, project.report_expedite_option),
        report_expedite_label: firstText(payload.report_expedite_label, project.report_expedite_label),
        report_due_window_start: firstText(payload.report_due_window_start, project.report_due_window_start),
        report_due_window_end: firstText(payload.report_due_window_end, project.report_due_window_end),
        report_due_window_label: firstText(payload.report_due_window_label, project.report_due_window_label),
        amount_charged: Number(project.amount_charged ?? payload.report_expedite_net_total_price ?? payload.report_expedite_total_price ?? 0) || 0,
        submitted_at: firstText(project.created_at, new Date().toISOString()),
        raw: data
      };
      const ordered = {
        ...(existingProject || {}),
        id: existingProject?.id || existingProjectId || projectIdFromMeasurement(measurement),
        measurement_project_id: measurementId,
        project_id: measurementId,
        folder: measurementId,
        previous_measurement_ids: [...new Set([
          ...(existingProject?.previous_measurement_ids || []),
          ...measurementKeys(existingProject?.measurement_project || existingProject?.measurement || {})
        ])].filter((id) => id !== measurementId),
        title: firstProjectDisplayText(payload.project_title, existingProject?.title, payload.residentName),
        address: firstText(payload.address, project.address),
        project_type: firstText(payload.project_type, project.project_type, 'residential'),
        lat: firstText(payload.lat, project.lat, project.latitude),
        lng: firstText(payload.lng, project.lng, project.longitude),
        pins: parseJson(payload.pins, []),
        contacts: Array.isArray(contacts) && contacts.length ? contacts : [{
          name: firstText(payload.residentName),
          phone: firstText(payload.residentPhone),
          email: firstText(payload.residentEmail)
        }],
        project_notes: firstText(payload.project_notes),
        photos: Array.isArray(existingProject?.photos) ? existingProject.photos : [],
        events: Array.isArray(existingProject?.events) ? existingProject.events : [],
        proposals: Array.isArray(existingProject?.proposals) ? existingProject.proposals : [],
        stage: firstText(existingProject?.stage, existingProject?.stage_id, 'contacting'),
        stage_id: firstText(existingProject?.stage_id, existingProject?.stage, 'contacting'),
        workflow_state: 'measurement_ordered',
        status: measurement.status,
        refund_issued: false,
        refund_amount: 0,
        refund_reason: '',
        rejection_reason: '',
        rejection_message: '',
        customer_rejection_message: '',
        has_report: false,
        report_url: '',
        pdf_url: '',
        summary_url: '',
        xml_url: '',
        created_at: firstText(existingProject?.created_at, project.created_at, project.queued_at, measurement.submitted_at, new Date().toISOString()),
        submitted_at: firstText(existingProject?.submitted_at, project.created_at, project.queued_at, measurement.submitted_at, new Date().toISOString()),
        measurement,
        measurement_project: measurement
      };
      return options.persist === false ? this.cache(ordered) : this.save(ordered);
    },
    findByMeasurement(project){
      const normalized = project || {};
      const store = readStore();
      for (const key of measurementKeys(normalized)) {
        const baseId = store.measurementIndex[key];
        if (baseId && store.projects[baseId]) return store.projects[baseId];
      }
      return null;
    },
    async findByMeasurementRemote(project){
      const keys = new Set(measurementKeys(project || {}));
      if (!keys.size) return null;
      const orgId = await ensureRemoteOrganization();
      const result = await window.PlatformAPI.projects.list(orgId);
      const docs = Array.isArray(result.documents) ? result.documents : [];
      for (const doc of docs) {
        const base = remoteProjectFromDocument(doc);
        if (!base) continue;
        const baseKeys = new Set(measurementKeys(base.measurement || base.measurement_project || {}));
        for (const key of keys) {
          if (baseKeys.has(key)) return cacheProject(base);
        }
      }
      return null;
    },
    ensureFromMeasurement(project){
      if (!isProjectLike(project)) return null;
      return this.findByMeasurement(project) || this.save(projectFromMeasurement(project || {}));
    },
    async ensureFromMeasurementAsync(project){
      if (!isProjectLike(project)) return null;
      const cached = this.findByMeasurement(project);
      if (cached) return cached;
      const remote = await this.findByMeasurementRemote(project).catch(() => null);
      if (remote) return remote;
      return this.save(projectFromMeasurement(project || {}));
    },
    get(id){
      const store = readStore();
      return store.projects[String(id || '')] || null;
    }
  };
})();
