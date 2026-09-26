/* public/libraries/apps/smoke/independent-load-frame.js */
(function(){
  const smokeCase = window.__FM_APP_SMOKE_CASE || {};
  const appId = String(smokeCase.id || '').trim();
  const realAppId = appId === 'project.request.map-transition' ? 'project.request' : appId;
  const runtime = window.FirstMateEmbeddableApps;
  const errors = [];
  const loadedScripts = new Set();
  const cacheBust = String(smokeCase.cacheBust || Date.now());
  const crewSmokeReadOnly = new URLSearchParams(location.search || '').get('crewReadOnly') === '1';

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
    const crewSmoke = /^(portal|project)\.crew_/.test(realAppId);
    const crewReadOnly = new URLSearchParams(location.search || '').get('crewReadOnly') === '1';
    const entitlementIds = realAppId === 'project.request'
      ? ['project.request','project.map','project.photos','project.proposal','project.docs','project.materials','project.money','project.customer_portal','project.schedule','project.measurements']
      : [realAppId];
    const smokeEntitlements = entitlementIds.map((entitlementId) => ({
      id:entitlementId,
      enabled:true,
      allowed:true,
      visible:true,
      params:crewSmoke ? { can_append:!crewReadOnly, can_upload:!crewReadOnly, can_upload_receipt:!crewReadOnly, can_take_payment:!crewReadOnly, can_manage:!crewReadOnly, can_complete:!crewReadOnly, time_clock_enabled:!crewReadOnly } : {},
      layout:crewSmoke ? { left_column:'none', uses_left_column:false } : {}
    }));
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
        postAction: (action, payload = {}) => {
          if (window.__FM_MAP_TRANSITION_TEST && action === 'queue') {
            const address = String(payload.address || '21722 SE 32nd Pl, Sammamish, WA 98075, USA');
            return okJson({
              project: {
                id: 'project_map_transition',
                platform_project_id: 'project_map_transition',
                base_project_id: 'project_map_transition',
                address,
                project_type: payload.project_type || 'residential',
                workflow_state: 'measurement_ordered',
                status: 'submitted',
                measurement: {
                  id: 'measurement_map_transition',
                  project_id: 'measurement_map_transition',
                  folder: 'measurement_map_transition',
                  status: 'submitted',
                  report_mode: payload.report_mode || 'full',
                  raw: { status: 'submitted', manifest: { status: 'submitted', report_mode: payload.report_mode || 'full' } }
                },
                measurement_project: {
                  id: 'measurement_map_transition',
                  project_id: 'measurement_map_transition',
                  folder: 'measurement_map_transition',
                  status: 'submitted',
                  report_mode: payload.report_mode || 'full',
                  raw: { status: 'submitted', manifest: { status: 'submitted', report_mode: payload.report_mode || 'full' } }
                },
                pins: []
              },
              manifest: {
                status: 'submitted',
                report_mode: payload.report_mode || 'full',
                amount_charged: 7
              }
            });
          }
          return okJson();
        },
        hasPerm: () => true,
        enableSafeBackdropClose,
        formatDate: (value) => value ? new Date(value).toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.()) : '',
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
            project_photos: !window.__FM_MAP_TRANSITION_TEST,
            photos_feed: true,
            proposals: !window.__FM_MAP_TRANSITION_TEST,
            materials: !window.__FM_MAP_TRANSITION_TEST,
            money: !window.__FM_MAP_TRANSITION_TEST,
            pricebook: true,
            customer_portal: !window.__FM_MAP_TRANSITION_TEST,
            customer_portal_media: !window.__FM_MAP_TRANSITION_TEST,
            scheduling: !window.__FM_MAP_TRANSITION_TEST,
            project_docs: !window.__FM_MAP_TRANSITION_TEST,
            contacts: !window.__FM_MAP_TRANSITION_TEST,
            left_column_todo_list: !window.__FM_MAP_TRANSITION_TEST,
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
      permissions: realAppId === 'project.money' ? { manage_projects:true } : {},
      capabilities: {},
      routeState: { set(){}, get(){ return {}; } },
      currentTheme: {}
    };
    Portal.currentUser = {
      id:'user_smoke',
      user_id:'user_smoke',
      permissions:{ '*':true },
      roleIds:crewSmoke ? ['crew_foreman'] : ['super_admin'],
      applicationAccess:{
        management:{ enabled:!crewSmoke, role_id:crewSmoke ? '' : 'super_admin', permissions:{ '*':true } },
        field:{ enabled:crewSmoke, role_id:crewSmoke ? 'crew_foreman' : '', permissions:{ '*':crewSmoke } }
      },
      entitlements:smokeEntitlements,
      appEntitlements:smokeEntitlements
    };
    window.Portal = Portal;
    document.documentElement.dataset.smokeStubEntitlements = JSON.stringify(window.Portal.currentUser.entitlements || {});

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
          return { ...project, photos: Array.isArray(project.photos) ? project.photos : [], thumbnail_photo_id: '', thumbnail_photo: null };
        },
        normalizePhoto(photo = {}, options = {}) {
          if (typeof photo === 'string') return { id: photo, src: photo, thumb: photo, label: ((v0) => globalThis.PlatformLanguage?.text("smoke","m_7b2459374254fa",`Photo ${v0}`,{v0}) ?? `Photo ${v0}`)(options.index || 1) };
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
            { id: 'scheduled', label: (globalThis.PlatformLanguage?.text("smoke","m_6abe57e6a307d5","Scheduled") ?? "Scheduled") },
            { id: 'completed', label: (globalThis.PlatformLanguage?.text("smoke","m_3c4d2141b2fa1c","Completed") ?? "Completed") },
            { id: 'overdue', label: (globalThis.PlatformLanguage?.text("smoke","m_cda60f7c71e465","Overdue") ?? "Overdue") },
            { id: 'unscheduled', label: (globalThis.PlatformLanguage?.text("smoke","m_2b7432531aba4c","Unscheduled") ?? "Unscheduled") }
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
          { id: 'scheduled', label: (globalThis.PlatformLanguage?.text("smoke","m_6abe57e6a307d5","Scheduled") ?? "Scheduled"), items: [], projects: [], events: [] },
          { id: 'unscheduled', label: (globalThis.PlatformLanguage?.text("smoke","m_2b7432531aba4c","Unscheduled") ?? "Unscheduled"), items: [], projects: [], events: [] }
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
      renderDailyTeam(root) { if (root) root.innerHTML = `<div class="r-schedule-empty">${(globalThis.PlatformLanguage?.htmlText("smoke","m_1f1a69778b4a79","Smoke schedule rendered.") ?? "Smoke schedule rendered.")}</div>`; },
      updateDraft() {}
    };
    window.CanvassingAPI = {
      settings: {
        get: () => Promise.resolve({
          settings: {
            enabled: true,
            statuses: [
              { id: 'new', label: (globalThis.PlatformLanguage?.text("smoke","m_96834d2fc9c9a5","New") ?? "New"), color: '#2563eb' },
              { id: 'knocked', label: (globalThis.PlatformLanguage?.text("smoke","m_a8ec9f6bd315b8","Knocked") ?? "Knocked"), color: '#16a34a' },
              { id: 'follow_up', label: (globalThis.PlatformLanguage?.text("smoke","m_7bb6770732db90","Follow Up") ?? "Follow Up"), color: '#d97706' }
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
        if (root) root.innerHTML = `<div class="cs-note">${(globalThis.PlatformLanguage?.htmlText("smoke","m_682f6abc604b8e","Smoke settings rendered.") ?? "Smoke settings rendered.")}</div>`;
        return { destroy(){} };
      }
    };
    window.FirstMateMarkup = {
      openPhotoViewer: () => ({ updateMarkupLayerBounds(){} }),
      markupColorPaletteHtml: () => '',
      rememberMarkupColor: () => {}
    };
  }

  function setupGoogleMapsSmokeApi(){
    if (window.google?.maps?.Map) return;
    const maps = {};
    class LatLng {
      constructor(lat, lng){ this._lat = Number(lat); this._lng = Number(lng); }
      lat(){ return this._lat; }
      lng(){ return this._lng; }
    }
    maps.LatLng = LatLng;
    maps.Size = class { constructor(width, height){ this.width = width; this.height = height; } };
    maps.Point = class { constructor(x, y){ this.x = x; this.y = y; } };
    maps.LatLngBounds = class {
      constructor(){ this.points = []; }
      extend(point){ this.points.push(point); }
    };
    maps.Map = class {
      constructor(el, options = {}){
        this.el = el;
        this.options = { ...options };
        this.center = options.center || { lat: 0, lng: 0 };
        this.zoom = options.zoom || 4;
        this.mapTypeId = options.mapTypeId || 'roadmap';
        el.innerHTML = `<div class="gm-style" data-smoke-google-map="1" style="position:absolute;inset:0;background:#9fc5e8;"><div style="position:absolute;left:12px;top:12px;background:#fff;padding:6px;border-radius:4px;font:12px Arial;">${(globalThis.PlatformLanguage?.htmlText("smoke","m_a0185be1d3bc11","Smoke Google Map") ?? "Smoke Google Map")}</div></div>`;
      }
      getDiv(){ return this.el; }
      addListener(){ return { remove(){} }; }
      setOptions(options){ this.options = { ...this.options, ...(options || {}) }; }
      setCenter(point){ this.center = point; this.el.dataset.center = `${Number(point.lat ?? point.lat?.() ?? 0)},${Number(point.lng ?? point.lng?.() ?? 0)}`; }
      setZoom(zoom){ this.zoom = zoom; this.el.dataset.zoom = String(zoom); }
      getZoom(){ return this.zoom; }
      setMapTypeId(value){ this.mapTypeId = value; this.el.dataset.mapType = value; }
      setTilt(value){ this.tilt = value; }
      setHeading(value){ this.heading = value; }
      fitBounds(){ this.el.dataset.fitBounds = '1'; }
    };
    maps.Marker = class {
      constructor(options = {}){ this.options = options; this.position = options.position; this.map = options.map || null; }
      addListener(){ return { remove(){} }; }
      getPosition(){ const p = this.position || { lat: 0, lng: 0 }; return typeof p.lat === 'function' ? p : new LatLng(p.lat, p.lng); }
      setMap(map){ this.map = map; }
      setIcon(icon){ this.icon = icon; }
    };
    maps.Geocoder = class {
      geocode(request, callback){
        const location = request?.location || new LatLng(47.5906, -122.0423);
        const point = typeof location.lat === 'function' ? location : new LatLng(47.5906, -122.0423);
        setTimeout(() => callback([{
          formatted_address: '21722 SE 32nd Pl, Sammamish, WA 98075, USA',
          address_components: [],
          geometry: { location: point }
        }], 'OK'), 20);
      }
    };
    maps.MaxZoomService = class { getMaxZoomAtLatLng(_location, callback){ callback({ status: 'OK', zoom: 20 }); } };
    maps.places = {};
    maps.event = { trigger(){} };
    window.google = { maps };
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

  function setupMoneySmokeApiCase(){
    if (!['project.money', 'portal.receipts'].includes(realAppId)) return;
    const materialTargets = [
      { target_key:'scope_resource_list:smoke_shingles', source_type:'scope_resource_list', source_id:'smoke_shingles', title:(globalThis.PlatformLanguage?.text("smoke","m_3d5c2fb4a7881f","Shingle materials") ?? "Shingle materials"), resource_type:'material', color:'#d93025', projected_cents:950000, actual_override_cents:null },
      { target_key:'scope_resource_list:smoke_dry_in', source_type:'scope_resource_list', source_id:'smoke_dry_in', title:(globalThis.PlatformLanguage?.text("smoke","m_506a5ed1cbd0b4","Dry-in materials") ?? "Dry-in materials"), resource_type:'material', color:'#2563eb', projected_cents:500000, actual_override_cents:null }
    ];
    const laborTarget = { target_key:'scope_resource_list:smoke_labor', source_type:'scope_resource_list', source_id:'smoke_labor', title:(globalThis.PlatformLanguage?.text("smoke","m_107b29d920f3c1","Installation labor") ?? "Installation labor"), resource_type:'labor', color:'#7c3aed', projected_cents:300000, actual_override_cents:null, details:{ hourly_cents:90000, salary_cents:50000, piece_rate_cents:160000, details:[] } };
    const equipmentTarget = { target_key:'scope_resource_list:smoke_equipment', source_type:'scope_resource_list', source_id:'smoke_equipment', title:(globalThis.PlatformLanguage?.text("smoke","m_4527f0b7a74638","Roofing equipment") ?? "Roofing equipment"), resource_type:'equipment', color:'#0f766e', projected_cents:100000, actual_override_cents:120000 };
    const receipt = { id:'receipt_smoke_1', project_id:'project_smoke_1', revision:3, title:(globalThis.PlatformLanguage?.text("smoke","m_2acc3856f7ff6e","ABC Supply invoice") ?? "ABC Supply invoice"), status:'applied', total_cents:1500000, currency:'USD', purchase_date:'2026-07-10', purchase_time:'14:15:00', uploaded_at:'2026-07-10T21:18:00Z', uploaded_by:{ user_id:'user_smoke', name:'Smoke Tester', email:'smoke@example.com' }, file:{ file_name:'abc-supply.pdf', content_type:'application/pdf', size_bytes:184000 }, attributed_target_keys:materialTargets.map((target) => target.target_key), suggested_target_keys:materialTargets.map((target) => target.target_key), extraction:{ vendor_name:'ABC Supply', line_items:[{ description:(globalThis.PlatformLanguage?.text("smoke","m_e7bc0e59713cd7","Roofing package") ?? "Roofing package"), total_cents:1500000 }], warnings:[] } };
    const groups = [
      { id:'expense_group_materials', grouped:true, target_keys:materialTargets.map((target) => target.target_key), title:(globalThis.PlatformLanguage?.text("smoke","m_8dc8d1dbf4ad8b","2 linked expense lists") ?? "2 linked expense lists"), targets:materialTargets, receipts:[receipt], receipt_ids:[receipt.id], projected_cents:1450000, actual_cents:1500000, current_cents:1500000, variance_cents:50000, actual_source:'receipts' },
      { id:'expense_group_labor', grouped:false, target_keys:[laborTarget.target_key], title:laborTarget.title, targets:[laborTarget], receipts:[], receipt_ids:[], projected_cents:300000, actual_cents:null, current_cents:300000, variance_cents:null, actual_source:'projection' },
      { id:'expense_group_equipment', grouped:false, target_keys:[equipmentTarget.target_key], title:equipmentTarget.title, targets:[equipmentTarget], receipts:[], receipt_ids:[], projected_cents:100000, actual_cents:120000, current_cents:120000, variance_cents:20000, actual_source:'manual_override' }
    ];
    const expenseSummary = {
      project_id:'project_smoke_1', currency:'USD', targets:[...materialTargets,laborTarget,equipmentTarget], groups, receipts:[receipt],
      totals:{ projected_cents:1850000, actual_cents:1620000, current_cents:1920000, variance_cents:70000, actual_group_count:2, projected_group_count:1, receipt_count:1 },
      by_resource:{ material:{ projected_cents:1450000, current_cents:1500000 }, labor:{ projected_cents:300000, current_cents:300000 }, equipment:{ projected_cents:100000, current_cents:120000 }, shared:{ projected_cents:0, current_cents:0 } }
    };
    const summary = {
      project:{ id:'project_smoke_1', title:(globalThis.PlatformLanguage?.text("smoke","m_a7b2a04437d2b1","Smoke Test Project") ?? "Smoke Test Project"), address:'123 Example St' }, project_total_cents:2500000, total_collected_cents:500000, total_remaining_cents:2000000,
      projected_revenue_cents:2500000, revenue_to_date_cents:500000, projected_expenses_cents:1850000, expenses_to_date_cents:200000, actual_expenses_cents:1620000, forecast_expenses_cents:1920000, expense_variance_cents:70000,
      projected_profit_cents:650000, profit_to_date_cents:300000, forecast_profit_cents:580000, materials:{ projected_cents:1450000, paid_cents:200000 }, labor:{ projected_cents:300000, paid_cents:0 }, equipment:{ projected_cents:100000, paid_cents:0 }, expense_summary:expenseSummary,
      schedules:[{ id:'schedule_smoke', title:(globalThis.PlatformLanguage?.text("smoke","m_466b8581b66d28","Signed proposal") ?? "Signed proposal"), status:'active', total_cents:2500000 }],
      obligations:[{ id:'obligation_deposit', schedule_id:'schedule_smoke', label:(globalThis.PlatformLanguage?.text("smoke","m_894309a0cbf8a4","Deposit") ?? "Deposit"), amount_cents:500000, allocated_cents:500000, status:'paid', due_at:'2026-07-01' },{ id:'obligation_final', schedule_id:'schedule_smoke', label:(globalThis.PlatformLanguage?.text("smoke","m_eb3b751277fbeb","Final payment") ?? "Final payment"), amount_cents:2000000, allocated_cents:0, status:'scheduled', due_at:'2026-07-25' }],
      payments:[{ id:'payment_smoke', amount_cents:500000, status:'settled', method:{ label:(globalThis.PlatformLanguage?.text("smoke","m_cc74e4e6c905ec","Check") ?? "Check") }, created_at:'2026-07-01T17:00:00Z', allocations:[] }], payables:[]
    };
    window.PaymentsAPI = {
      projects:{ summary:() => Promise.resolve({ summary }), expenses:() => Promise.resolve({ expense_summary:expenseSummary }) },
      ledger:{ list:() => Promise.resolve({ ledger:[] }) }, events:{ list:() => Promise.resolve({ events:[] }) },
      expenses:{ create:() => Promise.resolve({ expense_summary:expenseSummary }), update:() => Promise.resolve({ expense_summary:expenseSummary }), setActual:() => Promise.resolve({ expense_summary:expenseSummary }) },
      receipts:{ list:() => Promise.resolve({ receipts:[receipt] }), listFor:() => Promise.resolve({ receipts:[receipt] }), upload:() => Promise.resolve({ receipt, expense_summary:expenseSummary }), get:() => Promise.resolve({ receipt }), update:() => Promise.resolve({ receipt }), apply:() => Promise.resolve({ receipt, expense_summary:expenseSummary }), extract:() => Promise.resolve({ receipt, expense_summary:expenseSummary }), remove:() => Promise.resolve({ receipt:{...receipt,status:'void'}, expense_summary:expenseSummary }), fileUrl:() => '#' },
      payments:{ create:() => Promise.resolve({ payment:{ id:'payment_new', amount_cents:10000 } }), get:() => Promise.resolve({}), refund:() => Promise.resolve({}), reallocate:() => Promise.resolve({}) },
      intents:{ create:() => Promise.resolve({}) }, payables:{ list:() => Promise.resolve({ payables:[] }), create:() => Promise.resolve({}), remove:() => Promise.resolve({}) }, disbursements:{ create:() => Promise.resolve({}) }
    };
  }

  function setupCrewSmokeApiCase(){
    if (!/^(portal|project)\.crew_/.test(realAppId)) return;
    const project = {
      id:'project_smoke_1', title:(globalThis.PlatformLanguage?.text("smoke","m_f846ca95ed55a3","Smith Roof Replacement") ?? "Smith Roof Replacement"), project_name:'Smith Roof Replacement',
      address:'123 Example St', customer_name:'Example Customer', customer_phone:'(555) 010-2026',
      notes:'Protect landscaping and confirm the final walkthrough.', scope_name:'Roofing', scope_color:'#d93025',
      scope_icon:'fa-house-chimney', scheduled_start:'2026-07-11T08:00:00-07:00', scheduled_end:'2026-07-11T16:00:00-07:00',
      schedule:{ start_at:'2026-07-11T08:00:00-07:00', end_at:'2026-07-11T16:00:00-07:00', start_date:'2026-07-11', end_date:'2026-07-12', specific_time:true, all_day:false, day_number:1, total_days:2 },
      status:'scheduled'
    };
    const overdueProject = { ...project, id:'project_smoke_overdue', title:(globalThis.PlatformLanguage?.text("smoke","m_179e8a67c84513","Jones Gutter Repair") ?? "Jones Gutter Repair"), project_name:'Jones Gutter Repair', address:'456 Past Due Ave', overdue:true, scope_name:'Gutters', scope_color:'#2563eb', scope_icon:'fa-cloud-rain', schedule:{ start_date:'2026-07-09', end_date:'2026-07-10', specific_time:false, all_day:true, day_number:3, total_days:2 } };
    const materialList = { id:'materials_smoke', title:(globalThis.PlatformLanguage?.text("smoke","m_25090005be824e","Roofing delivery") ?? "Roofing delivery"), delivery_status:'scheduled', current_items:[{ id:'shingles', description:(globalThis.PlatformLanguage?.text("smoke","m_c3c5f657e2099a","Architectural shingles") ?? "Architectural shingles"), quantity:28, unit:'square', total_cents:1120000 }] };
    const payout = { id:'payout_smoke', project_id:project.id, project_title:project.title, amount_cents:240000, projected_cents:240000, paid_cents:0, status:'open' };
    const dashboard = { today:[project], overdue:[overdueProject], projects:[project,overdueProject], time_clock:{ active:false, status:'clocked_out' } };
    window.CrewAPI = {
      me:{
        dashboard:() => Promise.resolve(dashboard),
        projects:() => Promise.resolve({ projects:[project], assigned_projects:[project] }),
        payouts:() => Promise.resolve({ payouts:[payout], summary:{ owed_cents:240000, paid_cents:0, projected_cents:240000 } }),
        timeClock:() => Promise.resolve({ time_clock:dashboard.time_clock }),
        timeAction:(_orgId, action) => Promise.resolve({ time_clock:{ active:action !== 'clock_out', status:action, clocked_in_at:'2026-07-11T08:00:00-07:00', duration_seconds:7200 } })
      },
      projects:{
        get:() => Promise.resolve({ project }),
        materials:() => Promise.resolve({ material_lists:[materialList] }),
        addMaterialItem:() => Promise.resolve({ material_lists:[materialList] }),
        addMaterialsFromReceipt:() => Promise.resolve({ material_lists:[materialList], extraction:{ line_items:[] } }),
        payouts:() => Promise.resolve({ payouts:[payout], summary:{ projected_cents:240000 } }),
        payments:() => Promise.resolve({ payment_summary:{ total_cents:2500000, due_cents:1000000, paid_cents:500000, next_payment:{ id:'obligation_smoke', amount_cents:500000, due_at:'2026-07-20' }, payments:[{ id:'payment_smoke', amount_cents:500000, status:'settled', created_at:'2026-07-01T12:00:00Z', method:{ kind:'check' } }] } }),
        takePayment:() => Promise.resolve({ payment:{ id:'payment_new', amount_cents:500000, status:'settled' } }),
        changeOrders:() => Promise.resolve({ change_orders:[] }),
        createChangeOrder:() => Promise.resolve({ change_order:{ id:'change_smoke', status:'draft' } }),
        sendChangeOrder:() => Promise.resolve({ change_orders:[] }),
        checklist:() => Promise.resolve({ mode:crewSmokeReadOnly ? 'complete' : 'manage', can_manage:!crewSmokeReadOnly, permissions:{ view:true, complete:!crewSmokeReadOnly, manage:!crewSmokeReadOnly }, items:[{ id:'check_smoke', title:(globalThis.PlatformLanguage?.text("smoke","m_762cdf6fd5abc9","Magnet sweep complete") ?? "Magnet sweep complete"), status:'pending' }] }),
        addChecklistItem:() => Promise.resolve({}),
        updateChecklistItem:() => Promise.resolve({}),
        removeChecklistItem:() => Promise.resolve({})
      }
    };
    window.PaymentsAPI = {
      ...(window.PaymentsAPI || {}),
      receipts:{
        ...((window.PaymentsAPI || {}).receipts || {}),
        listFor:() => Promise.resolve({ receipts:[] }),
        uploadFor:() => Promise.resolve({ receipt:{ id:'receipt_smoke', title:(globalThis.PlatformLanguage?.text("smoke","m_7bce998ebd4129","Smoke receipt") ?? "Smoke receipt"), status:'ready', total_cents:1299 } })
      }
    };
  }

  function setupMaterialsSmokeApiCase(){
    const params = new URLSearchParams(location.search || '');
    if (params.get('materialsCase') !== 'dirty_duplicates') return;
    let materialList = {
      id: 'smoke_dirty_materials',
      title: (globalThis.PlatformLanguage?.text("smoke","m_691187e28aba8e","Materials") ?? "Materials"),
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
    let modalOpenEvents = 0;
    const countModalOpen = (event) => {
      if (event?.detail?.open === true && event?.detail?.id === 'request') modalOpenEvents += 1;
    };
    window.addEventListener('fm:modal:open', countModalOpen);
    const shellyOpen = request.openProject({
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
    const immediateOverlay = document.querySelector('#rOverlay.active');
    if (!immediateOverlay) throw new Error('Project request did not reveal its prepared shell synchronously.');
    if (window.matchMedia('(max-width: 820px)').matches && !immediateOverlay.classList.contains('mobile-info-navigation')) {
      throw new Error('Project request exposed the fullscreen mobile layout before its bottom-sheet presentation was ready.');
    }
    if (document.querySelectorAll('#rOverlay.active').length !== 1 || document.querySelector('#vOverlay.active')) {
      throw new Error('Project request exposed more than one project modal while opening.');
    }
    await shellyOpen;
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.removeEventListener('fm:modal:open', countModalOpen);
    if (modalOpenEvents !== 1) throw new Error(`Project request emitted ${modalOpenEvents} modal openings for one project.`);
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
    modalOpenEvents = 0;
    window.addEventListener('fm:modal:open', countModalOpen);
    const commodoreOpen = request.openProject({
      id: 'project_1p3an301i4cuyn',
      address: '3731 W Commodore Way, Seattle, WA 98199, USA',
      project_type: 'residential'
    }, { tab: 'photos' });
    const switchedOverlay = document.querySelector('#rOverlay.active');
    if (!switchedOverlay || document.querySelectorAll('#rOverlay.active').length !== 1 || document.querySelector('#vOverlay.active')) {
      throw new Error('Switching projects replaced the current modal with another modal shell.');
    }
    await commodoreOpen;
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.removeEventListener('fm:modal:open', countModalOpen);
    if (modalOpenEvents !== 1) throw new Error(`Project switch emitted ${modalOpenEvents} modal openings.`);
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

  async function assertProjectRequestMapTransition(){
    if (appId !== 'project.request.map-transition') return;
    window.__FM_MAP_TRANSITION_TEST = true;
    setupGoogleMapsSmokeApi();
    const request = window.Portal?.modules?.request;
    if (!request?.open) throw new Error('Project request module did not expose open().');
    if (!request?.openProject) throw new Error('Project request module did not expose openProject().');
    request.open(null, { workflow: 'report' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const mapApp = window.Portal?.modules?.projectMap || window.Portal?.ProjectMapApp;
    if (!mapApp?.loadPlaceResult) throw new Error('Project map module did not expose loadPlaceResult().');
    const location = new window.google.maps.LatLng(47.5906, -122.0423);
    mapApp.loadPlaceResult(location, [], '21722 SE 32nd Pl, Sammamish, WA 98075, USA');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await request.openProject({
      id: 'project_map_transition',
      platform_project_id: 'project_map_transition',
      base_project_id: 'project_map_transition',
      address: '21722 SE 32nd Pl, Sammamish, WA 98075, USA',
      project_type: 'residential',
      workflow_state: 'measurement_ordered',
      status: 'submitted',
      measurement: {
        id: 'measurement_map_transition',
        project_id: 'measurement_map_transition',
        folder: 'measurement_map_transition',
        status: 'submitted',
        raw: { status: 'submitted', manifest: { status: 'submitted' } }
      },
      measurement_project: {
        id: 'measurement_map_transition',
        project_id: 'measurement_map_transition',
        folder: 'measurement_map_transition',
        status: 'submitted',
        raw: { status: 'submitted', manifest: { status: 'submitted' } }
      }
    }, { tab: 'measurements' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const measurementsButton = Array.from(document.querySelectorAll('#rProjectViewerTabs [data-tab], #rProjectViewerTabs [data-smoke-tab]'))
      .find((button) => (button.dataset.tab || button.dataset.smokeTab || '').toLowerCase() === 'measurements');
    measurementsButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const reopenMapButton = Array.from(document.querySelectorAll('#rMeasureTabs [data-tab], #rMeasureTabs [data-smoke-tab]'))
      .find((button) => (button.dataset.tab || button.dataset.smokeTab || '').toLowerCase() === 'map');
    if (!reopenMapButton) throw new Error('Measurements Map tab was not rendered for ordered project transition.');
    reopenMapButton.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const transitionedPane = document.querySelector('#rOverlay .r-preview-panel[data-panel="measurements"].active [data-measure-pane="map"].active');
    const transitionedMapRoot = transitionedPane?.querySelector('#rMeasurementMap');
    const transitionedGoogleMap = transitionedPane?.querySelector('#rMeasurementMap #rMap .gm-style');
    const transitionedRect = transitionedMapRoot?.getBoundingClientRect?.();
    window.__FM_MAP_TRANSITION_RESULT = {
      activePanel: document.querySelector('#rOverlay .r-preview-panel.active')?.dataset?.panel || '',
      activeMeasurePane: transitionedPane?.dataset?.measurePane || '',
      hasMapRoot: !!transitionedMapRoot,
      hasGoogleMap: !!transitionedGoogleMap,
      width: transitionedRect?.width || 0,
      height: transitionedRect?.height || 0,
      html: transitionedMapRoot?.innerHTML?.slice(0, 300) || ''
    };
    if (!transitionedPane) throw new Error('Ordered project transition did not activate the Measurements Map pane.');
    if (!transitionedMapRoot || !transitionedRect || transitionedRect.width < 20 || transitionedRect.height < 20) {
      throw new Error(`Ordered project transition Map pane has invalid dimensions: ${transitionedRect?.width || 0}x${transitionedRect?.height || 0}.`);
    }
    if (!transitionedGoogleMap) {
      throw new Error(`Ordered project transition Map pane did not contain a rendered Google map. HTML: ${transitionedMapRoot?.innerHTML?.slice(0, 160) || '(empty)'}`);
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
    const app = manifests.get(realAppId);
    if (!app) throw new Error(`Unknown app id ${realAppId}`);
    if (appId === 'project.request.map-transition') {
      window.__FM_MAP_TRANSITION_TEST = true;
      setupGoogleMapsSmokeApi();
    }
    await loadAppAndDependencies(realAppId, manifests);
    setupMoneySmokeApiCase();
    setupMaterialsSmokeApiCase();
    setupCrewSmokeApiCase();
    await new Promise((resolve) => setTimeout(resolve, 180));

    const root = document.getElementById('smokeRoot');
    const model = window.FirstMateAppContext.createProjectModel({
      project: {
        id: 'project_smoke_1',
        title: (globalThis.PlatformLanguage?.text("smoke","m_a7b2a04437d2b1","Smoke Test Project") ?? "Smoke Test Project"),
        address: '123 Example St',
        project_type: 'residential',
        measurement_project_id: 'measurement_smoke_1',
        contacts: [{ name: 'Example Customer', email: 'customer@example.com', phone: '', primary: true }],
        photos: [],
        proposals: [],
        events: [],
        measurement: { id: 'measurement_smoke_1', project_id: 'measurement_smoke_1', status: 'complete', report_url: '' }
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
    document.documentElement.dataset.smokePremountEntitlements = JSON.stringify(window.Portal?.currentUser?.entitlements || {});
    const handle = await runtime.mount(target, realAppId, {
      currentUser: window.Portal?.currentUser || {},
      applicationAccess: window.Portal?.currentUser?.applicationAccess || {},
      permissions: window.Portal?.currentUser?.permissions || {},
      entitlements: window.Portal?.currentUser?.entitlements || [],
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
    document.documentElement.dataset.smokeResolvedParams = JSON.stringify(handle?.context?.params || {});
    document.documentElement.dataset.smokeEntitlements = JSON.stringify(handle?.context?.entitlements || {});
    document.documentElement.dataset.smokeEntitlement = JSON.stringify(handle?.context?.entitlement || {});
    document.documentElement.dataset.smokeAppId = String(handle?.context?.app?.id || handle?.context?.appId || '');
    document.documentElement.dataset.smokeAccessDecision = JSON.stringify(handle?.context?.accessDecision || {});
    handle?.setActive?.(true);
    handle?.renderAll?.();
    handle?.renderManager?.();
    handle?.renderPreview?.();
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (realAppId === 'project.measurements') await new Promise((resolve) => setTimeout(resolve, 2250));
    await assertProjectRequestMapTransition();
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
