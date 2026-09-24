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
  // Keep the management shell usable while the session/access API is still
  // loading (or temporarily unavailable). Once access data arrives the runtime
  // still applies application and explicit entitlement denials, but a missing
  // entitlement snapshot must not remove every established portal tab.
  const managementAccess = { applicationsAny: ['management'] };
  const managementShellAccess = { applicationsAny: ['management'] };
  const crewAccess = { applicationsAny: ['field'], devices: ['mobile', 'desktop'], requireEntitlement: true };
  const crewProjectPresentation = {
    projectModal: {
      desktopLeft: 'none',
      mobileLeft: 'none',
      mobileInfo: 'none',
      mobileTabs: 'icons',
      mobileFullscreenControl: false
    }
  };
  const channelsLibBundles = [
    versionedBundle('../platform-realtime/platform-realtime.js', '20260723-channels-v1'),
    versionedBundle('../channels-api/channels-api.js', '20260723-channels-v1'),
    versionedBundle('../audio-notes/audio-notes.js', '20260725-communications-voice-v2'),
    versionedBundle('../audio-structure/audio-structure.js', '20260725-checklist-voice-v1'),
    versionedBundle('../window-manager/window-manager.js', '20260907-windows-v1'),
    versionedBundle('../channels-ui/channels-ui.js', '20260723-channels-v1'),
    versionedBundle('../project-notes/project-notes.js', '20260723-channels-notes')
  ];
  const fieldApprovalBundles = [
    versionedBundle('../crew-api/crew-api.js', '20260803-field-flows-v10'),
    versionedBundle('../field-visit/field-visit.js', '20260803-compact-arrival-v13'),
    versionedBundle('../doc-model/firstmate-doc-model.js', '20260803-field-flows-v10'),
    versionedBundle('../payment-intake/payment-intake.js', '20260803-field-flows-v10'),
    // Same version string as crewBundles so the runtime's URL dedupe keeps a
    // single load; the field checkout resolves provider tokenization here.
    versionedBundle('../payments-api/payments-api.js', '20260714-invoice-line-items-tax'),
    versionedBundle('../doc-widgets/firstmate-doc-widgets.js', '20260803-field-flows-v10'),
    versionedBundle('../doc-renderer/firstmate-doc-renderer.js', '20260803-field-flows-v10'),
    versionedBundle('../doc-workflow/firstmate-doc-workflow.js', '20260803-field-flows-v10'),
    versionedBundle('signatures/project.js', '20260814-field-tokenized-payments-v1')
  ];
  const crewBundles = [
    ...channelsLibBundles,
    ...fieldApprovalBundles,
    versionedBundle('../equipment-api/equipment-api.js', '20260904-equipment-unit-cards-v14'),
    versionedBundle('../payroll-api/payroll-api.js', '20260713-self-service-earnings'),
    versionedBundle('../payments-api/payments-api.js', '20260714-invoice-line-items-tax'),
    versionedBundle('../proposals-api/proposals-api.js', '20260711-crew-change-orders'),
    versionedBundle('crew/app.js', '20260803-single-project-headers-v1')
  ];
  const crewSignatureBundles = [...fieldApprovalBundles];
  const salesBundles = [
    ...fieldApprovalBundles,
    versionedBundle('../sales-api/sales-api.js', '20260801-field-flows-v4'),
    versionedBundle('../payroll-api/payroll-api.js', '20260713-self-service-earnings'),
    versionedBundle('sales/app.js', '20260801-field-flows-v4')
  ];

  const apps = [
    {
      id: 'portal.viewer',
      package: 'projects',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_1a8d3340c06415","My Projects") ?? "My Projects"),
      terminologyKey: 'projects.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'viewer',
      access: managementAccess,
      bundles: [versionedBundle('projects/viewer.js', '20260725-project-board-order-memory')]
    },
    {
      id: 'portal.contacts',
      package: 'contacts',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_2bf043c3cce511","My Contacts") ?? "My Contacts"),
      terminologyKey: 'contacts.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'contacts',
      settingsTabId: 'contacts',
      access: managementAccess,
      bundles: [versionedBundle('contacts/modal.js', '20260725-contact-tags-todos'), versionedBundle('settings/contacts.js', '20260725-contact-workspace-v2'), versionedBundle('contacts/app.js', '20260725-contact-workspace-v2')]
    },
    {
      id: 'portal.photos_feed',
      package: 'photos',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_3eea4dfd8e947d","Feed") ?? "Feed"),
      terminologyKey: 'photos.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'photos_feed',
      access: managementAccess,
      bundles: [versionedBundle('../payments-api/payments-api.js', '20260714-invoice-line-items-tax'), versionedBundle('photos/feed.js', '20260725-unified-feed')]
    },
    {
      id: 'portal.receipts',
      package: 'receipts',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_fc54001a0cc000","Receipts") ?? "Receipts"),
      terminologyKey: 'receipts.portal_tab',
      icon: 'fa-receipt',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'receipts',
      access: managementAccess,
      bundles: [versionedBundle('../payments-api/payments-api.js', '20260714-receipt-browser'), versionedBundle('photos/feed.js', '20260714-media-gallery-adapters'), versionedBundle('receipts/app.js', '20260714-receipt-pdf-preview')]
    },
    {
      // DEPRECATED (2026-08): legacy proposals surface — hidden by its bundle
      // (visible:false). Kept so historical proposals stay debuggable; the
      // document engine + unified Docs tab replace it.
      id: 'portal.proposals',
      package: 'proposals',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_3129f3f0e39249","Proposals") ?? "Proposals"),
      terminologyKey: 'proposals.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'proposals',
      access: managementAccess,
      bundles: [versionedBundle('proposals/global.js', '20260627-global-proposals')]
    },
    {
      id: 'project.photos',
      package: 'photos',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_be4cfb58b9c4d7","Photos") ?? "Photos"),
      terminologyKey: 'photos.project_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [bundle('photos/project.js')]
    },
    {
      // DEPRECATED (2026-08): legacy Proposals project tab — hidden by its
      // bundle (visible:false). The bundle must keep loading: the document
      // engine still bridges into its scope-generation exports (see the
      // project.documents dependency note below).
      id: 'project.proposal',
      package: 'proposals',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_3129f3f0e39249","Proposals") ?? "Proposals"),
      terminologyKey: 'proposals.project_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      dependencies: ['project.photos'],
      bundles: [versionedBundle('proposals/project.js', '20260715-project-notes')]
    },
    {
      id: 'project.docs',
      package: 'docs',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_e1f126038d5b27","Docs") ?? "Docs"),
      terminologyKey: 'documents.project_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [bundle('docs/project.js')]
    },
    {
      id: 'project.documents',
      package: 'documents',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_5d7c7ad6033624","Documents") ?? "Documents"),
      terminologyKey: 'document_engine.project_tab',
      icon: 'fa-file-signature',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      // project.proposal: the legacy module still owns scope generation
      // (proposalBuilderScopeForTemplate — customer choice groups, optional
      // items); without it loaded, workflow generation degrades to raw
      // pricebook rows with no customer-selectable options. Remove when the
      // generator moves into the workflow runtime at legacy teardown.
      dependencies: ['pricebook.bridge', 'project.proposal'],
      bundles: [
        versionedBundle('../documents-api/documents-api.js', '20260811-folder-history'),
        versionedBundle('../doc-model/firstmate-doc-model.js', '20260811-word-doc-v1'),
        versionedBundle('../doc-widgets/firstmate-doc-widgets.js', '20260811-doc-audio'),
        versionedBundle('../doc-renderer/firstmate-doc-renderer.js', '20260811-word-doc-v4'),
        versionedBundle('../doc-editor/firstmate-doc-editor.js', '20260813-theme-styles-restored'),
        versionedBundle('photos/feed.js', '20260811-document-media-picker'),
        bundle('../agents-api/agents-api.js'),
        bundle('../agent-chat/agent-chat.js'),
        versionedBundle('../doc-agent/doc-agent.js', '20260812-agent-command-actions'),
        versionedBundle('documents/project.js', '20260812-agent-command-actions')
      ]
    },
    {
      id: 'documents.studio',
      package: 'documents',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_d1e8bdb71c4dd5","Doc Studio") ?? "Doc Studio"),
      terminologyKey: 'document_engine.studio_tab',
      icon: 'fa-pen-ruler',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'documents_studio',
      settingsTabId: 'documents',
      access: managementAccess,
      params: {
        studioSection: { default:'templates', values:['templates','workflows','themes','folder'], history:'push' },
        studioFolder: { history:'push' },
        studioDocument: { history:'push' }
      },
      bundles: [
        versionedBundle('../documents-api/documents-api.js', '20260811-folder-history'),
        versionedBundle('../doc-model/firstmate-doc-model.js', '20260811-word-doc-v1'),
        versionedBundle('../doc-widgets/firstmate-doc-widgets.js', '20260811-doc-audio'),
        versionedBundle('../doc-renderer/firstmate-doc-renderer.js', '20260811-word-doc-v4'),
        versionedBundle('../doc-editor/firstmate-doc-editor.js', '20260813-theme-styles-restored'),
        versionedBundle('photos/feed.js', '20260811-document-media-picker'),
        bundle('../agents-api/agents-api.js'),
        bundle('../agent-chat/agent-chat.js'),
        versionedBundle('../doc-agent/doc-agent.js', '20260812-agent-command-actions'),
        versionedBundle('documents/studio.js', '20260813-theme-styles-restored')
      ]
    },
    {
      id: 'portal.web_editor',
      package: 'web-editor',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_e4dceacd1d07d0","Web Editor") ?? "Web Editor"),
      terminologyKey: 'web_editor.tab',
      icon: 'fa-globe',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'web_editor',
      access: managementAccess,
      bundles: [
        versionedBundle('../websites-api/websites-api.js', '20260731-domains-v10'),
        versionedBundle('../domains-api/domains-api.js', '20260731-domains-v10'),
        versionedBundle('../doc-model/firstmate-doc-model.js', '20260726-doc-tiers'),
        versionedBundle('../doc-widgets/firstmate-doc-widgets.js', '20260728-legal-parity'),
        versionedBundle('../doc-renderer/firstmate-doc-renderer.js', '20260726-doc-tiers'),
        versionedBundle('../web-widgets/firstmate-web-widgets.js', '20260728-web-editor-v1'),
        versionedBundle('../portal-widgets/firstmate-portal-widgets.js', '20260801-portal-builder-v1'),
        versionedBundle('../doc-editor/firstmate-doc-editor.js', '20260813-theme-styles-restored'),
        versionedBundle('../visual-editor/firstmate-visual-editor.js', '20260813-modes-in-toolbar'),
        versionedBundle('settings/domains.js', '20260731-domains-v11'),
        versionedBundle('web-editor/app.js', '20260813-modes-in-toolbar')
      ]
    },
    {
      id: 'project.materials',
      package: 'materials',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_9d3e82ecfd10ec","Scope") ?? "Scope"),
      terminologyKey: 'scope.project_tab',
      icon: 'fa-clipboard-list',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      dependencies: ['pricebook.bridge'],
      bundles: [...channelsLibBundles, bundle('../materials-api/materials-api.js'), versionedBundle('../payments-api/payments-api.js', '20260714-invoice-line-items-tax'), versionedBundle('materials/project.js', '20260723-channels-v1')]
    },
    {
      id: 'project.money',
      package: 'money',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_05cb9dd7e5a780","Money") ?? "Money"),
      terminologyKey: 'money.project_tab',
      icon: 'fa-dollar-sign',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      dependencies: ['project.proposal', 'project.materials'],
      bundles: [versionedBundle('../payments-api/payments-api.js', '20260730-payment-reconciliation'), versionedBundle('../payroll-api/payroll-api.js', '20260714-scope-commission-rules'), versionedBundle('../documents-api/documents-api.js', '20260730-money-reports'), versionedBundle('payroll/project.js', '20260714-money-commissions'), versionedBundle('photos/feed.js', '20260714-media-gallery-adapters'), versionedBundle('receipts/app.js', '20260714-receipt-pdf-preview'), versionedBundle('money/project.js', '20260730-reports-reconciliation')]
    },
    {
      id: 'project.request',
      package: 'project-request',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_f973900d181c17","Project Request") ?? "Project Request"),
      kind: 'modal_app',
      surfaces: ['modal', 'project_modal'],
      access: { applicationsAny: ['management', 'field'] },
      dependencies: ['firstmeasure.order', 'project.map', 'project.photos', 'project.proposal', 'project.materials', 'project.money', 'project.customer_portal', 'project.schedule', 'project.measurements', 'project.checklists'],
      bundles: [...channelsLibBundles, versionedBundle('project-request/app.js', '20260803-visit-identity-v2')]
    },
    {
      id: 'firstmeasure.order',
      package: 'firstmeasure/order',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_83a10fdb954ac4","FirstMeasure Order Workflow") ?? "FirstMeasure Order Workflow"),
      kind: 'project_modal_region_app',
      surfaces: ['project_modal'],
      regions: ['left'],
      access: managementShellAccess,
      bundles: [...channelsLibBundles, versionedBundle('firstmeasure/order/app.js', '20260723-channels-v1')]
    },
    {
      id: 'project.map',
      package: 'project-map',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_b69161f38dacdf","Overview") ?? "Overview"),
      terminologyKey: 'projects.overview_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [versionedBundle('project-map/app.js', '20260702-inline-root-preferred')]
    },
    {
      id: 'project.customer_portal',
      package: 'customer-portal',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal"),
      terminologyKey: 'customer_portal.project_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [bundle('customer-portal/project.js')]
    },
    {
      id: 'project.schedule',
      package: 'project-schedule',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_fc05a804bd034c","Schedule") ?? "Schedule"),
      terminologyKey: 'scheduling.project_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [versionedBundle('project-schedule/panel.js', '20260710-project-production-groups')]
    },
    {
      id: 'project.comms',
      package: 'comms',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_da0c54815d9259","Comms") ?? "Comms"),
      terminologyKey: 'comms.project_tab',
      icon: 'fa-comments',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [bundle('../comms-api/comms-api.js'), bundle('../agent-chat/agent-chat.js'), bundle('comms/communications-ui.js'), bundle('comms/calling-runtime.js'), bundle('comms/workspace.js'), bundle('comms/project.js')]
    },
    {
      id: 'project.measurements',
      package: 'measurements',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_fc81637c875032","Reports") ?? "Reports"),
      terminologyKey: 'reports.project_tab',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [versionedBundle('measurements/project.js', '20260702-inline-map-reset')]
    },
    {
      id: 'project.checklists',
      package: 'checklists',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_4890d3d11dc3eb","Checklists") ?? "Checklists"),
      terminologyKey: 'checklists.project_tab',
      icon: 'fa-list-check',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      access: managementAccess,
      bundles: [
        versionedBundle('../crew-api/crew-api.js', '20260723-crew-assignees'),
        versionedBundle('checklists/app.js', '20260725-checklist-assignment-v2')
      ]
    },
    {
      id: 'portal.scheduling',
      package: 'scheduling',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_4249990706c50e","Scheduling") ?? "Scheduling"),
      terminologyKey: 'scheduling.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'scheduling',
      settingsTabId: 'scheduling',
      access: managementAccess,
      bundles: [bundle('scheduling/app.js')]
    },
    {
      id: 'portal.training',
      package: 'training',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_de9da7671834b2","Training") ?? "Training"),
      terminologyKey: 'training.portal_tab',
      icon: 'fa-graduation-cap',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'training',
      order: 58,
      access: { applicationsAny: ['management', 'field'] },
      bundles: [
        versionedBundle('../training-api/training-api.js', '20260720-training-v1'),
        versionedBundle('training/app.js', '20260720-training-v1')
      ]
    },
    {
      id: 'portal.training_studio',
      package: 'training-studio',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_2b81e8bab27da3","Training Studio") ?? "Training Studio"),
      terminologyKey: 'training.studio_portal_tab',
      icon: 'fa-chalkboard-user',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'training_studio',
      order: 59,
      access: managementAccess,
      bundles: [
        versionedBundle('../training-api/training-api.js', '20260720-training-v1'),
        versionedBundle('training/app.js', '20260720-training-v1'),
        versionedBundle('training/studio.js', '20260720-training-v1')
      ]
    },
    {
      id: 'portal.equipment',
      package: 'equipment',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_2813f320a63b94","Equipment") ?? "Equipment"),
      terminologyKey: 'equipment.portal_tab',
      icon: 'fa-truck-pickup',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'equipment',
      settingsTabId: 'equipment',
      order: 57,
      access: managementAccess,
      bundles: [
        versionedBundle('../equipment-api/equipment-api.js', '20260904-equipment-unit-cards-v14'),
        versionedBundle('settings/equipment.js', '20260725-equipment-v1'),
        versionedBundle('equipment/app.js', '20260904-equipment-unit-cards-v14')
      ]
    },
    {
      id: 'portal.invoices',
      package: 'invoices',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_74b68c454b06a0","Invoices") ?? "Invoices"),
      terminologyKey: 'invoices.portal_tab',
      icon: 'fa-file-invoice-dollar',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'invoices',
      order: 51,
      access: managementAccess,
      bundles: [
        versionedBundle('../payments-api/payments-api.js', '20260803-invoices-tab'),
        versionedBundle('invoices/app.js', '20260803-invoices-tab')
      ]
    },
    {
      id: 'portal.financials',
      package: 'financials',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_187b087cb700ce","Financials") ?? "Financials"),
      terminologyKey: 'financials.portal_tab',
      icon: 'fa-chart-line',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'financials',
      order: 52,
      access: managementAccess,
      params: {
        financialView: { default:'projects', history:'push' },
        financialGrain: { default:'month', history:'replace' },
        financialDate: { history:'replace' }
      },
      bundles: [
        versionedBundle('../financials-api/financials-api.js', '20260715-financial-read-model'),
        versionedBundle('../payments-api/payments-api.js', '20260812-finance-read-models'),
        versionedBundle('financials/app.js', '20260812-payouts-view')
      ]
    },
    {
      id: 'portal.stats',
      package: 'stats',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_bd451534def6c4","Stats") ?? "Stats"),
      terminologyKey: 'stats.portal_tab',
      icon: 'fa-chart-column',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'stats',
      order: 53,
      access: managementAccess,
      params: {
        statsView: { history:'push' },
        statsThread: { history:'replace' }
      },
      bundles: [
        versionedBundle('../stats-api/stats-api.js', '20260722-stats-v10'),
        versionedBundle('stats/app.js', '20260722-stats-v10')
      ]
    },
    {
      id: 'portal.payroll',
      package: 'payroll',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_45e0abb75231e4","Payroll") ?? "Payroll"),
      terminologyKey: 'payroll.portal_tab',
      icon: 'fa-money-check-dollar',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'payroll',
      settingsTabId: 'payroll',
      order: 55,
      access: managementAccess,
      bundles: [versionedBundle('../payroll-api/payroll-api.js', '20260712-payroll-v1'), versionedBundle('settings/payroll.js', '20260715-payroll-settings-workspace'), versionedBundle('payroll/app.js', '20260715-payroll-settings-workspace')]
    },
    {
      id: 'portal.chat',
      package: 'chat',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_643fa01aa77d59","Communications") ?? "Communications"),
      terminologyKey: 'chat.portal_tab',
      icon: 'fa-inbox',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'chat',
      access: managementAccess,
      bundles: [
        bundle('../comms-api/comms-api.js'),
        bundle('../agents-api/agents-api.js'),
        bundle('../agent-chat/agent-chat.js'),
        bundle('comms/communications-ui.js'),
        bundle('comms/calling-runtime.js'),
        bundle('comms/workspace.js'),
        bundle('chat/app.js')
      ]
    },
    {
      id: 'portal.channels',
      package: 'channels',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_dc8b4f6c066b30","Channels") ?? "Channels"),
      terminologyKey: 'channels.portal_tab',
      icon: 'fa-comments',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'channels',
      settingsTabId: 'channels',
      order: 44,
      access: { applicationsAny: ['management', 'field'] },
      bundles: [
        versionedBundle('../platform-realtime/platform-realtime.js', '20260723-channels-v1'),
        versionedBundle('../channels-api/channels-api.js', '20260723-channels-v1'),
        versionedBundle('../audio-notes/audio-notes.js', '20260725-communications-voice-v2'),
        versionedBundle('../window-manager/window-manager.js', '20260907-windows-v1'),
        versionedBundle('../channels-ui/channels-ui.js', '20260723-channels-v1'),
        versionedBundle('channels/app.js', '20260723-channels-v1')
      ]
    },
    {
      id: 'portal.canvassing',
      package: 'canvassing',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_88f66f0b968bb2","Canvassing") ?? "Canvassing"),
      terminologyKey: 'canvassing.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'canvassing',
      access: managementAccess,
      bundles: [bundle('canvassing/app.js')]
    },
    {
      id: 'portal.feedback',
      package: 'feedback',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_d77e00c8c3f0b8","Feedback") ?? "Feedback"),
      icon: 'fa-star',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'feedback',
      settingsTabId: 'feedback',
      params: { feedbackView: { default:'responses', values:['responses','delivery','workflow'], history:'push' } },
      placement: 'more',
      order: 56,
      access: managementAccess,
      bundles: [versionedBundle('../insights/firstmate-insights.js', '20260901-insights-v1'), versionedBundle('settings/feedback.js', '20260917-feedback-app-v1'), versionedBundle('feedback/app.js', '20260917-feedback-app-v1')]
    },
    {
      id: 'portal.company_settings',
      package: 'settings',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_7d461dc7d355cc","Settings") ?? "Settings"),
      terminologyKey: 'settings.portal_tab',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'company_settings',
      placement: 'settings',
      access: managementAccess,
      bundles: [versionedBundle('../custom-fields/firstmate-custom-fields.js', '20260720-custom-fields-v1'), versionedBundle('../payroll-api/payroll-api.js', '20260712-payroll-v1'), versionedBundle('../websites-api/websites-api.js', '20260731-domains-v10'), versionedBundle('../domains-api/domains-api.js', '20260731-domains-v10'), versionedBundle('../insights/firstmate-insights.js', '20260901-insights-v1'), versionedBundle('settings/domains.js', '20260731-domains-v11'), versionedBundle('settings/crm.js', '20260901-calls-configuration-v3'), versionedBundle('settings/contacts.js', '20260725-contact-import-v1'), versionedBundle('settings/payroll.js', '20260712-payroll-v1'), versionedBundle('settings/money-overlay-enforcer.js', '20260828-money-overlay-integrity-v1'), versionedBundle('settings/platform-billing.js', '20260924-unified-billing-v2'), versionedBundle('settings/company.js', '20260924-unified-billing-v2')]
    },
    {
      id: 'portal.crew_overview',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_23929ba4ba84dd","Today") ?? "Today"),
      terminologyKey: 'crew.today_portal_tab',
      icon: 'fa-house',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'crew_overview',
      order: 10,
      access: crewAccess,
      defaultHome: true,
      params: { mode: 'crew', assignedOnly: true },
      bundles: crewBundles
    },
    {
      id: 'portal.crew_schedule',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_fc05a804bd034c","Schedule") ?? "Schedule"),
      terminologyKey: 'scheduling.crew_portal_tab',
      icon: 'fa-calendar-days',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'crew_schedule',
      order: 20,
      access: crewAccess,
      params: { mode: 'crew', crewMode: true, assignedOnly: true },
      bundles: crewBundles
    },
    {
      id: 'portal.crew_receipts',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_fc54001a0cc000","Receipts") ?? "Receipts"),
      terminologyKey: 'receipts.crew_portal_tab',
      icon: 'fa-receipt',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'crew_receipts',
      order: 30,
      access: crewAccess,
      params: { mode: 'crew' },
      bundles: crewBundles
    },
    {
      id: 'portal.crew_payouts',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_685ff0ff145929","Earnings") ?? "Earnings"),
      terminologyKey: 'earnings.crew_portal_tab',
      icon: 'fa-wallet',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'crew_payouts',
      order: 40,
      access: crewAccess,
      params: { mode: 'crew', assignedOnly: true },
      bundles: crewBundles
    },
    {
      id: 'portal.sales_overview',
      package: 'sales',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_23929ba4ba84dd","Today") ?? "Today"),
      terminologyKey: 'sales.today_portal_tab',
      icon: 'fa-house',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'sales_overview',
      order: 10,
      access: crewAccess,
      defaultHome: true,
      params: { mode: 'sales' },
      bundles: salesBundles
    },
    {
      id: 'portal.sales_schedule',
      package: 'sales',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_fc05a804bd034c","Schedule") ?? "Schedule"),
      terminologyKey: 'scheduling.sales_portal_tab',
      icon: 'fa-calendar-days',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'sales_schedule',
      order: 20,
      access: crewAccess,
      params: { mode: 'sales' },
      bundles: salesBundles
    },
    {
      id: 'portal.sales_earnings',
      package: 'sales',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_685ff0ff145929","Earnings") ?? "Earnings"),
      terminologyKey: 'earnings.sales_portal_tab',
      icon: 'fa-wallet',
      kind: 'portal_tab',
      surfaces: ['portal_tab'],
      portalTabId: 'sales_earnings',
      order: 30,
      access: crewAccess,
      params: { mode: 'sales' },
      bundles: salesBundles
    },
    {
      id: 'project.sales_overview',
      package: 'sales',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_d8d2e84c5e4d8b","Visit") ?? "Visit"),
      icon: 'fa-house',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 10,
      access: crewAccess,
      defaultHome: true,
      presentation: crewProjectPresentation,
      bundles: salesBundles
    },
    {
      id: 'project.crew_overview',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_d8d2e84c5e4d8b","Visit") ?? "Visit"),
      icon: 'fa-house',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 10,
      access: crewAccess,
      defaultHome: true,
      presentation: crewProjectPresentation,
      bundles: crewBundles
    },
    {
      id: 'project.crew_materials',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_691187e28aba8e","Materials") ?? "Materials"),
      terminologyKey: 'materials.crew_project_tab',
      icon: 'fa-boxes-stacked',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 20,
      access: crewAccess,
      presentation: crewProjectPresentation,
      bundles: crewBundles
    },
    {
      id: 'project.crew_payouts',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_685ff0ff145929","Earnings") ?? "Earnings"),
      terminologyKey: 'earnings.crew_project_tab',
      icon: 'fa-wallet',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 30,
      access: crewAccess,
      presentation: crewProjectPresentation,
      bundles: crewBundles
    },
    {
      id: 'project.crew_payments',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_5842802f6c8cbb","Payments") ?? "Payments"),
      terminologyKey: 'payments.crew_project_tab',
      icon: 'fa-credit-card',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 40,
      access: crewAccess,
      presentation: crewProjectPresentation,
      bundles: crewBundles
    },
    {
      id: 'project.crew_change_orders',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_2ab7cbc52241e3","Change Orders") ?? "Change Orders"),
      terminologyKey: 'change_orders.crew_project_tab',
      icon: 'fa-file-signature',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 50,
      access: crewAccess,
      presentation: crewProjectPresentation,
      bundles: crewBundles
    },
    {
      id: 'project.crew_checklists',
      package: 'crew',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_4890d3d11dc3eb","Checklists") ?? "Checklists"),
      icon: 'fa-list-check',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 60,
      access: crewAccess,
      presentation: crewProjectPresentation,
      bundles: crewBundles
    },
    {
      id: 'project.field_customer',
      package: 'field_visit',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_ae8e4953e07d70","Customer") ?? "Customer"),
      icon: 'fa-address-card',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 15,
      visible: true,
      access: { applicationsAny: ['field'], devices: ['mobile', 'desktop'], entitlementKey: 'project.sales_overview', requireEntitlement: false },
      presentation: crewProjectPresentation,
      bundles: crewSignatureBundles
    },
    {
      id: 'project.crew_signatures',
      package: 'signatures',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_222066ef57ae0e","Work") ?? "Work"),
      icon: 'fa-diagram-project',
      kind: 'project_modal_app',
      surfaces: ['project_modal'],
      requiresContext: ['project'],
      order: 70,
      visible: true,
      access: { applicationsAny: ['field'], devices: ['mobile', 'desktop'], permissionsAny: ['crew.signatures.present'], requireEntitlement: true },
      presentation: crewProjectPresentation,
      bundles: crewSignatureBundles
    },
    {
      id: 'billing',
      package: 'billing',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_831d8d28763333","Billing") ?? "Billing"),
      kind: 'modal_app',
      surfaces: ['modal', 'service'],
      bundles: [bundle('billing/app.js')]
    },
    {
      id: 'help',
      package: 'help',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_67b289b34e4ca4","Help") ?? "Help"),
      kind: 'ambient_app',
      surfaces: ['ambient', 'service'],
      bundles: [bundle('help/app.js')]
    },
    {
      id: 'onboarding.wizard',
      package: 'onboarding',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_c1ae5cde2c02d6","Onboarding Wizard") ?? "Onboarding Wizard"),
      kind: 'modal_app',
      surfaces: ['modal'],
      bundles: [bundle('onboarding/wizard.js')]
    },
    {
      id: 'promo.bonus_upfront_match',
      package: 'promo-inject',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_cb6d983a4aeec4","Credit Bonus Promotion") ?? "Credit Bonus Promotion"),
      kind: 'ambient_app',
      surfaces: ['ambient', 'modal'],
      bundles: [bundle('promo-inject/app.js')]
    },
    {
      id: 'referrals',
      package: 'referrals',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_e6531c84500a50","Referrals") ?? "Referrals"),
      kind: 'ambient_app',
      surfaces: ['ambient', 'modal'],
      bundles: [bundle('referrals/app.js')]
    },
    {
      id: 'pricebook.bridge',
      package: 'pricebook',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_e0ddf988d08b23","Pricebook Bridge") ?? "Pricebook Bridge"),
      kind: 'service',
      surfaces: ['service'],
      bundles: [bundle('pricebook/bridge.js')]
    },
    {
      id: 'tutorial',
      package: 'tutorial',
      title: (globalThis.PlatformLanguage?.text("firstmate-apps-manifest","m_f0cd67d228d884","Tutorial") ?? "Tutorial"),
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

  const nestedRouteParams = {
    projects: {
      projectView:{ default:'stages', values:['stages','tiles','list','drafts'], history:'push' },
      projectBoard:{ history:'push' }
    },
    contacts: { contact:{ history:'push' }, contactView:{ default:'list', values:['tiles','list'], history:'replace' }, contactsWorkspace:{ values:['import','settings'], history:'push' }, contactsSettingsView:{ values:['import','history'], history:'push' } },
    photos: { photo:{ history:'push' }, photoScope:{ history:'replace' }, mediaTags:{ history:'replace', apps:['portal.photos_feed'] }, feedDensity:{ default:'comfortable', values:['loose','comfortable','compact','list'], history:'replace', apps:['portal.photos_feed'] }, feedShown:{ history:'replace', apps:['portal.photos_feed'] }, user:{ history:'push', apps:['portal.photos_feed'] }, userTab:{ default:'photos', values:['photos','activity'], history:'push', apps:['portal.photos_feed'] } },
    proposals: { proposal:{ history:'push' }, proposalProject:{ history:'push', apps:['portal.proposals'] }, proposalMode:{ default:'list', values:['list','builder','edit','send'], history:'push' } },
    scheduling: { scheduleView:{ default:'week', values:['day','4day','week','month','appointment_schedule','gantt'], history:'push' }, date:{ history:'replace' }, day:{ history:'push' }, scheduleType:{ history:'push' }, scheduleGroup:{ history:'replace' }, scheduleResource:{ history:'replace' } },
    crew: { crewScheduleView:{ default:'week', values:['list','day','4day','week','month'], history:'push', apps:['portal.crew_schedule'] }, crewScheduleDate:{ history:'replace', apps:['portal.crew_schedule'] } },
    sales: { salesScheduleView:{ default:'week', values:['list','day','4day','week','month'], history:'push', apps:['portal.sales_schedule'] }, salesScheduleDate:{ history:'replace', apps:['portal.sales_schedule'] } },
    training: { trainingTab:{ default:'home', values:['home','decks','quizzes'], history:'push', apps:['portal.training'] }, course:{ history:'push', apps:['portal.training'] }, lesson:{ history:'push', apps:['portal.training'] } },
    equipment: { equipmentView:{ default:'fleet', values:['fleet','timeline','maintenance','utilization','settings'], history:'push' }, equipmentItem:{ history:'push' }, equipmentType:{ history:'replace' }, equipmentCategory:{ history:'replace' }, equipmentStatus:{ history:'replace' } },
    payroll: { payrollView:{ default:'upcoming', values:['upcoming','timesheets','contractors','exports','history','settings'], history:'push' }, settingsEntity:{ history:'push' } },
    chat: { callQueue:{ history:'push' },callIndex:{ history:'replace' },callStep:{ history:'replace' },chatConversation:{ history:'push' },chatFilter:{history:'replace',values:['open','mine','unclaimed','snoozed','closed']},chatChannel:{history:'replace',values:['all','email','sms','call','webchat']} },
    channels: { channel:{ history:'push' }, channelThread:{ history:'replace' }, channelMessage:{ history:'replace' }, channelsView:{ default:'channel', values:['channel','saved','search'], history:'replace' } },
    canvassing: { pin:{ history:'push' }, canvassingStatus:{ history:'replace' } },
    settings: { sub:{ history:'push' }, settingsView:{ history:'push' }, settingsEntity:{ history:'push' }, scopeTemplateView:{ default:'details', values:['details','boards','scheduling','developer','automations','todos','checklists','documents','materials','events','notifications','communications','resources','fields','calls','transitions','workflows','portal','payments','other','commissions','assistant'], history:'push' }, scopeArtifact:{ history:'replace' }, scopeArtifactFilter:{ default:'all', values:['all','conditional','inactive'], history:'replace' }, scopeAutomation:{ history:'push' }, scopeEventFocus:{ history:'push' }, scopeEventFilter:{ default:'all', values:['all','connected','unused','actions','documents','todos','events','materials','checklists','notifications'], history:'replace' }, previewMode:{ history:'replace' }, terminologyQuery:{ history:'replace' }, terminologySection:{ history:'replace' }, terminologyStatus:{ history:'replace' }, workflow:{ history:'push' }, workflow_step:{ history:'push' } },
    money: { moneyView:{ default:'overview', values:['overview','ledger','payments','invoices','recurring','expenses','receipts','commissions','take_payment'], history:'push' }, receipt:{ history:'push' } },
    receipts: { receipt:{ history:'push' } },
    invoices: { invoicesView:{ default:'outstanding', values:['outstanding','needs_invoicing','history'], history:'push' }, invoice:{ history:'push' }, invoicesStatus:{ history:'replace' } },
    docs: { document:{ history:'push' }, documentView:{ default:'tiles', values:['tiles','list'], history:'replace' } },
    materials: { materialList:{ history:'push' }, materialSection:{ default:'all', history:'replace' } },
    measurements: { reportView:{ default:'standard', history:'push' } },
    checklists: { checklistView:{ history:'push' } },
    'customer-portal': { customerPortalView:{ default:'overview', values:['overview','media'], history:'push' } },
    'web-editor': { site:{ history:'push' }, page:{ history:'push' }, view:{ history:'replace' }, domainSettings:{ values:['domains'], history:'push' } },
    comms: { commsView:{ default:'overview', values:['overview','email','sms','chat','calls'], history:'push' }, commsConversation:{ history:'replace' } },
    'project-schedule': { projectScheduleView:{ default:'month', history:'push' }, projectScheduleTarget:{ default:'production', history:'push' } }
  };

  function routeDefinition(app){
    const params = {};
    Object.entries(nestedRouteParams[app.package] || {}).forEach(([key, definition]) => {
      const allowedApps = Array.isArray(definition?.apps) ? definition.apps : [];
      if (allowedApps.length && !allowedApps.includes(app.id)) return;
      const { apps: _apps, ...schema } = definition || {};
      params[key] = schema;
    });
    // A few app definitions keep their route schemas beside mount params. Only
    // schema-shaped entries participate; ordinary values such as mode do not.
    Object.entries(app.params || {}).forEach(([key, definition]) => {
      if (!definition || typeof definition !== 'object' || !definition.history) return;
      params[key] = { ...definition };
    });
    if (app.kind === 'portal_tab') params.tab = { default:app.portalTabId, history:'push' };
    if (app.kind === 'project_modal_app') {
      params.project = { history:'push' };
      params.projectTab = { default:String(app.id || '').replace(/^project\./, ''), history:'push' };
    }
    if (app.kind === 'modal_app') params.modal = { default:app.id, history:'push' };
    return { parent:app.kind === 'project_modal_app' ? 'project' : (app.kind === 'portal_tab' ? 'portal' : ''), params };
  }

  // Org-level capability gating: each app id maps to the capability-registry
  // node that turns it off (public/v1/platform/capability_defs.ts). The
  // runtime hides the app when the capability resolves off; unmapped apps
  // (shell, help, onboarding) are ungated. Add a mapping here when you add a
  // manifest entry that belongs to a flaggable app.
  const appCapabilities = {
    'portal.viewer': 'apps.projects',
    'portal.contacts': 'platform.contacts',
    'portal.photos_feed': 'platform.photos_feed',
    'portal.receipts': 'crew.receipts',
    'portal.proposals': 'platform.proposals',
    'project.photos': 'platform.project_photos',
    'project.proposal': 'platform.proposals',
    // project.docs is the consolidated documents tab: it shows when EITHER
    // platform.project_docs OR platform.documents is on, so its gate lives in
    // the app's own enabled predicate (apps/docs/project.js) instead of a
    // single capability key here.
    'project.documents': 'platform.documents',
    'documents.studio': 'documents.templates_studio',
    'portal.web_editor': 'apps.web_editor',
    'project.materials': 'platform.materials',
    'project.money': 'platform.money',
    'project.map': 'apps.project_map',
    'project.customer_portal': 'platform.customer_portal',
    'project.schedule': 'platform.scheduling',
    'project.comms': 'apps.comms',
    'project.measurements': 'apps.firstmeasure',
    'project.checklists': 'apps.checklists',
    'firstmeasure.order': 'firstmeasure.report_orders',
    'portal.scheduling': 'platform.scheduling',
    'portal.training': 'apps.training',
    'portal.training_studio': 'training.studio',
    'portal.equipment': 'apps.equipment',
    'portal.financials': 'money.profitability',
    'portal.invoices': 'money.invoices',
    'portal.stats': 'apps.stats',
    'portal.payroll': 'apps.payroll',
    'portal.feedback': 'apps.feedback',
    // The global communications center: shown when the comms hub is on (the
    // live-chat channel additionally gates itself inside the app).
    'portal.chat': 'apps.comms',
    'portal.channels': 'apps.channels',
    'portal.canvassing': 'canvassing.app',
    'portal.sales_overview': 'apps.sales',
    'portal.sales_schedule': 'apps.sales',
    'portal.sales_earnings': 'payroll.self_service_earnings',
    'project.sales_overview': 'apps.sales',
    'portal.crew_overview': 'apps.crew',
    'portal.crew_schedule': 'apps.crew',
    'portal.crew_receipts': 'crew.receipts',
    'portal.crew_payouts': 'payroll.self_service_earnings',
    'project.crew_overview': 'apps.crew',
    'project.crew_materials': 'platform.materials',
    'project.crew_payouts': 'payroll.self_service_earnings',
    'project.crew_payments': 'crew.field_payments',
    'project.crew_change_orders': 'crew.change_orders',
    'project.crew_checklists': 'apps.checklists',
    billing: 'apps.billing',
    'promo.bonus_upfront_match': 'firstmeasure.bonus_upfront_match',
    referrals: 'apps.referrals'
  };

  apps.forEach((app) => {
    const capability = appCapabilities[app.id];
    if (capability) app.access = { ...(app.access || {}), capability };
    app.route = app.route || routeDefinition(app);
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
