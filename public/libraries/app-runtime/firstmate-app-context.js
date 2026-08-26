/* public/libraries/app-runtime/firstmate-app-context.js
 * Shared context helpers for embeddable apps and standalone smoke hosts.
 */
(function(){
  const root = window;
  const noop = () => {};
  const cleanText = (value) => String(value ?? '').trim();
  const clone = (value) => {
    if (value == null || typeof value !== 'object') return value;
    try {
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return Array.isArray(value) ? value.slice() : { ...value }; }
  };

  const DEFAULT_PROPOSAL_TEMPLATES = [
    {
      id: 'preset_roofing_standard',
      name: 'Standard Roof Proposal',
      description: 'A clean contract-ready proposal with scope, pricing, signature, and terms.',
      theme: 'margin',
      createdBy: 'FirstMate',
      preset: true,
      used_at: '2026-01-03T12:00:00.000Z',
      pages: ['cover', 'image_text', 'pricing', 'signature', 'fine_print']
    },
    {
      id: 'preset_visual_estimate',
      name: 'Visual Estimate',
      description: 'A photo-forward proposal for jobs where visuals and simple pricing matter.',
      theme: 'clean',
      createdBy: 'FirstMate',
      preset: true,
      used_at: '2026-01-02T12:00:00.000Z',
      pages: ['cover', 'image_text', 'pricing', 'signature']
    },
    {
      id: 'preset_premium_contract',
      name: 'Premium Contract',
      description: 'A polished presentation with added details and full terms.',
      theme: 'triangles',
      createdBy: 'FirstMate',
      preset: true,
      used_at: '2026-01-01T12:00:00.000Z',
      pages: ['cover', 'image_text', 'image_text', 'pricing', 'signature', 'fine_print']
    }
  ];

  const PROPOSAL_PITCH_FIELDS = [
    { key: 'flatRoofSquares', label: '<=2/12' },
    { key: 'pitch2to4Squares', label: '2-4/12' },
    { key: 'pitch4to6Squares', label: '4-6/12' },
    { key: 'pitch6to8Squares', label: '6-8/12' },
    { key: 'pitch9to12Squares', label: '9-12/12' },
    { key: 'pitch13PlusSquares', label: '13+/12' },
  ];

  const PROPOSAL_MEASUREMENT_FIELDS = [
    { key: 'wastePercent', label: 'Waste %' },
    { key: 'eavesLf', label: 'Eaves (LF)' },
    { key: 'rakesLf', label: 'Rakes (LF)' },
    { key: 'hipsLf', label: 'Hips (LF)' },
    { key: 'ridgesLf', label: 'Ridges (LF)' },
    { key: 'valleyLf', label: 'Valleys (LF)' },
    { key: 'transitionsLf', label: 'Transitions (LF)' },
    { key: 'sideWallLf', label: 'Side Wall (LF)' },
    { key: 'headWallLf', label: 'Head Wall (LF)' },
    { key: 'gutterLf', label: 'Gutters (LF)' },
    { key: 'downspoutLf', label: 'Downspouts (LF)' },
    { key: 'structures', label: 'Structures' },
    { key: 'chimneysEa', label: 'Chimneys' },
    { key: 'skylightsEa', label: 'Skylights' },
  ];

  const proposalGlobals = {
    PROJECT_CONFIG_MODULE_ID: 'project_configuration',
    PROPOSAL_COVER_DEFAULT_SIZE: 380,
    PROPOSAL_THEMES: {
      margin: { label: 'Margin' },
      triangles: { label: 'Triangles' },
      clean: { label: 'Clean' },
    },
    PRESENTATION_STYLE_MODULE_ID: 'presentation_style',
    PROPOSAL_TEMPLATES_MODULE_ID: 'proposal_templates',
    DEFAULT_PROPOSAL_TEMPLATES,
    PROPOSAL_MARKUP_COLORS: ['#111111', '#d93025', '#2563eb', '#15803d'],
    PROPOSAL_MARKUP_SIZES: [1.8, 2.2, 3.2, 4.4],
    PROPOSAL_ITEM_PAGE_HEIGHT: 720,
    PROPOSAL_MEDIA_PAGE_HEIGHT: 900,
    PROPOSAL_MEDIA_BLOCK_GAP: 12,
    PROPOSAL_MEDIA_BOTTOM_GUTTER: 28,
    PROPOSAL_IMAGE_TEXT_DEFAULT: { ratio: 50, height: 220, imageLeft: true },
    PROPOSAL_FONT_OPTIONS: ['Montserrat','Inter','Roboto','Open Sans','Lato','Poppins','Source Sans 3'],
    PROPOSAL_PITCH_FIELDS,
    PROPOSAL_MEASUREMENT_FIELDS
  };

  const defaultState = () => ({
    activeBaseProject: {
      id: 'project_smoke_1',
      title: 'Smoke Test Project',
      address: '123 Example St',
      project_type: 'residential',
      contacts: [{ name: 'Example Customer', phone: '', email: 'customer@example.com', primary: true }],
      photos: [],
      proposals: [],
      events: []
    },
    projectPhotos: [],
    activePhotoIndex: 0,
    photoViewerOpen: false,
    pendingRoutePhotoId: '',
    activePreviewTab: 'map',
    customerPortalState: { loading: false, portal: null, activity: [], error: '' },
    proposals: [],
    activeProposalIndex: 0,
    activeProposalPageIndex: 0,
    proposalInsertIndex: null,
    proposalEditorMode: 'preview',
    proposalMarkupMode: false,
    proposalMarkupDockOpen: false,
    proposalMarkupTool: 'pen',
    proposalMarkupPopover: null,
    proposalDeleteConfirmPageId: null,
    proposalPhotoPicker: null,
    proposalCoverAdjustOpen: false,
    proposalMarkupStrokeColor: '#111111',
    proposalMarkupStrokeSize: 2.2,
    proposalDeleteConfirmBlockId: null,
    proposalWorkspaceOpen: false,
    proposalWorkspaceMode: 'list',
    proposalSettingsPanelOpen: false,
    proposalBrandingMedia: [],
    proposalBrandingMediaLoaded: false,
    proposalSendOrigin: 'list',
    proposalSendMessage: '',
    proposalSendIncludePdf: true,
    proposalSendIncludePortal: true,
    proposalSendSelectedIds: new Set(),
    proposalSendContactKeys: new Set(),
    proposalDeleteConfirmProposalId: null,
    proposalActionExpanded: false,
    proposalMeasurementsExpanded: false,
    proposalInternalNotesCollapsed: true,
    proposalAgentCollapsed: true,
    proposalAgentPrompt: '',
    proposalAgentProgress: 0,
    proposalAgentRunning: false,
    proposalAgentTimer: null,
    proposalAgentRecognition: null,
    proposalSigningMode: false,
    proposalSigningSession: null,
    branchPresentationStyle: {},
    branchProposalTemplates: { templates: [] },
    proposalSignatureModalState: null,
    proposalPricebookSuggest: null,
    proposalAutosaveTimer: null,
    proposalHydrateRequestId: 0,
    proposalBackendLoadedProjectId: '',
    proposalLocalMutationVersion: 0,
    reportOrderState: null,
    branchProjectConfig: { title_mode: 'customer_name' }
  });

  function createProjectModel(initial = {}, options = {}){
    const state = { ...defaultState(), ...(initial.state || {}), ...initial };
    if (initial.project) state.activeBaseProject = initial.project;
    if (Array.isArray(initial.photos)) state.projectPhotos = initial.photos;
    if (Array.isArray(initial.proposals)) state.proposals = initial.proposals;
    const subscribers = new Set();

    const notify = (meta = {}) => {
      const snapshot = model.snapshot();
      subscribers.forEach((listener) => {
        try { listener(snapshot, meta); } catch (error) { console.warn('FirstMate app context subscriber failed', error); }
      });
    };

    const model = {
      state,
      options,
      get(key){ return state[key]; },
      set(key, value, meta = {}) {
        state[key] = value;
        notify({ type: 'set', key, ...meta });
        return value;
      },
      patch(patch, meta = {}) {
        Object.assign(state, typeof patch === 'function' ? patch(state) : (patch || {}));
        notify({ type: 'patch', ...meta });
        return state;
      },
      snapshot(){ return clone({ ...state, proposalSendSelectedIds: [...(state.proposalSendSelectedIds || [])], proposalSendContactKeys: [...(state.proposalSendContactKeys || [])] }); },
      subscribe(listener){
        if (typeof listener !== 'function') return noop;
        subscribers.add(listener);
        return () => subscribers.delete(listener);
      }
    };
    return model;
  }

  function defineWindowAccessor(name, get, set = null, options = {}){
    if (!options.overwrite && Object.prototype.hasOwnProperty.call(root, name)) return;
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        get,
        set: set || ((value) => { get(); return value; })
      });
    } catch (_) {}
  }

  function defineWindowValue(name, value, options = {}){
    if (!options.overwrite && Object.prototype.hasOwnProperty.call(root, name)) return;
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        get: () => value,
        set: () => {}
      });
    } catch (_) {
      try { root[name] = value; } catch (__) {}
    }
  }

  function featureEnabled(model, group, flag, fallback = true){
    const flags = model.options?.featureFlags || root.Portal?.appFlags?.current?.() || {};
    const value = flags?.[group]?.[flag] ?? flags?.[flag];
    if (value === undefined || value === null) return fallback;
    return value !== false && value !== 0 && value !== '0' && value !== 'false';
  }

  function projectId(model){
    return cleanText(model.state.activeBaseProject?.id || model.options?.projectId || 'project_smoke_1');
  }

  function orgId(model){
    return cleanText(model.options?.orgId || root.__APP?.userOrgId || root.__APP?.orgId || root.Portal?.cfg?.userOrgId || root.Portal?.cfg?.orgId || 'org_smoke');
  }

  function ensureProject(model){
    if (!model.state.activeBaseProject) model.state.activeBaseProject = defaultState().activeBaseProject;
    model.state.activeBaseProject.photos = model.state.projectPhotos.map((photo) => ({ ...photo, file: undefined }));
    model.state.activeBaseProject.proposals = model.state.proposals;
    model.state.activeBaseProject.events = Array.isArray(model.state.activeBaseProject.events) ? model.state.activeBaseProject.events : [];
    return model.state.activeBaseProject;
  }

  function installProjectContextAccessors(model = createProjectModel(), options = {}){
    const overwrite = !!options.overwrite;
    [
      'activeBaseProject',
      'projectPhotos',
      'activePhotoIndex',
      'photoViewerOpen',
      'pendingRoutePhotoId',
      'activePreviewTab',
      'customerPortalState',
      'proposals',
      'activeProposalIndex',
      'activeProposalPageIndex',
      'proposalInsertIndex',
      'proposalEditorMode',
      'proposalMarkupMode',
      'proposalMarkupDockOpen',
      'proposalMarkupTool',
      'proposalMarkupPopover',
      'proposalDeleteConfirmPageId',
      'proposalPhotoPicker',
      'proposalCoverAdjustOpen',
      'proposalMarkupStrokeColor',
      'proposalMarkupStrokeSize',
      'proposalDeleteConfirmBlockId',
      'proposalWorkspaceOpen',
      'proposalWorkspaceMode',
      'proposalSettingsPanelOpen',
      'proposalBrandingMedia',
      'proposalBrandingMediaLoaded',
      'proposalSendOrigin',
      'proposalSendMessage',
      'proposalSendIncludePdf',
      'proposalSendIncludePortal',
      'proposalSendSelectedIds',
      'proposalSendContactKeys',
      'proposalDeleteConfirmProposalId',
      'proposalActionExpanded',
      'proposalMeasurementsExpanded',
      'proposalInternalNotesCollapsed',
      'proposalAgentCollapsed',
      'proposalAgentPrompt',
      'proposalAgentProgress',
      'proposalAgentRunning',
      'proposalAgentTimer',
      'proposalAgentRecognition',
      'proposalSigningMode',
      'proposalSigningSession',
      'branchPresentationStyle',
      'branchProposalTemplates',
      'proposalSignatureModalState',
      'proposalPricebookSuggest',
      'proposalAutosaveTimer',
      'proposalHydrateRequestId',
      'proposalBackendLoadedProjectId',
      'proposalLocalMutationVersion',
      'reportOrderState',
      'branchProjectConfig'
    ].forEach((key) => {
      defineWindowAccessor(key, () => model.state[key], (value) => { model.state[key] = value; }, { overwrite });
    });

    Object.entries(proposalGlobals).forEach(([key, value]) => defineWindowValue(key, value, { overwrite }));

    const functions = {
      projectOrgId: () => orgId(model),
      customerPortalProjectId: () => projectId(model),
      customerPortalMediaEnabled: () => featureEnabled(model, 'platform', 'customer_portal_media', false),
      customerPortalEnabled: () => featureEnabled(model, 'platform', 'customer_portal', false),
      projectPhotosEnabled: () => featureEnabled(model, 'platform', 'project_photos', true),
      projectDocsEnabled: () => featureEnabled(model, 'platform', 'project_docs', false),
      proposalsEnabled: () => featureEnabled(model, 'platform', 'proposals', true),
      proposalAgentEnabled: () => featureEnabled(model, 'platform', 'proposal_agent', false),
      schedulePreviewAvailable: () => featureEnabled(model, 'platform', 'scheduling', false) && !!model.state.activeBaseProject,
      schedulingEnabled: () => featureEnabled(model, 'platform', 'scheduling', false),
      storageLimitsEnabled: () => featureEnabled(model, 'platform', 'storage_limits', false),
      purchasableStorageEnabled: () => featureEnabled(model, 'platform', 'purchasable_storage', false),
      weatherReportsEnabled: () => featureEnabled(model, 'firstmeasure', 'weather_reports', false),
      hasReportOrdered: () => !!model.state.reportOrderState?.ordered,
      hasSelectedAddons: () => false,
      shouldUseMobileOrderPagination: () => false,
      isProposalChoice: () => true,
      isScheduleChoice: () => false,
      canSubmit: () => true,
      pinCount: () => 1,
      getMarkersData: () => [],
      activeMeasurementProjectId: () => projectId(model),
      reportOrderMeasurement: () => model.state.activeBaseProject?.measurement || model.state.activeBaseProject?.measurement_project || {},
      reportOrderIsActivelyPending: () => false,
      reportOrderIsCompleteLike: () => !!model.state.reportOrderState?.hasReadyReport,
      reportOrderIsCancelled: () => false,
      reportOrderIsRejected: () => false,
      reportReleaseHoldIsActive: () => false,
      reportFollowupEnabled: () => false,
      projectDefaultPreviewTab: () => 'map',
      setActivePreviewTab: (tab) => { model.state.activePreviewTab = cleanText(tab) || 'map'; },
      syncActiveProjectRoute: noop,
      syncProjectViewerTabs: noop,
      revealCustomerSection: noop,
      syncProjectNotesPlacement: noop,
      renderActionRow: noop,
      updateSubmitLabel: noop,
      renderSigningOverlay: noop,
      renderWorkflowState: noop,
      updateModalTitle: noop,
      queueAutosaveNotice: noop,
      persistActiveBaseProject: () => ensureProject(model),
      ensureDraftBaseProject: () => ensureProject(model),
      ensureProposalOnlyBaseProject: () => ensureProject(model),
      trackRequestActivity: () => Promise.resolve(null),
      loadBranchProjectConfig: () => Promise.resolve(model.state.branchProjectConfig),
      normalizeProjectConfig: (config) => config && typeof config === 'object' ? config : { title_mode: 'customer_name' },
      cssEscape: (value) => (root.CSS?.escape ? root.CSS.escape(value) : cleanText(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')),
      formatStorageBytes: (bytes) => `${Math.round(Number(bytes || 0) / (1024 * 1024))} MB`,
      storageLimitBytes: () => 0,
      openStorageSettings: noop,
      renderCustomerPortalPanel: noop,
      loadCustomerPortal: () => Promise.resolve(null),
      infoTip: (text) => `<span class="r-info-tip"><i class="fas fa-info"></i><span class="r-tip-bubble">${cleanText(text)}</span></span>`,
      fmUrl: (path) => root.Portal?.util?.fmUrl?.(path) || cleanText(path),
      fmJson: (...args) => root.Portal?.util?.fmJson?.(...args),
      fmPost: (...args) => root.Portal?.util?.fmPost?.(...args),
      platformJson: (...args) => root.Portal?.util?.platformJson?.(...args),
      currentActor: () => root.Portal?.util?.currentActor?.() || {}
    };
    Object.entries(functions).forEach(([key, fn]) => defineWindowValue(key, fn, { overwrite }));
    return model;
  }

  function modelFromContext(context = {}){
    if (context.projectModel) return context.projectModel;
    if (context.model) return context.model;
    return createProjectModel({
      project: context.project || context.entity || null,
      photos: context.photos || context.project?.photos || [],
      proposals: context.proposals || context.project?.proposals || []
    }, context);
  }

  function createProjectHost(model, host = {}){
    return {
      ...host,
      getProject: () => model.state.activeBaseProject,
      setProject: (project) => { model.state.activeBaseProject = project || null; return model.state.activeBaseProject; },
      getPhotos: () => model.state.projectPhotos,
      setPhotos: (photos) => { model.state.projectPhotos = Array.isArray(photos) ? photos : []; return model.state.projectPhotos; },
      getProposals: () => model.state.proposals,
      setProposals: (proposals) => { model.state.proposals = Array.isArray(proposals) ? proposals : []; return model.state.proposals; },
      installContextAccessors: (options = {}) => installProjectContextAccessors(model, options)
    };
  }

  root.FirstMateAppContext = {
    createProjectModel,
    createProjectHost,
    installProjectContextAccessors,
    modelFromContext,
    proposalGlobals,
    clone
  };
})();
