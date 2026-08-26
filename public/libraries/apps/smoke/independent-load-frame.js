/* public/libraries/apps/smoke/independent-load-frame.js */
(function(){
  const smokeCase = window.__FM_APP_SMOKE_CASE || {};
  const appId = String(smokeCase.id || '').trim();
  const runtime = window.FirstMateEmbeddableApps;
  const errors = [];
  const loadedScripts = new Set();
  const cacheBust = String(smokeCase.cacheBust || Date.now());

  function report(ok, detail){
    window.parent?.postMessage?.({
      type: 'fm-app-smoke-result',
      appId,
      ok,
      detail: ok ? detail : '',
      error: ok ? '' : String(detail || 'Unknown smoke failure.')
    }, '*');
  }

  window.addEventListener('error', (event) => {
    errors.push(event.message || event.error?.message || 'Script error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    errors.push(event.reason?.message || String(event.reason || 'Unhandled promise rejection'));
  });

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  function loadScript(src){
    const next = new URL(src, document.baseURI);
    next.searchParams.set('smoke_v', cacheBust);
    const url = next.href;
    if (loadedScripts.has(url)) return Promise.resolve();
    if (Array.from(document.querySelectorAll('script[src]')).some((script) => new URL(script.src, document.baseURI).href === url)) {
      loadedScripts.add(url);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = false;
      script.onload = () => {
        loadedScripts.add(url);
        resolve();
      };
      script.onerror = () => reject(new Error(`Could not load ${url}`));
      document.head.appendChild(script);
    });
  }

  function setupPortalStub(){
    const cfg = {
      userOrgId: 'org_smoke',
      orgId: 'org_smoke',
      userBranchId: 'branch_smoke',
      branchId: 'branch_smoke',
      userName: 'Smoke Tester',
      userEmail: 'smoke@example.com',
      platformApiBase: '',
      googleMapsApiKey: ''
    };
    window.__APP = { ...(window.__APP || {}), ...cfg };

    const $ = (sel, root = document) => root.querySelector(sel);
    const injectCSS = (id, css) => {
      const safeId = `smoke_css_${String(id || '').replace(/[^a-z0-9_-]/gi, '_')}`;
      let style = document.getElementById(safeId);
      if (!style) {
        style = document.createElement('style');
        style.id = safeId;
        document.head.appendChild(style);
      }
      style.textContent = css || '';
      return style;
    };
    const okJson = (data = {}) => Promise.resolve({ data: { success: true, ...data } });
    const enableSafeBackdropClose = (overlayEl, closeFn) => {
      overlayEl?.addEventListener?.('click', (event) => {
        if (event.target === overlayEl && typeof closeFn === 'function') closeFn();
      });
    };
    if (!document.getElementById('mainPanels')) {
      const panels = document.createElement('div');
      panels.id = 'mainPanels';
      panels.className = 'main-panels';
      document.body.appendChild(panels);
    }

    class ProjectViewer {
      constructor(options = {}) {
        this.root = options.root || null;
        this.tabsEl = options.tabsEl || null;
        this.panelSelector = options.panelSelector || '.r-preview-panel';
        this.onTabChange = options.onTabChange || (() => {});
        this.activeTab = 'map';
      }
      setTabs(tabs = []) {
        this.tabs = tabs;
        ProjectViewer.renderTabs(this.tabsEl, tabs, { onTabClick: (tab) => this.setActiveTab(tab.id) });
      }
      setActiveTab(id) {
        this.activeTab = id;
        this.onTabChange(id);
      }
      render(){}
      static renderTabs(root, tabs = [], options = {}) {
        if (!root) return;
        root.innerHTML = tabs.map((tab) => `<button type="button" data-smoke-tab="${escapeHtml(tab.id)}">${escapeHtml(tab.label || tab.title || tab.id)}</button>`).join('');
        root.querySelectorAll('[data-smoke-tab]').forEach((button) => {
          button.addEventListener('click', () => options.onTabClick?.(tabs.find((tab) => tab.id === button.dataset.smokeTab) || { id: button.dataset.smokeTab }));
        });
      }
    }

    const Portal = {
      cfg,
      util: {
        $,
        injectCSS,
        escapeHtml,
        postAction: () => okJson(),
        hasPerm: () => true,
        enableSafeBackdropClose,
        formatDate: (value) => value ? new Date(value).toLocaleDateString() : '',
        fmUrl: (path) => String(path || ''),
        fmJson: () => Promise.resolve({}),
        fmPost: () => Promise.resolve({ success: true }),
        platformJson: () => Promise.resolve({}),
        currentActor: () => ({ id: 'user_smoke', name: 'Smoke Tester', email: 'smoke@example.com' }),
        googleMapsApiKey: () => ''
      },
      ui: {
        showToast: () => {},
        hideToast: () => {}
      },
      modules: {
        request: {
          openProject(project, options) {
            window.__FM_SMOKE_OPENED_PROJECT = { project, options };
            document.documentElement.dataset.openedProjectId = project?.id || '';
            document.documentElement.dataset.openedPlatformProjectId = project?.platform_project_id || '';
            document.documentElement.dataset.openedCustomerName = project?.customer_name || project?.primary_contact_name || '';
            document.documentElement.dataset.openedProjectAddress = project?.address || '';
            document.documentElement.dataset.openedProjectTab = options?.tab || '';
            let debug = document.getElementById('smokeOpenedProject');
            if (!debug) {
              debug = document.createElement('pre');
              debug.id = 'smokeOpenedProject';
              debug.hidden = true;
              document.body.appendChild(debug);
            }
            debug.textContent = JSON.stringify({
              id: project?.id || '',
              platform_project_id: project?.platform_project_id || '',
              base_project_id: project?.base_project_id || '',
              customer_name: project?.customer_name || '',
              primary_contact_name: project?.primary_contact_name || '',
              address: project?.address || '',
              tab: options?.tab || ''
            });
          }
        }
      },
      apps: {
        tabs: new Map(),
        registerPortalApp(def = {}) {
          const tabId = def.tabId || def.portalTabId || String(def.id || '').replace(/^portal\./, '');
          if (!tabId) return null;
          const id = def.id && String(def.id).startsWith('portal.') ? def.id : (def.appId || `portal.${tabId}`);
          this.tabs.set(tabId, { ...def, tabId, id });
          runtime?.registerApp?.({
            id,
            portalTabId: tabId,
            kind: 'portal_tab',
            title: def.title || tabId,
            label: def.title || tabId,
            icon: def.icon || '',
            order: Number.isFinite(def.order) ? def.order : 1000,
            surfaces: ['portal_tab'],
            regions: ['main'],
            mount(context = {}) {
              const root = context.roots?.main || document.getElementById('smokeRoot');
              const result = typeof def.mount === 'function' ? def.mount(root, context) : null;
              return result && typeof result === 'object' ? result : {};
            }
          });
          return def;
        },
        unregisterPortalApp(id){
          const tabId = String(id || '').replace(/^portal\./, '');
          const appId = String(id || '').startsWith('portal.') ? id : `portal.${tabId}`;
          this.tabs.delete(tabId);
          runtime?.unregisterApp?.(appId);
        }
      },
      tabs: {
        renderTabs(){},
        activateTab(id){
          const def = window.Portal.apps.tabs.get(id);
          if (!def) return;
          const root = document.getElementById('smokeRoot');
          def.mount?.(root, { surface: 'portal_tab', roots: { main: root } });
        }
      },
      ProjectViewer,
      ProjectStore: {
        list: () => [],
        save: (project) => project,
        saveRemote: (project) => Promise.resolve(project),
        remove: () => {},
        removeRemote: () => Promise.resolve(),
        fromQueue: (_payload, data) => data?.project || null,
        findByMeasurement: () => null,
        findByMeasurementRemote: () => Promise.resolve(null),
        ensureFromMeasurement(project = {}) {
          window.__FM_SMOKE_MEASUREMENT_RESOLVER_USED = true;
          return {
            id: 'project_generated_from_measurement',
            address: 'Generated Measurement Project',
            workflow_state: 'measurement_ordered',
            measurement: { id: project.id || project.project_id || 'measurement_smoke' },
            measurement_project: { id: project.id || project.project_id || 'measurement_smoke' }
          };
        },
        ensureFromMeasurementAsync(project = {}) {
          window.__FM_SMOKE_MEASUREMENT_RESOLVER_USED = true;
          return Promise.resolve({
            id: 'project_generated_from_measurement',
            address: 'Generated Measurement Project',
            workflow_state: 'measurement_ordered',
            measurement: { id: project.id || project.project_id || 'measurement_smoke' },
            measurement_project: { id: project.id || project.project_id || 'measurement_smoke' }
          });
        }
      },
      branchModules: {
        currentBranchId: () => 'branch_smoke',
        get: () => Promise.resolve({ data: {} }),
        save: (_id, data) => Promise.resolve({ data })
      },
      modals: { register: () => ({ unregister(){} }) },
      credits: { refreshCredits: () => Promise.resolve(100), balance: () => 100 },
      appFlags: {
        has: (group, flag) => {
          const current = Portal.appFlags.current();
          const value = current?.[group]?.[flag] ?? current?.[flag];
          return value !== undefined ? !!value : true;
        },
        value: (group, flag, fallback) => {
          const current = Portal.appFlags.current();
          return current?.[group]?.[flag] ?? current?.[flag] ?? fallback;
        },
        current: () => ({
          test_admin: true,
          calls: { app: true },
          canvassing: { app: true },
          platform: {
            project_photos: true,
            photos_feed: true,
            proposals: true,
            materials: true,
            pricebook: true,
            customer_portal: true,
            customer_portal_media: true,
            scheduling: true,
            storage_limits: false,
            purchasable_storage: false
          },
          firstmeasure: {
            report_orders: true,
            gutter_reports: true,
            weather_reports: true,
            instant_reports: true,
            report_expedite_options: true,
            report_cancellations: true,
            report_followup: true
          }
        }),
        load: () => Promise.resolve({})
      },
      permissions: {},
      capabilities: {},
      routeState: { set(){}, get(){ return {}; } },
      currentTheme: {}
    };
    window.Portal = Portal;

    window.PlatformUI = {
      alert: () => Promise.resolve(true),
      confirm: () => Promise.resolve(true),
      showToast: () => {},
      hideToast: () => {}
    };
    const smokeProjectDocs = [
      {
        id: 'project_1v6gduusp58b1',
        data: {
          id: 'project_1v6gduusp58b1',
          address: '21722 SE 32nd Pl, Sammamish, WA 98075, USA',
          project_type: 'residential',
          contacts: [
            {
              name: 'Shelly Shlerson',
              phone: '12634567890',
              email: 'test@shjellysemai.stuff',
              primary: true
            }
          ],
          photos: [
            {
              id: 'top_down_thumbnail',
              designator: 'top_down_thumbnail',
              is_top_down_thumbnail: true,
              src: 'https://example.test/top-down.jpg',
              thumb: 'https://example.test/top-down.jpg'
            },
            {
              id: 'media_19a53ab79650548a',
              media_id: 'media_19a53ab79650548a',
              src: 'https://example.test/media_19a53ab79650548a-original.jpg',
              thumb: 'https://example.test/media_19a53ab79650548a-thumb.jpg',
              uploaded_at: '2026-06-06T00:42:35.066Z'
            }
          ],
          proposals: [],
          events: []
        }
      },
      {
        id: 'project_3og98ma60eei',
        data: {
          id: 'project_3og98ma60eei',
          address: '21722 SE 32nd Pl, Sammamish, WA 98075, USA',
          project_type: 'residential',
          contacts: [],
          photos: [],
          workflow_state: 'measurement_ordered'
        }
      },
      {
        id: 'project_1p3an301i4cuyn',
        data: {
          id: 'project_1p3an301i4cuyn',
          address: '3731 W Commodore Way, Seattle, WA 98199, USA',
          project_type: 'residential',
          contacts: [{ name: 'Test Customer', phone: '', email: '', primary: true }],
          photos: [
            {
              id: 'media_3ea1f5b1ad66144b',
              media_id: 'media_3ea1f5b1ad66144b',
              src: 'https://example.test/commodore-original.jpg',
              thumb: 'https://example.test/commodore-thumb.jpg',
              uploaded_at: '2026-06-05T23:14:30.451Z'
            }
          ],
          proposals: [],
          events: [],
          workflow_state: 'measurement_ordered'
        }
      },
      {
        id: 'project_pioffo2a6chh',
        data: {
          id: 'project_pioffo2a6chh',
          address: '3731 W Commodore Way, Seattle, WA 98199, USA',
          project_type: 'residential',
          contacts: [],
          photos: [],
          workflow_state: 'measurement_ordered'
        }
      }
    ];
    window.PlatformAPI = {
      projects: {
        list: () => Promise.resolve({ documents: smokeProjectDocs }),
        save: (_orgId, projectId, data) => Promise.resolve({ document: { id: projectId, data } }),
        get: (_orgId, projectId) => Promise.resolve({
          document: smokeProjectDocs.find((doc) => doc.id === projectId) || { id: projectId, data: {} }
        }),
        remove: () => Promise.resolve({ ok: true })
      },
      projectMedia: {
        hydrateProjectPhotos(project = {}) {
          return { photos: Array.isArray(project.photos) ? project.photos : [], thumbnail_photo_id: '', thumbnail_photo: null };
        },
        normalizePhoto(photo = {}, options = {}) {
          if (typeof photo === 'string') return { id: photo, src: photo, thumb: photo, label: `Photo ${options.index || 1}` };
          return { ...photo, id: photo.id || `photo_${options.index || 1}`, src: photo.src || photo.url || '', thumb: photo.thumb || photo.src || photo.url || '' };
        },
        normalizePhotos(photos = []) { return photos; },
        thumbnailPhoto(photos = []) { return photos[0] || null; },
        upload: () => Promise.resolve({ document: { data: { photos: [] } } })
      },
      mediaStorage: { get: () => Promise.resolve({ used_bytes: 0, limit_bytes: 0 }), current: () => Promise.resolve({ used_bytes: 0, limit_bytes: 0 }) },
      customerPortals: {
        ensure: () => Promise.resolve({ portal: { live_url: 'https://example.test/customer', preview_url: 'https://example.test/preview' } }),
        activity: () => Promise.resolve({ events: [] }),
        shareMedia: () => Promise.resolve({ portal: {} }),
        unshareMedia: () => Promise.resolve({ portal: {} })
      },
      brandingMedia: {
        list: () => Promise.resolve({ media: [] }),
        upload: (_orgId, file) => Promise.resolve({ media: { id: file?.name || 'brand', src: '' } }),
        imageRef: (_orgId, item) => item?.src || ''
      },
      dashboard: {
        normalizeConfig: () => ({
          stats: [
            { id: 'scheduled', label: 'Scheduled' },
            { id: 'completed', label: 'Completed' },
            { id: 'overdue', label: 'Overdue' },
            { id: 'unscheduled', label: 'Unscheduled' }
          ]
        }),
        statsForRange: () => ({
          scheduled: 0,
          completed: 0,
          overdue: 0,
          unscheduled: 0,
          value: 0
        }),
        formatStatValue: (_id, value) => String(value ?? 0),
        getDashboardProjectGroups: () => [
          { id: 'scheduled', label: 'Scheduled', items: [], projects: [], events: [] },
          { id: 'unscheduled', label: 'Unscheduled', items: [], projects: [], events: [] }
        ]
      },
      userActivity: { track: () => Promise.resolve(null) },
      appFlags: {
        load: () => Promise.resolve({}),
        current: () => window.Portal.appFlags.current(),
        has: (...args) => window.Portal.appFlags.has(...args),
        value: (...args) => window.Portal.appFlags.value(...args)
      }
    };
    window.PlatformScheduling = {
      loadBranchConfig: () => Promise.resolve({ event_types: { sales_appointment: { duration_minutes: 60 } }, availability: {} }),
      listUsers: () => Promise.resolve([{ id: 'user_smoke', name: 'Smoke User', roles: ['sales_appointments'], status: 'active' }]),
      listProjects: () => Promise.resolve([]),
      userHasRole: () => true,
      eventStart: (event = {}) => new Date(event.start_at || event.start || Date.now()),
      eventEnd: (event = {}) => new Date(event.end_at || event.end || Date.now() + 3600000),
      availabilityForEventType: () => ({ hasAvailability: true }),
      saveProjectEvent: (_orgId, project, event) => Promise.resolve({ project: { ...project, events: [event] } })
    };
    window.PlatformScheduleView = {
      renderDailyTeam(root) { if (root) root.innerHTML = '<div class="r-schedule-empty">Smoke schedule rendered.</div>'; },
      updateDraft() {}
    };
    window.CanvassingAPI = {
      settings: {
        get: () => Promise.resolve({
          settings: {
            enabled: true,
            statuses: [
              { id: 'new', label: 'New', color: '#2563eb' },
              { id: 'knocked', label: 'Knocked', color: '#16a34a' },
              { id: 'follow_up', label: 'Follow Up', color: '#d97706' }
            ]
          }
        })
      },
      pins: {
        list: () => Promise.resolve({ pins: [], settings: { enabled: true, statuses: [] } }),
        create: (_orgId, _branchId, payload) => Promise.resolve({ pin: { id: 'pin_smoke', ...payload } }),
        patch: (_orgId, _branchId, _pinId, payload) => Promise.resolve({ pin: payload }),
        remove: () => Promise.resolve({ success: true }),
        promote: () => Promise.resolve({ success: true })
      },
      geocode: {
        reverse: () => Promise.resolve({ address: '123 Example St' })
      }
    };
    window.FirstMateSettingsPages = {
      pages: new Map(),
      registerPage(page = {}) {
        if (page.id) this.pages.set(page.id, page);
        return page;
      },
      branchModuleStore(_moduleId, options = {}) {
        let draft = {};
        const listeners = new Set();
        return {
          load: () => Promise.resolve(draft),
          get: () => ({ ...draft }),
          setDraft(next, meta = {}) {
            draft = next && typeof next === 'object' ? { ...next } : {};
            listeners.forEach((listener) => listener(draft, meta));
            return draft;
          },
          save(next, meta = {}) {
            draft = next && typeof next === 'object' ? { ...next } : {};
            listeners.forEach((listener) => listener(draft, { type: 'save', ...meta }));
            return Promise.resolve(draft);
          },
          subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          options
        };
      },
      mount(root) {
        if (root) root.innerHTML = '<div class="cs-note">Smoke settings rendered.</div>';
        return { destroy(){} };
      }
    };
    window.FirstMateMarkup = {
      openPhotoViewer: () => ({ updateMarkupLayerBounds(){} }),
      markupColorPaletteHtml: () => '',
      rememberMarkupColor: () => {}
    };
  }

  function manifestMap(){
    const apps = window.FirstMateAppsManifest?.apps || [];
    return new Map(apps.map((app) => [app.id, app]));
  }

  async function loadAppAndDependencies(id, manifests, stack = []){
    if (stack.includes(id)) throw new Error(`Circular app dependency: ${[...stack, id].join(' -> ')}`);
    const manifest = manifests.get(id);
    if (!manifest) throw new Error(`Manifest missing for ${id}`);
    for (const dependencyId of manifest.dependencies || []) {
      await loadAppAndDependencies(dependencyId, manifests, [...stack, id]);
    }
    for (const bundle of manifest.bundles || []) await loadScript(bundle);
  }

  function seedPanelHtml(app, model){
    const root = document.getElementById('smokeRoot');
    const definition = runtime?.getApp?.(app.id) || app;
    if (!definition?.panelHtml) return;
    const context = {
      activeProject: model.state.activeBaseProject,
      project: model.state.activeBaseProject,
      projectPhotosEnabled: true,
      proposalsEnabled: true,
      customerPortalEnabled: true,
      schedulePreviewAvailable: true,
      hasReportOrdered: true,
      reportOrderPending: false,
      reorderMeasurementProjectId: ''
    };
    root.innerHTML = typeof definition.panelHtml === 'function' ? definition.panelHtml(context) : String(definition.panelHtml || '');
  }

  function smokeHost(model){
    return window.FirstMateAppContext.createProjectHost(model, {
      showToast: () => {}
    });
  }

  function setupMaterialsSmokeApiCase(){
    const params = new URLSearchParams(location.search || '');
    if (params.get('materialsCase') !== 'dirty_duplicates') return;
    let materialList = {
      id: 'smoke_dirty_materials',
      title: 'Materials',
      status: 'planning',
      delivery_status: 'unscheduled',
      revision: 1,
      version_number: 1,
      metadata: { primary: true, role: 'primary_materials', source: 'smoke_dirty_duplicates' },
      current_items: [
        { id: 'dirty_shingle_selected', section: 'shingles', name: 'Shingles', item_type_id: 'field_shingles', product_selection: { item_type_id: 'field_shingles', item_type_name: 'Shingles', variant_item_id: 'gaf_hd', variant_name: 'Timberline HDZ' }, pricebook_ref: { item_id: 'gaf_hd', item_type_id: 'field_shingles' }, category: 'shingle_roofs', quantity: 29, unit: 'sq', projected_unit_price: 398 },
        { id: 'dirty_starter', section: 'shingles', name: 'Starter Strip', item_type_id: 'starter', category: 'shingle_roofs', quantity: 46, unit: 'lf', projected_unit_price: 2.45 },
        { id: 'dirty_ridge_cap', section: 'shingles', name: 'Ridge Cap', item_type_id: 'ridge_cap', category: 'shingle_roofs', quantity: 35, unit: 'lf', projected_unit_price: 4.25 },
        { id: 'dirty_under_shingles', section: 'shingles', name: 'Underlayment', product_selection: { item_type_id: 'underlayment', item_type_name: 'Underlayment', variant_name: 'Tiger Paw' }, category: 'shingle_roofs', quantity: 29, unit: 'sq', projected_unit_price: 62 },
        { id: 'dirty_steep', section: 'shingles', name: 'Steep Slope Charge', item_type_id: 'steep_slope', category: 'shingle_roofs', quantity: 29, unit: 'sq', projected_unit_price: 35 },
        { id: 'dirty_gaf_hdz', section: 'shingles', name: 'GAF Timberline HDZ', category: 'shingle_roofs', quantity: 29, unit: 'sq', projected_unit_price: 398 },
        { id: 'dirty_duration', section: 'shingles', name: 'Owens Corning Duration', category: 'shingle_roofs', quantity: 29, unit: 'sq', projected_unit_price: 405 },
        { id: 'dirty_vista', section: 'shingles', name: 'Malarkey Vista', category: 'shingle_roofs', quantity: 29, unit: 'sq', projected_unit_price: 418 },
        { id: 'dirty_ice', section: 'underlayments', name: 'Ice & Water Shield', category: 'leak_barriers', quantity: 1, unit: 'sq', projected_unit_price: 78 },
        { id: 'dirty_weatherwatch', section: 'underlayments', name: 'GAF WeatherWatch', category: 'leak_barriers', quantity: 29, unit: 'sq', projected_unit_price: 92 },
        { id: 'dirty_weatherlock', section: 'underlayments', name: 'Owens Corning WeatherLock', category: 'leak_barriers', quantity: 29, unit: 'sq', projected_unit_price: 95 },
        { id: 'dirty_under_1', section: 'underlayments', name: 'Underlayment', category: 'underlayments', quantity: 26, unit: 'sq', projected_unit_price: 42 },
        { id: 'dirty_under_2', section: 'underlayments', name: 'Underlayment', category: 'underlayments', quantity: 26, unit: 'sq', projected_unit_price: 42 },
        { id: 'dirty_under_3', section: 'underlayments', name: 'Underlayment', category: 'underlayments', quantity: 26, unit: 'sq', projected_unit_price: 42 },
        { id: 'dirty_drip', section: 'metal', name: 'Drip Edge', item_type_id: 'drip_edge', category: 'flashing', quantity: 46, unit: 'lf', projected_unit_price: 3.25 },
        { id: 'dirty_valley', section: 'metal', name: 'Valley Metal', item_type_id: 'valley_metal', category: 'flashing', quantity: 20, unit: 'lf', projected_unit_price: 8.75 }
      ]
    };
    const saveList = (next = {}) => {
      materialList = {
        ...materialList,
        ...next,
        current_items: Array.isArray(next.current_items) ? next.current_items : materialList.current_items,
        revision: Number(materialList.revision || 0) + 1
      };
      window.__FM_DIRTY_MATERIALS_LIST = materialList;
      return materialList;
    };
    window.__FM_DIRTY_MATERIALS_LIST = materialList;
    window.MaterialsAPI = {
      projects: {
        list: () => Promise.resolve({ material_lists: [materialList] }),
        create: (_orgId, _projectId, payload = {}) => Promise.resolve({ material_list: saveList(payload) })
      },
      lists: {
        get: () => Promise.resolve({ material_list: materialList }),
        versions: () => Promise.resolve({ versions: [] }),
        orders: () => Promise.resolve({ orders: [] }),
        createVersion: (_orgId, _listId, payload = {}) => {
          const nextItems = Array.isArray(payload.items) ? payload.items : materialList.current_items;
          return Promise.resolve({
            material_list: saveList({ current_items: nextItems }),
            version: { id: `smoke_version_${Date.now()}`, reason: payload.reason || 'smoke' }
          });
        },
        createOrder: () => Promise.resolve({ order: {} })
      },
      orders: {
        deliveries: () => Promise.resolve({ deliveries: [] }),
        recordDelivery: () => Promise.resolve({ delivery: {} })
      }
    };
  }

  async function assertProjectRequestOpensPlatformProject(){
    if (appId !== 'project.request') return;
    const request = window.Portal?.modules?.request;
    if (!request?.openProject) throw new Error('Project request module did not expose openProject.');
    window.__FM_SMOKE_MEASUREMENT_RESOLVER_USED = false;
    await request.openProject({
      id: 'project_1v6gduusp58b1',
      platform_project_id: 'project_1v6gduusp58b1',
      base_project_id: 'project_1v6gduusp58b1',
      address: '21722 SE 32nd Pl, Sammamish, WA 98075, USA',
      project_type: 'residential',
      contacts: [
        {
          name: 'Shelly Shlerson',
          phone: '12634567890',
          email: 'test@shjellysemai.stuff',
          primary: true
        }
      ],
      photos: [{ id: 'media_19a53ab79650548a', media_id: 'media_19a53ab79650548a', src: 'https://example.test/photo.jpg' }],
      proposals: [],
      events: []
    }, { tab: 'photos' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (window.__FM_SMOKE_MEASUREMENT_RESOLVER_USED) {
      throw new Error('Platform project open incorrectly used the measurement resolver.');
    }
    const overlay = document.querySelector('#rOverlay.active');
    const address = document.querySelector('#rAddress')?.value || '';
    const title = document.querySelector('#rOverlay .r-title')?.textContent?.trim()
      || document.querySelector('#rProjectTitleInput')?.value?.trim()
      || document.querySelector('#rProjectTitleInput')?.getAttribute('placeholder')?.trim()
      || '';
    const tabIds = Array.from(document.querySelectorAll('#rProjectViewerTabs [data-tab], #rProjectViewerTabs [data-smoke-tab]'))
      .map((button) => button.dataset.tab || button.dataset.smokeTab || '');
    if (!overlay) throw new Error('Project request openProject did not open the modal.');
    if (address !== '21722 SE 32nd Pl, Sammamish, WA 98075, USA') throw new Error(`Project request opened the wrong project address: ${address || '(blank)'}.`);
    if (title !== 'Shelly Shlerson') throw new Error(`Project request did not preserve contact-derived project title: ${title || '(blank)'}.`);
    if (!tabIds.includes('photos')) throw new Error(`Project request did not preserve the requested Photos tab. Tabs: ${tabIds.join(', ') || '(none)'}`);
    if (!tabIds.includes('customer_portal') || !tabIds.includes('schedule')) {
      throw new Error(`Existing project tabs missing after platform open: ${tabIds.join(', ')}`);
    }
    await request.openProject({
      id: 'project_1p3an301i4cuyn',
      address: '3731 W Commodore Way, Seattle, WA 98199, USA',
      project_type: 'residential'
    }, { tab: 'photos' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const commodoreAddress = document.querySelector('#rAddress')?.value || '';
    const commodoreTitle = document.querySelector('#rOverlay .r-title')?.textContent?.trim()
      || document.querySelector('#rProjectTitleInput')?.value?.trim()
      || document.querySelector('#rProjectTitleInput')?.getAttribute('placeholder')?.trim()
      || '';
    const photoText = document.querySelector('#rOverlay')?.textContent || '';
    if (commodoreAddress !== '3731 W Commodore Way, Seattle, WA 98199, USA') {
      throw new Error(`Project request opened the wrong Commodore address: ${commodoreAddress || '(blank)'}.`);
    }
    if (commodoreTitle !== 'Test Customer') {
      throw new Error(`Project request did not hydrate the Commodore customer title: ${commodoreTitle || '(blank)'}.`);
    }
    if (!/1 media item|media_3ea1f5b1ad66144b|Photos/i.test(photoText)) {
      throw new Error('Project request opened the Commodore shell without hydrated photos.');
    }
  }

  async function assertPhotoFeedOpensHydratedPlatformProject(){
    if (appId !== 'portal.photos_feed') return;
    window.__FM_SMOKE_OPENED_PROJECT = null;
    let projectButton = null;
    for (let i = 0; i < 20; i += 1) {
      projectButton = document.querySelector('[data-photo-project-open]');
      if (projectButton) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!projectButton) throw new Error('Photo Feed did not render a project-open control.');
    projectButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = window.__FM_SMOKE_OPENED_PROJECT || {};
    const project = opened.project || {};
    if (project.id !== 'project_1v6gduusp58b1') {
      throw new Error(`Photo Feed opened the wrong project id: ${project.id || '(blank)'}.`);
    }
    if (project.platform_project_id !== 'project_1v6gduusp58b1') {
      throw new Error(`Photo Feed did not preserve the Platform project id: ${project.platform_project_id || '(blank)'}.`);
    }
    if (project.customer_name !== 'Shelly Shlerson' && project.primary_contact_name !== 'Shelly Shlerson') {
      throw new Error(`Photo Feed did not preserve the contact-derived project label: ${project.customer_name || project.primary_contact_name || '(blank)'}.`);
    }
    if (opened.options?.tab !== 'photos') {
      throw new Error(`Photo Feed did not request the Photos tab: ${opened.options?.tab || '(blank)'}.`);
    }
    window.__FM_SMOKE_OPENED_PROJECT = null;
    const commodoreButton = document.querySelector('[data-photo-project-open*="project_1p3an301i4cuyn"]');
    if (!commodoreButton) throw new Error('Photo Feed did not render the Commodore project-open control.');
    commodoreButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const commodoreOpened = window.__FM_SMOKE_OPENED_PROJECT || {};
    const commodore = commodoreOpened.project || {};
    if (commodore.id !== 'project_1p3an301i4cuyn') {
      throw new Error(`Photo Feed opened the wrong Commodore project id: ${commodore.id || '(blank)'}.`);
    }
    if (commodore.customer_name !== 'Test Customer' && commodore.primary_contact_name !== 'Test Customer') {
      throw new Error(`Photo Feed did not preserve the Commodore customer label: ${commodore.customer_name || commodore.primary_contact_name || '(blank)'}.`);
    }
    if (!Array.isArray(commodore.photos) || !commodore.photos.length) {
      throw new Error('Photo Feed opened a thin Commodore project without photos.');
    }
  }

  async function run(){
    if (!runtime) throw new Error('FirstMateEmbeddableApps runtime did not load.');
    setupPortalStub();
    await loadScript('../firstmate-apps-manifest.js');
    const manifests = manifestMap();
    const app = manifests.get(appId);
    if (!app) throw new Error(`Unknown app id ${appId}`);
    await loadAppAndDependencies(appId, manifests);
    setupMaterialsSmokeApiCase();
    await new Promise((resolve) => setTimeout(resolve, 180));

    const root = document.getElementById('smokeRoot');
    const model = window.FirstMateAppContext.createProjectModel({
      project: {
        id: 'project_smoke_1',
        title: 'Smoke Test Project',
        address: '123 Example St',
        project_type: 'residential',
        contacts: [{ name: 'Example Customer', email: 'customer@example.com', phone: '', primary: true }],
        photos: [],
        proposals: [],
        events: [],
        measurement: { status: 'complete', report_url: '' }
      },
      photos: [],
      proposals: []
    }, { orgId: 'org_smoke', branchId: 'branch_smoke' });
    window.FirstMateAppContext.installProjectContextAccessors(model, { overwrite: true });
    const host = smokeHost(model);
    seedPanelHtml(app, model);

    const surface = (app.surfaces || []).includes('portal_tab')
      ? 'portal_tab'
      : ((app.surfaces || []).includes('project_modal') ? 'project_modal' : ((app.surfaces || [])[0] || 'embedded'));
    const target = surface === 'project_modal'
      ? { main: root, left: document.getElementById('smokeLeft'), overlay: document.getElementById('smokeOverlay') }
      : root;
    const handle = await runtime.mount(target, appId, {
      surface,
      source: 'independent_app_smoke',
      chrome: surface,
      project: model.state.activeBaseProject,
      projectId: model.state.activeBaseProject.id,
      projectModel: model,
      model,
      host,
      orgId: 'org_smoke',
      branchId: 'branch_smoke',
      params: { smoke: true }
    });
    handle?.setActive?.(true);
    handle?.renderAll?.();
    handle?.renderManager?.();
    handle?.renderPreview?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assertProjectRequestOpensPlatformProject();
    await assertPhotoFeedOpensHydratedPlatformProject();

    const isVisualApp = ['portal_tab', 'project_modal'].includes(surface);
    const visualScope = app.kind === 'modal_app' ? document.body : root;
    const hasVisibleOutput = !!visualScope.textContent.trim() || !!visualScope.querySelector('canvas,img,video,iframe,button,input,textarea,svg,.r-preview-panel,.fm-tabpanel,.r-overlay,.b-overlay');
    if (visualScope.querySelector('.fm-app-unavailable') || /host is unavailable|Smoke .* host rendered/i.test(visualScope.textContent || '')) {
      throw new Error('Mounted through a host fallback instead of app-owned rendering.');
    }
    if (isVisualApp && !hasVisibleOutput) throw new Error('Mounted without visible output.');
    if (errors.length) throw new Error(errors.slice(0, 5).join(' | '));
    report(true, `${surface}; loaded ${loadedScripts.size} script(s)`);
  }

  document.addEventListener('DOMContentLoaded', () => {
    run().catch((error) => {
      const all = [...errors, error?.message || String(error)].filter(Boolean);
      report(false, all.slice(0, 6).join(' | '));
    });
  });
})();
