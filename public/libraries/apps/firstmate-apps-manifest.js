/* public/libraries/apps/firstmate-apps-manifest.js
 * Canonical manifest for FirstMate embeddable app packages.
 */
(function(){
  const runtime = window.FirstMateEmbeddableApps;
  if (!runtime?.registerManifest) return;

  const scriptUrl = document.currentScript?.src || '';
  const baseUrl = scriptUrl ? new URL('.', scriptUrl).href : '../libraries/apps/';
  const bundle = (path) => new URL(path, baseUrl).href;
  const versionedBundle = (path, version) => {
    const url = new URL(path, baseUrl);
    url.searchParams.set('v', version);
    return url.href;
  };

  const apps = [
    {
      id: 'portal.viewer',
      package: 'projects',
      title: 'My Projects',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'viewer',
      bundles: [versionedBundle('projects/viewer.js', '20260628-optional-contacting-stage')]
    },
    {
      id: 'portal.contacts',
      package: 'contacts',
      title: 'My Contacts',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'contacts',
      bundles: [versionedBundle('contacts/modal.js', '20260627-contact-book'), versionedBundle('contacts/app.js', '20260628-sales-stage-labels')]
    },
    {
      id: 'portal.photos_feed',
      package: 'photos',
      title: 'Photo Feed',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'photos_feed',
      bundles: [versionedBundle('photos/feed.js', '20260626-photo-left-title-fix')]
    },
    {
      id: 'portal.proposals',
      package: 'proposals',
      title: 'Proposals',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'proposals',
      bundles: [versionedBundle('proposals/global.js', '20260627-global-proposals')]
    },
    {
      id: 'project.photos',
      package: 'photos',
      title: 'Project Photos',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      bundles: [bundle('photos/project.js')]
    },
    {
      id: 'project.proposal',
      package: 'proposals',
      title: 'Project Proposals',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      dependencies: ['project.photos'],
      bundles: [bundle('proposals/project.js')]
    },
    {
      id: 'project.docs',
      package: 'docs',
      title: 'Project Docs',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      bundles: [bundle('docs/project.js')]
    },
    {
      id: 'project.materials',
      package: 'materials',
      title: 'Materials',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      dependencies: ['pricebook.bridge'],
      bundles: [bundle('../materials-api/materials-api.js'), versionedBundle('materials/project.js', '20260626-materials-color-portal3')]
    },
    {
      id: 'project.money',
      package: 'money',
      title: 'Money',
      icon: 'fa-dollar-sign',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      dependencies: ['project.proposal', 'project.materials'],
      bundles: [bundle('../payments-api/payments-api.js'), versionedBundle('money/project.js', '20260628-money-flag-gate')]
    },
    {
      id: 'project.request',
      package: 'project-request',
      title: 'Project Request',
      kind: 'modal_app',
      surfaces: ['modal', 'project_modal'],
      dependencies: ['firstmeasure.order', 'project.map', 'project.photos', 'project.proposal', 'project.materials', 'project.money', 'project.customer_portal', 'project.schedule', 'project.measurements'],
      bundles: [versionedBundle('project-request/app.js', '20260702-prune-stale-map-panel')]
    },
    {
      id: 'firstmeasure.order',
      package: 'firstmeasure/order',
      title: 'FirstMeasure Order Workflow',
      kind: 'project_modal_region_app',
      surfaces: ['project_modal'],
      regions: ['left'],
      bundles: [versionedBundle('firstmeasure/order/app.js', '20260627-stage-bar')]
    },
    {
      id: 'project.map',
      package: 'project-map',
      title: 'Project Overview',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      bundles: [versionedBundle('project-map/app.js', '20260702-inline-root-preferred')]
    },
    {
      id: 'project.customer_portal',
      package: 'customer-portal',
      title: 'Customer Portal',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      bundles: [bundle('customer-portal/project.js')]
    },
    {
      id: 'project.schedule',
      package: 'project-schedule',
      title: 'Project Schedule',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      bundles: [bundle('project-schedule/panel.js')]
    },
    {
      id: 'project.measurements',
      package: 'measurements',
      title: 'Reports',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      bundles: [versionedBundle('measurements/project.js', '20260702-inline-map-reset')]
    },
    {
      id: 'portal.dashboard',
      package: 'scheduling',
      title: 'Scheduling',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'dashboard',
      bundles: [bundle('scheduling/app.js')]
    },
    {
      id: 'portal.calls',
      package: 'calls',
      title: 'Calls',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'calls',
      bundles: [bundle('calls/app.js')]
    },
    {
      id: 'portal.canvassing',
      package: 'canvassing',
      title: 'Canvassing',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'canvassing',
      bundles: [bundle('canvassing/app.js')]
    },
    {
      id: 'portal.company_settings',
      package: 'settings',
      title: 'Settings',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'company_settings',
      bundles: [versionedBundle('settings/company.js', '20260630-report-summary-flag')]
    },
    {
      id: 'billing',
      package: 'billing',
      title: 'Billing',
      kind: 'modal_app',
      surfaces: ['modal', 'service'],
      bundles: [bundle('billing/app.js')]
    },
    {
      id: 'help',
      package: 'help',
      title: 'Help',
      kind: 'ambient_app',
      surfaces: ['ambient', 'service'],
      bundles: [bundle('help/app.js')]
    },
    {
      id: 'onboarding.wizard',
      package: 'onboarding',
      title: 'Onboarding Wizard',
      kind: 'modal_app',
      surfaces: ['modal'],
      bundles: [bundle('onboarding/wizard.js')]
    },
    {
      id: 'promo.bonus_upfront_match',
      package: 'promo-inject',
      title: 'Credit Bonus Promotion',
      kind: 'ambient_app',
      surfaces: ['ambient', 'modal'],
      bundles: [bundle('promo-inject/app.js')]
    },
    {
      id: 'referrals',
      package: 'referrals',
      title: 'Referrals',
      kind: 'ambient_app',
      surfaces: ['ambient', 'modal'],
      bundles: [bundle('referrals/app.js')]
    },
    {
      id: 'pricebook.bridge',
      package: 'pricebook',
      title: 'Pricebook Bridge',
      kind: 'service',
      surfaces: ['service'],
      bundles: [bundle('pricebook/bridge.js')]
    },
    {
      id: 'tutorial',
      package: 'tutorial',
      title: 'Tutorial',
      kind: 'ambient_app',
      surfaces: ['ambient'],
      bundles: [bundle('tutorial/app.js')],
      enabled: false
    }
  ];

  const noopHandle = { destroy(){} };
  const moduleMount = (moduleName, openMethod = 'open') => (context = {}) => {
    const module = window.Portal?.modules?.[moduleName];
    if (module && typeof module[openMethod] === 'function') {
      module[openMethod](context.params || context);
    }
    return {
      destroy(){
        if (module && typeof module.close === 'function') module.close();
      }
    };
  };

  const initialAppDefinitions = {
    'project.request': { mount: moduleMount('request') },
    billing: { mount: moduleMount('billing') },
    'onboarding.wizard': { mount: moduleMount('onboarding_wizard', 'show') },
    help: { mount: () => noopHandle },
    'promo.bonus_upfront_match': { mount: () => noopHandle },
    referrals: { mount: () => noopHandle },
    'pricebook.bridge': { mount: () => noopHandle }
  };

  apps.forEach((app) => {
    runtime.registerManifest(app);
    runtime.registerApp({
      ...app,
      visible: false,
      ...(initialAppDefinitions[app.id] || {})
    });
  });

  window.FirstMateAppsManifest = {
    version: 1,
    apps: apps.map((app) => ({ ...app, bundles: [...(app.bundles || [])] }))
  };
})();
