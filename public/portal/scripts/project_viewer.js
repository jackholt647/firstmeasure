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
    constructor({ root, tabsEl, panelSelector, tabClass = 'pv-tab', activeClass = 'active', pendingClass = 'pending', onTabChange } = {}){
      this.root = root || null;
      this.tabsEl = tabsEl || null;
      this.panelSelector = panelSelector || '';
      this.tabClass = tabClass;
      this.activeClass = activeClass;
      this.pendingClass = pendingClass;
      this.onTabChange = onTabChange;
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

    render(){
      ProjectViewer.renderTabs(this.tabsEl, this.tabs.map((tab) => ({
        ...tab,
        active: tab.id === this.activeTab
      })), {
        tabClass: this.tabClass,
        activeClass: this.activeClass,
        pendingClass: this.pendingClass,
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
      const items = (tabs || []).filter(Boolean);
      tabsEl.classList.toggle('single-tab', items.length <= 1);
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
        return `<button type="button" class="${escapeHtml(classes)}"${idAttr} data-tab="${escapeHtml(tab.id)}"${disabledAttr}>${iconHtml}${escapeHtml(tab.label || tab.id)}</button>`;
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
    return {
      name: firstText(contact.name, project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === 'string' ? project.resident : '', customer.name, resident.name),
      email: firstText(contact.email, project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail, customer.email, resident.email),
      phone: firstText(contact.phone, project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone, customer.phone, resident.phone)
    };
  };

  const withProjectDisplayAliases = (project = {}) => {
    const contact = projectPrimaryContactAlias(project);
    const contacts = dedupeProjectContacts([
      ...(Array.isArray(project.contacts) ? project.contacts : []),
      contact
    ]);
    const projectTitle = firstProjectDisplayText(project.title, project.project_title, project.project_name, project.projectName, project.name, project.address, project.customer_name, project.customerName, project.primary_contact_name, contact.name);
    return {
      ...project,
      contacts,
      title: projectTitle || 'New Project',
      project_title: projectTitle || 'New Project',
      customer_name: firstText(project.customer_name, project.customerName, contact.name),
      primary_contact_name: firstText(project.primary_contact_name, contact.name),
      customer_email: firstText(project.customer_email, contact.email),
      primary_contact_email: firstText(project.primary_contact_email, contact.email),
      customer_phone: firstText(project.customer_phone, contact.phone),
      primary_contact_phone: firstText(project.primary_contact_phone, contact.phone)
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

  window.Portal.ProjectStore = {
    cache(project){
      if (!isProjectLike(project)) return project || null;
      return cacheProject(project);
    },
    save(project){
      if (!isProjectLike(project)) return project || null;
      const next = cacheProject(project);
      void this.saveRemote(next).catch((error) => console.warn('Platform project save failed', error));
      return next;
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
        stage: firstText(project?.stage, project?.stage_id, 'contacting'),
        stage_id: firstText(project?.stage_id, project?.stage, 'contacting'),
        measurement: project?.measurement || measurementProject,
        measurement_project: project?.measurement_project || measurementProject,
        updated_at: new Date().toISOString()
      };
      const result = await window.PlatformAPI.projects.save(orgId, next.id, next, {
        workflow_state: next.workflow_state || '',
        measurement_keys: measurementKeys(next.measurement_project || next.measurement || {})
      });
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
    fromQueue(payload = {}, data = {}){
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
      return this.save({
        ...(existingProject || {}),
        id: existingProject?.id || existingProjectId || projectIdFromMeasurement(measurement),
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
        created_at: firstText(existingProject?.created_at, project.created_at, project.queued_at, measurement.submitted_at, new Date().toISOString()),
        submitted_at: firstText(existingProject?.submitted_at, project.created_at, project.queued_at, measurement.submitted_at, new Date().toISOString()),
        measurement,
        measurement_project: measurement
      });
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
