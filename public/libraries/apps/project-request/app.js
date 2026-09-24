/* public/libraries/apps/project-request/app.js
 * Staged request workflow with optional roof-report ordering.
 */
(function(){
  if (!window.Portal) return;

  const cfg = window.Portal.cfg || {};
  const { $, injectCSS, postAction, hasPerm, formatDate, fmUrl, fmJson, fmPost, platformJson, currentActor } = window.Portal.util;
  const { showToast } = window.Portal.ui;

  const PRICE_RESIDENTIAL = 7;
  const PRICE_COMMERCIAL = 12;
  const PRICE_MULTIFAMILY = 12;
  const INSTANT_ADDON_RESIDENTIAL = 2;
  const INSTANT_ADDON_COMMERCIAL = 4;
  const INSTANT_ADDON_MULTIFAMILY = 4;
  const GUTTER_REPORT_ADDON = Number(cfg.gutterReportAddon ?? 2) || 2;
  const WEATHER_REPORT_ADDON = Number(cfg.weatherReportAddon ?? 5) || 5;
  const EXPEDITE_FEE_PERCENT = 115;
  const MAX_PINS_RESIDENTIAL = 5;
  const MAX_PINS_PER_STRUCTURE_REPORT = 10;
  const PENDING_ORDER_KEY = 'fm_pending_order_v1';
  const PDF_PREVIEW_QUERY_FLAGS = ['disablePdfPreview', 'mobileDebug', 'noPdfPreview'];
  const FIRST_REPORT_CHECKOUT_FORCE_FLAGS = ['fm_force_first_report_checkout'];
  const PROPOSAL_FONT_OPTIONS = ['Montserrat','Inter','Roboto','Open Sans','Lato','Poppins','Source Sans 3'];

  function queryFlagEnabled(names){
    try {
      const params = new URLSearchParams(window.location.search || '');
      return names.some((name) => {
        if (!params.has(name)) return false;
        const value = String(params.get(name) || '').trim().toLowerCase();
        return !['0', 'false', 'off', 'no'].includes(value);
      });
    } catch (error) {
      return false;
    }
  }

  const pdfPreviewDisabled = queryFlagEnabled(PDF_PREVIEW_QUERY_FLAGS);
  const forceFirstReportCheckout = queryFlagEnabled(FIRST_REPORT_CHECKOUT_FORCE_FLAGS);

  const ICON_PATHS = {
    residential: 'M8 1.5L0.5 7.5H3V14h4v-4h2v4h4V7.5h2.5L8 1.5z',
    commercial: 'M3 0h10v16H3z M5 2.5h2v2H5z M9 2.5h2v2H9z M5 6.5h2v2H5z M9 6.5h2v2H9z M5 10.5h2v2H5z M9 10.5h2v2H9z M7 13.5h2v2.5H7z',
    multifamily: 'M0 6h4v10H0z M1 7.5h2v1.5H1z M1 10.5h2v1.5H1z M5 2h6v14H5z M6.5 3.5h1.2v1.2H6.5z M8.3 3.5h1.2v1.2H8.3z M6.5 6h1.2v1.2H6.5z M8.3 6h1.2v1.2H8.3z M6.5 8.5h1.2v1.2H6.5z M8.3 8.5h1.2v1.2H8.3z M6.5 11h1.2v1.2H6.5z M8.3 11h1.2v1.2H8.3z M12 6h4v10h-4z M13 7.5h2v1.5h-2z M13 10.5h2v1.5h-2z',
  };

  const TYPE_META = {
    residential: { label: (globalThis.PlatformLanguage?.text("project-request","m_aaf397f737f7b1","Residential") ?? "Residential"), icon: 'fa-house', price: PRICE_RESIDENTIAL },
    commercial: { label: (globalThis.PlatformLanguage?.text("project-request","m_84e41491611ca9","Commercial") ?? "Commercial"), icon: 'fa-building', price: PRICE_COMMERCIAL },
    multifamily: { label: (globalThis.PlatformLanguage?.text("project-request","m_bb037b99df2dbb","Multi-Family") ?? "Multi-Family"), icon: 'fa-city', price: PRICE_MULTIFAMILY },
  };
  const REPORT_MODE_META = {
    full: { label: (globalThis.PlatformLanguage?.text("project-request","m_00f3e8b60aebc9","Standard") ?? "Standard") },
    both: { label: (globalThis.PlatformLanguage?.text("project-request","m_b8c0c33704d4aa","Standard + Instant Report") ?? "Standard + Instant Report") },
  };
  const FALLBACK_REPORT_EXPEDITE_OPTIONS = [
    { key: 'standard_3_6', label: (globalThis.PlatformLanguage?.text("project-request","m_d733253e76c414","Less than 7 hrs") ?? "Less than 7 hrs"), startMinutes: 240, endMinutes: 420, productionDeadlineMinutes: 240, estimatedWaitMinutes: 240, busyLabel: "We aren't very busy", residentialPrice: 7, rushDelta: 0, expedited: false },
    { key: 'rush_1_3', label: (globalThis.PlatformLanguage?.text("project-request","m_0bb29e9472d757","Less than 3 hrs rush") ?? "Less than 3 hrs rush"), startMinutes: 60, endMinutes: 180, productionDeadlineMinutes: 120, residentialPrice: 8.15, rushDelta: 1.15, expedited: true },
    { key: 'rush_under_1', label: (globalThis.PlatformLanguage?.text("project-request","m_ce0c416274915b","Less than 1 hr rush") ?? "Less than 1 hr rush"), startMinutes: 50, endMinutes: 60, productionDeadlineMinutes: 50, residentialPrice: 10.45, rushDelta: 3.45, expedited: true },
  ];
  const PROJECT_CONFIG_MODULE_ID = 'project_configuration';
  const PROPOSAL_COVER_DEFAULT_SIZE = 380;
  const PROPOSAL_THEMES = {
    margin: { label: (globalThis.PlatformLanguage?.text("project-request","m_190ca7354b9101","Margin") ?? "Margin") },
    triangles: { label: (globalThis.PlatformLanguage?.text("project-request","m_a7933e949ff793","Triangles") ?? "Triangles") },
    clean: { label: (globalThis.PlatformLanguage?.text("project-request","m_bf7af1d2354e74","Clean") ?? "Clean") },
  };
  const PRESENTATION_STYLE_MODULE_ID = 'presentation_style';
  const PROPOSAL_TEMPLATES_MODULE_ID = 'proposal_templates';
  const DEFAULT_PROPOSAL_TEMPLATES = [
    {
      id: 'preset_roofing_standard',
      name: 'Standard Roof Proposal',
      description: (globalThis.PlatformLanguage?.text("project-request","m_ed4d92fc9f4e08","A clean contract-ready proposal with scope, pricing, signature, and terms.") ?? "A clean contract-ready proposal with scope, pricing, signature, and terms."),
      theme: 'margin',
      createdBy: 'FirstMate',
      preset: true,
      used_at: '2026-01-03T12:00:00.000Z',
      pages: ['cover', 'image_text', 'pricing', 'signature', 'fine_print']
    },
    {
      id: 'preset_visual_estimate',
      name: 'Visual Estimate',
      description: (globalThis.PlatformLanguage?.text("project-request","m_f6a55be56295ec","A photo-forward proposal for jobs where visuals and simple pricing matter most.") ?? "A photo-forward proposal for jobs where visuals and simple pricing matter most."),
      theme: 'clean',
      createdBy: 'FirstMate',
      preset: true,
      used_at: '2026-01-02T12:00:00.000Z',
      pages: ['cover', 'image_text', 'pricing', 'signature']
    },
    {
      id: 'preset_premium_contract',
      name: 'Premium Contract',
      description: (globalThis.PlatformLanguage?.text("project-request","m_dc8bbc832598bf","A polished presentation with added details and full terms.") ?? "A polished presentation with added details and full terms."),
      theme: 'triangles',
      createdBy: 'FirstMate',
      preset: true,
      used_at: '2026-01-01T12:00:00.000Z',
      pages: ['cover', 'image_text', 'image_text', 'pricing', 'signature', 'fine_print']
    }
  ];

  let addressSelected = false;
  let locationConfirmed = false;
  let selectedType = null;
  let headerPropertyTypeMenu = null;
  let headerPropertyTypeGlobalEventsBound = false;
  let structurePinLimitNoticeActive = false;
  let typePickerExpanded = false;
  let mobileTypeTransitioning = false;
  let mobileTypeTransitionTimer = null;
  let mobileRoofOnlyChosen = false;
  let reportSelection = null;
  let mobileOrderPage = 'location';
  let mobileLeftTrayOpen = false;
  let mobileDefaultInfoTrayOpen = false;
  let mobileDefaultInfoTrayLeaveTimer = 0;
  let mobileProjectNotesOpen = false;
  let mobileOrderAnimTimer = null;
  let mobileSwipeStart = null;
  let selectedReportExpedite = null;
  let reportExpediteOptions = [...FALLBACK_REPORT_EXPEDITE_OPTIONS];
  let reportExpediteOptionsProjectType = '';
  let reportExpediteOptionsStructureCount = 1;
  let reportExpediteOptionsSlot = -1;
  let reportExpediteOptionsLoading = false;
  let reportExpediteOptionsAuthoritative = false;
  let reportExpediteMinuteTimer = null;
  let firstReportCheckoutEligibility = {
    orgId: '',
    loaded: false,
    loading: false,
    eligible: null,
    promise: null
  };
  let includeGutterMeasurements = false;
  let includeWeatherReport = false;
  let includeInstantPreview = false;
  let addonInfoHideTimer = null;
  let activePreviewTab = 'map';
  let workflowRenderInProgress = false;
  let workflowRenderScheduled = false;
  let workflowRenderLastAt = 0;
  let projectPhotos = [];
  let activePhotoIndex = 0;
  let photoViewerOpen = false;
  let proposals = [];
  let activeProposalIndex = 0;
  let activeProposalPageIndex = 0;
  let proposalInsertIndex = null;
  let proposalEditorMode = 'edit';
  let proposalMarkupMode = false;
  let proposalMarkupDockOpen = false;
  let proposalMarkupTool = 'pen';
  let proposalMarkupPopover = null;
  let proposalDeleteConfirmPageId = null;
  let proposalPhotoPicker = null;
  let proposalCoverAdjustOpen = false;
  let proposalMarkupStrokeColor = '#111111';
  let proposalMarkupStrokeSize = 2.2;
  let autosaveToastTimer = null;
  let autosaveDebounceTimer = null;
  let suppressAutosaveNotice = false;
  let proposalDeleteConfirmBlockId = null;
  let proposalWorkspaceOpen = false;
  let proposalWorkspaceMode = 'list';
  let proposalSettingsPanelOpen = false;
  let proposalBrandingMedia = [];
  let proposalBrandingMediaLoaded = false;
  let proposalSendOrigin = 'list';
  let proposalSendMessage = '';
  let proposalSendIncludePdf = true;
  let proposalSendIncludePortal = true;
  let proposalSendSelectedIds = new Set();
  let proposalSendContactKeys = new Set();
  let proposalDeleteConfirmProposalId = null;
  let proposalActionExpanded = false;
  let proposalMeasurementsExpanded = false;
  let proposalInternalNotesCollapsed = true;
  let projectNoteVisibility = ['office', 'crew', 'sales'];
  let editingProjectNoteId = '';
  let pendingProjectAudio = null;
  let projectNoteMentionController = null;
  let projectNoteMentionDirectory = [];
  let projectNoteHistoryClosing = false;
  let projectNoteHistoryCloseTimer = 0;
  let proposalAgentCollapsed = true;
  let proposalAgentPrompt = '';
  let proposalAgentProgress = 0;
  let proposalAgentRunning = false;
  let proposalAgentTimer = null;
  let proposalAgentRecognition = null;
  let proposalSigningMode = false;
  let proposalSigningSession = null;
  let branchPresentationStyle = {};
  let branchProposalTemplates = { templates: [] };
  let proposalSignatureModalState = null;
  let proposalPricebookSuggest = null;
  let proposalAutosaveTimer = null;
  let proposalHydrateRequestId = 0;
  let proposalBackendLoadedProjectId = '';
  let proposalLocalMutationVersion = 0;
  let proposalPdfJsLoading = null;
  const proposalPdfDocumentCache = new Map();
  const proposalSaveInFlight = new Map();
  const proposalSaveRetryNeeded = new Set();
  const proposalPdfDownloadInFlight = new Set();
  let projectViewer = null;
  let activeBaseProject = null;
  let pendingRoutePhotoId = '';
  let routeRestoreInFlight = false;
  let routeRestorePromise = null;
  let routeRestoreProjectId = '';
  let projectRouteClosePendingId = '';
  let projectOpenGeneration = 0;
  let projectShellLoading = false;
  let projectRouteBatching = false;
  let viewingExistingProject = false;
  let newProjectCreationSession = false;
  let reportOrderState = null;
  let requestedWorkflow = 'project';
  // Doc-first workflows ("New Proposal"/"New Invoice"/…): the document type to
  // preselect in the create wizard, and whether the left-column project picker
  // was dismissed in favor of building a brand-new project.
  let requestedDocumentType = '';
  let requestedDocumentResume = null;
  let docPickerDismissed = false;
  let docPickerChoiceMade = false;
  let docCreateLaunched = false;
  let activeContactContext = null;
  let projectTodoController = null;
  let projectTodoLoadedFor = '';
  let reorderMeasurementProjectId = '';
  let reorderSourceCanReopenInPlace = false;
  let primaryContactIndex = 0;
  let contactPickerOptions = [];
  let contactPickerLoadPromise = null;
  let branchProjectConfig = { title_mode: 'customer_name' };
  let projectWorkPlanState = { projectId: '', plans: [], loaded: false };
  let projectWorkPlanPromise = null;
  let modalInitialProjectIds = new Set();
  let requestModalHandle = null;
  let projectModalFullscreen = false;
  let projectModalFullscreenTimer = null;
  let addonInfoModalHandle = null;
  const proposalMeasurementCache = new Map();
  const proposalMeasurementLoads = new Set();
  const PROPOSAL_MARKUP_COLORS = ['#111111', '#d93025', '#2563eb', '#15803d'];
  const PROPOSAL_MARKUP_SIZES = [1.8, 2.2, 3.2, 4.4];
  const PROPOSAL_ITEM_PAGE_HEIGHT = 720;
  const PROPOSAL_MEDIA_PAGE_HEIGHT = 900;
  const PROPOSAL_MEDIA_BLOCK_GAP = 12;
  const PROPOSAL_MEDIA_BOTTOM_GUTTER = 28;
  const PROPOSAL_IMAGE_TEXT_DEFAULT = { ratio: 50, height: 220, imageLeft: true };

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Lato:wght@400;700;900&family=Montserrat:wght@400;600;700&family=Open+Sans:wght@400;700;800&family=Poppins:wght@400;600;700;800;900&family=Roboto:wght@400;700;900&family=Source+Sans+3:wght@400;700;900&display=swap');
    .r-overlay{position:fixed;inset:0;z-index:2147483100;background:rgba(11,16,24,.78);backdrop-filter:none;display:none;align-items:center;justify-content:center;opacity:0;transition:opacity .22s ease,background .24s ease;width:var(--fm-visual-vw,100vw);height:var(--fm-visual-vh,100vh);overflow:hidden}
    .r-overlay.active{display:flex;opacity:1}
    .r-win{width:min(1720px,96vw);height:min(1180px,calc(var(--fm-visual-vh,100vh) * .92));background:#ffffff;border-radius:14px;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:flex;position:relative;animation:rUp .26s cubic-bezier(.22,1,.36,1);transition:width .28s cubic-bezier(.22,1,.36,1),height .28s cubic-bezier(.22,1,.36,1),border-radius .24s ease,box-shadow .24s ease}
    .r-overlay.route-initial-open .r-win{animation:none}
    .r-overlay.fullscreen{background:rgba(11,16,24,.28);backdrop-filter:none}
    .r-overlay.fullscreen .r-win{width:var(--fm-visual-vw,100vw);height:var(--fm-visual-vh,100vh);border-radius:0;box-shadow:none;animation:none}
    .r-overlay.fullscreen-transitioning .r-win{animation:none!important}
    .r-win.contact-mode{padding-top:58px;box-sizing:border-box}
    .r-contact-contextbar{display:none;position:absolute;inset:0 0 auto 0;height:58px;z-index:70;border-bottom:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.96);backdrop-filter:blur(14px);align-items:center;gap:12px;padding:0 62px 0 18px;box-sizing:border-box}
    .r-win.contact-mode .r-contact-contextbar{display:flex}
    .r-contact-context-main{min-width:0;display:flex;align-items:center;gap:8px;flex:0 1 auto}
    .r-contact-context-back{border:1px solid rgba(15,23,42,.10);background:#fff;color:#101828;border-radius:12px;min-height:34px;padding:0 11px;display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:1000;cursor:pointer;max-width:260px}
    .r-contact-context-back span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-contact-context-back:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-contact-context-tabs{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;scrollbar-width:none;flex:1}
    .r-contact-context-tabs::-webkit-scrollbar{display:none}
    .r-contact-context-tab{border:1px solid rgba(15,23,42,.09);background:#f8fafc;color:#475467;border-radius:999px;min-height:32px;padding:0 12px;display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:1000;white-space:nowrap;cursor:pointer}
    .r-contact-context-tab:hover{background:#fff;border-color:rgba(15,23,42,.18);color:#101828}
    .r-contact-context-tab.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .r-contact-context-empty{color:#98a2b3;font-size:12px;font-weight:900;white-space:nowrap}
    @keyframes rUp{from{transform:translateY(20px) scale(.985);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}
    .r-left{width:min(460px,46%);max-width:none;box-sizing:border-box;border-right:1px solid rgba(15,23,42,.08);padding:18px;overflow:hidden;display:flex;flex-direction:column;gap:10px;background:#ffffff;flex:0 0 min(460px,46%);transition:transform .5s cubic-bezier(.22,1,.36,1),margin-left .5s cubic-bezier(.22,1,.36,1),box-shadow .5s ease}
    .r-right{flex:1;position:relative;background:#eef2f6;display:flex;flex-direction:column;min-width:0;transition:flex-basis .5s cubic-bezier(.22,1,.36,1)}
    .r-project-shell-status{display:none;position:absolute;inset:58px 0 0;z-index:64;align-items:center;justify-content:center;padding:24px;background:rgba(238,242,246,.72);backdrop-filter:blur(3px);pointer-events:none}
    .r-project-shell-status-card{display:flex;align-items:center;gap:11px;padding:13px 16px;border:1px solid rgba(15,23,42,.09);border-radius:14px;background:rgba(255,255,255,.94);box-shadow:0 16px 44px rgba(15,23,42,.10);color:#475467;font-size:13px;font-weight:900}
    .r-project-shell-status-card i{color:var(--primary-readable,var(--primary,#d93025))}
    .r-overlay.project-shell-loading .r-project-shell-status{display:flex}
    .r-overlay.project-shell-loading .r-left{pointer-events:none}
    .r-overlay.project-shell-loading .r-left>*{opacity:.42;transition:opacity .16s ease}
    .r-overlay.entitlement-left-none .r-left{display:none!important}
    .r-overlay.entitlement-left-none .r-right{flex:1 1 100%;min-width:0;min-height:0}
    .r-win.photo-focus .r-left{margin-left:max(-460px,-46%);transform:translateX(0);box-shadow:28px 0 60px rgba(15,23,42,.08)}
    .r-win.photo-focus .r-right{flex-basis:100%}
    .r-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-shrink:0;padding:0 0 4px;background:#ffffff}
    .r-scroll{flex:1;overflow:auto;padding-right:var(--fm-scrollbar-content-gap,10px);scrollbar-gutter:stable;min-height:0}
    .r-left-bottom{flex-shrink:0;border-top:1px solid rgba(15,23,42,.08);padding-top:12px;background:#fff;display:flex;flex-direction:column;gap:10px}
    .r-left-bottom:empty{display:none}
    .r-overlay.left-override #rProjectStageBar,
    .r-overlay.left-override #rAfterHours,
    .r-overlay.left-override #rProjectionCard,
    .r-overlay.left-override #rViewerSummary,
    .r-overlay.left-override #rStepCustomer,
    .r-overlay.left-override #rInlineNotesMount,
    .r-overlay.left-override #rCustomerPortalLinkMount,
    .r-overlay.left-override #rStepAddress,
    .r-overlay.left-override #rStepType,
    .r-overlay.left-override #rWorkflowDock,
    .r-overlay.left-override #rStepReport,
    .r-overlay.left-override #rStepRoof{display:none!important}
    .r-mobile-pager{display:none}
    .r-mobile-close{display:none}
    @media(max-width:420px){.r-overlay #rStepType.is-condensed .r-type-icon{display:none}.r-overlay #rStepType.is-condensed .r-type-btn{padding:8px 4px;min-width:0;gap:0}.r-overlay #rStepType.is-condensed .r-type-label{font-size:10px;white-space:normal;overflow-wrap:normal}}
    .r-title-wrap{width:100%;min-width:0}
    .r-title{margin:0;font-size:22px;font-weight:1000;letter-spacing:-.4px;color:#101828}
    .r-title-input{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:14px;padding:10px 12px;font:inherit;font-size:20px;font-weight:1000;letter-spacing:-.4px;color:#101828;outline:none}
    .r-title-input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.45);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.10)}
    .r-sub{margin:8px 0 0;color:#667085;font-weight:800;font-size:12px;line-height:1.55;max-width:44ch}
    .r-sub:empty{display:none}
    .r-stagebar{flex-shrink:0;margin:-2px 0 2px;position:relative}
    .r-stagebar[hidden]{display:none!important}
    .r-project-tags{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding:2px 1px 4px;scrollbar-width:none}
    .r-project-tags::-webkit-scrollbar{display:none}
    .r-project-tag{display:inline-flex;align-items:center;gap:5px;min-height:25px;max-width:180px;padding:4px 9px;border:1px solid rgba(15,23,42,.09);border-radius:999px;background:#f2f4f7;color:#344054;font-size:10.5px;font-weight:1000;line-height:1;white-space:nowrap}
    .r-project-tag span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .r-project-tag i{font-size:9.5px;flex:0 0 auto}
    .r-project-tag.scope{--tag-color:#4f7cac;border-color:color-mix(in srgb,var(--tag-color) 30%,#dce2e8);background:color-mix(in srgb,var(--tag-color) 10%,#fff);color:color-mix(in srgb,var(--tag-color) 78%,#17212b)}
    .r-project-tag.total{border-color:#a6dfbd;background:#ecfdf3;color:#15803d}
    button.r-project-tag{font-family:inherit;cursor:pointer}.r-project-tag.stage-editable{border-color:#c9d9eb;background:#f2f7fc;color:#28577f;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}.r-project-tag.stage-editable:hover{border-color:#7aa6cf;background:#eaf3fb;box-shadow:0 2px 8px rgba(23,105,170,.12)}.r-project-tag.stage-editable .fa-chevron-down{font-size:8px;opacity:.7}
    .r-manual-stage-backdrop{position:absolute;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.48);backdrop-filter:blur(3px)}
    .r-manual-stage-dialog{width:min(690px,100%);max-height:min(680px,calc(100vh - 48px));display:flex;flex-direction:column;border:1px solid rgba(15,23,42,.1);border-radius:20px;background:#fff;box-shadow:0 30px 90px rgba(15,23,42,.28);overflow:hidden}
    .r-manual-stage-head{display:flex;align-items:flex-start;gap:12px;padding:20px 20px 16px;border-bottom:1px solid #eaecf0}.r-manual-stage-head>i{width:38px;height:38px;border-radius:12px;background:#eaf3fb;color:#1769aa;display:grid;place-items:center}.r-manual-stage-head-copy{min-width:0;flex:1}.r-manual-stage-head h3{margin:0;color:#101828;font-size:18px}.r-manual-stage-head p{margin:5px 0 0;color:#667085;font-size:11px;line-height:1.45}.r-manual-stage-close{width:34px;height:34px;border:0;border-radius:9px;background:#f2f4f7;color:#667085;cursor:pointer}
    .r-manual-stage-body{min-height:0;overflow:auto;padding:16px 20px 20px}.r-manual-stage-board-label{display:block;margin-bottom:6px;color:#475467;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em}.r-manual-stage-board-select{width:100%;height:40px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 11px;color:#344054;font:inherit;font-size:12px;font-weight:900;outline:none}.r-manual-stage-list{display:grid;gap:7px;margin-top:14px}.r-manual-stage-option{width:100%;min-height:48px;border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:8px 10px;display:grid;grid-template-columns:12px minmax(0,1fr) auto;align-items:center;gap:10px;text-align:left;color:#344054;font:inherit;cursor:pointer}.r-manual-stage-option:hover{border-color:var(--stage-color,#1769aa);background:color-mix(in srgb,var(--stage-color,#1769aa) 5%,#fff)}.r-manual-stage-option.current{border-color:color-mix(in srgb,var(--stage-color,#1769aa) 45%,#d0d5dd);background:color-mix(in srgb,var(--stage-color,#1769aa) 8%,#fff)}.r-manual-stage-option:disabled{opacity:.6;cursor:wait}.r-manual-stage-dot{width:11px;height:11px;border-radius:999px;background:var(--stage-color,#1769aa);box-shadow:0 0 0 3px color-mix(in srgb,var(--stage-color,#1769aa) 14%,transparent)}.r-manual-stage-option strong{display:block;font-size:12px}.r-manual-stage-option small{display:block;margin-top:3px;color:#98a2b3;font-size:9px;font-weight:850}.r-manual-stage-current{color:var(--stage-color,#1769aa);font-size:9px;font-weight:1000;text-transform:uppercase}.r-manual-stage-note{margin-top:14px;border:1px solid #dbe7f4;border-radius:11px;background:#f5f9fd;color:#46627d;padding:10px 11px;display:flex;align-items:flex-start;gap:8px;font-size:10px;line-height:1.45}.r-manual-stage-note i{margin-top:1px;color:#1769aa}
    .r-project-tag.property-type{max-width:150px;padding:0;gap:0;overflow:hidden;transition:border-color .16s ease,box-shadow .16s ease,background .16s ease}
    .r-project-tag.property-type:hover,.r-project-tag.property-type.menu-open{border-color:#b9c9db;background:#f8fafc;box-shadow:0 2px 8px rgba(23,105,170,.10)}
    .r-property-type-trigger{display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:25px;border:0;background:transparent;color:inherit;padding:4px 8px;font:inherit;font-weight:1000;line-height:1;cursor:pointer;text-align:left}
    .r-property-type-trigger span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.r-property-type-trigger>i{flex:0 0 auto}.r-property-type-trigger .property-type-chevron{font-size:8px;opacity:.65;transition:transform .16s ease}.r-property-type-trigger[aria-expanded="true"] .property-type-chevron{transform:rotate(180deg)}
    .r-property-type-trigger:focus-visible{outline:2px solid rgba(var(--primary-rgb,217,48,37),.38);outline-offset:-2px;border-radius:999px}
    .r-property-type-menu{position:fixed;z-index:2147483400;width:260px;padding:7px;border:1px solid rgba(15,23,42,.10);border-radius:16px;background:rgba(255,255,255,.98);box-shadow:0 18px 50px rgba(15,23,42,.18),0 3px 10px rgba(15,23,42,.08);backdrop-filter:blur(14px);transform-origin:top right;animation:rPropertyMenuIn .14s ease-out}
    @keyframes rPropertyMenuIn{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
    .r-property-type-option{display:grid;grid-template-columns:34px minmax(0,1fr) 18px;align-items:center;gap:10px;width:100%;min-height:48px;padding:7px 8px;border:0;border-radius:11px;background:transparent;color:#344054;font:inherit;text-align:left;cursor:pointer;transition:background .14s ease,color .14s ease}
    .r-property-type-option:hover,.r-property-type-option:focus-visible{background:#f2f6fa;outline:none}.r-property-type-option[aria-selected="true"]{background:#edf5fc;color:#194f78}
    .r-property-type-option-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:10px;background:#eef2f6;color:#526274}.r-property-type-option[data-property-type="residential"] .r-property-type-option-icon{background:#eaf3fb;color:#1769aa}.r-property-type-option[data-property-type="commercial"] .r-property-type-option-icon{background:#fff3e8;color:#b45309}.r-property-type-option[data-property-type="multifamily"] .r-property-type-option-icon{background:#f1edff;color:#6941c6}
    .r-property-type-option-copy{min-width:0}.r-property-type-option-copy strong{display:block;font-size:11.5px;line-height:1.2}.r-property-type-option-copy small{display:block;margin-top:3px;color:#8491a3;font-size:9.5px;font-weight:750;line-height:1.2}.r-property-type-option-check{font-size:11px;color:#1769aa;opacity:0}.r-property-type-option[aria-selected="true"] .r-property-type-option-check{opacity:1}
    .r-stage-track{overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:2px 1px 4px;scroll-behavior:smooth}
    .r-stage-track::-webkit-scrollbar{display:none}
    .r-stage-list{display:flex;align-items:center;gap:6px;min-width:max-content}
    .r-work-phase-list{display:flex;align-items:center;gap:12px;min-width:max-content}
    .r-work-phase{display:flex;align-items:center;gap:7px;padding-right:12px;border-right:1px solid rgba(15,23,42,.08)}
    .r-work-phase:last-child{border-right:0;padding-right:0}
    .r-work-phase-name{font-size:10px;font-weight:1000;color:#344054;white-space:nowrap}
    .r-stage-pill{display:inline-flex;align-items:center;gap:5px;max-width:142px;min-height:25px;padding:4px 8px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:#f8fafc;color:#98a2b3;font-size:10.5px;font-weight:900;line-height:1;white-space:nowrap;letter-spacing:0}
    .r-stage-pill span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .r-stage-pill i{font-size:9.5px;flex-shrink:0}
    .r-stage-pill.done{background:#ecfdf3;border-color:rgba(22,163,74,.18);color:#15803d}
    .r-stage-pill.current{background:#fffbeb;border-color:#fde68a;color:#92400e;font-weight:1000;box-shadow:inset 0 0 0 1px rgba(245,158,11,.12)}
    .r-stage-pill.upcoming{background:#f8fafc;border-color:rgba(15,23,42,.07);color:#9aa4b2}
    .r-stage-arrow{color:#cbd5e1;font-size:9px;flex:0 0 auto}
    .modal-shell-actions{flex:0 0 auto;display:flex;align-items:center;border-left:1px solid rgba(15,23,42,.10);margin-left:auto}
    .modal-shell-action{align-self:center;min-height:34px;margin:0 8px;padding:0 12px;border:1px solid rgba(var(--primary-rgb,217,48,37),.24);border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:11px;font-weight:1000;white-space:nowrap;cursor:pointer}
    .modal-shell-action[hidden]{display:none!important}
    .modal-shell-btn{width:42px;min-height:47px;border:0;border-left:1px solid rgba(15,23,42,.08);border-radius:0;background:#fff;color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;transition:background .16s ease,color .16s ease}
    .modal-shell-btn:hover{background:#f8fafc;color:#101828}
    .r-form{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1}
    .r-after-hours{display:none;align-items:center;gap:9px;margin:0 0 6px;padding:12px 14px;border-radius:18px;background:#fff7e6;border:1px solid rgba(245,158,11,.24);font-size:12.5px;font-weight:800;color:#9a6700;line-height:1.45}
    .r-after-hours.visible{display:flex}
    .r-step{border:0;background:transparent;border-radius:0;box-shadow:none;overflow:visible;transition:opacity .34s cubic-bezier(.22,1,.36,1),margin .34s cubic-bezier(.22,1,.36,1)}
    .r-step + .r-step{border-top:0}
    .r-step:hover{transform:none;box-shadow:none}
    .r-step[data-status="locked"]{opacity:.58}
    .r-step.is-hidden{display:none}
    .r-step-head{display:flex;align-items:center;gap:12px;padding:4px 0 6px}
    .r-step-txt{min-width:0;display:flex;flex-direction:column;gap:3px}
    .r-step-title{font-size:13px;font-weight:1000;color:#111827}
    .r-step-sub{font-size:11px;font-weight:800;color:#667085;line-height:1.45}
    .r-step-badge{display:none}
    .r-step-shell{display:grid;grid-template-rows:0fr;transition:grid-template-rows .42s cubic-bezier(.22,1,.36,1)}
    .r-step.is-open .r-step-shell{grid-template-rows:1fr}
    .r-step.is-condensed .r-step-sub{display:none}
    .r-step-inner{overflow:visible}
    .r-step-body{padding:0 0 8px;display:flex;flex-direction:column;gap:8px}
    .r-step-line{height:1px;background:rgba(15,23,42,.1);margin-bottom:14px}
    .r-step-summary{display:none;padding:0 0 12px;font-size:12px;font-weight:900;color:#344054}
    .r-step-summary:empty{display:none}
    .r-step.is-condensed .r-step-line{display:none}
    .r-step.is-condensed .r-step-body{padding:0 0 10px;gap:7px}
    .r-step.is-condensed .r-step-summary{display:none}
    .r-step.use-summary.is-condensed .r-step-body{display:none}
    .r-step.use-summary.is-condensed .r-step-summary{display:block;padding:0 0 12px}
    .r-step.is-condensed .r-inp{padding:10px 12px;border-radius:14px}
    .r-step.is-condensed .r-choice-row,
    .r-step.is-condensed .r-inline{gap:8px}
    .r-step.is-condensed .r-type-btn,
    .r-step.is-condensed .r-toggle-btn{flex-direction:row;justify-content:center;padding:9px 10px;border-radius:14px;gap:6px}
    .r-step.is-condensed .r-type-icon,
    .r-step.is-condensed .r-toggle-icon{width:auto;height:auto;border-radius:0;font-size:11px;flex-shrink:0;background:transparent;padding:0}
    .r-step.is-condensed .r-type-label,
    .r-step.is-condensed .r-toggle-label{font-size:11px}
    .r-step.is-condensed .r-type-price,
    .r-step.is-condensed .r-toggle-sub{display:none}
    .r-step.hide-head-when-condensed.is-condensed .r-step-head{display:none}
    #rStepCustomer .r-step-body{padding-bottom:4px}
    #rStepAddress .r-step-body{padding-bottom:4px}
    #rStepType .r-step-body{padding-bottom:4px}
    .r-group{display:flex;flex-direction:column;gap:6px}
    .r-inline{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .r-inline3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .r-group label{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
    .r-help{font-size:10px;font-weight:800;color:#98a2b3;text-transform:none;letter-spacing:0}
    .r-label-optional{font-size:10px;font-weight:800;color:#98a2b3;letter-spacing:0;text-transform:none}
    .r-contact-list.has-multiple .r-label-optional{display:none}
    .r-inline-label{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px}
    .r-step.is-condensed .r-inline-label{display:none}
    .r-inp{width:100%;padding:10px 11px;border-radius:12px;border:1px solid rgba(15,23,42,.14);outline:none;background:rgba(255,255,255,.94);font-weight:850;color:#101828;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease;box-sizing:border-box;font-size:13px;min-height:40px}
    .r-inp:focus{border-color:rgba(217,48,37,.7);box-shadow:0 0 0 4px rgba(217,48,37,.12);transform:translateY(-1px)}
    .r-inp.loading{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24'%3E%3Cstyle%3E%40keyframes s%7Bto%7Btransform:rotate(360deg)%7D%7D%3C/style%3E%3Ccircle cx='12' cy='12' r='9' fill='none' stroke='%23cbd5e1' stroke-width='2.5'/%3E%3Cpath d='M12 3a9 9 0 0 1 9 9' fill='none' stroke='%23d93025' stroke-width='2.5' stroke-linecap='round' style='transform-origin:center;animation:s .65s linear infinite'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:18px 18px;padding-right:40px}
    .r-choice-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;position:relative;overflow:visible}
    .r-report-choice-row{grid-template-columns:repeat(3,minmax(0,1fr));width:100%}
    .r-report-choice-row .r-toggle-btn{min-height:58px;padding:10px 12px;border-radius:14px;flex-direction:row;gap:8px}
    .r-report-choice-row .r-toggle-icon{width:28px;height:28px;border-radius:9px;font-size:12px;flex-shrink:0}
    .r-report-choice-row .r-toggle-label{font-size:12px}
    .r-report-choice-row .r-toggle-sub{display:none}
    .r-expedite-panel{display:none;border:1px solid rgba(var(--primary-rgb,217,48,37),.16);background:linear-gradient(180deg,rgba(var(--primary-rgb,217,48,37),.055),#fff 58%);border-radius:16px;padding:12px;gap:8px;flex-direction:column;margin-top:2px}
    .r-expedite-panel.visible{display:flex}
    .r-expedite-panel.is-closed .r-expedite-wait{display:none}
    .r-expedite-title{font-size:12px;font-weight:1000;color:#111827}
    .r-expedite-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .r-expedite-wait{display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid rgba(15,23,42,.1);border-radius:14px;background:#fff;box-shadow:0 10px 24px rgba(15,23,42,.05)}
    .r-expedite-default{grid-column:1/-1}
    .r-expedite-default-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    .r-expedite-status{display:flex;flex-direction:column;gap:2px;min-width:0}
    .r-expedite-status strong{font-size:13px;font-weight:1000;color:#101828;line-height:1.2}
    .r-expedite-status span{font-size:11px;font-weight:850;color:#667085;line-height:1.25}
    .r-expedite-eta{font-size:12px;font-weight:1000;color:var(--primary-readable,var(--primary,#d93025));white-space:nowrap}
    .r-expedite-bar{display:block;width:100%;position:relative;height:9px;border-radius:999px;background:linear-gradient(90deg,#22c55e 0%,#f59e0b 52%,#ef4444 100%);box-shadow:inset 0 0 0 1px rgba(15,23,42,.08)}
    .r-expedite-marker{position:absolute;top:50%;left:var(--wait-position,50%);width:17px;height:17px;border-radius:999px;background:#fff;border:3px solid var(--primary-readable,var(--primary,#d93025));box-shadow:0 5px 14px rgba(15,23,42,.22);transform:translate(-50%,-50%)}
    .r-expedite-bar-labels{display:flex;justify-content:space-between;font-size:10px;font-weight:950;color:#98a2b3;line-height:1}
    .r-expedite-btn{appearance:none;border:1px solid rgba(15,23,42,.10);border-radius:14px;background:#fff;padding:10px 11px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:center;gap:9px;cursor:pointer;text-align:left;color:#344054;min-height:64px;position:relative;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease,filter .16s ease,background .16s ease}
    .r-expedite-btn:hover{transform:translateY(-1px);filter:none;border-color:rgba(15,23,42,.22);box-shadow:0 14px 28px rgba(15,23,42,.08)}
    .r-expedite-btn:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
    .r-expedite-btn.selected{transform:translateY(-1px);border-color:rgba(var(--primary-rgb,217,48,37),.42);background:#fff;box-shadow:inset 0 0 0 2px rgba(var(--primary-rgb,217,48,37),.12),0 0 0 4px rgba(var(--primary-rgb,217,48,37),.10),0 16px 30px rgba(15,23,42,.10);filter:none}
    .r-expedite-copy{grid-column:1;grid-row:1 / span 2;min-width:0;display:flex;flex-direction:column;gap:3px}
    .r-expedite-name{font-size:12px;font-weight:1000;color:#101828;line-height:1.15}
    .r-expedite-window{font-size:11px;font-weight:900;color:#667085;line-height:1.15;white-space:nowrap;overflow:visible;letter-spacing:0}
    .r-expedite-window.compact{font-size:10px}
    .r-expedite-pill{display:inline-flex;align-items:center;align-self:flex-start;margin-top:1px;padding:2px 6px;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025));font-size:9px;font-weight:1000;line-height:1;text-transform:uppercase}
    .r-expedite-price{grid-column:2;grid-row:1 / span 2;align-self:center;font-size:24px;font-weight:1000;color:var(--primary-readable,var(--primary,#d93025));line-height:.95;letter-spacing:0;white-space:nowrap;display:inline-flex;align-items:baseline;justify-content:flex-end;min-width:max-content}
    .r-expedite-price.is-loading{min-width:58px;height:28px;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.07);align-items:center;justify-content:center;font-size:12px}
    .r-expedite-price.is-loading::before{content:'';width:14px;height:14px;border-radius:999px;border:2px solid currentColor;border-right-color:transparent;animation:fa-spin .75s linear infinite;opacity:.78}
    .r-expedite-price-cents{font-size:.5em;line-height:1;vertical-align:baseline}
    .r-expedite-price.has-coupon{display:flex;flex-direction:column;align-items:flex-end;gap:4px;line-height:1}
    .r-expedite-price s{font-size:12px;font-weight:900;opacity:.82;display:inline-flex;align-items:baseline}
    .r-expedite-coupon{display:none;align-items:center;gap:8px;padding:8px 10px;border-radius:12px;background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:11px;font-weight:900;line-height:1.35}
    .r-expedite-coupon.visible{display:flex}
    .r-expedite-coupon i{color:#d97706}
    .r-expedite-submit{display:none;width:100%;justify-content:center;margin-top:6px}
    .r-expedite-submit.visible{display:flex}
    .r-submit-spinner{width:1em;height:1em;display:inline-flex;align-items:center;justify-content:center;margin-right:8px;line-height:1;transform-origin:50% 50%;flex:0 0 auto}
    .r-type-btn,.r-toggle-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:15px 10px 13px;border-radius:18px;border:1px solid rgba(15,23,42,.1);background:#f8fafc;cursor:pointer;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease,background .18s ease,color .18s ease;text-align:center;font-weight:900;color:#334155}
    .r-type-btn:hover,.r-toggle-btn:hover{transform:translateY(-1px);border-color:rgba(15,23,42,.22);box-shadow:0 14px 28px rgba(15,23,42,.08);z-index:4}
    .r-type-btn,.r-toggle-btn{position:relative;z-index:1}
    .r-type-btn.selected,.r-toggle-btn.selected{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),0.08);box-shadow:0 16px 30px rgba(var(--primary-rgb,217,48,37),0.14);color:var(--primary-readable,var(--primary,#d93025))}
    .r-type-icon,.r-toggle-icon{width:38px;height:38px;border-radius:14px;background:rgba(15,23,42,.06);display:flex;align-items:center;justify-content:center;font-size:15px;transition:.18s ease}
    .r-type-btn.selected .r-type-icon,.r-toggle-btn.selected .r-toggle-icon{background:rgba(var(--primary-rgb,217,48,37),0.14);color:var(--primary-readable,var(--primary,#d93025))}
    .r-type-label,.r-toggle-label{font-size:12px;font-weight:1000}
    .r-type-price,.r-toggle-sub{font-size:10px;font-weight:900;color:#667085}
    .r-type-btn.selected .r-type-price,.r-toggle-btn.selected .r-toggle-sub{color:var(--primary-readable,var(--primary,#d93025))}
    .r-step.hide-prices .r-type-price{display:none}
    .r-type-pill-row{display:none}
    .r-type-pill-row .r-viewer-type-tag[data-type-pill]{cursor:pointer}
    .r-type-pill-row .r-viewer-type-tag[data-type-pill]:hover{border-color:rgba(var(--primary-rgb,217,48,37),.22);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.05)}
    .r-type-pill-row .r-viewer-type-tag:not([data-type-pill]){cursor:default}
    .r-type-pill-row .r-viewer-type-tag .fa-chevron-down{font-size:9px;opacity:.72}
    .r-overlay #rStepType.is-condensed #rTypeGroup{display:none!important}
    .r-overlay #rStepType.is-condensed #rTypePill{display:flex!important;gap:8px;align-items:center;flex-wrap:wrap}
    .r-overlay.report-ordered #rTypeGroup{display:none}
    .r-overlay.report-ordered #rTypePill{display:flex}
    .r-order-select{position:relative;display:inline-flex;align-items:center;min-width:0;color:#344054;background:#f2f4f7;border:1px solid #dfe3e8;border-radius:999px;height:28px}
    .r-order-select>i{position:absolute;left:9px;font-size:11px;pointer-events:none}
    .r-order-select>i:last-child{left:auto;right:9px;font-size:9px}
    .r-order-select select{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:11px;font-weight:700;padding:4px 25px 4px 27px;border-radius:inherit;cursor:pointer;max-width:100%;height:100%}
    .r-order-select:focus-within{border-color:var(--primary-readable,var(--primary,#d93025));outline:none;box-shadow:none}
    .r-order-select select:focus,.r-order-select select:focus-visible{outline:none;box-shadow:none}
    .r-order-select select option{background:#fff;color:#344054;font-weight:500;text-align:left}
    #rStepAddress{padding-top:0}
    .r-project-address-step{margin:0;padding:0;border:0;background:transparent}
    .r-project-address-row{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;align-items:center}
    .r-project-address-row .r-inp{width:100%;min-width:0;height:26px;min-height:26px;box-sizing:border-box;border:1px solid rgba(15,23,42,.10);border-radius:7px;background:#fff;color:#101828;padding:3px 6px;font-size:12px;font-weight:900;outline:none;box-shadow:none}
    .r-project-address-row .r-inp:focus{border-color:rgba(var(--primary-rgb,217,48,37),.35);background:#fff;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08);transform:none}
    .r-contact-list{display:flex;flex-direction:column;gap:5px}
    .r-contact-card{position:relative;border:1px solid rgba(15,23,42,.08);border-radius:10px;background:#fff;padding:7px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 7px;align-items:center;box-shadow:0 1px 0 rgba(15,23,42,.03)}
    .r-overlay.contacts-disabled .r-contact-card{grid-template-columns:minmax(0,1fr)}
    .r-contact-card.has-inline-add{grid-template-columns:minmax(0,1fr) auto}
    .r-overlay.contacts-disabled .r-contact-card.has-inline-add{grid-template-columns:minmax(0,1fr)}
    .r-mobile-customer-label{display:none;font-size:10px;font-weight:1000;color:#667085;letter-spacing:.04em;text-transform:uppercase}
    .r-contact-list.has-multiple .r-contact-card{background:#fff;padding:7px}
    .r-contact-list.has-multiple .r-contact-card.has-inline-add{grid-template-columns:minmax(0,1fr) auto}
    .r-overlay.contacts-disabled .r-contact-list.has-multiple .r-contact-card.has-inline-add{grid-template-columns:minmax(0,1fr)}
    .r-contact-card .r-inline{display:grid;grid-template-columns:minmax(0,1fr) minmax(118px,.68fr);gap:6px;grid-column:1}
    .r-contact-card .r-contact-email-row{display:grid;grid-template-columns:minmax(0,1fr);grid-column:1;gap:0;align-items:center}
    .r-contact-card.has-inline-add .r-contact-email-row{display:grid}
    .r-contact-card.has-inline-add .r-contact-email-row .r-group{min-width:0}
    .r-contact-card.has-inline-add .r-contact-email-row .r-contact-add{align-self:end}
    .r-contact-card .r-group{min-width:0;gap:0}
    .r-contact-card .r-group label{display:none}
    .r-contact-card .r-inp{padding:3px 6px;min-height:24px;border-radius:7px;border-color:rgba(15,23,42,.10);background:#fff;font-size:12px;font-weight:900;box-shadow:none}
    .r-contact-card .r-inp:focus{border-color:rgba(var(--primary-rgb,217,48,37),.35);background:#fff;box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08);transform:none}
    .r-contact-card [data-field="name"]{font-size:12.5px;font-weight:1000;color:#101828}
    .r-contact-card [data-field="phone"]{text-align:left;color:#344054}
    .r-contact-card [data-field="email"]{font-size:11.5px;color:#667085}
    .r-contact-actions{grid-column:2;grid-row:1 / span 2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;align-self:center}
    .r-contact-primary{display:flex;width:26px;height:26px;border-radius:8px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#f59e0b;align-items:center;justify-content:center;cursor:pointer;flex:0 0 auto}
    .r-contact-card:not(.primary) .r-contact-primary{display:none}
    .r-contact-primary i{font-size:11px}
    .r-contact-card.primary .r-contact-primary{color:#f59e0b;background:#fff8e6;border-color:rgba(245,158,11,.22)}
    .r-contact-menu-btn{display:flex;width:26px;height:26px;border-radius:8px;border:1px solid rgba(15,23,42,.10);background:#fff;color:#667085;align-items:center;justify-content:center;cursor:pointer;transition:.14s ease;flex:0 0 auto}
    .r-contact-menu-btn:hover{background:#f8fafc;color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),0.22)}
    .r-contact-menu-btn i{font-size:11px}
    .r-contact-primary,.r-contact-remove,.r-contact-view{box-shadow:none}
    .r-contact-remove,.r-contact-view{display:none}
    .r-overlay.contacts-disabled .r-contact-actions{display:none}
    .r-contact-add{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;width:100%;padding:8px 10px;border-radius:10px;border:1px dashed rgba(15,23,42,.18);background:#fff;font-size:11.5px;font-weight:1000;color:#475467;cursor:pointer;transition:.14s ease}
    .r-contact-add.compact{width:34px;min-width:34px;min-height:34px;height:34px;padding:0;align-self:end;white-space:nowrap;flex:0 0 auto}
    .r-contact-add.compact span{display:none}
    .r-contact-card .r-contact-add{display:none}
    #rAddContact{display:none!important}
    .r-contact-add:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.35);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),0.03)}
    .r-contact-action-menu{position:fixed;z-index:2147483450;min-width:188px;display:none;flex-direction:column;gap:4px;padding:6px;border:1px solid rgba(15,23,42,.12);border-radius:12px;background:rgba(255,255,255,.98);box-shadow:0 18px 42px rgba(15,23,42,.20);backdrop-filter:blur(12px)}
    .r-contact-action-menu.visible{display:flex}
    .r-contact-action-menu button{border:0;border-radius:9px;background:transparent;color:#344054;min-height:34px;padding:0 9px;display:flex;align-items:center;gap:9px;text-align:left;font-size:12px;font-weight:900;cursor:pointer}
    .r-contact-action-menu button:hover{background:rgba(var(--primary-rgb,217,48,37),.05);color:var(--primary-readable,var(--primary,#d93025))}
    .r-contact-action-menu button.danger:hover{background:#fef2f2;color:#b42318}
    .r-contact-action-menu button:disabled{opacity:.45;cursor:not-allowed;background:transparent;color:#98a2b3}
    .r-contact-action-menu i{width:14px;text-align:center}
    .r-contact-picker{position:fixed;z-index:2147483400;width:min(360px,calc(100vw - 36px));max-height:360px;display:none;flex-direction:column;gap:8px;padding:10px;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:rgba(255,255,255,.98);box-shadow:0 24px 60px rgba(15,23,42,.22);backdrop-filter:blur(12px)}
    .r-contact-picker.visible{display:flex}
    .r-contact-picker-search{width:100%;box-sizing:border-box;border:1px solid rgba(15,23,42,.14);border-radius:11px;min-height:36px;padding:8px 10px;font-size:12.5px;font-weight:850;outline:none}
    .r-contact-picker-list{overflow:auto;display:flex;flex-direction:column;gap:5px;min-height:80px;max-height:220px}
    .r-contact-picker-row{border:1px solid rgba(15,23,42,.08);border-radius:10px;background:#fff;min-height:42px;padding:8px 9px;text-align:left;display:flex;align-items:center;gap:9px;cursor:pointer}
    .r-contact-picker-row:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-contact-picker-row i{color:#667085;width:16px;text-align:center}
    .r-contact-picker-row span{display:flex;flex-direction:column;gap:2px;min-width:0}
    .r-contact-picker-row strong{font-size:12px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-contact-picker-row small{font-size:11px;font-weight:850;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-contact-picker-new{border:1px dashed rgba(15,23,42,.18);border-radius:11px;background:#fff;min-height:38px;display:flex;align-items:center;justify-content:center;gap:8px;color:#344054;font-size:12px;font-weight:1000;cursor:pointer}
    .r-contact-picker-new:hover{border-color:rgba(var(--primary-rgb,217,48,37),.32);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.03)}
    .r-contact-picker-empty{padding:18px 10px;text-align:center;color:#667085;font-size:12px;font-weight:850}
    .r-customer-portal-link{display:none;margin:2px 0 7px}
    .r-customer-portal-link.visible{display:block}
    .r-customer-portal-card{border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#f8fafc;padding:6px 7px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:7px}
    .r-customer-portal-card-head{display:flex;align-items:center;gap:6px;min-width:0}
    .r-customer-portal-card-title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:1000;color:#101828;white-space:nowrap}
    .r-customer-portal-card-title i{color:var(--primary-readable,var(--primary,#d93025))}
    .r-customer-portal-card-status{font-size:9.5px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.02em;white-space:nowrap}
    .r-customer-portal-actions{display:flex;align-items:center;gap:6px;justify-self:end;grid-column:2}
    .r-customer-portal-actions button,.r-customer-portal-actions a{border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff;color:#344054;min-height:26px;padding:0 7px;font-size:10.5px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center;gap:5px;text-decoration:none;cursor:pointer;white-space:nowrap}
    .r-customer-portal-actions button.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .r-customer-portal-actions button:hover,.r-customer-portal-actions a:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);color:var(--primary-readable,var(--primary,#d93025))}
    .r-workflow-dock{display:none;border-top:1px solid rgba(15,23,42,.08);padding-top:10px;margin-top:2px}
    .r-workflow-dock.visible{display:block}
    .r-workflow-empty{display:flex;flex-direction:column;gap:8px}
    .r-workflow-empty-title{font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
    .r-workflow-todos{min-height:92px;max-height:clamp(180px,calc(var(--fm-visual-vh,100vh) - 430px),420px)}
    .r-workflow-todos .pai-today-list{max-height:inherit;overflow-y:auto;overscroll-behavior:contain;padding-right:4px}
    .r-workflow-todos .pai-composer{position:sticky;top:0;z-index:1;background:#fff;box-shadow:0 5px 8px -8px rgba(15,23,42,.45)}
    .r-overlay.project-todos-visible:not(.left-override) .r-scroll{overflow:hidden;display:flex;flex-direction:column}
    .r-overlay.project-todos-visible:not(.left-override) .r-workflow-dock.visible,.r-overlay.project-todos-visible:not(.left-override) .r-workflow-empty{display:flex;flex:1 1 auto;flex-direction:column;min-height:0}
    .r-overlay.project-todos-visible:not(.left-override) .r-workflow-todos{flex:1 1 auto;min-height:0;max-height:none}
    .r-overlay.project-todos-visible:not(.left-override) .r-workflow-todos .pai-today-list{height:100%;max-height:none}
    .r-workflow-todos .pai-today-list{gap:6px}
    .r-workflow-todos .pai-composer{margin-bottom:4px}
    .r-workflow-todos .pai-state{font-size:12px;padding:12px}
    .r-pin-info{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:14px;background:#eff6ff;border:1px solid rgba(59,130,246,.18);font-size:12px;font-weight:900;color:#2563eb;transition:.2s ease}
    .r-pin-info.has-pins{background:#e9f9ee;border-color:rgba(34,197,94,.18);color:#15803d}
    .r-pin-info.pin-limit{background:#fff7ed;border-color:rgba(234,88,12,.22);color:#c2410c}
    .r-pin-count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 7px;border-radius:8px;background:rgba(37,99,235,.12);font-size:12px;font-weight:1000}
    .r-pin-info.has-pins .r-pin-count{background:rgba(21,128,61,.12)}
    .r-pin-info.pin-limit .r-pin-count{background:rgba(234,88,12,.12)}
    .r-pin-clear{margin-left:auto;padding:6px 10px;border-radius:10px;border:1px solid rgba(15,23,42,.1);background:#fff;font-size:11px;font-weight:1000;color:#475467;cursor:pointer;display:none}
    .r-pin-info.has-pins .r-pin-clear{display:block}
    .r-pricing-note{display:none;align-items:center;gap:6px;margin:-6px 2px 0;padding:0 2px;font-size:11px;font-weight:800;color:#667085;line-height:1.45}
    .r-pricing-note.visible{display:flex}
    .r-referral-discount{display:none;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:14px;background:#eef9f2;border:1px solid rgba(22,163,74,.16);font-size:11px;font-weight:900;color:#16703c;line-height:1.45}
    .r-referral-discount.visible{display:flex}
    .r-referral-discount s{margin-right:5px;color:#667085}
    .r-addon-list{display:none;flex-direction:column;gap:8px;margin-top:10px}
    .r-addon-list.visible{display:flex}
    .r-addon-inline{display:none}
    .r-addon-inline.visible{display:flex}
    .r-report-order-group{display:flex;flex-direction:column;gap:12px}
    #rRoofReportFields{display:flex;flex-direction:column;gap:12px}
    .r-report-submit{width:100%;justify-content:center}
    .r-schedule-choice-card{display:none;border:1px solid rgba(15,23,42,.09);background:#fff;border-radius:14px;padding:12px;gap:10px;align-items:flex-start;color:#475467;font-size:12px;font-weight:800;line-height:1.45}
    .r-schedule-choice-card.visible{display:flex}
    .r-schedule-choice-card i{width:30px;height:30px;border-radius:10px;background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .r-schedule-choice-card strong{display:block;color:#101828;font-size:12px;font-weight:1000;margin-bottom:2px}
    .r-report-order-group .r-addon-list{margin-top:0}
    .r-addon-toggle{width:100%;border:1px solid rgba(15,23,42,.1);background:#fff;border-radius:14px;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;text-align:left;transition:.18s ease}
    .r-addon-toggle:hover{border-color:rgba(15,23,42,.22);transform:translateY(-1px)}
    .r-addon-toggle.selected{border-color:rgba(var(--primary-rgb,217,48,37),.34);background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.08)}
    .r-addon-copy{display:flex;align-items:center;gap:9px;min-width:0}
    .r-addon-title{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:1000;color:#101828;line-height:1.2}
    .r-addon-side{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .r-addon-price{font-size:12px;font-weight:1000;color:var(--primary-readable,var(--primary,#d93025));white-space:nowrap}
    .r-switch{width:38px;height:22px;border-radius:999px;background:#e4e7ec;border:1px solid rgba(15,23,42,.08);position:relative;transition:.18s ease;display:inline-block}
    .r-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.2);transition:.18s ease}
    .r-addon-toggle.selected .r-switch{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
    .r-addon-toggle.selected .r-switch::after{transform:translateX(16px)}
    .r-addon-info-popout{position:absolute;left:18px;top:72px;z-index:34;width:min(360px,calc(100% - 36px));display:none;border:1px solid rgba(15,23,42,.12);border-radius:18px;background:rgba(255,255,255,.96);box-shadow:0 24px 60px rgba(15,23,42,.22);padding:16px;text-align:left;color:#344054;backdrop-filter:blur(12px)}
    .r-addon-info-popout.visible{display:block}
    .r-addon-info-card h4{margin:0 0 7px;font-size:15px;font-weight:1000;color:#101828}
    .r-addon-info-card p{margin:0 0 10px;font-size:12px;font-weight:800;line-height:1.5;color:#475467}
    .r-addon-info-card ul{margin:0;padding-left:18px;display:grid;gap:5px;font-size:12px;font-weight:850;line-height:1.4;color:#344054}
    .r-addon-info-card li::marker{color:var(--primary-readable,var(--primary,#d93025))}
    .r-addon-info-price{margin-top:12px;padding-top:10px;border-top:1px solid rgba(15,23,42,.08);font-size:12px;font-weight:1000;color:var(--primary-readable,var(--primary,#d93025));line-height:1.35}
    .r-addon-info-actions{display:flex;margin-top:14px;padding-top:12px;border-top:1px solid rgba(15,23,42,.08)}
    .r-addon-info-sample{min-height:34px;border-radius:11px;border:1px solid rgba(var(--primary-rgb,217,48,37),.22);background:var(--primary,#d93025);color:#fff;font-size:12px;font-weight:1000;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 13px}
    .r-addon-info-sample:hover{filter:brightness(.96)}
    .r-addon-info-modal{position:fixed;inset:0;z-index:2147483400;background:rgba(15,23,42,.46);display:flex;align-items:flex-end;justify-content:center;padding:16px;box-sizing:border-box}
    .r-addon-info-modal-card{width:min(520px,100%);max-height:82vh;overflow:auto;border-radius:22px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.30);padding:18px;position:relative}
    .r-addon-info-modal-close{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:12px;border:1px solid rgba(15,23,42,.10);background:#fff;color:#475467;display:flex;align-items:center;justify-content:center}
    .r-confirm{display:flex;align-items:center;gap:10px;border-radius:16px;padding:10px;border:1px solid rgba(15,23,42,.1);background:#f8fafc;opacity:.6;pointer-events:none;transition:.18s ease}
    .r-confirm.active{opacity:1;pointer-events:auto;background:#fff}
    .r-confirm.checked{background:#e9f9ee;border-color:rgba(22,163,74,.35)}
    .r-confirm .ic{font-size:18px;color:#98a2b3;flex-shrink:0}
    .r-confirm.active .ic{color:#d93025}
    .r-confirm.checked .ic{color:#16a34a}
    .r-confirm .tx{font-weight:950;font-size:13px;color:#1f2937;line-height:1.4}
    .r-mobile-pin-count{display:none}
    .r-cc-list{display:flex;flex-direction:column;gap:8px}
    .r-cc-row{display:flex;gap:8px;align-items:center}
    .r-cc-row input{flex:1}
    .r-cc-remove{width:34px;height:34px;border-radius:12px;border:1px solid rgba(15,23,42,.1);background:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#98a2b3;transition:.14s ease;flex-shrink:0}
    .r-cc-remove:hover{background:#fef2f2;color:#d93025;border-color:rgba(217,48,37,.2)}
    .r-cc-add{display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:12px;border:1px dashed rgba(15,23,42,.18);background:transparent;font-size:12px;font-weight:1000;color:#475467;cursor:pointer;transition:.14s ease;align-self:flex-start}
    .r-cc-add:hover{border-color:rgba(217,48,37,.32);color:#d93025;background:rgba(217,48,37,.03)}
    .r-btn{flex:1 1 0;padding:13px 14px;border-radius:16px;border:1px solid rgba(15,23,42,.12);background:#fff;font-weight:1000;cursor:pointer;transition:.18s ease;color:#1f2937}
    .r-btn:hover{transform:translateY(-1px);box-shadow:0 14px 28px rgba(15,23,42,.08)}
    .r-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 18px 32px rgba(var(--primary-rgb,217,48,37),.22)}
    .r-btn.primary:hover{background:var(--primary-dark,var(--primary,#d93025));border-color:var(--primary-dark,var(--primary,#d93025));box-shadow:0 20px 36px rgba(var(--primary-rgb,217,48,37),.26)}
    .r-btn:disabled{opacity:1;cursor:not-allowed;transform:none;box-shadow:none}
    .r-btn.primary:disabled{color:#667085;background:#e5e7eb;border-color:#d1d5db;box-shadow:none}
    .r-btn.primary:disabled:hover{background:#e5e7eb;border-color:#d1d5db;transform:none;box-shadow:none}
    .r-btn.choice{display:none;align-items:center;justify-content:center}
    .r-left-bottom{transition:none}.r-bottom-notes{position:relative;min-height:0}.r-note-composer-shell{position:relative;z-index:2;display:flex;flex-direction:column;gap:6px;min-height:0;flex:0 0 auto;background:#fff}#rProjectAudioPending:empty{display:none}
    .r-bottom-notes-head{min-height:18px;display:flex;align-items:center;justify-content:space-between;gap:8px}.r-bottom-notes-head label{min-width:0;font-size:10px;line-height:1.15}.r-note-visibility-control{display:flex;align-items:center;justify-content:flex-end;gap:9px;min-width:0;white-space:nowrap}.r-note-visibility-disclaimer{font-size:8px;font-weight:800;color:#98a2b3}.r-note-visibility-choice{min-width:0;display:inline-flex;align-items:center;justify-content:flex-end;gap:2px;color:#667085;cursor:pointer;transition:color .16s ease,transform .16s ease}.r-note-visibility-choice strong{max-width:112px;overflow:hidden;text-overflow:ellipsis;font-size:9px;font-weight:950;color:currentColor}.r-note-visibility-choice i{width:14px;height:18px;display:grid;place-items:center;font-size:10px;flex:0 0 auto}.r-note-visibility-choice:hover,.r-note-visibility-choice[aria-expanded="true"]{color:var(--primary-readable,var(--primary,#d93025));transform:translateY(-1px)}
    .r-note-input-wrap{position:relative;min-height:56px}.r-note-input-wrap textarea{display:block;width:100%}.r-bottom-notes textarea{position:relative;z-index:2;box-sizing:border-box;min-height:56px;max-height:180px;resize:none!important;overflow-y:hidden;font-family:inherit;font-size:12px;line-height:1.42;transition:height .16s ease,border-color .16s ease,box-shadow .16s ease}.r-note-input-wrap.has-mentions textarea{background:transparent;color:transparent;caret-color:#101828}.r-note-input-wrap.has-mentions textarea::selection{color:transparent;background:rgba(59,130,246,.3)}.r-note-input-highlights{position:absolute;z-index:1;inset:0;box-sizing:border-box;overflow:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:break-word;padding:10px 12px;border:1px solid transparent;border-radius:inherit;background:#fff;font-family:inherit;font-size:12px;line-height:1.42;color:#101828}.r-note-input-highlights .r-note-compose-mention{display:inline;border-radius:4px;background:rgba(var(--primary-rgb,217,48,37),.1);box-shadow:0 0 0 1px rgba(var(--primary-rgb,217,48,37),.22);color:var(--primary-readable,var(--primary,#d93025));box-decoration-break:clone;-webkit-box-decoration-break:clone}
    /* FirstMeasure's saved note stays independent of the Channels history layout. */
    .r-left.notes-panel-ready:has(.r-firstmeasure-notes){padding-bottom:18px}
    .r-firstmeasure-notes{display:flex;flex-direction:column;gap:6px}
    .r-firstmeasure-notes .r-bottom-notes-head{min-height:26px}
    .r-firstmeasure-notes .r-bottom-notes-head label{margin:0;color:#667085;font-size:10px;letter-spacing:.04em}
    .r-firstmeasure-notes .r-bottom-notes-toggle{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:#667085;font:inherit;font-size:11px;cursor:pointer}
    .r-firstmeasure-notes .r-bottom-notes-toggle:hover{background:#f2f4f7;color:#344054}
    .r-firstmeasure-notes .r-bottom-notes-toggle:focus-visible{outline:2px solid var(--primary-readable,var(--primary,#d93025));outline-offset:2px}
    .r-firstmeasure-notes .r-bottom-notes-toggle i{transition:transform .16s ease}
    .r-firstmeasure-notes.notes-expanded .r-bottom-notes-toggle i{transform:rotate(180deg)}
    .r-firstmeasure-notes textarea.r-inp{display:block;width:100%;height:72px!important;min-height:72px;max-height:160px;overflow-y:auto!important;padding:10px 12px;border:1px solid #e4e7ec;border-radius:10px;background:#fafbfc;font-family:inherit;font-size:12px;line-height:1.45}
    .r-firstmeasure-notes.notes-expanded textarea.r-inp{height:160px!important}
    .r-firstmeasure-notes textarea.r-inp:focus{background:#fff}
    .r-note-visibility-menu{position:fixed;right:auto;top:0;left:0;z-index:2147483647;width:max-content;min-width:190px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);min-height:36px;padding:6px;display:grid;grid-auto-rows:minmax(32px,auto);gap:2px;overflow-x:hidden;overflow-y:auto;border:1px solid rgba(15,23,42,.14);border-radius:10px;background:#fff;color:#344054;box-shadow:0 18px 44px rgba(15,23,42,.24);isolation:isolate;animation:rNoteMenuIn .16s cubic-bezier(.22,1,.36,1)}.r-note-visibility-menu[hidden]{display:none!important}@keyframes rNoteMenuIn{from{opacity:0;transform:translateX(-6px) scale(.98)}to{opacity:1;transform:none}}
    .r-note-visibility-menu button{width:100%;min-height:32px;border:0;border-radius:7px;background:#fff;padding:7px 9px;display:flex;align-items:center;gap:8px;color:#344054;font:inherit;font-size:11px;line-height:1.2;font-weight:900;text-align:left;white-space:nowrap;cursor:pointer}.r-note-visibility-menu button:hover{background:#f2f4f7}.r-note-visibility-menu i{width:13px;color:#98a2b3}.r-note-visibility-menu button.active i{color:var(--primary-readable,var(--primary,#d93025))}
    .r-note-compose-actions{min-height:29px;display:flex;align-items:center;justify-content:space-between;gap:8px}.r-note-history-toggle{display:inline-flex;align-items:center;gap:5px;color:#667085;font-size:9px;font-weight:900;cursor:pointer;user-select:none;transform:translateY(-2px);transition:color .16s ease}.r-note-history-toggle:hover{color:#111827}.r-note-history-chevron{font-size:8px;transition:transform .28s cubic-bezier(.22,1,.36,1)}.r-bottom-notes.expanded .r-note-history-chevron{transform:rotate(180deg)}.r-note-compose-actions .r-note-audio{width:29px;height:29px;padding:0;border:1px solid #d0d5dd;background:#fff;color:#475467}.r-note-compose-actions .r-note-audio:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.34)}
    .r-note-compose-right{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0}.r-note-compose-right>span{font-size:9px;font-weight:900;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.r-note-compose-actions button{box-sizing:border-box;height:29px;border:0;border-radius:8px;background:#111827;color:#fff;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;gap:4px;font-size:10px;font-weight:950;cursor:pointer;transition:transform .16s ease,box-shadow .16s ease}.r-note-compose-actions button:hover{transform:translateY(-1px);box-shadow:0 7px 16px rgba(15,23,42,.16)}.r-note-compose-actions button:disabled{opacity:.45;cursor:default}
    .r-note-history-deck{position:relative;isolation:isolate;box-sizing:border-box;min-height:0;height:0;margin-bottom:-6px;padding:0 0 0;border-bottom:1px solid transparent;visibility:hidden;overflow:visible;display:flex;flex-direction:column;gap:7px;transition:visibility 0s linear .5s}.r-bottom-notes.expanded .r-note-history-deck{height:auto;margin-bottom:0;padding:10px 0 9px;border-bottom-color:rgba(15,23,42,.14);visibility:visible;transition:visibility 0s}.r-note-history-deck::before{content:'';position:absolute;z-index:-1;inset:0 -18px -9px;background:#fff;border-top:1px solid rgba(15,23,42,.18);box-shadow:none;clip-path:inset(-40px 0 0);transform:scaleY(0);transform-origin:center bottom;transition:transform .5s cubic-bezier(.45,0,.55,1);will-change:transform}.r-bottom-notes.expanded .r-note-history-deck::before{transform:scaleY(1)}.r-bottom-notes.opening .r-note-history-deck::before,.r-bottom-notes.closing .r-note-history-deck::before{transform:scaleY(0)}.r-note-history-tools,.r-note-history{position:relative;z-index:1;opacity:0;transition:opacity .14s ease}.r-bottom-notes.expanded:not(.opening):not(.closing) .r-note-history-tools,.r-bottom-notes.expanded:not(.opening):not(.closing) .r-note-history{opacity:1;transition:opacity .2s ease .28s}
    .r-note-history-tools{flex:0 0 auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.r-note-history-tools input,.r-note-history-tools select{min-width:0;height:28px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;padding:0 7px;font:inherit;font-size:10px;color:#344054}.r-note-history{flex:1 1 auto;min-height:52px;overflow:auto;display:flex;flex-direction:column;gap:7px;padding-right:2px}.r-note-card{border:1px solid rgba(15,23,42,.08);border-radius:9px;background:#f8fafc;padding:8px;display:flex;flex-direction:column;gap:5px}.r-note-card p{margin:0;white-space:pre-wrap;font-size:11px;line-height:1.55;color:#344054}.r-note-mention{position:relative;display:inline-flex;align-items:center;vertical-align:baseline;margin:0 1px;padding:1px 5px;border:1px solid rgba(var(--primary-rgb,217,48,37),.2);border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));font-weight:750;line-height:1.25;white-space:nowrap;cursor:pointer}.r-note-mention::before{content:'@';font-weight:800;opacity:.82}.r-note-mention-card{position:fixed;left:0;top:0;z-index:2147483646;width:max-content;min-width:220px;max-width:280px;padding:10px;border:1px solid rgba(15,23,42,.1);border-radius:14px;background:#fff;color:#101828;box-shadow:0 18px 38px rgba(15,23,42,.18);display:none;grid-template-columns:34px minmax(0,1fr);gap:9px;white-space:normal;pointer-events:none}.r-note-mention-card.visible{display:grid}.r-note-mention-avatar{width:34px;height:34px;border-radius:999px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:13px;font-weight:1000}.r-note-mention-avatar img{width:100%;height:100%;object-fit:cover}.r-note-mention-name{display:block;font-size:13px;font-weight:1000;line-height:1.15;color:#101828}.r-note-mention-email{display:block;margin-top:3px;font-size:11px;font-weight:700;color:#667085}.r-note-card-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:9px;font-weight:850;color:#667085}.r-note-card-meta span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.r-note-card-actions{display:flex;gap:2px}.r-note-card-actions button{border:0;background:transparent;color:#98a2b3;width:22px;height:22px;padding:0;cursor:pointer}.r-note-card-actions button:hover{color:#344054}.r-note-empty{flex:1 1 auto;width:100%;min-height:180px;box-sizing:border-box;border:1px dashed rgba(15,23,42,.1);border-radius:9px;background:#fafbfc;padding:24px 14px;display:grid;place-items:center;text-align:center;color:#98a2b3;font-size:12px;font-weight:900}
    .r-left.notes-panel-ready{position:relative;padding-bottom:5px}.r-overlay.proposal-workspace .r-bottom-notes{gap:6px}.r-left.notes-history-expanded .r-left-bottom,.r-left:has(.r-bottom-notes.expanded) .r-left-bottom{position:absolute;z-index:45;left:0;right:0;bottom:0;box-sizing:border-box;height:80%;min-height:0;margin:0;padding:12px 18px 5px;border-top-color:transparent;background:transparent;box-shadow:none}.r-left.notes-history-expanded .r-left-bottom::before,.r-left:has(.r-bottom-notes.expanded) .r-left-bottom::before{display:none}.r-left.notes-history-expanded .r-left-bottom>:not(.r-bottom-notes),.r-left:has(.r-bottom-notes.expanded) .r-left-bottom>:not(.r-bottom-notes){display:none!important}.r-bottom-notes.expanded{height:100%;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:6px}
    .r-note-card{scroll-margin:14px;transition:border-color .22s ease,box-shadow .22s ease,background .22s ease}.r-note-card.notification-target{border-color:rgba(var(--primary-rgb,217,48,37),.55);background:rgba(var(--primary-rgb,217,48,37),.07);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-overlay.proposal-workspace.proposal-edit-mode .r-proposal-agent{border-bottom:1px solid rgba(15,23,42,.1);border-radius:0;background:transparent;padding:0 0 14px;box-shadow:none}
    .r-overlay.proposal-workspace.proposal-edit-mode .r-bottom-notes:not(.expanded){display:flex;flex-direction:column}
    .r-overlay.proposal-workspace.proposal-edit-mode .r-bottom-notes-head label{display:flex;align-items:center;gap:7px;min-width:0;font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
    .r-overlay.proposal-workspace.proposal-edit-mode .r-bottom-notes-head .customer-report-tip{letter-spacing:0;text-transform:none}
    .r-proposal-agent{display:none;border-bottom:1px solid rgba(15,23,42,.08);padding-bottom:10px;gap:8px}
    .r-overlay.proposal-workspace.proposal-edit-mode .r-proposal-agent{display:flex}
    .r-proposal-agent-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .r-proposal-agent-title{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
    .r-proposal-agent-title i{color:var(--primary-readable,var(--primary,#d93025));font-size:12px}
    .r-proposal-agent-toggle{border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;border-radius:10px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease;flex-shrink:0}
    .r-proposal-agent-toggle:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.22)}
    .r-proposal-agent-toggle i{transition:transform .18s ease}
    .r-proposal-agent.collapsed .r-proposal-agent-body{display:none}
    .r-proposal-agent.collapsed .r-proposal-agent-toggle i{transform:rotate(180deg)}
    .r-proposal-agent-body{display:flex;flex-direction:column;gap:8px}
    .r-proposal-agent-textwrap{position:relative}
    .r-proposal-agent textarea{width:100%;min-height:132px;padding-right:46px;resize:vertical;font-family:inherit;font-size:13px;line-height:1.45}
    .r-proposal-agent-dictate{position:absolute;right:8px;top:8px;width:34px;height:34px;border-radius:12px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease}
    .r-proposal-agent-dictate:hover,.r-proposal-agent-dictate.active{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.05)}
    .r-proposal-agent-submit{width:100%;border:0;border-radius:14px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:11px 13px;font-size:12px;font-weight:1000;cursor:pointer;box-shadow:0 12px 24px rgba(var(--primary-rgb,217,48,37),.18);transition:.16s ease}
    .r-proposal-agent-submit:hover{transform:translateY(-1px);box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.22)}
    .r-proposal-agent-submit:disabled{cursor:not-allowed;transform:none;box-shadow:none;background:#e5e7eb;color:#667085}
    .r-proposal-agent-progress{display:none;height:8px;border-radius:999px;background:#eef2f6;overflow:hidden}
    .r-proposal-agent-progress.visible{display:block}
    .r-proposal-agent-progress span{display:block;height:100%;width:var(--progress,0%);background:var(--primary,#d93025);transition:width .24s ease}
    .r-proposal-agent-note{font-size:11px;font-weight:800;line-height:1.35;color:#667085}
    .r-inline-notes-mount{display:none}
    .r-inline-notes-mount.has-notes{display:block}
    .r-inline-notes-mount .r-bottom-notes{padding:0 0 14px}
    .r-save-toast{position:absolute;right:18px;bottom:18px;z-index:80;padding:9px 12px;border-radius:12px;background:rgba(17,24,39,.88);color:#fff;font-size:11px;font-weight:1000;letter-spacing:.02em;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}
    .r-save-toast.visible{opacity:1;transform:translateY(0)}
    .r-cp-panel{height:100%;overflow:auto;background:#f4f5f7;padding:20px}
    .r-cp-wrap{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
    .r-cp-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .r-cp-head h3{margin:0;font-size:24px;letter-spacing:0}
    .r-cp-head p{margin:5px 0 0;color:#6b7280;font-size:13px}
    .r-cp-pill{border:1px solid rgba(17,24,39,.12);background:#fff;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:900;color:#374151}
    .r-cp-error{background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;border-radius:8px;padding:10px 12px;font-size:13px;font-weight:800}
    .r-cp-subtabs{display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(17,24,39,.10);padding-bottom:8px}
    .r-cp-subtabs button{border:1px solid rgba(17,24,39,.12);background:#fff;color:#374151;border-radius:7px;padding:8px 11px;font-size:12px;font-weight:950;display:inline-flex;align-items:center;gap:8px;cursor:pointer}
    .r-cp-subtabs button.active{background:#111827;color:#fff;border-color:#111827}
    .r-cp-subtabs button:disabled{opacity:.45;cursor:not-allowed}
    .r-cp-tab-panel{display:flex;flex-direction:column;gap:14px}
    .r-cp-links{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .r-cp-link-card,.r-cp-media-box,.r-cp-empty,.r-cp-event,.r-cp-stat,.r-cp-visitor-card{background:#fff;border:1px solid rgba(17,24,39,.10);border-radius:8px}
    .r-cp-link-card{padding:12px;display:flex;flex-direction:column;gap:8px}
    .r-cp-link-card span{font-size:12px;color:#6b7280;font-weight:900;text-transform:uppercase;letter-spacing:.04em}
    .r-cp-link-card input{width:100%;border:1px solid rgba(17,24,39,.12);border-radius:7px;padding:9px 10px;font-size:12px;color:#374151;background:#f9fafb}
    .r-cp-actions{display:flex;gap:8px;flex-wrap:wrap}
    .r-cp-actions button,.r-cp-actions a,.r-cp-section-title button,.r-cp-bulk-btn{border:1px solid rgba(17,24,39,.16);background:#fff;color:#111827;border-radius:7px;padding:8px 10px;font-size:12px;font-weight:900;text-decoration:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px}
    .r-cp-actions button:first-child,.r-cp-actions a:last-child,.r-cp-bulk-btn.primary{background:#111827;color:#fff;border-color:#111827}
    .r-cp-actions button:disabled,.r-cp-bulk-btn:disabled{opacity:.45;cursor:not-allowed}
    .r-cp-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
    .r-cp-section-title strong{font-size:15px}
    .r-cp-section-title span{color:#6b7280;font-size:12px;font-weight:800}
    .r-cp-sharing-admin{display:grid;gap:10px;padding:13px;background:#fff;border:1px solid rgba(17,24,39,.10);border-radius:8px}
    .r-cp-sharing-admin>p{margin:0;color:#6b7280;font-size:12px;line-height:1.55}
    .r-cp-share-list{display:grid;gap:8px}
    .r-cp-share-list>div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid rgba(17,24,39,.09);border-radius:7px;background:#f8fafc}
    .r-cp-share-list span{display:grid;gap:2px;min-width:0}.r-cp-share-list strong{font-size:12px;color:#111827}.r-cp-share-list small{font-size:10px;color:#6b7280;text-transform:capitalize}
    .r-cp-share-list button{border:1px solid #fecaca;border-radius:6px;background:#fff;color:#b91c1c;padding:6px 9px;font-size:11px;font-weight:900;cursor:pointer}
    .r-cp-media-board{display:grid;grid-template-columns:1fr;gap:14px;align-items:start}
    .r-cp-media-box{min-height:360px;padding:12px;display:flex;flex-direction:column;gap:12px}
    .r-cp-media-box-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
    .r-cp-media-box-title{min-width:0}
    .r-cp-media-box-title strong{display:block;font-size:15px;color:#111827}
    .r-cp-media-box-title span{display:block;margin-top:2px;color:#6b7280;font-size:12px;font-weight:800}
    .r-cp-media-box-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;justify-content:flex-end}
    .r-cp-media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:10px;align-content:start}
    .r-cp-media-tile{position:relative;min-width:0;border:1px solid rgba(17,24,39,.10);background:#f8fafc;border-radius:8px;padding:0;overflow:hidden;cursor:pointer;text-align:left;box-shadow:0 10px 20px rgba(15,23,42,.045);transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
    .r-cp-media-tile:hover{border-color:rgba(17,24,39,.26);box-shadow:0 14px 26px rgba(15,23,42,.08);transform:translateY(-1px)}
    .r-cp-media-tile.selected{border-color:#111827;box-shadow:0 0 0 2px rgba(17,24,39,.16),0 14px 26px rgba(15,23,42,.10)}
    .r-cp-media-tile:disabled{cursor:not-allowed;opacity:.72;transform:none;box-shadow:none}
    .r-cp-thumb{position:relative;width:100%;aspect-ratio:4/3;overflow:hidden;background:#e5e7eb}
    .r-cp-thumb::before{content:'';position:absolute;inset:0;z-index:1;background:linear-gradient(110deg,#e5e7eb 8%,#f8fafc 18%,#e5e7eb 33%);background-size:200% 100%;animation:rCpThumbLoad 1.15s linear infinite}
    .r-cp-thumb.loaded::before,.r-cp-thumb.failed::before{display:none}
    .r-cp-thumb img,.r-cp-thumb video{width:100%;height:100%;object-fit:cover;display:block}
    .r-cp-thumb.failed img,.r-cp-thumb.failed video{display:none}
    .r-cp-fallback{position:absolute;inset:0;z-index:2;display:none;flex-direction:column;align-items:center;justify-content:center;gap:7px;text-align:center;background:linear-gradient(135deg,#eef2f6,#f8fafc);color:#6b7280;padding:10px}
    .r-cp-thumb.failed .r-cp-fallback{display:flex}
    .r-cp-fallback i{font-size:22px;color:#9ca3af}
    .r-cp-fallback span{font-size:11px;font-weight:900;line-height:1.2}
    .r-cp-check{position:absolute;z-index:3;top:8px;left:8px;width:24px;height:24px;border-radius:999px;border:1px solid rgba(255,255,255,.72);background:rgba(17,24,39,.58);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 8px 18px rgba(15,23,42,.25)}
    .r-cp-media-tile:not(.selected) .r-cp-check i{opacity:0}
    .r-cp-media-name{display:block;padding:9px 10px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#111827;font-size:12px;font-weight:900}
    @keyframes rCpThumbLoad{to{background-position:-200% 0}}
    .r-cp-empty{padding:18px;text-align:center;color:#6b7280;font-size:13px}
    .r-cp-events{display:flex;flex-direction:column;gap:8px}
    .r-cp-activity-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
    .r-cp-stat{padding:10px 11px;min-width:0}
    .r-cp-stat span{display:block;color:#6b7280;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-cp-stat strong{display:block;margin-top:4px;color:#111827;font-size:16px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-cp-activity-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .r-cp-visitor-card{padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}
    .r-cp-visitor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
    .r-cp-visitor-head strong{display:block;color:#111827;font-size:14px;font-weight:1000;overflow:hidden;text-overflow:ellipsis}
    .r-cp-visitor-head span,.r-cp-visitor-head time,.r-cp-visitor-window{color:#6b7280;font-size:11px;font-weight:850;line-height:1.35}
    .r-cp-visitor-head time{white-space:nowrap}
    .r-cp-visitor-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
    .r-cp-visitor-counts span{background:#f8fafc;border:1px solid rgba(17,24,39,.08);border-radius:7px;padding:7px 6px;color:#6b7280;font-size:10px;font-weight:950;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-cp-visitor-counts b{display:block;color:#111827;font-size:14px;line-height:1.1}
    .r-cp-recent-events{display:flex;flex-direction:column;gap:5px}
    .r-cp-recent-event{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid rgba(17,24,39,.07);padding-top:6px;font-size:11px;color:#374151}
    .r-cp-recent-event span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:850;text-transform:capitalize}
    .r-cp-recent-event em{font-style:normal;color:#6b7280;text-transform:none}
    .r-cp-recent-event time{flex:0 0 auto;color:#6b7280;font-weight:800}
    @media(max-width:980px){.r-cp-media-box{min-height:280px}}
    @media(max-width:980px){.r-cp-activity-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.r-cp-activity-grid{grid-template-columns:1fr}}
    @media(max-width:820px){.r-cp-links{grid-template-columns:1fr}.r-cp-panel{padding:14px}.r-cp-media-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.r-cp-media-box-head{flex-direction:column}.r-cp-media-box-actions{justify-content:flex-start}.r-cp-activity-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.r-cp-visitor-counts{grid-template-columns:repeat(2,minmax(0,1fr))}}
    .r-modal-header{min-height:48px;display:flex;align-items:stretch;border-bottom:1px solid rgba(15,23,42,.10);background:#fff;flex:0 0 auto}
    .r-mobile-project-title,.r-mobile-left-tray-toggle,.r-mobile-left-tray-scrim,.r-mobile-default-info-tray-scrim,.r-mobile-project-notes-launcher,.r-mobile-project-notes-scrim,.r-mobile-project-notes-workspace{display:none}
    .r-tabbar{display:flex;align-items:stretch;gap:0;padding:0;min-width:0;flex:1 1 auto;overflow-x:auto;scrollbar-width:none}
    .r-tabbar::-webkit-scrollbar{display:none}
    .r-tabbar.single-tab{display:none}
    .r-tab{min-width:0;min-height:47px;border:0;border-right:1px solid rgba(15,23,42,.10);border-radius:0;background:#fff;padding:10px 14px;font-size:11px;font-weight:1000;color:#475467;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;line-height:1;white-space:nowrap;transition:background .16s ease,color .16s ease,box-shadow .16s ease}
    .r-tab:hover{background:#f8fafc;color:#101828}
    .r-tab.active{background:#fff;color:var(--primary-readable,var(--primary,#d93025));box-shadow:inset 0 -3px 0 var(--primary,#d93025)}
    .r-tab.pending{border-style:dashed;color:#8a5a00;background:#fff8e1}
    .r-tab.pending i{animation:fa-spin 1.3s linear infinite}
    .r-overlay.report-ordered #rStepRoof{display:none}
    .r-overlay.report-ordered .r-addon-toggle,
    .r-overlay.report-ordered .r-pin-clear,
    .r-overlay.report-ordered #rConfirm{pointer-events:none}
    .r-overlay.report-ordered .r-after-hours,
    .r-overlay.report-ordered .r-projection-card{display:none!important}
    .r-projection-card{display:none;padding:12px;border-radius:16px;background:#f8fafc;border:1px solid rgba(15,23,42,.08);font-size:12px;font-weight:850;color:#475467;line-height:1.45}
    .r-projection-card strong{display:block;color:#101828;font-size:13px;margin-bottom:4px}
    .r-viewer-summary{display:none;flex-direction:column;gap:10px;padding:2px 0 0}
    .r-viewer-summary.visible{display:flex;margin-top:-2px;margin-bottom:11px}
    .r-viewer-address{font-size:15px;font-weight:1000;line-height:1.35;color:#101828}
    .r-viewer-type-tag{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;padding:5px 8px;border-radius:999px;background:#f2f4f7;border:1px solid rgba(15,23,42,.08);font-size:10.5px;font-weight:1000;color:#344054}
    .r-viewer-appt{display:flex;align-items:center;gap:8px;align-self:flex-start;max-width:100%;padding:8px 10px;border-radius:13px;background:rgba(var(--primary-rgb,217,48,37),.07);border:1px solid rgba(var(--primary-rgb,217,48,37),.16);color:#344054;font-size:11px;font-weight:950;line-height:1.35}
    .r-viewer-appt i{color:var(--primary-readable,var(--primary,#d93025));flex-shrink:0}
    .r-viewer-appt span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-step.is-condensed #rStepTypeLabel{display:none}
    .r-overlay.report-ordered #rStepCustomer .r-label-optional{display:none}
    .r-overlay.report-ordered #rStepCustomer .r-step-body{gap:14px}
    .r-overlay.report-ordered #rStepCustomer .r-contact-card{background:#fff}
    .r-overlay.report-ordered #rAddContact{padding:7px 10px;border-radius:10px;background:transparent;font-size:11px;color:#667085}
    .r-measure-tabs{position:absolute;top:0;left:0;right:0;height:46px;padding:8px 16px;display:none;align-items:center;gap:8px;overflow-x:auto;scrollbar-width:none;background:rgba(248,250,252,.96);border-bottom:1px solid rgba(15,23,42,.08);z-index:18}
    .r-preview-panel.active .r-measure-tabs{display:flex}
    .r-measure-meta{margin-left:auto;font-size:11px;font-weight:900;color:#667085;white-space:nowrap}
    .r-measure-tabs::-webkit-scrollbar{display:none}
    .r-overlay.report-tabs-in-header .r-modal-header .r-measure-tabs{position:static;display:flex;flex:1 1 auto;min-width:0;height:auto;box-sizing:border-box;border-bottom:0}
    .r-overlay.report-tabs-in-header .r-measure-body{inset:0}
    .r-overlay.report-tabs-in-header:not(:has(.r-preview-panel[data-panel="measurements"].active)) .r-modal-header .r-measure-tabs{display:none}

    .r-measure-tab{appearance:none;border:1px solid transparent;display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;background:transparent;color:#526071;font-size:11px;font-weight:950;white-space:nowrap;cursor:pointer;transition:.18s ease}
    .r-measure-tab:hover:not(:disabled):not(.active){background:#fff;border-color:rgba(15,23,42,.08);color:#344054}
    .r-measure-tab.active{background:#fff;border-color:rgba(15,23,42,.10);color:#1f2937;box-shadow:0 8px 18px rgba(15,23,42,.08)}
    .r-measure-tab.pending{color:#7b8794}
    .r-measure-tab:disabled{cursor:default}
    .r-measure-body{position:absolute;inset:46px 0 0;background:#eef2f6}
    .r-measure-pane{position:absolute;inset:0;display:none}
    .r-measure-pane.active{display:block}
    .r-report-pending{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:30px;color:#475467}
    .r-report-pending-card{width:min(430px,90%);border-radius:22px;background:#fff;border:1px solid rgba(15,23,42,.08);box-shadow:0 18px 42px rgba(15,23,42,.12);padding:26px;display:flex;flex-direction:column;gap:10px}
    .r-report-pending-card i{font-size:28px;color:var(--primary,#d93025)}
    .r-report-pending-card h3{margin:0;font-size:18px;color:#101828}
    .r-report-pending-card p{margin:0;font-size:13px;line-height:1.55;color:#667085}
    .r-report-pending-card.is-expedited{justify-content:center;gap:14px;border-color:rgba(251,188,4,.38);box-shadow:0 18px 42px rgba(251,188,4,.18)}
    .r-report-pending-card.is-cancelled{border-color:rgba(95,99,104,.22);box-shadow:0 18px 42px rgba(95,99,104,.12)}
    .r-report-pending-card.is-cancelled i{color:#5f6368}
    .r-pending-title{display:inline-flex;align-items:center;justify-content:center;gap:8px}
    .r-pending-title.is-expedited{color:#7a5b00}
    .r-pending-title.is-expedited i{font-size:17px;color:#b77900}
    .r-pending-badge{display:inline-flex;align-items:center;justify-content:center;gap:6px;align-self:center;padding:5px 9px;border-radius:999px;background:#fff7d6;border:1px solid rgba(251,188,4,.42);color:#7a5b00;font-size:10px;font-weight:1000;text-transform:uppercase}
    .r-pending-badge i{font-size:10px;color:#b77900}
    .r-pending-detail{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:14px;background:#f8fafc;border:1px solid rgba(15,23,42,.07);font-size:12px;font-weight:900;color:#344054}
    .r-pending-detail strong{font-size:11px;color:#667085;text-transform:uppercase;letter-spacing:.04em}
    .r-report-refund-note{display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;padding:12px 14px;border-radius:14px;background:#fff8e1;border:1px solid rgba(245,158,11,.28);color:#7a4a00;text-align:left;font-size:12px;line-height:1.45}
    .r-report-refund-note>i{font-size:17px;color:#f59e0b;margin-top:1px;flex:0 0 auto}
    .r-report-refund-note strong{display:block;color:#3f2a00;font-size:12px;margin-bottom:2px}
    .r-report-refund-note span{display:block;color:#7a4a00;font-weight:750}
    .r-pending-actions{display:flex;flex-direction:column;gap:8px;margin-top:4px}
    .r-pending-action-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .r-pending-action{appearance:none;position:relative;border:1px solid rgba(var(--primary-rgb,217,48,37),.16);border-radius:13px;background:#fff5f3;background:color-mix(in srgb,var(--primary,#d93025) 18%,#fff);color:var(--primary-readable,var(--primary,#d93025));padding:10px 11px;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;align-items:center;column-gap:9px;row-gap:3px;text-align:left;cursor:pointer;font-size:11px;font-weight:1000;line-height:1.15;box-shadow:none}
    .r-pending-action:not(.selected):hover{background:#ffebe7;background:color-mix(in srgb,var(--primary,#d93025) 25%,#fff);border-color:rgba(var(--primary-rgb,217,48,37),.24)}
    .r-pending-action.selected{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:inset 0 0 0 2px rgba(255,255,255,.24),0 0 0 3px rgba(var(--primary-rgb,217,48,37),.18),0 12px 24px rgba(var(--primary-rgb,217,48,37),.18);transform:translateY(-1px)}
    .r-pending-action-copy{grid-column:1;grid-row:1 / span 2;display:flex;flex-direction:column;gap:3px;min-width:0}
    .r-pending-action-copy strong{font-size:12px;font-weight:1000;line-height:1.12;color:inherit}
    .r-pending-action-copy span{font-size:10px;font-weight:900;opacity:.9;line-height:1.2}
    .r-pending-action-price{grid-column:2;grid-row:1 / span 2;align-self:center;font-size:22px;font-weight:1000;letter-spacing:0;line-height:.95;color:inherit;white-space:nowrap}
    .r-pending-action-price.is-loading{min-width:50px;height:24px;border-radius:999px;background:rgba(255,255,255,.62);display:inline-flex;align-items:center;justify-content:center;font-size:12px}
    .r-pending-action-price.is-loading::before{content:'';width:13px;height:13px;border-radius:999px;border:2px solid currentColor;border-right-color:transparent;animation:fa-spin .75s linear infinite;opacity:.82}
    .r-pending-action:disabled{opacity:.48;cursor:not-allowed;filter:grayscale(.2)}
    .r-pending-expedite-confirm{appearance:none;border:1px solid rgba(var(--primary-rgb,217,48,37),.25);border-radius:13px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:11px 12px;font-size:12px;font-weight:1000;cursor:pointer;box-shadow:0 14px 26px rgba(var(--primary-rgb,217,48,37),.16)}
    .r-pending-expedite-confirm:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
    .r-pending-cancel{appearance:none;border:1px solid rgba(15,23,42,.14);border-radius:13px;background:#fff;color:#344054;padding:10px 12px;font-size:12px;font-weight:1000;cursor:pointer}
    .r-pending-cancel:disabled{opacity:.5;cursor:not-allowed}
    .r-pending-reorder{appearance:none;border:1px solid var(--primary,#d93025);border-radius:13px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:10px 12px;font-size:12px;font-weight:1000;cursor:pointer}
    .r-pending-note{font-size:11px;font-weight:850;line-height:1.4;color:#667085}
    .r-schedule-panel{height:100%;min-height:0;overflow:hidden;background:#f8fafc;padding:24px;box-sizing:border-box;display:flex;flex-direction:column}
    .r-schedule-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
    .r-schedule-title{margin:0;font-size:22px;font-weight:1000;color:#101828}
    .r-schedule-sub{margin:4px 0 0;font-size:12px;font-weight:800;color:#667085}
    .r-schedule-head-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .r-schedule-list{display:grid;gap:10px}
    .r-schedule-event{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#fff;padding:14px;box-shadow:0 12px 28px rgba(15,23,42,.06)}
    .r-schedule-dot{width:38px;height:38px;border-radius:14px;background:#e0ecff;color:#1d4ed8;display:flex;align-items:center;justify-content:center}
    .r-schedule-event-title{font-size:14px;font-weight:1000;color:#101828}
    .r-schedule-event-meta{margin-top:3px;font-size:12px;font-weight:800;color:#667085;line-height:1.45}
    .r-schedule-empty{border:1px dashed rgba(15,23,42,.18);border-radius:18px;background:#fff;padding:22px;text-align:center;color:#667085;font-weight:850}
    .r-schedule-empty i{display:block;font-size:24px;color:#98a2b3;margin-bottom:8px}
    .r-schedule-action{border:0;border-radius:14px;background:var(--primary,#d93025);color:var(--on-primary,#fff);height:42px;padding:0 16px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.18)}
    .r-schedule-action.secondary{background:#fff;color:#344054;border:1px solid rgba(15,23,42,.12);box-shadow:none}
    .r-schedule-calendar{display:flex;flex-direction:column;gap:14px;min-height:0;flex:1}
    .r-schedule-footer{display:none}
    .r-schedule-confirm{border:0;border-radius:13px;background:var(--primary,#d93025);color:var(--on-primary,#fff);height:40px;padding:0 18px;font-size:12px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;box-shadow:0 12px 24px rgba(var(--primary-rgb,217,48,37),.18)}
    .r-schedule-confirm:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
    .r-schedule-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .r-schedule-nav{display:flex;align-items:center;gap:8px}
    .r-schedule-nav button{width:36px;height:36px;border-radius:12px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#344054;cursor:pointer;font-weight:1000}
    .r-schedule-range{font-size:14px;font-weight:1000;color:#101828}
    .r-schedule-toolbar-right{display:flex;align-items:center;gap:10px}
    .r-schedule-view-switch{display:inline-flex;align-items:center;gap:4px;padding:3px;border-radius:13px;background:#fff;border:1px solid rgba(15,23,42,.10)}
    .r-schedule-view-btn{height:28px;border:0;border-radius:10px;background:transparent;color:#667085;padding:0 9px;font-size:11px;font-weight:1000;cursor:pointer}
    .r-schedule-view-btn.active{background:rgba(var(--primary-rgb,217,48,37),.10);color:var(--primary-readable,var(--primary,#d93025))}
    .r-schedule-mode-pill{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(var(--primary-rgb,217,48,37),.2);background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary-readable,var(--primary,#d93025));border-radius:999px;padding:8px 11px;font-size:11px;font-weight:1000}
    .r-travel-toggle{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(15,23,42,.10);background:#fff;border-radius:999px;height:34px;padding:0 10px;font-size:11px;font-weight:1000;color:#344054;cursor:pointer}
    .r-travel-toggle .dot{width:22px;height:12px;border-radius:999px;background:#cbd5e1;position:relative;transition:.16s ease}
    .r-travel-toggle .dot:after{content:"";position:absolute;width:8px;height:8px;border-radius:999px;left:2px;top:2px;background:#fff;transition:.16s ease}
    .r-travel-toggle.active .dot{background:var(--primary,#d93025)}
    .r-travel-toggle.active .dot:after{left:12px}
    .r-cal-scroll{flex:1;overflow:auto;border:1px solid rgba(15,23,42,.06);border-radius:18px;background:#fff;box-shadow:0 14px 34px rgba(15,23,42,.05)}
    .r-cal-week{display:grid;grid-template-columns:70px repeat(7,minmax(118px,1fr));min-width:940px;min-height:100%;align-content:start}
    .r-cal-day{position:relative;min-height:44px;border-left:1px solid rgba(15,23,42,.055);border-bottom:1px solid rgba(15,23,42,.055);padding:10px;font-size:11px;font-weight:1000;color:#344054;background:#f8fafc}
    .r-cal-time{min-height:44px;border-bottom:1px solid rgba(15,23,42,.045);padding:8px 10px;font-size:11px;font-weight:900;color:#667085;background:#f8fafc;position:sticky;left:0;z-index:2}
    .r-cal-slot{position:relative;min-height:44px;border-left:1px solid rgba(15,23,42,.045);border-bottom:1px solid rgba(15,23,42,.045);background:#fff;cursor:pointer;transition:.14s ease;overflow:visible}
    .r-cal-slot:hover{background:rgba(var(--primary-rgb,217,48,37),.06)}
    .r-cal-slot.unavailable{background:#f6f7f9;cursor:not-allowed}
    .r-cal-slot.unavailable:hover{background:#f6f7f9}
    .r-cal-slot:not(.unavailable):hover:after,.r-cal-day-slot:not(.unavailable):hover:after{content:"";position:absolute;left:5px;top:5px;width:calc((var(--span,1) * 100%) - 10px);height:calc((var(--span,1) * 100%) - 10px);border-radius:11px;background:rgba(var(--primary-rgb,217,48,37),.13);border:1px dashed rgba(var(--primary-rgb,217,48,37),.42);z-index:2;pointer-events:none}
    .r-cal-day-slot:not(.unavailable):hover:after{height:calc(100% - 10px);width:calc((var(--span,1) * 100%) - 10px)}
    .r-cal-appointment{position:absolute;left:5px;top:5px;width:calc((var(--span,1) * 100%) - 10px);height:calc((var(--span,1) * 100%) - 10px);border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.30);border:1px solid rgba(var(--primary-rgb,217,48,37),.42);color:#101828;padding:7px 8px;font-size:10px;font-weight:950;line-height:1.25;overflow:hidden;z-index:4;box-sizing:border-box;box-shadow:0 10px 20px rgba(15,23,42,.14)}
    .r-cal-day-slot .r-cal-appointment{height:calc(100% - 10px);width:calc((var(--span,1) * 100%) - 10px)}
    .r-cal-appointment.draft{border-style:dashed;background:rgba(var(--primary-rgb,217,48,37),.10);border-color:rgba(var(--primary-rgb,217,48,37),.54);box-shadow:none;opacity:.78}
    .r-cal-appointment.has-confirm{padding-right:38px}
    .r-cal-draft-confirm{position:absolute;right:7px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:0;border-radius:9px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 18px rgba(var(--primary-rgb,217,48,37),.22);z-index:7}
    .r-cal-appointment.foreign{background:rgba(100,116,139,.12);border-color:rgba(100,116,139,.18);color:#475467;box-shadow:none}
    .r-cal-appt-top{display:flex;justify-content:space-between;gap:8px;font-weight:1000}
    .r-cal-appt-address{margin-top:3px;color:#475467;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-cal-travel{position:absolute;inset:5px;border-radius:10px;background:rgba(100,116,139,.10);border:1px dashed rgba(100,116,139,.18);display:flex;align-items:center;justify-content:center;color:#64748b;font-size:10px;font-weight:1000;z-index:1;pointer-events:none}
    .r-cal-daily{display:grid;grid-template-columns:150px repeat(var(--slot-count,16),minmax(78px,1fr));min-width:980px;min-height:100%;align-content:start}
    .r-cal-person{position:sticky;left:0;z-index:3;min-height:56px;border-bottom:1px solid rgba(15,23,42,.055);background:#f8fafc;padding:12px;font-size:12px;font-weight:1000;color:#101828}
    .r-cal-person.unassigned,.r-cal-day-slot.unassigned{border-bottom:8px solid #eef2f6}
    .r-cal-person small{display:block;margin-top:3px;color:#667085;font-size:10px;font-weight:900}
    .r-cal-hour{min-height:38px;border-left:1px solid rgba(15,23,42,.055);border-bottom:1px solid rgba(15,23,42,.055);background:#f8fafc;padding:10px 8px;font-size:11px;font-weight:1000;color:#344054;text-align:center}
    .r-cal-day-slot{position:relative;min-height:56px;border-left:1px solid rgba(15,23,42,.045);border-bottom:1px solid rgba(15,23,42,.045);background:#fff;cursor:pointer;overflow:visible}
    .r-cal-day-slot:hover{background:rgba(var(--primary-rgb,217,48,37),.06)}
    .r-cal-day-slot.unavailable{background:#f6f7f9;cursor:not-allowed}
    .r-project-cal{height:100%;min-height:0;display:flex;flex-direction:column;gap:12px}
    .r-project-cal-scroll{flex:1;min-height:0;overflow:auto;border:1px solid rgba(15,23,42,.06);border-radius:18px;background:#fff;box-shadow:0 14px 34px rgba(15,23,42,.05)}
    .r-project-week{display:grid;grid-template-columns:72px repeat(7,minmax(120px,1fr));min-width:980px;align-content:start}
    .r-project-day{display:grid;grid-template-columns:72px minmax(420px,1fr);min-width:620px;align-content:start}
    .r-project-hour-head,.r-project-day-head{min-height:44px;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.06);border-left:1px solid rgba(15,23,42,.05);padding:10px;font-size:11px;font-weight:1000;color:#344054}
    .r-project-hour-head{position:sticky;left:0;z-index:3;border-left:0}
    .r-project-time{position:sticky;left:0;z-index:2;min-height:52px;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.045);padding:9px 10px;font-size:11px;font-weight:900;color:#667085}
    .r-project-slot{position:relative;min-height:52px;background:#fff;border-left:1px solid rgba(15,23,42,.045);border-bottom:1px solid rgba(15,23,42,.045);overflow:visible}
    .r-project-event{position:absolute;left:6px;top:6px;width:calc((var(--span,1) * 100%) - 12px);height:calc((var(--rowspan,1) * 52px) - 12px);min-height:36px;border-radius:12px;background:rgba(var(--primary-rgb,217,48,37),.18);border:1px solid rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 10px 22px rgba(15,23,42,.10);padding:7px 9px;box-sizing:border-box;overflow:hidden;color:#101828;z-index:6}
    .r-project-event-title{font-size:11px;font-weight:1000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-project-event-meta{margin-top:3px;font-size:10px;font-weight:850;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-project-month{display:grid;grid-template-columns:repeat(7,minmax(116px,1fr));min-width:860px;min-height:100%;align-content:start}
    .r-project-month-head{background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.06);border-left:1px solid rgba(15,23,42,.05);padding:10px;font-size:11px;font-weight:1000;color:#344054}
    .r-project-month-day{min-height:112px;border-left:1px solid rgba(15,23,42,.045);border-bottom:1px solid rgba(15,23,42,.045);padding:8px;background:#fff;box-sizing:border-box}
    .r-project-month-day.muted{background:#f8fafc;color:#98a2b3}
    .r-project-month-num{font-size:11px;font-weight:1000;color:#344054;margin-bottom:7px}
    .r-project-month-chip{display:block;width:100%;border:0;border-radius:9px;background:rgba(var(--primary-rgb,217,48,37),.12);color:#101828;padding:6px 7px;margin-bottom:5px;text-align:left;font-size:10px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-schedule-loading{height:100%;display:flex;align-items:center;justify-content:center;color:#667085;font-weight:900}
    .r-schedule-dialog{position:fixed;inset:0;z-index:2147483110;background:rgba(15,23,42,.42);display:none;align-items:center;justify-content:center;padding:20px}
    .r-schedule-dialog.active{display:flex}
    .r-schedule-card{width:min(660px,96vw);max-height:86vh;overflow:auto;background:#fff;border-radius:24px;box-shadow:0 30px 90px rgba(15,23,42,.28);padding:22px}
    .r-schedule-card h3{margin:0 0 6px;font-size:20px;color:#101828}
    .r-schedule-card p{margin:0 0 18px;font-size:13px;font-weight:800;color:#667085;line-height:1.5}
    .r-schedule-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .r-schedule-field{display:flex;flex-direction:column;gap:6px}
    .r-schedule-field label{font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
    .r-schedule-field input,.r-schedule-field select{height:44px;border:1px solid rgba(15,23,42,.14);border-radius:14px;padding:0 12px;font-weight:850;color:#101828;background:#fff}
    .r-schedule-slots{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
    .r-schedule-slot{border:1px solid rgba(15,23,42,.12);border-radius:999px;background:#fff;padding:7px 11px;font-size:12px;font-weight:900;color:#344054;cursor:pointer}
    .r-schedule-slot.available{border-color:rgba(37,99,235,.24);color:#1d4ed8;background:#eff6ff}
    .r-schedule-slot.unavailable{opacity:.42;cursor:default;text-decoration:line-through}
    .r-schedule-slot.active{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
    .r-schedule-status{min-height:20px;font-size:12px;font-weight:900;color:#667085;margin:6px 0 0}
    .r-schedule-status.bad{color:#b42318}
    .r-schedule-override{display:none;margin-top:8px;align-items:center;gap:8px;font-size:12px;font-weight:900;color:#667085}
    .r-schedule-override.visible{display:flex}
    .r-schedule-override input{width:16px;height:16px;accent-color:var(--primary,#d93025)}
    .r-schedule-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}
    .r-report-frame{height:100%;display:flex;flex-direction:column;background:#eef2f6}
    .r-report-iframe{flex:1;min-height:0;width:100%;border:0;background:#fff}
    .r-report-debug-disabled{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;background:#f8fafc;box-sizing:border-box}
    .r-report-debug-card{width:min(430px,100%);border:1px dashed rgba(15,23,42,.18);border-radius:18px;background:#fff;padding:24px;text-align:center;display:grid;justify-items:center;gap:12px;color:#667085;box-shadow:0 14px 34px rgba(15,23,42,.06)}
    .r-report-debug-card > i{font-size:30px;color:var(--primary-readable,var(--primary,#d93025))}
    .r-report-debug-card h3{margin:0;font-size:18px;color:#101828}
    .r-report-debug-card p{margin:0;font-size:12px;font-weight:800;line-height:1.5}
    .r-report-debug-card a{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:0 14px;border-radius:14px;background:var(--primary,#d93025);color:var(--on-primary,#fff);text-decoration:none;font-size:12px;font-weight:1000;box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.18)}
    .r-report-followup-open{position:absolute;right:18px;bottom:18px;z-index:28;border:0;border-radius:16px;background:var(--primary,#d93025);color:var(--on-primary,#fff);min-height:44px;padding:0 16px;display:none;align-items:center;gap:9px;font-size:12px;font-weight:1000;box-shadow:0 18px 36px rgba(var(--primary-rgb,217,48,37),.24);cursor:pointer}
    .r-report-followup-open.visible{display:inline-flex}
    .r-report-changes{height:100%;overflow:auto;background:#f8fafc;padding:22px 22px 92px;box-sizing:border-box}
    .r-report-changes-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}
    .r-report-changes-head h3{margin:0;font-size:20px;color:#101828}
    .r-report-changes-head p{margin:4px 0 0;font-size:12px;font-weight:800;color:#667085;line-height:1.45}
    .r-report-change-list{display:grid;gap:10px}
    .r-report-change-card{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:14px;box-shadow:0 12px 28px rgba(15,23,42,.06);display:grid;gap:10px}
    .r-report-change-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    .r-report-change-title{font-size:14px;font-weight:1000;color:#101828}
    .r-report-change-meta{font-size:11px;font-weight:900;color:#667085;margin-top:2px}
    .r-report-change-status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025));padding:6px 9px;font-size:10px;font-weight:1000;text-transform:uppercase;white-space:nowrap}
    .r-report-change-notes{white-space:pre-wrap;font-size:12px;line-height:1.5;color:#344054;background:#f8fafc;border:1px solid rgba(15,23,42,.06);border-radius:13px;padding:10px}
    .r-report-change-facts{display:flex;flex-wrap:wrap;gap:7px}
    .r-report-change-facts span{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(15,23,42,.08);background:#fff;border-radius:999px;padding:5px 8px;font-size:10px;font-weight:950;color:#475467}
    .r-report-support-empty{height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:26px;box-sizing:border-box}
    .r-report-support-empty-card{width:min(420px,100%);border:1px dashed rgba(15,23,42,.16);border-radius:18px;background:#fff;padding:22px;display:grid;gap:10px;justify-items:center;color:#667085}
    .r-report-support-empty-card > i{font-size:26px;color:var(--primary-readable,var(--primary,#d93025))}
    .r-report-support-empty-card h3{margin:0;font-size:18px;color:#101828}
    .r-report-support-empty-card p{margin:0;font-size:12px;font-weight:800;line-height:1.5}
    .r-report-support-request{border:0;border-radius:14px;background:var(--primary,#d93025);color:var(--on-primary,#fff);min-height:40px;padding:0 14px;font-size:12px;font-weight:1000;display:inline-flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.18)}
    .r-report-support-request i{font-size:12px;color:inherit}
    .r-report-changes-head .r-report-support-request{flex:0 0 auto}
    .r-report-followup-modal{position:fixed;inset:0;z-index:2147483140;background:rgba(15,23,42,.42);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px}
    .r-report-followup-card{width:min(680px,calc(100vw - 32px));max-height:88vh;overflow:auto;background:#fff;border-radius:24px;box-shadow:0 30px 90px rgba(15,23,42,.30);padding:22px}
    .r-report-followup-card.is-additional{width:min(1180px,calc(100vw - 36px))}
    .r-report-followup-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px}
    .r-report-followup-top h3{margin:0;font-size:21px;color:#101828}
    .r-report-followup-top p{margin:5px 0 0;font-size:12px;font-weight:800;line-height:1.45;color:#667085}
    .r-report-followup-close{width:38px;height:38px;border-radius:13px;border:1px solid rgba(15,23,42,.10);background:#fff;color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .r-report-followup-types{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-bottom:14px}
    .r-report-followup-type{border:1px solid rgba(15,23,42,.10);border-radius:16px;background:#fff;color:#344054;padding:12px;min-height:94px;text-align:left;display:flex;flex-direction:column;gap:7px;cursor:pointer}
    .r-report-followup-type i{color:var(--primary-readable,var(--primary,#d93025))}
    .r-report-followup-type strong{font-size:12px;font-weight:1000;color:#101828}
    .r-report-followup-type span{font-size:11px;font-weight:800;line-height:1.35;color:#667085}
    .r-report-followup-type.active{background:rgba(var(--primary-rgb,217,48,37),.08);border-color:rgba(var(--primary-rgb,217,48,37),.38);box-shadow:0 10px 22px rgba(var(--primary-rgb,217,48,37),.10)}
    .r-report-followup-form{display:grid;gap:12px}
    .r-report-followup-card.is-additional .r-report-followup-form{grid-template-columns:minmax(330px,.78fr) minmax(500px,1.22fr);align-items:start}
    .r-report-followup-field{display:flex;flex-direction:column;gap:6px}
    .r-report-followup-field label{font-size:11px;font-weight:1000;text-transform:uppercase;letter-spacing:.06em;color:#667085}
    .r-report-followup-field textarea,.r-report-followup-field input[type="number"]{border:1px solid rgba(15,23,42,.14);border-radius:14px;background:#fff;padding:11px 12px;font:inherit;font-size:13px;font-weight:800;color:#101828;resize:vertical}
    .r-report-followup-field input[type="file"]{border:1px dashed rgba(15,23,42,.18);border-radius:14px;background:#f8fafc;padding:12px;font-size:12px;font-weight:850;color:#475467}
    .r-report-followup-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .r-report-followup-count-display{border:1px solid rgba(15,23,42,.08);border-radius:14px;background:#f8fafc;min-height:43px;display:flex;align-items:center;padding:0 12px;font-size:18px;font-weight:1000;color:#101828}
    .r-report-followup-card.is-additional .r-report-followup-map-field{grid-column:2;grid-row:1 / span 7;position:sticky;top:0}
    .r-report-followup-map-wrap{border:1px solid rgba(15,23,42,.10);border-radius:18px;overflow:hidden;background:#eef2f6;box-shadow:inset 0 1px 0 rgba(255,255,255,.65)}
    .r-report-followup-card.is-additional .r-report-followup-map{height:min(58vh,560px)}
    .r-report-followup-map{height:280px;width:100%;background:#dbe4ee}
    .r-report-followup-map-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 11px;background:#fff;border-top:1px solid rgba(15,23,42,.08);font-size:11px;font-weight:900;color:#667085}
    .r-report-followup-map-legend{display:flex;flex-wrap:wrap;gap:8px}
    .r-report-followup-map-legend span{display:inline-flex;align-items:center;gap:5px}
    .r-report-followup-map-legend i{width:9px;height:9px;border-radius:999px;display:inline-block}
    .r-report-followup-map-legend .old i{background:#64748b}
    .r-report-followup-map-legend .new i{background:var(--primary,#d93025)}
    .r-report-followup-map-clear{border:0;background:transparent;color:var(--primary-readable,var(--primary,#d93025));font-size:11px;font-weight:1000;cursor:pointer}
    .r-report-followup-expedite{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .r-report-followup-expedite button{border:1px solid rgba(var(--primary-rgb,217,48,37),.22);border-radius:14px;background:var(--primary,#d93025);color:var(--on-primary,#fff);padding:10px;text-align:left;font-weight:1000;cursor:pointer;display:grid;gap:4px}
    .r-report-followup-expedite button span{font-size:10px;font-weight:850;opacity:.9}
    .r-report-followup-expedite button.active{outline:3px solid rgba(var(--primary-rgb,217,48,37),.24);box-shadow:inset 0 0 0 2px rgba(255,255,255,.75)}
    .r-report-followup-summary{border:1px solid rgba(15,23,42,.08);border-radius:15px;background:#f8fafc;padding:11px 12px;font-size:12px;font-weight:900;color:#344054;display:flex;align-items:center;justify-content:space-between;gap:12px}
    .r-report-followup-summary strong{font-size:17px;color:#101828}
    .r-report-followup-note{font-size:11px;font-weight:850;line-height:1.45;color:#667085}
    .r-report-followup-error{display:none;border:1px solid rgba(180,35,24,.18);border-radius:13px;background:#fff1f0;color:#b42318;padding:9px 11px;font-size:12px;font-weight:900}
    .r-report-followup-error.visible{display:block}
    .r-report-followup-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:4px}
    .r-report-followup-card.is-additional .r-report-followup-error,.r-report-followup-card.is-additional .r-report-followup-actions{grid-column:1}
    .r-report-followup-secondary,.r-report-followup-submit{height:40px;border-radius:13px;padding:0 14px;font-size:12px;font-weight:1000;cursor:pointer}
    .r-report-followup-secondary{border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054}
    .r-report-followup-submit{border:0;background:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 14px 28px rgba(var(--primary-rgb,217,48,37),.18)}
    .r-report-followup-submit:disabled{opacity:.55;cursor:not-allowed;box-shadow:none}
    @media (max-width: 980px){
      .r-report-followup-card.is-additional .r-report-followup-form{grid-template-columns:1fr}
      .r-report-followup-card.is-additional .r-report-followup-map-field{grid-column:auto;grid-row:auto;position:static}
      .r-report-followup-card.is-additional .r-report-followup-map{height:320px}
    }
    .r-preview{flex:1;position:relative;padding:0}
    .r-preview-stage{position:relative;height:100%;border-radius:24px;overflow:visible;border:1px solid rgba(255,255,255,.34);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 30px 70px rgba(15,23,42,.12);background:rgba(255,255,255,.22)}
    .r-preview-panel{position:absolute;inset:0;opacity:0;pointer-events:none;transform:translateY(14px) scale(.985);transition:opacity .28s ease,transform .28s cubic-bezier(.22,1,.36,1)}
    .r-preview-panel.active{opacity:1;pointer-events:auto;transform:translateY(0) scale(1)}
    .r-settings-panel{height:100%;min-height:0;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 24px 52px rgba(15,23,42,.12);display:flex;flex-direction:column}
    .r-settings-panel-head{height:58px;flex:0 0 auto;border-bottom:1px solid rgba(15,23,42,.08);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 16px}
    .r-settings-panel-head strong{font-size:14px;font-weight:1000;color:#111827}
    .r-settings-panel-head span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:2px}
    .r-settings-panel-close{width:34px;height:34px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#475467;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
    .r-settings-panel-close:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-settings-panel-body{flex:1;min-height:0;overflow:hidden}
    .r-signing-overlay{position:fixed;inset:0;z-index:2147483120;background:#d6d8dc;display:none;flex-direction:column}
    .r-signing-overlay.active{display:flex}
    .r-signing-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px}
    .r-signing-actions{display:flex;align-items:center;gap:10px}
    .r-signing-back{display:inline-flex;align-items:center;gap:8px;padding:12px 16px;border-radius:16px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#1f2937;font-size:13px;font-weight:1000;cursor:pointer;box-shadow:0 14px 28px rgba(15,23,42,.08)}
    .r-signing-next,.r-signing-finish{display:inline-flex;align-items:center;gap:8px;padding:12px 16px;border-radius:16px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#1f2937;font-size:13px;font-weight:1000;cursor:pointer;box-shadow:0 14px 28px rgba(15,23,42,.08)}
    .r-signing-finish{background:var(--primary-readable,var(--primary,#d93025));border-color:var(--primary-readable,var(--primary,#d93025));color:#fff}
    .r-signing-body{flex:1;min-height:0;padding:0 20px 20px}
    .r-signing-sheet{height:100%;border-radius:0;overflow:auto}
    .r-signature-page{width:min(820px,100%);aspect-ratio:8.5/11;background:#fff;border:1px solid rgba(15,23,42,.08);box-shadow:0 18px 42px rgba(15,23,42,.14);padding:56px 42px;display:flex;flex-direction:column;gap:24px}
    .r-signature-page h3{margin:0;font-size:22px;color:#111827}
    .r-signature-page p{margin:0;font-size:14px;line-height:1.6;color:#475467}
    .r-signature-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:auto}
    .r-signature-box{border:1px dashed rgba(15,23,42,.2);border-radius:18px;background:#f8fafc;padding:18px;min-height:160px;display:flex;flex-direction:column;justify-content:flex-end;gap:12px}
    .r-signature-box strong{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .r-signature-line{height:1px;background:rgba(15,23,42,.16)}
    .r-signature-modal{position:fixed;inset:0;z-index:2147483130;background:rgba(15,23,42,.38);backdrop-filter:blur(6px);display:none;align-items:center;justify-content:center;padding:24px}
    .r-signature-modal.active{display:flex}
    .r-signature-modal-card{width:min(920px,92vw);background:#fff;border-radius:26px;box-shadow:0 30px 90px rgba(15,23,42,.28);padding:24px;display:flex;flex-direction:column;gap:18px}
    .r-signature-modal-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .r-signature-modal-title{margin:0;font-size:24px;font-weight:1000;color:#101828}
    .r-signature-modal-sub{margin:6px 0 0;font-size:13px;line-height:1.55;color:#667085}
    .r-signature-modal-close{width:40px;height:40px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .r-signature-modal-body{display:grid;grid-template-columns:minmax(0,1.2fr) 280px;gap:18px;min-height:440px}
    .r-signature-modal-main{border:1px solid rgba(15,23,42,.08);border-radius:22px;background:#fbfcfe;padding:18px;display:flex;flex-direction:column;gap:16px}
    .r-signature-mode-row{display:flex;gap:10px}
    .r-signature-mode-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 14px;border-radius:14px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#475467;font-size:13px;font-weight:1000;cursor:pointer;transition:.18s ease}
    .r-signature-mode-btn.active{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
    .r-signature-adopt-name{width:100%;padding:14px 16px;border-radius:14px;border:1px solid rgba(15,23,42,.12);background:#fff;font-size:16px;font-weight:800;color:#111827;outline:none}
    .r-signature-style-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .r-signature-style-btn{border:1px solid rgba(15,23,42,.1);border-radius:18px;background:#fff;min-height:112px;padding:14px;display:flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;transition:.18s ease}
    .r-signature-style-btn.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-signature-style-sample{font-size:34px;line-height:1.05;color:#111827}
    .r-signature-style-sample.style-classic{font-family:"Brush Script MT","Segoe Script","Lucida Handwriting",cursive}
    .r-signature-style-sample.style-elegant{font-family:"Snell Roundhand","Segoe Script","Lucida Handwriting",cursive}
    .r-signature-style-sample.style-modern{font-family:"Segoe Print","Comic Sans MS",cursive}
    .r-signature-draw-wrap{display:flex;flex-direction:column;gap:12px;min-height:0}
    .r-signature-draw-pad{flex:1;min-height:280px;border:1px dashed rgba(15,23,42,.16);border-radius:20px;background:#fff;position:relative;overflow:hidden}
    .r-signature-draw-pad canvas{width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}
    .r-signature-draw-hint{position:absolute;left:16px;top:14px;font-size:12px;font-weight:800;color:#98a2b3;pointer-events:none}
    .r-signature-side{border:1px solid rgba(15,23,42,.08);border-radius:22px;background:#fff;padding:18px;display:flex;flex-direction:column;justify-content:space-between;gap:16px}
    .r-signature-preview-box{border:1px dashed rgba(15,23,42,.16);border-radius:18px;background:#fbfcfe;padding:18px;min-height:150px;display:flex;align-items:center;justify-content:center}
    .r-signature-preview-box img{max-width:100%;max-height:110px;object-fit:contain}
    .r-signature-preview-text{font-size:36px;color:#111827;line-height:1.05}
    .r-signature-preview-text.style-classic{font-family:"Brush Script MT","Segoe Script","Lucida Handwriting",cursive}
    .r-signature-preview-text.style-elegant{font-family:"Snell Roundhand","Segoe Script","Lucida Handwriting",cursive}
    .r-signature-preview-text.style-modern{font-family:"Segoe Print","Comic Sans MS",cursive}
    .r-signature-secondary{display:inline-flex;align-items:center;justify-content:center;padding:11px 14px;border-radius:14px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#475467;font-size:12px;font-weight:1000;cursor:pointer}
    .r-signature-modal-actions{display:flex;justify-content:flex-end;gap:10px}
    .r-signature-apply{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:13px 18px;border-radius:14px;border:0;background:var(--primary-readable,var(--primary,#d93025));color:#fff;font-size:13px;font-weight:1000;cursor:pointer}
    #rMap{position:absolute;inset:0}
    .r-map-hint{position:absolute;top:16px;left:50%;transform:translateX(-50%);background:rgba(255,255,255,.92);border:1px solid rgba(15,23,42,.1);padding:9px 13px;border-radius:999px;font-weight:1000;font-size:12px;box-shadow:0 12px 28px rgba(15,23,42,.14);z-index:5;display:none;pointer-events:none}
    .r-map-hint.visible{display:block}
    .r-photo-wrap{height:100%;padding:18px;background:#f8fafc;border-radius:0;overflow:hidden}
    .r-photo-upload{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px dashed rgba(15,23,42,.18);background:#fff;color:#475467;font-size:12px;font-weight:1000;cursor:pointer;transition:.14s ease}
    .r-photo-upload:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.35);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),0.03)}
    .r-photo-empty{height:100%;border:2px dashed rgba(15,23,42,.14);border-radius:0;background:#ffffff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#667085;text-align:center;padding:28px;transition:.16s ease}
    .r-photo-empty.dragover,.r-photo-stage.dragover,.r-photo-strip.dragover{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),0.04)}
    .r-photo-empty i{width:54px;height:54px;border-radius:18px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px}
    .r-photo-empty strong{font-size:16px;color:#111827}
    .r-photo-empty-tile{width:min(108px,30vw);aspect-ratio:1/1;border:1px dashed rgba(15,23,42,.24);border-radius:20px;background:#f8fafc;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease}
    .r-photo-empty-tile:hover{background:#f1f5f9;border-color:rgba(15,23,42,.38)}
    .r-photo-empty-plus{font-size:38px;line-height:1;color:#98a2b3;font-weight:300}
    .r-photo-gallery{height:100%;display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:16px;min-height:0}
    .r-photo-gallery.is-grid{display:flex;flex-direction:column}
    .r-preview-panel[data-panel="photos"] .pf-group{border-radius:0}
    .r-photo-grid-only{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;overflow:auto;padding-right:4px}
    .r-photo-gallery-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
    .r-photo-gallery-head strong{font-size:13px;font-weight:1000;color:#111827}
    .r-photo-gallery.viewer{display:flex;flex-direction:column;gap:12px}
    .r-photo-viewer-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .r-photo-viewer-title{flex:1;text-align:center;font-size:13px;font-weight:1000;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-photo-stage{position:relative;border-radius:0;background:#ffffff;border:1px solid rgba(15,23,42,.08);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:0;transition:.16s ease;flex:1}
    .r-photo-stage img,.r-photo-stage video{width:100%;height:100%;object-fit:contain;background:#101828}
    .r-photo-nav{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.92);display:flex;align-items:center;justify-content:center;cursor:pointer;color:#344054;box-shadow:0 12px 24px rgba(15,23,42,.12)}
    .r-photo-nav:hover{background:#fff}
    .r-photo-nav.prev{left:14px}
    .r-photo-nav.next{right:14px}
    .r-photo-count{position:absolute;left:16px;bottom:16px;padding:8px 12px;border-radius:999px;background:rgba(17,24,39,.78);color:#fff;font-size:11px;font-weight:1000}
    .r-photo-strip{border-radius:0;background:#ffffff;border:1px solid rgba(15,23,42,.08);padding:10px;display:flex;gap:10px;overflow:auto;transition:.16s ease}
    .r-photo-thumb{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:0;cursor:pointer;transition:.16s ease;display:block;overflow:hidden}
    .r-photo-strip .r-photo-thumb{min-width:104px;max-width:104px}
    .r-photo-thumb:hover{transform:translateY(-1px);box-shadow:0 12px 20px rgba(15,23,42,.08)}
    .r-photo-thumb.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.12)}
    .r-photo-thumb img,.r-photo-thumb video{width:100%;aspect-ratio:1/1;object-fit:cover;background:#eef2f6;display:block}
    .r-photo-thumb{position:relative}.r-photo-video-placeholder{width:100%;aspect-ratio:1/1;background:#101828;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px}.r-photo-video-badge{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border-radius:999px;background:rgba(15,23,42,.76);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 8px 16px rgba(15,23,42,.16);pointer-events:none}
    #rProposalPreview{position:relative;overflow:hidden}
    .r-proposal-wrap{height:100%;overflow:auto;background:#d6d8dc;padding:22px;overflow-x:visible}
    .r-proposal-wrap.markup-active .r-proposal-editable{border-color:transparent!important;background:transparent!important;box-shadow:none!important}
    .r-proposal-wrap.markup-active .r-proposal-editable[contenteditable="true"]{pointer-events:none!important}
    .r-proposal-wrap.markup-active .r-proposal-page-insert{opacity:0;pointer-events:none}
    .r-proposal-topmode{position:absolute;top:96px;right:66px;z-index:61;display:none}
    .r-proposal-topmode.visible{display:block}
    .r-proposal-markupdock{position:absolute;top:156px;right:39px;z-index:61;display:none;width:42px}
    .r-proposal-markupdock.visible{display:block}
    .r-proposal-markupdock.expanded{width:42px}
    .r-proposal-markup-btn{position:relative;width:42px;height:42px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.92);backdrop-filter:blur(14px);color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 34px rgba(15,23,42,.12);transition:.18s ease}
    .r-proposal-markup-btn:hover{transform:translateY(-1px);background:#fff;color:#101828}
    .r-proposal-markup-btn.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
    .r-proposal-markup-tools{position:absolute;top:52px;right:0;display:flex;flex-direction:column;gap:10px;pointer-events:none}
    .r-proposal-markupdock.expanded .r-proposal-markup-tools{pointer-events:auto}
    .r-proposal-markup-tool{width:42px;height:42px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.94);backdrop-filter:blur(14px);color:#475467;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 34px rgba(15,23,42,.12);opacity:0;transform:translateY(-14px) scale(.88);transition:opacity .2s ease,transform .26s cubic-bezier(.22,1,.36,1),background .18s ease,color .18s ease,border-color .18s ease}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool{opacity:1;transform:translateY(0) scale(1)}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(1){transition-delay:.02s}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(2){transition-delay:.05s}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(3){transition-delay:.08s}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(4){transition-delay:.11s}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(5){transition-delay:.14s}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(6){transition-delay:.17s}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:nth-child(7){transition-delay:.20s}
    .r-proposal-markup-tool:hover{transform:translateY(0) scale(1.04);background:#fff;color:#101828}
    .r-proposal-markup-tool:disabled{cursor:not-allowed;transform:translateY(-14px) scale(.88);background:rgba(255,255,255,.74);color:#98a2b3}
    .r-proposal-markupdock.expanded .r-proposal-markup-tool:disabled{opacity:.36;transform:translateY(0) scale(.96)}
    .r-proposal-markup-tool.active{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
    .r-proposal-markup-tool.swatch{position:relative;overflow:hidden}
    .r-proposal-markup-tool-swatch{position:absolute;inset:10px;border-radius:10px;border:1px solid rgba(255,255,255,.35)}
    .r-proposal-markup-tool-size{font-size:11px;font-weight:1000;letter-spacing:.02em}
    .r-proposal-markup-pop{position:absolute;right:52px;top:0;padding:12px;border-radius:16px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.96);backdrop-filter:blur(14px);box-shadow:0 18px 34px rgba(15,23,42,.12);opacity:0;transform:translateX(8px) scale(.96);pointer-events:none;transition:opacity .18s ease,transform .22s cubic-bezier(.22,1,.36,1)}
    .r-proposal-markup-pop.visible{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
    .r-proposal-markup-slider{width:140px}
    .r-proposal-markup-slider input{width:100%}
    .r-proposal-markup-colorbox,.r-proposal-markup-recent{display:grid;grid-template-columns:repeat(6,28px);gap:8px}
    .r-proposal-markup-recent{margin-bottom:8px;min-height:28px}
    .r-proposal-markup-recent.empty{display:none}
    .r-proposal-markup-color{width:28px;height:28px;border-radius:10px;border:1px solid rgba(15,23,42,.08);cursor:pointer;box-shadow:inset 0 0 0 1px rgba(255,255,255,.45)}
    .r-proposal-markup-color.custom{position:relative;background:conic-gradient(#ff6b6b,#ffd166,#06d6a0,#118ab2,#9b5de5,#ff6b6b)}
    .r-proposal-markup-color input{position:absolute;inset:0;opacity:0;cursor:pointer}
    .r-proposal-mode{display:inline-flex;gap:6px;padding:6px;border-radius:16px;background:rgba(255,255,255,.9);border:1px solid rgba(15,23,42,.08);box-shadow:0 18px 34px rgba(15,23,42,.12)}
    .r-proposal-mode-btn{border:0;background:transparent;color:#475467;font-size:12px;font-weight:1000;padding:10px 14px;border-radius:12px;cursor:pointer;transition:.16s ease}
    .r-proposal-mode-btn.active{background:var(--primary,#d93025);color:#fff}
    .r-proposal-pages{--proposal-page-base-width:820px;--proposal-page-base-height:calc(820px * 11 / 8.5);--proposal-page-scale:1;display:flex;flex-direction:column;gap:18px;align-items:center}
    .r-proposal-empty{width:min(560px,100%);margin:auto;border:1px dashed rgba(15,23,42,.16);border-radius:18px;background:#fff;padding:34px;text-align:center;color:#667085;font-size:13px;font-weight:850}
    .r-proposal-empty i{display:block;font-size:24px;margin-bottom:10px;color:#98a2b3}
    .r-proposal-page-stack{position:relative;flex:0 0 auto;width:calc(var(--proposal-page-base-width) * var(--proposal-page-scale));height:calc(var(--proposal-page-base-height) * var(--proposal-page-scale));aspect-ratio:auto;transition:transform .34s cubic-bezier(.22,1,.36,1)}
    .r-proposal-page-stack.insert-after{z-index:90;transform:translateY(-96px);animation:rProposalSplitUp .34s cubic-bezier(.22,1,.36,1)}
    .r-proposal-page-stack.insert-after + .r-proposal-page-stack{z-index:1;transform:translateY(96px);animation:rProposalSplitDown .34s cubic-bezier(.22,1,.36,1)}
    @keyframes rProposalSplitUp{from{transform:translateY(0)}to{transform:translateY(-96px)}}
    @keyframes rProposalSplitDown{from{transform:translateY(0)}to{transform:translateY(96px)}}
    .r-proposal-page{position:relative;overflow:hidden;width:var(--proposal-page-base-width);height:var(--proposal-page-base-height);min-height:0;max-height:none;max-width:none;aspect-ratio:auto;box-sizing:border-box;background:#fff;border:1px solid rgba(15,23,42,.08);box-shadow:0 18px 42px rgba(15,23,42,.14);padding:38px 42px;display:flex;flex-direction:column;gap:18px;font-family:var(--proposal-font-family,"Montserrat",Arial,sans-serif);transform:scale(var(--proposal-page-scale));transform-origin:top left}
    .r-proposal-page :where(input,textarea,button,select,h2,h3,p,div,span,b,label,section){font-family:inherit}
    .r-proposal-page.is-active{box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.16),0 18px 42px rgba(15,23,42,.14)}
    .r-proposal-page.theme-margin{padding-left:108px;background:#fff}
    .r-proposal-page.theme-margin::before{content:'';position:absolute;z-index:0;top:0;left:0;bottom:0;width:48px;background:var(--primary,#d93025)}
    .r-proposal-page.theme-margin::after{content:'';position:absolute;z-index:0;top:0;left:48px;bottom:0;width:10px;background:var(--accent,#f3b5b0)}
    .r-proposal-page.theme-triangles::before{content:'';position:absolute;z-index:0;top:0;left:0;width:40%;height:20%;background:linear-gradient(135deg,var(--accent-soft,rgba(217,48,37,.28)) 0 68%,transparent 68.5%)}
    .r-proposal-page.theme-triangles::after{content:'';position:absolute;z-index:0;right:0;bottom:0;width:22%;height:22%;background:linear-gradient(315deg,var(--primary,#d93025) 0 65%,transparent 66%)}
    .r-proposal-page.theme-triangles .r-proposal-page-shape-top{position:absolute;z-index:0;top:0;left:0}
    .r-proposal-page.theme-triangles.is-cover{padding-top:184px}
.r-proposal-page.theme-triangles.is-cover::before{width:40%;height:29%;background:linear-gradient(135deg,var(--accent-soft,rgba(217,48,37,.28)) 0 65%,transparent 65.5%)}
.r-proposal-page.theme-triangles.is-cover .r-proposal-page-shape-top{width:29%;height:23%;background:linear-gradient(135deg,var(--primary,#d93025) 0 65%,transparent 65.5%)}
    .r-proposal-page.theme-triangles:not(.is-cover)::before{top:auto;left:auto;right:0;bottom:0;width:var(--triangle-accent-width,46%);height:18%;background:linear-gradient(315deg,var(--accent-soft,rgba(217,48,37,.28)) 0 68%,transparent 68.5%)}
    .r-proposal-page.theme-triangles:not(.is-cover)::after{width:24%;height:24%}
    .r-proposal-page.theme-triangles:not(.is-cover) .r-proposal-page-shape-top{width:var(--triangle-header-width,36%);height:10%;background:linear-gradient(135deg,var(--primary,#d93025) 0 68%,transparent 68.5%)}
    .r-proposal-page.theme-clean{padding-top:86px}
    .r-proposal-page.is-full-replacement{padding:0;gap:0;background:#fff;border:0;box-shadow:none}
    .r-proposal-page.is-full-replacement::before,.r-proposal-page.is-full-replacement::after{display:none}
    .r-proposal-page.is-full-replacement .r-proposal-page-content{height:100%;max-height:100%;gap:0;padding:0;overflow:hidden}
    .r-proposal-page-header{display:none;z-index:0}
    .r-proposal-page.theme-clean .r-proposal-page-header{position:absolute;top:0;left:0;right:0;height:52px;border-bottom:3px solid var(--primary,#d93025);background:#f8fafc;display:flex;align-items:center;justify-content:space-between;padding:0 26px}
    .r-proposal-page.theme-clean.is-cover .r-proposal-page-header{height:78px;background:linear-gradient(180deg,#f8fafc 0%,#fff 100%)}
    .r-proposal-page-logo{font-size:11px;font-weight:1000;letter-spacing:.18em;text-transform:uppercase;color:#111827}
    .r-proposal-page-number{font-size:11px;font-weight:1000;color:#667085}
    .r-proposal-page-logoimg{display:block;max-height:38px;max-width:180px;object-fit:contain}
    .r-proposal-page-logoimg.large{max-height:96px;max-width:260px}
    .r-proposal-brand-lockup{display:inline-flex;align-items:center;gap:clamp(12px,8%,28px);min-width:0}
    .r-proposal-brand-lockup.triangles{flex-direction:row-reverse;gap:clamp(24px,14%,56px)}
    .r-proposal-cobrand{position:relative;display:inline-flex;align-items:center;justify-content:center;height:38px;max-width:180px;background:transparent;border:0;padding:0;box-shadow:none}
    .r-proposal-brand-lockup.triangles .r-proposal-cobrand{border:0;padding:0}
    .r-proposal-cobrand img{max-width:170px;max-height:38px;object-fit:contain;display:block;background:transparent;border:0;box-shadow:none}
    .r-proposal-page-logoimg.large + .r-proposal-cobrand{height:96px;max-width:360px}
    .r-proposal-page-logoimg.large + .r-proposal-cobrand img{max-height:96px;max-width:360px}
    .r-proposal-cobrand-error{display:none;color:#b42318;font-size:10px;font-weight:1000;white-space:nowrap}
    .r-proposal-cobrand.load-failed img{display:none}
    .r-proposal-cobrand.load-failed .r-proposal-cobrand-error{display:inline-flex;align-items:center;justify-content:center;height:100%;max-width:170px}
    .r-proposal-page-logoimg.large + .r-proposal-cobrand.load-failed .r-proposal-cobrand-error{max-width:360px}
    .r-proposal-cobrand-add{width:30px;height:30px;border-radius:999px;border:1px dashed rgba(15,23,42,.2);background:rgba(255,255,255,.92);color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease;flex:0 0 auto}
    .r-proposal-cobrand-add:hover{border-color:rgba(var(--primary-rgb,217,48,37),.3);color:var(--primary-readable,var(--primary,#d93025));background:#fff}
    .r-proposal-cobrand.editable{cursor:pointer}
    .r-proposal-cobrand-remove{position:absolute;right:-8px;top:-8px;width:18px;height:18px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#667085;display:none;align-items:center;justify-content:center;font-size:9px;cursor:pointer;box-shadow:0 6px 12px rgba(15,23,42,.14)}
    .r-proposal-brand-lockup.triangles .r-proposal-cobrand-remove{right:auto;left:-8px}
    .r-proposal-cobrand.editable:hover .r-proposal-cobrand-remove{display:flex}
    .r-proposal-page-content{position:relative;z-index:1;display:flex;flex:1 1 auto;flex-direction:column;gap:18px;min-height:0;max-height:100%;overflow:visible}
    .r-proposal-page.kind-pricing .r-proposal-page-content{overflow:visible}
    .r-proposal-page.theme-margin.is-cover .r-proposal-page-content{padding-top:44px}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-page-content{padding-top:36px;height:calc(100% - 40px);min-height:0;justify-content:center;align-items:center}
    .r-proposal-page.theme-triangles:not(.is-cover) .r-proposal-page-content{padding-top:92px}
    .r-proposal-margin-logo{position:absolute;z-index:1;top:28px;left:76px}
    .r-proposal-triangle-logo{position:absolute;z-index:2;top:28px;right:36px;opacity:.98}
    .r-proposal-kicker,.r-proposal-page-title{font-size:11px;font-weight:1000;letter-spacing:.12em;text-transform:uppercase;color:#667085}
    .r-proposal-page-title{font-size:13px;letter-spacing:.08em}
    .r-proposal-page.theme-triangles:not(.is-cover) .r-proposal-page-title{position:absolute;top:6px;left:-14px;z-index:2;color:#fff;font-size:22px;letter-spacing:.06em;line-height:1.1}
    .r-proposal-page h2{margin:0;font-size:28px;line-height:1.05;color:#111827}
    .r-proposal-page h3{margin:0;font-size:15px;color:#111827}
    .r-proposal-page p{margin:0;font-size:13px;line-height:1.6;color:#475467}
    .r-proposal-cover-shell{position:relative;display:flex;flex-direction:column;align-items:center;overflow:visible;width:100%;box-sizing:border-box}
    .r-proposal-cover-stage{position:relative;display:flex;justify-content:center;align-items:flex-start;overflow:visible;flex-shrink:0}
    .r-proposal-cover-stage.is-hidden{height:0 !important;min-height:0;overflow:visible;margin-bottom:4px}
    .r-proposal-cover-image{width:240px;max-width:100%;height:240px;border-radius:22px;border:1px solid rgba(15,23,42,.08);background:#eef2f6;overflow:hidden;position:relative;display:flex;flex-direction:column;flex-shrink:0}
    .r-proposal-cover-image::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,23,42,.02),rgba(15,23,42,.14));pointer-events:none}
    .r-proposal-cover-image.is-editable{cursor:pointer}
    .r-proposal-cover-image.is-adjusting{cursor:grab}
    .r-proposal-cover-image.is-adjusting:active{cursor:grabbing}
    .r-proposal-cover-image.is-empty{border-style:dashed;background:#f8fafc}
    .r-proposal-cover-image.is-empty:not(.is-editable){border-color:transparent;background:transparent}
    .r-proposal-cover-image.is-empty:not(.is-editable)::after{display:none}
    .r-proposal-cover-image-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:6px;padding:6px;height:100%;box-sizing:border-box;position:relative;z-index:1}
    .r-proposal-cover-image-grid.count-1{grid-template-columns:1fr;grid-template-rows:1fr}
    .r-proposal-cover-image-grid.count-2{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:1fr}
    .r-proposal-cover-image-grid > :is(img,.r-proposal-video-frame,.r-proposal-media-processing){width:100%;height:100%;min-width:0;min-height:0;object-fit:cover;display:block;border-radius:16px;overflow:hidden}
    .r-proposal-cover-image-grid.count-1 > :is(img,.r-proposal-video-frame,.r-proposal-media-processing){transform-origin:center center}
    .r-proposal-cover-image-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:42px;color:#98a2b3;z-index:1}
    .r-proposal-cover-image-badge{position:absolute;right:12px;bottom:12px;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.92);border:1px solid rgba(15,23,42,.08);font-size:10px;font-weight:1000;color:#344054;z-index:2;opacity:0;transform:translateY(4px);transition:.18s ease;pointer-events:none}
    .r-proposal-cover-image.is-editable:hover .r-proposal-cover-image-badge{opacity:1;transform:translateY(0)}
    .r-proposal-cover-editbtn{position:absolute;top:12px;right:12px;z-index:4}
    .r-proposal-cover-toggle-anchor{position:absolute;top:8px;left:calc(100% + 12px);display:flex;justify-content:flex-start;align-items:center;z-index:5;pointer-events:none}
    .r-proposal-cover-stage.is-hidden .r-proposal-cover-toggle-anchor{top:auto;bottom:100%;margin-bottom:8px}
    .r-proposal-cover-toggle{position:relative;z-index:4;white-space:nowrap;pointer-events:auto}
    .r-proposal-cover-adjust{position:absolute;top:12px;left:12px;width:168px;padding:10px 12px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.96);box-shadow:0 18px 34px rgba(15,23,42,.12);display:none;flex-direction:column;gap:8px;z-index:4}
    .r-proposal-cover-adjust.visible{display:flex}
    .r-proposal-cover-adjust label{display:flex;flex-direction:column;gap:6px;font-size:11px;font-weight:900;color:#475467}
    .r-proposal-cover-adjust input{width:100%}
    .r-proposal-cover-widthgrab{position:absolute;top:50%;right:-14px;transform:translateY(-50%);width:28px;height:110px;border-radius:999px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 10px 18px rgba(15,23,42,.1);display:flex;align-items:center;justify-content:center;color:#98a2b3;cursor:ew-resize;z-index:3}
    .r-proposal-cover-widthgrab i{transform:rotate(90deg);font-size:10px}
    .r-proposal-cover-heightgrab{position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);width:110px;height:28px;border-radius:999px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 10px 18px rgba(15,23,42,.1);display:flex;align-items:center;justify-content:center;color:#98a2b3;cursor:row-resize;z-index:3}
    .r-proposal-cover-heightgrab i{font-size:10px}
    .r-proposal-cover-cornergrab{position:absolute;right:-12px;bottom:-12px;width:30px;height:30px;border-radius:999px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 10px 18px rgba(15,23,42,.1);display:flex;align-items:center;justify-content:center;color:#98a2b3;cursor:nwse-resize;z-index:3}
    .r-proposal-cover-cornergrab i{font-size:11px}
    .r-proposal-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .r-proposal-meta-card{border:1px solid rgba(15,23,42,.08);border-radius:16px;padding:14px;background:#f8fafc}
    .r-proposal-meta-card.wide{grid-column:1/-1}
    .r-proposal-meta-card strong{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#667085;margin-bottom:6px}
    .r-proposal-meta-card span{font-size:14px;font-weight:900;color:#111827}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-meta-card{border:0;background:transparent;padding:0}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-meta-card strong{margin-bottom:4px}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-cover-shell{margin-bottom:22px}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-edit-heading{font-size:34px;line-height:1.02;text-align:center;max-width:min(520px,100%);margin-top:4px}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-meta{grid-template-columns:1fr;gap:6px;max-width:360px;width:100%;text-align:center;justify-items:center}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-meta-card.wide{grid-column:auto}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-meta-card{display:flex;flex-direction:column;align-items:center}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-edit-meta,
    .r-proposal-page.theme-triangles.is-cover .r-proposal-edit-paragraph{font-size:15px;line-height:1.45;text-align:center}
    .r-proposal-page.theme-triangles.is-cover .r-proposal-edit-meta{font-size:14px;line-height:1.35;text-align:center;max-width:100%;margin-left:auto;margin-right:auto}
    .r-proposal-list{display:flex;flex-direction:column;gap:10px}
    .r-proposal-row{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid rgba(15,23,42,.08);font-size:13px;color:#344054}
    .r-proposal-row:last-child{border-bottom:0}
    .r-proposal-total{margin-top:auto;padding-top:14px;border-top:1px solid rgba(15,23,42,.1);display:flex;justify-content:space-between;align-items:center}
    .r-proposal-total strong{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .r-proposal-total span{font-size:24px;font-weight:1000;color:#111827}
    .r-proposal-page.theme-triangles .r-proposal-total.is-final-page-total{position:relative;padding-top:16px;border-top:0}
    .r-proposal-page.theme-triangles .r-proposal-total.is-final-page-total::before{content:'';position:absolute;left:0;right:220px;top:0;height:1px;background:rgba(15,23,42,.14)}
    .r-proposal-page.theme-triangles .r-proposal-total.is-final-page-total strong,
    .r-proposal-page.theme-triangles .r-proposal-total.is-final-page-total .r-proposal-edit-total{color:#fff;font-weight:1000}
    .r-proposal-section{display:none;flex-direction:column;gap:10px}
    .r-proposal-section.visible{display:flex;flex:1;min-height:calc(100vh - 320px)}
    .r-proposal-section.mode-edit .r-proposal-listing,.r-proposal-section.mode-send .r-proposal-listing{animation:rProposalPanelIn .36s cubic-bezier(.22,1,.36,1)}
    .r-proposal-section.mode-list .r-proposal-listing{animation:rProposalPanelSettle .24s ease}
    @keyframes rProposalPanelIn{from{opacity:.72;transform:translateX(34px)}to{opacity:1;transform:translateX(0)}}
    @keyframes rProposalPanelSettle{from{opacity:.82;transform:translateX(-18px)}to{opacity:1;transform:translateX(0)}}
    .r-overlay.proposal-workspace:not(.proposal-list-mode) #rStepCustomer,
    .r-overlay.proposal-workspace:not(.proposal-list-mode) #rStepAddress,
    .r-overlay.proposal-workspace #rStepType,
    .r-overlay.proposal-workspace #rStepReport,
    .r-overlay.proposal-workspace #rStepRoof{display:none!important}
    .r-overlay.left-override[data-left-override-tab="proposal"].proposal-list-mode #rStepCustomer,
    .r-overlay.left-override[data-left-override-tab="proposal"].proposal-list-mode #rStepAddress{display:block!important}
    .r-overlay.proposal-list-mode #rStepAddress{border-bottom:1px solid rgba(15,23,42,.10);padding-bottom:12px;margin-bottom:4px}
    .r-overlay.proposal-list-mode #rProposalSection.visible{min-height:0;flex:1 1 auto}
    .r-overlay.proposal-list-mode .r-proposal-listing{min-height:0;flex:1 1 auto}
    .r-overlay.proposal-list-mode .r-proposal-workspace-head{padding:4px 0 6px;margin:0;align-items:flex-start}
    .r-overlay.proposal-list-mode .r-proposal-workspace-head > div{gap:3px}
    .r-overlay.proposal-list-mode .r-proposal-workspace-head strong{font-size:13px;font-weight:1000;color:#111827;line-height:1.2}
    .r-overlay.proposal-list-mode .r-proposal-workspace-head span{font-size:11px;font-weight:800;color:#667085;line-height:1.45}
    .r-overlay.proposal-edit-mode .r-scroll{overflow:hidden;display:flex;flex-direction:column}
    .r-overlay.proposal-edit-mode #rProposalSection.visible{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
    .r-overlay.proposal-edit-mode #rProposalSection .r-step-shell,
    .r-overlay.proposal-edit-mode #rProposalSection .r-step-inner,
    .r-overlay.proposal-edit-mode #rProposalSection .r-step-body{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
    .r-overlay.proposal-edit-mode #rProposalSection .r-step-inner{overflow:hidden}
    .r-overlay.proposal-edit-mode #rProposalSection .r-step-body{padding-bottom:0}
    .r-overlay.proposal-edit-mode .r-proposal-listing{min-height:0;flex:1 1 auto;overflow:hidden}
    .r-overlay.left-override[data-left-override-tab="scope"] .r-scroll{overflow:hidden;display:flex;flex-direction:column}
    .r-overlay.left-override[data-left-override-tab="scope"] #rProposalSection.visible{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
    .r-proposal-listing{display:flex;flex-direction:column;gap:10px;min-height:calc(100vh - 320px)}
    .r-proposal-workspace-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:2px}
    .r-proposal-workspace-head > div{min-width:0;display:flex;flex-direction:column;gap:2px}
    .r-proposal-workspace-head strong{font-size:13px;font-weight:1000;color:#111827}
    .r-proposal-workspace-head span{font-size:10px;font-weight:900;color:#667085}
    .r-proposal-settings-link{height:32px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#475467;border-radius:10px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:11px;font-weight:1000;cursor:pointer;transition:.16s ease;white-space:nowrap}
    .r-proposal-settings-link:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-proposal-workspace-title{min-width:0;flex:1;border:0;background:transparent;color:#111827;font-size:13px;font-weight:1000;font-family:inherit;padding:7px 0}
    .r-proposal-workspace-title:focus{outline:none}
    .r-proposal-editor-head{flex-shrink:0}
    .r-proposal-editor-head .r-proposal-status-row{flex:0 0 auto;flex-direction:row;flex-wrap:nowrap}
    .r-proposal-rail-scroll{display:flex;flex:1 1 auto;flex-direction:column;gap:10px;min-height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;padding-right:var(--fm-scrollbar-content-gap,10px);scrollbar-gutter:stable}
    .r-proposal-back{width:34px;height:34px;border-radius:12px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#475467;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
    .r-proposal-back:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-proposal-add-card{width:100%;min-height:56px;border:1px dashed rgba(var(--primary-rgb,217,48,37),.28);border-radius:16px;background:rgba(var(--primary-rgb,217,48,37),.045);color:var(--primary-readable,var(--primary,#d93025));display:flex;align-items:center;justify-content:center;gap:9px;font-size:12px;font-weight:1000;cursor:pointer;transition:.18s ease}
    .r-proposal-add-card:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(15,23,42,.08);background:#fff}
    .r-proposal-list-view{display:flex;flex-direction:column;gap:9px}
    .r-proposal-list-card{width:100%;border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:11px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;text-align:left;cursor:pointer;transition:.16s ease}
    .r-proposal-list-card:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(15,23,42,.08)}
    .r-proposal-list-card.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-proposal-list-main{min-width:0}
    .r-proposal-list-main strong{display:block;font-size:12px;font-weight:1000;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-proposal-list-main span{display:block;font-size:10px;font-weight:800;color:#667085;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-proposal-list-side{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
    .r-proposal-status-row{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
    .r-proposal-status-badge{height:26px;border:1px solid rgba(15,23,42,.08);border-radius:999px;background:#f8fafc;color:#667085;font-size:10px;font-weight:1000;padding:0 9px;display:inline-flex;align-items:center;text-transform:uppercase}
    .r-proposal-status-badge.sent{background:rgba(21,128,61,.08);border-color:rgba(21,128,61,.14);color:#15803d}
    .r-proposal-status-badge.discarded{background:rgba(180,35,24,.08);border-color:rgba(180,35,24,.14);color:#b42318}
    .r-proposal-delivery-badge.unviewed{background:rgba(217,119,6,.08);border-color:rgba(217,119,6,.16);color:#b45309}
    .r-proposal-delivery-badge.viewed{background:rgba(37,99,235,.08);border-color:rgba(37,99,235,.14);color:#2563eb}
    .r-proposal-delivery-badge.signed{background:rgba(21,128,61,.08);border-color:rgba(21,128,61,.14);color:#15803d}
    .r-proposal-list-actions{display:flex;align-items:center;gap:5px}
    .r-proposal-list-actions button{height:28px;min-width:28px;border:1px solid rgba(15,23,42,.08);border-radius:10px;background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;padding:0 8px;font-size:10px;font-weight:1000;cursor:pointer}
    .r-proposal-list-actions button:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.22);background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-proposal-list-actions button:disabled{opacity:.58;cursor:not-allowed;transform:none}
    .r-proposal-list-actions button.loading{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.22);background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-proposal-list-actions button.confirm{background:#b42318;border-color:#b42318;color:#fff}
    .r-proposal-more-wrap{position:relative;display:inline-flex}
    .r-proposal-more-menu{position:absolute;right:0;top:calc(100% + 6px);width:176px;border:1px solid rgba(15,23,42,.10);border-radius:12px;background:#fff;box-shadow:0 18px 42px rgba(15,23,42,.16);padding:6px;z-index:30;display:grid;gap:2px}
    .r-proposal-list-actions .r-proposal-more-menu button{width:100%;height:34px;border:0;border-radius:9px;background:transparent;color:#344054;justify-content:flex-start;gap:9px;padding:0 9px;font-size:12px}
    .r-proposal-list-actions .r-proposal-more-menu button:hover{background:#f8fafc;border-color:transparent;color:#111827}
    .r-proposal-list-actions .r-proposal-more-menu button.danger{color:#b42318}
    .r-proposal-list-actions .r-proposal-more-menu button.danger:hover{background:rgba(180,35,24,.07);color:#b42318}
    .r-proposal-list-actions .r-proposal-more-menu button.confirm{background:#b42318;color:#fff}
    .r-proposal-empty-list,.r-proposal-preview-empty{min-height:220px;border:1px dashed rgba(15,23,42,.12);border-radius:18px;background:rgba(255,255,255,.7);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;color:#667085;padding:20px}
    .r-proposal-empty-list>i,.r-proposal-preview-empty>i{font-size:24px;color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-empty-list>strong,.r-proposal-preview-empty>strong{font-size:13px;font-weight:1000;color:#111827}
    .r-proposal-empty-list>span,.r-proposal-preview-empty>span{font-size:11px;font-weight:800;line-height:1.45}
    .r-proposal-preview-empty{height:100%;border:0;background:#f8fafc;border-radius:0}
    .r-proposal-preview-create{display:none}
    .r-proposal-send-form{display:flex;flex-direction:column;gap:12px}
    .r-proposal-send-block{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:12px;display:flex;flex-direction:column;gap:9px}
    .r-proposal-send-block > strong,.r-proposal-send-message span{font-size:10px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase;color:#667085}
    .r-proposal-send-list{display:flex;flex-direction:column;gap:7px}
    .r-proposal-send-check{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:9px;border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#f8fafc;padding:9px 10px;font-size:11px;font-weight:900;color:#344054}
    .r-proposal-send-check input{accent-color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-send-check span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-proposal-send-check em{font-style:normal;font-size:9px;font-weight:1000;text-transform:uppercase;color:#667085}
    .r-proposal-send-empty{font-size:11px;font-weight:800;color:#98a2b3;padding:10px}
    .r-proposal-send-message{display:flex;flex-direction:column;gap:7px}
    .r-proposal-send-options{display:flex;flex-direction:column;gap:8px;border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:12px}
    .r-proposal-send-options label{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:900;color:#344054}
    .r-proposal-send-options input{accent-color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-send-submit,.r-proposal-bottom-send{border:0;border-radius:14px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;min-height:42px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;font-weight:1000;cursor:pointer;box-shadow:0 14px 24px rgba(15,23,42,.12)}
    .r-proposal-bottom-send{display:none;width:100%;box-shadow:none}
    .r-proposal-bottom-send.visible{display:flex}
    .r-proposal-settings{border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#fff;padding:14px;display:flex;flex-direction:column;gap:10px}
    .r-proposal-settings.style-section{border:0;border-radius:0;background:transparent;padding:0 0 14px;border-bottom:1px solid rgba(15,23,42,.1);gap:12px}
    .r-proposal-settings-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .r-proposal-settings-head strong{font-size:12px;font-weight:1000;color:#111827}
    .r-proposal-settings-head span{font-size:11px;font-weight:800;color:#667085}
    .r-proposal-settings-head-actions{display:flex;align-items:center;gap:10px}
    .r-proposal-rail-section{display:flex;flex-direction:column;gap:10px;padding:0 0 14px;border-bottom:1px solid rgba(15,23,42,.1)}
    .r-proposal-rail-section:last-child{border-bottom:0;padding-bottom:0}
    .r-proposal-rail-toggle,.r-proposal-rail-heading{border:0;background:transparent;padding:0;display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left}
    .r-proposal-rail-toggle{cursor:pointer}
    .r-proposal-rail-toggle span,.r-proposal-rail-heading span{display:flex;flex-direction:column;gap:4px;min-width:0}
    .r-proposal-rail-toggle strong,.r-proposal-rail-heading strong{font-size:12px;font-weight:1000;color:#111827}
    .r-proposal-rail-toggle small,.r-proposal-rail-heading small{font-size:11px;font-weight:800;color:#667085;line-height:1.35}
    .r-proposal-rail-title{display:flex!important;flex-direction:row!important;align-items:baseline!important;gap:0!important;min-width:0;font-size:11px;font-weight:1000;color:#667085;letter-spacing:.08em;text-transform:uppercase}
    .r-proposal-rail-title strong{font-size:11px!important;font-weight:1000!important;color:#667085!important;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
    .r-proposal-rail-title small{min-width:0;font-size:11px!important;font-weight:800!important;color:#667085!important;letter-spacing:0;text-transform:none;font-style:italic;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-proposal-rail-toggle i{color:#667085;transition:transform .18s ease}
    .r-proposal-rail-section.expanded>.r-proposal-rail-toggle i{transform:rotate(180deg)}
    .r-proposal-rail-body{display:flex;flex-direction:column;gap:12px}
    .r-proposal-rail-section.collapsed>.r-proposal-rail-body{display:none}
    .r-proposal-rail-section.pages-section{flex:0 0 auto;min-height:0}
    .r-proposal-rail-section.r-proposal-agent-section:not(.has-mounted),
    .r-proposal-rail-section.r-proposal-notes-section:not(.has-mounted){display:none}
    .r-proposal-rail-mount .r-proposal-agent,
    .r-proposal-rail-mount .r-bottom-notes{border-bottom:0!important;padding-bottom:0!important;margin:0}
    .r-proposal-rail-mount .r-proposal-agent-head,
    .r-proposal-rail-mount .r-bottom-notes-head{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer}
    .r-proposal-rail-mount .r-proposal-agent-title,
    .r-proposal-rail-mount .r-bottom-notes-head label{display:flex!important;align-items:baseline!important;gap:7px!important;min-width:0;font-size:11px!important;font-weight:1000!important;color:#667085!important;letter-spacing:.08em!important;text-transform:uppercase!important;cursor:pointer}
    .r-proposal-rail-mount .r-proposal-agent-title i{display:none!important}
    .r-proposal-rail-mount .r-proposal-agent-toggle,
    .r-proposal-rail-mount .r-bottom-notes-toggle{border:0!important;background:transparent!important;color:#667085!important;border-radius:0!important;width:auto!important;height:auto!important;display:flex!important;padding:0!important;box-shadow:none!important}
    .r-proposal-rail-mount .r-proposal-agent-toggle:hover,
    .r-proposal-rail-mount .r-bottom-notes-toggle:hover{color:#111827!important;border-color:transparent!important;background:transparent!important}
    .r-proposal-scope-summary{display:flex;flex-direction:column;gap:7px}
    .r-proposal-scope-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:10px;align-items:center;border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#fff;padding:8px 9px}
    .r-proposal-scope-row span{min-width:0;font-size:10px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-proposal-scope-row strong{min-width:0;font-size:11px;font-weight:1000;color:#111827;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .r-proposal-scope-empty{border:1px dashed rgba(15,23,42,.14);border-radius:12px;background:rgba(248,250,252,.72);padding:10px;font-size:11px;font-weight:850;color:#667085;line-height:1.35}
    .r-proposal-template-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .r-proposal-template-card{position:relative;border:1px solid rgba(15,23,42,.1);background:#fff;border-radius:14px;padding:10px;text-align:left;cursor:pointer;display:flex;flex-direction:column;justify-content:center;gap:5px;min-height:54px;transition:.16s ease}
    .r-proposal-template-card:hover{transform:translateY(-1px);border-color:rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 12px 22px rgba(15,23,42,.08)}
    .r-proposal-template-card.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.12)}
    .r-proposal-template-card strong{font-size:11px;font-weight:1000;color:#111827;line-height:1.15}
    .r-proposal-template-card span{position:absolute;left:8px;right:8px;top:calc(100% + 6px);z-index:6;display:block;padding:8px 9px;border:1px solid rgba(15,23,42,.08);border-radius:12px;background:rgba(255,255,255,.98);box-shadow:0 12px 22px rgba(15,23,42,.12);font-size:10px;font-weight:800;color:#667085;line-height:1.25;opacity:0;transform:translateY(-4px);pointer-events:none;transition:.16s ease}
    .r-proposal-template-card:hover span,.r-proposal-template-card:focus-visible span{opacity:1;transform:translateY(0)}
    .r-proposal-template-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .r-proposal-template-action{border:1px solid rgba(15,23,42,.1);background:#f8fafc;color:#344054;border-radius:12px;padding:9px 10px;font-size:11px;font-weight:1000;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px}
    .r-proposal-template-action:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);color:var(--primary-readable,var(--primary,#d93025));background:#fff}
    .r-proposal-template-modal{position:fixed;inset:0;background:rgba(15,23,42,.34);z-index:2147483400;display:flex;align-items:center;justify-content:center;padding:20px}
    .r-proposal-template-dialog{width:min(720px,calc(100vw - 32px));max-height:84vh;overflow:hidden;border-radius:22px;background:#fff;box-shadow:0 28px 68px rgba(15,23,42,.28);display:flex;flex-direction:column}
    .r-proposal-template-dialog.small{width:min(480px,calc(100vw - 32px))}
    .r-proposal-template-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px 18px 12px;border-bottom:1px solid rgba(15,23,42,.08)}
    .r-proposal-template-head strong{display:block;font-size:16px;font-weight:1000;color:#111827}
    .r-proposal-template-head span{display:block;margin-top:3px;font-size:12px;font-weight:800;color:#667085}
    .r-proposal-template-close{width:36px;height:36px;border-radius:12px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;cursor:pointer}
    .r-proposal-template-body{padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:10px}
    .r-proposal-template-list-item{border:1px solid rgba(15,23,42,.08);background:#fff;border-radius:16px;padding:13px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;text-align:left}
    .r-proposal-template-list-item:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);box-shadow:0 12px 22px rgba(15,23,42,.07)}
    .r-proposal-template-list-item strong{display:block;font-size:13px;font-weight:1000;color:#111827}
    .r-proposal-template-list-item p{margin:4px 0 0;font-size:12px;font-weight:750;color:#667085;line-height:1.35}
    .r-proposal-template-meta{margin-top:7px;font-size:11px;font-weight:850;color:#98a2b3}
    .r-proposal-template-use{border:0;border-radius:12px;background:var(--primary-readable,var(--primary,#d93025));color:#fff;padding:10px 13px;font-size:11px;font-weight:1000;cursor:pointer}
    .r-proposal-template-form{display:flex;flex-direction:column;gap:12px;padding:16px 18px 0}
    .r-proposal-template-form label{display:flex;flex-direction:column;gap:6px;font-size:11px;font-weight:1000;color:#667085;text-transform:uppercase;letter-spacing:.04em}
    .r-proposal-template-form input,.r-proposal-template-form textarea{border:1px solid rgba(15,23,42,.14);border-radius:12px;padding:11px 12px;font:inherit;font-size:13px;font-weight:800;color:#111827;outline:none;text-transform:none;letter-spacing:0}
    .r-proposal-template-form textarea{min-height:82px;resize:vertical}
    .r-proposal-template-error{min-height:16px;font-size:12px;font-weight:900;color:#b42318}
    .r-proposal-template-footer{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px 18px}
    .r-proposal-template-footer button{border:1px solid rgba(15,23,42,.1);border-radius:12px;background:#fff;color:#344054;padding:10px 13px;font-size:12px;font-weight:1000;cursor:pointer}
    .r-proposal-template-footer .primary{border-color:var(--primary-readable,var(--primary,#d93025));background:var(--primary-readable,var(--primary,#d93025));color:#fff}
    .r-proposal-pricebook-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 12px;border-radius:12px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#344054;font-size:11px;font-weight:1000;cursor:pointer}
    .r-proposal-pricebook-btn:hover{border-color:rgba(var(--primary-rgb,217,48,37),.26);color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-measurements{border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#fff;padding:14px;display:flex;flex-direction:column;gap:12px}
    .r-proposal-measure-toggle{border:0;background:transparent;padding:0;display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;cursor:pointer}
    .r-proposal-measure-title{display:flex;flex-direction:column;gap:4px}
    .r-proposal-measure-title strong{font-size:12px;font-weight:1000;color:#111827}
    .r-proposal-measure-toggle i{color:#667085;transition:transform .18s ease}
    .r-proposal-measurements.expanded .r-proposal-measure-toggle i{transform:rotate(180deg)}
    .r-proposal-measure-status{font-size:11px;font-weight:850;color:#667085;line-height:1.35}
    .r-proposal-measure-status.needed{color:#b42318}
    .r-proposal-measure-details{display:none;flex-direction:column;gap:12px}
    .r-proposal-measurements.expanded .r-proposal-measure-details{display:flex}
    .r-proposal-rail-section.r-proposal-measurements{border-left:0;border-right:0;border-top:0;border-radius:0;background:transparent;padding:0 0 14px}
    .r-proposal-rail-section.r-proposal-measurements .r-proposal-measure-details{display:flex}
    .r-proposal-rail-section.r-proposal-measurements.collapsed .r-proposal-measure-details{display:none}
    .r-proposal-measure-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .r-proposal-measure-group{display:flex;flex-direction:column;gap:6px}
    .r-proposal-measure-group label{font-size:10px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase;color:#667085}
    .r-proposal-measure-group input{width:100%;padding:10px 12px;border-radius:12px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#111827;font-size:12px;font-weight:900;outline:none;transition:border-color .18s ease,box-shadow .22s ease,background .18s ease,transform .18s ease}
    .r-proposal-measure-group input:hover{border-color:rgba(15,23,42,.2);background:#fcfcfd}
    .r-proposal-measure-group input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.4);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12);background:#fff}
    .r-proposal-measure-group input[readonly]{background:#f8fafc;color:#475467}
    .r-proposal-measure-group.span-2{grid-column:span 2}
    .r-proposal-measure-strip{display:flex;align-items:center;justify-content:space-between;gap:12px;transition:opacity .2s ease,transform .22s cubic-bezier(.22,1,.36,1)}
    .r-proposal-measure-strip strong{font-size:10px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase;color:#667085}
    .r-proposal-measure-strip span{font-size:13px;font-weight:1000;color:#111827;white-space:nowrap}
    .r-proposal-pitch-table{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;align-items:end;width:100%}
    .r-proposal-pitch-head{font-size:10px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase;color:#667085;text-align:center}
    .r-proposal-pitch-cell{display:flex;flex-direction:column;gap:6px}
    .r-proposal-pitch-cell input{width:100%;padding:10px 10px;border-radius:12px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#111827;font-size:12px;font-weight:900;outline:none;text-align:center;transition:border-color .18s ease,box-shadow .22s ease,background .18s ease,transform .18s ease}
    .r-proposal-pitch-cell input:hover{border-color:rgba(15,23,42,.2);background:#fcfcfd}
    .r-proposal-pitch-cell input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.4);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12);background:#fff}
    .r-proposal-style-row{display:grid;grid-template-columns:repeat(3,76px);gap:10px;align-items:center}
    .r-proposal-style-btn{position:relative;height:64px;border:1px solid rgba(15,23,42,.12);border-radius:15px;background:#fff;cursor:pointer;padding:0;overflow:hidden;transition:.16s ease}
    .r-proposal-style-btn:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(15,23,42,.08)}
    .r-proposal-style-btn.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.12)}
    .r-proposal-style-mini{position:absolute;inset:7px;border-radius:10px;border:1px solid rgba(15,23,42,.08);background:#fff;overflow:hidden}
    .r-proposal-style-mini::before,.r-proposal-style-mini::after{content:'';position:absolute}
    .r-proposal-style-mini.margin::before{inset:0 auto 0 0;width:28%;background:var(--primary,#d93025)}
    .r-proposal-style-mini.margin::after{inset:0 auto 0 28%;width:8%;background:var(--accent,#f3b5b0)}
    .r-proposal-style-mini.triangles::before{top:0;left:0;width:56%;height:56%;background:linear-gradient(135deg,var(--primary,#d93025) 0 65%,transparent 66%)}
    .r-proposal-style-mini.triangles::after{top:0;left:0;width:72%;height:72%;background:linear-gradient(135deg,var(--accent-soft,rgba(217,48,37,.28)) 0 65%,transparent 66%)}
    .r-proposal-style-mini.triangles .mini-corner{position:absolute;right:0;bottom:0;width:34%;height:34%;background:linear-gradient(315deg,var(--primary,#d93025) 0 65%,transparent 66%)}
    .r-proposal-style-mini.clean::before{inset:0 0 auto 0;height:20%;background:#f8fafc;border-bottom:1px solid rgba(15,23,42,.08)}
    .r-proposal-style-mini.clean::after{top:8%;right:10%;width:18%;height:7%;border-radius:999px;background:rgba(var(--primary-rgb,217,48,37),.16)}
    .r-proposal-style-mini .mini-lines{position:absolute;left:16%;right:14%;top:30%;bottom:16%;display:flex;flex-direction:column;gap:7px}
    .r-proposal-style-mini.margin .mini-lines{left:42%}
    .r-proposal-style-mini .mini-lines span{display:block;height:6px;border-radius:999px;background:rgba(15,23,42,.1)}
    .r-proposal-style-mini .mini-lines span.short{width:58%}
    .r-proposal-color-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .r-proposal-color-field{display:flex;align-items:center;justify-content:space-between;gap:9px;border:1px solid rgba(15,23,42,.1);background:#fff;border-radius:13px;padding:8px 9px}
    .r-proposal-color-field span{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
    .r-proposal-color-field input{appearance:none;width:32px;height:28px;border:0;background:transparent;padding:0;cursor:pointer}
    .r-proposal-color-field input::-webkit-color-swatch-wrapper{padding:0}
    .r-proposal-color-field input::-webkit-color-swatch{border:1px solid rgba(15,23,42,.12);border-radius:9px}
    .r-proposal-type-paper-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}
    .r-proposal-font-field{display:flex;min-width:0;flex-direction:column;gap:6px;border:1px solid rgba(15,23,42,.1);background:#fff;border-radius:13px;padding:9px}
    .r-proposal-font-field span{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
    .r-proposal-font-field select{width:100%;min-width:0;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#f8fafc;color:#111827;padding:0 9px;font:inherit;font-size:12px;font-weight:900;outline:none;text-overflow:ellipsis}
    .r-proposal-pages-list{display:flex;flex-direction:column;gap:4px;flex:0 0 auto;min-height:0}
    .r-proposal-list-insert{display:flex;justify-content:center;align-items:center;height:0;position:relative;z-index:3;margin:-4px 0}
    .r-proposal-list-insert-btn{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:19px;height:19px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.38);color:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:none;transition:all .22s cubic-bezier(.22,1,.36,1)}
    .r-proposal-list-insert-btn:hover{width:32px;height:32px;background:#fff;color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.24);box-shadow:0 11px 20px rgba(15,23,42,.11)}
    .r-proposal-page-item{width:100%;border:1px solid rgba(15,23,42,.08);border-radius:15px;background:#fff;padding:8px 10px;display:flex;align-items:center;gap:9px;cursor:pointer;transition:.16s ease;text-align:left}
    .r-proposal-page-item:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(15,23,42,.08)}
    .r-proposal-page-item.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.12)}
    .r-proposal-page-item.dragging{opacity:.5}
    .r-proposal-page-item.disabled{opacity:.48;background:#f8fafc}
    .r-proposal-page-item.disabled .r-proposal-page-copy strong,
    .r-proposal-page-item.disabled .r-proposal-page-copy span{color:#98a2b3}
    .r-proposal-page-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .r-proposal-page-enable{border:1px solid rgba(15,23,42,.12);background:#fff;color:var(--primary-readable,var(--primary,#d93025));width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease}
    .r-proposal-page-enable:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 8px 16px rgba(15,23,42,.08)}
    .r-proposal-page-enable.off{color:transparent;background:#eef2f6;border-color:rgba(15,23,42,.14);box-shadow:inset 0 0 0 2px #fff}
    .r-proposal-page-enable.off:hover{color:#98a2b3}
    .r-proposal-page-delete{border:1px solid rgba(15,23,42,.08);background:#fff;color:#98a2b3;width:28px;height:28px;border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease}
    .r-proposal-page-delete:hover{color:#b42318;border-color:rgba(180,35,24,.18);background:#fff5f5}
    .r-proposal-page-delete.confirm{width:auto;padding:0 12px;background:#b42318;border-color:#b42318;color:#fff;font-size:11px;font-weight:1000;letter-spacing:.02em}
    .r-proposal-page-delete.confirm:hover{background:#981b1b;border-color:#981b1b}
    .r-proposal-page-chip{width:28px;height:36px;border-radius:9px;border:1px solid rgba(15,23,42,.12);background:#f8fafc;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:1000;color:#667085;flex-shrink:0}
    .r-proposal-page-copy{min-width:0;flex:1}
    .r-proposal-page-copy strong{display:block;font-size:11px;font-weight:1000;color:#111827}
    .r-proposal-page-copy span{display:block;font-size:10px;font-weight:800;color:#667085;margin-top:2px}
    .r-proposal-drag{color:#98a2b3;font-size:12px;flex-shrink:0}
    .r-proposal-card{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#f8fafc;padding:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;transition:.16s ease}
    .r-proposal-card:hover{transform:translateY(-1px);box-shadow:0 12px 22px rgba(15,23,42,.08)}
    .r-proposal-card.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.12)}
    .r-proposal-card strong{display:block;font-size:12px;font-weight:1000;color:#111827}
    .r-proposal-card span{display:block;font-size:11px;font-weight:800;color:#667085;margin-top:2px}
    .r-proposal-editable{position:relative;display:block;width:100%;min-width:0;border:1px dashed rgba(15,23,42,.14);border-radius:10px;padding:2px 4px;margin:-2px -4px;background:rgba(15,23,42,.015);color:inherit;box-sizing:border-box;white-space:pre-wrap;transition:border-color .22s ease,background-color .22s ease,box-shadow .22s ease,transform .22s ease}
    .r-proposal-editable.is-preview{border-color:transparent;background:transparent;box-shadow:none;transform:none;pointer-events:none;caret-color:transparent}
    .r-proposal-editable[contenteditable="true"]{cursor:text}
    .r-proposal-editable[data-proposal-type="currency"]:not(.is-preview){padding-left:14px}
    .r-proposal-editable[data-proposal-type="currency"]:not(.is-preview)::before{content:"$";position:absolute;left:4px;top:50%;transform:translateY(-50%);font-weight:inherit;color:#667085;pointer-events:none;user-select:none}
    .r-proposal-editable[contenteditable="true"]:hover{border-color:rgba(15,23,42,.28);background:rgba(15,23,42,.03);box-shadow:0 0 0 1px rgba(255,255,255,.72);transform:scale(1.01)}
    .r-proposal-editable[contenteditable="true"]:focus{outline:none}
    .r-proposal-editable[contenteditable="true"].is-keyboard-focus,
    .r-proposal-editable[contenteditable="true"]:focus-visible{border-color:var(--accent-readable,var(--accent,#b42318));background:#fff;box-shadow:0 0 0 5px rgba(var(--accent-rgb,180,35,24),.12);transform:scale(1.014)}
    .r-proposal-editable.is-derived{border-style:solid;border-color:rgba(217,48,37,.08);background:rgba(217,48,37,.035);color:#7a271a;cursor:default}
    .r-proposal-editable.is-derived:hover,.r-proposal-editable.is-derived:focus{transform:none;box-shadow:none;border-color:rgba(217,48,37,.12);background:rgba(217,48,37,.04)}
    .r-proposal-editable.is-derived.is-preview{border-color:transparent;background:transparent;box-shadow:none;color:inherit}
    .r-proposal-edit-heading{font-size:28px;font-weight:1000;letter-spacing:-.02em;line-height:1.05;color:#111827}
    .r-proposal-edit-subheading{font-size:13px;line-height:1.6;color:#475467}
    .r-proposal-edit-meta{font-size:14px;font-weight:900;line-height:1.35;color:#111827;display:inline-block;width:fit-content;min-width:0;max-width:100%;white-space:nowrap}
    .r-proposal-edit-meta.multiline{display:block;width:100%;white-space:pre-line;line-height:1.45}
    .r-proposal-edit-paragraph{font-size:13px;line-height:1.6;color:#475467;white-space:pre-wrap}
    .r-proposal-editable[data-proposal-placeholder]:empty::before{content:attr(data-proposal-placeholder);color:#98a2b3;pointer-events:none}
    .r-proposal-editable.is-rich{display:block;text-align:var(--proposal-text-align,left);color:var(--proposal-text-color,inherit);padding:10px 12px;min-height:88px;width:100%}
    .r-proposal-editable.is-rich.is-preview{padding:10px 12px}
    .r-proposal-editable.is-rich > *:first-child{margin-top:0}
    .r-proposal-editable.is-rich > *:last-child{margin-bottom:0}
    .r-proposal-editable.is-rich[data-text-align="center"]{--proposal-text-align:center}
    .r-proposal-editable.is-rich[data-text-align="right"]{--proposal-text-align:right}
    .r-proposal-editable.is-rich[data-text-align="justify"]{--proposal-text-align:justify}
    .r-proposal-editable.is-rich[data-v-align="top"]{--proposal-v-align:flex-start}
    .r-proposal-editable.is-rich[data-v-align="center"]{--proposal-v-align:center}
    .r-proposal-editable.is-rich[data-v-align="bottom"]{--proposal-v-align:flex-end}
    .r-proposal-rich-toolbar{position:fixed;display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid rgba(15,23,42,.08);border-radius:999px;background:rgba(255,255,255,.96);box-shadow:0 14px 24px rgba(15,23,42,.14);opacity:0;pointer-events:none;transition:opacity .18s ease,transform .2s ease;z-index:4210}
    .r-proposal-rich-toolbar.visible{opacity:1;pointer-events:auto;transform:translate(-50%,0)}
    .r-proposal-rich-toolbar .group{display:flex;align-items:center;gap:4px}
    .r-proposal-rich-btn{width:28px;height:28px;border:1px solid rgba(15,23,42,.08);border-radius:999px;background:#fff;color:#475467;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:11px;transition:.16s ease}
    .r-proposal-rich-btn:hover,.r-proposal-rich-btn.active{border-color:rgba(var(--accent-rgb,180,35,24),.32);color:var(--accent-readable,var(--accent,#b42318));background:rgba(var(--accent-rgb,180,35,24),.08)}
    .r-proposal-rich-color{position:relative;width:28px;height:28px;border-radius:999px;overflow:hidden;border:1px solid rgba(15,23,42,.08);background:#fff}
    .r-proposal-rich-color input{position:absolute;inset:-6px;opacity:0;cursor:pointer}
    .r-proposal-rich-color span{position:absolute;inset:6px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:var(--swatch,#111111)}
    .r-proposal-edit-rowvalue{font-size:13px;line-height:1.5;color:#344054;text-align:right;display:inline-block;width:fit-content;min-width:0;max-width:100%;white-space:nowrap}
    .r-proposal-edit-percent{font-size:13px;line-height:1.5;color:#344054;text-align:right;display:inline-block;width:fit-content;min-width:34px;max-width:100%;white-space:nowrap}
    .r-proposal-edit-total{font-size:24px;font-weight:1000;line-height:1.1;color:#111827;text-align:right;max-width:220px}
    .r-proposal-row-value{display:flex;justify-content:flex-end;align-items:flex-start;text-align:right;min-width:0}
    .r-proposal-row-value .r-proposal-editable{width:auto;max-width:100%;min-width:0}
    .r-proposal-row-value.quantity-cell .r-proposal-edit-rowvalue{min-width:52px}
    .r-proposal-row-value.unit-cell .r-proposal-edit-rowvalue{min-width:82px}
    .r-proposal-row-value.amount-cell .r-proposal-edit-rowvalue{min-width:96px}
    .r-proposal-row-value .r-proposal-editable.is-rich,
    .r-proposal-edit-paragraph.r-proposal-editable{width:100%}
    .r-proposal-edit-meta.r-proposal-editable,
    .r-proposal-edit-rowvalue.r-proposal-editable{white-space:nowrap;overflow-wrap:normal;word-break:normal}
    .r-proposal-edit-meta.multiline.r-proposal-editable{white-space:pre-line;overflow-wrap:anywhere}
    .r-proposal-contact-grid{display:flex;flex-direction:column;gap:10px}
    .r-proposal-contact-row{padding:12px 0;border-bottom:1px solid rgba(15,23,42,.08)}
    .r-proposal-contact-row:last-child{border-bottom:0}
    .r-proposal-contact-name{display:block;font-size:12px;font-weight:1000;color:#111827}
    .r-proposal-contact-copy{display:block;font-size:13px;line-height:1.6;color:#475467}
    .r-proposal-line-items{display:flex;flex-direction:column;gap:0}
    .r-proposal-line-item{position:relative;display:grid;grid-template-columns:minmax(0,1.5fr) 86px 78px 104px 112px;gap:9px;align-items:center;padding:8px 0 8px calc(var(--proposal-depth,0) * 18px);border-bottom:0;background:linear-gradient(to right,transparent 0 calc(var(--proposal-depth,0) * 18px),rgba(15,23,42,.08) calc(var(--proposal-depth,0) * 18px) 100%) left bottom/100% 1px no-repeat;overflow:visible}
    .r-proposal-line-item::before{content:'';position:absolute;left:-42px;top:0;bottom:0;width:42px}
    .r-proposal-line-item:last-child{border-bottom:0}
    .r-proposal-line-item.depth-1{grid-template-columns:minmax(0,1.5fr) 86px 78px 104px 112px}
    .r-proposal-line-item.is-category{grid-template-columns:minmax(0,1fr) 120px;padding-top:12px;padding-bottom:10px;background-image:linear-gradient(to right,transparent 0 calc(var(--proposal-depth,0) * 18px),rgba(15,23,42,.14) calc(var(--proposal-depth,0) * 18px) 100%)}
    .r-proposal-line-item.is-category .r-proposal-line-label{font-size:14px;font-weight:1000;color:#111827}
    .r-proposal-line-item.is-category .r-proposal-row-value{font-weight:1000;color:#111827}
    .r-proposal-line-item.is-category .r-proposal-variation-cell,.r-proposal-line-item.is-category .r-proposal-row-value.quantity-cell,.r-proposal-line-item.is-category .r-proposal-row-value.unit-cell{display:none}
    .r-proposal-line-item.is-category .r-proposal-line-description{max-width:none}
    .r-proposal-line-item.is-included .r-proposal-line-label{color:#475467}
    .r-proposal-line-item.is-disabled{opacity:1;filter:none}
    .r-proposal-line-item.is-disabled > :not(.r-proposal-line-more-wrap):not(.r-proposal-line-delete){opacity:.48;filter:grayscale(.75)}
    .r-proposal-line-item.is-disabled::after{content:'';position:absolute;inset:5px -3px;border-radius:8px;background:rgba(248,250,252,.55);pointer-events:none;z-index:-1}
    .r-proposal-line-item.is-menu-open{z-index:3000}
    .r-proposal-line-item.is-discount .r-proposal-line-label,.r-proposal-line-item.is-discount .r-proposal-row-value{color:#137a3a}
    .r-proposal-line-labelwrap{display:flex;flex-direction:column;gap:4px;min-width:0}
    .r-proposal-line-labelrow{display:flex;align-items:center;gap:6px;min-width:0}
    .r-proposal-line-label{font-size:12.5px;line-height:1.35;color:#344054}
    .r-proposal-line-labelrow .r-proposal-line-label{min-width:0;flex:1 1 auto}
    .r-proposal-line-description{font-size:11px;line-height:1.35;color:#667085;padding-left:10px;border-left:2px solid rgba(15,23,42,.1);min-height:15px}
    .r-proposal-line-meta{font-size:10px;font-weight:900;letter-spacing:.03em;color:#667085;text-transform:uppercase}
    .r-proposal-included-badge{font-size:11px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase;color:#667085}
    .r-proposal-variation-cell{position:relative;display:flex;justify-content:flex-start;min-width:0;z-index:24}
    .r-proposal-variation-pill{max-width:100%;min-width:72px;min-height:24px;border:1px solid rgba(15,23,42,.1);border-radius:999px;background:#f8fafc;color:#475467;padding:4px 7px;font-size:10.5px;font-weight:950;display:inline-flex;align-items:center;gap:5px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    button.r-proposal-variation-pill{cursor:pointer}
    button.r-proposal-variation-pill:hover,.r-proposal-variation-cell.open .r-proposal-variation-pill{border-color:rgba(var(--primary-rgb,217,48,37),.26);background:rgba(var(--primary-rgb,217,48,37),.06);color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-variation-pill span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .r-proposal-variation-pill.locked{background:transparent;border-color:transparent;padding-left:0;color:#667085}
    .r-proposal-variation-swatch{width:11px;height:11px;border-radius:999px;background:var(--variation-color,#94a3b8);border:1px solid rgba(15,23,42,.14);display:inline-block;flex:0 0 auto}
    .r-proposal-variation-menu{position:absolute;left:0;top:calc(100% + 5px);width:168px;border:1px solid rgba(15,23,42,.12);border-radius:13px;background:#fff;box-shadow:0 18px 42px rgba(15,23,42,.18);padding:6px;z-index:3004;display:flex;flex-direction:column;gap:2px}
    .r-proposal-variation-menu button{border:0;background:transparent;border-radius:9px;padding:8px 9px;display:grid;grid-template-columns:16px minmax(0,1fr);gap:7px;align-items:center;text-align:left;color:#344054;font-size:12px;font-weight:900;cursor:pointer}
    .r-proposal-variation-menu button span{display:inline-flex;align-items:center;gap:6px;min-width:0}
    .r-proposal-variation-menu button:hover{background:rgba(15,23,42,.055);color:#111827}
    .r-proposal-choice-grid-row{display:grid;grid-template-columns:repeat(var(--choice-cols,3),minmax(0,1fr));gap:6px;padding:6px 0 8px calc(var(--proposal-depth,0) * 18px);background:linear-gradient(to right,transparent 0 calc(var(--proposal-depth,0) * 18px),rgba(15,23,42,.06) calc(var(--proposal-depth,0) * 18px) 100%) left bottom/100% 1px no-repeat;position:relative;z-index:3}
    .r-proposal-choice-grid-row:has(.r-proposal-choice-mini:hover){z-index:3300}
    .r-proposal-choice-mini{position:relative;min-width:0;border:1px solid rgba(15,23,42,.1);border-radius:10px;background:#fff;padding:6px 7px;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;gap:2px 6px;align-items:center;color:#344054;cursor:pointer;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease,transform .16s ease}
    .r-proposal-choice-mini.has-logo,.r-proposal-choice-mini:has(> img){grid-template-columns:22px minmax(0,1fr)}
    .r-proposal-choice-mini:hover{border-color:rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 10px 20px rgba(15,23,42,.08);transform:translateY(-1px);z-index:7}
    .r-proposal-choice-mini.selected{border-color:rgba(var(--primary-rgb,217,48,37),.34);background:rgba(var(--primary-rgb,217,48,37),.055)}
    .r-proposal-choice-mini > img{width:18px;height:18px;object-fit:contain;grid-row:1 / span 2;grid-column:1}
    .r-proposal-choice-mini span{grid-column:1;min-width:0;font-size:10.5px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-proposal-choice-mini.has-logo span,.r-proposal-choice-mini:has(> img) span{grid-column:2}
    .r-proposal-choice-mini strong{grid-column:1;grid-row:2;font-size:10px;font-weight:1000;color:#111827;white-space:nowrap}
    .r-proposal-choice-mini.has-logo strong,.r-proposal-choice-mini:has(> img) strong{grid-column:2}
    .r-proposal-choice-hover{display:none;position:absolute;left:0;top:calc(100% + 8px);bottom:auto;width:220px;border:1px solid rgba(15,23,42,.12);border-radius:13px;background:#fff;box-shadow:0 18px 42px rgba(15,23,42,.18);padding:10px;z-index:3400;color:#344054}
    .r-proposal-choice-mini:hover .r-proposal-choice-hover{display:grid;gap:6px}
    .r-proposal-choice-hover img{max-width:74px;max-height:34px;object-fit:contain}
    .r-proposal-choice-hover b{font-size:12px;color:#111827}
    .r-proposal-choice-hover p{font-size:11px;line-height:1.35;color:#667085}
    .r-proposal-line-more-wrap{position:absolute;right:-34px;top:50%;transform:translateY(-50%);z-index:20}
    .r-proposal-line-more-btn{width:28px;height:28px;border:0;background:transparent;color:#667085;display:inline-flex;align-items:center;justify-content:center;font-size:15px;font-weight:1000;line-height:1;letter-spacing:1px;cursor:pointer;padding:0;transition:color .16s ease,transform .16s ease}
    .r-proposal-line-more-btn:hover,.r-proposal-line-more-btn.active{color:#111827;transform:translateY(-1px)}
    .r-proposal-line-more-btn.active{background:rgba(15,23,42,.06);border-radius:8px}
    .r-proposal-line-item.is-menu-open .r-proposal-line-more-wrap{z-index:3002}
    .r-proposal-line-more-menu{position:absolute;right:0;top:28px;width:224px;border:1px solid rgba(15,23,42,.12);border-radius:14px;background:#fff;box-shadow:0 22px 48px rgba(15,23,42,.2);padding:6px;display:flex;flex-direction:column;gap:2px;z-index:3003}
    .r-proposal-line-more-menu button{width:100%;border:0;background:transparent;border-radius:10px;padding:9px 10px;display:grid;grid-template-columns:18px minmax(0,1fr);gap:8px;align-items:center;text-align:left;color:#344054;font-size:12px;font-weight:900;cursor:pointer}
    .r-proposal-line-more-menu button:hover{background:rgba(15,23,42,.055);color:#111827}
    .r-proposal-line-more-menu button.is-muted{color:#98a2b3}
    .r-proposal-line-more-check{width:18px;height:18px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;color:var(--primary,#d93025);font-size:10px}
    .r-proposal-choice-settings-btn{flex:0 0 auto;width:24px;height:24px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#98a2b3;display:inline-flex;align-items:center;justify-content:center;font-size:10px;cursor:pointer;transition:background .16s ease,color .16s ease,border-color .16s ease,box-shadow .16s ease,transform .16s ease}
    .r-proposal-choice-settings-btn:hover{color:#344054;border-color:rgba(15,23,42,.22);box-shadow:0 6px 14px rgba(15,23,42,.1);transform:translateY(-1px)}
    .r-proposal-choice-settings-btn.active{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.34);background:rgba(var(--primary-rgb,217,48,37),.1)}
    .r-proposal-choice-backdrop{position:absolute;inset:0;z-index:2147483199;background:rgba(15,23,42,.42);backdrop-filter:grayscale(.4);border-radius:0}
    .r-proposal-choice-popover{position:absolute;z-index:2147483200;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,calc(100% - 48px));max-height:min(760px,calc(100% - 48px));overflow:hidden;border:1px solid rgba(15,23,42,.14);border-radius:16px;background:#fff;box-shadow:0 24px 60px rgba(15,23,42,.22);padding:16px;display:flex;flex-direction:column;gap:12px;min-height:0}
    .r-proposal-choice-popover-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    .r-proposal-choice-popover-head span{display:flex;flex-direction:column;gap:3px;min-width:0}
    .r-proposal-choice-popover-head strong{font-size:14px;font-weight:1000;color:#111827;line-height:1.2}
    .r-proposal-choice-popover-head em{font-style:normal;font-size:11px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
    .r-proposal-choice-close{width:28px;height:28px;border-radius:999px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
    .r-proposal-choice-help{font-size:11px;font-weight:750;color:#667085;line-height:1.35}
    .r-proposal-choice-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;overflow:auto;min-height:0;padding-right:2px}
    .r-proposal-choice-option{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;align-items:start;border:1px solid rgba(15,23,42,.1);border-radius:12px;padding:10px;background:#fff}
    .r-proposal-choice-option.selected{border-color:rgba(var(--primary-rgb,217,48,37),.3);background:rgba(var(--primary-rgb,217,48,37),.055)}
    .r-proposal-choice-option.customer-visible:not(.selected){border-color:rgba(var(--primary-rgb,217,48,37),.18);background:#fff}
    .r-proposal-choice-radio{display:flex;align-items:center;justify-content:center;margin:0}
    .r-proposal-choice-radio input{position:absolute;opacity:0;pointer-events:none}
    .r-proposal-choice-radio span{width:16px;height:16px;border-radius:999px;border:2px solid #cbd5e1;background:#fff;box-sizing:border-box}
    .r-proposal-choice-radio input:checked + span{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 4px #fff;background:var(--primary,#d93025)}
    .r-proposal-choice-fields{display:flex;flex-direction:column;gap:7px;min-width:0}
    .r-proposal-choice-name-row{display:flex;align-items:center;gap:8px;min-width:0}
    .r-proposal-choice-name-row img{width:28px;height:28px;object-fit:contain;flex:0 0 auto}
    .r-proposal-choice-group-title{display:flex;flex-direction:column;gap:4px;margin:0;font-size:10px;font-weight:1000;color:#98a2b3;text-transform:uppercase;letter-spacing:.05em}
    .r-proposal-choice-name,.r-proposal-choice-grid input,.r-proposal-choice-group-title input{width:100%;min-width:0;box-sizing:border-box;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;padding:8px 9px;font-size:12px;font-weight:850;color:#111827;outline:none}
    .r-proposal-choice-name:focus,.r-proposal-choice-grid input:focus,.r-proposal-choice-group-title input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.45);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.1)}
    .r-proposal-choice-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
    .r-proposal-choice-grid label{display:flex;flex-direction:column;gap:3px;margin:0}
    .r-proposal-choice-grid span{font-size:9px;font-weight:1000;color:#98a2b3;text-transform:uppercase;letter-spacing:.05em}
    .r-proposal-choice-customer{grid-column:2;display:inline-flex;align-items:center;gap:7px;margin:0;font-size:10px;font-weight:1000;color:#667085;white-space:nowrap;cursor:pointer;justify-self:start}
    .r-proposal-choice-customer input{position:absolute;opacity:0;pointer-events:none}
    .r-proposal-choice-switch{position:relative;width:32px;height:18px;border-radius:999px;background:#cbd5e1;transition:background .16s ease,box-shadow .16s ease;flex:0 0 auto}
    .r-proposal-choice-switch::after{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.22);transition:transform .16s ease}
    .r-proposal-choice-customer input:checked + .r-proposal-choice-switch{background:var(--primary,#d93025)}
    .r-proposal-choice-customer input:checked + .r-proposal-choice-switch::after{transform:translateX(14px)}
    .r-proposal-choice-customer input:disabled + .r-proposal-choice-switch{opacity:.72}
    .r-proposal-choice-customer em{font-style:normal}
    .r-proposal-choice-remove{grid-column:2;border:0;background:transparent;color:#b42318;display:inline-flex;align-items:center;justify-content:flex-start;gap:6px;cursor:pointer;font-size:10px;font-weight:1000;padding:0;justify-self:start}
    .r-proposal-choice-remove:hover{text-decoration:underline}
    .r-proposal-choice-popover-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid rgba(15,23,42,.08);padding-top:12px;flex:0 0 auto}
    .r-proposal-choice-add,.r-proposal-choice-save{border-radius:999px;border:1px solid rgba(15,23,42,.12);padding:9px 12px;font-size:12px;font-weight:950;cursor:pointer}
    .r-proposal-choice-add{background:#fff;color:#344054}
    .r-proposal-choice-save{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
    @media(max-width:760px){.r-proposal-choice-options{grid-template-columns:1fr}.r-proposal-choice-popover{width:min(560px,calc(100% - 28px));max-height:calc(100% - 28px)}}
    .r-proposal-line-delete{position:absolute;left:-34px;top:50%;transform:translateY(-50%) scale(.92);width:22px;height:22px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.94);color:#98a2b3;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease,color .18s ease,border-color .18s ease,background .18s ease;z-index:2}
    .r-proposal-line-item:hover .r-proposal-line-delete,.r-proposal-line-item:focus-within .r-proposal-line-delete{opacity:1;pointer-events:auto;transform:translateY(-50%) scale(1)}
    .r-proposal-line-delete:hover{color:#b42318;border-color:rgba(180,35,24,.24);background:#fff}
    .r-proposal-discount-mode{display:inline-flex;align-items:center;border:1px solid rgba(22,163,74,.2);border-radius:999px;background:#f0fdf4;padding:2px;gap:2px}
    .r-proposal-discount-mode button{width:24px;height:22px;border:0;border-radius:999px;background:transparent;color:#15803d;font-size:11px;font-weight:1000;cursor:pointer}
    .r-proposal-discount-mode button.active{background:#16a34a;color:#fff}
    .r-proposal-discount-value,.r-proposal-discount-amount{color:#137a3a!important;font-weight:1000}
    .r-proposal-addrow-bar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:center;margin-top:10px}
    .r-proposal-addrow{display:flex;align-items:center;justify-content:center;gap:7px;min-width:0;padding:10px 12px;border:1px dashed rgba(15,23,42,.16);border-radius:12px;color:#667085;background:rgba(15,23,42,.02);cursor:pointer;transition:.16s ease;font-size:12px;font-weight:1000;white-space:nowrap}
    .r-proposal-addrow:hover{border-color:rgba(217,48,37,.26);background:rgba(217,48,37,.035);color:#b42318}
    .r-proposal-add-discount{border-color:rgba(22,163,74,.22);background:#f0fdf4;color:#137a3a}
    .r-proposal-add-discount:hover{border-color:rgba(22,163,74,.34);background:#dcfce7;color:#166534}
    .r-proposal-addrow span:first-child{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:0;white-space:nowrap;font-weight:1000}
    .r-proposal-section-actions{display:flex;flex-wrap:wrap;gap:6px;margin:3px 0 5px 0;padding-left:calc(var(--proposal-depth,0) * 18px);position:relative;z-index:1}
    .r-proposal-section-actions button{border:1px dashed rgba(15,23,42,.14);border-radius:10px;background:rgba(248,250,252,.72);color:#667085;padding:5px 8px;font-size:10.5px;font-weight:1000;display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;line-height:1.1}
    .r-proposal-section-actions button:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.045);color:var(--primary-readable,var(--primary,#d93025))}
    .r-builder-discount-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .r-builder-discount-actions button{border:1px solid rgba(22,163,74,.18);background:#f0fdf4;color:#137a3a;border-radius:14px;padding:11px 12px;font-size:12px;font-weight:1000;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer}
    .r-builder-discount-actions button:hover{background:#dcfce7;border-color:rgba(22,163,74,.34)}
    .r-builder-discount-list{display:flex;flex-direction:column;gap:9px}
    .r-builder-discount-row{display:grid;grid-template-columns:minmax(0,1fr) auto 90px 120px 30px;gap:8px;align-items:center;border:1px solid rgba(22,163,74,.16);background:#f7fef9;border-radius:14px;padding:10px}
    .r-builder-discount-row input{width:100%;box-sizing:border-box;border:1px solid rgba(22,163,74,.16);border-radius:10px;background:#fff;padding:8px 9px;font-size:12px;font-weight:850;color:#14532d;outline:none}
    .r-builder-discount-row strong{font-size:12px;font-weight:1000;color:#137a3a;text-align:right;white-space:nowrap}
    .r-builder-discount-row > button{width:28px;height:28px;border-radius:999px;border:1px solid rgba(22,163,74,.14);background:#fff;color:#15803d;display:flex;align-items:center;justify-content:center;cursor:pointer}
    .r-builder-discount-empty{border:1px dashed rgba(22,163,74,.2);background:#f7fef9;color:#15803d;border-radius:14px;padding:14px;font-size:12px;font-weight:900;text-align:center}
    .r-proposal-signature-stack{display:flex;flex-direction:column;gap:18px}
    .r-proposal-signature-intro{font-size:13px;line-height:1.6;color:#475467}
    .r-proposal-signature-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(240px,.85fr);gap:18px;align-items:start}
    .r-proposal-signature-left,.r-proposal-signature-right{display:flex;flex-direction:column;gap:12px}
    .r-proposal-signature-group{display:flex;flex-direction:column;gap:8px}
    .r-proposal-signature-group + .r-proposal-signature-group{margin-top:8px}
    .r-proposal-signature-box{position:relative;border:0;border-radius:0;background:transparent;padding:0 0 8px;min-height:118px;display:flex;flex-direction:column;justify-content:flex-start;gap:6px}
    .r-proposal-signature-box.compact{min-height:94px}
    .r-proposal-signature-box strong{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .r-proposal-signature-line{height:1px;width:66%;background:rgba(15,23,42,.18)}
    .r-proposal-signature-value{font-size:14px;font-weight:800;color:#111827;line-height:1.35;min-height:58px;margin-top:auto;display:flex;align-items:flex-end}
    .r-proposal-signature-box.is-signing{cursor:pointer;transition:.18s ease}
    .r-proposal-signature-box.is-signing:hover{transform:translateY(-1px)}
    .r-proposal-signature-box.signed{background:transparent}
    .r-proposal-signature-box.signed .r-proposal-signature-line{background:rgba(15,23,42,.28)}
    .r-proposal-signature-tab{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;padding:6px 10px;border-radius:12px;border:1px dashed rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.04);color:var(--primary-readable,var(--primary,#d93025));font-size:10px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase}
    .r-proposal-signature-tab.done{border-color:rgba(21,128,61,.18);color:#15803d}
    .r-proposal-signature-autofill{font-size:12px;line-height:1.55;color:#475467;min-height:18px}
    .r-proposal-signature-script{display:block;min-height:30px;font-size:28px;font-weight:400;line-height:1;color:#111827}
    .r-proposal-signature-script.style-classic{font-family:"Brush Script MT","Segoe Script","Lucida Handwriting",cursive}
    .r-proposal-signature-script.style-elegant{font-family:"Snell Roundhand","Segoe Script","Lucida Handwriting",cursive}
    .r-proposal-signature-script.style-modern{font-family:"Segoe Print","Comic Sans MS",cursive}
    .r-proposal-signature-script img{max-width:100%;max-height:56px;object-fit:contain}
    .r-proposal-financial-card{border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#fff;padding:18px;display:flex;flex-direction:column;gap:14px}
    .r-proposal-financial-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .r-proposal-financial-head strong{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .r-proposal-financial-rows{display:flex;flex-direction:column;gap:10px}
    .r-proposal-financial-row{display:flex;align-items:center;justify-content:space-between;gap:14px;font-size:13px;color:#475467}
    .r-proposal-financial-row.tax{display:grid;grid-template-columns:minmax(0,1fr) auto auto}
    .r-proposal-tax-rate{display:inline-flex;align-items:center;justify-content:flex-end;gap:2px;color:#344054;font-weight:800;white-space:nowrap}
    .r-proposal-tax-rate em,.r-proposal-payment-percent em{font-style:normal;color:#667085;font-size:11px;font-weight:900}
    .r-proposal-financial-row.total{padding-top:10px;border-top:1px solid rgba(15,23,42,.08);font-size:15px;font-weight:1000;color:#111827}
    .r-proposal-payment-card{border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#fff;padding:18px;display:flex;flex-direction:column;gap:12px}
    .r-proposal-payment-card.invalid{border-color:rgba(180,35,24,.34);background:rgba(180,35,24,.035)}
    .r-proposal-payment-card strong{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .r-proposal-payment-row{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:10px;align-items:center;font-size:13px;color:#475467}
    .r-proposal-payment-row.preview{grid-template-columns:minmax(0,1fr) auto}
    .r-proposal-payment-row.preview .r-proposal-payment-label{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-proposal-payment-row.preview .r-proposal-payment-amount{justify-self:end;text-align:right;white-space:nowrap;font-weight:900;color:#344054}
    .r-proposal-payment-card.invalid .r-proposal-payment-row{color:#b42318}
    .r-proposal-payment-card.invalid .r-proposal-payment-row .r-proposal-editable{border-color:rgba(180,35,24,.2);background:rgba(180,35,24,.05)}
    .r-proposal-payment-percent{display:inline-flex;align-items:center;justify-content:flex-end;gap:5px;min-width:0;font-weight:900;color:#344054}
    .r-proposal-edit-payment-label{font-size:13px;line-height:1.5;color:#475467;display:inline-block;min-width:0;max-width:100%}
    .r-proposal-payment-warning{border:1px solid rgba(180,35,24,.18);border-radius:12px;background:#fff;color:#b42318;padding:9px 10px;font-size:11px;font-weight:900;line-height:1.35}
    .r-proposal-payment-options{display:flex;flex-direction:column;gap:8px;padding-top:2px}
    .r-proposal-fineprint{position:relative;display:flex;flex-direction:column;gap:16px}
    .r-proposal-fineprint-copy{font-size:13px;line-height:1.75;color:#344054}
    .r-proposal-fineprint-toggle{position:absolute;top:12px;right:12px;display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#475467;font-size:10px;font-weight:1000;cursor:pointer;z-index:2}
    .r-proposal-fineprint-toggle i{color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-signature-options{display:flex;flex-direction:column;gap:8px;padding-top:2px}
    .r-proposal-signature-option{display:inline-flex;align-items:center;gap:8px;padding:8px 10px;border-radius:12px;border:1px solid rgba(15,23,42,.08);background:#fff;color:#475467;font-size:11px;font-weight:900;cursor:pointer;align-self:flex-start}
    .r-proposal-signature-option i{color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-page-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 8px;border-radius:999px;background:rgba(15,23,42,.06);font-size:10px;font-weight:1000;color:#667085}
    .r-proposal-full-insert{position:absolute;inset:0;z-index:1;background:#fff;overflow:hidden}
    .r-proposal-full-insert iframe,.r-proposal-full-insert img{width:100%;height:100%;border:0;display:block;background:#fff}
    .r-proposal-full-insert img{object-fit:cover}
    .r-proposal-pdf-canvas-page{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#fff;overflow:hidden}
    .r-proposal-pdf-canvas-page canvas{width:100%;height:100%;object-fit:contain;display:block;background:#fff}
    .r-proposal-full-placeholder{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:44px;text-align:center;background:linear-gradient(160deg,#f8fafc,#fff);color:#667085;box-sizing:border-box}
    .r-proposal-full-placeholder strong{font-size:24px;color:#111827}
    .r-proposal-full-placeholder span{font-size:13px;font-weight:850;line-height:1.45;max-width:320px}
    .r-proposal-full-select{position:absolute;left:18px;right:18px;bottom:18px;z-index:4;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;padding:10px;border:1px solid rgba(15,23,42,.12);border-radius:16px;background:rgba(255,255,255,.94);backdrop-filter:blur(12px);box-shadow:0 18px 36px rgba(15,23,42,.18)}
    .r-proposal-full-option{border:1px solid rgba(15,23,42,.08);border-radius:12px;background:#fff;padding:8px 9px;text-align:left;cursor:pointer;transition:.16s ease;color:#344054;min-width:0}
    .r-proposal-full-option strong{display:block;font-size:11px;font-weight:1000;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-proposal-full-option span{display:block;margin-top:2px;font-size:10px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-proposal-full-option.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-proposal-media-stack{display:flex;flex-direction:column;gap:12px}
    .r-proposal-media-block{position:relative;display:grid;grid-template-areas:'media divider copy';grid-template-rows:minmax(0,1fr);gap:0;border:1px solid rgba(15,23,42,.08);border-radius:18px;background:#fff;height:220px;max-height:420px;padding:14px 14px 24px;align-items:stretch;overflow:visible}
    .r-proposal-media-block.flip{grid-template-areas:'copy divider media'}
    .r-proposal-media-block.text-only{display:block}
    .r-proposal-media-block.text-only .r-proposal-media-text{width:100%;height:100%}
    .r-proposal-media-block.image-only{display:block}
    .r-proposal-media-block.image-only .r-proposal-media-visual{width:100%;height:100%}
    .r-proposal-media-visual{grid-area:media;min-width:0;min-height:0;height:100%;display:flex}
    .r-proposal-media-pane{border:1px dashed rgba(15,23,42,.14);border-radius:14px;background:#f8fafc;position:relative;overflow:hidden;min-height:0;height:100%;width:100%;display:flex;flex-direction:column}
    .r-proposal-media-pane.has-image{border-style:solid}
    .r-proposal-media-pane:not(.is-editable):not(.has-image){border-color:transparent;background:transparent}
    .r-proposal-media-pane.is-editable{cursor:pointer}
    .r-proposal-media-pane.is-editable::after{content:'Edit Media';position:absolute;right:10px;bottom:10px;padding:6px 9px;border-radius:999px;background:rgba(255,255,255,.9);color:#344054;font-size:10px;font-weight:1000;opacity:0;transform:translateY(4px);transition:.18s ease;pointer-events:none}
    .r-proposal-media-pane.is-editable:hover::after{opacity:1;transform:translateY(0)}
    .r-proposal-media-gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:6px;padding:6px;height:100%;flex:1 1 auto;min-height:0;box-sizing:border-box;align-content:stretch}
    .r-proposal-media-gallery.count-1{grid-template-columns:1fr;grid-template-rows:1fr}
    .r-proposal-media-gallery.count-2{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:1fr}
    .r-proposal-media-gallery.count-3,.r-proposal-media-gallery.count-4{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .r-proposal-media-gallery > :is(img,.r-proposal-video-frame,.r-proposal-media-processing){width:100%;height:100%;object-fit:cover;display:block;border-radius:10px;min-width:0;min-height:0;overflow:hidden}
    .r-proposal-media-processing{background:#eef2f6;color:#667085;display:flex!important;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;font-size:18px}
    .r-proposal-media-processing strong{font-size:11px;font-weight:1000;letter-spacing:.06em;text-transform:uppercase}
    .r-proposal-video-frame{position:relative;background:#101828;color:#fff}
    .r-proposal-video-player,.r-proposal-video-print-thumbnail{display:block;width:100%;height:100%;object-fit:cover;background:#101828}
    .r-proposal-video-print-thumbnail,.r-proposal-video-print-fallback{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#101828}
    .r-proposal-video-print-thumbnail,.r-proposal-video-print-fallback,.r-proposal-video-print-placeholder{display:none}
    .r-proposal-video-print-placeholder{width:100%;height:100%;align-items:center;justify-content:center;background:#101828;color:#fff;font-size:36px}
    .r-proposal-media-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#98a2b3;font-size:28px}
    .r-proposal-media-text{grid-area:copy;min-width:0;min-height:0;display:flex;flex-direction:column;height:100%}
    .r-proposal-media-text .r-proposal-edit-paragraph{height:100%}
    .r-proposal-media-text .r-proposal-editable.is-rich{height:100%;display:flex;flex-direction:column;justify-content:var(--proposal-v-align,center)}
    .r-proposal-media-divider{grid-area:divider;position:relative;align-self:stretch;display:flex;align-items:center;justify-content:center;min-height:0}
    .r-proposal-media-divider::before{content:'';width:2px;height:100%;border-radius:999px;background:rgba(15,23,42,.08)}
    .r-proposal-media-grab{width:14px;height:72px;border-radius:999px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 10px 18px rgba(15,23,42,.1);color:#98a2b3;display:flex;align-items:center;justify-content:center;cursor:col-resize;z-index:2}
    .r-proposal-media-grab i{transform:rotate(90deg);font-size:10px}
    .r-proposal-media-heightgrab{position:absolute;left:50%;bottom:-14px;transform:translateX(-50%);width:110px;height:28px;border-radius:999px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 10px 18px rgba(15,23,42,.1);display:flex;align-items:center;justify-content:center;color:#98a2b3;cursor:row-resize;z-index:2}
    .r-proposal-media-heightgrab i{font-size:10px}
    .r-proposal-media-controls{position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:8px;z-index:3}
    .r-proposal-media-delete{position:absolute;top:-12px;left:-12px;min-width:26px;height:26px;padding:0 9px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.96);color:#98a2b3;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 10px 18px rgba(15,23,42,.12);z-index:4;font-size:11px;font-weight:1000;transition:.18s ease}
    .r-proposal-media-delete:hover{color:#b42318;border-color:rgba(180,35,24,.18);background:#fff}
    .r-proposal-media-delete.armed{color:#fff;background:#b42318;border-color:#b42318}
    .r-proposal-media-btn{border:1px solid rgba(15,23,42,.08);background:#fff;border-radius:12px;padding:8px 10px;font-size:11px;font-weight:1000;color:#475467;cursor:pointer}
    .r-proposal-media-btn.icon{width:34px;height:34px;padding:0;display:inline-flex;align-items:center;justify-content:center}
    .r-proposal-media-btn.icon.danger:hover{color:#b42318;border-color:rgba(180,35,24,.2);background:rgba(180,35,24,.06)}
    .r-proposal-media-addpicker{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .r-proposal-media-addoption{border:1px dashed rgba(15,23,42,.16);border-radius:16px;background:rgba(15,23,42,.02);padding:14px 12px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;font-size:12px;font-weight:1000;color:#667085;cursor:pointer;transition:.16s ease}
    .r-proposal-media-addoption:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.04);color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-media-addoption i{font-size:16px}
    .r-proposal-media-pick{position:fixed;inset:0;background:rgba(15,23,42,.28);z-index:2147483500;display:flex;align-items:center;justify-content:center}
    .r-proposal-media-pick-card{width:min(760px,92vw);max-height:82vh;overflow:auto;border-radius:22px;background:#fff;box-shadow:0 28px 68px rgba(15,23,42,.28);padding:18px;display:flex;flex-direction:column;gap:14px}
    .r-proposal-media-pick-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
    .r-pricebook-suggest{position:fixed;z-index:4320;width:min(360px,calc(100vw - 32px));padding:10px;border-radius:18px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.98);box-shadow:0 24px 48px rgba(15,23,42,.18);display:flex;flex-direction:column;gap:8px}
    .r-pricebook-suggest-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 4px}
    .r-pricebook-suggest-head strong{font-size:11px;font-weight:1000;letter-spacing:.08em;text-transform:uppercase;color:#667085}
    .r-pricebook-suggest-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}
    .r-pricebook-suggest-item{padding:11px 12px;border-radius:14px;border:1px solid rgba(15,23,42,.08);background:#fff;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:4px}
    .r-pricebook-suggest-item strong{font-size:12px;color:#101828}
    .r-pricebook-suggest-item span{font-size:11px;font-weight:800;color:#667085}
    .r-pricebook-suggest-item:hover{border-color:rgba(var(--primary-rgb,217,48,37),.22);background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-proposal-media-pick-thumb{position:relative;border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;overflow:hidden;cursor:pointer;transition:.16s ease}
    .r-proposal-media-pick-thumb.selected{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-proposal-media-pick-thumb :is(img,video){width:100%;aspect-ratio:1/1;object-fit:cover;display:block}
    .r-proposal-media-pick-video{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border-radius:999px;background:rgba(15,23,42,.78);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;pointer-events:none}
    .r-proposal-media-pick-actions{display:flex;justify-content:space-between;gap:10px;align-items:center}
    .r-proposal-page-insert{position:absolute;left:50%;top:calc(100% + 9px);transform:translate(-50%,-50%);z-index:120;display:flex;flex-direction:column;align-items:center;pointer-events:none;transition:top .34s cubic-bezier(.22,1,.36,1)}
    .r-proposal-page-insert.active{top:calc(100% + 98px)}
    .r-proposal-page-insert-btn{width:26px;height:26px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.22);color:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;transition:all .24s cubic-bezier(.22,1,.36,1);box-shadow:none}
    .r-proposal-page-insert-btn:hover,.r-proposal-page-insert.active .r-proposal-page-insert-btn{width:42px;height:42px;border-color:rgba(15,23,42,.18);background:rgba(255,255,255,.98);color:#667085;box-shadow:0 12px 24px rgba(15,23,42,.14)}
    .r-proposal-page-insert.active .r-proposal-page-insert-btn{opacity:0;transform:scale(.72);pointer-events:none}
    .r-proposal-page-insert[data-mode="preview"]{opacity:0;visibility:hidden}
    .r-proposal-page-insert-picker{position:absolute;top:0;left:50%;z-index:140;transform:translate(-50%,-50%) scale(.94);display:flex;align-items:center;gap:14px;opacity:0;pointer-events:none;transition:opacity .24s ease,transform .28s cubic-bezier(.22,1,.36,1)}
    .r-proposal-page-insert.active .r-proposal-page-insert-picker{opacity:1;pointer-events:auto;transform:translate(-50%,-50%) scale(1)}
    .r-proposal-page-insert-rail{display:grid;grid-template-columns:repeat(auto-fit,minmax(86px,86px));grid-auto-rows:auto;justify-content:center;gap:8px;max-width:min(720px,calc(100vw - 120px))}
    .r-proposal-page-option{width:86px;border:1px solid rgba(15,23,42,.08);background:#fff;border-radius:13px;padding:6px;display:flex;flex-direction:column;gap:5px;cursor:pointer;transition:.18s ease;text-align:left;box-shadow:0 14px 28px rgba(15,23,42,.12)}
    .r-proposal-page-option:hover{transform:translateY(-1px);border-color:rgba(var(--primary-rgb,217,48,37),.28);box-shadow:0 12px 20px rgba(15,23,42,.08)}
    .r-proposal-page-option-mini{aspect-ratio:8.5/11;border-radius:8px;border:1px solid rgba(15,23,42,.08);background:#fff;position:relative;overflow:hidden}
    .r-proposal-page-option-mini::before{content:'';position:absolute;inset:10px 12px auto 12px;height:6px;border-radius:999px;background:rgba(15,23,42,.12)}
    .r-proposal-page-option-mini::after{content:'';position:absolute;inset:24px 12px auto 12px;height:4px;border-radius:999px;background:rgba(15,23,42,.08)}
    .r-proposal-page-option[data-page-template="cover"] .r-proposal-page-option-mini::before{inset:0 auto 0 0;width:26%;height:auto;border-radius:0;background:var(--primary,#d93025)}
    .r-proposal-page-option[data-page-template="cover"] .r-proposal-page-option-mini::after{inset:14px 16px auto 42px;height:7px;border-radius:999px;background:rgba(15,23,42,.12)}
    .r-proposal-page-option[data-page-template="pricing"] .r-proposal-page-option-mini::before{inset:12px auto auto 12px;width:44px;height:6px}
    .r-proposal-page-option[data-page-template="pricing"] .r-proposal-page-option-mini::after{inset:26px 12px auto 12px;height:26px;border-radius:0;background:linear-gradient(180deg,transparent 0 5px,rgba(15,23,42,.08) 5px 6px,transparent 6px 13px,rgba(15,23,42,.08) 13px 14px,transparent 14px 100%)}
    .r-proposal-page-option[data-page-template="marketing"] .r-proposal-page-option-mini::before{inset:10px 12px auto 12px;height:18px;border-radius:8px;background:rgba(var(--primary-rgb,217,48,37),.16)}
    .r-proposal-page-option[data-page-template="marketing"] .r-proposal-page-option-mini::after{inset:36px 12px 12px 12px;border-radius:10px;border:1px dashed rgba(15,23,42,.12);background:transparent}
    .r-proposal-page-option[data-page-template="measurement_insert"] .r-proposal-page-option-mini::before{inset:9px 11px auto 11px;height:10px;border-radius:5px;background:rgba(15,23,42,.14)}
    .r-proposal-page-option[data-page-template="measurement_insert"] .r-proposal-page-option-mini::after{inset:28px 12px 14px 12px;border-radius:8px;background:linear-gradient(180deg,rgba(var(--primary-rgb,217,48,37),.13),rgba(15,23,42,.04))}
    .r-proposal-page-option[data-page-template="image_text"] .r-proposal-page-option-mini::before{inset:12px auto 12px 12px;width:38%;border-radius:8px;background:rgba(var(--primary-rgb,217,48,37),.14)}
    .r-proposal-page-option[data-page-template="image_text"] .r-proposal-page-option-mini::after{inset:12px 12px 12px auto;width:38%;border-radius:8px;background:rgba(15,23,42,.08)}
    .r-proposal-page-option strong{font-size:10px;font-weight:1000;color:#111827;line-height:1.1}
    .r-proposal-page-option span{font-size:9px;font-weight:800;color:#667085;line-height:1.1}
    .r-proposal-page-insert-close{width:34px;height:34px;border-radius:999px;border:1px solid rgba(15,23,42,.1);background:rgba(255,255,255,.98);color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:none;opacity:0;transform:translateX(-6px);box-shadow:0 12px 24px rgba(15,23,42,.14);transition:opacity .22s ease,transform .24s cubic-bezier(.22,1,.36,1),color .18s ease,border-color .18s ease;flex:0 0 auto}
    .r-proposal-page-insert.active .r-proposal-page-insert-close{pointer-events:auto;opacity:1;transform:translateX(0)}
    .r-proposal-page-insert-close:hover{color:var(--primary,#d93025);border-color:rgba(var(--primary-rgb,217,48,37),.22)}
    .r-proposal-page-markup{position:absolute;inset:0;z-index:3;pointer-events:none}
    .r-proposal-wrap.markup-active .r-proposal-page-markup{pointer-events:auto}
    .r-proposal-page-markup-surface{position:absolute;inset:0}
    .r-proposal-page-markup-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
    .r-proposal-page-markup-path{fill:none;stroke:#111;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .r-proposal-page-markup-arrow{fill:none;stroke-linecap:round}
    .r-proposal-page-markup-text{position:absolute;min-width:84px;max-width:44%;padding:4px 6px;border-radius:8px;background:rgba(255,255,255,.72);color:#111;font-size:13px;line-height:1.4;white-space:pre-wrap;box-shadow:0 4px 14px rgba(15,23,42,.08)}
    .r-proposal-page-markup-editor{position:absolute;min-width:140px;max-width:48%;min-height:34px;padding:4px 6px;border-radius:8px;border:1px dashed rgba(15,23,42,.22);background:rgba(255,255,255,.72);color:#111;font:inherit;line-height:1.4;resize:none;outline:none;box-shadow:0 8px 18px rgba(15,23,42,.12)}
    .r-proposal-page-markup-editor:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-proposal-page-markup-handle{position:absolute;width:14px;height:14px;border-radius:999px;background:#fff;border:2px solid var(--primary,#d93025);box-shadow:0 6px 12px rgba(15,23,42,.14);transform:translate(-50%,-50%);display:none;cursor:grab;z-index:2}
    .r-proposal-wrap.markup-active .r-proposal-page-markup-handle{display:block}
    .r-proposal-page-markup-delete{position:absolute;width:20px;height:20px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.96);color:#667085;display:none;align-items:center;justify-content:center;font-size:10px;cursor:pointer;box-shadow:0 6px 12px rgba(15,23,42,.12);z-index:3}
    .r-proposal-wrap.markup-active .r-proposal-page-markup-delete{display:flex}
    .r-proposal-page-markup-delete:hover{color:#b42318;border-color:rgba(180,35,24,.2)}
    .r-proposal-page{--proposal-text-bold:600;--proposal-text-heavy:700}
    .r-proposal-page :where(strong,b,h2,h3,.r-proposal-page-logo,.r-proposal-page-number,.r-proposal-kicker,.r-proposal-page-title,.r-proposal-meta-card span,.r-proposal-total span,.r-proposal-edit-heading,.r-proposal-edit-meta,.r-proposal-edit-total,.r-proposal-contact-name,.r-proposal-line-meta,.r-proposal-signature-tab,.r-proposal-financial-row.total,.r-proposal-payment-row.total,.r-proposal-marketing-copy strong){font-weight:var(--proposal-text-heavy)}
    .r-proposal-page :where(.r-proposal-meta-card strong,.r-proposal-total strong,.r-proposal-signature-box strong,.r-proposal-financial-head strong,.r-proposal-payment-card strong){font-weight:var(--proposal-text-bold)}
    .r-proposal-page.theme-triangles .r-proposal-total.is-final-page-total strong,
    .r-proposal-page.theme-triangles .r-proposal-total.is-final-page-total .r-proposal-edit-total{font-weight:var(--proposal-text-heavy)}
    .r-info-tip{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:rgba(15,23,42,.08);cursor:help;font-size:9px;font-weight:900;color:#667085;flex-shrink:0}
    .r-addon-info-trigger{cursor:pointer;touch-action:manipulation}
    .r-info-tip.is-hidden{display:none}
    .r-info-tip .r-tip-bubble{display:none;position:absolute;bottom:calc(100% + 8px);left:0;width:220px;padding:10px 12px;border-radius:12px;background:#111827;color:#f8fafc;font-size:11px;font-weight:800;line-height:1.45;letter-spacing:0;text-transform:none;box-shadow:0 12px 28px rgba(0,0,0,.25);z-index:100}
    .r-info-tip .r-tip-bubble::after{content:'';position:absolute;top:100%;left:10px;border:6px solid transparent;border-top-color:#111827}
    .r-info-tip:hover .r-tip-bubble{display:block}
    .pac-container{z-index:2147483647!important;font-family:inherit}
    .r-dup-overlay{position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;opacity:0;animation:rDupIn .14s ease forwards}
    @keyframes rDupIn{to{opacity:1}}
    .r-dup-dialog{width:min(440px,90vw);background:#fff;border-radius:18px;box-shadow:0 24px 64px rgba(0,0,0,.35);padding:28px 24px 22px;animation:rUp .18s ease-out}
    .r-dup-icon{width:48px;height:48px;border-radius:14px;background:#fff3e0;display:flex;align-items:center;justify-content:center;margin-bottom:16px;font-size:22px;color:#e65100}
    .r-dup-title{font-size:16px;font-weight:1000;color:#111;margin:0 0 8px}
    .r-dup-body{font-size:13px;font-weight:700;color:#555;line-height:1.5;margin:0 0 8px}
    .r-dup-match{margin:12px 0 18px;padding:10px 14px;border-radius:12px;background:#f8f9fa;border:1px solid rgba(0,0,0,.08)}
    .r-dup-match-addr{font-weight:900;font-size:13px;color:#222;margin:0 0 3px}
    .r-dup-match-meta{font-size:11px;font-weight:700;color:#888}
    .r-dup-actions{display:flex;gap:10px}
    .r-dup-btn{flex:1;padding:11px 12px;border-radius:12px;border:1px solid rgba(0,0,0,.12);background:#fff;font-weight:1000;font-size:13px;cursor:pointer}
    .r-dup-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:var(--on-primary,#fff)}
    .storage-checkout-backdrop{position:fixed;inset:0;z-index:2147483300;background:rgba(15,23,42,.42);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:18px}
    .storage-checkout-modal{width:min(560px,calc(100vw - 36px));min-height:280px;background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:20px;box-shadow:0 28px 80px rgba(15,23,42,.28);display:flex;flex-direction:column;overflow:hidden}
    .storage-checkout-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:18px 18px 12px;border-bottom:1px solid #eaecf0}
    .storage-checkout-head strong{font-size:18px;font-weight:1000;color:#101828}.storage-checkout-head span{display:block;margin-top:4px;font-size:13px;font-weight:800;color:#667085;line-height:1.45}
    .storage-checkout-close{width:38px;height:38px;border-radius:13px;border:1px solid #d0d5dd;background:#fff;color:#475467;cursor:pointer}
    .storage-checkout-body{flex:1;display:flex;align-items:center;justify-content:center;padding:24px;color:#98a2b3;font-size:13px;font-weight:900;text-align:center}
    .storage-limit-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap}
    @media (max-width:1080px){.r-win{flex-direction:column;height:min(calc(var(--fm-visual-vh,100vh) * .96),1320px)}.r-left{width:100%;max-width:none;max-height:58%;border-right:none;border-bottom:1px solid rgba(15,23,42,.08)}.r-right{min-height:320px}.r-photo-grid{grid-template-columns:1fr}}
    @media (max-width:820px){
      .r-overlay.entitlement-mobile-fullscreen{align-items:stretch;background:#fff;backdrop-filter:none}
      .r-overlay.entitlement-mobile-fullscreen .r-win{width:var(--fm-visual-vw,100vw);height:var(--fm-visual-vh,100dvh);max-height:none;border-radius:0;box-shadow:none;animation:none}
      .r-overlay.entitlement-hide-fullscreen #rFullscreenToggle{display:none!important}
      .r-overlay.entitlement-tab-icons .r-tabbar{grid-auto-columns:minmax(44px,1fr)}
      .r-overlay.entitlement-tab-icons .r-tab{padding:0 10px;font-size:0}
      .r-overlay.entitlement-tab-icons .r-tab i{font-size:15px;margin:0}
    }
    @media (max-width:720px){
      .r-overlay{align-items:stretch}
      .r-win{width:var(--fm-visual-vw,100vw);height:var(--fm-visual-vh,100dvh);max-height:none;border-radius:0}
      /* Existing projects are a bottom-up workspace tray instead of a hard
         fullscreen takeover. The slim, shaded reveal above it preserves the
         sense of the Projects view that the user came from. */
      @keyframes rMobileProjectTrayIn{from{transform:translateY(100%);opacity:.96}to{transform:translateY(0);opacity:1}}
      .r-overlay.mobile-info-navigation:not(.mobile-order){align-items:flex-end;justify-content:center;padding-top:20px;box-sizing:border-box;background:rgba(11,16,24,.34);backdrop-filter:blur(2px)}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-win{width:var(--fm-visual-vw,100vw);height:calc(var(--fm-visual-vh,100dvh) - 20px);max-height:calc(var(--fm-visual-vh,100dvh) - 20px);border-radius:18px 18px 0 0;box-shadow:0 -9px 28px rgba(15,23,42,.30);animation:rMobileProjectTrayIn .36s cubic-bezier(.22,1,.36,1)}
      .r-overlay.mobile-info-navigation.route-initial-open:not(.mobile-order) .r-win{animation:none}
      .r-left{padding:12px;gap:8px;max-height:48%;flex-basis:auto}
      .r-left.notes-panel-ready:has(.r-firstmeasure-notes){padding-bottom:12px}
      .r-left.notes-history-expanded .r-left-bottom,.r-left:has(.r-bottom-notes.expanded) .r-left-bottom{margin:0;padding-left:12px;padding-right:12px;padding-bottom:5px}
      .r-top{padding-bottom:4px}
      .r-title{font-size:18px}
      .r-stagebar{margin:-1px 0 1px}
      .r-stage-pill{max-width:118px;min-height:24px;padding:4px 7px;font-size:10px}
      .r-scroll{padding-right:0}
      .r-step-body{padding-bottom:8px;gap:8px}
      #rStepCustomer .r-step-body{padding-bottom:8px}
      .r-group{gap:4px}
      .r-group label{font-size:10px;letter-spacing:.04em}
      .r-label-optional{display:none}
      .r-inp{padding:9px 10px;border-radius:12px;font-size:13px;min-height:38px}
      .r-contact-list{gap:6px}
      .r-contact-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 7px;align-items:center}
      .r-contact-card .r-inline{display:grid;grid-template-columns:minmax(0,1fr) minmax(112px,.65fr);gap:6px}
      .r-contact-card .r-contact-email-row{display:grid;grid-template-columns:minmax(0,1fr);gap:0}
      .r-contact-card .r-inline .r-group,.r-contact-card .r-contact-email-row .r-group{min-width:0}
      .r-contact-email-row.has-add{display:grid}
      .r-contact-menu-btn,.r-contact-primary{width:30px;height:30px;min-width:30px;border-radius:9px;font-size:11px}
      .r-mobile-customer-label{display:flex;grid-column:1/-1}
      .r-contact-list.has-multiple .r-contact-card{grid-template-columns:minmax(0,1fr) auto;padding:7px}
      .r-contact-list.has-multiple .r-contact-card.has-inline-add{grid-template-columns:minmax(0,1fr) auto}
      .r-contact-list.has-multiple + .r-contact-add{margin-top:2px}
      .r-bottom-notes label::after{content:'Optional';margin-left:2px;color:#98a2b3;font-size:10px;font-weight:800;letter-spacing:0;text-transform:none}
      .r-bottom-notes .customer-report-tip{display:none}
      .r-bottom-notes textarea{min-height:58px!important}
      .r-inline-notes-mount{display:block}
      .r-inline-notes-mount .r-bottom-notes{padding:0 0 8px}
      .r-mobile-internal-notes-mount{display:none}
      .r-left-bottom{display:none}
      .r-choice-row{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
      .r-inline,.r-inline3{grid-template-columns:1fr}
      .r-type-btn{display:grid;grid-template-columns:24px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;justify-content:start;text-align:left;padding:7px 6px;border-radius:12px;gap:1px 6px;min-height:42px}
      .r-type-icon{grid-row:1/3;grid-column:1;width:24px;height:24px;border-radius:9px;font-size:11px}
      .r-type-label{grid-row:1;grid-column:2;font-size:9.5px;line-height:1.1;white-space:normal}
      .r-type-price{grid-row:2;grid-column:2;font-size:8.5px;line-height:1.1;white-space:normal}
      .r-report-choice-row{grid-template-columns:repeat(3,minmax(0,1fr))}
      .r-tabbar{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);padding:0;gap:0;border-bottom:1px solid rgba(15,23,42,.10);background:#fff}
      .r-tab{min-height:44px;padding:0 8px;border:0;border-right:1px solid rgba(15,23,42,.10);border-bottom:1px solid rgba(15,23,42,.14);border-radius:0;background:#fff;box-shadow:none;backdrop-filter:none;justify-content:center;font-size:11px;gap:6px;line-height:1;color:#475467}
      .r-tab:last-child{border-right:0}
      .r-tab.active{box-shadow:inset 0 -3px 0 var(--primary,#d93025);background:#fff;color:var(--primary-readable,var(--primary,#d93025))}
      .r-tab i{font-size:13px}
      .r-tabbar.single-tab{display:none}
      .r-preview{padding:0}
      .r-preview-stage{border:0;border-radius:0;box-shadow:none;background:#e5e7eb;overflow:hidden}
      .r-preview-panel{border-radius:0}
      .r-proposal-topmode{top:61px;right:54px}
      .r-proposal-markupdock{top:121px;right:16px}
      .r-overlay.report-ordered:not(.mobile-order),
      .r-overlay.report-ordered:not(.mobile-order) .r-win,
      .r-overlay.report-ordered:not(.mobile-order) .r-left,
      .r-overlay.report-ordered:not(.mobile-order) .r-right{overflow-x:hidden}
      .r-overlay.report-ordered:not(.mobile-order) .r-left{max-height:43%;flex:0 0 auto}
      .r-overlay.report-ordered:not(.mobile-order) .r-right{flex:1 1 auto;min-height:0;background:#e5e7eb}
      .r-overlay.report-ordered:not(.mobile-order) .r-top{display:block;overflow:hidden;padding-right:42px}
      .r-overlay.report-ordered:not(.mobile-order) .r-title-wrap{overflow:hidden}
      .r-overlay.report-ordered:not(.mobile-order) .r-title,
      .r-overlay.report-ordered:not(.mobile-order) .r-title-input,
      .r-overlay.report-ordered:not(.mobile-order) .r-sub{display:block;max-width:none;white-space:nowrap;overflow:hidden;text-overflow:clip}
      .r-overlay.report-ordered:not(.mobile-order) .r-sub{margin-top:3px;font-size:10.5px;line-height:1.2}
      .r-overlay.report-ordered:not(.mobile-order) .r-tabbar{padding:0;gap:0}
      .r-overlay.report-ordered:not(.mobile-order) .r-preview,
      .r-overlay.report-ordered:not(.mobile-order) .r-preview-stage,
      .r-overlay.report-ordered:not(.mobile-order) .r-preview-panel{min-height:0}
      .r-overlay.report-ordered:not(.mobile-order) .r-preview-stage{height:100%;max-height:100%;overflow:hidden;background:#e5e7eb;border:0;border-radius:0;box-shadow:none}
      .r-overlay.report-ordered:not(.mobile-order) .r-preview-panel,
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-pane{overflow:hidden}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-tabs{height:48px;padding:0;gap:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);overflow:visible;background:#fff}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-tab{min-height:48px;width:100%;padding:0;border:0;border-right:1px solid rgba(15,23,42,.10);border-bottom:1px solid rgba(15,23,42,.14);border-radius:0;justify-content:center;font-size:0;gap:0;background:#fff;box-shadow:none}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-tab:last-of-type{border-right:0}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-tab.active{box-shadow:inset 0 -3px 0 var(--primary,#d93025);color:var(--primary-readable,var(--primary,#d93025))}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-tab i{font-size:17px}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-meta{display:none}
      .r-overlay.report-ordered:not(.mobile-order) .r-measure-body{inset:48px 0 0;overflow:hidden;background:#e5e7eb}
      .r-overlay.report-tabs-in-header.report-ordered:not(.mobile-order) .r-modal-header{height:48px;min-height:48px}
      .r-overlay.report-tabs-in-header.report-ordered:not(.mobile-order) .r-modal-header .r-measure-tabs{display:grid;height:48px;overflow-x:auto}
      .r-overlay.report-tabs-in-header.report-ordered:not(.mobile-order) .r-measure-body{inset:0}

      .r-overlay.report-ordered:not(.mobile-order) .r-report-pending{box-sizing:border-box;padding:8px;overflow:hidden;align-items:stretch}
      .r-overlay.report-ordered:not(.mobile-order) .r-report-pending-card{width:100%;max-height:100%;box-sizing:border-box;overflow:hidden;border-radius:14px;padding:12px;gap:6px;box-shadow:0 10px 24px rgba(15,23,42,.10)}
      .r-overlay.report-ordered:not(.mobile-order) .r-report-pending-card.is-expedited{justify-content:center;gap:10px}
      .r-overlay.report-ordered:not(.mobile-order) .r-report-pending-card i{font-size:18px}
      .r-overlay.report-ordered:not(.mobile-order) .r-report-pending-card h3{font-size:14px;line-height:1.15}
      .r-overlay.report-ordered:not(.mobile-order) .r-report-pending-card p{font-size:11px;line-height:1.35}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-badge{padding:3px 7px;font-size:9px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-detail{padding:7px 8px;border-radius:10px;font-size:10.5px;gap:2px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-detail strong{font-size:9px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-actions{gap:6px;margin-top:2px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-action-row{gap:6px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-action,
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-cancel,
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-reorder,
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-expedite-confirm{border-radius:10px;padding:7px 8px;font-size:10px;line-height:1.1}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-action-price{font-size:19px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-action-copy strong{font-size:10.5px}
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-action-copy span,
      .r-overlay.report-ordered:not(.mobile-order) .r-pending-note{font-size:9.5px;line-height:1.25}
      .r-overlay.report-ordered:not(.mobile-order) .r-report-refund-note{gap:7px;margin-bottom:6px;padding:8px 9px;border-radius:10px;font-size:10.5px;line-height:1.3}
      .r-modal-header{height:39px;min-height:39px}
      .modal-shell-actions{display:flex;position:static;z-index:auto;gap:0}
      .modal-shell-btn{width:36px;height:38px;min-height:38px;border-radius:0}
      .r-project-hour-head,.r-project-day-head,.r-project-time,.r-cal-person,.r-cal-time{position:static}
      .r-photo-wrap{padding:20px}
      .r-photo-title{font-size:22px}
      .r-overlay.mobile-order{--r-mobile-pager-height:calc(47px + env(safe-area-inset-bottom,0px))}
      html[data-native-app="android"] .r-overlay.mobile-order{--r-mobile-pager-height:47px}
      .r-overlay.mobile-order .r-win{padding-bottom:var(--r-mobile-pager-height);box-sizing:border-box}
      .r-overlay.mobile-order.mobile-order-location .r-win{padding-bottom:0}
      .r-overlay.mobile-order .r-modal-header{display:none}
      .r-overlay.mobile-order,
      .r-overlay.mobile-order .r-win,
      .r-overlay.mobile-order .r-left,
      .r-overlay.mobile-order .r-scroll{overflow-x:hidden}
      .r-overlay.mobile-order .r-top{display:block;overflow:hidden;padding-right:46px}
      .r-overlay.mobile-order .r-title-wrap{overflow:hidden}
      .r-overlay.mobile-order .r-title,
      .r-overlay.mobile-order .r-title-input,
      .r-overlay.mobile-order .r-sub{display:block;max-width:none;white-space:nowrap;overflow:hidden;text-overflow:clip}
      .r-overlay.mobile-order .r-tabbar{display:none}
      .r-overlay.mobile-order .r-preview{padding:0}
      .r-overlay.mobile-order .r-preview-stage{border:0;border-radius:0;box-shadow:none;background:transparent;overflow:hidden}
      .r-overlay.mobile-order .r-preview-panel{border:0;border-radius:0;box-shadow:none}
      .r-overlay.mobile-order .r-preview-panel:not([data-panel="map"]):not(:has(#rMeasurementMap)){display:none!important}
      .r-overlay.mobile-order [data-panel="measurements"]:has(#rMeasurementMap){display:flex!important}
      .r-overlay.mobile-order #rMeasureTabs{display:none!important}
      .r-overlay.mobile-order .r-measure-body{inset:0}
      .r-overlay.mobile-order [data-measure-pane="map"]{display:block!important}
      .r-overlay.mobile-order .r-measure-pane:not([data-measure-pane="map"]){display:none!important}
      .r-overlay.mobile-order .modal-shell-actions{display:none!important}
      .r-overlay.mobile-order .r-map-hint{top:0;left:0;right:0;width:auto;transform:none;box-sizing:border-box;border-radius:0 0 10px 10px;border-left:0;border-right:0;padding:5px 10px;min-height:24px;text-align:center;font-size:10.5px;line-height:1.2;box-shadow:0 6px 14px rgba(15,23,42,.10);background:rgba(255,255,255,.94)}
      .r-overlay.mobile-order .r-inline-label{display:none!important}
      .r-overlay.mobile-order .r-report-choice-row{display:none!important}
      .r-overlay.mobile-order #rReportOptionGroup{display:flex!important}
      .r-overlay.mobile-order #rRoofReportFields{display:flex!important}
      .r-overlay.mobile-order #rSubmit,
      .r-overlay.mobile-order #rExpediteSubmit{display:none!important}
      .r-overlay.mobile-order .r-mobile-close{display:flex;position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);right:8px;width:38px;height:38px;border-radius:12px;background:rgba(255,255,255,.88);backdrop-filter:blur(14px);border:1px solid rgba(15,23,42,.08);z-index:96;align-items:center;justify-content:center;cursor:pointer;font-size:15px;color:#344054}
      html[data-native-app="android"] .r-overlay.mobile-order .r-mobile-close{top:8px}
      .r-overlay.mobile-order .r-mobile-pager{height:var(--r-mobile-pager-height);position:fixed;left:0;right:0;bottom:0;z-index:95;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px max(10px,env(safe-area-inset-left)) calc(6px + env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));background:rgba(255,255,255,.96);border-top:1px solid rgba(15,23,42,.10);box-shadow:0 -8px 22px rgba(15,23,42,.10);box-sizing:border-box}
      html[data-native-app="android"] .r-overlay.mobile-order .r-mobile-pager{padding-bottom:6px}
      .r-overlay.mobile-order.mobile-order-location .r-mobile-pager{justify-content:flex-end;background:transparent;border:0;box-shadow:none;pointer-events:none}
      .r-overlay.mobile-order.mobile-order-location .r-mobile-pager{display:none}
      .r-overlay.mobile-order.mobile-order-location .r-mobile-pager .r-mobile-page-btn{pointer-events:auto;box-shadow:0 4px 18px rgba(15,23,42,.2)}
      .r-mobile-page-btn{height:34px;border-radius:11px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;padding:0 12px;font-size:12px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}
      .r-mobile-page-btn.primary{flex:0 0 auto;min-width:96px;border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 8px 18px rgba(var(--primary-rgb,217,48,37),.18)}
      .r-mobile-page-btn:disabled{background:#e5e7eb;border-color:#d1d5db;color:#667085;box-shadow:none;cursor:not-allowed}
      .r-overlay.mobile-order.mobile-order-location .r-left{flex:0 1 auto;gap:8px;max-height:calc(var(--fm-visual-vh,100dvh) - 180px);border-bottom:0;padding-bottom:8px}
      .r-overlay.mobile-order.mobile-order-location .r-right{display:flex;flex:1 1 auto;min-height:160px}
      .r-overlay.mobile-order.mobile-order-location .r-form{gap:8px}
      .r-overlay.mobile-order.mobile-order-location .r-scroll{flex:0 1 auto}
      .r-overlay.mobile-order.mobile-order-location .r-step-body{gap:9px;padding-bottom:6px}
      .r-overlay.mobile-order.mobile-order-location #rStepType{margin-bottom:2px}
      @keyframes rMobileStepReveal{from{opacity:0;transform:translateY(-7px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes rMobileTypeCollapse{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(.96)}}
      .r-overlay.mobile-order.mobile-order-location #rStepType.is-open,
      .r-overlay.mobile-order.mobile-order-location #rStepReport.is-open,
      .r-overlay.mobile-order.mobile-order-location #rExteriorOrder:not([hidden]),
      .r-overlay.mobile-order.mobile-order-location #rMobilePinStage:not([hidden]){animation:rMobileStepReveal .22s ease-out both}
      .r-overlay.mobile-order.mobile-order-location #rStepType.is-type-collapsing #rTypeGroup{animation:rMobileTypeCollapse .2s ease-in both}
      .r-overlay.mobile-order.mobile-order-location.mobile-scope-pending #rMobilePinStage{display:none!important}
      .r-overlay.mobile-order.mobile-order-location.mobile-scope-pending .r-map-hint{display:none!important}
      .r-overlay.mobile-order.mobile-order-location #rMobilePinStage{display:flex;flex-direction:column;gap:9px}
      .r-overlay.mobile-order.mobile-order-location #rMobilePinNext{width:100%;min-height:52px;border:0;border-radius:13px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font:inherit;font-weight:800;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer}
      .r-overlay.mobile-order.mobile-order-location #rMobilePinNext[hidden],
      .r-overlay.mobile-order.mobile-order-location #rMobileRoofChoice[hidden]{display:none!important}
      .r-overlay.mobile-order.mobile-order-location .r-mobile-roof-choice{width:100%;min-height:56px;border:1px solid rgba(15,23,42,.15);border-radius:13px;background:#fff;color:#344054;font:inherit;font-weight:700;cursor:pointer}
      .r-overlay.mobile-order.mobile-order-location #rConfirm.pin-returning{animation:rMobileStepReveal .22s ease-out both}
      @media(prefers-reduced-motion:reduce){.r-overlay.mobile-order.mobile-order-location #rStepType.is-open,.r-overlay.mobile-order.mobile-order-location #rStepReport.is-open,.r-overlay.mobile-order.mobile-order-location #rExteriorOrder:not([hidden]),.r-overlay.mobile-order.mobile-order-location #rMobilePinStage:not([hidden]),.r-overlay.mobile-order.mobile-order-location #rStepType.is-type-collapsing #rTypeGroup,.r-overlay.mobile-order.mobile-order-location #rConfirm.pin-returning{animation:none}}
      .r-overlay.mobile-order.mobile-order-location #rStepTypeLabel{display:none!important}
      .r-overlay.mobile-order.mobile-order-location #rStepType:not(.is-condensed) #rTypeGroup{display:grid!important}
      .r-overlay.mobile-order.mobile-order-location #rStepType.is-condensed #rTypeGroup{display:none!important}
      .r-overlay.mobile-order.mobile-order-location #rStepType:not(.is-condensed) #rTypePill{display:none!important}
      .r-overlay.mobile-order.mobile-order-location #rStepType.is-condensed #rTypePill{display:flex!important}
      .r-overlay.mobile-order.mobile-order-location .r-type-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:9px 5px;min-height:62px;min-width:0;gap:3px;box-sizing:border-box}
      .r-overlay.mobile-order.mobile-order-location .r-type-icon{display:flex!important;width:24px;height:24px;flex:0 0 24px;align-items:center;justify-content:center}
      .r-overlay.mobile-order.mobile-order-location .r-type-label{display:block!important;width:100%;min-width:0;font-size:11px;line-height:1.15;white-space:normal;overflow-wrap:anywhere}
      .r-overlay.mobile-order.mobile-order-location .r-type-price{display:block!important;width:100%;min-width:0;font-size:9px;line-height:1.1;white-space:normal;overflow-wrap:anywhere}
      .r-overlay.mobile-order.mobile-order-location #rStepReport .r-step-body{gap:9px;padding:0}
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields{gap:9px}
      .r-overlay.mobile-order.mobile-order-location #rConfirm{padding:9px 11px;border-radius:13px;margin:7px 0 0}
      .r-overlay.mobile-order.mobile-order-location.exteriors-choose #rConfirm{display:none!important}
      .r-overlay.mobile-order.mobile-order-location #rExteriorOrder{margin:4px 0 0}
      .r-overlay.mobile-order.mobile-order-location #rExteriorOrder .ext-pages{margin-top:0}
      .r-overlay.mobile-order.mobile-order-location #rExteriorOrder .ext-choice{min-height:62px}
      .r-overlay.mobile-order.mobile-order-location #rExteriorOrder #rConfirm{margin:7px 0 0}
      .pac-container{border:1px solid #d0d5dd!important;border-radius:14px!important;box-shadow:0 14px 36px rgba(15,23,42,.18)!important;overflow:hidden;font-family:inherit!important}
      .pac-item{min-height:48px;box-sizing:border-box;padding:9px 12px!important;border-top:1px solid #eef0f4!important;font-size:13px!important;line-height:1.5!important;color:#667085!important;white-space:normal}
      .pac-item:first-child{border-top:0!important}
      .pac-item-query{font-size:14px!important;font-weight:700;color:#344054!important;white-space:normal}
      .pac-item:hover,.pac-item-selected{background:#f5f8fc!important}
      @keyframes rMobileNeedShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
      .r-overlay.mobile-order .r-mobile-needs-attention{animation:rMobileNeedShake .32s ease;border-color:rgba(180,35,24,.42)!important;box-shadow:0 0 0 3px rgba(180,35,24,.08)!important}
      .r-overlay.mobile-order.mobile-order-location #rStepCustomer > .r-step-shell > .r-step-inner > .r-step-body > .r-group,
      .r-overlay.mobile-order.mobile-order-location #rProjectCustomFields,
      .r-overlay.mobile-order.mobile-order-location #rCustomerPortalLinkMount,
      .r-overlay.mobile-order.mobile-order-location #rPinInfo,
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields > .r-group,
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields > .r-addon-toggle,
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields > #rPricingNote,
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields > #rReferralDiscount,
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields > #rSubmit,
      .r-overlay.mobile-order.mobile-order-location #rExpeditePanel,
      .r-overlay.mobile-order.mobile-order-location #rScheduleChoiceCard,
      .r-overlay.mobile-order.mobile-order-location #rRoofSkipSummary,
      .r-overlay.mobile-order.mobile-order-location .r-mobile-internal-notes-mount,
      .r-overlay.mobile-order.mobile-order-location .r-mobile-pin-count{display:none!important}
      .r-overlay.mobile-order.mobile-order-details .r-left,
      .r-overlay.mobile-order.mobile-order-photos .r-left,
      .r-overlay.mobile-order.mobile-order-final .r-left{flex:1 1 auto;height:100%;max-height:none;border-bottom:0}
      .r-overlay.mobile-order.mobile-order-details .r-right,
      .r-overlay.mobile-order.mobile-order-photos .r-right,
      .r-overlay.mobile-order.mobile-order-final .r-right{display:none}
      .r-overlay.mobile-order.mobile-order-details .r-scroll,
      .r-overlay.mobile-order.mobile-order-photos .r-scroll,
      .r-overlay.mobile-order.mobile-order-final .r-scroll{height:100%;overflow:auto}
      .r-overlay.mobile-order.mobile-order-photos #rStepReport,
      .r-overlay.mobile-order.mobile-order-photos .r-mobile-internal-notes-mount{display:none!important}
      .r-overlay.mobile-order.mobile-order-details .r-scroll{display:flex;flex-direction:column}
      .r-overlay.mobile-order.mobile-order-details #rStepReport,
      .r-overlay.mobile-order.mobile-order-details #rStepReport .r-step-shell,
      .r-overlay.mobile-order.mobile-order-details #rStepReport .r-step-inner,
      .r-overlay.mobile-order.mobile-order-details #rStepReport .r-step-body,
      .r-overlay.mobile-order.mobile-order-details #rReportOptionGroup,
      .r-overlay.mobile-order.mobile-order-details #rRoofReportFields{flex:1 1 auto;min-height:0}
      .r-overlay.mobile-order.mobile-order-details #rStepReport,
      .r-overlay.mobile-order.mobile-order-details #rStepReport .r-step-shell,
      .r-overlay.mobile-order.mobile-order-details #rStepReport .r-step-inner{display:flex;flex-direction:column}
      .r-overlay.mobile-order.mobile-order-details #rStepReport .r-step-body,
      .r-overlay.mobile-order.mobile-order-details #rReportOptionGroup,
      .r-overlay.mobile-order.mobile-order-details #rRoofReportFields{display:flex;flex-direction:column}
      .r-overlay.mobile-order.mobile-order-details #rStepAddress,
      .r-overlay.mobile-order.mobile-order-details #rStepType,
      .r-overlay.mobile-order.mobile-order-details #rPinInfo,
      .r-overlay.mobile-order.mobile-order-details #rPricingNote,
      .r-overlay.mobile-order.mobile-order-details #rReferralDiscount,
      .r-overlay.mobile-order.mobile-order-details #rConfirm,
      .r-overlay.mobile-order.mobile-order-details #rReportAddons,
      .r-overlay.mobile-order.mobile-order-details #rRoofReportFields > .r-addon-toggle,
      .r-overlay.mobile-order.mobile-order-details #rExpeditePanel,
      .r-overlay.mobile-order.mobile-order-details #rSubmit,
      .r-overlay.mobile-order.mobile-order-details .r-mobile-pin-count{display:none!important}
      .r-overlay.mobile-order.mobile-order-no-final.mobile-order-details #rPricingNote.visible,
      .r-overlay.mobile-order.mobile-order-no-final.mobile-order-details #rReferralDiscount.visible{display:flex!important}
      .r-overlay.mobile-order.mobile-order-no-final.mobile-order-details #rReportAddons.visible{display:flex!important}
      .r-overlay.mobile-order.mobile-order-no-final.mobile-order-details #rRoofReportFields > .r-addon-toggle.visible{display:flex!important}
      .r-overlay.mobile-order.mobile-order-details .r-mobile-internal-notes-mount{display:flex;flex:1 1 0;min-height:0}
      .r-overlay.mobile-order.mobile-order-details .r-mobile-internal-notes-mount .r-bottom-notes{padding:0;display:flex;flex:1 1 auto;min-height:0;flex-direction:column}
      .r-overlay.mobile-order.mobile-order-details .r-mobile-internal-notes-mount .r-bottom-notes textarea{flex:1 1 auto;height:auto!important;min-height:58px!important}
      .r-overlay.mobile-order.mobile-order-details .r-inline-notes-mount{display:none}
      .r-overlay.mobile-order.mobile-order-final #rStepCustomer,
      .r-overlay.mobile-order.mobile-order-final #rStepAddress,
      .r-overlay.mobile-order.mobile-order-final #rStepType,
      .r-overlay.mobile-order.mobile-order-final #rPinInfo,
      .r-overlay.mobile-order.mobile-order-final #rConfirm,
      .r-overlay.mobile-order.mobile-order-final #rRoofReportFields > .r-group,
      .r-overlay.mobile-order.mobile-order-final .r-mobile-internal-notes-mount,
      .r-overlay.mobile-order.mobile-order-final .r-mobile-pin-count{display:none!important}
      .r-overlay.mobile-order.mobile-order-final #rPricingNote.visible{margin:8px 2px 0}
      .r-overlay.mobile-order.mobile-order-final #rExpeditePanel.visible{display:flex!important;border:0;background:transparent;border-radius:0;padding:0;margin:0;box-shadow:none;gap:10px}
      .r-overlay.mobile-order.mobile-order-final #rExpediteWait{padding:0;border:0;border-radius:0;background:transparent;box-shadow:none}
      .r-overlay.mobile-order.mobile-order-final #rExpediteWait .r-expedite-bar{width:calc(100% - 18px);margin:0 9px}
      .r-overlay.mobile-order.mobile-order-final #rExpediteOptions{gap:8px}
      .r-overlay.mobile-order.mobile-order-final .r-expedite-default{grid-column:1/-1}
      .r-overlay.mobile-order .r-addon-info-trigger{width:22px;height:22px;font-size:10px;background:rgba(15,23,42,.10);color:#475467}
      @keyframes rMobilePageInForward{from{opacity:.2;transform:translateX(26px)}to{opacity:1;transform:translateX(0)}}
      @keyframes rMobilePageInBack{from{opacity:.2;transform:translateX(-26px)}to{opacity:1;transform:translateX(0)}}
      .r-overlay.mobile-order.mobile-page-anim-forward .r-left,
      .r-overlay.mobile-order.mobile-page-anim-forward .r-right{animation:rMobilePageInForward .24s cubic-bezier(.22,1,.36,1)}
      .r-overlay.mobile-order.mobile-page-anim-back .r-left,
      .r-overlay.mobile-order.mobile-page-anim-back .r-right{animation:rMobilePageInBack .24s cubic-bezier(.22,1,.36,1)}
      /* Existing-project details are available from the title drawer, so tabs
         can use the complete workspace instead of stacking the default column. */
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-modal-header{height:48px}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-tabbar{grid-auto-columns:minmax(44px,1fr)}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-tab{min-height:48px;padding:0 10px;font-size:0}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-tab i{margin:0;font-size:16px}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-tab .pv-tab-label{display:none}
      .r-overlay.mobile-info-navigation:not(.mobile-order) #rProjectHeaderAction{display:none!important}
      .r-overlay.mobile-info-navigation:not(.mobile-order) #rFullscreenToggle{display:none!important}
      .r-overlay.mobile-info-navigation:not(.mobile-order):not(.mobile-info-active):not(.left-override):not(.mobile-default-info-tray-mode) .r-left{display:none!important}
      .r-overlay.mobile-info-navigation:not(.mobile-order):not(.mobile-info-active):not(.left-override) .r-right{flex:1 1 auto;min-height:0}
      .r-overlay.mobile-info-navigation:not(.mobile-order):not(.mobile-info-active) .r-mobile-project-title{height:48px;min-height:48px;box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:0 16px;border-bottom:1px solid rgba(15,23,42,.10);background:#fff;color:#101828;font-size:18px;font-weight:1000;letter-spacing:-.02em;line-height:1.2}
      .r-mobile-project-tab-title{display:inline-flex;align-items:center;gap:9px;min-width:0;overflow:hidden;white-space:nowrap;flex:0 1 auto;font-size:16px;font-weight:1000;color:#475467;letter-spacing:-.01em}
      .r-mobile-project-tab-title span{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .r-mobile-project-tab-title i{font-size:14px;color:#667085;flex:0 0 auto}
      .r-overlay.visit-identity-header:not(.mobile-order) .r-mobile-project-title{height:62px;min-height:62px;padding-top:7px;padding-bottom:7px}
      .r-overlay.visit-identity-header .r-mobile-project-tab-title{flex:1 1 auto;max-width:100%;color:#101828}
      .r-mobile-visit-identity-copy{display:flex;min-width:0;flex-direction:column;gap:2px;line-height:1.15}
      .r-mobile-visit-identity-copy strong,.r-mobile-visit-identity-copy small{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-mobile-visit-identity-copy strong{font-size:17px;color:#101828}.r-mobile-visit-identity-copy small{font-size:11px;font-weight:750;color:#667085}
      .r-mobile-project-header-action{margin-left:auto;min-height:34px;padding:0 12px;border:1px solid rgba(var(--primary-rgb,217,48,37),.24);border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);display:inline-flex;align-items:center;justify-content:center;gap:7px;font:inherit;font-size:12px;font-weight:1000;white-space:nowrap;cursor:pointer}
      .r-mobile-project-header-action[hidden]{display:none!important}
      .r-mobile-project-header-action i{font-size:11px}
      .r-mobile-project-info-toggle{margin-left:0;min-width:0;max-width:64%;padding:0;border:0;background:transparent;color:#475467;display:inline-flex;align-items:center;justify-content:flex-end;gap:10px;font:inherit;cursor:pointer}
      .r-mobile-project-header-action[hidden] + .r-mobile-project-info-toggle{margin-left:auto}
      .r-mobile-project-info-toggle i{flex:0 0 auto;font-size:14px;color:#667085}
      .r-mobile-project-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:16px;font-weight:1000;letter-spacing:-.01em}
      .r-overlay.entitlement-info-none #rMobileProjectInfoToggle{pointer-events:none}
      .r-overlay.entitlement-info-none #rMobileProjectInfoChevron{display:none}
      .r-overlay.mobile-info-navigation.mobile-info-active:not(.mobile-order) .r-right{order:1;flex:0 0 48px;min-height:48px;background:#fff}
      .r-overlay.mobile-info-navigation.mobile-info-active:not(.mobile-order) .r-right .r-preview{display:none!important}
      .r-overlay.mobile-info-navigation.mobile-info-active:not(.mobile-order) .r-left{order:2;display:flex!important;flex:1 1 auto;min-height:0;max-height:none;border-bottom:0}
      .r-overlay.mobile-left-tray-mode .r-modal-header,
      .r-overlay.mobile-left-tray-mode .r-mobile-project-title{position:relative;z-index:101}
      /* The modal chrome owns the project identity on mobile.  The left region
         can contain project details, but must not repeat the same title. */
      .r-overlay.mobile-left-tray-mode .r-left .r-top,.r-overlay.mobile-default-info-tray-mode .r-left .r-top{display:none!important}
      .r-overlay.mobile-left-tray-mode .r-mobile-project-tab-title{display:none}
      .r-overlay.mobile-left-tray-mode .r-mobile-left-tray-toggle{min-width:0;max-width:58%;padding:0;border:0;background:transparent;color:#475467;display:inline-flex;align-items:center;gap:9px;cursor:pointer;font:inherit;font-size:16px;font-weight:1000;letter-spacing:-.01em}
      .r-overlay.mobile-left-tray-mode .r-mobile-left-tray-toggle:hover{color:var(--primary-readable,var(--primary,#d93025))}
      .r-overlay.mobile-left-tray-mode .r-mobile-left-tray-toggle span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-overlay.mobile-left-tray-mode .r-mobile-left-tray-toggle i{font-size:14px;flex:0 0 auto;color:#667085}
      .r-overlay.mobile-left-tray-mode .r-mobile-project-info-toggle{max-width:58%}
      .r-overlay.mobile-left-tray-mode .r-left{position:absolute;z-index:90;top:96px;bottom:0;left:0;width:95%;max-width:none;min-height:0;max-height:none;padding:20px 12px 12px;display:flex!important;transform:translateX(-103%);pointer-events:none;border:0;box-shadow:18px 0 38px rgba(15,23,42,.24);transition:transform .30s cubic-bezier(.22,1,.36,1),box-shadow .30s ease}
      /* These are custom-left-tray rules only.  Do not let them restyle the
         shared project-info surface when that same node is the right drawer. */
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-left,
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-left .r-scroll,
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-left .r-scroll > *{min-width:0;max-width:100%;box-sizing:border-box}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-contact-card .r-inline{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open:not(.mobile-default-info-tray-open) .r-left{height:calc(100% - 96px);max-height:calc(100% - 96px);flex:0 0 auto}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-left .r-scroll{flex:1 1 auto;min-height:0}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-left{transform:translateX(0);pointer-events:auto}
      .r-overlay.mobile-left-tray-mode .r-mobile-left-tray-scrim{display:none;position:absolute;z-index:89;top:96px;right:0;bottom:0;width:5%;border:0;padding:0;background:linear-gradient(90deg,rgba(15,23,42,.30),rgba(15,23,42,.06));cursor:pointer}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open .r-mobile-left-tray-scrim{display:block}
      /* Custom tab panels always originate on the left. The project-details
         drawer is independent and only takes the right edge while it is open. */
      .r-overlay.mobile-default-info-tray-mode:not(.mobile-left-tray-mode) .r-left{position:absolute;z-index:90;top:96px;right:0;bottom:0;left:auto;width:95%;max-width:none;min-height:0;max-height:none;padding:20px 12px 12px;display:flex!important;transform:translateX(103%);pointer-events:none;border:0;box-shadow:-18px 0 38px rgba(15,23,42,.24);transition:transform .30s cubic-bezier(.22,1,.36,1),box-shadow .30s ease}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-open .r-left{position:absolute;z-index:90;top:96px;right:0;bottom:0;left:auto;width:95%;max-width:none;min-height:0;max-height:none;padding:20px 12px 12px;display:flex!important;transform:translateX(0);pointer-events:auto;border:0;box-shadow:-18px 0 38px rgba(15,23,42,.24);transition:transform .30s cubic-bezier(.22,1,.36,1),box-shadow .30s ease}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-open.mobile-default-info-tray-entering .r-left{transform:translateX(103%);transition:none}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-leaving .r-left{position:absolute;z-index:90;top:96px;right:0;bottom:0;left:auto;width:95%;max-width:none;min-height:0;max-height:none;padding:20px 12px 12px;display:flex!important;transform:translateX(0);pointer-events:none;border:0;box-shadow:-18px 0 38px rgba(15,23,42,.24);transition:none}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-leaving.mobile-default-info-tray-leaving-active .r-left{transform:translateX(103%);transition:transform .30s cubic-bezier(.22,1,.36,1),box-shadow .30s ease}
      /* When a tab also owns a left tray, the shared region must still become
         a right-originating standard-info drawer while that drawer is open. */
      .r-overlay.mobile-left-tray-mode.mobile-default-info-tray-open .r-left{position:absolute;z-index:90;top:96px;right:0;bottom:0;left:auto;width:95%;max-width:none;min-height:0;max-height:none;padding:20px 12px 12px;display:flex!important;transform:translateX(0);pointer-events:auto;border:0;box-shadow:-18px 0 38px rgba(15,23,42,.24);transition:transform .30s cubic-bezier(.22,1,.36,1),box-shadow .30s ease}
      .r-overlay.mobile-left-tray-mode.mobile-default-info-tray-open.mobile-default-info-tray-entering .r-left{transform:translateX(103%);transition:none}
      .r-overlay.mobile-left-tray-mode.mobile-default-info-tray-leaving .r-left{position:absolute;z-index:90;top:96px;right:0;bottom:0;left:auto;width:95%;max-width:none;min-height:0;max-height:none;padding:20px 12px 12px;display:flex!important;transform:translateX(0);pointer-events:none;border:0;box-shadow:-18px 0 38px rgba(15,23,42,.24);transition:none}
      .r-overlay.mobile-left-tray-mode.mobile-default-info-tray-leaving.mobile-default-info-tray-leaving-active .r-left{transform:translateX(103%);transition:transform .30s cubic-bezier(.22,1,.36,1),box-shadow .30s ease}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-resetting .r-left{transition:none!important}
      .r-overlay.mobile-default-info-tray-mode .r-mobile-default-info-tray-scrim{display:none;position:absolute;z-index:89;top:96px;left:0;bottom:0;width:5%;border:0;padding:0;background:linear-gradient(270deg,rgba(15,23,42,.30),rgba(15,23,42,.06));cursor:pointer}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-open .r-mobile-default-info-tray-scrim{display:block}
      /* A custom desktop left region and the mobile project-info drawer share
         the source markup, but the mobile drawer must always be the complete
         standard project-info surface.  Restore that surface explicitly rather
         than leaking the active region app's layout into it. */
      .r-overlay.mobile-default-info-tray-open #rProjectStageBar{display:block!important}
      .r-overlay.mobile-default-info-tray-open #rAfterHours.visible{display:flex!important}
      .r-overlay.mobile-default-info-tray-open #rProjectionCard,.r-overlay.mobile-default-info-tray-open #rViewerSummary,.r-overlay.mobile-default-info-tray-open #rStepCustomer,.r-overlay.mobile-default-info-tray-open #rInlineNotesMount,.r-overlay.mobile-default-info-tray-open #rCustomerPortalLinkMount,.r-overlay.mobile-default-info-tray-open #rStepAddress,.r-overlay.mobile-default-info-tray-open #rStepType,.r-overlay.mobile-default-info-tray-open #rStepReport,.r-overlay.mobile-default-info-tray-open #rStepRoof{display:block!important}
      .r-overlay.mobile-default-info-tray-open #rWorkflowDock.visible{display:block!important}
      .r-overlay.mobile-default-info-tray-open #rProposalSection{display:none!important}
      .r-overlay.mobile-default-info-tray-mode.mobile-default-info-tray-open .r-scroll{overflow:auto!important;display:block!important;min-height:0!important;box-sizing:border-box;padding-bottom:74px!important}
      .r-overlay.mobile-default-info-tray-open .r-workflow-dock.visible,.r-overlay.mobile-default-info-tray-open .r-workflow-empty{display:flex!important;flex-direction:column;min-height:0}
      .r-mobile-project-notes-launcher,.r-mobile-project-notes-workspace,.r-mobile-project-notes-scrim{display:none}
      .r-overlay.mobile-default-info-tray-open .r-mobile-project-notes-launcher{position:absolute;z-index:92;right:0;bottom:0;left:5%;width:auto;height:58px;padding:0 18px;border:0;border-top:1px solid rgba(15,23,42,.10);border-radius:0;background:#fff;color:#344054;box-shadow:0 -8px 20px rgba(15,23,42,.10);display:flex;align-items:center;justify-content:flex-start;gap:10px;font-size:14px;font-weight:900;cursor:pointer}
      .r-overlay.mobile-default-info-tray-open .r-mobile-project-notes-launcher > i:first-child{font-size:16px;color:var(--primary-readable,var(--primary,#d93025))}
      .r-overlay.mobile-default-info-tray-open .r-mobile-project-notes-launcher span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-overlay.mobile-default-info-tray-open .r-mobile-project-notes-launcher > i:last-child{margin-left:auto;font-size:12px;color:#98a2b3}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-mobile-project-notes-launcher:hover{color:var(--primary-readable,var(--primary,#d93025));background:#f8fafc}
      .r-overlay.mobile-project-notes-open .r-mobile-project-notes-launcher{display:none!important}
      .r-overlay.mobile-project-notes-open .r-mobile-project-notes-scrim{position:absolute;z-index:120;inset:0;display:block;border:0;background:rgba(15,23,42,.48);backdrop-filter:blur(2px);cursor:pointer}
      .r-overlay.mobile-project-notes-open .r-mobile-project-notes-workspace{position:absolute;z-index:130;inset:max(12px,env(safe-area-inset-top,0px)) max(12px,env(safe-area-inset-right,0px)) max(12px,env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px));display:flex;min-height:0;flex-direction:column;overflow:hidden;border:1px solid rgba(15,23,42,.12);border-radius:20px;background:#fff;box-shadow:0 24px 64px rgba(15,23,42,.28);animation:rMobileNotesIn .18s cubic-bezier(.22,1,.36,1)}
      @keyframes rMobileNotesIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
      .r-mobile-project-notes-head{height:54px;flex:0 0 auto;padding:0 10px 0 16px;border-bottom:0;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff}
      .r-mobile-project-notes-head strong{font-size:16px;font-weight:1000;color:#101828;letter-spacing:-.01em}
      .r-mobile-project-notes-close{width:34px;height:34px;padding:0;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;color:#475467;display:inline-flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer}
      .r-mobile-project-notes-body{display:flex;flex:1 1 auto;min-height:0;padding:14px;box-sizing:border-box;background:#fff}
      .r-mobile-project-notes-body .r-bottom-notes{width:100%;height:100%;display:grid!important;grid-template-rows:minmax(0,1fr) auto;gap:10px;margin:0;padding:0!important;min-height:0;background:transparent}
      .r-mobile-project-notes-body .r-firstmeasure-notes{display:flex!important;height:auto;align-self:flex-start;flex-direction:column}
      .r-mobile-project-notes-body .r-firstmeasure-notes textarea.r-inp{min-height:160px;height:160px!important}
      .r-mobile-project-notes-body .r-note-history-deck{height:100%!important;min-height:0;margin:0!important;padding:0 0 10px!important;visibility:visible!important;overflow:hidden;border-bottom:0;display:flex;flex-direction:column;gap:9px}
      .r-mobile-project-notes-body .r-note-history-deck::before{display:none!important}
      .r-mobile-project-notes-body .r-note-history-tools,.r-mobile-project-notes-body .r-note-history{opacity:1!important}
      .r-mobile-project-notes-body .r-note-history{min-height:0;padding-right:2px}
      .r-mobile-project-notes-body .r-note-composer-shell{gap:9px;padding:0;background:transparent}
      .r-mobile-project-notes-body .r-bottom-notes-head label{font-size:12px;font-weight:1000;color:#475467;letter-spacing:.05em;text-transform:uppercase}
      .r-mobile-project-notes-body .r-note-visibility-disclaimer{font-size:9px}
      .r-mobile-project-notes-body .r-note-visibility-choice strong{max-width:150px;font-size:10px}
      .r-mobile-project-notes-body .r-bottom-notes textarea{min-height:78px!important;max-height:150px;font-size:14px;line-height:1.45}
      .r-mobile-project-notes-body .r-note-input-highlights{font-size:14px;line-height:1.45}
      .r-mobile-project-notes-body .r-note-compose-actions{min-height:36px}
      .r-mobile-project-notes-body .r-note-history-toggle{display:none!important}
      .r-mobile-project-notes-body .r-note-empty{border:0;background:transparent}
      .r-mobile-project-notes-body .r-note-compose-actions button{min-height:36px;padding:8px 12px;font-size:11px}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-preview-panel .mn-top .mn-title,
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-preview-panel .mt-top .mt-title{display:none!important}
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-preview-panel .mn-top,
      .r-overlay.mobile-info-navigation:not(.mobile-order) .r-preview-panel .mt-top{padding:10px 12px;min-height:0}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open #rProposalSection .r-proposal-workspace-head>div:first-child,
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open #rProposalSection .mt-left-head>strong{display:none!important}
      .r-overlay.mobile-left-tray-mode.mobile-left-tray-open #rProposalSection .r-proposal-workspace-head{justify-content:flex-end}
      #rProposalPreview .r-proposal-mobile-main{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:14px 12px 24px;background:#f8fafc}
      #rProposalPreview .r-proposal-mobile-main .r-proposal-listing{min-height:0;gap:12px}
      #rProposalPreview .r-proposal-mobile-main .r-proposal-workspace-head{padding:2px 0 4px;margin:0}
      #rProposalPreview .r-proposal-mobile-main .r-proposal-workspace-head strong{font-size:16px}
      #rProposalPreview .r-proposal-mobile-main .r-proposal-workspace-head span{font-size:11px}
      #rProposalPreview .r-proposal-mobile-main .r-proposal-list-card{padding:13px}
      .r-proposal-preview-empty .r-proposal-preview-create{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 14px;border:1px solid var(--primary,#d93025);border-radius:10px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font:inherit;font-size:12px;font-weight:1000;cursor:pointer}
      .r-proposal-preview-empty .r-proposal-preview-create i,.r-proposal-preview-empty .r-proposal-preview-create span{font:inherit;color:inherit;line-height:1}
      @media (prefers-reduced-motion:reduce){
        .r-overlay.mobile-order.mobile-page-anim-forward .r-left,
        .r-overlay.mobile-order.mobile-page-anim-forward .r-right,
        .r-overlay.mobile-order.mobile-page-anim-back .r-left,
        .r-overlay.mobile-order.mobile-page-anim-back .r-right{animation:none}
        .r-overlay.mobile-left-tray-mode .r-left{transition:none}
        .r-overlay.mobile-default-info-tray-mode .r-left{transition:none}
        .r-overlay.mobile-project-notes-open .r-mobile-project-notes-workspace{animation:none}
      }
    }
    @media (max-width:430px){
      .r-overlay.mobile-order.mobile-order-final #rExpediteOptions{grid-template-columns:1fr}
      .r-overlay.mobile-order.mobile-order-final .r-expedite-btn{min-height:60px}
    }
  `;

  function isMobileProjectOrder(){
    return !!window.matchMedia?.('(max-width: 720px)')?.matches;
  }

  function shouldUseMobileOrderPagination(){
    return isMobileProjectOrder()
      && requestedWorkflow === 'report'
      && !hasReportOrdered()
      && !proposalWorkspaceOpen
      && actionAvailable('roof');
  }

  function mobileProjectInfoTabEnabled(){
    return false;
  }

  function mobileProjectNavigationEnabled(){
    return !window.Portal.ExteriorOrder?.active() && isMobileProjectOrder() && viewingExistingProject && !shouldUseMobileOrderPagination();
  }

  function syncMobileProjectInfoNavigation(){
    const overlay = $('#rOverlay');
    if (!overlay) return;
    const enabled = mobileProjectNavigationEnabled();
    overlay.classList.toggle('mobile-info-navigation', enabled);
    overlay.classList.remove('mobile-info-active');
  }

  function mobileLeftTrayEnabled(){
    return isMobileProjectOrder() && !shouldUseMobileOrderPagination() && projectLeftColumnOverridden();
  }

  function mobileDefaultInfoTrayEnabled(){
    // Field-style project modals (crew/supervisor) opt out of the right-side
    // project-info pop-out entirely via presentation mobileInfo:'none'.
    return mobileProjectNavigationEnabled()
      && projectModalResolvedPresentation().infoTrayHidden !== true;
  }

  function mobileDefaultProjectInfoVisible(){
    return mobileDefaultInfoTrayOpen
      && mobileDefaultInfoTrayEnabled();
  }

  function shouldRenderDefaultProjectInfo(){
    return !projectLeftColumnOverridden() || mobileDefaultProjectInfoVisible();
  }

  function refreshMobileDefaultProjectInfo(){
    if (!mobileDefaultProjectInfoVisible()) return;
    renderProjectStageBar();
    renderProjectViewerSummary();
    renderProjectTodoDock();
    renderCustomerPortalLink();
    renderAfterHoursNotice();
  }

  function syncMobileDefaultInfoTray(){
    const overlay = $('#rOverlay');
    const toggle = $('#rMobileProjectInfoToggle');
    if (!overlay) return;
    const enabled = mobileDefaultInfoTrayEnabled();
    if (!enabled) mobileDefaultInfoTrayOpen = false;
    overlay.classList.toggle('mobile-default-info-tray-mode', enabled);
    overlay.classList.toggle('mobile-default-info-tray-open', enabled && mobileDefaultInfoTrayOpen);
    const win = overlay.querySelector('.r-win');
    if (win) window.requestAnimationFrame(() => { win.scrollLeft = 0; });
    if (!toggle) return;
    const open = enabled && mobileDefaultInfoTrayOpen;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Close project details' : 'Open project details');
    toggle.title = open ? 'Close project details' : 'Open project details';
    const icon = $('#rMobileProjectInfoChevron');
    if (icon) icon.className = `fas ${open ? 'fa-chevron-right' : 'fa-chevron-left'}`;
  }

  function setMobileDefaultInfoTrayOpen(open){
    const wantsOpen = !!open;
    const overlay = $('#rOverlay');
    window.clearTimeout(mobileDefaultInfoTrayLeaveTimer);
    mobileDefaultInfoTrayLeaveTimer = 0;
    if (wantsOpen) overlay?.classList.remove('mobile-default-info-tray-leaving', 'mobile-default-info-tray-leaving-active', 'mobile-default-info-tray-resetting');
    const shouldStageCloseToRight = !wantsOpen && mobileDefaultInfoTrayOpen;
    const shouldStageFromRight = wantsOpen && !mobileDefaultInfoTrayOpen;
    if (shouldStageFromRight) overlay?.classList.add('mobile-default-info-tray-entering');
    if (!wantsOpen) overlay?.classList.remove('mobile-default-info-tray-entering');
    mobileDefaultInfoTrayOpen = wantsOpen;
    if (mobileDefaultInfoTrayOpen) mobileLeftTrayOpen = false;
    if (shouldStageCloseToRight) overlay?.classList.add('mobile-default-info-tray-leaving');
    syncMobileLeftTray();
    syncMobileDefaultInfoTray();
    if (wantsOpen) refreshMobileDefaultProjectInfo();
    if (shouldStageFromRight) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (mobileDefaultInfoTrayOpen) overlay?.classList.remove('mobile-default-info-tray-entering');
      }));
    }
    if (shouldStageCloseToRight) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!mobileDefaultInfoTrayOpen) overlay?.classList.add('mobile-default-info-tray-leaving-active');
      }));
      mobileDefaultInfoTrayLeaveTimer = window.setTimeout(() => {
        overlay?.classList.add('mobile-default-info-tray-resetting');
        overlay?.classList.remove('mobile-default-info-tray-leaving', 'mobile-default-info-tray-leaving-active');
        requestAnimationFrame(() => requestAnimationFrame(() => overlay?.classList.remove('mobile-default-info-tray-resetting')));
        mobileDefaultInfoTrayLeaveTimer = 0;
      }, 330);
    }
  }

  function mobileProjectNotesEnabled(){
    return isMobileProjectOrder() && viewingExistingProject && !!activeBaseProject && !shouldUseMobileOrderPagination();
  }

  function syncMobileProjectNotes(){
    const overlay = $('#rOverlay');
    const launch = $('#rMobileProjectNotesLauncher');
    if (!overlay) return;
    const enabled = mobileProjectNotesEnabled();
    if (!enabled && mobileProjectNotesOpen) {
      mobileProjectNotesOpen = false;
      syncProjectNotesPlacement();
    }
    overlay.classList.toggle('mobile-project-notes-open', enabled && mobileProjectNotesOpen);
    if (launch) launch.hidden = !enabled;
  }

  function setMobileProjectNotesOpen(open, options = {}){
    const wantsOpen = !!open;
    if (wantsOpen && !mobileProjectNotesEnabled()) return;
    const overlay = $('#rOverlay');
    const notes = document.querySelector('#rOverlay .r-bottom-notes');
    const workspace = $('#rMobileProjectNotesBody');
    if (!overlay || !notes || !workspace) return;
    if (wantsOpen) {
      setMobileDefaultInfoTrayOpen(true);
      closeProjectNoteVisibilityMenu();
      mobileProjectNotesOpen = true;
      workspace.appendChild(notes);
      window.clearTimeout(projectNoteHistoryCloseTimer);
      projectNoteHistoryCloseTimer = 0;
      projectNoteHistoryClosing = false;
      proposalInternalNotesCollapsed = false;
      syncMobileProjectNotes();
      syncProjectNotesUi();
      if (!options.fromRoute && !window.Portal?.navigation?.applying) {
        window.Portal?.navigation?.push?.({ project:activeProjectRouteId(), projectTab:activePreviewTab, projectNotes:'1' }, { source:'project-mobile-notes-open', ownedKeys:['projectNotes'] });
      }
      window.requestAnimationFrame(() => $('#rProjectNotes')?.focus());
      return;
    }
    if (!mobileProjectNotesOpen) return;
    closeProjectNoteVisibilityMenu();
    mobileProjectNotesOpen = false;
    syncMobileProjectNotes();
    syncProjectNotesPlacement();
    if (!options.fromRoute && !window.Portal?.navigation?.applying) {
      window.Portal?.navigation?.backOrClose?.(['projectNotes'], { projectNotes:null }, { source:'project-mobile-notes-close' });
    }
  }

  function syncMobileLeftTray(){
    const overlay = $('#rOverlay');
    if (!overlay) return;
    const enabled = mobileLeftTrayEnabled();
    if (!enabled) mobileLeftTrayOpen = false;
    overlay.classList.toggle('mobile-left-tray-mode', enabled);
    overlay.classList.toggle('mobile-left-tray-open', enabled && mobileLeftTrayOpen);
    const toggle = $('#rMobileLeftTrayToggle');
    if (!toggle) return;
    const open = enabled && mobileLeftTrayOpen;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.setAttribute('aria-label', open ? 'Return to project content' : 'Open project panel');
    toggle.title = open ? 'Return to project content' : 'Open project panel';
    const icon = $('#rMobileLeftTrayChevron');
    if (icon) icon.className = `fas ${open ? 'fa-chevron-left' : 'fa-chevron-right'}`;
  }

  function setMobileLeftTrayOpen(open){
    mobileLeftTrayOpen = !!open;
    if (mobileLeftTrayOpen) {
      mobileDefaultInfoTrayOpen = false;
      window.clearTimeout(mobileDefaultInfoTrayLeaveTimer);
      mobileDefaultInfoTrayLeaveTimer = 0;
      $('#rOverlay')?.classList.remove('mobile-default-info-tray-entering', 'mobile-default-info-tray-leaving', 'mobile-default-info-tray-leaving-active', 'mobile-default-info-tray-resetting');
    }
    syncMobileLeftTray();
    syncMobileDefaultInfoTray();
  }

  function mobileOrderReadyForDetails(){
    return !!(mobileOrderScopeReady() && pinCount() > 0 && locationConfirmed);
  }

  function mobileOrderScopeReady(){
    if (!addressSelected || !selectedType || mobileTypeTransitioning) return false;
    const exterior = window.Portal.ExteriorOrder;
    return exterior?.offersChoice?.(selectedType)
      ? !!exterior.selectedScope?.(selectedType)
      : mobileRoofOnlyChosen;
  }

  function shakeMobileOrderTarget(target){
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    el.classList.remove('r-mobile-needs-attention');
    void el.offsetWidth;
    el.classList.add('r-mobile-needs-attention');
    setTimeout(() => el.classList.remove('r-mobile-needs-attention'), 420);
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  function shakeMissingMobileOrderRequirement(){
    if (!addressSelected) {
      shakeMobileOrderTarget('#rStepAddress .r-inp');
      return true;
    }
    if (!selectedType) {
      shakeMobileOrderTarget('#rTypeGroup');
      return true;
    }
    if (pinCount() === 0 || !locationConfirmed) {
      shakeMobileOrderTarget('#rConfirm');
      return true;
    }
    return false;
  }

  function mobileOrderUsesFinalPage(){
    return !!(window.Portal.ExteriorOrder?.active() || (reportExpediteOptionsEnabled() && hasSelectedAddons()));
  }

  function mobileOrderReadyForFinal(){
    return mobileOrderUsesFinalPage() && mobileOrderReadyForDetails()
      && (!window.Portal.ExteriorOrder?.active() || window.Portal.ExteriorOrder.mobilePhotosReady());
  }

  function mobileOrderPageIndex(page = mobileOrderPage){
    return page === 'final' ? 3 : (page === 'photos' ? 2 : (page === 'details' ? 1 : 0));
  }

  function setMobileOrderPage(page){
    const previous = mobileOrderPage;
    mobileOrderPage = ['details', 'photos', 'final'].includes(page) ? page : 'location';
    if (mobileOrderPage === 'photos' && !window.Portal.ExteriorOrder?.active()) mobileOrderPage = 'details';
    if (mobileOrderPage !== 'location' && !mobileOrderReadyForDetails()) mobileOrderPage = 'location';
    if (mobileOrderPage === 'final' && !mobileOrderUsesFinalPage()) mobileOrderPage = 'details';
    if (mobileOrderPage === 'final' && !mobileOrderReadyForFinal()) mobileOrderPage = window.Portal.ExteriorOrder?.active() ? 'photos' : 'details';
    const overlay = $('#rOverlay');
    if (overlay && previous !== mobileOrderPage) {
      clearTimeout(mobileOrderAnimTimer);
      overlay.classList.remove('mobile-page-anim-forward', 'mobile-page-anim-back');
      overlay.classList.add(mobileOrderPageIndex(mobileOrderPage) > mobileOrderPageIndex(previous) ? 'mobile-page-anim-forward' : 'mobile-page-anim-back');
      mobileOrderAnimTimer = setTimeout(() => overlay.classList.remove('mobile-page-anim-forward', 'mobile-page-anim-back'), 280);
    }
    const scroller = document.querySelector('#rOverlay .r-scroll');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
    renderWorkflowState();
    requestAnimationFrame(() => {
      if (mobileOrderPage === 'location') scheduleProjectMapInitialize(activeBaseProject, 60);
    });
  }
  function queryParamChoice(names, allowed){
    try {
      const params = new URLSearchParams(window.location.search || '');
      for (const name of names) {
        if (!params.has(name)) continue;
        const value = String(params.get(name) || '').trim().toLowerCase();
        if (allowed.includes(value)) return value;
      }
    } catch (error) {
      return '';
    }
    return '';
  }
  function reportCreditViewOverride(){
    const value = queryParamChoice(['fm_report_credit_view', 'fm_credit_gate_view'], ['initial', 'first', 'first_report', 'normal', 'existing']);
    if (value === 'first' || value === 'first_report') return 'initial';
    if (value === 'existing') return 'normal';
    return value;
  }

  function mobileOrderGoBack(){
    if (!shouldUseMobileOrderPagination() || mobileOrderPage === 'location') return;
    setMobileOrderPage(mobileOrderPage === 'final'
      ? (window.Portal.ExteriorOrder?.active() ? 'photos' : 'details')
      : (mobileOrderPage === 'photos' ? 'details' : 'location'));
  }

  function mobileOrderGoNext(){
    if (!shouldUseMobileOrderPagination() || mobileOrderPage === 'final') return;
    if (mobileOrderPage === 'photos') {
      if (mobileOrderReadyForFinal()) setMobileOrderPage('final');
      return;
    }
    if (mobileOrderPage === 'details') {
      if (window.Portal.ExteriorOrder?.active()) {
        if (window.Portal.ExteriorOrder.mobileDetailsReady()) setMobileOrderPage('photos');
        return;
      }
      if (!mobileOrderUsesFinalPage()) return;
      if (!mobileOrderReadyForFinal()) return;
      setMobileOrderPage('final');
      return;
    }
    if (!mobileOrderReadyForDetails()) {
      shakeMissingMobileOrderRequirement();
      return;
    }
    setMobileOrderPage('details');
  }

  function handleMobileOrderSwipeStart(event){
    if (!shouldUseMobileOrderPagination() || event.touches?.length !== 1) return;
    if (event.target?.closest?.('input,textarea,select,button,a,[contenteditable="true"]')) return;
    const touch = event.touches[0];
    mobileSwipeStart = { x: touch.clientX, y: touch.clientY, t: Date.now() };
  }

  function handleMobileOrderSwipeEnd(event){
    if (!mobileSwipeStart || !shouldUseMobileOrderPagination()) {
      mobileSwipeStart = null;
      return;
    }
    const touch = event.changedTouches?.[0];
    if (!touch) {
      mobileSwipeStart = null;
      return;
    }
    const dx = touch.clientX - mobileSwipeStart.x;
    const dy = touch.clientY - mobileSwipeStart.y;
    mobileSwipeStart = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.45) return;
    if (dx < 0) mobileOrderGoNext();
    else mobileOrderGoBack();
  }

  function syncMobileOrderPagination(){
    const overlay = $('#rOverlay');
    if (!overlay) return;
    const mobile = shouldUseMobileOrderPagination();
    if (!mobile) mobileOrderPage = 'location';
    if (mobile && mobileOrderPage !== 'location' && !mobileOrderReadyForDetails()) mobileOrderPage = 'location';
    if (mobile && mobileOrderPage === 'photos' && !window.Portal.ExteriorOrder?.active()) mobileOrderPage = 'details';
    if (mobile && mobileOrderPage === 'final' && !mobileOrderUsesFinalPage()) mobileOrderPage = 'details';
    if (mobile && mobileOrderPage === 'final' && !mobileOrderReadyForFinal()) mobileOrderPage = window.Portal.ExteriorOrder?.active() ? 'photos' : 'details';
    const hasFinalPage = mobile && mobileOrderUsesFinalPage();
    overlay.classList.toggle('mobile-order', mobile);
    overlay.classList.toggle('mobile-order-no-final', mobile && !hasFinalPage);
    overlay.classList.toggle('mobile-order-location', mobile && mobileOrderPage === 'location');
    overlay.classList.toggle('mobile-order-details', mobile && mobileOrderPage === 'details');
    overlay.classList.toggle('mobile-order-photos', mobile && mobileOrderPage === 'photos');
    overlay.classList.toggle('mobile-order-final', mobile && mobileOrderPage === 'final');
    if (mobile && window.Portal.ExteriorOrder?.active()) window.Portal.ExteriorOrder.setMobilePage(mobileOrderPage);
    syncMobileProjectInfoNavigation();
    syncMobileLeftTray();
    syncMobileDefaultInfoTray();
    syncMobileProjectNotes();
    const back = $('#rMobileBack');
    const next = $('#rMobileNext');
    const order = $('#rMobileOrder');
    if (back) back.style.display = mobile && mobileOrderPage !== 'location' ? '' : 'none';
    if (next) {
      const exterior = window.Portal.ExteriorOrder?.active();
      const ready = mobileOrderPage === 'photos' ? mobileOrderReadyForFinal()
        : mobileOrderPage === 'details' ? (exterior ? window.Portal.ExteriorOrder.mobileDetailsReady() : mobileOrderReadyForFinal())
        : mobileOrderReadyForDetails();
      next.style.display = mobile && (mobileOrderPage === 'photos' || (mobileOrderPage === 'details' && hasFinalPage)) ? '' : 'none';
      next.disabled = mobile ? !ready : false;
      next.innerHTML = `<span>${(globalThis.PlatformLanguage?.text("project-request","m_5e03a7c216f500","Next") ?? "Next")}</span><i class="fas fa-arrow-right"></i>`;
    }
    if (order) {
      const submit = activeSubmitButton();
      const orderVisible = mobile && (mobileOrderPage === 'final' || (mobileOrderPage === 'details' && !hasFinalPage));
      order.style.display = orderVisible ? '' : 'none';
      order.disabled = !orderVisible || !submit || submit.disabled || !!(window.Portal.ExteriorOrder?.active() && !window.Portal.ExteriorOrder.ready());
      const label = window.Portal.ExteriorOrder?.active() ? 'Order Full Structure' : (submit?.textContent?.trim() || 'Order Roof Report');
      order.textContent = label.replace(/^Order Roof Report\b/, 'Order Report');
    }
  }

  function normalizedProjectType(type){
    return String(type || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function isPerStructureType(type){
    const normalized = normalizedProjectType(type);
    return normalized === 'commercial' || normalized === 'multifamily' || normalized === 'multi_family';
  }

  function pinCount(){ return getMarkersData().length; }

  function maxPinsForType(type){
    const normalized = normalizedProjectType(type);
    if (normalized === 'residential') return MAX_PINS_RESIDENTIAL;
    if (isPerStructureType(normalized)) return MAX_PINS_PER_STRUCTURE_REPORT;
    return 0;
  }

  function pinLimitMessage(maxPins){
    return `Maximum of ${maxPins} pins per report. Remove a pin to place a new one.`;
  }

  function pinLimitExceeded(pins = getMarkersData(), type = selectedType){
    const maxPins = maxPinsForType(type);
    return !!maxPins && Array.isArray(pins) && pins.length > maxPins;
  }

  function showStructurePinLimitNotice(maxPins = maxPinsForType(selectedType)){
    structurePinLimitNoticeActive = true;
    renderPinInfo();
    showToast((globalThis.PlatformLanguage?.text("project-request","m_21b024a2811c3a","Pin limit") ?? "Pin limit"), pinLimitMessage(maxPins || MAX_PINS_PER_STRUCTURE_REPORT), false);
    return true;
  }

  function validateStructurePinLimitForSubmit(pins = getMarkersData()){
    if (!pinLimitExceeded(pins, selectedType)) return true;
    showStructurePinLimitNotice(maxPinsForType(selectedType));
    return false;
  }
  function hasSelectedAddons(){ return reportSelection === 'roof'; }
  function shouldUseExpandedOverviewMap(){ return hasSelectedAddons() && !hasReportOrdered(); }
  function isProposalChoice(){ return reportSelection === 'proposal' || reportSelection === 'none'; }
  function isScheduleChoice(){ return reportSelection === 'schedule'; }
  function hasReportOrdered(){
    if (reorderMeasurementProjectId) return false;
    const ordered = !!(reportOrderState?.ordered || activeBaseProject?.workflow_state === 'measurement_ordered');
    if (!ordered) return false;
    if (activeMeasurementProjectId()) return true;
    return !!(
      projectHasReportOrder(activeBaseProject || {})
      || reportOrderState?.hasReadyReport
      || reportOrderState?.reportUrl
      || reportOrderState?.summaryUrl
      || reportOrderState?.xmlUrl
      || isFirstMeasureReturnedReportStatus(reportOrderState?.status, activeBaseProject?.status)
    );
  }
  function hasProposalDrafted(){ return proposals.length > 0 || (Array.isArray(activeBaseProject?.proposals) && activeBaseProject.proposals.length > 0); }
  function hasAppointmentScheduled(){ return !!currentProjectSalesAppointment(); }
  injectCSS('firstmeasure-notes', `
    #rOverlay .r-firstmeasure-notes{display:flex;flex-direction:column;gap:8px}
    #rOverlay .r-firstmeasure-notes textarea{display:block;min-height:72px;background:#fff;color:#333}
    #rOverlay .r-firstmeasure-notes.expanded textarea{min-height:180px}
  `);

  function expandedPlatformEnabled(){ return window.Portal?.capabilities?.value?.('platform.expanded_access', false) === true; }

  function appFeatureEnabled(group, flag, fallback = true){
    const appFlags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.(group, flag)) return true;
      const value = appFlags.value?.(group, flag, undefined);
      return typeof value === 'boolean' ? value : fallback;
    }
    return fallback;
  }
  function appFlagValue(group, flag, fallback = null){
    const appFlags = window.Portal?.appFlags || window.PlatformAPI?.appFlags;
    if (appFlags?.current?.()) return appFlags.value?.(group, flag, fallback) ?? fallback;
    return fallback;
  }
  function projectPhotosEnabled(){ return appFeatureEnabled('platform', 'project_photos', false); }
  // Consolidated Docs tab: shown when either the legacy project-docs flag or
  // the document engine is on (the tab embeds the engine when available).
  function projectDocsEnabled(){
    return appFeatureEnabled('platform', 'project_docs', false) || appFeatureEnabled('platform', 'documents', false);
  }
  function activeProjectRouteId(){
    return window.Portal?.routeState?.projectId?.(activeBaseProject) || String(activeBaseProject?.id || '').trim();
  }
  function routePhotoId(photo = {}){
    return window.Portal?.routeState?.mediaId?.(photo) || projectPhotoId(photo);
  }
  function syncActiveProjectRoute(extra = {}, options = {}){
    const projectId = activeProjectRouteId();
    if (!projectId || !activeBaseProject) return;
    const patch = { project: projectId, projectTab: activePreviewTab, projectFullscreen: projectModalFullscreen ? '1' : null, contact:null, user:null, userTab:null, pin:null, day:null, callQueue:null, callIndex:null, callStep:null, ...extra };
    if ((patch.projectTab || activePreviewTab) !== 'photos' && !patch.photo) {
      patch.photo = null;
      patch.photoScope = null;
    }
    if (projectRouteBatching || window.Portal?.navigation?.applying) return;
    window.Portal?.routeState?.set?.(patch, {
      history: options.history || 'replace',
      source: options.source || 'project-sync',
      ownedKeys: options.ownedKeys || ['project', 'projectTab']
    });
  }
  function clearProjectRoute(options = {}){
    const patch = { project: null, projectTab: null, projectNote: null, projectNotes: null, photo: null, photoScope: null, projectFullscreen: null, proposal: null, proposalMode: null, moneyView: null, receipt: null, reportView: null, document: null, documentView: null, materialList: null, materialSection: null, checklistView: null, customerPortalView: null, projectScheduleView: null, projectScheduleTarget: null };
    if (options.back !== false && window.Portal?.navigation?.backOrClose) {
      return window.Portal.navigation.backOrClose(['project'], patch, { source:'project-close' });
    }
    return window.Portal?.routeState?.set?.(patch, { history:'replace', source:options.source || 'project-clear' });
  }
  function routeFullscreenEnabled(value){
    const text = String(value || '').trim().toLowerCase();
    return !!text && !['0', 'false', 'off', 'no'].includes(text);
  }
  function syncProjectModalFullscreenRoute(){
    if (!viewingExistingProject) return;
    syncActiveProjectRoute({ projectFullscreen: projectModalFullscreen ? '1' : null });
  }
  function setProjectModalFullscreen(enabled, options = {}){
    projectModalFullscreen = !!enabled;
    const overlay = $('#rOverlay');
    clearTimeout(projectModalFullscreenTimer);
    if (overlay) {
      overlay.classList.add('fullscreen-transitioning');
      void overlay.offsetWidth;
    }
    overlay?.classList.toggle('fullscreen', projectModalFullscreen);
    const btn = $('#rFullscreenToggle');
    if (btn) {
      btn.setAttribute('aria-label', projectModalFullscreen ? 'Shrink project modal' : 'Open project fullscreen');
      btn.setAttribute('title', projectModalFullscreen ? 'Shrink' : 'Fullscreen');
      btn.setAttribute('data-fm-tooltip', projectModalFullscreen ? 'Shrink' : 'Fullscreen');
      btn.innerHTML = `<i class="fas ${projectModalFullscreen ? 'fa-down-left-and-up-right-to-center' : 'fa-up-right-and-down-left-from-center'}"></i>`;
    }
    projectModalFullscreenTimer = setTimeout(() => {
      overlay?.classList.remove('fullscreen-transitioning');
      projectModalFullscreenTimer = null;
      if (options.syncRoute !== false) syncProjectModalFullscreenRoute();
    }, options.immediate ? 0 : 340);
  }
  function toggleProjectModalFullscreen(){
    setProjectModalFullscreen(!projectModalFullscreen);
  }
  function preferMapForNewProjectInput(){
    if (proposalWorkspaceOpen && activePreviewTab === 'proposal') return;
    if (viewingExistingProject || hasReportOrdered() || activePreviewTab === 'map') return;
    setActivePreviewTab('map');
  }
  function storageLimitsEnabled(){ return appFeatureEnabled('platform', 'storage_limits', false); }
  function purchasableStorageEnabled(){ return appFeatureEnabled('platform', 'purchasable_storage', false); }
  function freeStorageGB(){ return Math.max(0, Number(appFlagValue('platform', 'free_storage_gb', 1) || 1)); }
  function storageLimitBytes(){ return window.PlatformAPI?.mediaStorage?.bytesFromGB?.(freeStorageGB()) || freeStorageGB() * 1024 * 1024 * 1024; }
  function formatStorageBytes(bytes){ return window.PlatformAPI?.mediaStorage?.formatBytes?.(bytes) || `${Math.round(Number(bytes || 0) / (1024 * 1024))} MB`; }
  function openStorageSettings(){
    try {
      window.dispatchEvent(new CustomEvent('fm:open-storage-settings'));
      window.Portal?.tabs?.activateTab?.('company_settings');
    } catch (_) {}
  }
  function proposalsEnabled(){ return appFeatureEnabled('platform', 'proposals', false); }
  function documentsEngineEnabled(){ return appFeatureEnabled('platform', 'documents', false); }
  function materialsEnabled(){ return appFeatureEnabled('platform', 'materials', false); }
  function moneyEnabled(){
    return appFeatureEnabled('platform', 'money', false);
  }
  function proposalAgentEnabled(){ return proposalsEnabled() && appFeatureEnabled('platform', 'proposal_agent', false); }
  function customerPortalEnabled(){ return appFeatureEnabled('platform', 'customer_portal', false); }
  function customerPortalMediaEnabled(){ return customerPortalEnabled() && appFeatureEnabled('platform', 'customer_portal_media', false); }
  function contactsEnabled(){ return appFeatureEnabled('platform', 'contacts', false); }
  function projectTodosEnabled(){ return appFeatureEnabled('platform', 'left_column_todo_list', false); }
  function projectStagesEnabled(){ return appFeatureEnabled('platform', 'project_stages_view', false); }
  function projectAssignmentsEnabled(){ return appFeatureEnabled('platform', 'project_assignments', true); }
  function manualProjectStageMovementEnabled(){ return appFeatureEnabled('platform', 'manual_project_stage_movement', false); }
  function canManageProjectStages(){
    const permissions = window.Portal?.currentUser?.permissions || {};
    return permissions['*'] === true || permissions.manage_projects === true;
  }
  function schedulingEnabled(){ return appFeatureEnabled('platform', 'scheduling', false); }
  function schedulePreviewAvailable(){ return schedulingEnabled() && (addressSelected || !!activeBaseProject); }
  function firstMeasureReportOrdersEnabled(){ return appFeatureEnabled('firstmeasure', 'report_orders', true); }
  function reportsEnabled(){ return firstMeasureReportOrdersEnabled(); }
  function gutterReportsEnabled(){ return appFeatureEnabled('firstmeasure', 'gutter_reports', false); }
  function weatherReportsEnabled(){ return firstMeasureReportOrdersEnabled() && appFeatureEnabled('firstmeasure', 'weather_reports', false); }
  function instantReportsEnabled(){ return appFeatureEnabled('firstmeasure', 'instant_reports', false); }
  function reportExpediteOptionsEnabled(){ return appFeatureEnabled('firstmeasure', 'report_expedite_options', false); }
  function reportOrderingClosed(){ return !!getAfterHoursMessage(); }
  function reportCancellationsEnabled(){ return firstMeasureReportOrdersEnabled() && appFeatureEnabled('firstmeasure', 'report_cancellations', true); }
  function reportFollowupEnabled(){ return firstMeasureReportOrdersEnabled() && appFeatureEnabled('firstmeasure', 'report_followup', false); }
  function actionAvailable(action){
    if (action === 'roof') return firstMeasureReportOrdersEnabled() && !hasReportOrdered();
    if (action === 'proposal') return proposalsEnabled();
    if (action === 'document') return documentsEngineEnabled();
    if (action === 'schedule') return schedulingEnabled() && !hasAppointmentScheduled();
    return false;
  }
  function availableProjectActions(){
    return ['roof', 'proposal', 'schedule'].filter(actionAvailable);
  }
  function normalizeWorkflow(value){
    const workflow = String(value || 'project').trim().toLowerCase();
    if (['contact', 'contacts', 'customer', 'customers'].includes(workflow)) return 'contact';
    if (['report', 'roof', 'measurement', 'measurements'].includes(workflow)) return 'report';
    // Legacy proposal workflow now lands on the document engine (Docs tab).
    if (['proposal', 'proposals'].includes(workflow)) return 'document';
    if (['document', 'documents', 'doc'].includes(workflow)) return 'document';
    if (['appointment', 'schedule', 'scheduling'].includes(workflow)) return 'appointment';
    return 'project';
  }
  function isUnfinishedReportDraft(project = {}){
    if (!project || projectHasReportOrder(project)) return false;
    const workflowIntent = String(project.workflow_intent || project.creation_workflow || '').trim();
    if (workflowIntent && normalizeWorkflow(workflowIntent) === 'report') return true;
    if (String(project.report_selection || '').trim().toLowerCase() === 'roof') return true;
    return String(project.workflow_state || '').trim().toLowerCase() === 'draft'
      && !!String(project.address || '').trim()
      && firstMeasureReportOrdersEnabled()
      && !proposalsEnabled()
      && !schedulingEnabled();
  }
  function workflowWantsAction(){
    return !['project', 'contact'].includes(requestedWorkflow) || !!reportSelection || hasReportOrdered();
  }
  function workflowActionKey(){
    if (requestedWorkflow === 'report') return 'roof';
    if (requestedWorkflow === 'proposal') return 'proposal';
    if (requestedWorkflow === 'document') return 'document';
    if (requestedWorkflow === 'appointment') return 'schedule';
    return null;
  }
  function shouldLockReportOrderingWorkflow(){
    return requestedWorkflow === 'report' && !hasReportOrdered();
  }
  function applyRequestedWorkflow(){
    const key = workflowActionKey();
    if (!key || !actionAvailable(key)) return;
    reportSelection = key;
    if (key === 'roof') {
      locationConfirmed = false;
      setActivePreviewTab('map');
    } else if (key === 'proposal' && proposalsEnabled()) {
      setTimeout(() => launchProposalBuilder(), 0);
    } else if (key === 'document' && documentsEngineEnabled()) {
      // Doc-first flow: land on the unified Docs tab. With no base project the
      // left column shows the project picker; with one, go straight to the
      // create wizard (type preselected when the action named one).
      setTimeout(() => beginDocumentWorkflow(), 0);
    } else if (key === 'schedule' && schedulingEnabled()) {
      setTimeout(() => startAppointmentScheduling(), 0);
    }
  }
  function projectLeftColumnOverridden(tab = activePreviewTab){
    // On phones, the proposal list and setup flow use the full preview pane.
    // Keep the drawer for the actual editor rail only; desktop keeps its
    // existing two-column presentation for every proposal state.
    if (tab === 'proposal' && isMobileProjectOrder() && proposalWorkspaceMode !== 'edit') return false;
    return ['app', 'override', 'replace', 'drawer', 'popout'].includes(projectModalResolvedPresentation(tab).leftMode);
  }
  function syncLeftColumnOverride(){
    const overlay = $('#rOverlay');
    if (!overlay) return false;
    applyProjectModalPresentation();
    const overridden = projectLeftColumnOverridden();
    overlay.classList.toggle('left-override', overridden);
    if (overridden) overlay.dataset.leftOverrideTab = activePreviewTab;
    else delete overlay.dataset.leftOverrideTab;
    syncMobileLeftTray();
    syncMobileDefaultInfoTray();
    return overridden;
  }
  function syncContactsFeatureState(){
    const overlay = $('#rOverlay');
    if (!overlay) return false;
    const enabled = contactsEnabled();
    overlay.classList.toggle('contacts-disabled', !enabled);
    if (!enabled) {
      closeContactActionMenu();
      closeContactPicker();
    }
    return enabled;
  }
  function restoreDefaultLeftColumnState(){
    if (projectLeftColumnOverridden()) return false;
    const overlay = $('#rOverlay');
    if (overlay) {
      overlay.classList.remove('left-override', 'materials-workspace', 'money-workspace', 'schedule-workspace');
      if (!proposalWorkspaceOpen) overlay.classList.remove('proposal-workspace');
      delete overlay.dataset.leftOverrideTab;
    }
    const section = $('#rProposalSection');
    const label = $('#rProposalLabel');
    const list = $('#rProposalList');
    section?.classList.remove('visible', 'mode-edit', 'mode-list', 'mode-send');
    if (label) {
      label.hidden = false;
      label.textContent = (globalThis.PlatformLanguage?.text("project-request","m_1d8655e967c464","Proposal") ?? "Proposal");
    }
    if (list) list.innerHTML = '';
    renderProjectStageBar();
    renderProjectViewerSummary();
    renderProjectTodoDock();
    renderCustomerPortalLink();
    renderAfterHoursNotice();
    return true;
  }
  function showProjectTodoDock(){
    if (!projectTodosEnabled()) return false;
    if (shouldLockReportOrderingWorkflow()) return false;
    if (hasSelectedAddons() && !hasReportOrdered()) return false;
    return shouldRenderDefaultProjectInfo();
  }
  function hasGutterAddon(){ return gutterReportsEnabled() && selectedType === 'residential' && includeGutterMeasurements; }
  function hasWeatherAddon(){ return weatherReportsEnabled() && includeWeatherReport; }
  function roofDecisionMade(){ return reportSelection !== null; }
  function reportExpediteChoiceComplete(){ return !reportExpediteOptionsEnabled() || !hasSelectedAddons() || reportOrderingClosed() || !!selectedReportExpediteOption(); }
  function roofStepComplete(){ return isProposalChoice() || isScheduleChoice() || (hasSelectedAddons() && locationConfirmed && reportExpediteChoiceComplete()); }
  function customerStepVisible(){ return roofDecisionMade() && roofStepComplete(); }
  function canSubmit(){ if (window.Portal.ExteriorOrder?.needsChoice()) return false; if (window.Portal.ExteriorOrder?.active()) return window.Portal.ExteriorOrder.ready(); return !!(addressSelected && selectedType && roofDecisionMade() && roofStepComplete()); }
  function roofReportControlsUnlocked(){
    return !hasSelectedAddons() || shouldUseMobileOrderPagination() || !!locationConfirmed;
  }
  function isProposalReadyFlow(){ return isProposalChoice() && proposals.length > 0; }
  function selectedReportMode(){ return instantReportsEnabled() && includeInstantPreview ? 'both' : 'full'; }
  function reportModeLabel(){ return REPORT_MODE_META[selectedReportMode()]?.label || REPORT_MODE_META.full.label; }
  function reportExpediteOption(key = selectedReportExpedite){
    const normalized = normalizeReportExpediteKey(key);
    return reportExpediteOptions.find((option) => option.key === normalized) || null;
  }
  function reportExpediteStructureCount(type = selectedType){
    if (!isPerStructureType(type)) return 1;
    const livePins = pinCount();
    if (livePins > 0) return livePins;
    const projectPins = normalizeProjectPins(activeBaseProject || {}).length;
    return Math.max(1, projectPins || 1);
  }
  function invalidateReportExpediteOptions(){
    reportExpediteOptionsProjectType = '';
    reportExpediteOptionsStructureCount = reportExpediteStructureCount();
    reportExpediteOptionsSlot = -1;
    reportExpediteOptionsAuthoritative = false;
  }
  function reportExpeditePricingReady(type = selectedType, structureCount = reportExpediteStructureCount(type)){
    if (!reportExpediteOptionsEnabled()) return true;
    const currentSlot = Math.floor(Date.now() / 600000);
    return reportExpediteOptionsAuthoritative
      && !reportExpediteOptionsLoading
      && reportExpediteOptionsProjectType === type
      && reportExpediteOptionsStructureCount === structureCount
      && reportExpediteOptionsSlot === currentSlot
      && reportExpediteOptions.some((option) => option.expedited)
      && reportExpediteOptions.every((option) => option._pricingAuthoritative === true);
  }
  function reportExpeditePricingLoading(){
    return reportExpediteOptionsLoading;
  }
  function defaultReportExpediteOption(){
    return reportExpediteOption('standard_3_6')
      || reportExpediteOptions.find((option) => option.expedited === false)
      || reportExpediteOptions.find((option) => Number(option.startMinutes) >= 180 && Number(option.endMinutes) >= 360)
      || null;
  }
  function selectedReportExpediteOption(){
    if (!reportExpediteOptionsEnabled()) return null;
    if (reportOrderingClosed()) return defaultReportExpediteOption();
    return reportExpediteOption() || defaultReportExpediteOption();
  }
  function proportionalReportExpediteUnitPrice(option, type = selectedType){
    const base = TYPE_META[type]?.price ?? PRICE_RESIDENTIAL;
    if (!option) return base;
    const residential = Number(option.residentialPrice ?? option.residential_price ?? (PRICE_RESIDENTIAL + (Number(option.rushDelta ?? option.rush_delta ?? 0) || 0))) || PRICE_RESIDENTIAL;
    return Math.round((isPerStructureType(type) ? base * (residential / PRICE_RESIDENTIAL) : residential) * 100) / 100;
  }
  function reportBaseUnitPrice(type = selectedType){
    const base = TYPE_META[type]?.price ?? PRICE_RESIDENTIAL;
    const option = selectedReportExpediteOption();
    if (!option) return base;
    return reportExpediteUnitPrice(option, type);
  }
  function instantAddonUnitPriceFor(type){
    return type === 'commercial'
      ? INSTANT_ADDON_COMMERCIAL
      : (type === 'multifamily' ? INSTANT_ADDON_MULTIFAMILY : INSTANT_ADDON_RESIDENTIAL);
  }
  function shouldAutoOpenInstantFromMode(mode = selectedReportMode()){
    return instantReportsEnabled() && mode === 'both';
  }
  function normalizeReportSelection(){
    if (!instantReportsEnabled()) includeInstantPreview = false;
    if (!gutterReportsEnabled() || selectedType !== 'residential') includeGutterMeasurements = false;
    if (!weatherReportsEnabled()) includeWeatherReport = false;
    if (!firstMeasureReportOrdersEnabled() && reportSelection === 'roof') reportSelection = null;
    if (!proposalsEnabled() && isProposalChoice()) reportSelection = null;
    if (reportSelection && !actionAvailable(reportSelection)) reportSelection = null;
    if (!reportExpediteOptionsEnabled()) selectedReportExpedite = null;
    if (reportOrderingClosed()) selectedReportExpedite = null;
    if (selectedReportExpedite && !reportExpediteOption(selectedReportExpedite)) selectedReportExpedite = null;
    if (!hasSelectedAddons()) {
      includeInstantPreview = false;
      includeGutterMeasurements = false;
      includeWeatherReport = false;
    }
  }

  function autoSelectOnlyAction(availableActions = availableProjectActions()){
    if (!workflowWantsAction() || !addressSelected || !selectedType || reportSelection || availableActions.length !== 1) return false;
    const only = availableActions[0];
    reportSelection = only;
    if (only === 'roof') {
      locationConfirmed = false;
      return true;
    }
    if (only === 'proposal' && proposalsEnabled()) {
      launchProposalBuilder();
      return true;
    }
    if (only === 'schedule' && schedulingEnabled()) {
      startAppointmentScheduling();
      return true;
    }
    return false;
  }
  function fmtMoney(value){
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    const amount = Math.round(n * 100) / 100;
    return amount % 1 === 0 ? String(amount.toFixed(0)) : amount.toFixed(2);
  }
  function fmtWholeMoney(value){
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US")) : '0';
  }
  function creditErrorDetails(errorOrData = {}){
    const data = errorOrData?.data || errorOrData || {};
    const text = [
      errorOrData?.message,
      data?.message,
      data?.error,
      data?.code
    ].map((value) => String(value || '').toLowerCase()).join(' ');
    const details = data?.details && typeof data.details === 'object' ? data.details : data;
    const balance = Number(details?.balance);
    const required = Number(details?.required ?? details?.amount);
    return {
      isCreditError: text.includes('insufficient_credits') || (text.includes('credit') && (text.includes('not enough') || text.includes('insufficient'))),
      balance: Number.isFinite(balance) ? Math.round(balance * 100) / 100 : null,
      required: Number.isFinite(required) ? Math.round(required * 100) / 100 : null
    };
  }
  function openCreditTopupForPurchase({ label, required, balance = null, context = 'paid_action_credit_gate', firstReportCheckout = false, reportCreditView = '' } = {}){
    const currentBalance = Number.isFinite(Number(balance))
      ? Math.round(Number(balance) * 100) / 100
      : (Number.isFinite(Number(window.Portal?.credits?.lastCredits)) ? Math.round(Number(window.Portal.credits.lastCredits) * 100) / 100 : null);
    const amount = Number(required);
    const requiredAmount = Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0;
    const needed = currentBalance === null ? requiredAmount : Math.max(0, Math.round((requiredAmount - currentBalance) * 100) / 100);
    window.dispatchEvent(new CustomEvent('fm:billing:open', {
      detail: {
        context,
        firstReportCheckout: !!firstReportCheckout,
        reportCreditView: reportCreditViewOverride() || reportCreditView || (firstReportCheckout ? 'initial' : ''),
        purchase: {
          label: label || 'this purchase',
          required: requiredAmount,
          balance: currentBalance,
          needed
        }
      }
    }));
  }
  async function ensureCreditsForPurchase(required, label, context){
    const amount = Number(required);
    if (!Number.isFinite(amount) || amount <= 0) return true;
    const refreshed = await window.Portal?.credits?.refreshCredits?.().catch(() => null);
    const balance = Number(window.Portal?.credits?.lastCredits);
    if (!refreshed?.ok || !Number.isFinite(balance) || balance >= amount) return true;
    openCreditTopupForPurchase({ label, required: amount, balance, context });
    return false;
  }
  function currentOriginalPrice(){
    if (!hasSelectedAddons()) return 0;
    const expediteOption = reportExpediteOptionsEnabled() ? selectedReportExpediteOption() : null;
    if (expediteOption) return reportExpediteNetTotalPrice(expediteOption, selectedType);
    if (!selectedType) return reportBaseUnitPrice('residential');
    const base = reportBaseUnitPrice(selectedType);
    const instant = includeInstantPreview ? instantAddonUnitPriceFor(selectedType) : 0;
    const unit = base + instant;
    const reportPrice = isPerStructureType(selectedType) ? unit * Math.max(1, pinCount()) : unit;
    const gutterPrice = hasGutterAddon() ? GUTTER_REPORT_ADDON : 0;
    const weatherPrice = hasWeatherAddon() ? WEATHER_REPORT_ADDON * Math.max(1, pinCount()) : 0;
    return reportPrice + gutterPrice + weatherPrice;
  }
  function currentDiscountableBase(){
    return window.Portal?.pricing?.standardBaseAmountForOrder?.(selectedType, pinCount(), selectedReportMode()) || currentOriginalPrice();
  }
  function currentPriceQuote(){
    const original = currentOriginalPrice();
    return window.Portal?.pricing?.referralDiscountPreview?.(original, currentDiscountableBase()) || {
      active: false,
      original_amount: original,
      final_amount: original,
      discount_amount: 0,
      discountable_amount: 0,
      discount_percent: 0,
    };
  }
  function currentPrice(){
    if (window.Portal.ExteriorOrder?.active()) return window.Portal.ExteriorOrder.price();
    return currentPriceQuote().final_amount;
  }

  function projectMapModule(){
    return window.Portal?.modules?.projectMap || window.Portal?.ProjectMapApp || null;
  }

  let projectMapMounting = false;
  let mountedProjectMapApp = null;
  let mountedProjectMapRoot = null;
  let projectMapInitTimer = 0;

  function mountProjectMapApp(context = {}){
    const app = projectMapModule();
    if (!app?.mount) return null;
    if (projectMapMounting) return app;
    const panelRoot = context.panelRoot || (document.querySelector('#rOverlay .r-preview-panel[data-panel="map"]') || document.querySelector('#rMeasurementMap'));
    projectMapMounting = true;
    try {
      app.mount({
        ...projectModalTabContext(),
        ...context,
        panelRoot,
        overlayRoot: $('#rOverlay'),
        host: projectWorkspaceHost(),
        projectWorkspace: projectWorkspaceHost()
      });
      mountedProjectMapApp = app;
      mountedProjectMapRoot = panelRoot;
      return app;
    } finally {
      projectMapMounting = false;
    }
  }

  function projectMapInvoke(name, args = []){
    const panelRoot = (document.querySelector('#rOverlay .r-preview-panel[data-panel="map"]') || document.querySelector('#rMeasurementMap'));
    const module = projectMapModule();
    // Read helpers such as pinCount must not remount and recenter the map.
    const app = module === mountedProjectMapApp && panelRoot && panelRoot === mountedProjectMapRoot
      ? module : mountProjectMapApp();
    if (app?.invoke) return app.invoke(name, args);
    const fn = app && app[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  function scheduleProjectMapInitialize(inputProject = activeBaseProject, delay = 0){
    clearTimeout(projectMapInitTimer);
    projectMapInitTimer = setTimeout(() => {
      projectMapInitTimer = 0;
      initializeMapView(inputProject);
    }, Math.max(0, Number(delay) || 0));
  }

  function resetProjectMapExpansionPreference(){
    const app = projectMapModule();
    if (app?.resetOverviewMapExpansion) app.resetOverviewMapExpansion();
  }

  function buildPinIcon(...args){ return projectMapInvoke('buildPinIcon', args) || ''; }
  function refreshMarkerIcons(...args){ return projectMapInvoke('refreshMarkerIcons', args); }
  function clearAllPins(...args){ return projectMapInvoke('clearAllPins', args); }
  function removePin(...args){ return projectMapInvoke('removePin', args); }
  function addPin(...args){ return projectMapInvoke('addPin', args); }
  function getMarkersData(...args){ return projectMapInvoke('getMarkersData', args) || []; }
  function finiteCoord(...args){ return projectMapInvoke('finiteCoord', args); }
  function normalizeProjectPins(...args){ return projectMapInvoke('normalizeProjectPins', args) || []; }
  function setCoords(...args){ return projectMapInvoke('setCoords', args); }
  function parseAddressComponents(...args){ return projectMapInvoke('parseAddressComponents', args) || {}; }
  function reverseGeocode(...args){ return projectMapInvoke('reverseGeocode', args); }
  function loadPlaceResult(...args){ return projectMapInvoke('loadPlaceResult', args); }
  function forwardGeocode(...args){ return projectMapInvoke('forwardGeocode', args); }
  function latLngLiteral(...args){ return projectMapInvoke('latLngLiteral', args); }
  function setSafeMapZoom(...args){ return projectMapInvoke('setSafeMapZoom', args); }
  function applyMapControlsForMode(...args){ return projectMapInvoke('applyMapControlsForMode', args); }
  function fitMapToPins(...args){ return projectMapInvoke('fitMapToPins', args); }
  function focusMapOnProject(...args){ return projectMapInvoke('focusMapOnProject', args); }

  function collectCcEmails(){
    const rows = document.querySelectorAll('.r-cc-row input');
    const emails = [];
    rows.forEach((inp) => {
      const v = (inp.value || '').trim().toLowerCase();
      if (v && v.includes('@')) emails.push(v);
    });
    return emails;
  }

  function addCcRow(value, options = {}){
    const list = $('#rCcList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'r-cc-row';
    row.innerHTML = `<input class="r-inp" type="email" placeholder="${(globalThis.PlatformLanguage?.text("project-request","m_e91e3cd877a6d7","email@example.com") ?? "email@example.com")}" value="${String(escapeHtml(value || ''))}"><div class="r-cc-remove" data-fm-tooltip="Remove"><i class="fas fa-times"></i></div>`;
    row.querySelector('.r-cc-remove').addEventListener('click', () => { row.remove(); queueAutosaveNotice(); });
    list.appendChild(row);
    if (!options.hydrate) {
      queueAutosaveNotice();
      const inp = row.querySelector('input');
      if (inp) setTimeout(() => inp.focus(), 50);
    }
  }

  function cardContactId(card){
    return projectText(card?.dataset?.contactId, card?.dataset?.contact_id);
  }

  function contactHasCardInfo(contact = {}){
    return !!projectText(contact.name, contact.phone, contact.email, contact.address, contact.default_address);
  }

  function contactFromCard(card){
    if (!card) return {};
    const id = cardContactId(card);
    let customFieldValues = {};
    try { customFieldValues = JSON.parse(card.dataset.contactCustomFieldValues || '{}') || {}; }
    catch (_) { customFieldValues = {}; }
    return {
      id,
      contact_id: id,
      record_project_id: projectText(card.dataset.contactRecordProjectId),
      name: (card.querySelector('[data-field="name"]')?.value || '').trim(),
      phone: (card.querySelector('[data-field="phone"]')?.value || '').trim(),
      email: (card.querySelector('[data-field="email"]')?.value || '').trim(),
      address: projectText(card.dataset.contactAddress),
      default_address: projectText(card.dataset.contactAddress),
      custom_field_values: customFieldValues,
      primary: card.classList.contains('primary')
    };
  }

  function applyContactToCard(card, contact = {}){
    if (!card) return;
    const id = projectText(contact.id, contact.contact_id) || `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    card.dataset.contactId = id;
    card.dataset.contactAddress = projectText(contact.address, contact.default_address);
    card.dataset.contactRecordProjectId = projectText(contact.record_project_id, contact.project_id);
    card.dataset.contactCustomFieldValues = JSON.stringify(contact.custom_field_values || contact.contact_custom_field_values || {});
    const set = (field, value) => {
      const input = card.querySelector(`[data-field="${field}"]`);
      if (input) input.value = projectText(value);
    };
    set('name', contact.name);
    set('phone', contact.phone);
    set('email', contact.email);
  }

  function saveStandaloneContact(contact = {}){
    if (!window.Portal?.ProjectStore || !contactHasCardInfo(contact)) return null;
    const existingRecord = findStandaloneContactRecord(contact);
    const id = projectText(contact.id, contact.contact_id) || `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const projectId = projectText(contact.record_project_id, existingRecord?.id) || `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const payload = {
      ...(existingRecord || {}),
      id: projectId,
      title: projectText(contact.name, contact.email, contact.phone, contact.address, 'Contact'),
      project_title: projectText(contact.name, contact.email, contact.phone, contact.address, 'Contact'),
      address: projectText(contact.address),
      project_type: 'residential',
      contacts: [{
        id,
        contact_id: id,
        name: projectText(contact.name),
        phone: projectText(contact.phone),
        email: projectText(contact.email),
        address: projectText(contact.address),
        default_address: projectText(contact.address),
        custom_field_values: { ...(contact.custom_field_values || {}) },
        primary: true
      }],
      contact_custom_field_values: { ...(contact.custom_field_values || {}) },
      contact_id: id,
      primary_contact_id: id,
      contact_ids: [id],
      workflow_state: 'contact_only',
      measurement: {},
      measurement_project: {},
      events: [],
      proposals: [],
      photos: [],
      updated_at: new Date().toISOString()
    };
    return window.Portal.ProjectStore.save(payload);
  }

  function openContactFromCard(card){
    if (!contactsEnabled()) return;
    const contact = contactFromCard(card);
    const contactContext = activeContactContext;
    const currentContextId = projectText(contactContext?.contact?.id, contactContext?.contact?.contact_id);
    if (currentContextId && projectText(contact.id, contact.contact_id) === currentContextId) {
      close({ skipHistory:true });
      window.Portal?.modules?.contacts?.open?.(contactContext.contact, { projects: contactContext.projects || [] });
      return;
    }
    close({ skipHistory:true });
    window.Portal?.modules?.contacts?.open?.(contact, { projects: activeBaseProject ? [activeBaseProject] : [] });
  }

  function removeContactCard(card){
    const list = $('#rContactList');
    const cards = [...(list?.querySelectorAll('.r-contact-card') || [])];
    if (!card || cards.length <= 1) return;
    const contact = contactFromCard(card);
    const removedIndex = Number(card.dataset.contactIndex || 0) || 0;
    if (contactHasCardInfo(contact)) saveStandaloneContact(contact);
    card.remove();
    if (primaryContactIndex === removedIndex) primaryContactIndex = 0;
    else if (primaryContactIndex > removedIndex) primaryContactIndex -= 1;
    refreshContactCards();
    updateModalTitle();
    queueAutosaveNotice();
    persistActiveBaseProject();
  }

  function closeContactActionMenu(){
    const menu = $('#rContactActionMenu');
    if (menu) {
      menu.classList.remove('visible');
      menu.dataset.contactIndex = '';
      menu.innerHTML = '';
    }
  }

  function ensureContactActionMenu(){
    let menu = $('#rContactActionMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'rContactActionMenu';
    menu.className = 'r-contact-action-menu';
    document.body.appendChild(menu);
    if (!document.__fmContactActionMenuCloseBound) {
      document.__fmContactActionMenuCloseBound = true;
      document.addEventListener('mousedown', (event) => {
        const active = $('#rContactActionMenu.visible');
        if (!active) return;
        if (active.contains(event.target) || event.target.closest('.r-contact-menu-btn')) return;
        closeContactActionMenu();
      });
    }
    return menu;
  }

  function positionContactActionMenu(menu, anchor){
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) return;
    const width = 188;
    menu.style.width = `${width}px`;
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
    const topBelow = rect.bottom + 6;
    const estimatedHeight = Math.min(190, window.innerHeight - 24);
    const top = topBelow + estimatedHeight <= window.innerHeight ? topBelow : Math.max(12, rect.top - estimatedHeight - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function openContactActionMenu(card, anchor){
    if (!contactsEnabled()) return;
    if (!card) return;
    const existing = $('#rContactActionMenu.visible');
    if (existing && existing.dataset.contactIndex === String(card.dataset.contactIndex || '')) {
      closeContactActionMenu();
      return;
    }
    closeContactPicker();
    const menu = ensureContactActionMenu();
    const cards = [...($('#rContactList')?.querySelectorAll('.r-contact-card') || [])];
    const index = Number(card.dataset.contactIndex || 0) || 0;
    const isPrimary = index === primaryContactIndex;
    const canRemove = cards.length > 1;
    menu.dataset.contactIndex = String(card.dataset.contactIndex || '');
    menu.innerHTML = `
      ${String(isPrimary ? '' : '<button type="button" data-contact-menu-action="primary"><i class="fas fa-star"></i><span>Make primary</span></button>')}
      <button type="button" data-contact-menu-action="view"><i class="fas fa-address-book"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_94b3d11b415704","View contact") ?? "View contact")}</span></button>
      <button type="button" data-contact-menu-action="new"><i class="fas fa-plus"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_9ed0a85dcdfd8e","New contact") ?? "New contact")}</span></button>
      <button type="button" class="danger" data-contact-menu-action="remove"${String(canRemove ? '' : ' disabled')}><i class="fas fa-times"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_ea7197edfa259b","Remove from project") ?? "Remove from project")}</span></button>
    `;
    menu.querySelectorAll('[data-contact-menu-action]').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const action = button.dataset.contactMenuAction;
        closeContactActionMenu();
        if (action === 'primary') {
          makeContactPrimary(card);
        } else if (action === 'view') {
          openContactFromCard(card);
        } else if (action === 'new') {
          openContactPicker(anchor);
        } else if (action === 'remove') {
          removeContactCard(card);
        }
      });
    });
    menu.classList.add('visible');
    positionContactActionMenu(menu, anchor);
  }

  function makeContactPrimary(card){
    if (!contactsEnabled()) return;
    const list = $('#rContactList');
    if (list && card && list.firstElementChild !== card) list.insertBefore(card, list.firstElementChild);
    primaryContactIndex = 0;
    refreshContactCards();
    updateModalTitle();
    queueAutosaveNotice();
    persistActiveBaseProject();
  }

  function createContactCard(index, values = {}){
    const wrap = document.createElement('div');
    wrap.className = 'r-contact-card';
    wrap.dataset.contactIndex = String(index);
    const contactId = projectText(values.id, values.contact_id);
    if (contactId) wrap.dataset.contactId = contactId;
    const contactAddress = projectText(values.address, values.default_address);
    if (contactAddress) wrap.dataset.contactAddress = contactAddress;
    const recordProjectId = projectText(values.record_project_id, values.project_id);
    if (recordProjectId) wrap.dataset.contactRecordProjectId = recordProjectId;
    wrap.dataset.contactCustomFieldValues = JSON.stringify(values.custom_field_values || values.contact_custom_field_values || {});
    if (values.primary || index === primaryContactIndex) wrap.classList.add('primary');
    wrap.innerHTML = `
      <div class="r-mobile-customer-label">${(globalThis.PlatformLanguage?.text("project-request","m_59b58b1850f257","Customer Info") ?? "Customer Info")}</div>
      <div class="r-inline">
        <div class="r-group">
          <label>${(globalThis.PlatformLanguage?.text("project-request","m_006d986794e9db","Name ") ?? "Name ")}<span class="r-label-optional">${(globalThis.PlatformLanguage?.text("project-request","m_c79f78a53be623","- optional") ?? "- optional")}</span></label>
          <input class="r-inp" data-field="name" placeholder="${(globalThis.PlatformLanguage?.text("project-request","m_8cf345002184e5","Name") ?? "Name")}" value="${String(escapeHtml(values.name || ''))}">
        </div>
        <div class="r-group">
          <label>${(globalThis.PlatformLanguage?.text("project-request","m_432606fa294b6c","Phone ") ?? "Phone ")}<span class="r-label-optional">${(globalThis.PlatformLanguage?.text("project-request","m_c79f78a53be623","- optional") ?? "- optional")}</span></label>
          <input class="r-inp" data-field="phone" placeholder="${(globalThis.PlatformLanguage?.text("project-request","m_ed04c65845180f","Phone") ?? "Phone")}" type="tel" value="${String(escapeHtml(values.phone || ''))}">
        </div>
      </div>
      <div class="r-contact-email-row">
        <div class="r-group">
          <label>${(globalThis.PlatformLanguage?.text("project-request","m_374bb9c6199652","Email ") ?? "Email ")}<span class="r-label-optional">${(globalThis.PlatformLanguage?.text("project-request","m_c79f78a53be623","- optional") ?? "- optional")}</span></label>
          <input class="r-inp" data-field="email" placeholder="${(globalThis.PlatformLanguage?.text("project-request","m_5d2b9327181e33","Email") ?? "Email")}" type="email" value="${String(escapeHtml(values.email || ''))}">
        </div>
      </div>
      <div class="r-contact-actions">
        <button type="button" class="r-contact-primary" data-fm-tooltip="Primary Contact"><i class="fas fa-star"></i></button>
        <button type="button" class="r-contact-menu-btn" data-fm-tooltip="Contact Actions"><i class="fas fa-ellipsis"></i></button>
      </div>
    `;
    wrap.querySelector('.r-contact-primary')?.addEventListener('click', () => makeContactPrimary(wrap));
    wrap.querySelector('.r-contact-menu-btn')?.addEventListener('click', (event) => openContactActionMenu(wrap, event.currentTarget));
    return wrap;
  }

  function refreshContactCards(){
    const list = $('#rContactList');
    if (!list) return;
    const cards = [...list.querySelectorAll('.r-contact-card')];
    if (primaryContactIndex >= cards.length) primaryContactIndex = 0;
    list.classList.toggle('has-multiple', cards.length > 1);
    list.querySelectorAll('.r-contact-email-row.has-add').forEach((row) => row.classList.remove('has-add'));
    cards.forEach((card) => card.classList.remove('has-inline-add'));
    cards.forEach((card, index) => {
      card.dataset.contactIndex = String(index);
      card.classList.toggle('primary', index === primaryContactIndex);
      card.classList.toggle('has-inline-add', index === cards.length - 1);
      card.querySelector('.r-contact-email-row')?.classList.toggle('has-add', index === cards.length - 1);
      const removeBtn = card.querySelector('.r-contact-remove');
      if (removeBtn) removeBtn.disabled = cards.length === 1;
    });
  }

  function addContactCard(values = {}, options = {}){
    const list = $('#rContactList');
    if (!list) return;
    const card = createContactCard(list.querySelectorAll('.r-contact-card').length, values);
    list.appendChild(card);
    refreshContactCards();
    updateModalTitle();
    if (options.hydrate) return;
    queueAutosaveNotice();
    if (options.deferPersist) setTimeout(persistActiveBaseProject, 0);
    else persistActiveBaseProject();
    if (options.reveal) revealInLeftColumnIfBelow(card);
  }

  function contactLookupKey(contact = {}){
    const id = projectText(contact.id, contact.contact_id);
    return id ? `id:${id}` : '';
  }

  function findStandaloneContactRecord(contact = {}){
    if (!window.Portal?.ProjectStore) return null;
    const explicitId = projectText(contact.record_project_id, contact.project_id);
    if (explicitId) {
      const explicit = window.Portal.ProjectStore.get?.(explicitId);
      if (explicit?.workflow_state === 'contact_only') return explicit;
    }
    const ids = window.Portal.ProjectStore.cachedIds?.() || [];
    for (const id of ids) {
      const project = window.Portal.ProjectStore.get?.(id);
      if (project?.workflow_state !== 'contact_only') continue;
      if (contactCandidatesFromProject(project).some((candidate) => contactMatchesContact(candidate, contact))) return project;
    }
    return null;
  }

  function contactMatchesContact(a = {}, b = {}){
    const aId = projectText(a.id, a.contact_id);
    const bId = projectText(b.id, b.contact_id);
    return !!(aId && bId && aId === bId);
  }

  function projectFromPlatformDocument(doc = {}){
    const data = doc?.data && typeof doc.data === 'object' ? doc.data : {};
    const id = projectText(data.platform_project_id, data.base_project_id, data.id, doc.id);
    return id ? { ...data, id, platform_project_id: projectText(data.platform_project_id, id), base_project_id: projectText(data.base_project_id, id) } : null;
  }

  function contactCandidatesFromProject(project = {}){
    const projectId = projectIdentity(project);
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    return [projectPrimaryContactAlias(project), ...contacts].map((contact, index) => {
      const id = index === 0
        ? projectText(contact.id, contact.contact_id, project.contact_id, project.primary_contact_id)
        : projectText(contact.id, contact.contact_id);
      return {
        id,
        contact_id: id,
        record_project_id: project.workflow_state === 'contact_only' ? projectId : '',
        project_id: project.workflow_state === 'contact_only' ? projectId : '',
        name: projectText(contact.name),
        phone: projectText(contact.phone),
        email: projectText(contact.email),
        address: projectText(contact.address, contact.default_address, project.workflow_state === 'contact_only' ? project.address : ''),
        default_address: projectText(contact.default_address, contact.address, project.workflow_state === 'contact_only' ? project.address : '')
      };
    }).filter(contactHasCardInfo);
  }

  function cachedContactPickerProjects(){
    return (window.Portal?.ProjectStore?.cachedIds?.() || [])
      .map((id) => window.Portal.ProjectStore?.get?.(id))
      .filter(Boolean);
  }

  function applyContactPickerProjects(projects = []){
    const seenProjects = new Set();
    const allProjects = projects.filter((project) => {
      const id = projectIdentity(project);
      if (!id || seenProjects.has(id)) return false;
      seenProjects.add(id);
      return true;
    });
    const seenContacts = new Set();
    const currentContacts = collectContacts();
    contactPickerOptions = allProjects
      .flatMap(contactCandidatesFromProject)
      .filter((contact) => !currentContacts.some((current) => contactMatchesContact(current, contact)))
      .filter((contact) => {
        const key = contactLookupKey(contact);
        if (!key || seenContacts.has(key)) return false;
        seenContacts.add(key);
        return true;
      })
      .sort((a, b) => projectText(a.name, a.email, a.phone).localeCompare(projectText(b.name, b.email, b.phone)));
    return contactPickerOptions;
  }

  async function loadContactPickerOptions(options = {}){
    const cached = cachedContactPickerProjects();
    if (options.remote === false) return applyContactPickerProjects(cached);
    const oid = projectOrgId();
    let remote = [];
    if (oid && window.PlatformAPI?.projects?.list) {
      const result = await window.PlatformAPI.projects.list(oid).catch(() => ({ documents: [], projects: [] }));
      remote = [
        ...(result.documents || []).map(projectFromPlatformDocument),
        ...(result.projects || [])
      ].filter(Boolean);
      remote.forEach((project) => window.Portal?.ProjectStore?.cache?.(project));
    }
    return applyContactPickerProjects([...cached, ...remote]);
  }

  function ensureContactPicker(){
    let picker = $('#rContactPicker');
    if (picker) return picker;
    picker = document.createElement('div');
    picker.id = 'rContactPicker';
    picker.className = 'r-contact-picker';
    picker.innerHTML = `
      <input class="r-contact-picker-search" id="rContactPickerSearch" placeholder="${(globalThis.PlatformLanguage?.text("project-request","m_b753851275b3e8","Search contacts") ?? "Search contacts")}">
      <div class="r-contact-picker-list" id="rContactPickerList"></div>
      <button type="button" class="r-contact-picker-new" id="rContactPickerNew"><i class="fas fa-plus"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_4f460d87ee9426","Create new contact") ?? "Create new contact")}</span></button>
    `;
    document.body.appendChild(picker);
    picker.querySelector('#rContactPickerSearch')?.addEventListener('input', renderContactPicker);
    picker.querySelector('#rContactPickerNew')?.addEventListener('click', () => {
      closeContactPicker();
      addContactCard({
        id: `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
      }, { reveal: true, deferPersist: true });
      const cards = [...($('#rContactList')?.querySelectorAll('.r-contact-card') || [])];
      cards[cards.length - 1]?.querySelector('[data-field="name"]')?.focus();
    });
    if (!document.__fmContactPickerCloseBound) {
      document.__fmContactPickerCloseBound = true;
      document.addEventListener('mousedown', (event) => {
        const active = $('#rContactPicker.visible');
        if (!active) return;
        if (active.contains(event.target) || event.target.closest('.r-contact-add')) return;
        closeContactPicker();
      });
    }
    return picker;
  }

  function closeContactPicker(){
    const picker = $('#rContactPicker');
    if (picker) picker.classList.remove('visible');
  }

  function positionContactPicker(anchor){
    const picker = ensureContactPicker();
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) return;
    const width = Math.min(360, Math.max(280, window.innerWidth - 36));
    picker.style.width = `${width}px`;
    const left = Math.min(window.innerWidth - width - 18, Math.max(18, rect.right - width));
    const below = rect.bottom + 8;
    const height = Math.min(360, window.innerHeight - 36);
    const top = below + height <= window.innerHeight ? below : Math.max(18, rect.top - height - 8);
    picker.style.left = `${left}px`;
    picker.style.top = `${top}px`;
  }

  function renderContactPicker(){
    const picker = ensureContactPicker();
    const list = picker.querySelector('#rContactPickerList');
    const query = projectText(picker.querySelector('#rContactPickerSearch')?.value).toLowerCase();
    const loading = picker.dataset.loading === 'true';
    if (!list) return;
    const matches = contactPickerOptions.filter((contact) => {
      const haystack = [contact.name, contact.email, contact.phone, contact.address].map(projectText).join(' ').toLowerCase();
      return !query || haystack.includes(query);
    });
    if (!matches.length) {
      list.innerHTML = `<div class="r-contact-picker-empty">${query ? 'No matching contacts' : (loading ? 'Loading saved contacts...' : 'No saved contacts yet')}</div>`;
      return;
    }
    list.innerHTML = matches.map((contact, index) => {
      const title = projectText(contact.name, contact.email, contact.phone, 'Contact');
      const meta = [contact.email, contact.phone, contact.address].map(projectText).filter(Boolean).join(' - ');
      return `
        <button type="button" class="r-contact-picker-row" data-contact-picker-index="${index}">
          <i class="fas fa-address-book"></i>
          <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta || 'Saved contact')}</small></span>
        </button>
      `;
    }).join('');
    list.querySelectorAll('[data-contact-picker-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const contact = matches[Number(button.dataset.contactPickerIndex || 0)] || {};
        closeContactPicker();
        addContactCard(contact, { reveal: true, deferPersist: true });
      });
    });
  }

  function openContactPicker(anchor){
    if (!contactsEnabled()) return;
    const picker = ensureContactPicker();
    const token = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    picker.dataset.loadToken = token;
    picker.dataset.loading = 'true';
    picker.classList.add('visible');
    picker.querySelector('#rContactPickerSearch').value = '';
    positionContactPicker(anchor);
    contactPickerOptions = [];
    renderContactPicker();
    picker.querySelector('#rContactPickerSearch')?.focus();
    setTimeout(() => {
      if (!picker.classList.contains('visible') || picker.dataset.loadToken !== token) return;
      loadContactPickerOptions({ remote: false });
      renderContactPicker();
      contactPickerLoadPromise = loadContactPickerOptions();
      contactPickerLoadPromise
        .catch(() => [])
        .then(() => {
          if (!picker.classList.contains('visible') || picker.dataset.loadToken !== token) return;
          picker.dataset.loading = 'false';
          renderContactPicker();
        });
    }, 0);
  }

  function collectContacts(){
    const list = $('#rContactList');
    if (!list) return [];
    const savedContacts = Array.isArray(activeBaseProject?.contacts) ? activeBaseProject.contacts : [];
    const assignedByIdentity = new Map();
    return [...list.querySelectorAll('.r-contact-card')].map((card, index) => {
      const address = projectText(card.dataset.contactAddress);
      const contact = {
        id: cardContactId(card),
        contact_id: cardContactId(card),
        name: (card.querySelector('[data-field="name"]')?.value || '').trim(),
        phone: (card.querySelector('[data-field="phone"]')?.value || '').trim(),
        email: (card.querySelector('[data-field="email"]')?.value || '').trim(),
        address,
        default_address: address,
        primary: index === primaryContactIndex,
      };
      if (!projectText(contact.name, contact.phone, contact.email, contact.address)) return contact;
      const emailKey = projectText(contact.email).toLowerCase();
      const phoneKey = projectText(contact.phone).replace(/\D+/g, '');
      const nameKey = projectText(contact.name).toLowerCase().replace(/\s+/g, ' ');
      const identityKey = emailKey ? `email:${emailKey}` : (phoneKey.length >= 7 ? `phone:${phoneKey}` : (nameKey ? `name:${nameKey}` : ''));
      let id = projectText(contact.id, contact.contact_id);
      if (!id && identityKey) id = projectText(assignedByIdentity.get(identityKey));
      if (!id) id = projectText(savedContacts[index]?.id, savedContacts[index]?.contact_id);
      if (!id && index === primaryContactIndex) id = projectText(activeBaseProject?.contact_id, activeBaseProject?.primary_contact_id);
      if (!id) id = `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      card.dataset.contactId = id;
      if (identityKey) assignedByIdentity.set(identityKey, id);
      return {
        ...contact,
        id,
        contact_id: id,
      };
    }).filter((contact) => projectText(contact.id, contact.name, contact.phone, contact.email, contact.address));
  }

  function primaryContact(){
    const contacts = collectContacts();
    return contacts.find((contact) => contact.primary) || contacts[0] || {};
  }

  function projectText(...values){
    for (const value of values) {
      if (value && typeof value === 'object') continue;
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  function projectTitleAlias(project = {}){
    return projectText(project.title, project.project_title, project.project_name, project.projectName, project.name);
  }

  function projectPrimaryContactAlias(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const contact = contacts.find((entry) => projectText(entry?.name, entry?.email, entry?.phone)) || {};
    const resident = project.resident && typeof project.resident === 'object' && !Array.isArray(project.resident) ? project.resident : {};
    const customer = project.customer && typeof project.customer === 'object' && !Array.isArray(project.customer) ? project.customer : {};
    return {
      id: projectText(contact.id, contact.contact_id, project.contact_id, project.primary_contact_id),
      name: projectText(contact.name, project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === 'string' ? project.resident : '', customer.name, resident.name),
      email: projectText(contact.email, project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail, customer.email, resident.email),
      phone: projectText(contact.phone, project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone, customer.phone, resident.phone),
      address: projectText(contact.address, contact.default_address, project.contact_address, project.customer_address, project.primary_contact_address, customer.address, resident.address)
    };
  }

  function projectIdentity(project = {}){
    project = project || {};
    return projectText(project.id, project.platform_project_id, project.base_project_id);
  }

  function normalizeContactContext(context = null, selectedProject = null){
    if (!context || typeof context !== 'object') return null;
    const contactSource = context.contact && typeof context.contact === 'object' ? context.contact : context;
    const selectedContact = projectPrimaryContactAlias(selectedProject || {});
    const contact = {
      id: projectText(contactSource.id, selectedContact.id),
      name: projectText(contactSource.name, contactSource.customer_name, selectedContact.name),
      email: projectText(contactSource.email, selectedContact.email),
      phone: projectText(contactSource.phone, selectedContact.phone),
      address: projectText(contactSource.address, contactSource.default_address, contactSource.contact_address, selectedProject?.contact_address, selectedProject?.customer_address, selectedProject?.primary_contact_address)
    };
    const projects = [];
    const seen = new Set();
    [...(Array.isArray(context.projects) ? context.projects : []), selectedProject].forEach((project) => {
      if (!project || typeof project !== 'object') return;
      const id = projectIdentity(project);
      if (!id || seen.has(id)) return;
      seen.add(id);
      projects.push({ ...project, id });
    });
    return { contact, projects };
  }

  function renderContactContextBar(){
    const win = document.querySelector('#rOverlay .r-win');
    const bar = $('#rContactContextBar');
    if (!win || !bar) return;
    const context = activeContactContext;
    win.classList.toggle('contact-mode', !!context);
    if (!context) {
      bar.innerHTML = '';
      return;
    }
    const currentId = projectIdentity(activeBaseProject || {});
    const contactLabel = projectText(context.contact?.name, context.contact?.email, context.contact?.phone, 'Contact');
    const tabs = (context.projects || []).map((project) => {
      const id = projectIdentity(project);
      const label = projectText(projectTitleAlias(project), project.address, 'Project');
      return `<button type="button" class="r-contact-context-tab ${id === currentId ? 'active' : ''}" data-contact-project-id="${escapeHtml(id)}"><i class="fas fa-folder"></i><span>${escapeHtml(label)}</span></button>`;
    }).join('');
    bar.innerHTML = `
      <div class="r-contact-context-main">
        <button type="button" class="r-contact-context-back" data-contact-context-overview="1">
          <i class="fas fa-address-book"></i>
          <span>${escapeHtml(contactLabel)}</span>
        </button>
      </div>
      <div class="r-contact-context-tabs">
        ${tabs || `<div class="r-contact-context-empty">${(globalThis.PlatformLanguage?.text("project-request","m_b0390c8bca193d","No other projects") ?? "No other projects")}</div>`}
      </div>
    `;
  }

  function contactIdFromRecord(record = {}){
    return projectText(record.id, record.contact_id, record.primary_contact_id);
  }

  function contactHasDisplayInfo(contact = {}){
    return !!projectText(contact.name, contact.email, contact.phone);
  }

  function contactForProjectModal(project = {}){
    const contacts = Array.isArray(project.contacts) ? project.contacts : [];
    const contextContact = activeContactContext?.contact || {};
    const contextId = contactIdFromRecord(contextContact);
    const projectContactIds = [
      project.contact_id,
      project.primary_contact_id,
      ...(Array.isArray(project.contact_ids) ? project.contact_ids : []),
      ...contacts.map(contactIdFromRecord)
    ].map((value) => projectText(value)).filter(Boolean);
    const contextApplies = !!(
      contextId && projectContactIds.includes(contextId)
    );
    const concrete = contacts
      .filter(contactHasDisplayInfo)
      .map((contact) => ({ ...contact }));
    if (!contextApplies || !contactHasDisplayInfo(contextContact)) return concrete;
    const existingIndex = concrete.findIndex((contact) => {
      const id = contactIdFromRecord(contact);
      return contextId && id === contextId;
    });
    const displayContact = {
      id: contextId || contactIdFromRecord(concrete[existingIndex] || {}),
      contact_id: contextId || contactIdFromRecord(concrete[existingIndex] || {}),
      name: contextContact.name || '',
      email: contextContact.email || '',
      phone: contextContact.phone || '',
      address: contextContact.address || '',
      primary: true
    };
    if (existingIndex >= 0) concrete[existingIndex] = { ...concrete[existingIndex], ...displayContact };
    else concrete.unshift(displayContact);
    concrete.forEach((contact, index) => { contact.primary = index === (existingIndex >= 0 ? existingIndex : 0); });
    return concrete;
  }

  function manualProjectTitle(){
    if ((branchProjectConfig?.title_mode || 'customer_name') !== 'manual') return '';
    return projectText(document.getElementById('rProjectTitleInput')?.value, projectTitleAlias(activeBaseProject || {}));
  }

  function projectOrgId(){
    return String(cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || '').trim();
  }

  function trackRequestActivity(event = {}, metadata = {}){
    const project = activeBaseProject || {};
    const oid = projectOrgId();
    if (!oid) return null;
    return window.Portal?.PhotoFeed?.trackActivity?.({
      actor_user_id: String(cfg.userId || window.__APP?.userId || ''),
      actor_name: String(cfg.userName || window.__APP?.userName || cfg.userEmail || ''),
      actor_email: String(cfg.userEmail || window.__APP?.userEmail || ''),
      target: {
        project_id: project.id || '',
        project_title: projectTitleAlias(project) || project.address || '',
        project_address: project.address || project.project_address || '',
        ...(event.target || {})
      },
      ...event
    }, metadata) || window.PlatformAPI?.userActivity?.track?.(oid, event, metadata).catch(() => null);
  }

  function escapeHtml(value){
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatCurrency(value){
    const num = Number(value || 0);
    return `$${num.toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

  function getPricebookModule(){
    return window.Portal.modules?.pricebook || null;
  }

  const PROPOSAL_PITCH_FIELDS = [
    { key: 'flatRoofSquares', label: '<=2/12' },
    { key: 'pitch2to4Squares', label: '2-4/12' },
    { key: 'pitch4to6Squares', label: '4-6/12' },
    { key: 'pitch6to8Squares', label: '6-8/12' },
    { key: 'pitch9to12Squares', label: '9-12/12' },
    { key: 'pitch13PlusSquares', label: '13+/12' },
  ];
  const PROPOSAL_MEASUREMENT_FIELDS = [
    { key: 'wastePercent', label: (globalThis.PlatformLanguage?.text("project-request","m_185415b1d2c50e","Waste %") ?? "Waste %") },
    { key: 'eavesLf', label: (globalThis.PlatformLanguage?.text("project-request","m_440f5bc2a4a952","Eaves (LF)") ?? "Eaves (LF)") },
    { key: 'rakesLf', label: (globalThis.PlatformLanguage?.text("project-request","m_bf4b9cfb1b180a","Rakes (LF)") ?? "Rakes (LF)") },
    { key: 'hipsLf', label: (globalThis.PlatformLanguage?.text("project-request","m_2fcb2eeb6acb94","Hips (LF)") ?? "Hips (LF)") },
    { key: 'ridgesLf', label: (globalThis.PlatformLanguage?.text("project-request","m_c52328c3032f2e","Ridges (LF)") ?? "Ridges (LF)") },
    { key: 'valleyLf', label: (globalThis.PlatformLanguage?.text("project-request","m_e68824fd286246","Valleys (LF)") ?? "Valleys (LF)") },
    { key: 'transitionsLf', label: (globalThis.PlatformLanguage?.text("project-request","m_a38eff4477656a","Transitions (LF)") ?? "Transitions (LF)") },
    { key: 'sideWallLf', label: (globalThis.PlatformLanguage?.text("project-request","m_18d57aea0dc79e","Side Wall (LF)") ?? "Side Wall (LF)") },
    { key: 'headWallLf', label: (globalThis.PlatformLanguage?.text("project-request","m_4a283fa6e37581","Head Wall (LF)") ?? "Head Wall (LF)") },
    { key: 'gutterLf', label: (globalThis.PlatformLanguage?.text("project-request","m_7b63c9ab1a740a","Gutters (LF)") ?? "Gutters (LF)") },
    { key: 'downspoutLf', label: (globalThis.PlatformLanguage?.text("project-request","m_911bbaded09649","Downspouts (LF)") ?? "Downspouts (LF)") },
    { key: 'chimneysEa', label: (globalThis.PlatformLanguage?.text("project-request","m_2586b5b0f04d70","Chimneys") ?? "Chimneys") },
    { key: 'skylightsEa', label: (globalThis.PlatformLanguage?.text("project-request","m_f8cd783f0f9952","Skylights") ?? "Skylights") },
    { key: 'pipeBootsEa', label: (globalThis.PlatformLanguage?.text("project-request","m_e3f935307ef27c","Pipe Boots") ?? "Pipe Boots") },
    { key: 'roofVentsEa', label: (globalThis.PlatformLanguage?.text("project-request","m_684d328858cea9","Roof Vents") ?? "Roof Vents") },
    { key: 'ridgeVentLf', label: (globalThis.PlatformLanguage?.text("project-request","m_f3dd7d16439791","Ridge Vent (LF)") ?? "Ridge Vent (LF)") },
    { key: 'boxVentsEa', label: (globalThis.PlatformLanguage?.text("project-request","m_0293b757a0a77c","Box Vents") ?? "Box Vents") },
  ];

  function normalizeProjectConfig(config){
    const mode = String(config?.title_mode || config?.project_title_mode || 'customer_name').trim();
    const celebrationMode = String(config?.celebrations_mode || config?.celebrations?.mode || 'on').trim();
    const pillFields = Array.isArray(config?.project_header_pills) ? config.project_header_pills.map(cleanStageText).filter(Boolean) : ['scope_type','stage','dollar_value'];
    return {
      ...(config && typeof config === 'object' ? config : {}),
      title_mode: ['customer_name', 'address', 'manual'].includes(mode) ? mode : 'customer_name',
      celebrations_mode: ['on', 'small_only', 'off'].includes(celebrationMode) ? celebrationMode : 'on',
      project_header_pills: pillFields
    };
  }

  async function loadBranchProjectConfig(){
    if (!window.Portal.branchModules?.get) return branchProjectConfig;
    try {
      const doc = await window.Portal.branchModules.get(PROJECT_CONFIG_MODULE_ID);
      branchProjectConfig = normalizeProjectConfig(doc?.data || doc || {});
      window.PlatformCelebrations?.configure?.({ mode: branchProjectConfig.celebrations_mode });
    } catch (e) {
      branchProjectConfig = normalizeProjectConfig(null);
      window.PlatformCelebrations?.configure?.({ mode: branchProjectConfig.celebrations_mode });
      if (Number(e?.status || 0) !== 404) console.warn('Unable to load branch project configuration', e);
    }
    updateModalTitle();
    return branchProjectConfig;
  }

  function cleanStageText(value){
    return String(value ?? '').trim();
  }

  function humanizeStageId(id){
    return cleanStageText(id)
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function currentBranchId(){
    return cleanStageText(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || activeBaseProject?.branch_id || 'default') || 'default';
  }

  function projectActiveWorkInstances(project = activeBaseProject){
    const projection = project?.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    if (Array.isArray(projection.active_instances)) return projection.active_instances.filter((instance) => instance && typeof instance === 'object');
    const instances = Array.isArray(projection.instances) ? projection.instances : [];
    return instances.filter((instance) => instance && typeof instance === 'object' && (instance.status === 'active' || instance.status === 'pending'));
  }

  function projectLifecycleInfo(project = activeBaseProject){
    const projection = project?.work_projection && typeof project.work_projection === 'object' ? project.work_projection : {};
    if (projection.lifecycle && typeof projection.lifecycle === 'object') return projection.lifecycle;
    return (project?.lifecycle && typeof project.lifecycle === 'object') ? project.lifecycle : {};
  }

  let projectTagBoards = [];
  let projectTagBoardsLoaded = false;
  let projectTagBoardsPromise = null;

  function projectTagProposals(project = activeBaseProject){
    const fromProject = Array.isArray(project?.proposals) ? project.proposals : [];
    const fromWorkspace = Array.isArray(proposals) ? proposals : [];
    const seen = new Set();
    return [...fromProject, ...fromWorkspace].filter((proposal) => {
      const key = cleanStageText(proposal?.id || proposal?.proposal_id || proposal?.uuid) || proposal;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function signedProjectProposal(project = activeBaseProject){
    return projectTagProposals(project).find((proposal) => (
      ['signed', 'accepted', 'approved'].includes(String(proposal?.status || proposal?.state || proposal?.delivery?.status || proposal?.delivery_status || '').toLowerCase())
    )) || null;
  }

  function projectTagStatus(project = activeBaseProject){
    const instances = projectActiveWorkInstances(project);
    const primary = instances.find((instance) => instance.kind === 'pipeline') || instances[0] || null;
    const label = cleanStageText(primary?.stage_title || primary?.title);
    if (label) return label;
    const status = cleanStageText(projectLifecycleInfo(project).status).toLowerCase();
    if (status === 'lost') return 'Lost';
    if (status === 'completed') return 'Completed';
    if (status === 'canceled' || status === 'cancelled') return 'Cancelled';
    return '';
  }

  function projectTagBoard(project = activeBaseProject){
    const projectId = String(project?.id || project?.project_id || '').trim();
    const explicitBoardId = cleanStageText(project?.board_id || project?.work_board_id || project?.scope_id);
    const matched = projectTagBoards.find((board) => {
      if (explicitBoardId && String(board?.id || '') === explicitBoardId) return true;
      return (Array.isArray(board?.columns) ? board.columns : []).some((column) =>
        (Array.isArray(column?.cards) ? column.cards : []).some((card) => String(card?.project_id || card?.id || '') === projectId)
      );
    });
    if (matched) return matched;
    return projectTagBoards.find((board) => /sales/i.test(String(board?.title || board?.name || board?.id || ''))) || null;
  }

  function loadProjectTagBoards(){
    if (!expandedPlatformEnabled()) return Promise.resolve([]);
    const orgId = projectOrgId();
    if (projectTagBoardsLoaded || !orgId || !window.PlatformAPI?.work?.boards) return Promise.resolve(projectTagBoards);
    if (projectTagBoardsPromise) return projectTagBoardsPromise;
    projectTagBoardsPromise = window.PlatformAPI.work.boards(orgId, { includeCompleted:true }).then((result) => {
      projectTagBoards = Array.isArray(result?.boards) ? result.boards : [];
      projectTagBoardsLoaded = true;
      renderProjectStageBar();
      return projectTagBoards;
    }).catch((error) => {
      console.warn('Unable to load project tag colors', error);
      projectTagBoardsLoaded = true;
      return [];
    }).finally(() => { projectTagBoardsPromise = null; });
    return projectTagBoardsPromise;
  }

  function projectTagTotal(project = activeBaseProject){
    const values = [
      project?.project_total, project?.project_total_amount, project?.contract_total, project?.contract_value,
      project?.sale_total, project?.sold_total, project?.total_amount, project?.total_price,
      project?.financials?.project_total, project?.financials?.contract_total,
      project?.money?.project_total, project?.money?.project_total_cents != null ? Number(project.money.project_total_cents) / 100 : null
    ];
    const direct = values.map(Number).find((value) => Number.isFinite(value) && value > 0);
    if (direct != null) return direct;
    const proposalList = projectTagProposals(project);
    const accepted = signedProjectProposal(project) || proposalList[0];
    const proposalTotal = Number(accepted?.total ?? accepted?.grand_total ?? accepted?.total_amount ?? accepted?.amount);
    if (Number.isFinite(proposalTotal) && proposalTotal > 0) return proposalTotal;
    const calculatedTotal = Number(proposalPricingSummary(accepted)?.total);
    return Number.isFinite(calculatedTotal) && calculatedTotal >= 0 ? calculatedTotal : 0;
  }

  function projectTagDate(value){
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? cleanStageText(value) : date.toLocaleDateString(globalThis.PlatformLanguage?.formatLocale?.());
  }

  function projectScopeSetTag(project = activeBaseProject){
    const direct = project?.scope_template || project?.scope_set || project?.scope;
    const directId = cleanStageText(project?.scope_template_id || project?.scope_set_id || direct?.scope_template_id || direct?.template_id || direct?.id);
    const directName = cleanStageText(project?.scope_template_name || project?.scope_set_name || (directId ? (direct?.name || direct?.display_name) : ''));
    const directColor = cleanStageText(project?.scope_color || project?.scope_template_color || project?.scope_set_color || direct?.color);
    if (directName) return { name: directName, color: directColor };

    const proposal = signedProjectProposal(project) || projectTagProposals(project)[0];
    const roots = Array.isArray(proposal?.scope?.root_items)
      ? proposal.scope.root_items
      : (Array.isArray(proposal?.scope?.children) ? proposal.scope.children : []);
    const stack = [...roots];
    while (stack.length) {
      const item = stack.shift() || {};
      const name = cleanStageText(item.scope_template_name || item.template_name || item.display_name || item.name);
      if (cleanStageText(item.scope_template_id || item.template_id) && name) {
        return { name, color: cleanStageText(item.scope_color || item.color) };
      }
      if (Array.isArray(item.children)) stack.push(...item.children);
    }
    return null;
  }

  function projectManualStageContexts(project = activeBaseProject){
    const projectId = cleanStageText(project?.id || project?.project_id);
    if (!projectId) return [];
    const contexts = [];
    for (const board of projectTagBoards) {
      const columns = Array.isArray(board?.columns) ? board.columns : [];
      for (const column of columns) {
        const card = (Array.isArray(column?.cards) ? column.cards : []).find((item) => cleanStageText(item?.project_id || item?.id) === projectId);
        if (!card?.plan_id) continue;
        contexts.push({ board, column, card, planId:cleanStageText(card.plan_id), columns });
      }
    }
    const seen = new Set();
    return contexts.filter((context) => {
      if (seen.has(context.planId)) return false;
      seen.add(context.planId);
      return true;
    });
  }

  function closeManualStagePicker(){
    document.querySelector('#rOverlay .r-manual-stage-backdrop')?.remove();
  }

  function openManualStagePicker(){
    closeManualStagePicker();
    const contexts = projectManualStageContexts();
    if (!contexts.length) {
      window.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("project-request","m_a665e8249df2aa","Stage unavailable") ?? "Stage unavailable"), (globalThis.PlatformLanguage?.text("project-request","m_e4f8d91f496ad2","This project is not on an active work board yet.") ?? "This project is not on an active work board yet."), false);
      return;
    }
    const overlay = document.getElementById('rOverlay');
    if (!overlay) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'r-manual-stage-backdrop';
    backdrop.innerHTML = `<section class="r-manual-stage-dialog" role="dialog" aria-modal="true" aria-labelledby="rManualStageTitle"><header class="r-manual-stage-head"><i class="fas fa-arrows-left-right" aria-hidden="true"></i><div class="r-manual-stage-head-copy"><h3 id="rManualStageTitle">${(globalThis.PlatformLanguage?.text("project-request","m_a12d99be8366cc","Move to another stage") ?? "Move to another stage")}</h3><p>${(globalThis.PlatformLanguage?.text("project-request","m_73f44538c28f3e","Choose the board and the stage where this project should appear.") ?? "Choose the board and the stage where this project should appear.")}</p></div><button type="button" class="r-manual-stage-close" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button></header><div class="r-manual-stage-body"></div></section>`;
    overlay.appendChild(backdrop);
    const body = backdrop.querySelector('.r-manual-stage-body');
    let activeContext = contexts[0];
    const render = () => {
      body.innerHTML = (String(contexts.length > 1 ? `<label><span class="r-manual-stage-board-label">Board</span><select class="r-manual-stage-board-select">${contexts.map((context) => `<option value="${escapeHtml(context.planId)}" ${context.planId === activeContext.planId ? 'selected' : ''}>${escapeHtml(context.board.title || context.board.id || 'Board')}</option>`).join('')}</select></label>` : `<span class="r-manual-stage-board-label">${escapeHtml(activeContext.board.title || activeContext.board.id || 'Board')}</span>`) + "<div class=\"r-manual-stage-list\">" + String(activeContext.columns.map((column) => {
        const current = cleanStageText(column.id) === cleanStageText(activeContext.column.id);
        return `<button type="button" class="r-manual-stage-option ${current ? 'current' : ''}" data-stage-id="${escapeHtml(column.id)}" style="--stage-color:${escapeHtml(column.color || activeContext.board.color || '#667085')}"><span class="r-manual-stage-dot"></span><span><strong>${escapeHtml(column.title || 'Stage')}</strong><small>${escapeHtml(column.description || (current ? 'Current board stage' : 'Move this project here'))}</small></span>${current ? '<span class="r-manual-stage-current">Current</span>' : '<i class="fas fa-chevron-right" aria-hidden="true"></i>'}</button>`;
      }).join('')) + "</div><div class=\"r-manual-stage-note\"><i class=\"fas fa-circle-info\"></i><span>" + (globalThis.PlatformLanguage?.text("project-request","m_e227614ba32bfe","This changes board placement without completing or skipping workflow tasks. The next real workflow transition or automation takes control again.") ?? "This changes board placement without completing or skipping workflow tasks. The next real workflow transition or automation takes control again.") + "</span></div>");
      body.querySelector('.r-manual-stage-board-select')?.addEventListener('change', (event) => {
        activeContext = contexts.find((context) => context.planId === event.target.value) || contexts[0];
        render();
      });
      body.querySelectorAll('.r-manual-stage-option').forEach((option) => option.addEventListener('click', async () => {
        const stageId = cleanStageText(option.dataset.stageId);
        if (!stageId || stageId === cleanStageText(activeContext.column.id)) return;
        body.querySelectorAll('button,select').forEach((control) => { control.disabled = true; });
        try {
          const result = await window.PlatformAPI.work.setManualStage(projectOrgId(), activeContext.planId, stageId);
          const targetColumn = activeContext.columns.find((column) => cleanStageText(column.id) === stageId);
          for (const column of activeContext.columns) {
            column.cards = (Array.isArray(column.cards) ? column.cards : []).filter((card) => cleanStageText(card.plan_id) !== activeContext.planId);
          }
          if (targetColumn) targetColumn.cards = [...(targetColumn.cards || []), { ...activeContext.card, stage_id:stageId, manual_stage_override:true }];
          if (result?.projection) {
            activeBaseProject = { ...activeBaseProject, work_projection:result.projection };
            window.Portal?.ProjectStore?.save?.(activeBaseProject);
          }
          closeManualStagePicker();
          renderProjectStageBar();
          window.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("project-request","m_1bdd4e384f01a8","Stage updated") ?? "Stage updated"), ((v0) => globalThis.PlatformLanguage?.text("project-request","m_cc6d8119258484",`Project moved to ${v0}.`,{v0}) ?? `Project moved to ${v0}.`)(targetColumn?.title || 'the selected stage'), true);
        } catch (error) {
          body.querySelectorAll('button,select').forEach((control) => { control.disabled = false; });
          window.Portal?.ui?.showToast?.((globalThis.PlatformLanguage?.text("project-request","m_1bc89b9afda475","Stage not changed") ?? "Stage not changed"), error?.message || 'The project could not be moved.', false);
        }
      }));
    };
    render();
    backdrop.querySelector('.r-manual-stage-close')?.addEventListener('click', closeManualStagePicker);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeManualStagePicker(); });
    backdrop.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeManualStagePicker(); });
    backdrop.querySelector('.r-manual-stage-close')?.focus();
  }

  function projectHeaderPillHtml(field, project, board){
    if (String(field || '').startsWith('custom_field:')) {
      const path = String(field).slice('custom_field:'.length);
      const runtime = window.FirstMateCustomFields;
      const definition = runtime?.definitionsFor?.('project', project, { location:'all' })
        ?.find?.((candidate) => String(candidate.path || candidate.key) === path);
      if (!definition) return '';
      const value = runtime.valueFor(definition, project);
      const display = runtime.formatValue(definition, value);
      if (!display || display === 'Not set') {
        const emptyBehavior = definition.ui?.project_tag_empty_behavior || definition.ui?.empty_behavior || 'hide';
        if (emptyBehavior !== 'show') return '';
      }
      const icon = cleanStageText(definition.ui?.project_tag_icon || definition.ui?.icon)
        || (definition.data_type === 'reference' ? 'fa-user-tag' : 'fa-tag');
      const label = cleanStageText(definition.ui?.project_tag_label || definition.label);
      return `<div class="r-project-tag custom-field" title="${escapeHtml(label)}"><i class="fas ${escapeHtml(icon)}" aria-hidden="true"></i><span>${escapeHtml(display === 'Not set' ? `${label}: Unassigned` : display)}</span></div>`;
    }
    if (field === 'stage' && manualProjectStageMovementEnabled() && canManageProjectStages() && projectManualStageContexts(project).length) {
      const [primaryContext] = projectManualStageContexts(project);
      const status = cleanStageText(primaryContext?.column?.title) || projectTagStatus(project);
      if (!status) return '';
      return `<button type="button" class="r-project-tag status stage-editable" data-manual-stage-trigger title="${(globalThis.PlatformLanguage?.text("project-request","m_0aa4129cee6f73","Change board stage") ?? "Change board stage")}" aria-label="${((v0) => globalThis.PlatformLanguage?.text("project-request","m_c2b7110fd652f2",`Change board stage, currently ${v0}`,{v0}) ?? `Change board stage, currently ${v0}`)(escapeHtml(status))}" aria-haspopup="dialog"><i class="fas fa-circle-dot"></i><span>${String(escapeHtml(status))}</span><i class="fas fa-chevron-down"></i></button>`;
    }
    const scopeSet = projectScopeSetTag(project);
    const scopeColor = cleanStageText(scopeSet?.color) || '#4f7cac';
    const contact = projectPrimaryContactAlias(project || {});
    const propertyType = normalizedProjectType(project?.project_type || selectedType);
    const propertyTypeMeta = TYPE_META[propertyType] || null;
    const definitions = {
      scope_type: { icon:'fa-layer-group', value:scopeSet?.name || '', cls:'scope', style:`--tag-color:${scopeColor}`, title:(globalThis.PlatformLanguage?.text("project-request","m_db64d2c3e595d5","Scope set") ?? "Scope set") },
      stage: { icon:'fa-circle-dot', value:projectTagStatus(project), cls:'status' },
      dollar_value: { value:`$${fmtWholeMoney(projectTagTotal(project))}`, cls:'total' },
      start_date: { icon:'fa-calendar-day', value:projectTagDate(project?.start_date || project?.starts_at || project?.scheduled_start), cls:'' },
      end_date: { icon:'fa-calendar-check', value:projectTagDate(project?.end_date || project?.ends_at || project?.scheduled_end), cls:'' },
      customer: { icon:'fa-user', value:cleanStageText(contact?.name || project?.customer_name || project?.primary_contact_name), cls:'' },
      address: { icon:'fa-location-dot', value:cleanStageText(project?.address), cls:'' },
      owner: { icon:'fa-user-tie', value:cleanStageText(project?.owner_name || project?.project_owner_name || project?.assigned_to_name || project?.sales_rep_name), cls:'' },
      project_type: {
        value:propertyTypeMeta?.label || humanizeStageId(propertyType),
        cls:'property-type',
        html:`<button type="button" class="r-property-type-trigger" data-header-property-type aria-label="Change property type, currently ${escapeHtml(propertyTypeMeta?.label || humanizeStageId(propertyType))}" aria-haspopup="listbox" aria-expanded="false"><i class="fas ${escapeHtml(propertyTypeMeta?.icon || 'fa-house')} property-type-icon" aria-hidden="true"></i><span>${escapeHtml(propertyTypeMeta?.label || humanizeStageId(propertyType))}</span><i class="fas fa-chevron-down property-type-chevron" aria-hidden="true"></i></button>`
      },
      created_date: { icon:'fa-calendar-plus', value:projectTagDate(project?.created_at), cls:'' },
      updated_date: { icon:'fa-clock-rotate-left', value:projectTagDate(project?.updated_at), cls:'' },
      project_number: { icon:'fa-hashtag', value:cleanStageText(project?.project_number || project?.job_number || project?.number), cls:'' }
    };
    const item = definitions[field];
    if (!item?.value) return '';
    if (item.html) return `<div class="r-project-tag ${item.cls}">${item.html}</div>`;
    const icon = item.icon ? `<i class="fas ${item.icon}" aria-hidden="true"></i>` : '';
    return `<div class="r-project-tag ${item.cls}" ${item.style ? `style="${escapeHtml(item.style)}"` : ''} ${item.title ? `title="${escapeHtml(item.title)}"` : ''}>${icon}<span>${escapeHtml(item.value)}</span></div>`;
  }

  function workPlanStageNodes(plan = {}){
    const stages = [];
    const visit = (nodes = []) => (Array.isArray(nodes) ? nodes : []).forEach((node) => {
      if (String(node?.terminology_key || '').endsWith('stage')) stages.push(node);
      visit(node?.children);
    });
    visit(plan.root_nodes);
    return stages;
  }

  async function loadProjectWorkPlans(options = {}){
    if (!expandedPlatformEnabled()) return [];
    const projectId = String(activeBaseProject?.id || activeBaseProject?.project_id || '').trim();
    const orgId = projectOrgId();
    if (!projectId || !orgId || !window.PlatformAPI?.work?.plans) return [];
    if (projectWorkPlanState.projectId === projectId && projectWorkPlanState.loaded && !options.refresh) return projectWorkPlanState.plans;
    if (projectWorkPlanPromise && !options.refresh) return projectWorkPlanPromise;
    projectWorkPlanPromise = window.PlatformAPI.work.plans(orgId, projectId, { includeTree: true }).then((result) => {
      if (String(activeBaseProject?.id || '') !== projectId) return [];
      projectWorkPlanState = { projectId, plans: Array.isArray(result?.plans) ? result.plans : [], loaded: true };
      renderProjectStageBar();
      return projectWorkPlanState.plans;
    }).catch((error) => {
      console.warn('Unable to load project work plan', error);
      projectWorkPlanState = { projectId, plans: [], loaded: true };
      return [];
    }).finally(() => { projectWorkPlanPromise = null; });
    return projectWorkPlanPromise;
  }

  function renderWorkPlanStageBar(bar){
    const plans = projectWorkPlanState.plans || [];
    if (!plans.length) return false;
    const phases = plans.flatMap((plan) => (Array.isArray(plan.root_nodes) ? plan.root_nodes : []).map((phase) => ({
      plan,
      phase,
      stages: workPlanStageNodes({ root_nodes:[phase] })
    })));
    bar.hidden = false;
    bar.innerHTML = `
      <div class="r-stage-track" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_aa1db7f907b58f","Project work progress") ?? "Project work progress")}">
        <div class="r-work-phase-list">
          ${String(phases.map(({ plan, phase, stages }) => `
            <div class="r-work-phase" data-work-plan-id="${escapeHtml(plan.id || '')}">
              <span class="r-work-phase-name">${escapeHtml(phase.title || plan.title || 'Phase')}</span>
              <div class="r-stage-list">
                ${stages.map((stage, index) => {
                  const status = String(stage.status || 'pending');
                  const state = ['completed','skipped'].includes(status) ? 'done' : ['active','ready'].includes(status) ? 'current' : 'upcoming';
                  const icon = state === 'done' ? 'fa-check' : state === 'current' ? 'fa-circle-dot' : 'fa-circle';
                  return `${index ? '<i class="fas fa-arrow-right r-stage-arrow" aria-hidden="true"></i>' : ''}<div class="r-stage-pill ${state}" data-work-node-id="${escapeHtml(stage.id || '')}"><i class="fas ${icon}" aria-hidden="true"></i><span>${escapeHtml(stage.title || 'Stage')}</span></div>`;
                }).join('')}
              </div>
            </div>`).join(''))}
        </div>
      </div>`;
    return true;
  }

  function renderProjectStageBar(){
    closeHeaderPropertyTypeMenu();
    const bar = document.getElementById('rProjectStageBar');
    if (!bar) return;
    if (!expandedPlatformEnabled() || !shouldRenderDefaultProjectInfo() || !activeBaseProject) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    loadProjectTagBoards().catch(() => null);
    const board = projectTagBoard();
    const configuredFields = Array.isArray(branchProjectConfig?.project_header_pills) ? branchProjectConfig.project_header_pills : ['scope_type','stage','dollar_value'];
    const customFieldPills = window.FirstMateCustomFields?.definitionsFor?.('project', activeBaseProject, { location:'all' })
      ?.filter?.((definition) => projectAssignmentsEnabled() || definition.group_path !== 'assignments')
      ?.filter?.((definition) => definition.ui?.project_tag === true || definition.ui?.visible_tag === true)
      ?.map?.((definition) => `custom_field:${definition.path || definition.key}`) || [];
    const configuredWithCustomFields = [...new Set([...configuredFields, ...customFieldPills])];
    // Manual stage movement is an action, not merely an optional informational
    // header field. Keep its control visible even when a branch customized the
    // project pills before this feature existed.
    if (manualProjectStageMovementEnabled() && canManageProjectStages() && projectManualStageContexts(activeBaseProject).length
      && !configuredWithCustomFields.includes('stage')) {
      const scopeIndex = configuredWithCustomFields.indexOf('scope_type');
      configuredWithCustomFields.splice(scopeIndex >= 0 ? scopeIndex + 1 : 0, 0, 'stage');
    }
    const fields = newProjectCreationSession
      ? configuredWithCustomFields.filter((field) => field !== 'project_type')
      : [...configuredWithCustomFields.filter((field) => field !== 'project_type'), 'project_type'];
    const pills = fields.map((field) => projectHeaderPillHtml(field, activeBaseProject, board)).filter(Boolean).join('');
    if (!pills) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;
    bar.innerHTML = ("\n      <div class=\"r-project-tags\" aria-label=\"" + (globalThis.PlatformLanguage?.text("project-request","m_12e617b6b10c5c","Project details") ?? "Project details") + "\">\n        " + String(pills) + "\n      </div>\n    ");
    bindProjectStageBarWheel();
  }

  function closeHeaderPropertyTypeMenu(options = {}){
    if (!headerPropertyTypeMenu) return;
    const { menu, trigger } = headerPropertyTypeMenu;
    menu.remove();
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.closest('.property-type')?.classList.remove('menu-open');
    headerPropertyTypeMenu = null;
    if (options.restoreFocus) trigger?.focus();
  }

  function positionHeaderPropertyTypeMenu(menu, trigger){
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const width = Math.min(260, window.innerWidth - (gutter * 2));
    menu.style.width = `${width}px`;
    const left = Math.max(gutter, Math.min(window.innerWidth - width - gutter, rect.right - width));
    const menuHeight = menu.offsetHeight || 164;
    const opensAbove = rect.bottom + gutter + menuHeight > window.innerHeight && rect.top > menuHeight + gutter;
    const top = opensAbove ? rect.top - menuHeight - 6 : rect.bottom + 6;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(gutter, top))}px`;
    menu.style.transformOrigin = `${rect.left + (rect.width / 2) - left}px ${opensAbove ? 'bottom' : 'top'}`;
  }

  function openHeaderPropertyTypeMenu(trigger){
    if (headerPropertyTypeMenu?.trigger === trigger) {
      closeHeaderPropertyTypeMenu({ restoreFocus:true });
      return;
    }
    closeHeaderPropertyTypeMenu();
    const currentType = normalizedProjectType(activeBaseProject?.project_type || selectedType) || 'residential';
    const descriptions = {
      residential:'Houses and single-family homes',
      commercial:'Business and industrial properties',
      multifamily:'Apartments and shared housing'
    };
    const menu = document.createElement('div');
    menu.className = 'r-property-type-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', (globalThis.PlatformLanguage?.text("project-request","m_dccbe8abe35b17","Property type") ?? "Property type"));
    menu.innerHTML = Object.entries(TYPE_META).map(([key, meta]) => `<button type="button" class="r-property-type-option" role="option" data-property-type="${escapeHtml(key)}" aria-selected="${key === currentType ? 'true' : 'false'}"><span class="r-property-type-option-icon"><i class="fas ${escapeHtml(meta.icon)}" aria-hidden="true"></i></span><span class="r-property-type-option-copy"><strong>${escapeHtml(meta.label)}</strong><small>${escapeHtml(descriptions[key])}</small></span><i class="fas fa-check r-property-type-option-check" aria-hidden="true"></i></button>`).join('');
    document.body.appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.closest('.property-type')?.classList.add('menu-open');
    headerPropertyTypeMenu = { menu, trigger };
    positionHeaderPropertyTypeMenu(menu, trigger);
    const options = [...menu.querySelectorAll('[data-property-type]')];
    const currentOption = menu.querySelector('[aria-selected="true"]') || options[0];
    menu.addEventListener('click', (event) => {
      const option = event.target.closest('[data-property-type]');
      if (!option) return;
      const value = option.dataset.propertyType;
      closeHeaderPropertyTypeMenu();
      selectProjectType(value, { reveal:false, persist:true });
    });
    menu.addEventListener('keydown', (event) => {
      const index = Math.max(0, options.indexOf(document.activeElement));
      if (event.key === 'Escape') { event.preventDefault(); closeHeaderPropertyTypeMenu({ restoreFocus:true }); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        options[(index + delta + options.length) % options.length]?.focus();
      }
      if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); options[event.key === 'Home' ? 0 : options.length - 1]?.focus(); }
    });
    currentOption?.focus();
  }

  function bindHeaderPropertyTypeGlobalEvents(){
    if (headerPropertyTypeGlobalEventsBound) return;
    headerPropertyTypeGlobalEventsBound = true;
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest?.('[data-header-property-type]');
      if (!trigger) return;
      event.preventDefault();
      event.stopPropagation();
      openHeaderPropertyTypeMenu(trigger);
    }, true);
    document.addEventListener('keydown', (event) => {
      const trigger = event.target.closest?.('[data-header-property-type]');
      if (!trigger || !['ArrowDown','ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      openHeaderPropertyTypeMenu(trigger);
    }, true);
    document.addEventListener('pointerdown', (event) => {
      if (!headerPropertyTypeMenu) return;
      if (headerPropertyTypeMenu.menu.contains(event.target) || headerPropertyTypeMenu.trigger.contains(event.target)) return;
      closeHeaderPropertyTypeMenu();
    });
    document.addEventListener('scroll', () => {
      if (headerPropertyTypeMenu?.trigger?.isConnected) {
        positionHeaderPropertyTypeMenu(headerPropertyTypeMenu.menu, headerPropertyTypeMenu.trigger);
      }
    }, true);
    window.addEventListener('resize', () => closeHeaderPropertyTypeMenu());
  }

  function bindProjectStageBarWheel(){
    bindHeaderPropertyTypeGlobalEvents();
    const bar = document.getElementById('rProjectStageBar');
    if (!bar || bar.__fmStageWheelBound) return;
    bar.__fmStageWheelBound = true;
    bar.addEventListener('click', (event) => {
      if (event.target.closest('[data-manual-stage-trigger]')) openManualStagePicker();
    });
    bar.addEventListener('wheel', (event) => {
      const track = bar.querySelector('.r-stage-track');
      if (!track || track.scrollWidth <= track.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      track.scrollLeft += delta;
    }, { passive: false });
  }

  bindHeaderPropertyTypeGlobalEvents();

  function customerPortalProjectModule(){
    return window.Portal?.modules?.customerPortalProject || window.Portal?.ProjectCustomerPortalApp || null;
  }

  // The dedicated project tab owns Customer Portal access for now. Keep the
  // left-column card implementation intact so it can be restored easily.
  const CUSTOMER_PORTAL_LEFT_COLUMN_ENABLED = false;

  function mountCustomerPortalProjectApp(context = {}){
    const app = customerPortalProjectModule();
    if (!app?.mount) return null;
    const panelRoot = context.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="customer_portal"]');
    app.mount({
      ...projectModalTabContext(),
      ...context,
      panelRoot,
      overlayRoot: $('#rOverlay'),
      host: projectWorkspaceHost(),
      projectWorkspace: projectWorkspaceHost()
    });
    return app;
  }

  function customerPortalProjectId(){
    return String(activeBaseProject?.id || '').trim();
  }

  function loadCustomerPortal(options = {}){
    const result = mountCustomerPortalProjectApp()?.load?.(options);
    if (result && typeof result.finally === 'function') result.finally(renderCustomerPortalLink);
    else renderCustomerPortalLink();
    return result;
  }

  function renderCustomerPortalPanel(){
    const result = mountCustomerPortalProjectApp()?.render?.();
    renderCustomerPortalLink();
    return result;
  }

  function resetCustomerPortalApp(){
    return mountCustomerPortalProjectApp()?.reset?.();
  }

  async function copyCustomerPortalUrl(url){
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast((globalThis.PlatformLanguage?.text("project-request","m_16841202d17c7c","Copied") ?? "Copied"), (globalThis.PlatformLanguage?.text("project-request","m_bfa8fef03b9ba7","Customer portal link copied.") ?? "Customer portal link copied."), true);
    } catch (_) {
      showToast((globalThis.PlatformLanguage?.text("project-request","m_9c6d3ea981962c","Copy failed") ?? "Copy failed"), (globalThis.PlatformLanguage?.text("project-request","m_4cd4659b75610e","Could not copy the customer portal link.") ?? "Could not copy the customer portal link."), false);
    }
  }

  function renderCustomerPortalLink(){
    const mount = document.getElementById('rCustomerPortalLinkMount');
    if (!mount) return;
    const pid = customerPortalProjectId();
    if (!CUSTOMER_PORTAL_LEFT_COLUMN_ENABLED || !shouldRenderDefaultProjectInfo() || !customerPortalEnabled() || !pid) {
      mount.classList.remove('visible');
      mount.innerHTML = '';
      return;
    }
    const app = customerPortalProjectModule();
    const portalState = app?.context?.().portal || {};
    const portal = portalState.portal || {};
    const liveUrl = String(portal.live_url || '').trim();
    const previewUrl = String(portal.preview_url || '').trim();
    const busy = !!portalState.loading;
    const ready = !!(liveUrl || previewUrl);
    mount.classList.add('visible');
    mount.innerHTML = `
      <div class="r-customer-portal-card">
        <div class="r-customer-portal-card-head">
          <div class="r-customer-portal-card-title"><i class="fas fa-link"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_61f3d0db590ab0","Customer Portal") ?? "Customer Portal")}</span></div>
          <div class="r-customer-portal-card-status">${String(busy ? 'Loading' : (ready ? 'Ready' : 'Not created'))}</div>
        </div>
        <div class="r-customer-portal-actions">
          <button type="button" class="${String(ready ? '' : 'primary')}" data-customer-portal-open-tab>${String(ready ? 'Manage' : 'Create Link')}</button>
          ${String(liveUrl ? `
            <button type="button" data-customer-portal-copy><i class="fas fa-copy"></i><span>Copy</span></button>
          ` : '')}
          ${String(previewUrl ? `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i><span>Open</span></a>` : '')}
        </div>
      </div>
    `;
    mount.querySelector('[data-customer-portal-open-tab]')?.addEventListener('click', () => {
      setActivePreviewTab('customer_portal');
      const maybePromise = loadCustomerPortal({ silent: false });
      if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
    });
    mount.querySelector('[data-customer-portal-copy]')?.addEventListener('click', () => copyCustomerPortalUrl(liveUrl));
  }

  function isVisibleModalLayer(el){
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && el.getClientRects().length > 0;
  }

  function hasProjectModalTopLayer(){
    const selectors = [
      '.fm-dialog-backdrop',
      '.fm-photo-modal',
      '.pf-user-modal',
      '.pf-trash-modal',
      '.r-dup-overlay',
      '.storage-checkout-backdrop',
      '.dash-modal-backdrop',
      '.b-overlay.active',
      '.r-schedule-dialog',
      '.r-signature-modal',
      '.r-signing-overlay',
      '.r-proposal-media-pick'
    ];
    return selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some(isVisibleModalLayer));
  }

  function handleProjectModalKeydown(e){
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const overlay = $('#rOverlay');
    if (!overlay?.classList.contains('active')) return;
    if (hasProjectModalTopLayer()) return;
    e.preventDefault();
    close();
  }

  let projectPhotosContextAccessorsInstalled = false;
  let proposalContextAccessorsInstalled = false;

  function defineProjectWorkspaceAccessor(name, get, set = null){
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get,
        set: set || ((value) => { console.warn(`Project workspace accessor ${name} is read-only.`, value); })
      });
    } catch (_) {}
  }

  function installProjectPhotosContextAccessors(){
    if (projectPhotosContextAccessorsInstalled) return;
    projectPhotosContextAccessorsInstalled = true;
    defineProjectWorkspaceAccessor('activeBaseProject', () => activeBaseProject, (value) => { activeBaseProject = value; });
    defineProjectWorkspaceAccessor('projectPhotos', () => projectPhotos, (value) => { projectPhotos = Array.isArray(value) ? value : []; });
    defineProjectWorkspaceAccessor('activePhotoIndex', () => activePhotoIndex, (value) => { activePhotoIndex = Number(value || 0) || 0; });
    defineProjectWorkspaceAccessor('photoViewerOpen', () => photoViewerOpen, (value) => { photoViewerOpen = !!value; });
    defineProjectWorkspaceAccessor('pendingRoutePhotoId', () => pendingRoutePhotoId, (value) => { pendingRoutePhotoId = String(value || '').trim(); });
    defineProjectWorkspaceAccessor('activePreviewTab', () => activePreviewTab, (value) => { activePreviewTab = String(value || 'map'); });
    defineProjectWorkspaceAccessor('customerPortalState', () => customerPortalProjectModule()?.context?.().portal || { loading: false, portal: null, activity: [], error: '' }, () => {});
    Object.assign(window, {
      projectPhotosEnabled: (...args) => projectPhotosEnabled(...args),
      projectOrgId: (...args) => projectOrgId(...args),
      getMarkersData: (...args) => getMarkersData(...args),
      customerPortalMediaEnabled: (...args) => customerPortalMediaEnabled(...args),
      customerPortalProjectId: (...args) => customerPortalProjectId(...args),
      queueAutosaveNotice: (...args) => queueAutosaveNotice(...args),
      persistActiveBaseProject: (...args) => persistActiveBaseProject(...args),
      ensureDraftBaseProject: (...args) => ensureDraftBaseProject(...args),
      trackRequestActivity: (...args) => trackRequestActivity(...args),
      storageLimitsEnabled: (...args) => storageLimitsEnabled(...args),
      purchasableStorageEnabled: (...args) => purchasableStorageEnabled(...args),
      formatStorageBytes: (...args) => formatStorageBytes(...args),
      storageLimitBytes: (...args) => storageLimitBytes(...args),
      openStorageSettings: (...args) => openStorageSettings(...args),
      renderCustomerPortalPanel: (...args) => renderCustomerPortalPanel(...args),
      syncActiveProjectRoute: (...args) => syncActiveProjectRoute(...args),
      showToast: (...args) => showToast(...args)
    });
    const photosTab = window.Portal?.modules?.projectPhotosTab || window.Portal?.ProjectPhotosTab || null;
    photosTab?.functionNames?.().forEach((name) => {
      window[name] = (...args) => projectPhotosInvoke(name, args);
    });
  }

  function installProposalContextAccessors(){
    if (proposalContextAccessorsInstalled) return;
    proposalContextAccessorsInstalled = true;
    defineProjectWorkspaceAccessor('proposals', () => proposals, (value) => { proposals = value; });
    defineProjectWorkspaceAccessor('activeProposalIndex', () => activeProposalIndex, (value) => { activeProposalIndex = value; });
    defineProjectWorkspaceAccessor('activeProposalPageIndex', () => activeProposalPageIndex, (value) => { activeProposalPageIndex = value; });
    defineProjectWorkspaceAccessor('proposalInsertIndex', () => proposalInsertIndex, (value) => { proposalInsertIndex = value; });
    defineProjectWorkspaceAccessor('proposalEditorMode', () => proposalEditorMode, (value) => { proposalEditorMode = value; });
    defineProjectWorkspaceAccessor('proposalMarkupMode', () => proposalMarkupMode, (value) => { proposalMarkupMode = value; });
    defineProjectWorkspaceAccessor('proposalMarkupDockOpen', () => proposalMarkupDockOpen, (value) => { proposalMarkupDockOpen = value; });
    defineProjectWorkspaceAccessor('proposalMarkupTool', () => proposalMarkupTool, (value) => { proposalMarkupTool = value; });
    defineProjectWorkspaceAccessor('proposalMarkupPopover', () => proposalMarkupPopover, (value) => { proposalMarkupPopover = value; });
    defineProjectWorkspaceAccessor('proposalDeleteConfirmPageId', () => proposalDeleteConfirmPageId, (value) => { proposalDeleteConfirmPageId = value; });
    defineProjectWorkspaceAccessor('proposalPhotoPicker', () => proposalPhotoPicker, (value) => { proposalPhotoPicker = value; });
    defineProjectWorkspaceAccessor('proposalCoverAdjustOpen', () => proposalCoverAdjustOpen, (value) => { proposalCoverAdjustOpen = value; });
    defineProjectWorkspaceAccessor('proposalMarkupStrokeColor', () => proposalMarkupStrokeColor, (value) => { proposalMarkupStrokeColor = value; });
    defineProjectWorkspaceAccessor('proposalMarkupStrokeSize', () => proposalMarkupStrokeSize, (value) => { proposalMarkupStrokeSize = value; });
    defineProjectWorkspaceAccessor('proposalDeleteConfirmBlockId', () => proposalDeleteConfirmBlockId, (value) => { proposalDeleteConfirmBlockId = value; });
    defineProjectWorkspaceAccessor('proposalWorkspaceOpen', () => proposalWorkspaceOpen, (value) => { proposalWorkspaceOpen = value; });
    defineProjectWorkspaceAccessor('proposalWorkspaceMode', () => proposalWorkspaceMode, (value) => { proposalWorkspaceMode = value; });
    defineProjectWorkspaceAccessor('proposalSettingsPanelOpen', () => proposalSettingsPanelOpen, (value) => { proposalSettingsPanelOpen = value; });
    defineProjectWorkspaceAccessor('proposalBrandingMedia', () => proposalBrandingMedia, (value) => { proposalBrandingMedia = value; });
    defineProjectWorkspaceAccessor('proposalBrandingMediaLoaded', () => proposalBrandingMediaLoaded, (value) => { proposalBrandingMediaLoaded = value; });
    defineProjectWorkspaceAccessor('proposalSendOrigin', () => proposalSendOrigin, (value) => { proposalSendOrigin = value; });
    defineProjectWorkspaceAccessor('proposalSendMessage', () => proposalSendMessage, (value) => { proposalSendMessage = value; });
    defineProjectWorkspaceAccessor('proposalSendIncludePdf', () => proposalSendIncludePdf, (value) => { proposalSendIncludePdf = value; });
    defineProjectWorkspaceAccessor('proposalSendIncludePortal', () => proposalSendIncludePortal, (value) => { proposalSendIncludePortal = value; });
    defineProjectWorkspaceAccessor('proposalSendSelectedIds', () => proposalSendSelectedIds, (value) => { proposalSendSelectedIds = value; });
    defineProjectWorkspaceAccessor('proposalSendContactKeys', () => proposalSendContactKeys, (value) => { proposalSendContactKeys = value; });
    defineProjectWorkspaceAccessor('proposalDeleteConfirmProposalId', () => proposalDeleteConfirmProposalId, (value) => { proposalDeleteConfirmProposalId = value; });
    defineProjectWorkspaceAccessor('proposalActionExpanded', () => proposalActionExpanded, (value) => { proposalActionExpanded = value; });
    defineProjectWorkspaceAccessor('proposalMeasurementsExpanded', () => proposalMeasurementsExpanded, (value) => { proposalMeasurementsExpanded = value; });
    defineProjectWorkspaceAccessor('proposalInternalNotesCollapsed', () => proposalInternalNotesCollapsed, (value) => { proposalInternalNotesCollapsed = value; });
    defineProjectWorkspaceAccessor('proposalAgentCollapsed', () => proposalAgentCollapsed, (value) => { proposalAgentCollapsed = value; });
    defineProjectWorkspaceAccessor('proposalAgentPrompt', () => proposalAgentPrompt, (value) => { proposalAgentPrompt = value; });
    defineProjectWorkspaceAccessor('proposalAgentProgress', () => proposalAgentProgress, (value) => { proposalAgentProgress = value; });
    defineProjectWorkspaceAccessor('proposalAgentRunning', () => proposalAgentRunning, (value) => { proposalAgentRunning = value; });
    defineProjectWorkspaceAccessor('proposalAgentTimer', () => proposalAgentTimer, (value) => { proposalAgentTimer = value; });
    defineProjectWorkspaceAccessor('proposalAgentRecognition', () => proposalAgentRecognition, (value) => { proposalAgentRecognition = value; });
    defineProjectWorkspaceAccessor('proposalSigningMode', () => proposalSigningMode, (value) => { proposalSigningMode = value; });
    defineProjectWorkspaceAccessor('proposalSigningSession', () => proposalSigningSession, (value) => { proposalSigningSession = value; });
    defineProjectWorkspaceAccessor('branchPresentationStyle', () => branchPresentationStyle, (value) => { branchPresentationStyle = value; });
    defineProjectWorkspaceAccessor('branchProposalTemplates', () => branchProposalTemplates, (value) => { branchProposalTemplates = value; });
    defineProjectWorkspaceAccessor('proposalSignatureModalState', () => proposalSignatureModalState, (value) => { proposalSignatureModalState = value; });
    defineProjectWorkspaceAccessor('proposalPricebookSuggest', () => proposalPricebookSuggest, (value) => { proposalPricebookSuggest = value; });
    defineProjectWorkspaceAccessor('proposalAutosaveTimer', () => proposalAutosaveTimer, (value) => { proposalAutosaveTimer = value; });
    defineProjectWorkspaceAccessor('proposalHydrateRequestId', () => proposalHydrateRequestId, (value) => { proposalHydrateRequestId = value; });
    defineProjectWorkspaceAccessor('proposalBackendLoadedProjectId', () => proposalBackendLoadedProjectId, (value) => { proposalBackendLoadedProjectId = value; });
    defineProjectWorkspaceAccessor('proposalLocalMutationVersion', () => proposalLocalMutationVersion, (value) => { proposalLocalMutationVersion = value; });
    defineProjectWorkspaceAccessor('proposalPdfJsLoading', () => proposalPdfJsLoading, (value) => { proposalPdfJsLoading = value; });
    defineProjectWorkspaceAccessor('autosaveToastTimer', () => autosaveToastTimer, (value) => { autosaveToastTimer = value; });
    defineProjectWorkspaceAccessor('autosaveDebounceTimer', () => autosaveDebounceTimer, (value) => { autosaveDebounceTimer = value; });
    defineProjectWorkspaceAccessor('suppressAutosaveNotice', () => suppressAutosaveNotice, (value) => { suppressAutosaveNotice = value; });
    defineProjectWorkspaceAccessor('activeBaseProject', () => activeBaseProject, (value) => { activeBaseProject = value; });
    defineProjectWorkspaceAccessor('projectPhotos', () => projectPhotos, (value) => { projectPhotos = value; });
    defineProjectWorkspaceAccessor('selectedType', () => selectedType, (value) => { selectedType = value; });
    defineProjectWorkspaceAccessor('activePreviewTab', () => activePreviewTab, (value) => { activePreviewTab = value; });
    defineProjectWorkspaceAccessor('reportSelection', () => reportSelection, (value) => { reportSelection = value; });
    defineProjectWorkspaceAccessor('viewingExistingProject', () => viewingExistingProject, (value) => { viewingExistingProject = value; });
    defineProjectWorkspaceAccessor('reportOrderState', () => reportOrderState, (value) => { reportOrderState = value; });
    defineProjectWorkspaceAccessor('branchProjectConfig', () => branchProjectConfig, (value) => { branchProjectConfig = value; });
    defineProjectWorkspaceAccessor('primaryContactIndex', () => primaryContactIndex, (value) => { primaryContactIndex = value; });
    defineProjectWorkspaceAccessor('proposalPdfDocumentCache', () => proposalPdfDocumentCache);
    defineProjectWorkspaceAccessor('proposalSaveInFlight', () => proposalSaveInFlight);
    defineProjectWorkspaceAccessor('proposalSaveRetryNeeded', () => proposalSaveRetryNeeded);
    defineProjectWorkspaceAccessor('proposalPdfDownloadInFlight', () => proposalPdfDownloadInFlight);
    defineProjectWorkspaceAccessor('measurementAssetCache', () => projectMeasurementsModule()?.cache?.().measurementAssetCache || new Map());
    defineProjectWorkspaceAccessor('measurementAssetLoads', () => projectMeasurementsModule()?.cache?.().measurementAssetLoads || new Set());
    defineProjectWorkspaceAccessor('proposalMeasurementCache', () => proposalMeasurementCache);
    defineProjectWorkspaceAccessor('proposalMeasurementLoads', () => proposalMeasurementLoads);
    defineProjectWorkspaceAccessor('PROPOSAL_COVER_DEFAULT_SIZE', () => PROPOSAL_COVER_DEFAULT_SIZE);
    defineProjectWorkspaceAccessor('PROPOSAL_THEMES', () => PROPOSAL_THEMES);
    defineProjectWorkspaceAccessor('PRESENTATION_STYLE_MODULE_ID', () => PRESENTATION_STYLE_MODULE_ID);
    defineProjectWorkspaceAccessor('PROPOSAL_TEMPLATES_MODULE_ID', () => PROPOSAL_TEMPLATES_MODULE_ID);
    defineProjectWorkspaceAccessor('DEFAULT_PROPOSAL_TEMPLATES', () => DEFAULT_PROPOSAL_TEMPLATES);
    defineProjectWorkspaceAccessor('PROPOSAL_MARKUP_COLORS', () => PROPOSAL_MARKUP_COLORS);
    defineProjectWorkspaceAccessor('PROPOSAL_MARKUP_SIZES', () => PROPOSAL_MARKUP_SIZES);
    defineProjectWorkspaceAccessor('PROPOSAL_ITEM_PAGE_HEIGHT', () => PROPOSAL_ITEM_PAGE_HEIGHT);
    defineProjectWorkspaceAccessor('PROPOSAL_MEDIA_PAGE_HEIGHT', () => PROPOSAL_MEDIA_PAGE_HEIGHT);
    defineProjectWorkspaceAccessor('PROPOSAL_MEDIA_BLOCK_GAP', () => PROPOSAL_MEDIA_BLOCK_GAP);
    defineProjectWorkspaceAccessor('PROPOSAL_MEDIA_BOTTOM_GUTTER', () => PROPOSAL_MEDIA_BOTTOM_GUTTER);
    defineProjectWorkspaceAccessor('PROPOSAL_IMAGE_TEXT_DEFAULT', () => PROPOSAL_IMAGE_TEXT_DEFAULT);
    defineProjectWorkspaceAccessor('PROPOSAL_FONT_OPTIONS', () => PROPOSAL_FONT_OPTIONS);
    defineProjectWorkspaceAccessor('PROPOSAL_PITCH_FIELDS', () => PROPOSAL_PITCH_FIELDS);
    defineProjectWorkspaceAccessor('PROPOSAL_MEASUREMENT_FIELDS', () => PROPOSAL_MEASUREMENT_FIELDS);
    Object.assign(window, {
      proposalPhotoById: (...args) => proposalPhotoById(...args),
      getPricebookModule: (...args) => getPricebookModule(...args),
      formatCurrency: (...args) => formatCurrency(...args),
      formatProposalPhone: (...args) => formatProposalPhone(...args),
      normalizeProposalNumber: (...args) => normalizeProposalNumber(...args),
      proposalCurrencyDisplay: (...args) => proposalCurrencyDisplay(...args),
      proposalStylePreview: (...args) => proposalStylePreview(...args),
      proposalDisplayTitle: (...args) => proposalDisplayTitle(...args),
      proposalSectionPageCount: (...args) => proposalSectionPageCount(...args),
      proposalPageEnabled: (...args) => proposalPageEnabled(...args),
      normalizeActiveProposalPage: (...args) => normalizeActiveProposalPage(...args),
      proposalLogoMarkup: (...args) => proposalLogoMarkup(...args),
      proposalBrandLockup: (...args) => proposalBrandLockup(...args),
      createProposalPageId: (...args) => createProposalPageId(...args),
      proposalMarkupSvgPath: (...args) => proposalMarkupSvgPath(...args),
      proposalMarkupSizeLabel: (...args) => proposalMarkupSizeLabel(...args),
      proposalMarkupCursorSvg: (...args) => proposalMarkupCursorSvg(...args),
      proposalMarkupHtml: (...args) => proposalMarkupHtml(...args),
      normalizeProposalTemplate: (...args) => normalizeProposalTemplate(...args),
      openProposalTemplateBrowser: (...args) => openProposalTemplateBrowser(...args),
      duplicateProposal: (...args) => duplicateProposal(...args),
      proposalDefaultTitle: (...args) => proposalDefaultTitle(...args),
      proposalApiErrorMessage: (...args) => proposalApiErrorMessage(...args),
      proposalPdfFileName: (...args) => proposalPdfFileName(...args),
      wrapPdfLine: (...args) => wrapPdfLine(...args),
      proposalLocalPdfBlob: (...args) => proposalLocalPdfBlob(...args),
      proposalPdfDocumentHtml: (...args) => proposalPdfDocumentHtml(...args),
      downloadProposalPdfUrl: (...args) => downloadProposalPdfUrl(...args),
      selectedProposalIdsForSend: (...args) => selectedProposalIdsForSend(...args),
      enterProposalEditMode: (...args) => enterProposalEditMode(...args),
      enterProposalSendMode: (...args) => enterProposalSendMode(...args),
      proposalContactKey: (...args) => proposalContactKey(...args),
      proposalContactLabel: (...args) => proposalContactLabel(...args),
      proposalDeliveryStatus: (...args) => proposalDeliveryStatus(...args),
      proposalDeliveryLabel: (...args) => proposalDeliveryLabel(...args),
      proposalHasCustomerSignature: (...args) => proposalHasCustomerSignature(...args),
      proposalHasView: (...args) => proposalHasView(...args),
      proposalStableId: (...args) => proposalStableId(...args),
      normalizeProposalCollection: (...args) => normalizeProposalCollection(...args),
      hydrateProposalsFromBackend: (...args) => hydrateProposalsFromBackend(...args),
      syncProposalPricebookItems: (...args) => syncProposalPricebookItems(...args),
      ensureProposalMeasurements: (...args) => ensureProposalMeasurements(...args),
      ensureProposalSignatureData: (...args) => ensureProposalSignatureData(...args),
      ensureProposalSigningSession: (...args) => ensureProposalSigningSession(...args),
      proposalSigningComplete: (...args) => proposalSigningComplete(...args),
      proposalNextUnsignedTarget: (...args) => proposalNextUnsignedTarget(...args),
      proposalRenderSections: (...args) => proposalRenderSections(...args),
      proposalTriangleHeaderVars: (...args) => proposalTriangleHeaderVars(...args),
      loadBranchPresentationStyle: (...args) => loadBranchPresentationStyle(...args),
      loadBranchProposalTemplates: (...args) => loadBranchProposalTemplates(...args),
      queueAutosaveNotice: (...args) => queueAutosaveNotice(...args),
      closeSignatureChooser: (...args) => closeSignatureChooser(...args),
      scrollSigningToTarget: (...args) => scrollSigningToTarget(...args),
      openSignatureChooser: (...args) => openSignatureChooser(...args),
      showProposalWorkspace: (...args) => showProposalWorkspace(...args),
      closeProposalSettingsPanel: (...args) => closeProposalSettingsPanel(...args),
      launchProposalBuilder: (...args) => launchProposalBuilder(...args),
      hideProposalWorkspace: (...args) => hideProposalWorkspace(...args),
      bindProposalModeToggle: (...args) => bindProposalModeToggle(...args),
      bindProposalMarkupToggle: (...args) => bindProposalMarkupToggle(...args),
      syncProposalAgentState: (...args) => syncProposalAgentState(...args),
      syncProposalBottomSendState: (...args) => syncProposalBottomSendState(...args),
      positionProposalWorkspaceChrome: (...args) => positionProposalWorkspaceChrome(...args),
      syncProposalWorkspaceChrome: (...args) => syncProposalWorkspaceChrome(...args),
      stopProposalAgentActivity: (...args) => stopProposalAgentActivity(...args),
      projectOrgId: (...args) => projectOrgId(...args),
      activeMeasurementProjectId: (...args) => activeMeasurementProjectId(...args),
      primeMeasurementAssetCacheFromKnownUrls: (...args) => primeMeasurementAssetCacheFromKnownUrls(...args),
      loadMeasurementAssets: (...args) => loadMeasurementAssets(...args),
      weatherReportsEnabled: (...args) => weatherReportsEnabled(...args),
      customerPortalEnabled: (...args) => customerPortalEnabled(...args),
      projectPhotosEnabled: (...args) => projectPhotosEnabled(...args),
      pinCount: (...args) => pinCount(...args),
      schedulePreviewAvailable: (...args) => schedulePreviewAvailable(...args),
      hasReportOrdered: (...args) => hasReportOrdered(...args),
      hasSelectedAddons: (...args) => hasSelectedAddons(...args),
      shouldUseMobileOrderPagination: (...args) => shouldUseMobileOrderPagination(...args),
      isProposalChoice: (...args) => isProposalChoice(...args),
      isScheduleChoice: (...args) => isScheduleChoice(...args),
      canSubmit: (...args) => canSubmit(...args),
      currentPriceQuote: (...args) => currentPriceQuote(...args),
      reportOrderMeasurement: (...args) => reportOrderMeasurement(...args),
      reportOrderIsActivelyPending: (...args) => reportOrderIsActivelyPending(...args),
      reportOrderIsCompleteLike: (...args) => reportOrderIsCompleteLike(...args),
      reportOrderIsCancelled: (...args) => reportOrderIsCancelled(...args),
      reportOrderIsRejected: (...args) => reportOrderIsRejected(...args),
      reportReleaseHoldIsActive: (...args) => reportReleaseHoldIsActive(...args),
      reportFollowupEnabled: (...args) => reportFollowupEnabled(...args),
      projectPhotoId: (...args) => projectPhotoId(...args),
      projectThumbnailPhoto: (...args) => projectThumbnailPhoto(...args),
      projectMediaThumbHtml: (...args) => projectMediaThumbHtml(...args),
      projectMediaViewerHtml: (...args) => projectMediaViewerHtml(...args),
      normalizePhoto: (...args) => normalizePhoto(...args),
      normalizeProjectPhotoList: (...args) => normalizeProjectPhotoList(...args),
      serializablePhoto: (...args) => serializablePhoto(...args),
      syncProjectPhotosFromLibrary: (...args) => syncProjectPhotosFromLibrary(...args),
      ensurePhotoStorageCapacity: (...args) => ensurePhotoStorageCapacity(...args),
      addPhotoFiles: (...args) => addPhotoFiles(...args),
      isVideoMedia: (...args) => isVideoMedia(...args),
      isImageMedia: (...args) => isImageMedia(...args),
      collectContacts: (...args) => collectContacts(...args),
      primaryContact: (...args) => primaryContact(...args),
      manualProjectTitle: (...args) => manualProjectTitle(...args),
      selectedReportExpediteOption: (...args) => selectedReportExpediteOption(...args),
      projectDefaultPreviewTab: (...args) => projectDefaultPreviewTab(...args),
      setActivePreviewTab: (...args) => setActivePreviewTab(...args),
      renderWorkflowState: (...args) => renderWorkflowState(...args),
      syncProjectViewerTabs: (...args) => syncProjectViewerTabs(...args),
      revealCustomerSection: (...args) => revealCustomerSection(...args),
      syncProjectNotesPlacement: (...args) => syncProjectNotesPlacement(...args),
      renderActionRow: (...args) => renderActionRow(...args),
      updateSubmitLabel: (...args) => updateSubmitLabel(...args),
      renderSigningOverlay: (...args) => renderSigningOverlay(...args),
      syncActiveProjectRoute: (...args) => syncActiveProjectRoute(...args),
      persistActiveBaseProject: (...args) => persistActiveBaseProject(...args),
      ensureProposalOnlyBaseProject: (...args) => ensureProposalOnlyBaseProject(...args),
      ensureDraftBaseProject: (...args) => ensureDraftBaseProject(...args),
      trackRequestActivity: (...args) => trackRequestActivity(...args),
      updateModalTitle: (...args) => updateModalTitle(...args),
      loadBranchProjectConfig: (...args) => loadBranchProjectConfig(...args),
      normalizeProjectConfig: (...args) => normalizeProjectConfig(...args),
      cssEscape: (...args) => cssEscape(...args),
      setProjectPhotoFocus: (...args) => setProjectPhotoFocus(...args),
      renderPhotoGallery: (...args) => renderPhotoGallery(...args),
      loadCustomerPortal: (...args) => loadCustomerPortal(...args),
      renderCustomerPortalPanel: (...args) => renderCustomerPortalPanel(...args),
      infoTip: (...args) => infoTip(...args),
      fmUrl: (...args) => fmUrl(...args),
      fmJson: (...args) => fmJson(...args),
      fmPost: (...args) => fmPost(...args),
      platformJson: (...args) => platformJson(...args),
      currentActor: (...args) => currentActor(...args)
    });
    window.proposalsEnabled = (...args) => proposalsEnabled(...args);
    const proposalTab = window.Portal?.modules?.proposalsTab || window.Portal?.ProposalsTab || null;
    proposalTab?.functionNames?.().forEach((name) => {
      window[name] = (...args) => proposalInvoke(name, args);
    });
  }

  function proposalTabModule(){
    installProposalContextAccessors();
    return window.Portal?.modules?.proposalsTab || window.Portal?.ProposalsTab || null;
  }

  function projectPhotosTabModule(){
    installProjectPhotosContextAccessors();
    return window.Portal?.modules?.projectPhotosTab || window.Portal?.ProjectPhotosTab || null;
  }

  function projectPhotosInvoke(name, args = []){
    installProjectPhotosContextAccessors();
    const tab = projectPhotosTabModule();
    return tab?.invoke?.(name, args);
  }

  function projectPhotosTabHost(){
    return projectWorkspaceHost();
  }

  function mountProjectPhotosTab(force = false){
    installProjectPhotosContextAccessors();
    const tab = projectPhotosTabModule();
    if (!tab?.mount) return null;
    tab.mount({
      force,
      panelRoot: document.querySelector('#rOverlay .r-preview-panel[data-panel="photos"]'),
      overlayRoot: $('#rOverlay'),
      host: projectPhotosTabHost()
    });
    return tab;
  }

  function syncProjectPhotosTabActive(){
    const tab = mountProjectPhotosTab();
    if (!tab?.setActive) return;
    tab.setActive(projectPhotosEnabled() && activePreviewTab === 'photos');
  }

  function resetProjectPhotosTabModule(){
    const tab = projectPhotosTabModule();
    tab?.reset?.();
  }

  function projectPhotoLibrary(...args){ return projectPhotosInvoke('projectPhotoLibrary', args); }
  function firstMeasurePhotoOptions(...args){ return projectPhotosInvoke('firstMeasurePhotoOptions', args); }
  function normalizeProjectPhotoList(...args){ return projectPhotosInvoke('normalizeProjectPhotoList', args) || []; }
  function projectPhotoId(...args){ return projectPhotosInvoke('projectPhotoId', args) || ''; }
  function projectMediaKind(...args){ return projectPhotosInvoke('projectMediaKind', args) || 'image'; }
  function isVideoMedia(...args){ return !!projectPhotosInvoke('isVideoMedia', args); }
  function isImageMedia(...args){ return projectPhotosInvoke('isImageMedia', args) !== false; }
  function isAcceptedProjectMediaFile(...args){ return !!projectPhotosInvoke('isAcceptedProjectMediaFile', args); }
  function serializablePhoto(...args){ return projectPhotosInvoke('serializablePhoto', args); }
  function projectThumbnailPhoto(...args){ return projectPhotosInvoke('projectThumbnailPhoto', args) || null; }
  function syncProjectPhotosFromLibrary(...args){ return projectPhotosInvoke('syncProjectPhotosFromLibrary', args) || projectPhotos; }
  function proposalPhotoById(...args){ return projectPhotosInvoke('proposalPhotoById', args) || null; }
  function normalizePhoto(...args){ return projectPhotosInvoke('normalizePhoto', args); }
  function uploadPlaceholderPhoto(...args){ return projectPhotosInvoke('uploadPlaceholderPhoto', args); }
  function replaceUploadPlaceholder(...args){ return projectPhotosInvoke('replaceUploadPlaceholder', args); }
  function removeUploadPlaceholder(...args){ return projectPhotosInvoke('removeUploadPlaceholder', args); }
  function projectMediaThumbHtml(...args){ return projectPhotosInvoke('projectMediaThumbHtml', args) || ''; }
  function projectMediaViewerHtml(...args){ return projectPhotosInvoke('projectMediaViewerHtml', args) || ''; }
  function setProjectPhotoFocus(...args){ return projectPhotosInvoke('setProjectPhotoFocus', args); }
  function renderPhotoGallery(...args){ return projectPhotosInvoke('renderPhotoGallery', args); }
  function bindPhotoUploadUI(...args){ return projectPhotosInvoke('bindPhotoUploadUI', args); }
  function openStorageCheckoutModal(...args){ return projectPhotosInvoke('openStorageCheckoutModal', args); }
  function showStorageLimitModal(...args){ return projectPhotosInvoke('showStorageLimitModal', args); }
  function ensurePhotoStorageCapacity(...args){ return projectPhotosInvoke('ensurePhotoStorageCapacity', args); }
  function addPhotoFiles(...args){ return projectPhotosInvoke('addPhotoFiles', args); }
  function showRelativePhoto(...args){ return projectPhotosInvoke('showRelativePhoto', args); }
  function handleGalleryKeydown(...args){ return projectPhotosInvoke('handleGalleryKeydown', args); }

  function proposalInvoke(name, args = []){
    installProposalContextAccessors();
    const tab = proposalTabModule();
    return tab?.invoke?.(name, args);
  }

  function proposalTabHost(){
    return {
      ...projectWorkspaceHost(),
      onActivate: () => {
        $('#rOverlay')?.classList.toggle('proposal-workspace', !!proposalWorkspaceOpen);
        syncLeftColumnOverride();
      },
      onDeactivate: () => {
        $('#rOverlay')?.classList.remove('proposal-workspace', 'proposal-list-mode', 'proposal-edit-mode', 'proposal-send-mode', 'proposal-builder-mode');
        syncLeftColumnOverride();
      },
      onReset: () => {
        $('#rOverlay')?.classList.remove('proposal-workspace', 'proposal-list-mode', 'proposal-edit-mode', 'proposal-send-mode', 'proposal-builder-mode');
        syncLeftColumnOverride();
      }
    };
  }

  function mountProposalTab(force = false){
    installProposalContextAccessors();
    const tab = proposalTabModule();
    if (!tab?.mount) return null;
    tab.mount({
      force,
      leftRoot: $('#rProposalSection'),
      previewRoot: $('#rProposalPreview'),
      overlayRoot: $('#rOverlay'),
      host: proposalTabHost()
    });
    return tab;
  }

  function syncProposalTabActive(){
    const tab = mountProposalTab();
    if (!tab?.setActive) return;
    tab.setActive(proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal');
  }

  function resetProposalTabModule(){
    const tab = proposalTabModule();
    tab?.reset?.();
  }

  function syncProposalPricebookItems(...args){ return proposalInvoke('syncProposalPricebookItems', args); }
  function queueAutosaveNotice(...args){
    // FirstMeasure drafts must save even when the platform proposal app is off.
    if (!proposalsEnabled() || !proposalTabModule()) return persistActiveBaseProject();
    return proposalInvoke('queueAutosaveNotice', args);
  }
  function ensureProposalSignatureData(...args){ return proposalInvoke('ensureProposalSignatureData', args); }
  function ensureProposalSigningSession(...args){ return proposalInvoke('ensureProposalSigningSession', args); }
  function proposalSigningComplete(...args){ return proposalInvoke('proposalSigningComplete', args); }
  function proposalNextUnsignedTarget(...args){ return proposalInvoke('proposalNextUnsignedTarget', args); }
  function proposalPricingSummary(...args){ return proposalInvoke('proposalPricingSummary', args) || null; }
  function proposalTriangleHeaderVars(...args){ return proposalInvoke('proposalTriangleHeaderVars', args); }
  function proposalRenderSections(...args){ return proposalInvoke('proposalRenderSections', args); }
  async function loadBranchPresentationStyle(...args){ return proposalInvoke('loadBranchPresentationStyle', args); }
  function hexToRgbString(...args){ return proposalInvoke('hexToRgbString', args); }
  function getProposalPrimaryColor(...args){ return proposalInvoke('getProposalPrimaryColor', args); }
  function getProposalAccentColor(...args){ return proposalInvoke('getProposalAccentColor', args); }
  function getProposalAccentReadableColor(...args){ return proposalInvoke('getProposalAccentReadableColor', args); }
  function proposalBrandLockup(...args){ return proposalInvoke('proposalBrandLockup', args); }
  function ensureProposalPageIds(...args){ return proposalInvoke('ensureProposalPageIds', args); }
  async function loadBranchProposalTemplates(...args){ return proposalInvoke('loadBranchProposalTemplates', args); }
  function proposalPageMarkup(...args){ return proposalInvoke('proposalPageMarkup', args); }
  function proposalMarkupDockHtml(...args){ return proposalInvoke('proposalMarkupDockHtml', args) || ''; }
  function proposalStableId(...args){ return proposalInvoke('proposalStableId', args); }
  function normalizeProposalCollection(...args){ return proposalInvoke('normalizeProposalCollection', args); }
  async function hydrateProposalsFromBackend(...args){ return proposalInvoke('hydrateProposalsFromBackend', args); }
  function enterProposalEditMode(...args){ return proposalInvoke('enterProposalEditMode', args); }
  function enterProposalSendMode(...args){ return proposalInvoke('enterProposalSendMode', args); }
  function createNewProposalAndEdit(...args){ return proposalInvoke('createNewProposalAndEdit', args); }
  function closeSignatureChooser(...args){ return proposalInvoke('closeSignatureChooser', args); }
  function scrollSigningToTarget(...args){ return proposalInvoke('scrollSigningToTarget', args); }
  function openSignatureChooser(...args){ return proposalInvoke('openSignatureChooser', args); }
  function showProposalWorkspace(...args){ return proposalInvoke('showProposalWorkspace', args); }
  function closeProposalSettingsPanel(...args){ return proposalInvoke('closeProposalSettingsPanel', args); }
  function launchProposalBuilder(...args){ return proposalInvoke('launchProposalBuilder', args); }
  function hideProposalWorkspace(...args){ return proposalInvoke('hideProposalWorkspace', args); }
  function bindProposalModeToggle(...args){ return proposalInvoke('bindProposalModeToggle', args); }
  function bindProposalMarkupToggle(...args){ return proposalInvoke('bindProposalMarkupToggle', args); }
  function syncProposalAgentState(...args){ return proposalInvoke('syncProposalAgentState', args); }
  function syncProposalBottomSendState(...args){ return proposalInvoke('syncProposalBottomSendState', args); }
  function positionProposalWorkspaceChrome(...args){ return proposalInvoke('positionProposalWorkspaceChrome', args); }
  function syncProposalWorkspaceChrome(...args){ return proposalInvoke('syncProposalWorkspaceChrome', args); }
  function stopProposalAgentActivity(...args){ return proposalInvoke('stopProposalAgentActivity', args); }

  function proposalIntentIdentity(proposal = {}, index = 0){
    return [
      proposal?.id,
      proposal?.proposal_api_id,
      proposal?.proposalApiId,
      proposal?.backend_id,
      proposal?.backendId,
      proposal?.proposal_id,
      proposal?.proposalId,
      proposalStableId(proposal, index),
      `proposal_index_${index}`
    ].map((value) => String(value || '').trim()).filter(Boolean);
  }

  function proposalIntentIndex(intent = {}){
    normalizeProposalCollection();
    const wantedId = String(intent.proposalId || intent.id || '').trim();
    if (wantedId) {
      const found = proposals.findIndex((proposal, index) => proposalIntentIdentity(proposal, index).includes(wantedId));
      if (found >= 0) return found;
    }
    const index = Number(intent.proposalIndex);
    if (Number.isFinite(index) && index >= 0 && index < proposals.length) return index;
    return proposals.length ? activeProposalIndex : -1;
  }

  async function applyProposalOpenIntent(options = {}){
    const intent = options.proposalIntent && typeof options.proposalIntent === 'object' ? options.proposalIntent : null;
    const action = String(intent?.action || '').trim().toLowerCase();
    if (!intent || !action || !proposalsEnabled()) return;
    if (action === 'list') {
      showProposalWorkspace();
      return;
    }
    showProposalWorkspace();
    await hydrateProposalsFromBackend({ render: false, force: true }).catch((error) => console.warn('Proposal intent hydration failed', error));
    normalizeProposalCollection();
    if (action === 'create' || action === 'new') {
      createNewProposalAndEdit();
      return;
    }
    if (action === 'edit' || action === 'open') {
      const index = proposalIntentIndex(intent);
      if (index >= 0) enterProposalEditMode(index);
      return;
    }
    if (action === 'send') {
      const index = proposalIntentIndex(intent);
      if (index >= 0) {
        activeProposalIndex = index;
        const proposal = proposals[index];
        enterProposalSendMode('list', [proposalStableId(proposal, index)]);
      }
    }
  }

  function renderProposalSection(){
    const mobileProposalMain = activePreviewTab === 'proposal'
      && isMobileProjectOrder()
      && proposalWorkspaceMode !== 'edit';
    if (!projectLeftColumnOverridden() && !mobileProposalMain) {
      restoreDefaultLeftColumnState();
      return;
    }
    if (activePreviewTab === 'schedule' && schedulePreviewAvailable()) return;
    if (activePreviewTab === 'materials' && materialsEnabled()) return;
    if (activePreviewTab === 'money' && moneyEnabled()) return;
    const tab = mountProposalTab();
    if (tab?.renderManager) {
      tab.renderManager();
      return;
    }
  }

  function renderProposalPreview(preservedScrollTop = null){
    const tab = mountProposalTab();
    if (tab?.renderPreview) {
      tab.renderPreview(preservedScrollTop);
    }
  }

  function infoTip(text){
    return `<span class="r-info-tip"><i class="fas fa-info"></i><span class="r-tip-bubble">${text}</span></span>`;
  }

  function reportAddonInfo(key){
    if (key === 'full_house') return {
      title: (globalThis.PlatformLanguage?.text("project-request","m_4a6c4929742fbe","Full Structure report") ?? "Full Structure report"),
      body: 'Exterior measurements for the whole house, including the roof.',
      bullets: ['Walls, windows, doors, and siding areas.', 'Roof and gutter measurements included.', 'Eight reference photos per structure are required.'],
      sample: {label: (globalThis.PlatformLanguage?.text("project-request","m_e1fd389d2c4cb3","Download sample Full Structure report") ?? "Download sample Full Structure report"), url: 'samples/full_house_sample.pdf'}
    };
    if (key === 'roof') return {
      title: (globalThis.PlatformLanguage?.text("project-request","m_874db260d86062","Roof Only report") ?? "Roof Only report"), body: 'Your roof measurement report.',
      bullets: ['Roof areas, slopes, edges and measurements.', 'Add gutters or other available reports when ordering.'],
      sample: {label: (globalThis.PlatformLanguage?.text("project-request","m_9db79290d13f2b","Download sample roof report") ?? "Download sample roof report"), url: 'landing/variants/landing_template/media/sample-roof-measurement-report.pdf'}
    };

    if (key === 'gutters') {
      return {
        title: (globalThis.PlatformLanguage?.text("project-request","m_f4779b9d631992","Gutter report") ?? "Gutter report"),
        body: 'Adds a dedicated gutter page to the standard residential report.',
        bullets: [
          'Active gutter linear feet calculated from eave runs.',
          'Stories by north, south, east, and west sides.',
          'Gutter diagram with each run labeled.',
          'Miter counts for outside 90, inside 90, and non-90 corners.'
        ],
        sample: {
          label: (globalThis.PlatformLanguage?.text("project-request","m_67350ceb0509e7","Download sample gutter report") ?? "Download sample gutter report"),
          url: 'samples/gutter_sample.pdf'
        }
      };
    }
    if (key === 'inspection') {
      return {
        title: (globalThis.PlatformLanguage?.text("project-request","m_8fb9df3711e29f","Instant report") ?? "Instant report"),
        body: 'Adds an instant measurement report while the standard report is processing.',
        bullets: [
          'Fast AI-generated roof measurement preview.',
          'Interactive roof model where available.',
          'Instant PDF access before the reviewed standard report is complete.',
          'Standard report still follows the selected delivery window.'
        ],
        sample: null
      };
    }
    if (key === 'weather') {
      return {
        title: (globalThis.PlatformLanguage?.text("project-request","m_a3126077e6d02c","Historical weather report") ?? "Historical weather report"),
        body: 'Adds a severe-weather history report for the property.',
        bullets: [
          'Broad hail, wind, and tornado event history for the address.',
          'Nearby event records grouped by date with distance and magnitude details.',
          'Map-style exhibits, warning context, and summary tables.',
          'Useful for claim review, customer conversations, and project documentation.'
        ],
        sample: {
          label: (globalThis.PlatformLanguage?.text("project-request","m_e92ed7b63f5c68","Download sample weather report") ?? "Download sample weather report"),
          url: 'samples/weather_sample.pdf'
        }
      };
    }
    return {
      title: (globalThis.PlatformLanguage?.text("project-request","m_66645473310bb3","Add-on") ?? "Add-on"),
      body: 'Adds an optional report feature to this order.',
      bullets: [],
      sample: null
    };
  }

  function reportAddonInfoHtml(key){
    const info = reportAddonInfo(key);
    return `
      <div class="r-addon-info-card">
        <h4>${escapeHtml(info.title)}</h4>
        <p>${escapeHtml(info.body)}</p>
        ${info.bullets.length ? `<ul>${info.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
        ${info.sample?.url ? `<div class="r-addon-info-actions"><a class="r-addon-info-sample" href="${escapeHtml(info.sample.url)}" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i>${escapeHtml(info.sample.label || 'Open sample report')}</a></div>` : ''}
        ${reportAddonPriceNoteHtml(key)}
      </div>`;
  }

  function reportAddonPriceNoteHtml(key){
    if (!isPerStructureType(selectedType) || pinCount() <= 1) return '';
    const normalized = String(key || '').trim().toLowerCase();
    const unit = normalized === 'weather'
      ? WEATHER_REPORT_ADDON
      : (normalized === 'inspection' ? instantAddonUnitPriceFor(selectedType) : 0);
    if (!unit) return '';
    const count = Math.max(1, pinCount());
    const total = Math.round(unit * count * 100) / 100;
    const structureLabel = count === 1 ? 'structure' : 'structures';
    return `<div class="r-addon-info-price">${((v0,v1,v2,v3) => globalThis.PlatformLanguage?.text("project-request","m_f2a719928b5a49",`$${v0} / structure x ${v1} ${v2} = $${v3}`,{v0,v1,v2,v3}) ?? `$${v0} / structure x ${v1} ${v2} = $${v3}`)(escapeHtml(fmtMoney(unit)),count,structureLabel,escapeHtml(fmtMoney(total)))}</div>`;
  }

  function addonInfoIcon(key){
    const info = reportAddonInfo(key);
    return `<span class="r-info-tip r-addon-info-trigger" data-addon-info-trigger="${String(escapeHtml(key))}" role="button" tabindex="0" aria-label="${((v1) => globalThis.PlatformLanguage?.text("project-request","m_6e4ba38fa02b85",`${v1} information`,{v1}) ?? `${v1} information`)(escapeHtml(info.title))}"><i class="fas fa-info"></i></span>`;
  }

  function buildTypeButtons(){
    const pricingLabels = { residential: '$7 flat rate', commercial: '$12 / structure', multifamily: '$12 / structure' };
    return Object.entries(TYPE_META).map(([key, meta]) => `
      <button type="button" class="r-type-btn" data-type="${key}">
        <div class="r-type-icon"><i class="fas ${meta.icon}"></i></div>
        <div class="r-type-label">${meta.label}</div>
        <div class="r-type-price">${pricingLabels[key]}</div>
      </button>`).join('');
  }

  function buildTypeOptions(selected = ''){
    return Object.entries(TYPE_META).map(([key, meta]) =>
      `<option value="${escapeHtml(key)}"${key === selected ? ' selected' : ''}>${escapeHtml(meta.label || key)}</option>`
    ).join('');
  }

  function selectProjectType(value, options = {}){
    const nextType = normalizedProjectType(value);
    if (!nextType || !TYPE_META[nextType]) return false;
    const previousType = selectedType;
    selectedType = nextType;
    const mobileTypeChoice = shouldUseMobileOrderPagination() && addressSelected;
    mobileRoofOnlyChosen = false;
    if (mobileTypeTransitionTimer) clearTimeout(mobileTypeTransitionTimer);
    mobileTypeTransitioning = mobileTypeChoice;
    typePickerExpanded = mobileTypeChoice;
    if (activeBaseProject) activeBaseProject.project_type = nextType;
    if (previousType && previousType !== selectedType && reportExpediteOptionsEnabled()) {
      selectedReportExpedite = null;
      invalidateReportExpediteOptions();
      reportExpediteOptions = [...FALLBACK_REPORT_EXPEDITE_OPTIONS];
      reportExpediteOptionsAuthoritative = false;
      if (reportSelection === 'roof' && !shouldLockReportOrderingWorkflow()) reportSelection = null;
    }
    normalizeReportSelection();
    if (hasSelectedAddons()) locationConfirmed = false;
    refreshMarkerIcons();
    renderWorkflowState();
    if (mobileTypeChoice) mobileTypeTransitionTimer = setTimeout(() => {
      mobileTypeTransitioning = false;
      typePickerExpanded = false;
      renderWorkflowState();
    }, 210);
    renderProjectStageBar();
    if (!addressSelected && !shouldUseMobileOrderPagination()) {
      const typedAddress = ($('#rAddress')?.value || '').trim();
      if (typedAddress) forwardGeocode(typedAddress);
    }
    if (options.reveal !== false) revealInLeftColumnIfBelow('#rStepReport');
    queueAutosaveNotice();
    if (options.persist) persistActiveBaseProject();
    return true;
  }

  function roofOnlyPriceLabel(){
    if (!selectedType) return 'Choose a project type first';
    const instant = includeInstantPreview ? instantAddonUnitPriceFor(selectedType) : 0;
    const unit = reportBaseUnitPrice(selectedType) + instant;
    return isPerStructureType(selectedType) ? `$${fmtMoney(unit)} / structure` : `$${fmtMoney(unit)} flat rate`;
  }

  function addMinutes(date, minutes){
    return new Date(date.getTime() + (Number(minutes) || 0) * 60000);
  }

  function formatTurnaroundTime(date){
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  function reportExpediteWindowLabel(option, now = new Date()){
    if (!option) return '';
    const dueStart = option.due_window_start ? new Date(option.due_window_start) : null;
    const dueEnd = option.due_window_end ? new Date(option.due_window_end) : null;
    if (dueStart && dueEnd && !Number.isNaN(dueStart.getTime()) && !Number.isNaN(dueEnd.getTime())) {
      return `${formatTurnaroundTime(dueStart)} - ${formatTurnaroundTime(dueEnd)}`;
    }
    if (option?.window_label) return option.window_label;
    return `${formatTurnaroundTime(addMinutes(now, option.startMinutes))} - ${formatTurnaroundTime(addMinutes(now, option.endMinutes))}`;
  }

  function reportCustomerPromiseLabelFromDate(date){
    return date && !Number.isNaN(date.getTime()) ? `By ${formatTurnaroundTime(date)}` : '';
  }

  function reportCustomerPromiseLabelFromWindow(windowLabel){
    const text = String(windowLabel || '').trim();
    if (!text) return '';
    const parts = text.split(/\s+-\s+/);
    return parts.length > 1 && parts[parts.length - 1] ? `By ${parts[parts.length - 1]}` : text;
  }

  function reportExpediteCustomerPromiseLabel(option, now = new Date()){
    if (!option) return '';
    const dueEnd = option.due_window_end ? new Date(option.due_window_end) : null;
    if (dueEnd && !Number.isNaN(dueEnd.getTime())) return reportCustomerPromiseLabelFromDate(dueEnd);
    const endMinutes = Number(option.endMinutes ?? option.end_minutes);
    if (Number.isFinite(endMinutes)) return reportCustomerPromiseLabelFromDate(addMinutes(now, endMinutes));
    return reportCustomerPromiseLabelFromWindow(option.window_label || '');
  }

  function reportExpediteDurationLabel(option){
    const end = Number(option?.endMinutes);
    if (!Number.isFinite(end)) return option?.label || '';
    const formatHours = (minutes) => {
      const normalized = Math.max(1, Number(minutes) || 0);
      if (normalized <= 60) return '1';
      const hours = Math.ceil(normalized / 60);
      return String(hours);
    };
    return `Less than ${formatHours(end)} hour${formatHours(end) === '1' ? '' : 's'}`;
  }

  function reportExpediteUnitPrice(option, type = selectedType){
    if (option?.unit_price != null) return Number(option.unit_price);
    return proportionalReportExpediteUnitPrice(option, type);
  }

  function reportExpeditePriceLabel(option, type = selectedType){
    const unit = Number(option?.unit_price ?? reportExpediteUnitPrice(option, type || 'residential'));
    return isPerStructureType(type) ? `$${fmtMoney(unit)} / structure` : `$${fmtMoney(unit)}`;
  }

  function reportExpediteTotalPrice(option, type = selectedType){
    const normalizedType = type || 'residential';
    const reportUnit = Number(option?.unit_price ?? reportExpediteUnitPrice(option, normalizedType));
    const instant = includeInstantPreview ? instantAddonUnitPriceFor(normalizedType) : 0;
    const unit = reportUnit + instant;
    const reportTotal = isPerStructureType(normalizedType) ? unit * Math.max(1, pinCount()) : unit;
    const gutters = normalizedType === 'residential' && hasGutterAddon() ? GUTTER_REPORT_ADDON : 0;
    const weather = hasWeatherAddon() ? WEATHER_REPORT_ADDON * Math.max(1, pinCount()) : 0;
    return Math.round((reportTotal + gutters + weather) * 100) / 100;
  }

  function freeExpediteUses(){
    return Math.max(0, parseInt(String(window.Portal?.freeExpediteUses ?? 0), 10) || 0);
  }

  function reportExpediteCouponDiscount(option, type = selectedType){
    if (!option?.expedited || freeExpediteUses() <= 0) return 0;
    const normalizedType = type || 'residential';
    const standardUnit = TYPE_META[normalizedType]?.price ?? PRICE_RESIDENTIAL;
    const unit = reportExpediteUnitPrice(option, normalizedType);
    const unitDelta = Math.max(0, Math.round((unit - standardUnit) * 100) / 100);
    const count = isPerStructureType(normalizedType) ? Math.max(1, pinCount()) : 1;
    return Math.round(unitDelta * count * 100) / 100;
  }

  function reportExpediteNetTotalPrice(option, type = selectedType){
    const gross = reportExpediteTotalPrice(option, type);
    const discount = reportExpediteCouponDiscount(option, type);
    return Math.round(Math.max(0.01, gross - discount) * 100) / 100;
  }

  function reportExpediteTotalPriceLabel(option, type = selectedType){
    return `$${fmtMoney(reportExpediteNetTotalPrice(option, type))}`;
  }

  function reportExpediteMoneyHtml(value){
    const text = fmtMoney(value);
    const parts = text.split('.');
    const dollars = parts[0] || '0';
    const cents = parts[1] ? `<span class="r-expedite-price-cents">.${escapeHtml(parts[1])}</span>` : '';
    return `<span class="r-expedite-price-currency">$</span><span class="r-expedite-price-dollars">${escapeHtml(dollars)}</span>${cents}`;
  }

  function reportExpediteAddOnAmount(option, type = selectedType){
    if (!option) return 0;
    const base = TYPE_META[type]?.price ?? PRICE_RESIDENTIAL;
    const unit = Number(option.unit_price ?? reportExpediteUnitPrice(option, type || 'residential'));
    return Math.max(0, Math.round((unit - base) * 100) / 100);
  }

  function reportExpediteAddOnMoneyHtml(value){
    return `<span class="r-expedite-price-plus">+</span>${reportExpediteMoneyHtml(value)}`;
  }

  function reportExpeditePriceHtml(option, type = selectedType){
    if (option?.expedited && !reportExpeditePricingReady(type)) {
      return ("<span class=\"r-expedite-price is-loading\" aria-label=\"" + (globalThis.PlatformLanguage?.text("project-request","m_4345f5c42b261f","Loading current price") ?? "Loading current price") + "\"></span>");
    }
    if (!option?.expedited) {
      const standard = reportExpediteNetTotalPrice(option, type);
      return `<span class="r-expedite-price">${reportExpediteMoneyHtml(standard)}</span>`;
    }
    const gross = reportExpediteAddOnAmount(option, type);
    const net = reportExpediteCouponDiscount(option, type) > 0 ? 0 : gross;
    if (net < gross) {
      return `<span class="r-expedite-price has-coupon"><s>${reportExpediteAddOnMoneyHtml(gross)}</s><span>${reportExpediteAddOnMoneyHtml(net)}</span></span>`;
    }
    return `<span class="r-expedite-price">${reportExpediteAddOnMoneyHtml(gross)}</span>`;
  }

  function reportExpediteDeltaLabel(option, type = selectedType){
    if (!option) return '';
    const delta = reportExpediteAddOnAmount(option, type);
    return delta > 0 ? `+$${fmtMoney(delta)}` : '+$0';
  }

  function reportExpediteBusyLabel(option){
    const explicit = String(option?.busyLabel || option?.busy_label || option?.wait_label || '').trim();
    if (explicit) return explicit;
    const wait = Number(option?.estimatedWaitMinutes ?? option?.estimated_wait_minutes);
    if (!Number.isFinite(wait)) return 'We are busy';
    if (wait >= 300) return 'We are very busy';
    if (wait >= 225) return 'We are busy';
    return "We aren't very busy";
  }

  function reportExpediteEstimatedWaitMinutes(option){
    const explicit = Number(option?.estimatedWaitMinutes ?? option?.estimated_wait_minutes);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const start = Number(option?.startMinutes);
    const end = Number(option?.endMinutes);
    if (Number.isFinite(start) && Number.isFinite(end)) return Math.round((start + end) / 2);
    return 240;
  }

  function reportExpediteWaitPosition(option){
    const isStandard = option?.key === 'standard_3_6';
    const start = isStandard ? 180 : Number(option?.baseStartMinutes ?? option?.base_start_minutes ?? option?.startMinutes ?? 180);
    const end = isStandard ? 360 : Number(option?.baseEndMinutes ?? option?.base_end_minutes ?? option?.endMinutes ?? 360);
    const wait = reportExpediteEstimatedWaitMinutes(option);
    const range = Math.max(1, end - start);
    return Math.max(0, Math.min(100, Math.round(((wait - start) / range) * 100)));
  }

  function reportExpediteEstimatedWaitLabel(option){
    const minutes = reportExpediteEstimatedWaitMinutes(option);
    if (minutes < 60) return `${minutes} min estimate`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder
      ? `${hours} hr ${remainder} min estimate`
      : `${hours} hr estimate`;
  }

  function reportExpediteHash(value){
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function reportExpediteSeededRange(seed, min, max){
    return min + (reportExpediteHash(seed) / 0xffffffff) * (max - min);
  }

  function reportExpediteSmoothstep(value){
    const x = Math.max(0, Math.min(1, Number(value) || 0));
    return x * x * (3 - 2 * x);
  }

  function localReportExpediteStandardWait(now = new Date()){
    const parts = new Intl.DateTimeFormat((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hourValue = get('hour') % 24;
    const minute = get('minute');
    const dateSeed = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const minutesSinceMidnight = hourValue * 60 + minute;
    const tenMinuteSlot = Math.floor(minutesSinceMidnight / 10);
    const hour = minutesSinceMidnight / 60;
    const dailyBias = reportExpediteSeededRange(`${dateSeed}:bias`, -8, 8);
    const slotNoise = reportExpediteSeededRange(`${dateSeed}:slot:${tenMinuteSlot}`, -1, 1);
    const waveA = Math.sin((tenMinuteSlot * 0.62) + reportExpediteSeededRange(`${dateSeed}:phase:a`, 0, Math.PI * 2));
    const waveB = Math.sin((tenMinuteSlot * 1.17) + reportExpediteSeededRange(`${dateSeed}:phase:b`, 0, Math.PI * 2));
    const noise = dailyBias + slotNoise * 8 + waveA * 10 + waveB * 5;
    let target = 180;
    if (hour < 6) {
      target = 180;
    } else if (hour < 10) {
      const progress = reportExpediteSmoothstep((hour - 6) / 4);
      target = 180 + progress * 120 + noise * progress;
    } else if (hour < 14) {
      target = 285 + Math.max(-15, Math.min(15, noise));
    } else if (hour < 17) {
      const progress = reportExpediteSmoothstep((hour - 14) / 3);
      target = 285 - progress * 105 + noise * (1 - progress);
    }
    const loadWait = Math.round(Math.max(180, Math.min(360, target)) / 10) * 10;
    const wait = loadWait + 60;
    const busyLabel = loadWait >= 300
      ? 'We are very busy'
      : (loadWait >= 225 ? 'We are busy' : "We aren't very busy");
    return { wait, busyLabel };
  }

  function localReportExpeditePrice(optionKey, waitMinutes){
    const base = 7;
    const normalizedKey = normalizeReportExpediteKey(optionKey);
    const ratio = Math.max(0, Math.min(1, (waitMinutes - 240) / 180));
    const previousRushDelta = Math.round((8 + ratio * 2) * 10) / 10 - base;
    const increaseFee = (fee) => Math.round(Math.round(fee * 100) * EXPEDITE_FEE_PERCENT / 100) / 100;
    if (normalizedKey === 'rush_1_3') {
      return Math.round((base + increaseFee(previousRushDelta)) * 100) / 100;
    }
    if (normalizedKey === 'rush_under_1') {
      return Math.round((base + increaseFee(previousRushDelta * 3)) * 100) / 100;
    }
    return base;
  }

  function buildLocalReportExpediteOptions(type = selectedType, now = new Date(), structureCount = reportExpediteStructureCount(type)){
    const standardWait = localReportExpediteStandardWait(now);
    return FALLBACK_REPORT_EXPEDITE_OPTIONS.map((option) => {
      const unit = localReportExpeditePrice(option.key, standardWait.wait);
      const extraMinutes = isPerStructureType(type) ? Math.max(0, Number(structureCount || 1) - 1) * 30 : 0;
      const startMinutes = option.startMinutes == null ? null : option.startMinutes + extraMinutes;
      const endMinutes = option.endMinutes == null ? null : option.endMinutes + extraMinutes;
      const start = startMinutes == null ? null : addMinutes(now, startMinutes);
      const end = endMinutes == null ? null : addMinutes(now, endMinutes);
      const productionDeadlineMinutes = Number(option.productionDeadlineMinutes ?? option.production_deadline_minutes ?? startMinutes);
      const productionDeadline = Number.isFinite(productionDeadlineMinutes) ? addMinutes(now, productionDeadlineMinutes + extraMinutes) : start;
      const standardBase = type === 'commercial' || type === 'multifamily' ? 12 : 7;
      const rushDelta = Math.max(0, Math.round((unit - 7) * 100) / 100);
      return {
        ...option,
        startMinutes,
        endMinutes,
        baseStartMinutes: option.startMinutes,
        baseEndMinutes: option.endMinutes,
        structureCount: Math.max(1, Number(structureCount || 1) || 1),
        additionalStructureMinutes: extraMinutes,
        estimatedWaitMinutes: option.key === 'standard_3_6' ? standardWait.wait + extraMinutes : null,
        busyLabel: option.key === 'standard_3_6' ? standardWait.busyLabel : '',
        residentialPrice: unit,
        rushDelta,
        unit_price: isPerStructureType(type) ? Math.round((standardBase * (unit / PRICE_RESIDENTIAL)) * 100) / 100 : unit,
        window_label: start && end ? `${formatTurnaroundTime(start)} - ${formatTurnaroundTime(end)}` : '',
        due_window_start: start ? start.toISOString() : '',
        due_window_end: end ? end.toISOString() : '',
        production_deadline_minutes: Number.isFinite(productionDeadlineMinutes) ? productionDeadlineMinutes + extraMinutes : null,
        production_deadline_at: productionDeadline ? productionDeadline.toISOString() : '',
        _pricingAuthoritative: false
      };
    });
  }

  function selectedReportExpeditePricingPending(){
    const option = reportExpediteOptionsEnabled() ? selectedReportExpediteOption() : null;
    return !!(option?.expedited && !reportExpeditePricingReady());
  }

  function normalizeReportExpediteKey(key){
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized === 'rush_1_2' || normalized === 'rush_1_1_5') return 'rush_under_1';
    if (normalized === 'rush_2_3') return 'rush_1_3';
    if (normalized === 'rush_3_4' || normalized === 'no_rush') return 'standard_3_6';
    return normalized;
  }

  function normalizeReportExpediteOptionsResponse(data, type = selectedType, structureCount = reportExpediteStructureCount(type)){
    if (String(data?.algorithm || '').trim() === 'hardcoded_v1') {
      return buildLocalReportExpediteOptions(type, new Date(), structureCount);
    }
    const raw = Array.isArray(data?.options) ? data.options : [];
    const normalizedOptions = raw.map((option) => {
      const rawKey = String(option?.key || '').trim().toLowerCase();
      const key = normalizeReportExpediteKey(rawKey);
      if (!key) return null;
      const fallback = FALLBACK_REPORT_EXPEDITE_OPTIONS.find((item) => item.key === key) || {};
      const isAlias = rawKey && rawKey !== key;
      const useUiWindow = !!fallback.key;
      const additionalStructureMinutes = Number(option.additional_structure_minutes ?? option.additionalStructureMinutes ?? 0) || 0;
      const fallbackStartMinutes = fallback.startMinutes == null ? null : fallback.startMinutes + additionalStructureMinutes;
      const fallbackEndMinutes = fallback.endMinutes == null ? null : fallback.endMinutes + additionalStructureMinutes;
      return {
        key,
        label: String((useUiWindow ? fallback.label : option.label) || fallback.label || key),
        startMinutes: useUiWindow ? fallbackStartMinutes : (option.start_minutes ?? option.startMinutes ?? fallback.startMinutes ?? null),
        endMinutes: useUiWindow ? fallbackEndMinutes : (option.end_minutes ?? option.endMinutes ?? fallback.endMinutes ?? null),
        baseStartMinutes: useUiWindow ? (fallback.startMinutes ?? null) : (option.base_start_minutes ?? option.baseStartMinutes ?? fallback.startMinutes ?? null),
        baseEndMinutes: useUiWindow ? (fallback.endMinutes ?? null) : (option.base_end_minutes ?? option.baseEndMinutes ?? fallback.endMinutes ?? null),
        structureCount: Number(option.structure_count ?? option.structureCount ?? structureCount) || structureCount,
        additionalStructureMinutes,
        productionDeadlineMinutes: useUiWindow && fallback.productionDeadlineMinutes != null
          ? fallback.productionDeadlineMinutes + additionalStructureMinutes
          : (Number(option.production_deadline_minutes ?? option.productionDeadlineMinutes ?? fallback.productionDeadlineMinutes ?? fallbackStartMinutes ?? 0) || null),
        estimatedWaitMinutes: Number(option.estimated_wait_minutes ?? option.estimatedWaitMinutes ?? fallback.estimatedWaitMinutes ?? 0) || null,
        busyLabel: String(option.busy_label || option.busyLabel || option.wait_label || fallback.busyLabel || ''),
        residentialPrice: Number(option.residential_price ?? option.residentialPrice ?? fallback.residentialPrice ?? 7) || 7,
        rushDelta: Number(option.rush_delta ?? option.rushDelta ?? 0) || 0,
        unit_price: Number(option.unit_price ?? reportExpediteUnitPrice(option, type)) || reportExpediteUnitPrice(option, type),
        window_label: useUiWindow ? '' : String(option.window_label || ''),
        due_window_start: (isAlias || useUiWindow) ? '' : (option.due_window_start || ''),
        due_window_end: (isAlias || useUiWindow) ? '' : (option.due_window_end || ''),
        production_deadline_at: (isAlias || useUiWindow) ? '' : (option.production_deadline_at || ''),
        expedited: key === 'standard_3_6' ? false : option.expedited !== false,
        _pricingAuthoritative: true,
        pricing_revision: Number(data.pricing_revision ?? 0)
      };
    }).filter(Boolean);
    const byKey = new Map();
    [...FALLBACK_REPORT_EXPEDITE_OPTIONS, ...normalizedOptions].forEach((option) => {
      byKey.set(option.key, { ...(byKey.get(option.key) || {}), ...option });
    });
    return ['standard_3_6', 'rush_1_3', 'rush_under_1'].map((key) => byKey.get(key)).filter(Boolean);
  }

  function loadReportExpediteOptions(force = false){
    if (!reportExpediteOptionsEnabled() || !selectedType || !fmJson) return;
    const currentSlot = Math.floor(Date.now() / 600000);
    const structureCount = reportExpediteStructureCount(selectedType);
    if (!force && reportExpediteOptionsProjectType === selectedType && reportExpediteOptionsStructureCount === structureCount && reportExpediteOptionsSlot === currentSlot && reportExpediteOptions.length) return;
    if (reportExpediteOptionsLoading) return;
    reportExpediteOptionsLoading = true;
    reportExpediteOptionsAuthoritative = false;
    fmJson(`report-expedite-options?project_type=${encodeURIComponent(selectedType)}&structure_count=${encodeURIComponent(String(structureCount))}`)
      .then((data) => {
        const options = normalizeReportExpediteOptionsResponse(data, selectedType, structureCount);
        if (options.length) {
          reportExpediteOptions = options;
          reportExpediteOptionsProjectType = selectedType;
          reportExpediteOptionsStructureCount = structureCount;
          reportExpediteOptionsSlot = currentSlot;
          reportExpediteOptionsAuthoritative = options.every((option) => option._pricingAuthoritative === true);
          if (selectedReportExpedite && !reportExpediteOption(selectedReportExpedite)) selectedReportExpedite = null;
          renderWorkflowState();
        }
      })
      .catch((error) => {
        console.warn('Report expedite options unavailable; using fallback options.', error);
        const options = buildLocalReportExpediteOptions(selectedType, new Date(), structureCount);
        if (options.length) {
          reportExpediteOptions = options;
          reportExpediteOptionsProjectType = selectedType;
          reportExpediteOptionsStructureCount = structureCount;
          reportExpediteOptionsSlot = currentSlot;
          reportExpediteOptionsAuthoritative = false;
          renderWorkflowState();
        }
      })
      .finally(() => {
        reportExpediteOptionsLoading = false;
        renderWorkflowState();
      });
  }

  function stopReportExpediteMinuteRefresh(){
    if (reportExpediteMinuteTimer) clearTimeout(reportExpediteMinuteTimer);
    reportExpediteMinuteTimer = null;
  }

  function reportExpediteMinuteRefreshActive(){
    const overlay = $('#rOverlay');
    if (!overlay?.classList.contains('active')) return false;
    if (!reportExpediteOptionsEnabled() || !selectedType) return false;
    return !!document.querySelector('#rExpeditePanel.visible, [data-select-upgrade-expedite], [data-followup-expedite]');
  }

  function refreshReportExpediteOptionsForClock(){
    if (!reportExpediteOptionsEnabled() || !selectedType) return;
    if (fmJson) {
      loadReportExpediteOptions(true);
      return;
    }
    const structureCount = reportExpediteStructureCount(selectedType);
    reportExpediteOptions = buildLocalReportExpediteOptions(selectedType, new Date(), structureCount);
    reportExpediteOptionsProjectType = selectedType;
    reportExpediteOptionsStructureCount = structureCount;
    reportExpediteOptionsSlot = Math.floor(Date.now() / 600000);
    reportExpediteOptionsAuthoritative = false;
    renderWorkflowState();
  }

  function syncReportExpediteMinuteRefresh(){
    if (!reportExpediteMinuteRefreshActive()) {
      stopReportExpediteMinuteRefresh();
      return;
    }
    if (reportExpediteMinuteTimer) return;
    const delay = Math.max(1000, 60000 - (Date.now() % 60000) + 120);
    reportExpediteMinuteTimer = setTimeout(() => {
      reportExpediteMinuteTimer = null;
      if (!reportExpediteMinuteRefreshActive()) return;
      refreshReportExpediteOptionsForClock();
      syncReportExpediteMinuteRefresh();
    }, delay);
  }

  function selectedReportExpeditePayload(){
    const option = selectedReportExpediteOption();
    if (!option) return {};
    const now = new Date();
    const start = option.due_window_start ? new Date(option.due_window_start) : (option.startMinutes == null ? null : addMinutes(now, option.startMinutes));
    const end = option.due_window_end ? new Date(option.due_window_end) : (option.endMinutes == null ? null : addMinutes(now, option.endMinutes));
    const productionDeadline = option.production_deadline_at
      ? new Date(option.production_deadline_at)
      : addMinutes(now, Number(option.productionDeadlineMinutes ?? option.production_deadline_minutes ?? option.startMinutes ?? 0) || 0);
    return {
      report_expedite_option: option.key,
      report_expedite_label: option.key === 'no_rush' ? 'No Rush' : option.label,
      report_due_window_start: start ? start.toISOString() : '',
      report_due_window_end: end ? end.toISOString() : '',
      report_due_window_label: reportExpediteWindowLabel(option, now),
      report_production_deadline_at: productionDeadline ? productionDeadline.toISOString() : '',
      report_expedite_unit_price: String(reportExpediteUnitPrice(option, selectedType)),
      report_expedite_total_price: String(reportExpediteTotalPrice(option, selectedType)),
      report_expedite_net_total_price: String(reportExpediteNetTotalPrice(option, selectedType)),
      report_expedite_rush_delta: String(Math.max(0, Math.round((reportExpediteUnitPrice(option, selectedType) - (TYPE_META[selectedType]?.price ?? PRICE_RESIDENTIAL)) * 100) / 100)),
      report_pricing_revision: String(option.pricing_revision ?? 0),
      report_expedite_structure_count: String(reportExpediteStructureCount(selectedType)),
      report_expedite_additional_structure_minutes: String(Number(option.additionalStructureMinutes ?? option.additional_structure_minutes ?? 0) || 0),
      report_expedite_coupon_available: reportExpediteCouponDiscount(option, selectedType) > 0 ? '1' : '0',
      report_expedite_coupon_discount: String(reportExpediteCouponDiscount(option, selectedType)),
      report_estimated_wait_minutes: String(reportExpediteEstimatedWaitMinutes(defaultReportExpediteOption() || option)),
      is_expedited: option.expedited ? '1' : '0',
    };
  }

  function setStepState(id, open, status, condensed, extraClasses){
    const step = $(id);
    if (!step) return;
    step.classList.toggle('is-open', !!open);
    step.classList.toggle('is-hidden', !open);
    step.classList.toggle('is-condensed', !!condensed && !!open);
    step.classList.toggle('hide-prices', !!(extraClasses && extraClasses.hidePrices) && !!open);
    step.classList.toggle('use-summary', !!(extraClasses && extraClasses.useSummary) && !!open);
    step.classList.toggle('hide-head-when-condensed', !!(extraClasses && extraClasses.hideHeadWhenCondensed) && !!open);
    step.dataset.status = status;
  }

  function renderTypeSelection(){
    normalizeReportSelection();
    document.querySelectorAll('.r-type-btn').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.type === selectedType);
    });
    const pill = $('#rTypePill');
    if (pill) {
      const meta = selectedType ? TYPE_META[selectedType] : null;
      if (!meta) {
        pill.innerHTML = '';
        return;
      }
      const icon = escapeHtml(meta.icon || 'fa-house');
      const label = escapeHtml(meta.label || selectedType);
      pill.innerHTML = hasReportOrdered()
        ? ("<span class=\"r-viewer-type-tag\" aria-label=\"" + (globalThis.PlatformLanguage?.text("project-request","m_207fd0b5cbe442","Project type") ?? "Project type") + "\"><i class=\"fas " + String(icon) + "\"></i> " + String(label) + "</span>")
        : `<label class="r-order-select"><i class="fas ${String(icon)}" aria-hidden="true"></i><select data-property-type aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_dccbe8abe35b17","Property type") ?? "Property type")}">${String(Object.entries(TYPE_META).map(([key,item])=>`<option value="${escapeHtml(key)}" ${key===selectedType?'selected':''}>${escapeHtml(item.label)}</option>`).join(''))}</select><i class="fas fa-chevron-down" aria-hidden="true"></i></label>`;
    }
  }

  function renderReportExpediteChoice(availableActions = availableProjectActions()){
    const panel = $('#rExpeditePanel');
    if (!panel) return;
    const visible = reportExpediteOptionsEnabled()
      && hasSelectedAddons()
      && roofReportControlsUnlocked()
      && addressSelected
      && !!selectedType;
    panel.classList.toggle('visible', visible);
    const closed = reportOrderingClosed();
    panel.classList.toggle('is-closed', visible && closed);
    const expediteSubmit = $('#rExpediteSubmit');
    if (expediteSubmit) expediteSubmit.classList.toggle('visible', visible);
    if (!visible) return;
    loadReportExpediteOptions();

    const defaultOption = defaultReportExpediteOption();
    const waitMount = $('#rExpediteWait');
    if (waitMount && closed) {
      waitMount.innerHTML = '';
    } else if (waitMount && defaultOption) {
      const position = reportExpediteWaitPosition(defaultOption);
      waitMount.innerHTML = `
        <div class="r-expedite-default-head">
          <div class="r-expedite-status">
            <strong>${String(escapeHtml(reportExpediteBusyLabel(defaultOption)))}</strong>
            <span>${(globalThis.PlatformLanguage?.text("project-request","m_484b63459c1357","Estimated wait time right now") ?? "Estimated wait time right now")}</span>
          </div>
          <div class="r-expedite-eta">${String(escapeHtml(reportExpediteEstimatedWaitLabel(defaultOption)))}</div>
        </div>
        <div class="r-expedite-bar" style="--wait-position:${String(position)}%"><span class="r-expedite-marker" aria-hidden="true"></span></div>
        <div class="r-expedite-bar-labels"><span>${(globalThis.PlatformLanguage?.text("project-request","m_c025d9e87eaacd","4 hrs") ?? "4 hrs")}</span><span>${(globalThis.PlatformLanguage?.text("project-request","m_ed52be56a2ea6c","7 hrs") ?? "7 hrs")}</span></div>`;
    } else if (waitMount) {
      waitMount.innerHTML = '';
    }

    const optionsMount = $('#rExpediteOptions');
    if (optionsMount) {
      const selectedOption = selectedReportExpediteOption();
      const pricingReady = reportExpeditePricingReady();
      optionsMount.innerHTML = reportExpediteOptions.map((option) => {
        const isStandard = option.key === defaultOption?.key;
        const selected = selectedOption?.key === option.key;
        const disabled = option.expedited && (closed || !pricingReady);
        const name = isStandard
          ? `Standard Delivery - ${reportExpediteDurationLabel(option)}`
          : reportExpediteDurationLabel(option);
        const window = reportExpediteCustomerPromiseLabel(option);
        const priceText = option.expedited && !pricingReady ? '' : reportExpediteDeltaLabel(option, selectedType);
        const windowCompact = window.length >= 16 || priceText.length >= 5 ? ' compact' : '';
        return `
          <button type="button" class="r-expedite-btn${isStandard ? ' r-expedite-default' : ''}${selected ? ' selected' : ''}" data-expedite-option="${escapeHtml(option.key)}" ${disabled ? 'disabled' : ''}>
            <span class="r-expedite-copy">
              <span class="r-expedite-name">${escapeHtml(name)}</span>
              <span class="r-expedite-window${windowCompact}">${escapeHtml(window)}</span>
              ${isStandard ? '' : `<span class="r-expedite-pill">${(globalThis.PlatformLanguage?.text("project-request","m_b51f2220e8185c","Expedited") ?? "Expedited")}</span>`}
            </span>
            ${reportExpeditePriceHtml(option, selectedType)}
          </button>`;
      }).join('');
    }

    const couponMount = $('#rExpediteCouponNotice');
    if (couponMount) {
      const selectedOption = selectedReportExpediteOption();
      const uses = freeExpediteUses();
      const showCoupon = selectedOption && reportExpediteCouponDiscount(selectedOption, selectedType) > 0;
      couponMount.classList.toggle('visible', !!showCoupon);
      couponMount.innerHTML = showCoupon
        ? `<i class="fas fa-bolt"></i><span>${((v0,v1) => globalThis.PlatformLanguage?.text("project-request","m_b08d94d95ec9f8",`Includes free expedite. ${v0} free expedite use${v1} remaining.`,{v0,v1}) ?? `Includes free expedite. ${v0} free expedite use${v1} remaining.`)(uses,uses === 1 ? '' : 's')}</span>`
        : '';
    }

    if (expediteSubmit) {
      const selectedOption = selectedReportExpediteOption();
      const pricingPending = selectedOption?.expedited && !reportExpeditePricingReady();
      const price = selectedOption && !pricingPending ? reportExpediteTotalPriceLabel(selectedOption, selectedType) : '';
      expediteSubmit.disabled = !!pricingPending;
      expediteSubmit.textContent = pricingPending ? 'Checking current price...' : (price ? `Order Roof Report - ${price}` : 'Order Roof Report');
    }
  }

  function renderRoofChoice(){
    normalizeReportSelection();
    const availableActions = availableProjectActions();
    const actionRow = document.querySelector('.r-report-choice-row');
    if (actionRow) actionRow.style.display = availableActions.length > 1 && !reportSelection ? '' : 'none';
    document.querySelectorAll('.r-toggle-btn[data-report-choice]').forEach((btn) => {
      const key = btn.dataset.reportChoice;
      btn.classList.toggle('selected', reportSelection === key);
      btn.style.display = actionAvailable(key) ? '' : 'none';
    });
    renderReportExpediteChoice(availableActions);
    const showGutters = gutterReportsEnabled() && selectedType === 'residential';
    const showWeather = weatherReportsEnabled();
    const showInspection = instantReportsEnabled();
    const showAddonGroup = hasSelectedAddons();
    const showReportControls = showAddonGroup && roofReportControlsUnlocked();
    const showScheduleGroup = isScheduleChoice();
    if (!showAddonGroup) hideAddonInfoPopout();
    const addOns = $('#rReportAddons');
    if (addOns) addOns.classList.remove('visible');
    const optionGroup = $('#rReportOptionGroup');
    if (optionGroup) optionGroup.style.display = (showAddonGroup || showScheduleGroup) ? '' : 'none';
    const roofFields = $('#rRoofReportFields');
    if (roofFields) roofFields.style.display = showAddonGroup ? '' : 'none';
    const scheduleCard = $('#rScheduleChoiceCard');
    if (scheduleCard) scheduleCard.classList.toggle('visible', showScheduleGroup);
    updateScheduleChoiceCard();
    document.querySelector('[data-report-addon="gutters"]')?.classList.toggle('selected', hasGutterAddon());
    document.querySelector('[data-report-addon="weather"]')?.classList.toggle('selected', hasWeatherAddon());
    document.querySelector('[data-report-addon="inspection"]')?.classList.toggle('selected', includeInstantPreview);
    const gutters = document.querySelector('[data-report-addon="gutters"]');
    if (gutters) {
      const visible = showReportControls && showGutters;
      gutters.classList.toggle('visible', visible);
      gutters.style.display = visible ? '' : 'none';
    }
    const weather = document.querySelector('[data-report-addon="weather"]');
    if (weather) {
      const visible = showReportControls && showWeather;
      weather.classList.toggle('visible', visible);
      weather.style.display = visible ? '' : 'none';
    }
    const inspection = document.querySelector('[data-report-addon="inspection"]');
    if (inspection) {
      const visible = showReportControls && showInspection;
      inspection.classList.toggle('visible', visible);
      inspection.style.display = visible ? '' : 'none';
    }
    const inspectionPrice = document.querySelector('[data-addon-price="inspection"]');
    if (inspectionPrice) {
      const unit = instantAddonUnitPriceFor(selectedType);
      const total = isPerStructureType(selectedType) ? unit * Math.max(1, pinCount()) : unit;
      inspectionPrice.textContent = selectedType
        ? `+$${fmtMoney(total)}`
        : 'Choose type';
    }
    const gutterPrice = document.querySelector('[data-addon-price="gutters"]');
    if (gutterPrice) gutterPrice.textContent = `+$${fmtMoney(GUTTER_REPORT_ADDON)}`;
    const weatherPrice = document.querySelector('[data-addon-price="weather"]');
    if (weatherPrice) weatherPrice.textContent = `+$${fmtMoney(WEATHER_REPORT_ADDON * Math.max(1, pinCount()))}`;
  }

  function renderProjectTodoDock(){
    const dock = $('#rWorkflowDock');
    const mount = $('#rProjectTodoList');
    if (!dock || !mount) return;
    const visible = showProjectTodoDock();
    $('#rOverlay')?.classList.toggle('project-todos-visible', visible);
    dock.classList.toggle('visible', visible);
    if (!visible) {
      projectTodoController?.destroy?.();
      projectTodoController = null;
      projectTodoLoadedFor = '';
      mount.innerHTML = '';
      return;
    }
    const projectId = projectText(activeProjectRouteId(), activeBaseProject?.platform_project_id, activeBaseProject?.base_project_id, activeBaseProject?.id);
    const orgId = projectOrgId();
    if (!projectId) {
      projectTodoController?.destroy?.();
      projectTodoController = null;
      projectTodoLoadedFor = '';
      mount.innerHTML = `<div class="pai-today-list"><div class="pai-state">${(globalThis.PlatformLanguage?.text("project-request","m_4998638df5e181","Project to-dos will appear here once this project is saved.") ?? "Project to-dos will appear here once this project is saved.")}</div></div>`;
      return;
    }
    if (!orgId || !window.PlatformActionItems?.renderTodayList) {
      mount.innerHTML = `<div class="pai-today-list"><div class="pai-state">${(globalThis.PlatformLanguage?.text("project-request","m_48f1ac01db9289","Project to-dos are not available.") ?? "Project to-dos are not available.")}</div></div>`;
      return;
    }
    const key = `${orgId}:${projectId}`;
    if (projectTodoController && projectTodoLoadedFor === key) {
      projectTodoController.load({ quiet: true }).catch(() => null);
      return;
    }
    projectTodoController?.destroy?.();
    projectTodoLoadedFor = key;
    projectTodoController = window.PlatformActionItems.renderTodayList(mount, {
      orgId,
      branchId: window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default',
      projectId,
      projectTitle: projectTitleAlias(activeBaseProject || {}) || projectText(activeBaseProject?.customer_name, activeBaseProject?.resident_name, activeBaseProject?.address, 'Project'),
      projectAddress: projectText(activeBaseProject?.address, activeBaseProject?.project_address, reportOrderState?.address),
      userId: String(cfg.userId || window.__APP?.userId || ''),
      completedOpen: false,
      futureOpen: false,
      dockDeferredSections: true,
      scrollItemsOnly: true,
      showProjectContext: false,
      showUpcoming: true,
      showFuture: true,
      query: { includeFuture: true, includeAll: true }
    });
  }

  function addonInfoPopout(){
    return document.getElementById('rAddonInfoPopout');
  }

  function hideAddonInfoPopout(delay = 0){
    clearTimeout(addonInfoHideTimer);
    addonInfoHideTimer = setTimeout(() => {
      addonInfoPopout()?.classList.remove('visible');
    }, Math.max(0, delay));
  }

  function closeAddonInfoSurfaces(){
    clearTimeout(addonInfoHideTimer);
    addonInfoHideTimer = null;
    const pop = addonInfoPopout();
    if (pop) {
      pop.classList.remove('visible');
      pop.innerHTML = '';
    }
    closeAddonInfoModal();
  }

  function showAddonInfoPopout(toggle){
    if (!toggle || isMobileProjectOrder()) return;
    const key = toggle.dataset.addonInfo || toggle.dataset.reportAddon || '';
    const pop = addonInfoPopout();
    const right = document.getElementById('rMapWrap');
    if (!key || !pop || !right) return;
    clearTimeout(addonInfoHideTimer);
    pop.innerHTML = reportAddonInfoHtml(key);
    const toggleRect = toggle.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();
    const top = Math.max(18, Math.min(rightRect.height - 260, toggleRect.top - rightRect.top));
    pop.style.top = `${top}px`;
    pop.classList.add('visible');
  }

  function closeAddonInfoModal(){
    const overlay = document.getElementById('rAddonInfoModal');
    const handle = addonInfoModalHandle;
    addonInfoModalHandle = null;
    handle?.unregister?.();
    overlay?.remove();
  }

  function showAddonInfoModal(key){
    closeAddonInfoModal();
    const overlay = document.createElement('div');
    overlay.className = 'r-addon-info-modal';
    overlay.id = 'rAddonInfoModal';
    overlay.innerHTML = `
      <div class="r-addon-info-modal-card" role="dialog" aria-modal="true">
        <button type="button" class="r-addon-info-modal-close" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
        ${String(reportAddonInfoHtml(key))}
      </div>`;
    document.body.appendChild(overlay);
    addonInfoModalHandle = window.Portal?.modals?.register?.(overlay, {
      id: 'addon-info',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: () => {
        addonInfoModalHandle = null;
        overlay.remove();
      }
    }) || null;
    overlay.style.zIndex = '2147483520';
    overlay.querySelector('.r-addon-info-modal-close')?.addEventListener('click', closeAddonInfoModal);
  }

  function openAddonInfoFromEvent(event){
    const trigger = event.target?.closest?.('[data-addon-info-trigger]');
    if (!trigger) return false;
    event.preventDefault();
    event.stopPropagation();
    showAddonInfoModal(trigger.dataset.addonInfoTrigger || '');
    return true;
  }

  function bindAddonInfoInteractions(){
    document.querySelectorAll('.r-addon-toggle[data-addon-info]').forEach((toggle) => {
      toggle.addEventListener('mouseenter', () => showAddonInfoPopout(toggle));
      toggle.addEventListener('mouseleave', () => hideAddonInfoPopout(120));
      toggle.addEventListener('focusin', () => showAddonInfoPopout(toggle));
      toggle.addEventListener('focusout', () => hideAddonInfoPopout(120));
    });
    const pop = addonInfoPopout();
    pop?.addEventListener('mouseenter', () => clearTimeout(addonInfoHideTimer));
    pop?.addEventListener('mouseleave', () => hideAddonInfoPopout(80));
    document.querySelectorAll('[data-addon-info-trigger]').forEach((trigger) => {
      const open = (event) => {
        openAddonInfoFromEvent(event);
      };
      trigger.addEventListener('click', open);
      trigger.addEventListener('touchend', open, { passive: false });
      trigger.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        open(event);
      });
    });
  }

  function renderPinInfo(){
    const el = $('#rPinInfo');
    const count = pinCount();
    const maxPins = maxPinsForType(selectedType);
    const showLimitNotice = structurePinLimitNoticeActive && !!maxPins && count >= maxPins;
    if (!showLimitNotice && (!maxPins || count < maxPins)) {
      structurePinLimitNoticeActive = false;
    }
    if (el) {
      el.classList.toggle('has-pins', count > 0);
      el.classList.toggle('pin-limit', showLimitNotice);
      el.querySelector('.r-pin-count').textContent = count;
      el.querySelector('.r-pin-text').textContent = showLimitNotice
        ? pinLimitMessage(maxPins)
        : count === 0
        ? 'Click the map to place pins on each structure you want included.'
        : count === 1 ? '1 pin placed' : `${count} pins placed`;
    }
    const mobileCount = $('#rMobilePinCount');
    if (mobileCount) {
      mobileCount.textContent = showLimitNotice
        ? pinLimitMessage(maxPins)
        : count === 0
        ? 'No pins placed'
        : count === 1 ? '1 pin placed' : `${count} pins placed`;
    }
    renderPricingNote();
  }

  function renderPricingNote(){
    const el = $('#rPricingNote');
    if (!el) return;
    const count = pinCount();
    if (!selectedType || !hasSelectedAddons() || !isPerStructureType(selectedType) || count <= 1) {
      el.classList.remove('visible');
      el.innerHTML = '';
      renderReferralDiscountNotice();
      return;
    }
    const reportLabel = reportModeLabel();
    const quote = currentPriceQuote();
    const base = reportBaseUnitPrice(selectedType);
    const instant = includeInstantPreview ? instantAddonUnitPriceFor(selectedType) : 0;
    const unit = base + instant;
    el.innerHTML = `<i class="fas fa-calculator"></i> ${reportLabel}: ${count} structures x $${fmtMoney(unit)} = $${fmtMoney(quote.final_amount)} total`;
    el.classList.add('visible');
    renderReferralDiscountNotice();
  }

  function renderReferralDiscountNotice(){
    const el = $('#rReferralDiscount');
    if (!el) return;
    const discount = window.Portal?.pricing?.activeReferralDiscount?.();
    if (!discount || !selectedType || !hasSelectedAddons()) {
      el.classList.remove('visible');
      el.innerHTML = '';
      return;
    }
    const quote = currentPriceQuote();
    if (quote.active) {
      el.innerHTML = `<i class="fas fa-percent"></i><span>${((v0) => globalThis.PlatformLanguage?.text("project-request","m_2bba8198d7ade2",`${v0}% referral discount applied. `,{v0}) ?? `${v0}% referral discount applied. `)(quote.discount_percent)}<s>$${String(fmtMoney(quote.original_amount))}</s>${((v2) => globalThis.PlatformLanguage?.text("project-request","m_ede7d3676ea640",`$${v2} total.`,{v2}) ?? `$${v2} total.`)(fmtMoney(quote.final_amount))}</span>`;
    } else {
      el.innerHTML = `<i class="fas fa-percent"></i><span>${((v0) => globalThis.PlatformLanguage?.text("project-request","m_c5fd3cbf0b07a0",`Your ${v0}% referral discount applies to standard report base pricing.`,{v0}) ?? `Your ${v0}% referral discount applies to standard report base pricing.`)(discount.discount_percent)}</span>`;
    }
    el.classList.add('visible');
  }

  function renderConfirm(){
    const wrap = $('#rConfirm');
    const tx = $('#rConfirmTx');
    const ic = $('#rConfirmIc');
    if (!wrap || !tx || !ic) return;
    const mobileLocation = shouldUseMobileOrderPagination() && mobileOrderPage === 'location';
    const next = $('#rMobilePinNext');
    if (next) next.hidden = !mobileLocation || !mobileOrderReadyForDetails();
    if (mobileLocation && wrap.dataset.pinConfirmed === 'true' && !locationConfirmed) {
      wrap.classList.remove('pin-returning');
      void wrap.offsetWidth;
      wrap.classList.add('pin-returning');
    }
    wrap.dataset.pinConfirmed = String(locationConfirmed);

    wrap.classList.remove('active', 'checked');
    wrap.setAttribute('aria-checked',String(locationConfirmed));
    wrap.setAttribute('aria-labelledby','rConfirmTx');

    if (!hasSelectedAddons()) {
      tx.textContent = (globalThis.PlatformLanguage?.text("project-request","m_2f7dd304a33ed5","Skip roof-report placement and continue to customer details.") ?? "Skip roof-report placement and continue to customer details.");
      ic.innerHTML = `<i class="far fa-square"></i>`;
      return;
    }
    if (!addressSelected || pinCount() === 0) {
      tx.textContent = (globalThis.PlatformLanguage?.text("project-request","m_d8cc2d868e3317","Place at least one pin on the map.") ?? "Place at least one pin on the map.");
      ic.innerHTML = `<i class="far fa-square"></i>`;
      return;
    }

    wrap.classList.add('active');
    if (!locationConfirmed) {
      tx.textContent = (globalThis.PlatformLanguage?.text("project-request","m_93a548f13a353b","I have placed a pin on every structure to be included in this report") ?? "I have placed a pin on every structure to be included in this report");
      ic.innerHTML = `<i class="far fa-square"></i>`;
      return;
    }

    wrap.classList.add('checked');
    if (mobileLocation) {
      tx.textContent = 'Pin confirmed';
      ic.innerHTML = `<i class="fas fa-check-square"></i>`;
      return;
    }
    tx.textContent = pinCount() === 1
      ? 'Confirmed - 1 pin placed'
      : `Confirmed - ${pinCount()} pins placed`;
    ic.innerHTML = `<i class="fas fa-check-square"></i>`;
  }

  function revealCustomerSection(){
    const scrollWrap = document.querySelector('#rOverlay .r-scroll');
    const section = $('#rStepCustomer');
    if (!scrollWrap || !section) return;
    const top = Math.max(0, section.offsetTop - 10);
    scrollWrap.scrollTo({ top, behavior: 'smooth' });
  }

  function handleBackOrClose(e){
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (proposalSigningMode) {
      proposalSigningMode = false;
      proposalSigningSession = null;
      closeSignatureChooser();
      renderWorkflowState();
      renderSigningOverlay();
      return;
    }
    if (proposalSettingsPanelOpen) {
      closeProposalSettingsPanel();
      return;
    }
    if (proposalWorkspaceOpen) {
      hideProposalWorkspace();
      return;
    }
    close();
  }

  function renderActionRow(){
    const normalSubmit = $('#rSubmit');
    const expediteSubmit = $('#rExpediteSubmit');
    const controlsUnlocked = roofReportControlsUnlocked();
    const useExpediteSubmit = controlsUnlocked && reportExpediteOptionsEnabled() && hasSelectedAddons() && !hasReportOrdered();
    if (normalSubmit) normalSubmit.style.display = controlsUnlocked && hasSelectedAddons() && !hasReportOrdered() && !useExpediteSubmit ? 'flex' : 'none';
    if (expediteSubmit) expediteSubmit.classList.toggle('visible', useExpediteSubmit);
  }

  function activeSubmitButton(){
    return $('#rExpediteSubmit.visible') || $('#rSubmit');
  }

  function renderSigningOverlay(preservedScrollTop = null){
    const overlay = $('#rSigningOverlay');
    const mount = $('#rSigningSheet');
    if (!overlay || !mount) return;
    const proposal = proposals[activeProposalIndex];
    if (!proposalSigningMode || !proposal) {
      overlay.classList.remove('active');
      mount.innerHTML = '';
      return;
    }
    ensureProposalPageIds(proposal);
    ensureProposalSignatureData(proposal, true);
    const session = ensureProposalSigningSession(proposal);
    const nextUnsigned = proposalNextUnsignedTarget(proposal);
    const canFinish = proposalSigningComplete(proposal);
    const priorWrap = mount.querySelector('.r-proposal-wrap');
    const scrollTop = preservedScrollTop ?? priorWrap?.scrollTop ?? 0;
    const primaryColor = getProposalPrimaryColor();
    const accentColor = getProposalAccentColor();
    const accentReadable = getProposalAccentReadableColor();
    mount.style.setProperty('--primary', primaryColor);
    mount.style.setProperty('--primary-readable', primaryColor);
    mount.style.setProperty('--primary-rgb', hexToRgbString(primaryColor));
    mount.style.setProperty('--accent', accentColor);
    mount.style.setProperty('--accent-readable', accentReadable);
    mount.style.setProperty('--accent-rgb', hexToRgbString(accentReadable));
    mount.style.setProperty('--accent-soft', `${accentColor}66`);
    const top = $('#rSigningOverlay .r-signing-top');
    if (top) {
      top.innerHTML = `
        <button type="button" class="r-signing-back" id="rSigningBack"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("project-request","m_206d31a7c795c4"," Back") ?? " Back")}</button>
        <div class="r-signing-actions">
          ${String(canFinish ? `<button type="button" class="r-signing-finish" id="rSigningFinishTop"><i class="fas fa-paper-plane"></i> Finish and Send</button>` : `<button type="button" class="r-signing-next" id="rSigningNext"><i class="fas fa-arrow-right"></i> Next Signature</button>`)}
        </div>
      `;
    }
    mount.innerHTML = `
      <div class="r-proposal-wrap">
        <div class="r-proposal-pages">
          ${proposalRenderSections(proposal).map((entry, overallIndex) => `
            <section class="r-proposal-page theme-${proposal.theme || 'margin'}${overallIndex === 0 ? ' is-cover' : ' is-inner'}" data-proposal-page-index="${entry.logicalIndex}" style="${proposal.theme === 'triangles' && overallIndex !== 0 ? proposalTriangleHeaderVars(entry.page) : ''}">
              <div class="r-proposal-page-shape-top"></div>
              ${proposal.theme === 'margin' && overallIndex === 0 ? `<div class="r-proposal-margin-logo">${proposalBrandLockup('margin', 'signing')}</div>` : ''}
              ${proposal.theme === 'triangles' && overallIndex === 0 ? `<div class="r-proposal-triangle-logo">${proposalBrandLockup('triangles', 'signing', true)}</div>` : ''}
              <div class="r-proposal-page-header">
                ${proposalBrandLockup('clean', 'signing')}
                <div class="r-proposal-page-number">${overallIndex === 0 ? '' : String(overallIndex + 1).padStart(2, '0')}</div>
              </div>
              <div class="r-proposal-page-content">
                ${proposalPageMarkup(entry.page, 'signing')}
              </div>
            </section>
          `).join('')}
        </div>
      </div>
    `;
    const wrap = mount.querySelector('.r-proposal-wrap');
    if (wrap) wrap.scrollTop = scrollTop;
    mount.querySelectorAll('[data-sign-slot]').forEach((slot) => {
      slot.addEventListener('click', () => {
        const currentScrollTop = wrap?.scrollTop ?? 0;
        const pageIndex = Number(slot.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || 0);
        const page = proposal.pages?.[pageIndex];
        if (!page) return;
        activeProposalPageIndex = pageIndex;
        openSignatureChooser(page, slot.dataset.signSlot, slot.dataset.signSigner || 'customer');
        if (wrap) wrap.scrollTop = currentScrollTop;
      });
    });
    $('#rSigningBack')?.addEventListener('click', () => {
      proposalSigningMode = false;
      proposalSigningSession = null;
      closeSignatureChooser();
      renderWorkflowState();
      renderSigningOverlay();
    });
    $('#rSigningNext')?.addEventListener('click', () => {
      const target = proposalNextUnsignedTarget(proposal);
      if (!target) return;
      const pageIndex = proposal.pages.findIndex((page) => page.id === target.pageId);
      scrollSigningToTarget({ ...target, pageIndex });
    });
    $('#rSigningFinishTop')?.addEventListener('click', () => {
      proposal.signatures = { ...(session?.signerTemplates || {}) };
      proposalSigningMode = false;
      proposalSigningSession = null;
      closeSignatureChooser();
      showToast((globalThis.PlatformLanguage?.text("project-request","m_ab7ec8db303996","Signed") ?? "Signed"), (globalThis.PlatformLanguage?.text("project-request","m_9304bb766f7e70","Signed proposal prepared for sending.") ?? "Signed proposal prepared for sending."), true);
      renderWorkflowState();
      renderSigningOverlay();
    });
    overlay.classList.add('active');
  }

  function updateSubmitLabel(){
    const submits = Array.from(document.querySelectorAll('#rSubmit,#rExpediteSubmit'));
    if (!submits.length) return;
    let text = 'Continue';
    if (hasReportOrdered()) {
      text = 'Proposals';
    } else if (hasSelectedAddons()) {
      const quote = currentPriceQuote();
      const expediteOption = reportExpediteOptionsEnabled() ? selectedReportExpediteOption() : null;
      const pricingPending = selectedReportExpeditePricingPending();
      const expeditePrice = expediteOption && !pricingPending ? reportExpediteTotalPriceLabel(expediteOption, selectedType) : '';
      text = selectedType
        ? (pricingPending
          ? 'Checking current price...'
          : (expeditePrice
          ? `Order Roof Report - ${expeditePrice}`
          : (quote.active
            ? `Order Roof Report - $${fmtMoney(quote.final_amount)} (save $${fmtMoney(quote.discount_amount)})`
            : `Order Roof Report - $${fmtMoney(quote.final_amount)}`)))
        : 'Order Roof Report';
    } else if (isProposalChoice() && proposalsEnabled()) {
      text = 'Proposals';
    } else if (isScheduleChoice()) {
      text = 'Confirm Appointment';
    }
    submits.forEach((submit) => {
      submit.textContent = text;
      submit.disabled = !canSubmit() || selectedReportExpeditePricingPending() || (isScheduleChoice() && !scheduleHasDraft());
    });
    renderActionRow();
    syncMobileOrderPagination();
  }

  function setSubmitBusyLabel(button, label){
    const targets = [button, $('#rMobileOrder')].filter(Boolean);
    targets.forEach((target) => {
      target.disabled = true;
      target.innerHTML = `<i class="fas fa-circle-notch fa-spin r-submit-spinner" aria-hidden="true"></i><span>${escapeHtml(label)}</span>`;
    });
  }

  function setActivePreviewTab(tab, options = {}){
    const previousTab = activePreviewTab;
    window.Portal.ExteriorOrder?.previewTabChanged?.(tab);
    const allowed = validPreviewTabs();
    // Docs consolidation aliases: the retired standalone Documents tab and the
    // deprecated Proposals tab both land on the unified Docs tab.
    if (!allowed.includes(tab) && ['documents', 'proposal'].includes(tab) && allowed.includes('docs')) tab = 'docs';
    activePreviewTab = allowed.includes(tab) ? tab : projectDefaultPreviewTab();
    proposalWorkspaceOpen = proposalsEnabled() && activePreviewTab === 'proposal';
    if (activePreviewTab !== 'proposal') proposalSettingsPanelOpen = false;
    if (!proposalWorkspaceOpen) {
      proposalWorkspaceMode = 'list';
      proposalEditorMode = 'preview';
      proposalMarkupMode = false;
      proposalMarkupDockOpen = false;
      proposalMarkupPopover = null;
      proposalActionExpanded = false;
      proposalSigningMode = false;
      proposalSigningSession = null;
      closeSignatureChooser();
    }
    $('#rOverlay')?.classList.toggle('proposal-workspace', !!proposalWorkspaceOpen);
    if (!proposalWorkspaceOpen) $('#rOverlay')?.classList.remove('proposal-list-mode', 'proposal-edit-mode', 'proposal-send-mode', 'proposal-builder-mode');
    syncLeftColumnOverride();
    syncMobileProjectInfoNavigation();
    ensureProjectModalAppPanels();
    if (!projectShellLoading) mountProjectModalRegionApps('left');
    if (projectViewer && projectViewer.activeTab !== activePreviewTab) {
      projectViewer.activeTab = activePreviewTab;
      projectViewer.render?.();
    }
    document.querySelectorAll('.r-preview-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === activePreviewTab);
    });
    // The mobile title is derived from the active tab, so update the shared
    // viewer chrome whenever a tab changes instead of only during a full render.
    syncProjectViewerTabs();
    if (!projectShellLoading) syncProjectModalAppActivation(previousTab);
    restoreDefaultLeftColumnState();
    const hint = $('#rMapHint');
    const topMode = $('#rProposalTopMode');
    const markupDock = $('#rProposalMarkupDock');
    if (hint) {
      const showPinHint = hint.dataset.kind !== 'pin-placement' || !hasReportOrdered();
      hint.style.display = activePreviewTab === 'map' && hasSelectedAddons() && showPinHint ? 'block' : 'none';
    }
    syncProposalWorkspaceChrome();
    bindProposalMarkupToggle();
    if (activePreviewTab === 'map' && previousTab !== 'map') scheduleProjectMapInitialize(activeBaseProject, 60);
    renderProposalSection();
    restoreDefaultLeftColumnState();
    syncProjectNotesPlacement();
    renderActionRow();
    if (options.syncRoute !== false) {
      syncActiveProjectRoute({
        projectNote:null, projectNotes:null,
        proposal:null, proposalMode:null,
        moneyView:null, receipt:null,
        document:null, documentView:null,
        materialList:null, materialSection:null,
        reportView:null,
        customerPortalView:null,
        projectScheduleView:null, projectScheduleTarget:null
      }, options);
    }
  }

  function projectModalTabContext(){
    return {
      activeTab: activePreviewTab,
      activeProject: activeBaseProject,
      project: activeBaseProject,
      projectId: activeBaseProject?.id || '',
      projectWorkspace: projectWorkspaceHost(),
      proposalsEnabled: proposalsEnabled(),
      materialsEnabled: materialsEnabled(),
      moneyEnabled: moneyEnabled(),
      projectPhotosEnabled: projectPhotosEnabled(),
      projectDocsEnabled: projectDocsEnabled(),
      customerPortalEnabled: customerPortalEnabled(),
      schedulePreviewAvailable: schedulePreviewAvailable(),
      hasReportOrdered: hasReportOrdered(),
      reportOrderPending: reportOrderIsActivelyPending(),
      reorderMeasurementProjectId,
      proposalWorkspaceOpen,
      proposalWorkspaceMode
    };
  }

  function projectWorkspaceHost(){
    return {
      kind: 'project_workspace',
      getProject: () => activeBaseProject,
      setProject: (project) => {
        activeBaseProject = project || null;
        return activeBaseProject;
      },
      getPhotos: () => projectPhotos,
      setPhotos: (photos) => {
        projectPhotos = Array.isArray(photos) ? photos : [];
        return projectPhotos;
      },
      getProposals: () => proposals,
      setProposals: (nextProposals) => {
        proposals = Array.isArray(nextProposals) ? nextProposals : [];
        if (activeBaseProject) activeBaseProject.proposals = proposals;
        renderProjectStageBar();
        return proposals;
      },
      getBranchProjectConfig: () => branchProjectConfig,
      getReportOrderState: () => reportOrderState,
      setReportOrderState: (nextState) => {
        reportOrderState = nextState || null;
        return reportOrderState;
      },
      persistProject: () => persistActiveBaseProject(),
      saveContactEmail: async ({ contact_id: contactId = '', index = 0, email = '' } = {}) => {
        const cards = [...($('#rContactList')?.querySelectorAll('.r-contact-card') || [])];
        const normalizedId = projectText(contactId);
        const card = (normalizedId ? cards.find((entry) => cardContactId(entry) === normalizedId) : null) || cards[Number(index) || 0];
        const input = card?.querySelector('[data-field="email"]');
        if (!card || !input) throw new Error('The customer contact could not be updated.');
        input.value = projectText(email);
        const updated = contactFromCard(card);
        const standalone = findStandaloneContactRecord(updated);
        if (standalone) saveStandaloneContact({ ...updated, record_project_id: projectIdentity(standalone) });
        persistActiveBaseProject();
        if (activeBaseProject && window.Portal?.ProjectStore?.saveRemote) {
          const saved = await window.Portal.ProjectStore.saveRemote(activeBaseProject);
          if (saved) activeBaseProject = { ...activeBaseProject, ...saved, contacts: collectContacts() };
        }
        return collectContacts().find((contact) => projectText(contact.id, contact.contact_id) === projectText(updated.id, updated.contact_id)) || updated;
      },
      autosaveSoon: () => queueAutosaveNotice(),
      loadCustomerPortal: (options = {}) => loadCustomerPortal(options),
      renderCustomerPortalLink: () => renderCustomerPortalLink(),
      setActivePreviewTab: (tab) => setActivePreviewTab(tab),
      getActivePreviewTab: () => activePreviewTab,
      isLeftColumnOverridden: (tab) => projectLeftColumnOverridden(tab),
      syncLeftColumnOverride: () => syncLeftColumnOverride(),
      setLeftColumnOverride: (active, tab = activePreviewTab) => {
        const overlay = $('#rOverlay');
        if (!overlay) return false;
        const owner = String(tab || activePreviewTab || '');
        const enabled = active !== false;
        if (enabled) {
          overlay.classList.add('left-override');
          overlay.dataset.leftOverrideTab = owner;
        } else if (!owner || overlay.dataset.leftOverrideTab === owner) {
          delete overlay.dataset.leftOverrideTab;
          overlay.classList.remove('left-override');
        }
        return enabled;
      },
      getSelectedType: () => selectedType,
      setSelectedType: (value) => {
        selectedType = value || null;
        return selectedType;
      },
      getReportSelection: () => reportSelection,
      setReportSelection: (value) => {
        reportSelection = value || null;
        return reportSelection;
      },
      shouldUseExpandedOverviewMap: () => shouldUseExpandedOverviewMap(),
      getIncludeGutterMeasurements: () => includeGutterMeasurements,
      setIncludeGutterMeasurements: (value) => {
        includeGutterMeasurements = !!value;
        return includeGutterMeasurements;
      },
      getIncludeWeatherReport: () => includeWeatherReport,
      setIncludeWeatherReport: (value) => {
        includeWeatherReport = !!value;
        return includeWeatherReport;
      },
      getIncludeInstantPreview: () => includeInstantPreview,
      setIncludeInstantPreview: (value) => {
        includeInstantPreview = !!value;
        return includeInstantPreview;
      },
      getSelectedReportExpedite: () => selectedReportExpedite,
      setSelectedReportExpedite: (value) => {
        selectedReportExpedite = value || null;
        return selectedReportExpedite;
      },
      getReportExpediteOptions: () => reportExpediteOptions,
      setReportExpediteOptions: (options) => {
        reportExpediteOptions = Array.isArray(options) ? options : [];
        reportExpediteOptionsAuthoritative = false;
        return reportExpediteOptions;
      },
      getAddressSelected: () => addressSelected,
      setAddressSelected: (value) => { addressSelected = !!value; return addressSelected; },
      getLocationConfirmed: () => locationConfirmed,
      setLocationConfirmed: (value) => { locationConfirmed = !!value; return locationConfirmed; },
      setTypePickerExpanded: (value) => { typePickerExpanded = !!value; return typePickerExpanded; },
      isViewingExistingProject: () => viewingExistingProject,
      getReorderMeasurementProjectId: () => reorderMeasurementProjectId,
      setReorderMeasurementProjectId: (value) => {
        reorderMeasurementProjectId = String(value || '').trim();
        return reorderMeasurementProjectId;
      },
      getReorderSourceCanReopenInPlace: () => reorderSourceCanReopenInPlace,
      setReorderSourceCanReopenInPlace: (value) => {
        reorderSourceCanReopenInPlace = !!value;
        return reorderSourceCanReopenInPlace;
      },
      hasSelectedAddons: () => hasSelectedAddons(),
      isMobileReportOrder: () => shouldUseMobileOrderPagination(),
      mobileOrderPinsLocked: () => shouldUseMobileOrderPagination() && !mobileOrderScopeReady(),
      inlineProjectMapWithReports: () => projectModalAppsShouldInlineMap(),
      showStructurePinLimitNotice: () => showStructurePinLimitNotice(),
      invalidateReportExpediteOptions: () => invalidateReportExpediteOptions(),
      renderPinInfo: () => renderPinInfo(),
      renderConfirm: () => renderConfirm(),
      renderWorkflowState: () => renderWorkflowState(),
      renderProjectViewerSummary: () => renderProjectViewerSummary(),
      syncProjectViewerTabs: () => syncProjectViewerTabs(),
      revealProposalSection: () => revealProposalSection(),
      revealInLeftColumnIfBelow: (...args) => revealInLeftColumnIfBelow(...args),
      projectOrgId: () => projectOrgId(),
      showToast: (...args) => showToast(...args),
      selectedReportMode: () => selectedReportMode(),
      reportModeLabel: () => reportModeLabel(),
      reportExpediteOption: (...args) => reportExpediteOption(...args),
      defaultReportExpediteOption: () => defaultReportExpediteOption(),
      normalizeReportExpediteKey: (...args) => normalizeReportExpediteKey(...args),
      reportExpediteOptionsEnabled: () => reportExpediteOptionsEnabled(),
      reportExpeditePricingReady: () => reportExpeditePricingReady(),
      reportExpeditePricingLoading: () => reportExpeditePricingLoading(),
      reportOrderingClosed: () => reportOrderingClosed(),
      reportCancellationsEnabled: () => reportCancellationsEnabled(),
      reportFollowupEnabled: () => reportFollowupEnabled(),
      weatherReportsEnabled: () => weatherReportsEnabled(),
      instantReportsEnabled: () => instantReportsEnabled(),
      fmtMoney: (...args) => fmtMoney(...args),
      isPerStructureType: (...args) => isPerStructureType(...args),
      pinCount: () => pinCount(),
      freeExpediteUses: () => freeExpediteUses(),
      reportExpediteCouponDiscount: (...args) => reportExpediteCouponDiscount(...args),
      reportExpeditePriceHtml: (...args) => reportExpeditePriceHtml(...args),
      reportExpediteDeltaLabel: (...args) => reportExpediteDeltaLabel(...args),
      reportExpediteCustomerPromiseLabel: (...args) => reportExpediteCustomerPromiseLabel(...args),
      reportExpediteWindowLabel: (...args) => reportExpediteWindowLabel(...args),
      reportExpediteNetTotalPrice: (...args) => reportExpediteNetTotalPrice(...args),
      reportExpediteTotalPrice: (...args) => reportExpediteTotalPrice(...args),
      reportExpediteUnitPrice: (...args) => reportExpediteUnitPrice(...args),
      buildLocalReportExpediteOptions: (...args) => buildLocalReportExpediteOptions(...args),
      loadReportExpediteOptions: (...args) => loadReportExpediteOptions(...args),
      shouldAutoOpenInstantFromMode: (...args) => shouldAutoOpenInstantFromMode(...args),
      setProjectionMode: (...args) => setProjectionMode(...args),
      ensureCreditsForPurchase: (...args) => ensureCreditsForPurchase(...args),
      openCreditTopupForPurchase: (...args) => openCreditTopupForPurchase(...args),
      creditErrorDetails: (...args) => creditErrorDetails(...args),
      closeProjectWorkspace: () => close(),
      openProjectWorkspace: (...args) => open(...args),
      projectDefaultPreviewTab: () => projectDefaultPreviewTab(),
      setCoords: (...args) => setCoords(...args),
      setMobileOrderPage: (page) => setMobileOrderPage(page),
      mobileOrderUsesFinalPage: () => mobileOrderUsesFinalPage(),
      getMarkersData: () => getMarkersData(),
      normalizeProjectPins: (...args) => normalizeProjectPins(...args),
      buildPinIcon: (...args) => buildPinIcon(...args),
      focusMapOnProject: (...args) => focusMapOnProject(...args),
      renderAfterHoursNotice: () => renderAfterHoursNotice(),
      syncReportExpediteMinuteRefresh: () => syncReportExpediteMinuteRefresh(),
      stopReportExpediteMinuteRefresh: () => stopReportExpediteMinuteRefresh(),
      currentPrice: () => currentPrice(),
      currentPriceQuote: () => currentPriceQuote(),
      reportBaseUnitPrice: (...args) => reportBaseUnitPrice(...args),
      activeSubmitButton: () => activeSubmitButton(),
      setSubmitBusyLabel: (...args) => setSubmitBusyLabel(...args),
      buildTypeButtons: () => buildTypeButtons(),
      proposalsEnabled: () => proposalsEnabled(),
      materialsEnabled: () => materialsEnabled(),
      reportsEnabled: () => reportsEnabled(),
      projectTodosEnabled: () => projectTodosEnabled(),
      moneyEnabled: () => moneyEnabled(),
      proposalAgentEnabled: () => proposalAgentEnabled(),
      infoTip: (...args) => infoTip(...args),
      addonInfoIcon: (...args) => addonInfoIcon(...args),
      gutterReportAddon: () => GUTTER_REPORT_ADDON,
      weatherReportAddon: () => WEATHER_REPORT_ADDON,
      schedulingEnabled: () => schedulingEnabled(),
      ensureProposalOnlyBaseProject: () => ensureProposalOnlyBaseProject(),
      renderRoofChoice: () => renderRoofChoice(),
      updateSubmitLabel: () => updateSubmitLabel(),
      primaryContact: () => primaryContact(),
      collectContacts: () => collectContacts(),
      manualProjectTitle: () => manualProjectTitle(),
      renderMeasurements: () => renderMeasurementsPanel(),
      renderSchedule: () => renderSchedulePanel(),
      renderCustomerPortal: () => renderCustomerPortalPanel(),
      loadCustomerPortal: (options = {}) => loadCustomerPortal(options),
      renderPhotos: () => renderPhotoGallery(),
      renderProposals: () => {
        renderProposalSection();
        renderProposalPreview();
      },
      installContextAccessors: () => {
        installProjectPhotosContextAccessors();
        installProposalContextAccessors();
      }
    };
  }

  const PROJECT_MODAL_APP_PREFIX = 'project.';
  const projectModalAppHandles = new Map();
  const projectModalRegionAppHandles = new Map();
  const projectModalAppMounts = new Map();
  const projectModalRegionAppMounts = new Map();
  let projectModalHeaderIdentity = null;

  function setProjectModalHeaderAction(action = null){
    const buttons = [$('#rProjectHeaderAction'), $('#rMobileProjectHeaderAction')].filter(Boolean);
    if (!buttons.length) return;
    const label = String(action?.label || '').trim();
    const onClick = typeof action?.onClick === 'function' ? action.onClick : null;
    buttons.forEach((button) => {
      if (button.__fmHeaderAction) button.removeEventListener('click', button.__fmHeaderAction);
      button.__fmHeaderAction = null;
      if (!label || !onClick) {
        button.hidden = true;
        button.replaceChildren();
        button.removeAttribute('aria-label');
        return;
      }
      const iconNode = document.createElement('i');
      iconNode.className = `fas ${String(action?.icon || 'fa-plus').trim()}`;
      iconNode.setAttribute('aria-hidden', 'true');
      const labelNode = document.createElement('span');
      labelNode.textContent = label;
      button.replaceChildren(iconNode, labelNode);
      button.setAttribute('aria-label', label);
      button.hidden = false;
      button.__fmHeaderAction = onClick;
      button.addEventListener('click', onClick);
    });
  }

  function setProjectModalHeaderIdentity(identity = null){
    const value = identity && typeof identity === 'object' ? identity : null;
    projectModalHeaderIdentity = value ? {
      ownerTab:String(value.ownerTab || activePreviewTab || ''),
      title:String(value.title || '').trim(),
      subtitle:String(value.subtitle || '').trim()
    } : null;
    syncProjectViewerTabs();
  }

  function projectModalTabId(meta = {}){
    const explicit = meta.app?.projectModalTabId || meta.app?.tabId;
    if (explicit) return String(explicit);
    const appId = String(meta.id || '');
    return appId.startsWith(PROJECT_MODAL_APP_PREFIX) ? appId.slice(PROJECT_MODAL_APP_PREFIX.length) : appId;
  }

  function firstMeasureOrderServices(){
    return {
      buildTypeButtons: () => buildTypeButtons(),
      buildTypeOptions: () => buildTypeOptions(),
      proposalsEnabled: () => proposalsEnabled(),
      schedulingEnabled: () => schedulingEnabled(),
      proposalAgentEnabled: () => proposalAgentEnabled(),
      infoTip: (...args) => infoTip(...args),
      addonInfoIcon: (...args) => addonInfoIcon(...args),
      fmtMoney: (...args) => fmtMoney(...args),
      gutterReportAddon: () => GUTTER_REPORT_ADDON,
      weatherReportAddon: () => WEATHER_REPORT_ADDON
    };
  }

  function projectModalRuntimeContext(extra = {}){
    const host = extra.host || projectWorkspaceHost();
    const project = activeBaseProject || null;
    const leftRoot = Object.prototype.hasOwnProperty.call(extra, 'leftRoot') ? extra.leftRoot : $('#rProposalSection');
    const services = {
      ...(extra.services || {}),
      firstMeasureOrder: {
        ...firstMeasureOrderServices(),
        ...(extra.services?.firstMeasureOrder || {})
      }
    };
    return {
      ...projectModalTabContext(),
      ...extra,
      surface: 'project_modal',
      source: 'project_request_modal',
      chrome: 'project_modal',
      entity: project,
      entityType: 'project',
      entityId: project?.id || '',
      project,
      activeProject: project,
      projectId: project?.id || '',
      orgId: projectOrgId(),
      branchId: window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default',
      activeTab: activePreviewTab,
      projectIdentity: {
        mobileOwner: 'modal_chrome',
        mobileTitleElementId: 'rMobileProjectTitleText',
        hideLeftRegionTitleInTray: true
      },
      setHeaderAction: setProjectModalHeaderAction,
      setHeaderIdentity: setProjectModalHeaderIdentity,
      host,
      projectWorkspace: host,
      overlayRoot: $('#rOverlay'),
      leftRoot,
      leftRegionRoot: $('#rOverlay .r-left'),
      services
    };
  }

  function projectModalRegionApps(region){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.listApps) return [];
    const wanted = String(region || '').trim();
    if (!wanted) return [];
    const context = projectModalRuntimeContext({ region: wanted });
    return runtime.listApps(context)
      .filter((meta) => meta?.id && meta.id !== 'project.request')
      .filter((meta) => meta.app?.kind === 'project_modal_region_app')
      .filter((meta) => Array.isArray(meta.regions) && meta.regions.includes(wanted))
      .map((meta) => ({
        ...meta,
        appId: meta.id,
        panelHtml: meta.app?.panelHtml,
        app: meta.app
      }));
  }

  function projectModalRegionHtml(region){
    const apps = projectModalRegionApps(region);
    const app = apps[0] || null;
    if (!app) return `<div class="r-${escapeHtml(region)}" data-region="${escapeHtml(region)}"></div>`;
    const context = projectModalRuntimeContext({ region });
    try {
      if (typeof app.panelHtml === 'function') return app.panelHtml(context);
      if (typeof app.panelHtml === 'string') return app.panelHtml;
    } catch (error) {
      console.warn(`Project modal ${region} region render failed for ${app.appId}`, error);
    }
    return `<div class="r-${escapeHtml(region)}" data-region="${escapeHtml(region)}"></div>`;
  }

  function disposeProjectModalRegionApps(region){
    projectModalRegionAppHandles.forEach((handle, key) => {
      const [handleRegion] = String(key).split(':');
      if (handleRegion !== region) return;
      try { handle?.destroy?.(); } catch (error) { console.warn(`Project modal region app destroy failed for ${key}`, error); }
      projectModalRegionAppHandles.delete(key);
    });
  }

  function ensureProjectModalLeftRegion(){
    const root = $('#rOverlay .r-left');
    if (!root || root.children.length || projectModalResolvedPresentation().leftMode === 'none') return false;
    const template = document.createElement('template');
    template.innerHTML = projectModalRegionHtml('left').trim();
    const replacement = template.content.firstElementChild;
    if (!replacement?.classList.contains('r-left') || !replacement.children.length) return false;
    root.replaceWith(replacement);
    bindProjectModalFormControls();
    return true;
  }

  function mountProjectModalRegionApps(region){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.mount) return;
    if (region === 'left' && projectModalResolvedPresentation().leftMode === 'none') {
      disposeProjectModalRegionApps(region);
      return;
    }
    const apps = projectModalRegionApps(region);
    const appIds = new Set(apps.map((app) => app.appId));
    projectModalRegionAppHandles.forEach((handle, key) => {
      const [handleRegion, appId] = String(key).split(':');
      if (handleRegion !== region || appIds.has(appId)) return;
      try { handle?.destroy?.(); } catch (error) { console.warn(`Project modal region app destroy failed for ${key}`, error); }
      projectModalRegionAppHandles.delete(key);
    });
    apps.forEach((app) => {
      let root = region === 'left'
        ? document.querySelector('#rOverlay .r-left')
        : document.querySelector(`#rOverlay [data-region="${cssEscape(region)}"]`);
      if (!root) return;
      if (!root.children.length && app.panelHtml) {
        try {
          const html = typeof app.panelHtml === 'function'
            ? app.panelHtml(projectModalRuntimeContext({ region }))
            : String(app.panelHtml || '');
          const template = document.createElement('template');
          template.innerHTML = html.trim();
          const replacement = template.content.firstElementChild;
          if (replacement && region === 'left' && replacement.classList?.contains('r-left')) {
            root.replaceWith(replacement);
            root = replacement;
            bindProjectModalFormControls();
          } else if (html) {
            root.innerHTML = html;
          }
        } catch (error) {
          console.warn(`Project modal ${region} region recovery failed for ${app.appId}`, error);
        }
      }
      const key = `${region}:${app.appId}`;
      const context = projectModalRuntimeContext({
        region,
        root,
        panelRoot: root,
        leftRoot: region === 'left' ? root : $('#rProposalSection'),
        roots: { main: root, left: region === 'left' ? root : $('#rProposalSection'), overlay: $('#rOverlay') },
        active: true
      });
      const existing = projectModalRegionAppHandles.get(key);
      if (existing) {
        try {
          if (typeof existing.activate === 'function') existing.activate(context);
          else existing.setActive?.(true, context);
        } catch (error) {
          console.warn(`Project modal region app activation failed for ${app.appId}`, error);
        }
        return;
      }
      // Rendering the order workflow can re-enter this path several times before
      // an async app mount resolves. Reuse that in-flight mount; otherwise every
      // render starts another full app instance and the renderer can run out of
      // memory before the first instance becomes available.
      if (projectModalRegionAppMounts.has(key)) return;
      const mountPromise = runtime.mount({ main: root, left: context.leftRoot, overlay: $('#rOverlay') }, app.appId, context)
        .then((handle) => {
          projectModalRegionAppHandles.set(key, handle);
          handle?.setActive?.(true);
          if (region === 'left') bindProjectStageBarWheel();
          return handle;
        })
        .catch((error) => {
          projectModalRegionAppHandles.delete(key);
          console.warn(`Project modal region app mount failed for ${app.appId}`, error);
          return null;
        })
        .finally(() => {
          if (projectModalRegionAppMounts.get(key) === mountPromise) projectModalRegionAppMounts.delete(key);
        });
      projectModalRegionAppMounts.set(key, mountPromise);
    });
  }

  function projectModalApps(options = {}){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.listApps) return [];
    const context = projectModalRuntimeContext();
    const apps = runtime.listApps(context)
      .filter((meta) => meta?.id && meta.id !== 'project.request')
      .filter((meta) => meta.app?.kind === 'project_modal_app' || String(meta.id || '').startsWith(PROJECT_MODAL_APP_PREFIX))
      .map((meta) => ({
        ...meta,
        id: projectModalTabId(meta),
        appId: meta.id,
        terminologyKey:meta.app?.terminologyKey || meta.terminologyKey || '',
        label:window.PlatformTerminology?.appLabel?.(meta, meta.label || meta.title || projectModalTabId(meta)) || meta.label || meta.title || projectModalTabId(meta),
        title:window.PlatformTerminology?.appLabel?.(meta, meta.title || meta.label || projectModalTabId(meta)) || meta.title || meta.label || projectModalTabId(meta),
        icon: meta.icon || '',
        params: meta.params || {},
        layout: meta.layout || {},
        presentation: meta.presentation || {},
        defaultHome: meta.defaultHome === true,
        access: meta.access || {},
        entitlement: meta.entitlement,
        reasons: meta.reasons || [],
        regions: meta.regions || meta.app?.regions || ['main'],
        panelHtml: meta.app?.panelHtml,
        app: meta.app
      }));
    if (window.Portal.ExteriorOrder?.active()) {
      const map = apps.find(app => app.id === 'map');
      const photos = apps.find(app => app.id === 'photos') || { id:'photos', label:'Photos', title:'Photos', icon:'fa-images', regions:['main'], panelHtml:'<div id="rExteriorPhotosPanel" style="height:100%"></div>' };
      return [map, photos, ...apps.filter(app => app.id === 'materials' && !app.app?.promoBadge)].filter(Boolean);
    }
    // Doc-first standalone mode: until a project is picked/created, the modal
    // is a single standalone document — only the Docs tab exists.
    if (docWorkflowStandaloneActive()) return apps.filter((app) => app.id === 'docs');
    return options.includeInlineMap || !projectModalAppsShouldInlineMap(apps)
      ? apps
      : apps.filter((app) => app.id !== 'map');
  }

  function projectModalResolvedPresentation(tabId = activePreviewTab){
    const id = String(tabId || '').trim();
    const app = projectModalApps({ includeInlineMap: true }).find((entry) => entry.id === id) || null;
    const presentation = app?.presentation && typeof app.presentation === 'object' ? app.presentation : {};
    const layout = app?.layout && typeof app.layout === 'object' ? app.layout : {};
    const modal = {
      ...presentation,
      ...layout,
      ...(presentation.project_modal || presentation.projectModal || {}),
      ...(layout.project_modal || layout.projectModal || {})
    };
    const mobile = !!window.matchMedia?.('(max-width: 820px)')?.matches;
    const devicePolicy = mobile
      ? { ...(modal.mobile && typeof modal.mobile === 'object' ? modal.mobile : {}) }
      : { ...(modal.desktop && typeof modal.desktop === 'object' ? modal.desktop : {}) };
    const generalLeft = typeof modal.left === 'object'
      ? (mobile ? modal.left.mobile : modal.left.desktop) || modal.left.default
      : modal.left;
    let leftMode = String(
      (mobile
        ? (modal.mobileLeft ?? modal.mobile_left ?? devicePolicy.left)
        : (modal.desktopLeft ?? modal.desktop_left ?? devicePolicy.left))
      ?? generalLeft
      ?? modal.left_column
      ?? ''
    ).trim().toLowerCase();
    if (modal.uses_left_column === false || modal.usesLeftColumn === false) leftMode = 'none';
    if (['hidden', 'hide', 'off'].includes(leftMode)) leftMode = 'none';
    if (['standard', 'host'].includes(leftMode)) leftMode = 'default';
    if (!leftMode) {
      leftMode = app?.regions?.includes?.('left') || ['proposal', 'scope', 'schedule', 'materials', 'money'].includes(id)
        ? 'app'
        : 'default';
    }
    const mobileTabs = String(modal.mobileTabs ?? modal.mobile_tabs ?? modal.mobile_navigation ?? devicePolicy.tabs ?? modal.tabs ?? '').trim().toLowerCase();
    const infoTray = String(modal.mobileInfo ?? modal.mobile_info ?? modal.mobileInfoTray ?? modal.mobile_info_tray ?? devicePolicy.infoTray ?? '').trim().toLowerCase();
    const fullscreenControl = mobile
      ? (modal.mobileFullscreenControl ?? modal.mobile_fullscreen_control ?? devicePolicy.fullscreenControl ?? devicePolicy.fullscreen_control ?? modal.fullscreenControl)
      : (modal.desktopFullscreenControl ?? modal.desktop_fullscreen_control ?? devicePolicy.fullscreenControl ?? modal.fullscreenControl);
    const mobileFullscreen = mobile && (modal.mobileFullscreen === true || modal.mobile_fullscreen === true || devicePolicy.fullscreen === true || fullscreenControl === false);
    return {
      app,
      modal,
      mobile,
      leftMode,
      iconOnly: mobile && ['icons', 'icon', 'icon-only'].includes(mobileTabs),
      infoTrayHidden: mobile && ['none', 'hidden', 'hide', 'off'].includes(infoTray),
      mobileFullscreen,
      showFullscreenControl: !(mobile && (fullscreenControl === false || mobileFullscreen))
    };
  }

  function applyProjectModalPresentation(){
    const policy = projectModalResolvedPresentation();
    const overlay = $('#rOverlay');
    if (!overlay) return policy;
    overlay.classList.toggle('entitlement-left-none', policy.leftMode === 'none');
    overlay.classList.toggle('entitlement-mobile-fullscreen', policy.mobileFullscreen);
    overlay.classList.toggle('entitlement-tab-icons', policy.iconOnly);
    overlay.classList.toggle('entitlement-hide-fullscreen', !policy.showFullscreenControl);
    overlay.classList.toggle('entitlement-info-none', policy.infoTrayHidden === true);
    overlay.dataset.projectLeftMode = policy.leftMode;
    overlay.dataset.projectTabMode = policy.iconOnly ? 'icons' : 'labels';
    projectViewer?.setPresentation?.({ iconOnly: policy.iconOnly });
    syncMobileDefaultInfoTray();
    return policy;
  }

  function projectModalAppsShouldInlineMap(apps = projectModalApps({ includeInlineMap: true })){
    const ids = (apps || []).filter((app) => !app?.app?.promoBadge).map((app) => app?.id).filter(Boolean);
    return ids.length === 2 && ids.includes('map') && ids.includes('measurements');
  }

  function projectModalAppPanelsHtml(){
    const context = projectModalRuntimeContext();
    return projectModalApps().map((app) => {
      const body = typeof app.panelHtml === 'function'
        ? app.panelHtml(context)
        : (typeof app.panelHtml === 'string' ? app.panelHtml : `<div id="${escapeHtml(app.id)}Panel" style="height:100%"></div>`);
      const activeClass = app.id === activePreviewTab ? ' active' : '';
      return `<div class="r-preview-panel${activeClass}" data-panel="${escapeHtml(app.id)}">${body}</div>`;
    }).join('');
  }

  function projectModalPanelHtml(app, context = projectModalRuntimeContext()){
    return typeof app.panelHtml === 'function'
      ? app.panelHtml(context)
      : (typeof app.panelHtml === 'string' ? app.panelHtml : `<div id="${escapeHtml(app.id)}Panel" style="height:100%"></div>`);
  }

  function ensureProjectModalAppPanels(){
    const stage = document.querySelector('#rOverlay .r-preview-stage');
    if (!stage) return;
    const context = projectModalRuntimeContext();
    projectModalApps().forEach((app) => {
      if (!app?.id) return;
      if (stage.querySelector(`.r-preview-panel[data-panel="${cssEscape(app.id)}"]`)) return;
      const panel = document.createElement('div');
      panel.className = `r-preview-panel${app.id === activePreviewTab ? ' active' : ''}`;
      panel.dataset.panel = app.id;
      panel.innerHTML = projectModalPanelHtml(app, context);
      stage.appendChild(panel);
    });
  }

  function pruneStaleProjectModalAppPanels(){
    const stage = document.querySelector('#rOverlay .r-preview-stage');
    if (!stage) return;
    const validPanels = new Set(projectModalApps().map((app) => app.id).filter(Boolean));
    stage.querySelectorAll('.r-preview-panel[data-panel]').forEach((panel) => {
      const panelId = panel.dataset.panel || '';
      if (!validPanels.has(panelId)) panel.remove();
    });
  }

  function resetProjectModalAppPanels(){
    projectModalAppHandles.forEach((handle, appId) => {
      try { handle?.destroy?.(); } catch (error) { console.warn(`Project modal app destroy failed for ${appId}`, error); }
    });
    projectModalAppHandles.clear();
    const stage = document.querySelector('#rOverlay .r-preview-stage');
    if (!stage) return;
    stage.innerHTML = projectModalAppPanelsHtml();
  }

  function renderProjectModalTabError(tab, phase, error){
    const panelRoot = document.querySelector(`#rOverlay .r-preview-panel[data-panel="${cssEscape(tab?.id || '')}"]`);
    if (!panelRoot || tab?.id !== activePreviewTab) return;
    panelRoot.innerHTML = `
      <div class="r-report-pending">
        <div class="r-report-pending-card">
          <i class="fas fa-triangle-exclamation"></i>
          <h3>${((v0) => globalThis.PlatformLanguage?.text("project-request","m_20b9cbe18eee54",`${v0} unavailable`,{v0}) ?? `${v0} unavailable`)(escapeHtml(tab?.label || tab?.title || tab?.id || 'Project app'))}</h3>
          <p>${String(escapeHtml(error?.message || `Could not ${phase || 'load'} this project app.`))}</p>
        </div>
      </div>`;
  }

  function safelyRunProjectModalTab(tab, phase, fn){
    try {
      return fn?.();
    } catch (error) {
      console.warn(`Project modal tab ${phase || 'operation'} failed for ${tab?.id || 'unknown'}`, error);
      renderProjectModalTabError(tab, phase, error);
      return null;
    }
  }

  function mountProjectModalApp(app, { force = false } = {}){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.mount || !app?.appId) return Promise.resolve(null);
    const panelRoot = document.querySelector(`#rOverlay .r-preview-panel[data-panel="${cssEscape(app.id)}"]`);
    if (!panelRoot) return Promise.resolve(null);
    const existing = projectModalAppHandles.get(app.appId);
    if (existing && !force) return Promise.resolve(existing);
    const pending = projectModalAppMounts.get(app.appId);
    if (pending && !force) return pending;
    const host = projectWorkspaceHost();
    const active = app.id === activePreviewTab;
    const leftRoot = projectModalResolvedPresentation(app.id).leftMode === 'none' ? null : $('#rProposalSection');
    const overlayRoot = $('#rOverlay');
    const mountPromise = runtime.mount({ main: panelRoot, left: leftRoot, overlay: overlayRoot }, app.appId, projectModalRuntimeContext({
      active,
      roots: { main: panelRoot, left: leftRoot, overlay: overlayRoot },
      panelRoot,
      previewRoot: panelRoot,
      leftRoot,
      overlayRoot,
      host,
      projectWorkspace: host,
      params: app.params || {},
      layout: app.layout || {},
      presentation: app.presentation || {},
      entitlement: app.entitlement,
      defaultHome: app.defaultHome === true
    })).then((handle) => {
      projectModalAppHandles.set(app.appId, handle);
      // The route may change while the app bundle loads (including capability
      // recovery switching away from the temporary Docs fallback).
      handle?.setActive?.(app.id === activePreviewTab);
      return handle;
    }).catch((error) => {
      projectModalAppHandles.delete(app.appId);
      renderProjectModalTabError(app, 'mount', error);
      console.warn(`Project modal app mount failed for ${app.appId}`, error);
      return null;
    }).finally(() => {
      if (projectModalAppMounts.get(app.appId) === mountPromise) projectModalAppMounts.delete(app.appId);
    });
    projectModalAppMounts.set(app.appId, mountPromise);
    return mountPromise;
  }

  function projectModalAppRuntimeContext(app, active){
    const panelRoot = document.querySelector(`#rOverlay .r-preview-panel[data-panel="${cssEscape(app?.id || '')}"]`);
    const leftRoot = projectModalResolvedPresentation(app?.id).leftMode === 'none' ? null : $('#rProposalSection');
    const overlayRoot = $('#rOverlay');
    const host = projectWorkspaceHost();
    return projectModalRuntimeContext({
      active,
      roots: { main: panelRoot, left: leftRoot, overlay: overlayRoot },
      panelRoot,
      previewRoot: panelRoot,
      leftRoot,
      overlayRoot,
      host,
      projectWorkspace: host,
      params: app?.params || {},
      layout: app?.layout || {},
      presentation: app?.presentation || {},
      entitlement: app?.entitlement,
      defaultHome: app?.defaultHome === true
    });
  }

  function mountProjectModalApps(){
    ensureProjectModalAppPanels();
    const apps = projectModalApps();
    const appIds = new Set(apps.map((app) => app.appId));
    projectModalAppHandles.forEach((handle, appId) => {
      if (appIds.has(appId)) return;
      try { handle?.destroy?.(); } catch (error) { console.warn(`Project modal app destroy failed for ${appId}`, error); }
      projectModalAppHandles.delete(appId);
    });
    apps.filter((app) => app.id === activePreviewTab).forEach((app) => safelyRunProjectModalTab(app, 'mount', () => {
      void mountProjectModalApp(app);
    }));
  }
  async function openReportCreditGateTopup({ label, required, balance = null, context = 'credit_gate' } = {}){
    const firstReportCheckout = reportCreditViewOverride()
      ? false
      : await firstReportCheckoutEligible({ honorForce: false }).catch(() => false);
    openCreditTopupForPurchase({
      label,
      required,
      balance,
      context,
      firstReportCheckout,
      reportCreditView: firstReportCheckout ? 'initial' : 'normal'
    });
  }

  function syncProjectModalAppActivation(previousTab = ''){
    ensureProjectModalAppPanels();
    setProjectModalHeaderAction(null);
    projectModalApps().forEach((app) => {
      const active = app.id === activePreviewTab;
      safelyRunProjectModalTab(app, active ? 'activate' : 'deactivate', () => {
        const handle = projectModalAppHandles.get(app.appId);
        if (handle) {
          if (active || app.id === previousTab) {
            const context = projectModalAppRuntimeContext(app, active);
            if (active && typeof handle.activate === 'function') handle.activate(context);
            else if (!active && typeof handle.deactivate === 'function') handle.deactivate(context);
            else handle.setActive?.(active, context);
          }
          return;
        }
        if (active) void mountProjectModalApp(app);
      });
    });
  }

  function refreshProjectModalAppsForOrderTransition(previousTab = activePreviewTab){
    ensureProjectModalAppPanels();
    pruneStaleProjectModalAppPanels();
    syncProjectViewerTabs();
    mountProjectModalApps();
    syncProjectModalAppActivation(previousTab);
    window.Portal?.modules?.projectMap?.renderOverview?.();
    if (activePreviewTab === 'map') scheduleProjectMapInitialize(activeBaseProject, 60);
  }

  function projectViewerTabs(){
    const tabs = [];
    if (mobileProjectInfoTabEnabled()) {
      tabs.push({
        id: 'info',
        label: (globalThis.PlatformLanguage?.text("project-request","m_e3530bc541f8e4","Info") ?? "Info"),
        icon: 'fa-circle-info',
        className: 'r-mobile-info-tab'
      });
    }
    projectModalApps().forEach((tab) => {
      if (!tabs.some((entry) => entry.id === tab.id)) {
        tabs.push({
          id: tab.id,
          label: tab.id === 'map' ? (window.Portal.ExteriorOrder?.active() ? 'Map' : projectOverviewTabLabel()) : (tab.label || tab.title || tab.id),
          icon: tab.icon || '',
          pending: !!tab.pending,
          badge: tab.app?.promoBadge || '',
          disabled: !!tab.disabled
        });
      }
    });
    return tabs;
  }

  function syncProjectViewerTabs(){
    ensureProjectModalAppPanels();
    const tabs = projectViewerTabs();
    projectViewer?.setTabs(tabs);
    const activeTab = tabs.find((tab) => tab.id === activePreviewTab)
      || projectModalApps({ includeInlineMap:true }).find((tab) => tab.id === activePreviewTab)
      || null;
    const mobileTabLabel = activeTab?.label || activeTab?.title || activePreviewTab || '';
    const mobileTabTitle = $('#rMobileProjectTabTitle');
    const mobileLeftTrayTitle = $('#rMobileLeftTrayTitle');
    if (mobileTabTitle) mobileTabTitle.textContent = mobileTabLabel;
    if (mobileLeftTrayTitle) mobileLeftTrayTitle.textContent = mobileTabLabel;
    const mobileTabIcon = $('#rMobileProjectTabIcon');
    if (mobileTabIcon) {
      const icon = String(activeTab?.icon || '').trim();
      mobileTabIcon.hidden = !icon;
      mobileTabIcon.className = icon ? `fas ${icon}` : 'fas';
    }
    const overlay = $('#rOverlay');
    const infoToggle = $('#rMobileProjectInfoToggle');
    const identity = projectModalHeaderIdentity?.ownerTab === activePreviewTab ? projectModalHeaderIdentity : null;
    overlay?.classList.toggle('visit-identity-header', !!identity);
    if (infoToggle) infoToggle.hidden = !!identity;
    if (identity && mobileTabTitle) {
      const copy = document.createElement('span');
      copy.className = 'r-mobile-visit-identity-copy';
      const title = document.createElement('strong');
      title.textContent = identity.title || mobileTabLabel;
      copy.appendChild(title);
      if (identity.subtitle) {
        const subtitle = document.createElement('small');
        subtitle.textContent = identity.subtitle;
        copy.appendChild(subtitle);
      }
      mobileTabTitle.replaceChildren(copy);
      if (mobileTabIcon) mobileTabIcon.hidden = true;
    }
    applyProjectModalPresentation();
  }

  function validPreviewTabs(){
    const tabs = mobileProjectInfoTabEnabled() ? ['info'] : [];
    projectModalApps().forEach((app) => {
      if (!tabs.includes(app.id)) tabs.push(app.id);
    });
    return tabs;
  }

  function overviewCardCount(){
    let count = 0;
    if (materialsEnabled()) count += 1;
    if (proposalsEnabled()) count += 1;
    if (reportsEnabled()) count += 1;
    if (schedulingEnabled()) count += 2;
    return count;
  }

  function projectOverviewIsMapOnly(){
    return overviewCardCount() <= 1;
  }

  function projectOverviewTabLabel(){
    return projectOverviewIsMapOnly()
      ? (window.Portal?.terminology?.get?.('projects.map_tab', 'Map') || 'Map')
      : (window.Portal?.terminology?.get?.('projects.overview_tab', 'Overview') || 'Overview');
  }

  function projectDefaultPreviewTab(){
    const apps = projectModalApps();
    const entitlementHome = apps.find((app) => app.defaultHome === true && !app.disabled);
    if (entitlementHome) return entitlementHome.id;
    if (projectModalAppsShouldInlineMap() && apps.some((app) => app.id === 'measurements')) return 'measurements';
    if (apps.some((app) => app.id === 'map')) return 'map';
    return apps.find((app) => !app.disabled)?.id || apps[0]?.id || 'map';
  }

  function projectMeasurementsModule(){
    return window.Portal?.modules?.projectMeasurements || window.Portal?.ProjectMeasurementsApp || null;
  }

  function mountProjectMeasurementsApp(context = {}){
    const app = projectMeasurementsModule();
    if (!app?.mount) return null;
    const panelRoot = context.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="measurements"]');
    app.mount({
      activeTab: activePreviewTab,
      activeProject: activeBaseProject,
      project: activeBaseProject,
      projectId: activeBaseProject?.id || '',
      ...context,
      panelRoot,
      overlayRoot: $('#rOverlay'),
      host: projectWorkspaceHost(),
      projectWorkspace: projectWorkspaceHost()
    });
    return app;
  }

  function projectMeasurementsInvoke(name, args = []){
    const app = mountProjectMeasurementsApp();
    if (app?.invoke) return app.invoke(name, args);
    const fn = app && app[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  function measurementTabs(...args){ return projectMeasurementsInvoke('measurementTabs', args); }
  function isPlatformProjectId(...args){ return projectMeasurementsInvoke('isPlatformProjectId', args); }
  function normalizedStatusList(values = []){
    return values.map((value) => projectText(value).toLowerCase()).filter(Boolean);
  }
  function isFirstMeasureCompleteStatus(...values){
    return normalizedStatusList(values).some((status) => status === 'completed' || status === 'complete');
  }
  function isFirstMeasureReturnedReportStatus(...values){
    return normalizedStatusList(values).some((status) => (
      status === 'completed'
      || status === 'complete'
      || status === 'rework_requested'
      || status === 'reworking'
      || status === 'customer_rework_requested'
    ));
  }
  function isFirstMeasureUnfinishedStatus(...values){
    return normalizedStatusList(values).some((status) => (
      status === 'draft'
      || status === 'new'
      || status === 'new_lead'
      || status === 'submitted'
      || status === 'queued'
      || status === 'processing'
      || status === 'in_progress'
      || status === 'awaiting_review'
      || status === 'awaiting_manager_review'
      || status === 'pending_rejection'
      || status === 'measurement_ordered'
    ));
  }
  function parseDeliveryHoldDate(value){
    const text = projectText(value);
    if (!text) return null;
    const hasExplicitZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
    const isoish = text.includes('T') ? text : text.replace(' ', 'T');
    const parsed = Date.parse(hasExplicitZone ? isoish : `${isoish}Z`);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  function projectDeliveryReleaseHoldIsActive(...sources){
    return sources.some((source) => {
      if (!source || typeof source !== 'object') return false;
      const raw = (source.raw && typeof source.raw === 'object') ? source.raw : {};
      const manifest = (source.manifest && typeof source.manifest === 'object')
        ? source.manifest
        : ((raw.manifest && typeof raw.manifest === 'object') ? raw.manifest : source);
      const delivery = (manifest.delivery && typeof manifest.delivery === 'object') ? manifest.delivery : {};
      const hold = (manifest.delivery_release_hold && typeof manifest.delivery_release_hold === 'object')
        ? manifest.delivery_release_hold
        : ((delivery.release_hold && typeof delivery.release_hold === 'object') ? delivery.release_hold : {});
      const status = String(manifest.delivery_hold_status || hold.status || '').trim().toLowerCase();
      if (status !== 'holding') return false;
      const scheduled = parseDeliveryHoldDate(manifest.delivery_hold_scheduled_release_at || hold.scheduled_release_at || '');
      return !!scheduled && scheduled.getTime() > Date.now();
    });
  }
  function projectHasDeliveredReport(project = {}){
    const p = project || {};
    const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
      ? p.measurement_project
      : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const manifest = (p.manifest && typeof p.manifest === 'object' && !Array.isArray(p.manifest))
      ? p.manifest
      : ((raw.manifest && typeof raw.manifest === 'object' && !Array.isArray(raw.manifest)) ? raw.manifest : {});
    if (isCancelledStatus(p.status, p.workflow_state, measurement.status, raw.status, manifest.status)) return false;
    if (isRejectedStatus(p.status, measurement.status, raw.status, manifest.status)) return false;
    if (projectDeliveryReleaseHoldIsActive(p, manifest, measurement, raw)) return false;
    const hasMeasurementSignal = [
      p.measurement_project_id,
      p.firstmeasure_project_id,
      p.firstmeasure_id,
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.id,
      raw.project_id,
      raw.folder,
      raw.measurement_project_id,
      manifest.project_id,
      manifest.folder,
      manifest.measurement_project_id
    ].some((value) => !!projectText(value));
    const hasDeliveredStatus = isFirstMeasureReturnedReportStatus(measurement.status, raw.status, manifest.status)
      || (hasMeasurementSignal && isFirstMeasureReturnedReportStatus(p.status, p.workflow_state));
    if (hasDeliveredStatus) return true;
    const hasUnfinishedStatus = isFirstMeasureUnfinishedStatus(p.status, p.workflow_state, measurement.status, raw.status, manifest.status);
    const hasDeliveredAsset = [
      p.report_url,
      p.summary_url,
      p.xml_url,
      p.artifacts?.report_url,
      p.artifacts?.summary_url,
      p.assets?.report_url,
      p.assets?.summary_url,
      measurement.report_url,
      measurement.pdf_url,
      measurement.summary_url,
      measurement.xml_url,
      raw.report_url,
      raw.pdf_url,
      raw.summary_url,
      raw.xml_url,
      manifest.report_url,
      manifest.pdf_url,
      manifest.summary_url,
      manifest.xml_url
    ].some((value) => !!projectText(value));
    return hasMeasurementSignal && hasDeliveredAsset && !hasUnfinishedStatus;
  }
  function resetFirstReportCheckoutEligibility(orgId = projectOrgId()){
    firstReportCheckoutEligibility = {
      orgId,
      loaded: false,
      loading: false,
      eligible: null,
      promise: null
    };
  }

  async function fetchFirstReportCheckoutEligibility(){
    for (let page = 1, totalPages = 1; page <= totalPages; page += 1) {
      const { data } = await postAction('list_projects', {
        filter: 'org',
        status_filter: 'all',
        include_instant_only: '1',
        hide_drafts: '0',
        view: 'card',
        limit: '100',
        page: String(page)
      });
      const projects = Array.isArray(data?.projects) ? data.projects : [];
      if (projects.some(projectHasDeliveredReport)) return false;
      totalPages = Number(data?.pagination?.total_pages || 1) || 1;
      if (page >= totalPages || projects.length < 100) break;
    }
    return true;
  }

  function preloadFirstReportCheckoutEligibility(){
    void firstReportCheckoutEligible({ honorForce: false }).catch(() => null);
  }

  async function firstReportCheckoutEligible({ honorForce = true } = {}){
    if (honorForce && forceFirstReportCheckout) return true;
    const orgId = projectOrgId();
    if (firstReportCheckoutEligibility.orgId !== orgId) resetFirstReportCheckoutEligibility(orgId);
    if (firstReportCheckoutEligibility.loaded) return firstReportCheckoutEligibility.eligible === true;
    if (firstReportCheckoutEligibility.loading && firstReportCheckoutEligibility.promise) {
      return await firstReportCheckoutEligibility.promise;
    }
    firstReportCheckoutEligibility.loading = true;
    firstReportCheckoutEligibility.promise = fetchFirstReportCheckoutEligibility()
      .then((eligible) => {
        firstReportCheckoutEligibility = {
          orgId,
          loaded: true,
          loading: false,
          eligible: eligible === true,
          promise: null
        };
        return eligible === true;
      })
      .catch((error) => {
        console.warn('First report checkout eligibility check failed:', error);
        resetFirstReportCheckoutEligibility(orgId);
        return true;
      });
    try {
      return await firstReportCheckoutEligibility.promise;
    } catch (error) {
      console.warn('First report checkout eligibility check failed:', error);
      resetFirstReportCheckoutEligibility(orgId);
      return true;
    }
  }
  function isCancelledStatus(...values){
    return normalizedStatusList(values).some((status) => status === 'cancelled' || status === 'canceled');
  }
  function isRejectedStatus(...values){
    return normalizedStatusList(values).some((status) => status === 'rejected' || status === 'rejected_no_coverage');
  }
  function currentReportMeasurement(){
    const measurement = (activeBaseProject?.measurement_project && typeof activeBaseProject.measurement_project === 'object')
      ? activeBaseProject.measurement_project
      : ((activeBaseProject?.measurement && typeof activeBaseProject.measurement === 'object') ? activeBaseProject.measurement : {});
    return measurement && typeof measurement === 'object' ? measurement : {};
  }
  function currentReportMeasurementRaw(){
    const measurement = currentReportMeasurement();
    return measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
  }
  function currentReportManifest(){
    const raw = currentReportMeasurementRaw();
    if (raw.manifest && typeof raw.manifest === 'object') return raw.manifest;
    if (activeBaseProject?.manifest && typeof activeBaseProject.manifest === 'object') return activeBaseProject.manifest;
    return {};
  }
  function reportOrderStatus(){
    const measurement = currentReportMeasurement();
    const raw = currentReportMeasurementRaw();
    const manifest = currentReportManifest();
    return projectText(
      reportOrderState?.status,
      measurement.status,
      raw.status,
      manifest.status,
      activeBaseProject?.status,
      activeBaseProject?.workflow_state
    ).toLowerCase();
  }
  function reportOrderIsCancelled(){
    return ['cancelled', 'canceled'].includes(reportOrderStatus());
  }
  function reportOrderIsRejected(){
    return ['rejected', 'rejected_no_coverage'].includes(reportOrderStatus());
  }
  function reportOrderKnownAssetUrls(...args){ return projectMeasurementsInvoke('reportOrderKnownAssetUrls', args); }
  function primeMeasurementAssetCacheFromKnownUrls(...args){ return projectMeasurementsInvoke('primeMeasurementAssetCacheFromKnownUrls', args); }
  function reportOrderHasReadyAssets(...args){ return projectMeasurementsInvoke('reportOrderHasReadyAssets', args); }
  function reportOrderIsCompleteLike(...args){ return projectMeasurementsInvoke('reportOrderIsCompleteLike', args); }
  function reportOrderIsActivelyPending(){
    if (!hasReportOrdered() || reportOrderIsCancelled() || reportOrderIsRejected()) return false;
    if (reportOrderState?.hasReadyReport) return false;
    const status = reportOrderStatus();
    if (isFirstMeasureReturnedReportStatus(status)) return false;
    return [
      '',
      'submitted',
      'queued',
      'ready',
      'processing',
      'in_progress',
      'awaiting_review',
      'awaiting_manager_review',
      'pending_rejection',
      'measurement_ordered'
    ].includes(status);
  }
  function reportOrderPendingStage(...args){ return projectMeasurementsInvoke('reportOrderPendingStage', args); }
  function firstMeasurementId(...values){
    for (const value of values) {
      const text = projectText(value);
      if (text && !/^(project|base|__optimistic)_/i.test(text)) return text;
    }
    return '';
  }
  function measurementIdFromAssetUrl(...values){
    for (const value of values) {
      const text = projectText(value);
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      const id = match ? firstMeasurementId(decodeURIComponent(match[1] || '')) : '';
      if (id) return id;
    }
    return '';
  }
  function activeMeasurementProjectId(){
    const measurement = (activeBaseProject?.measurement_project && typeof activeBaseProject.measurement_project === 'object')
      ? activeBaseProject.measurement_project
      : ((activeBaseProject?.measurement && typeof activeBaseProject.measurement === 'object') ? activeBaseProject.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const assetMeasurementId = measurementIdFromAssetUrl(
      activeBaseProject?.report_url,
      activeBaseProject?.pdf_url,
      activeBaseProject?.summary_url,
      activeBaseProject?.xml_url,
      measurement.report_url,
      measurement.pdf_url,
      measurement.summary_url,
      measurement.xml_url,
      raw.report_url,
      raw.pdf_url,
      raw.summary_url,
      raw.xml_url,
      reportOrderState?.reportUrl,
      reportOrderState?.summaryUrl,
      reportOrderState?.xmlUrl
    );
    return firstMeasurementId(
      measurement.id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.folder,
      raw.id,
      raw.project_id,
      reportOrderState?.data?.folder,
      reportOrderState?.data?.project?.id,
      reportOrderState?.data?.project?.project_id,
      activeBaseProject?.measurement_project_id,
      activeBaseProject?.folder,
      assetMeasurementId,
      measurement.project_id,
      activeBaseProject?.project_id
    );
  }
  function parseReportDate(...args){ return projectMeasurementsInvoke('parseReportDate', args); }
  function reportOrderSubmittedAt(...args){ return projectMeasurementsInvoke('reportOrderSubmittedAt', args); }
  function reportOrderIsStaleSubmitted(...args){ return projectMeasurementsInvoke('reportOrderIsStaleSubmitted', args); }
  function reportReleaseHoldIsActive(...args){ return projectMeasurementsInvoke('reportReleaseHoldIsActive', args); }
  function reportOrderReleaseHoldIsActive(...args){ return projectMeasurementsInvoke('reportOrderReleaseHoldIsActive', args); }
  function reportOrderMeasurement(){ return currentReportMeasurement(); }
  function reportOrderExpediteKey(...args){ return projectMeasurementsInvoke('reportOrderExpediteKey', args); }
  function reportOrderIsExpedited(...args){ return projectMeasurementsInvoke('reportOrderIsExpedited', args); }
  function reportExpediteRefundInfo(...args){ return projectMeasurementsInvoke('reportExpediteRefundInfo', args); }
  function reportExpediteRefundNoticeHtml(...args){ return projectMeasurementsInvoke('reportExpediteRefundNoticeHtml', args); }
  function reportOrderDueEnd(...args){ return projectMeasurementsInvoke('reportOrderDueEnd', args); }
  function reportOrderCustomerDeliveryText(...args){ return projectMeasurementsInvoke('reportOrderCustomerDeliveryText', args); }
  function formatMinutesDuration(...args){ return projectMeasurementsInvoke('formatMinutesDuration', args); }
  function formatCancelRemaining(...args){ return projectMeasurementsInvoke('formatCancelRemaining', args); }
  function reportOrderRemainingMinutes(...args){ return projectMeasurementsInvoke('reportOrderRemainingMinutes', args); }
  function reportOrderCancelState(...args){ return projectMeasurementsInvoke('reportOrderCancelState', args); }
  function clearCancellationCountdown(...args){ return projectMeasurementsInvoke('clearCancellationCountdown', args); }
  function scheduleCancellationCountdown(...args){ return projectMeasurementsInvoke('scheduleCancellationCountdown', args); }
  function refreshCancellationCountdown(...args){ return projectMeasurementsInvoke('refreshCancellationCountdown', args); }
  function pendingExpediteOptions(...args){ return projectMeasurementsInvoke('pendingExpediteOptions', args); }
  function pendingExpeditePriceHtml(...args){ return projectMeasurementsInvoke('pendingExpeditePriceHtml', args); }
  function selectPendingReportExpedite(...args){ return projectMeasurementsInvoke('selectPendingReportExpedite', args); }
  function pendingReportHtml(...args){ return projectMeasurementsInvoke('pendingReportHtml', args); }
  function reportCompletePlaceholderHtml(...args){ return projectMeasurementsInvoke('reportCompletePlaceholderHtml', args); }
  function cancelledReportHtml(...args){ return projectMeasurementsInvoke('cancelledReportHtml', args); }
  function staleSubmittedReportHtml(...args){ return projectMeasurementsInvoke('staleSubmittedReportHtml', args); }
  function normalizeProjectTypeLabel(...args){ return projectMeasurementsInvoke('normalizeProjectTypeLabel', args); }
  function reportOrderReorderType(...args){ return projectMeasurementsInvoke('reportOrderReorderType', args); }
  function customerRejectionCopy(...args){ return projectMeasurementsInvoke('customerRejectionCopy', args); }
  function normalizeOrderProjectType(...args){ return projectMeasurementsInvoke('normalizeOrderProjectType', args); }
  function reorderSourceProjectId(...args){ return projectMeasurementsInvoke('reorderSourceProjectId', args); }
  function applyReorderPrefillState(...args){ return projectMeasurementsInvoke('applyReorderPrefillState', args); }
  function rejectedReportHtml(...args){ return projectMeasurementsInvoke('rejectedReportHtml', args); }
  function reorderCurrentReportOrder(...args){ return projectMeasurementsInvoke('reorderCurrentReportOrder', args); }
  function reorderCancelledReportOrder(...args){ return projectMeasurementsInvoke('reorderCancelledReportOrder', args); }
  function reorderRejectedReportOrder(...args){ return projectMeasurementsInvoke('reorderRejectedReportOrder', args); }
  function reportFrameHtml(...args){ return projectMeasurementsInvoke('reportFrameHtml', args); }
  function xmlDownloadFileName(...args){ return projectMeasurementsInvoke('xmlDownloadFileName', args); }
  function xmlDownloadPanelHtml(...args){ return projectMeasurementsInvoke('xmlDownloadPanelHtml', args); }
  function downloadXmlModel(...args){ return projectMeasurementsInvoke('downloadXmlModel', args); }
  function weatherApiUrl(...args){ return projectMeasurementsInvoke('weatherApiUrl', args); }
  function weatherReportInfo(...args){ return projectMeasurementsInvoke('weatherReportInfo', args); }
  function weatherReportStructureCount(...args){ return projectMeasurementsInvoke('weatherReportStructureCount', args); }
  function weatherReportTotalPrice(...args){ return projectMeasurementsInvoke('weatherReportTotalPrice', args); }
  function weatherReportOrderButtonHtml(...args){ return projectMeasurementsInvoke('weatherReportOrderButtonHtml', args); }
  function weatherReportPanelHtml(...args){ return projectMeasurementsInvoke('weatherReportPanelHtml', args); }
  function clearWeatherReportPoll(...args){ return projectMeasurementsInvoke('clearWeatherReportPoll', args); }
  function markWeatherReportOrderedLocally(...args){ return projectMeasurementsInvoke('markWeatherReportOrderedLocally', args); }
  function refreshWeatherReportState(...args){ return projectMeasurementsInvoke('refreshWeatherReportState', args); }
  function scheduleWeatherReportPoll(...args){ return projectMeasurementsInvoke('scheduleWeatherReportPoll', args); }
  function checkWeatherReportStatus(...args){ return projectMeasurementsInvoke('checkWeatherReportStatus', args); }
  function orderWeatherReport(...args){ return projectMeasurementsInvoke('orderWeatherReport', args); }
  function reportRequestProjectType(...args){ return projectMeasurementsInvoke('reportRequestProjectType', args); }
  function reportChangeRequests(...args){ return projectMeasurementsInvoke('reportChangeRequests', args); }
  function reportRequestsAreSupportOnly(...args){ return projectMeasurementsInvoke('reportRequestsAreSupportOnly', args); }
  function reportChangeRequestLabel(...args){ return projectMeasurementsInvoke('reportChangeRequestLabel', args); }
  function reportChangeRequestStatusText(...args){ return projectMeasurementsInvoke('reportChangeRequestStatusText', args); }
  function reportChangesPanelHtml(...args){ return projectMeasurementsInvoke('reportChangesPanelHtml', args); }
  function ensureReportChangesPane(...args){ return projectMeasurementsInvoke('ensureReportChangesPane', args); }
  function reportHasReturnedAssets(...args){ return projectMeasurementsInvoke('reportHasReturnedAssets', args); }
  function renderReportFollowupButton(...args){ return projectMeasurementsInvoke('renderReportFollowupButton', args); }
  function reportRequestExistingPins(...args){ return projectMeasurementsInvoke('reportRequestExistingPins', args); }
  function reportRequestNewPins(...args){ return projectMeasurementsInvoke('reportRequestNewPins', args); }
  function reportRequestStructureCount(...args){ return projectMeasurementsInvoke('reportRequestStructureCount', args); }
  function syncReportRequestStructureCount(...args){ return projectMeasurementsInvoke('syncReportRequestStructureCount', args); }
  function reportRequestChargeEstimate(...args){ return projectMeasurementsInvoke('reportRequestChargeEstimate', args); }
  function reportRequestExpediteOptions(...args){ return projectMeasurementsInvoke('reportRequestExpediteOptions', args); }
  function fitReportRequestMap(...args){ return projectMeasurementsInvoke('fitReportRequestMap', args); }
  function updateReportRequestModalDynamicUi(...args){ return projectMeasurementsInvoke('updateReportRequestModalDynamicUi', args); }
  function setupReportRequestMap(...args){ return projectMeasurementsInvoke('setupReportRequestMap', args); }
  function closeReportRequestModal(...args){ return projectMeasurementsInvoke('closeReportRequestModal', args); }
  function reportRequestModalTypeMeta(...args){ return projectMeasurementsInvoke('reportRequestModalTypeMeta', args); }
  function refreshReportRequestModal(...args){ return projectMeasurementsInvoke('refreshReportRequestModal', args); }
  function openReportRequestModal(...args){ return projectMeasurementsInvoke('openReportRequestModal', args); }
  function readReportRequestPhotos(...args){ return projectMeasurementsInvoke('readReportRequestPhotos', args); }
  function mergeReportReworkResponse(...args){ return projectMeasurementsInvoke('mergeReportReworkResponse', args); }
  function submitReportReworkRequestAction(...args){ return projectMeasurementsInvoke('submitReportReworkRequestAction', args); }
  function submitReportRequestModal(...args){ return projectMeasurementsInvoke('submitReportRequestModal', args); }
  function disposeInstantMeasurement(...args){ return projectMeasurementsInvoke('disposeInstantMeasurement', args); }
  function buildInstantMeasurementProject(...args){ return projectMeasurementsInvoke('buildInstantMeasurementProject', args); }
  function renderInstantMeasurement(...args){ return projectMeasurementsInvoke('renderInstantMeasurement', args); }
  function loadMeasurementAssets(...args){ return projectMeasurementsInvoke('loadMeasurementAssets', args); }
  function setActiveMeasurementTab(...args){ return projectMeasurementsInvoke('setActiveMeasurementTab', args); }
  function mergeReportManifestIntoActiveProject(...args){ return projectMeasurementsInvoke('mergeReportManifestIntoActiveProject', args); }
  function snapshotReportExpediteState(...args){ return projectMeasurementsInvoke('snapshotReportExpediteState', args); }
  function restoreReportExpediteState(...args){ return projectMeasurementsInvoke('restoreReportExpediteState', args); }
  function applyOptimisticReportExpedite(...args){ return projectMeasurementsInvoke('applyOptimisticReportExpedite', args); }
  function upgradePendingReportExpedite(...args){ return projectMeasurementsInvoke('upgradePendingReportExpedite', args); }
  function cancelPendingReportOrder(...args){ return projectMeasurementsInvoke('cancelPendingReportOrder', args); }
  function renderMeasurementsPanel(...args){ return projectMeasurementsInvoke('renderMeasurementsPanel', args); }
  function resetProjectMeasurementsApp(){ return projectMeasurementsInvoke('reset', []); }

  function projectScheduleModule(){
    return window.Portal?.modules?.projectSchedule || window.Portal?.ProjectScheduleApp || null;
  }

  function mountProjectScheduleApp(context = {}){
    const app = projectScheduleModule();
    if (!app?.mount) return null;
    const panelRoot = context.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="schedule"]');
    app.mount({
      ...projectModalTabContext(),
      ...context,
      active: context.active !== undefined ? context.active : activePreviewTab === 'schedule',
      panelRoot,
      overlayRoot: $('#rOverlay'),
      host: projectWorkspaceHost(),
      projectWorkspace: projectWorkspaceHost()
    });
    return app;
  }

  function projectScheduleInvoke(name, args = []){
    const app = mountProjectScheduleApp();
    if (app?.invoke) return app.invoke(name, args);
    const fn = app && app[name];
    return typeof fn === 'function' ? fn(...(Array.isArray(args) ? args : [])) : undefined;
  }

  function cssEscape(value){
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function currentProjectSalesAppointment(...args){ return projectScheduleInvoke('currentProjectSalesAppointment', args) || null; }
  function appointmentSummaryLabel(...args){ return projectScheduleInvoke('appointmentSummaryLabel', args) || ''; }
  function startAppointmentScheduling(...args){ return projectScheduleInvoke('startAppointmentScheduling', args); }
  function updateScheduleChoiceCard(...args){ return projectScheduleInvoke('updateScheduleChoiceCard', args); }
  function renderSchedulePanel(...args){ return projectScheduleInvoke('renderSchedulePanel', args); }
  function openScheduleDialog(...args){ return projectScheduleInvoke('openScheduleDialog', args); }
  function saveCalendarAppointment(...args){ return projectScheduleInvoke('saveCalendarAppointment', args); }
  function scheduleHasDraft(){ return !!projectScheduleInvoke('hasDraft', []); }
  function prepareScheduleFromEvent(...args){ return projectScheduleInvoke('prepareFromEvent', args); }
  function resetProjectScheduleApp(){ return projectScheduleInvoke('reset', []); }

  function renderProjectViewerSummary(){
    const summary = $('#rViewerSummary');
    if (!summary) return;
    const appointment = currentProjectSalesAppointment();
    summary.classList.toggle('visible', !!appointment);
    summary.innerHTML = `
      ${appointment ? `<div class="r-viewer-appt"><i class="fas fa-calendar-check"></i><span>${escapeHtml(appointmentSummaryLabel(appointment))}</span></div>` : ''}
    `;
    return;
    const contacts = collectContacts();
    const primary = contacts[0] || {};
    const contactLines = [
      primary.name || '',
      primary.email || '',
      primary.phone || ''
    ].filter(Boolean);
    summary.innerHTML = `
      <div class="r-viewer-item"><div class="r-viewer-k">${(globalThis.PlatformLanguage?.text("project-request","m_53d803cdbe9ab1","Address") ?? "Address")}</div><div class="r-viewer-v">${String(escapeHtml(($('#rAddress')?.value || reportOrderState?.address || '—').trim() || '—'))}</div></div>
      <div class="r-viewer-item"><div class="r-viewer-k">${(globalThis.PlatformLanguage?.text("project-request","m_29f3cc51016963","Project Type") ?? "Project Type")}</div><div class="r-viewer-v">${String(escapeHtml(TYPE_META[selectedType]?.label || selectedType || '—'))}</div></div>
      <div class="r-viewer-item"><div class="r-viewer-k">${(globalThis.PlatformLanguage?.text("project-request","m_ae8e4953e07d70","Customer") ?? "Customer")}</div><div class="r-viewer-v">${String(contactLines.length ? contactLines.map(escapeHtml).join('<br>') : '—')}</div></div>
    `;
  }

  function projectNotesApi(){ return expandedPlatformEnabled() ? window.Portal?.ProjectNotes || null : null; }
  function legacyProjectNotesText(){
    if (!expandedPlatformEnabled()) return ($('#rProjectNotes')?.value || '').trim();
    return typeof activeBaseProject?.project_notes === 'string' ? activeBaseProject.project_notes : '';
  }
  function projectNoteDate(value){
    const date = new Date(value || 0);
    return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toLocaleString([], { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }) : 'Earlier';
  }
  function projectNoteMentionAvatar(user = {}){
    return projectText(user.avatar, user.avatar_url, user.photo_url, user.profile_photo_url, user.image_url, user.picture);
  }
  function projectNoteMentionHtml(user = {}, label = ''){
    const name = projectText(user.name, user.label, user.email, user.id, String(label).replace(/^@/, ''));
    const email = projectText(user.email, user.id);
    const avatar = projectNoteMentionAvatar(user);
    const initial = projectText(name, email, '?').slice(0, 1).toUpperCase();
    const isAgent = String(user.id || '').startsWith('agent_') || user.agent === true;
    const avatarHtml = isAgent
      ? '<span style="display:inline-block;width:22px;height:22px;background:var(--primary-readable,var(--primary,#d93025));-webkit-mask:url(\'/images/logo_square.png\') center / contain no-repeat;mask:url(\'/images/logo_square.png\') center / contain no-repeat"></span>'
      : (avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initial));
    return `<span class="r-note-mention" role="button" tabindex="0" data-project-note-mention-user="${escapeHtml(projectText(user.id, email, name))}" data-project-note-mention-name="${escapeHtml(name)}" data-project-note-mention-email="${escapeHtml(email)}" data-project-note-mention-avatar="${escapeHtml(avatar)}">${escapeHtml(String(label).replace(/^@/, '') || name)}<span class="r-note-mention-card"><span class="r-note-mention-avatar"${isAgent ? ' style="background:#fff;border:1px solid #eef1f4"' : ''}>${avatarHtml}</span><span style="min-width:0"><span class="r-note-mention-name">${escapeHtml(name || email || 'User')}</span>${email ? `<span class="r-note-mention-email">${escapeHtml(email)}</span>` : ''}</span></span></span>`;
  }
  function projectNoteTextHtml(note = {}){
    const text = String(note.text || '');
    const storedUsers = Array.isArray(note.mention_users) ? note.mention_users.filter(Boolean) : [];
    const inferredUsers = window.FirstMateTags?.extractMentions?.(text, projectNoteMentionDirectory) || [];
    const users = [...new Map([...storedUsers, ...inferredUsers].map((user) => [projectText(user.id, user.email, user.name).toLowerCase(), user])).values()].filter(Boolean);
    if (!text || !users.length) return escapeHtml(text);
    const ranges = [];
    users.forEach((user) => {
      const labels = [...new Set([user.name, user.email, user.label, user.id].map(projectText).filter(Boolean))].sort((a,b) => b.length - a.length);
      labels.forEach((label) => {
        const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`@${escaped}(?=$|\\s|[.,;:!?\\)\\]])`, 'ig');
        let match;
        while ((match = regex.exec(text))) {
          const start = match.index;
          const end = start + match[0].length;
          if (!ranges.some((range) => start < range.end && end > range.start)) ranges.push({ start, end, user, label:match[0] });
        }
      });
    });
    if (!ranges.length) return escapeHtml(text);
    ranges.sort((a,b) => a.start - b.start);
    let html = '';
    let cursor = 0;
    ranges.forEach((range) => {
      html += escapeHtml(text.slice(cursor, range.start));
      html += projectNoteMentionHtml(range.user, range.label);
      cursor = range.end;
    });
    return html + escapeHtml(text.slice(cursor));
  }
  function projectNoteMentionUser(chip){
    return { id:chip?.dataset?.projectNoteMentionUser || '', name:chip?.dataset?.projectNoteMentionName || '', email:chip?.dataset?.projectNoteMentionEmail || '', avatar:chip?.dataset?.projectNoteMentionAvatar || '' };
  }
  function positionProjectNoteMentionCard(chip){
    const card = chip?.querySelector?.('.r-note-mention-card');
    if (!chip || !card) return;
    const rect = chip.getBoundingClientRect();
    card.classList.add('visible');
    const cardRect = card.getBoundingClientRect();
    const width = cardRect.width || 250;
    const height = cardRect.height || 64;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const preferredTop = rect.top - height - 8;
    card.style.left = `${left}px`;
    card.style.top = `${Math.max(8, preferredTop < 8 ? rect.bottom + 8 : preferredTop)}px`;
  }
  function hideProjectNoteMentionCard(chip){ chip?.querySelector?.('.r-note-mention-card')?.classList.remove('visible'); }
  function openProjectNoteMentionUser(chip){
    const user = projectNoteMentionUser(chip);
    if (!projectText(user.id, user.email, user.name)) return;
    window.Portal?.PhotoFeed?.openUserModal?.(user, []);
  }
  function autoSizeProjectNoteInput(){
    const input = $('#rProjectNotes');
    if (!input) return;
    input.style.height = '0px';
    input.style.height = `${Math.min(180, Math.max(56, input.scrollHeight))}px`;
    input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
    const highlights = $('#rProjectNoteHighlights');
    if (highlights) highlights.style.height = input.style.height;
  }
  function renderProjectNoteComposerMentions(){
    const input = $('#rProjectNotes');
    const highlights = $('#rProjectNoteHighlights');
    const wrap = input?.closest('.r-note-input-wrap');
    if (!input || !highlights || !wrap) return;
    const text = input.value || '';
    const mentions = projectNoteMentionController?.confirmedMentions?.() || [];
    const ranges = [];
    mentions.forEach((user) => {
      const labels = [user.name, user.email, user.id].map((value) => projectText(value)).filter(Boolean);
      labels.forEach((label) => {
        const needle = `@${label}`.toLowerCase();
        let from = 0;
        while (from < text.length) {
          const start = text.toLowerCase().indexOf(needle, from);
          if (start < 0) break;
          const end = start + needle.length;
          if (!ranges.some((range) => start < range.end && end > range.start)) ranges.push({ start, end });
          from = end;
        }
      });
    });
    ranges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    highlights.innerHTML = ranges.map((range) => {
      const before = escapeHtml(text.slice(cursor, range.start));
      const tag = `<span class="r-note-compose-mention">${escapeHtml(text.slice(range.start, range.end))}</span>`;
      cursor = range.end;
      return before + tag;
    }).join('') + escapeHtml(text.slice(cursor)) + (text.endsWith('\n') ? '\n' : '');
    const style = getComputedStyle(input);
    highlights.style.padding = style.padding;
    highlights.style.font = style.font;
    highlights.style.letterSpacing = style.letterSpacing;
    highlights.style.lineHeight = style.lineHeight;
    highlights.scrollTop = input.scrollTop;
    wrap.classList.toggle('has-mentions', ranges.length > 0);
  }
  function renderProjectNoteVisibilityMenu(){
    const api = projectNotesApi();
    const menu = $('#rProjectNoteVisibilityMenu');
    const label = $('#rProjectNoteVisibilityLabel');
    if (!api || !menu) return;
    const all = projectNoteVisibility.length === api.GROUPS.length;
    menu.innerHTML = ("<button type=\"button\" data-project-note-group=\"everybody\" class=\"" + String(all ? 'active' : '') + "\"><i class=\"fas fa-" + String(all ? 'check-circle' : 'circle') + "\"></i>" + (globalThis.PlatformLanguage?.text("project-request","m_d068fb68fb07d2","Everybody") ?? "Everybody") + "</button>" + String(api.GROUPS.map((group) => `<button type="button" data-project-note-group="${group}" class="${projectNoteVisibility.includes(group) ? 'active' : ''}"><i class="fas fa-${projectNoteVisibility.includes(group) ? 'check-circle' : 'circle'}"></i>${escapeHtml(group[0].toUpperCase() + group.slice(1))}</button>`).join('')) + "<button type=\"button\" data-project-note-group=\"only_tagged\" class=\"" + String(projectNoteVisibility.length ? '' : 'active') + "\"><i class=\"fas fa-" + String(projectNoteVisibility.length ? 'circle' : 'check-circle') + "\"></i>" + (globalThis.PlatformLanguage?.text("project-request","m_6909fe060ad4e1","Only Tagged") ?? "Only Tagged") + "</button>");
    if (label) label.textContent = api.visibilityLabel(projectNoteVisibility);
  }
  function projectNoteVisibilityMenuHome(){ return document.querySelector('#rOverlay .r-bottom-notes'); }
  function closeProjectNoteVisibilityMenu(){
    const menu = $('#rProjectNoteVisibilityMenu');
    if (!menu) return;
    menu.hidden = true;
    menu.style.left = '0px';
    menu.style.top = '0px';
    projectNoteVisibilityMenuHome()?.appendChild(menu);
    $('#rProjectNoteVisibility')?.setAttribute('aria-expanded', 'false');
  }
  function positionProjectNoteVisibilityMenu(){
    const menu = $('#rProjectNoteVisibilityMenu');
    const trigger = $('#rProjectNoteVisibility');
    if (!menu || !trigger || menu.hidden) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 8;
    const safeInset = 16;
    const viewportWidth = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 0);
    const viewportHeight = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 0);
    const preferredLeft = rect.right + gap;
    const left = Math.max(safeInset, Math.min(preferredLeft, viewportWidth - menu.offsetWidth - safeInset));
    const top = Math.max(safeInset, Math.min(rect.top - 6, viewportHeight - menu.offsetHeight - safeInset));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
  function openProjectNoteVisibilityMenu(){
    const menu = $('#rProjectNoteVisibilityMenu');
    const trigger = $('#rProjectNoteVisibility');
    if (!menu || !trigger) return;
    document.body.appendChild(menu);
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionProjectNoteVisibilityMenu();
  }
  function renderProjectNoteHistory(){
    const api = projectNotesApi();
    const history = $('#rProjectNoteHistory');
    const tools = $('#rProjectNoteHistoryTools');
    const deck = $('#rProjectNoteHistoryDeck');
    if (!history || !tools || !deck || !api) return;
    const open = !proposalInternalNotesCollapsed;
    const expanded = open || projectNoteHistoryClosing;
    deck.setAttribute('aria-hidden', open ? 'false' : 'true');
    const notesRoot = history.closest('.r-bottom-notes');
    notesRoot?.classList.toggle('expanded', expanded);
    notesRoot?.classList.toggle('closing', projectNoteHistoryClosing);
    notesRoot?.closest('.r-left')?.classList.toggle('notes-history-expanded', expanded);
    const search = ($('#rProjectNoteSearch')?.value || '').trim().toLowerCase();
    const oldest = $('#rProjectNoteSort')?.value === 'oldest';
    const notes = (activeBaseProject ? (search ? api.visible(activeBaseProject) : (api.timeline?.(activeBaseProject) || api.visible(activeBaseProject))) : []).filter((note) => !search || `${note.text} ${note.created_by?.name || ''} ${note.created_by?.email || ''} ${(api.typeTags(note) || []).map((tag) => tag.label).join(' ')}`.toLowerCase().includes(search)).sort((a,b) => (oldest ? 1 : -1) * String(a.created_at).localeCompare(String(b.created_at)));
    history.innerHTML = notes.length ? notes.map((note) => note.deleted_at
      ? `<article class="r-note-card pn-removed" data-project-note-id="${escapeHtml(note.id)}">${api.removedNoteHtml?.(note) || ''}</article>`
      : `<article class="r-note-card ${api.typeTags(note).length ? 'fm-note-card-with-types' : ''}" data-project-note-id="${escapeHtml(note.id)}">${api.renderTypeTags(note)}${note.text ? `<p>${projectNoteTextHtml(note)}</p>` : ''}${api.audioPlayerHtml?.(note) || ''}${api.mediaAttachmentsHtml?.(note) || ''}<div class="r-note-card-meta"><span>${escapeHtml(note.created_by?.name || note.created_by?.email || 'Unknown')} · ${escapeHtml(projectNoteDate(note.created_at))} · ${escapeHtml(api.visibilityLabel(note.visibility))}${api.editedMetaHtml?.(note) || ''}</span><span class="r-note-card-actions">${api.repliesToggleHtml?.(note) || ''}${(note.can_edit || api.owns(note)) ? `<button type="button" data-project-note-edit="${String(escapeHtml(note.id))}" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_1fcb173e99effe","Edit note") ?? "Edit note")}"><i class="fas fa-pen"></i></button>` : ''}${(note.can_delete || api.owns(note)) ? `<button type="button" data-project-note-remove="${String(escapeHtml(note.id))}" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_4b4ba3b5b6d01b","Remove note") ?? "Remove note")}"><i class="fas fa-trash"></i></button>` : ''}</span></div></article>`).join('') : `<div class="r-note-empty">${search ? 'No notes match this filter.' : 'No notes yet.'}</div>`;
    window.FirstMateAudioNotes?.hydrate?.(history);
  }
  function syncProjectNotesUi(){
    if (!expandedPlatformEnabled()) return;
    const api = projectNotesApi();
    // Notes come from the channels backend; kick a lazy load so the history
    // deck fills in and re-renders via fm:project-notes:refreshed.
    if (activeBaseProject?.id) projectNotesApi()?.load?.(activeBaseProject);
    renderProjectNoteVisibilityMenu();
    renderProjectNoteHistory();
    const audioPending = $('#rProjectAudioPending');
    if (audioPending) {
      if (pendingProjectAudio) {
        const pendingAudioButton = $('#rProjectAudioNote');
        if (pendingAudioButton) pendingAudioButton.disabled = true;
        api?.mountPreparedUpload?.(audioPending, pendingProjectAudio, () => {
          pendingProjectAudio = null;
          const audioButton = $('#rProjectAudioNote');
          if (audioButton) audioButton.disabled = false;
          const uploadButton = $('#rProjectNoteUpload');
          if (uploadButton) uploadButton.disabled = false;
          audioPending.innerHTML = '';
        });
      } else {
        audioPending.innerHTML = '';
      }
    }
    const button = $('#rProjectNoteAdd');
    if (button) button.innerHTML = editingProjectNoteId ? '<i class="fas fa-check"></i> Save note' : '<i class="fas fa-plus"></i> Add note';
    $('#rProjectNotesToggle')?.setAttribute('aria-expanded', proposalInternalNotesCollapsed ? 'false' : 'true');
    autoSizeProjectNoteInput();
    renderProjectNoteComposerMentions();
  }
  function revealRoutedProjectNote(noteId){
    const id = projectText(noteId);
    if (!id || !activeBaseProject || projectShellLoading) return false;
    window.clearTimeout(projectNoteHistoryCloseTimer);
    projectNoteHistoryCloseTimer = 0;
    projectNoteHistoryClosing = false;
    proposalInternalNotesCollapsed = false;
    const search = $('#rProjectNoteSearch');
    if (search) search.value = '';
    renderProjectNoteHistory();
    const findCard = () => [...($('#rProjectNoteHistory')?.querySelectorAll('[data-project-note-id]') || [])]
      .find((item) => projectText(item.dataset.projectNoteId) === id);
    const highlight = (card) => {
      card.classList.add('notification-target');
      window.requestAnimationFrame(() => card.scrollIntoView?.({ behavior:'smooth', block:'center' }));
      window.setTimeout(() => card.classList.remove('notification-target'), 3600);
    };
    const card = findCard();
    if (card) { highlight(card); return true; }
    // Notes may still be loading from the backend — retry once after the fetch.
    projectNotesApi()?.load?.(activeBaseProject)?.then?.(() => {
      renderProjectNoteHistory();
      const late = findCard();
      if (late) highlight(late);
    });
    return false;
  }

  function restoreProjectNoteRoute(){
    const route = window.Portal?.navigation?.read?.() || window.Portal?.routeState?.get?.() || {};
    const noteId = projectText(route.projectNote);
    if (!noteId || !activeModalMatchesProject(route.project)) return false;
    return revealRoutedProjectNote(noteId);
  }
  async function persistProjectNoteMutation(){
    // Notes persist through the channels backend (flush awaits the pending
    // write); the project document itself no longer carries note data.
    await projectNotesApi()?.flush?.(activeBaseProject)?.catch?.(() => null);
    window.dispatchEvent(new CustomEvent('fm:project-notes:changed', { detail:{ projectId:activeBaseProject?.id || '' } }));
  }
  async function commitProjectNote(){
    const api = projectNotesApi();
    const input = $('#rProjectNotes');
    const text = (input?.value || '').trim();
    if (!api || (!text && !pendingProjectAudio?.attachment)) return;
    if (!activeBaseProject) ensureContactOnlyBaseProject() || ensureDraftBaseProject();
    if (!activeBaseProject) return;
    const mentionUsers = projectNoteMentionController?.selectedMentions?.() || [];
    const note = editingProjectNoteId
      ? api.update(activeBaseProject, editingProjectNoteId, { text, visibility:projectNoteVisibility, mention_users:mentionUsers })
      : api.add(activeBaseProject, text, projectNoteVisibility, mentionUsers, [], pendingProjectAudio ? {
        attachments:[pendingProjectAudio.attachment],
        metadata:pendingProjectAudio.kind === 'audio' || String(pendingProjectAudio.attachment?.content_type || '').startsWith('audio/')
          ? { audio_note:pendingProjectAudio.metadata }
          : pendingProjectAudio.metadata
      } : {});
    editingProjectNoteId = '';
    pendingProjectAudio = null;
    const audioButton = $('#rProjectAudioNote');
    if (audioButton) audioButton.disabled = false;
    const uploadButton = $('#rProjectNoteUpload');
    if (uploadButton) uploadButton.disabled = false;
    input.value = '';
    projectNoteMentionController?.setSelectedMentions?.([]);
    autoSizeProjectNoteInput();
    renderProjectNoteComposerMentions();
    proposalInternalNotesCollapsed = false;
    syncProjectNotesUi();
    await persistProjectNoteMutation();
    // Mention notifications are created server-side by the channels backend,
    // so no frontend mention event is needed here anymore.
    showToast((globalThis.PlatformLanguage?.text("project-request","m_6c9ffb3d517f10","Note saved") ?? "Note saved"), (globalThis.PlatformLanguage?.text("project-request","m_3b44027b035a28","Project note added to the history.") ?? "Project note added to the history."), true);
  }

  function syncProjectNotesPlacement(){
    const notes = document.querySelector('#rOverlay .r-bottom-notes');
    const agent = document.querySelector('#rOverlay #rProposalAgent');
    const inlineMount = $('#rInlineNotesMount');
    const mobileDetailMount = $('#rMobileInternalNotesMount');
    const bottomMount = document.querySelector('#rOverlay .r-left-bottom');
    const notesRailMount = $('#rProposalNotesRailMount');
    const notesRailSection = $('#rProposalNotesRailSection');
    const agentRailMount = $('#rProposalAgentRailMount');
    const agentRailSection = $('#rProposalAgentRailSection');
    if (!notes || !inlineMount || !bottomMount) return;
    const proposalTabActive = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    const mobileInline = proposalTabActive && !projectLeftColumnOverridden() && window.matchMedia?.('(max-width: 720px)')?.matches;
    const proposalEditMode = proposalTabActive && proposalWorkspaceMode === 'edit';
    const mobileOrderDetails = shouldUseMobileOrderPagination() && mobileOrderPage === 'details';
    const mobileNotesMount = mobileProjectNotesOpen && mobileProjectNotesEnabled() ? $('#rMobileProjectNotesBody') : null;
    const target = mobileNotesMount || (mobileOrderDetails ? (mobileDetailMount || bottomMount) : mobileInline ? (mobileDetailMount || inlineMount) : bottomMount);
    if (notes.parentElement !== target) target.appendChild(notes);
    notes.closest('.r-left')?.classList.add('notes-panel-ready');
    if (agent) {
      const agentTarget = proposalEditMode && agentRailMount ? agentRailMount : bottomMount;
      if (agent.parentElement !== agentTarget) agentTarget.prepend(agent);
    }
    const proposalNotesMode = proposalTabActive;
    notes.classList.toggle('collapsed', proposalNotesMode && proposalInternalNotesCollapsed);
    const simpleNotes = notes.classList.contains('r-firstmeasure-notes');
    if (simpleNotes) notes.classList.toggle('notes-expanded', !proposalInternalNotesCollapsed);
    notes.querySelector('.r-bottom-notes-toggle')?.setAttribute('aria-expanded', (simpleNotes || proposalNotesMode) && !proposalInternalNotesCollapsed ? 'true' : 'false');
    if (simpleNotes) notes.querySelector('.r-bottom-notes-toggle')?.setAttribute('aria-label', proposalInternalNotesCollapsed ? 'Expand internal notes' : 'Reduce internal notes');
    notesRailSection?.classList.toggle('has-mounted', proposalEditMode && notes.parentElement === notesRailMount);
    agentRailSection?.classList.toggle('has-mounted', proposalEditMode && !!agent && agent.parentElement === agentRailMount);
    inlineMount.classList.toggle('has-notes', mobileInline);
    mobileDetailMount?.classList.toggle('has-notes', mobileInline);
    syncProposalAgentState();
    syncProposalBottomSendState();
    syncProjectNotesUi();
  }

  function updateModalTitle(){
    const titleWrap = document.querySelector('#rOverlay .r-title-wrap');
    const sub = document.querySelector('#rOverlay .r-sub');
    const mobileTitle = document.getElementById('rMobileProjectTitleText');
    if (!titleWrap || !sub) return;
    const mode = branchProjectConfig?.title_mode || 'customer_name';
    const address = projectText($('#rAddress')?.value, reportOrderState?.address, activeBaseProject?.address);
    const primary = primaryContact();
    const savedTitle = projectTitleAlias(activeBaseProject || {});
    const activeResident = activeBaseProject?.resident && typeof activeBaseProject.resident === 'object' ? activeBaseProject.resident : {};
    const activeCustomer = activeBaseProject?.customer && typeof activeBaseProject.customer === 'object' ? activeBaseProject.customer : {};
    const customerName = projectText(
      primary.name,
      activeBaseProject?.customer_name,
      activeBaseProject?.customerName,
      activeBaseProject?.primary_contact_name,
      activeBaseProject?.resident_name,
      activeBaseProject?.residentName,
      typeof activeBaseProject?.resident === 'string' ? activeBaseProject.resident : '',
      activeCustomer.name,
      activeResident.name
    );
    // Saved titles are manual overrides.  In the configured customer/address
    // modes, always derive the modal heading from the selected display rule.
    const computed = mode === 'manual'
      ? (savedTitle || customerName || address || 'New Project')
      : (mode === 'address'
        ? (address || customerName || 'New Project')
        : (customerName || address || 'New Project'));
    const mobileDisplayTitle = hasReportOrdered()
      ? (mode === 'manual' ? (savedTitle || computed || 'Project') : (computed || 'Project'))
      : (mode === 'manual' ? (savedTitle || computed || 'Project') : computed);
    if (mobileTitle) mobileTitle.textContent = mobileDisplayTitle;
    titleWrap.classList.toggle('manual-title', mode === 'manual' && !hasReportOrdered());
    if (hasReportOrdered()) {
      const orderedTitle = mode === 'manual'
        ? (savedTitle || computed || 'Project')
        : (computed || 'Project');
      titleWrap.innerHTML = `<div class="r-title">${escapeHtml(orderedTitle)}</div>`;
      sub.textContent = '';
      renderProjectStageBar();
      return;
    }
    if (mode === 'manual') {
      const current = projectText(document.getElementById('rProjectTitleInput')?.value, savedTitle);
      const placeholder = savedTitle ? 'Project title' : (computed || 'New Project');
      titleWrap.innerHTML = `<input id="rProjectTitleInput" class="r-title-input" value="${escapeHtml(current)}" placeholder="${escapeHtml(placeholder)}">`;
      const input = document.getElementById('rProjectTitleInput');
      input?.addEventListener('input', () => {
        if (activeBaseProject) {
          activeBaseProject.title = input.value.trim();
          activeBaseProject.project_title = activeBaseProject.title;
        }
        queueAutosaveNotice();
        persistActiveBaseProject();
      });
    } else {
      titleWrap.innerHTML = `<div class="r-title">${escapeHtml(computed)}</div>`;
    }
    sub.textContent = '';
    renderProjectStageBar();
  }

  function persistActiveBaseProject(){
    // Routed shells and contact hydration contain incomplete field values.
    // They must never overwrite the saved project while it is still loading.
    if (projectShellLoading || projectFormHydrating) return;
    if (!activeBaseProject && requestedWorkflow === 'contact') ensureContactOnlyBaseProject();
    if (!activeBaseProject && requestedWorkflow === 'document' && docPickerDismissed) ensureDocumentBaseProject();
    if (!activeBaseProject && addressSelected) ensureDraftBaseProject();
    if (!activeBaseProject || !window.Portal.ProjectStore) return;
    syncProjectPhotosFromLibrary();
    const currentPrimary = primaryContact();
    const projectContact = projectPrimaryContactAlias({
      ...activeBaseProject,
      contacts: collectContacts()
    });
    const customerName = projectText(currentPrimary.name, projectContact.name);
    const customerEmail = projectText(currentPrimary.email, projectContact.email);
    const customerPhone = projectText(currentPrimary.phone, projectContact.phone);
    const measurement = activeBaseProject.measurement_project || activeBaseProject.measurement || reportOrderState?.data?.measurement || {};
    const measurementProject = {
      ...measurement,
      include_gutters: reportOrderState?.includeGutters ?? measurement.include_gutters,
      include_instant: reportOrderState?.includeInspection ?? measurement.include_instant,
      include_weather_report: reportOrderState?.includeWeather ?? measurement.include_weather_report,
      weather_report_tier: measurement.weather_report_tier || 'history',
      weather_report_id: reportOrderState?.weatherReportId || measurement.weather_report_id || '',
      weather_report_pdf_url: reportOrderState?.weatherReportPdfUrl || measurement.weather_report_pdf_url || '',
      weather_report_status: measurement.weather_report_status || '',
      weather_report_error: measurement.weather_report_error || '',
      is_expedited: reportOrderState?.isExpedited ?? measurement.is_expedited,
      report_expedite_option: reportOrderState?.reportExpediteOption || measurement.report_expedite_option || '',
      report_expedite_label: reportOrderState?.reportExpediteLabel || measurement.report_expedite_label || '',
      report_due_window_start: reportOrderState?.reportDueWindowStart || measurement.report_due_window_start || '',
      report_due_window_end: reportOrderState?.reportDueWindowEnd || measurement.report_due_window_end || '',
      report_due_window_label: reportOrderState?.reportDueWindowLabel || measurement.report_due_window_label || '',
      report_production_deadline_at: reportOrderState?.reportProductionDeadlineAt || measurement.report_production_deadline_at || '',
      amount_charged: Number(reportOrderState?.amountCharged ?? measurement.amount_charged ?? 0) || 0,
      submitted_at: reportOrderState?.submittedAt || measurement.submitted_at || '',
      status: reportOrderState?.status || measurement.status || '',
    };
    const nextWorkflowState = reportOrderIsCancelled()
      ? 'measurement_cancelled'
      : (hasReportOrdered() ? 'measurement_ordered' : activeBaseProject.workflow_state);
    activeBaseProject = window.Portal.ProjectStore.save({
      ...activeBaseProject,
      title: manualProjectTitle() || projectTitleAlias(activeBaseProject) || '',
      project_title: manualProjectTitle() || projectTitleAlias(activeBaseProject) || '',
      address: ($('#rAddress')?.value || activeBaseProject.address || '').trim(),
      project_type: selectedType || activeBaseProject.project_type || 'residential',
      lat: ($('#rLat')?.value || activeBaseProject.lat || '').trim(),
      lng: ($('#rLng')?.value || activeBaseProject.lng || '').trim(),
      address_components: (() => { try { return JSON.parse($('#rComps')?.value || '{}'); } catch (e) { return activeBaseProject.address_components || {}; } })(),
      pins: getMarkersData(),
      contacts: collectContacts(),
      customer_name: customerName,
      primary_contact_name: customerName,
      customer_email: customerEmail,
      primary_contact_email: customerEmail,
      customer_phone: customerPhone,
      primary_contact_phone: customerPhone,
      project_notes: legacyProjectNotesText(),
      tech_notes: $('#rTechNotes')?.value ?? activeBaseProject?.tech_notes ?? '',
      cc_emails: $('#rCcList') ? collectCcEmails() : (activeBaseProject?.cc_emails || []),
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      workflow_state: nextWorkflowState,
      workflow_intent: hasReportOrdered() ? '' : requestedWorkflow,
      report_selection: hasReportOrdered() ? 'roof' : (reportSelection || ''),
      measurement: measurementProject,
      measurement_project: measurementProject,
      events: Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [],
      proposals
    });
  }

  function renderProjectCustomFields(){
    const mount = $('#rProjectCustomFields');
    if (!mount || !window.FirstMateCustomFields?.renderEditor) return null;
    const rendered = window.FirstMateCustomFields.renderEditor(mount, activeBaseProject || {}, 'project', {
      location:'overview',
      showSave:false,
      flat:true,
      fieldClass:'r-group',
      inputClass:'r-inp'
    });
    rendered?.then?.(() => renderProjectStageBar());
    return rendered;
  }

  function syncProjectCustomFieldValues(){
    const mount = $('#rProjectCustomFields');
    const runtime = window.FirstMateCustomFields;
    if (!activeBaseProject || !mount || !runtime?.editorValues || !runtime?.applyValues) return activeBaseProject;
    activeBaseProject = runtime.applyValues(
      activeBaseProject,
      'project',
      runtime.editorValues(mount, activeBaseProject, 'project')
    );
    return activeBaseProject;
  }

  function ensureDraftBaseProject(){
    if (activeBaseProject || !window.Portal.ProjectStore || !addressSelected) return activeBaseProject;
    activeBaseProject = window.Portal.ProjectStore.save({
      id: `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      title: manualProjectTitle(),
      address: ($('#rAddress')?.value || '').trim(),
      project_type: selectedType || 'residential',
      lat: ($('#rLat')?.value || '').trim(),
      lng: ($('#rLng')?.value || '').trim(),
      address_components: (() => { try { return JSON.parse($('#rComps')?.value || '{}'); } catch (e) { return {}; } })(),
      pins: getMarkersData(),
      contacts: collectContacts(),
      project_notes: legacyProjectNotesText(),
      workflow_state: 'draft',
      workflow_intent: requestedWorkflow,
      report_selection: reportSelection || '',
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      measurement: {},
      measurement_project: {},
      events: [],
      proposals,
      updated_at: new Date().toISOString()
    });
    viewingExistingProject = true;
    syncActiveProjectRoute({}, { history:'replace', source:'project-draft-create' });
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    return activeBaseProject;
  }

  function ensureContactOnlyBaseProject(){
    const contacts = collectContacts();
    if (activeBaseProject || !window.Portal.ProjectStore || !contacts.some(contactHasContent)) return activeBaseProject;
    const primary = primaryContact();
    const title = manualProjectTitle() || projectText(primary.name, primary.email, primary.phone, 'New Contact');
    activeBaseProject = window.Portal.ProjectStore.save({
      id: `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      title,
      project_title: title,
      address: '',
      project_type: selectedType || 'residential',
      contacts,
      customer_name: primary.name || '',
      primary_contact_name: primary.name || '',
      customer_email: primary.email || '',
      primary_contact_email: primary.email || '',
      customer_phone: primary.phone || '',
      primary_contact_phone: primary.phone || '',
      project_notes: legacyProjectNotesText(),
      workflow_state: 'contact_only',
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      measurement: {},
      measurement_project: {},
      events: [],
      proposals,
      updated_at: new Date().toISOString()
    });
    viewingExistingProject = true;
    syncActiveProjectRoute();
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    return activeBaseProject;
  }

  function ensureProposalOnlyBaseProject(){
    if (!window.Portal.ProjectStore) return null;
    if (activeBaseProject) {
      const workflow = String(activeBaseProject.workflow_state || '').trim().toLowerCase();
      if (!workflow || workflow === 'draft' || workflow === 'contact_only') activeBaseProject.workflow_state = 'proposal_only';
      activeBaseProject.has_meaningful_activity = true;
      activeBaseProject.last_activity_at = new Date().toISOString();
      persistActiveBaseProject();
      return activeBaseProject;
    }
    activeBaseProject = window.Portal.ProjectStore.save({
      id: `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      title: manualProjectTitle(),
      address: ($('#rAddress')?.value || '').trim(),
      project_type: selectedType || 'residential',
      contacts: collectContacts(),
      project_notes: legacyProjectNotesText(),
      tech_notes: $('#rTechNotes')?.value ?? activeBaseProject?.tech_notes ?? '',
      cc_emails: $('#rCcList') ? collectCcEmails() : (activeBaseProject?.cc_emails || []),
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      workflow_state: 'proposal_only',
      has_meaningful_activity: true,
      last_activity_at: new Date().toISOString(),
      measurement: {},
      measurement_project: {},
      events: [],
      proposals,
      updated_at: new Date().toISOString()
    });
    viewingExistingProject = true;
    syncActiveProjectRoute();
    return activeBaseProject;
  }

  // ------------------------------------------------ doc-first workflow (Docs)
  // "New Document"/"New <doc type>" from the global New button: the modal opens
  // on the unified Docs tab; with no base project the left column shows a
  // picker (attach to an existing project, or start a new one — mirroring the
  // legacy proposal_only shell), then the create wizard opens with the
  // requested type preselected.
  function ensureDocumentBaseProject(){
    if (!window.Portal.ProjectStore) return null;
    if (activeBaseProject) {
      const workflow = String(activeBaseProject.workflow_state || '').trim().toLowerCase();
      if (!workflow || workflow === 'draft' || workflow === 'contact_only') activeBaseProject.workflow_state = 'document_only';
      activeBaseProject.has_meaningful_activity = true;
      activeBaseProject.last_activity_at = new Date().toISOString();
      persistActiveBaseProject();
      return activeBaseProject;
    }
    activeBaseProject = window.Portal.ProjectStore.save({
      id: `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      title: manualProjectTitle(),
      address: ($('#rAddress')?.value || '').trim(),
      project_type: selectedType || 'residential',
      contacts: collectContacts(),
      project_notes: legacyProjectNotesText(),
      tech_notes: $('#rTechNotes')?.value ?? activeBaseProject?.tech_notes ?? '',
      cc_emails: $('#rCcList') ? collectCcEmails() : (activeBaseProject?.cc_emails || []),
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      workflow_state: 'document_only',
      has_meaningful_activity: true,
      last_activity_at: new Date().toISOString(),
      measurement: {},
      measurement_project: {},
      events: [],
      proposals,
      updated_at: new Date().toISOString()
    });
    viewingExistingProject = true;
    syncActiveProjectRoute();
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    return activeBaseProject;
  }

  async function launchDocumentCreate(options = {}){
    if (docCreateLaunched) return;
    docCreateLaunched = true;
    setActivePreviewTab('docs');
    const docsTab = window.Portal?.modules?.projectDocsTab;
    const opener = docsTab?.openNewDocumentInline || docsTab?.openNewDocument;
    if (!opener) return;
    // The engine mount fails closed while capability state is still loading —
    // retry briefly instead of leaving the flow dead on a fresh page.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        // The wizard renders INLINE in the modal's right panel (typed prefill
        // lands on the params step; generic opens the type selector) — never a
        // modal over the modal.
        const opened = await opener.call(docsTab,
          requestedDocumentType ? { document_type: requestedDocumentType } : {},
          { standalone: options.standalone === true }
        );
        if (opened) return;
      } catch (error) {
        console.warn('Document create wizard failed to open', error);
        return;
      }
      if (requestedWorkflow !== 'document') return;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  function beginDocumentWorkflow(){
    setActivePreviewTab('docs');
    if (activeBaseProject) {
      launchDocumentCreate();
      return;
    }
    // Resume an existing standalone draft (My Projects → Drafts): skip the
    // chooser, open the document in the editor with the compact left-column
    // picker available for attaching it to a project.
    if (requestedDocumentResume) {
      const record = requestedDocumentResume;
      requestedDocumentResume = null;
      docPickerChoiceMade = true;
      docCreateLaunched = true;
      syncDocWorkflowPicker();
      setTimeout(async () => {
        const docsTab = window.Portal?.modules?.projectDocsTab;
        const opened = await docsTab?.openEngineDocument?.(record, { standalone: true }).catch(() => false);
        if (!opened) showToast((globalThis.PlatformLanguage?.text("project-request","m_5d7c7ad6033624","Documents") ?? "Documents"), (globalThis.PlatformLanguage?.text("project-request","m_fbfab8434a3f39","Could not reopen this draft.") ?? "Could not reopen this draft."), false);
      }, 0);
      return;
    }
    // Standalone doc-first mode: only the Docs tab exists (projectModalApps
    // filter). The flow opens with a FULL-WIDTH chooser — pick a project,
    // start a new one, or continue without one — and only then slides into
    // the left column while the create wizard fills the right panel.
    syncDocWorkflowPicker();
  }

  /** The document workflow just gained a project (picked or created): remount
   *  the engine under it, attach the standalone doc being worked on, unlock
   *  the other tabs, and reopen the doc (or the wizard when none existed). */
  /** Snapshot of the standalone engine's documents, taken BEFORE any reopen or
   *  remount destroys the standalone instance. */
  function captureStandaloneDocState(){
    const docsTab = window.Portal?.modules?.projectDocsTab;
    return {
      document: docsTab?.currentEngineDoc?.() || null,
      documents: docsTab?.standaloneEngineDocs?.() || []
    };
  }

  async function continueDocWorkflowWithProject(capture = null){
    // A still-open standalone create wizard belongs to the engine instance
    // that is about to be remounted — close it; the wizard reopens under the
    // project when no document had been created yet.
    document.querySelector('.fmdx-modal-back')?.remove();
    setActivePreviewTab('docs');
    const docsTab = window.Portal?.modules?.projectDocsTab;
    let adopted = null;
    try {
      adopted = await docsTab?.adoptProject?.(capture || {});
    } catch (error) {
      console.warn('Document adopt-project handoff failed', error);
    }
    if (!adopted?.id) {
      docCreateLaunched = false;
      launchDocumentCreate();
    }
  }

  function docWorkflowStandaloneActive(){
    return requestedWorkflow === 'document' && !activeBaseProject && !viewingExistingProject;
  }

  function docWorkflowPickerActive(){
    return docWorkflowStandaloneActive() && !docPickerDismissed;
  }

  function removeDocWorkflowPicker(){
    document.querySelector('#rOverlay [data-doc-picker]')?.remove();
  }

  function syncDocWorkflowPicker(){
    if (!docWorkflowPickerActive()) {
      removeDocWorkflowPicker();
      return;
    }
    renderDocWorkflowPicker();
  }

  function docPickerProjectLabel(project = {}){
    return projectText(project.title, project.project_title, project.customer_name, project.address, 'Untitled project');
  }

  /** Choice-made transition, shared by all three picker choices: the
   *  full-width chooser slides into the left column, `applyContent` renders
   *  whatever belongs there next (project left column, new-project form, or
   *  the compact picker) BENEATH it, and the chooser cross-fades away.
   *  The element is unmarked first so resetNewProjectState()/open() can't
   *  remove it mid-animation. */
  function animateDocPickerHandoff(applyContent){
    const picker = document.querySelector('#rOverlay [data-doc-picker]');
    if (!picker) { applyContent?.(); return; }
    // Ghost the element: it is now pure animation chrome, owned by this timer.
    picker.removeAttribute('data-doc-picker');
    picker.dataset.docPickerGhost = '';
    const fadeAway = () => {
      try { applyContent?.(); } catch (error) { console.warn('Doc picker handoff failed', error); }
      picker.style.transition = 'opacity .26s ease';
      picker.style.opacity = '0';
      setTimeout(() => picker.remove(), 300);
    };
    const left = document.querySelector('#rOverlay .r-left');
    const winRect = picker.parentElement?.getBoundingClientRect?.();
    const leftRect = left?.getBoundingClientRect?.();
    if (picker.dataset.docPickerMode !== 'full' || !winRect || !leftRect?.width) {
      fadeAway();
      return;
    }
    picker.style.transition = 'width .32s ease';
    picker.style.width = `${Math.max(120, Math.round(leftRect.right - winRect.left))}px`;
    picker.style.overflow = 'hidden';
    setTimeout(fadeAway, 340);
  }

  function renderDocWorkflowPicker(){
    injectCSS('request_doc_picker', `
      .r-doc-picker{position:absolute;inset:0;z-index:60;display:flex;flex-direction:column;gap:12px;background:#fff;padding:18px 16px;box-sizing:border-box;overflow:hidden}
      .r-doc-picker[data-doc-picker-mode="full"]{z-index:80;left:0;top:0;bottom:0;right:auto;width:100%;padding:34px 24px 24px;align-items:center}
      .r-doc-picker[data-doc-picker-mode="full"] .r-doc-picker-inner{width:min(560px,100%);flex:1;min-height:0;display:flex;flex-direction:column;gap:14px}
      .r-doc-picker .r-doc-picker-inner{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;width:100%}
      .r-doc-picker-head strong{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:1000;color:#101828}
      .r-doc-picker[data-doc-picker-mode="full"] .r-doc-picker-head strong{font-size:19px;justify-content:center}
      .r-doc-picker-head span{display:block;margin-top:4px;font-size:12px;font-weight:800;color:#667085}
      .r-doc-picker[data-doc-picker-mode="full"] .r-doc-picker-head{text-align:center}
      .r-doc-picker-search{display:flex;align-items:center;gap:8px;border:1px solid #e4e7ec;border-radius:10px;background:#f9fafb;padding:0 10px;height:38px;color:#98a2b3;flex:0 0 auto}
      .r-doc-picker-search input{flex:1;border:0;background:transparent;font:inherit;font-size:13px;font-weight:800;color:#101828;outline:none}
      .r-doc-picker-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
      .r-doc-picker-row{border:1px solid #e4e7ec;border-radius:10px;background:#fff;padding:9px 11px;text-align:left;cursor:pointer;font:inherit}
      .r-doc-picker-row:hover{border-color:rgba(var(--primary-rgb,217,48,37),.4);background:rgba(var(--primary-rgb,217,48,37),.04)}
      .r-doc-picker-row strong{display:block;font-size:13px;font-weight:1000;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .r-doc-picker-row em{display:block;margin-top:2px;font-style:normal;font-size:11px;font-weight:800;color:#667085;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .r-doc-picker-empty{padding:18px 8px;text-align:center;color:#667085;font-size:12px;font-weight:800}
      .r-doc-picker-foot{border-top:1px solid #eaecf0;padding-top:12px;display:flex;flex-direction:column;gap:8px;flex:0 0 auto}
      .r-doc-picker-new{width:100%;height:40px;border:0;border-radius:10px;background:var(--primary,#d93025);color:#fff;font:inherit;font-size:13px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}
      .r-doc-picker-new:hover{filter:brightness(.95)}
      .r-doc-picker-skip{width:100%;height:40px;border:1px solid #e4e7ec;border-radius:10px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:1000;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px}
      .r-doc-picker-skip:hover{border-color:#98a2b3}
    `);
    removeDocWorkflowPicker();
    const mode = docPickerChoiceMade ? 'left' : 'full';
    const container = mode === 'full'
      ? document.querySelector('#rOverlay .r-win')
      : document.querySelector('#rOverlay .r-left');
    if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const typeLabel = requestedDocumentType
      ? requestedDocumentType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'Document';
    const picker = document.createElement('div');
    picker.dataset.docPicker = '';
    picker.dataset.docPickerMode = mode;
    picker.className = 'r-doc-picker';
    picker.innerHTML = `
      <div class="r-doc-picker-inner">
        <div class="r-doc-picker-head">
          <strong><i class="fas fa-file-medical"></i>${((v0) => globalThis.PlatformLanguage?.text("project-request","m_e67e48daacbe10",` New ${v0}`,{v0}) ?? ` New ${v0}`)(escapeHtml(typeLabel))}</strong>
          <span>${(globalThis.PlatformLanguage?.text("project-request","m_97c5ddb47fa1ff","Select a project for this document.") ?? "Select a project for this document.")}</span>
        </div>
        <label class="r-doc-picker-search"><i class="fas fa-search"></i><input type="search" placeholder="${(globalThis.PlatformLanguage?.text("project-request","m_af80d9cead6991","Search projects") ?? "Search projects")}" data-doc-picker-search></label>
        <div class="r-doc-picker-list" data-doc-picker-list><div class="r-doc-picker-empty">${(globalThis.PlatformLanguage?.text("project-request","m_63e5f4717baad3","Loading projects…") ?? "Loading projects…")}</div></div>
        <div class="r-doc-picker-foot">
          <button type="button" class="r-doc-picker-new" data-doc-picker-new><i class="fas fa-folder-plus"></i>${(globalThis.PlatformLanguage?.text("project-request","m_1014630484dad8"," Start a new project") ?? " Start a new project")}</button>
          ${String(mode === 'full' ? `<button type="button" class="r-doc-picker-skip" data-doc-picker-skip><i class="fas fa-file-medical"></i> Create without a project</button>` : '')}
        </div>
      </div>`;
    container.appendChild(picker);
    const input = picker.querySelector('[data-doc-picker-search]');
    const list = picker.querySelector('[data-doc-picker-list]');
    const renderList = () => {
      if (!picker.isConnected) return;
      const rows = docPickerRowsCache.rows || [];
      const query = String(input?.value || '').trim().toLowerCase();
      const matches = (query ? rows.filter((row) => row.search.includes(query)) : rows).slice(0, 30);
      list.innerHTML = matches.length
        ? matches.map((row) => `
          <button type="button" class="r-doc-picker-row" data-doc-picker-project="${escapeHtml(row.id)}">
            <strong>${escapeHtml(row.label)}</strong>
            ${row.address ? `<em>${escapeHtml(row.address)}</em>` : ''}
          </button>`).join('')
        : `<div class="r-doc-picker-empty">${docPickerRowsCache.rows
          ? (query ? 'No projects match your search.' : 'No projects yet — start a new one below.')
          : 'Loading projects…'}</div>`;
      list.querySelectorAll('[data-doc-picker-project]').forEach((button) => button.addEventListener('click', () => {
        const row = rows.find((entry) => entry.id === button.dataset.docPickerProject);
        if (!row) return;
        const documentType = requestedDocumentType;
        docPickerChoiceMade = true;
        // Cache ONLY the selected project (a full-list cache pass serializes
        // the whole store per project and freezes the page on large orgs).
        const project = window.Portal?.ProjectStore?.cache?.({ ...row.data, id: row.data?.id || row.id }) || { ...row.data, id: row.id };
        // Capture the standalone documents BEFORE reopening — the reopen
        // remounts the docs tab and its embedded engine.
        const capture = captureStandaloneDocState();
        // Slide into the left column, hydrate the project beneath, cross-fade.
        animateDocPickerHandoff(() => {
          open(project, { tab: 'docs' });
          requestedDocumentType = documentType;
          docCreateLaunched = true;
          setTimeout(() => continueDocWorkflowWithProject(capture), 0);
        });
      }));
    };
    let searchDebounce = 0;
    input?.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderList, 120);
    });
    picker.querySelector('[data-doc-picker-new]')?.addEventListener('click', () => {
      const capture = captureStandaloneDocState();
      docPickerChoiceMade = true;
      docPickerDismissed = true;
      // Slide into the left column, reveal the new-project form beneath.
      animateDocPickerHandoff(() => {
        ensureDocumentBaseProject();
        setTimeout(() => continueDocWorkflowWithProject(capture), 0);
        setTimeout(() => document.querySelector('#rContactList [data-field="name"]')?.focus(), 60);
      });
    });
    // "Create without a project": the chooser slides into the left column and
    // cross-fades into the compact picker (still there for attaching later)
    // while the create wizard fills the right panel with a standalone doc.
    picker.querySelector('[data-doc-picker-skip]')?.addEventListener('click', () => {
      docPickerChoiceMade = true;
      animateDocPickerHandoff(() => {
        renderDocWorkflowPicker();
        launchDocumentCreate({ standalone: true });
      });
    });
    renderList();
    loadDocPickerRows().then(renderList).catch(() => renderList());
  }

  /** Lightweight picker rows, fetched ONCE per session and NEVER written into
   *  the ProjectStore (bulk-caching serializes the entire store per project —
   *  that froze the browser on orgs with many projects). Each row keeps a
   *  reference to the raw project data for the eventual selection. */
  const docPickerRowsCache = { orgId: '', rows: null, promise: null };
  window.addEventListener('fm:projects:refresh', () => { docPickerRowsCache.rows = null; });
  function loadDocPickerRows(){
    const orgId = String(window.__APP?.userOrgId || window.__APP?.orgId || '').trim();
    if (!orgId || !window.PlatformAPI?.projects?.list) return Promise.resolve([]);
    if (docPickerRowsCache.orgId === orgId && docPickerRowsCache.rows) return Promise.resolve(docPickerRowsCache.rows);
    if (docPickerRowsCache.orgId === orgId && docPickerRowsCache.promise) return docPickerRowsCache.promise;
    docPickerRowsCache.orgId = orgId;
    docPickerRowsCache.rows = null;
    docPickerRowsCache.promise = window.PlatformAPI.projects.list(orgId).then((result) => {
      const seen = new Set();
      const rows = [];
      (result?.documents || result?.projects || []).forEach((doc) => {
        const data = doc?.data || doc?.project || doc?.document?.data || doc;
        const id = projectText(data?.platform_project_id, data?.base_project_id, data?.id, doc?.id);
        if (!id || seen.has(id)) return;
        seen.add(id);
        const label = docPickerProjectLabel(data);
        const address = projectText(data?.address);
        rows.push({
          id,
          label,
          address,
          updated_at: String(data?.updated_at || ''),
          search: `${label} ${address} ${projectText(data?.customer_name)}`.toLowerCase(),
          data
        });
      });
      rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      docPickerRowsCache.rows = rows;
      docPickerRowsCache.promise = null;
      return rows;
    }).catch((error) => {
      console.warn('Project picker list failed', error);
      docPickerRowsCache.rows = [];
      docPickerRowsCache.promise = null;
      return [];
    });
    return docPickerRowsCache.promise;
  }

  function contactHasContent(contact = {}){
    return !!projectText(contact?.name, contact?.phone, contact?.email, contact?.address, contact?.default_address);
  }

  function isEmptyNewProjectDraft(){
    if (viewingExistingProject || hasReportOrdered() || addressSelected || locationConfirmed) return false;
    if (reportSelection || includeGutterMeasurements || includeWeatherReport || includeInstantPreview) return false;
    if (projectPhotos.length || proposals.length || pinCount()) return false;
    if (($('#rProjectNotes')?.value || '').trim() || ($('#rTechNotes')?.value || '').trim()) return false;
    if (collectContacts().some(contactHasContent)) return false;
    if (collectCcEmails().length) return false;
    const createdIds = currentModalCreatedProjectIds();
    return !!activeBaseProject || !!($('#rAddress')?.value || '').trim() || createdIds.length > 0;
  }

  function currentModalCreatedProjectIds(){
    const ids = window.Portal.ProjectStore?.cachedIds?.() || [];
    return ids.filter((id) => !modalInitialProjectIds.has(String(id)));
  }

  function discardEmptyNewProjectDraft(){
    if (!isEmptyNewProjectDraft()) return false;
    clearTimeout(autosaveDebounceTimer);
    const ids = new Set(currentModalCreatedProjectIds());
    if (activeBaseProject?.id) ids.add(activeBaseProject.id);
    ids.forEach((id) => {
      window.Portal.ProjectStore?.remove?.(id);
      window.Portal.ProjectStore?.removeRemote?.(id)
        .catch((error) => console.warn('Empty project discard failed', error))
        .finally(() => window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } })));
    });
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    activeBaseProject = null;
    return true;
  }

  function scrollOrderedSidebarIntoPosition(){
    const scroller = document.querySelector('#rOverlay .r-scroll');
    if (!scroller) return;
    requestAnimationFrame(() => {
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  function setProjectionMode(on){
    const overlay = $('#rOverlay');
    overlay?.classList.toggle('report-ordered', !!on);
    const card = $('#rProjectionCard');
    if (card && hasReportOrdered()) {
      if (reportOrderIsCancelled()) {
        card.innerHTML = `<strong>${(globalThis.PlatformLanguage?.text("project-request","m_aad3492084d297","Report canceled") ?? "Report canceled")}</strong>This report order was canceled. You can reorder it from the Reports tab.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      if (reportOrderIsRejected()) {
        card.innerHTML = `<strong>${(globalThis.PlatformLanguage?.text("project-request","m_279b64bc569e57","Report rejected") ?? "Report rejected")}</strong>This report order was rejected. You can review it from the Reports tab.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      if (reportOrderIsStaleSubmitted()) {
        card.innerHTML = `<strong>${(globalThis.PlatformLanguage?.text("project-request","m_539bb91daa77d5","Report not active") ?? "Report not active")}</strong>This report order stalled before processing. You can reorder it from the Reports tab.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      if (!reportOrderIsActivelyPending() && !reportOrderIsCompleteLike()) {
        card.innerHTML = `<strong>${(globalThis.PlatformLanguage?.text("project-request","m_539bb91daa77d5","Report not active") ?? "Report not active")}</strong>This project does not have an active report order.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      const stage = reportOrderPendingStage();
      const cardTitle = stage === 'processing' ? 'Report in progress' : (stage === 'review' ? 'Report in review' : 'Report pending');
      const cardBody = stage === 'processing'
        ? 'The standard report is currently being worked.'
        : (stage === 'review' ? 'The standard report is being reviewed.' : 'The standard report is pending.');
      const addOns = [];
      if (reportOrderState.includeGutters) addOns.push('gutters');
      if (reportOrderState.includeWeather) addOns.push('weather');
      if (reportOrderState.includeInspection) addOns.push('instant');
      const dueText = reportOrderCustomerDeliveryText();
      const due = dueText
        ? ` Target: ${escapeHtml(dueText)}.`
        : '';
      card.innerHTML = `<strong>${escapeHtml(cardTitle)}</strong>${escapeHtml(cardBody)}${addOns.length ? ` Includes ${escapeHtml(addOns.join(' and '))}.` : ''}${due}`;
    } else if (card) {
      card.innerHTML = '';
    }
    renderProjectViewerSummary();
    updateModalTitle();
  }

  function enterReportOrderedMode(data, payload){
    reportOrderState = {
      ordered: true,
      data: data || {},
      payload: payload || {},
      address: payload?.address || '',
      includeInspection: payload?.report_mode === 'both',
      includeGutters: payload?.include_gutter_measurements === '1' || payload?.include_gutter_measurements === true,
      includeWeather: payload?.include_weather_report === '1' || payload?.include_weather_report === true,
      weatherReportId: data?.manifest?.weather_report_id || data?.project?.weather_report_id || '',
      weatherReportPdfUrl: data?.manifest?.weather_report_pdf_url || data?.project?.weather_report_pdf_url || '',
      isExpedited: payload?.is_expedited === '1' || payload?.is_expedited === true,
      reportExpediteOption: payload?.report_expedite_option || '',
      reportExpediteLabel: payload?.report_expedite_label || '',
      reportDueWindowStart: payload?.report_due_window_start || '',
      reportDueWindowEnd: payload?.report_due_window_end || '',
      reportDueWindowLabel: payload?.report_due_window_label || '',
      reportProductionDeadlineAt: payload?.report_production_deadline_at || data?.manifest?.report_production_deadline_at || data?.project?.report_production_deadline_at || '',
      amountCharged: Number(data?.manifest?.amount_charged ?? data?.project?.amount_charged ?? payload?.report_expedite_net_total_price ?? 0) || 0,
      expediteRefundStatus: data?.manifest?.report_expedite_refund_status || data?.project?.report_expedite_refund_status || '',
      expediteRefundAmount: Number(data?.manifest?.report_expedite_refund_amount ?? data?.project?.report_expedite_refund_amount ?? 0) || 0,
      expediteRefundAt: data?.manifest?.report_expedite_refund_at || data?.project?.report_expedite_refund_at || '',
      expediteRefundMessage: data?.manifest?.report_expedite_refund_message || data?.project?.report_expedite_refund_message || '',
      submittedAt: data?.project?.created_at || data?.manifest?.created_at || new Date().toISOString(),
      hasReadyReport: false,
    };
    activeBaseProject = window.Portal.ProjectStore?.fromQueue?.(payload, data) || null;
    if (activeBaseProject) activeBaseProject.events = Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [];
    if (activeBaseProject) syncProjectPhotosFromLibrary();
    setProjectionMode(true);
    refreshProjectModalAppsForOrderTransition();
    setActiveMeasurementTab(reportOrderState.includeInspection ? 'instant' : 'standard');
    projectViewer?.setActiveTab('measurements');
    renderMeasurementsPanel();
    refreshProjectModalAppsForOrderTransition('measurements');
    renderWorkflowState();
    persistActiveBaseProject();
    scrollOrderedSidebarIntoPosition();
  }

  function renderWorkflowState(options = {}){
    // The field/Crew project shell intentionally has no FirstMeasure left-region
    // workflow. Keep shell presentation current without running renderers that
    // target controls supplied exclusively by that optional region app.
    if (!$('#rForm')) {
      applyProjectModalPresentation();
      return;
    }
    // A deep-linked modal paints its chrome before the project request returns.
    // Do not let workflow renderers fan out into project-specific requests until
    // the base record has hydrated; the requested tab and chrome are already live.
    if (projectShellLoading) {
      updateModalTitle();
      syncProjectViewerTabs();
      applyProjectModalPresentation();
      return;
    }
    if (workflowRenderInProgress) return;
    const now = Date.now();
    if (now - workflowRenderLastAt < 32) {
      if (!workflowRenderScheduled) {
        workflowRenderScheduled = true;
        requestAnimationFrame(() => {
          workflowRenderScheduled = false;
          renderWorkflowState(options);
        });
      }
      return;
    }
    workflowRenderLastAt = now;
    workflowRenderInProgress = true;
    try {
      renderWorkflowStateBody(options);
    } finally {
      workflowRenderInProgress = false;
    }
  }

  function renderWorkflowStateBody(options = {}){
    const preserveRouteTab = options.preserveRouteTab === true;
    normalizeReportSelection();
    if (shouldLockReportOrderingWorkflow()) {
      reportSelection = 'roof';
      if (!preserveRouteTab && !window.Portal.ExteriorOrder?.active() && !hasReportOrdered() && activePreviewTab !== 'map') setActivePreviewTab('map');
    }
    if (shouldUseMobileOrderPagination()) {
      reportSelection = 'roof';
      if (!preserveRouteTab && !window.Portal.ExteriorOrder?.active()) setActivePreviewTab('map');
    }
    const hasAddress = !!(($('#rAddress')?.value || '').trim());
    const mobileOrder = shouldUseMobileOrderPagination();
    const typeReady = mobileOrder ? addressSelected : addressSelected || hasAddress;
    const reportReady = addressSelected && !!selectedType;
    const customerOpen = true;
    const existingProjectSession = !newProjectCreationSession;
    let availableActions = availableProjectActions();
    if (workflowWantsAction() && autoSelectOnlyAction(availableActions)) availableActions = availableProjectActions();
    const roofNeedsPins = hasSelectedAddons();
    const hasAvailableActions = availableActions.length > 0;
    const reportCondensed = roofDecisionMade();
    const roofCondensed = false;

    setStepState('#rStepAddress', true, addressSelected ? 'complete' : 'active', false);
    setStepState('#rStepType', typeReady && (!existingProjectSession || (requestedWorkflow === 'report' && !hasReportOrdered())), selectedType ? 'complete' : (typeReady ? 'active' : 'locked'), !!selectedType && (!mobileOrder || !typePickerExpanded), { hidePrices: isProposalChoice() || isScheduleChoice() });
    $('#rStepType')?.classList.toggle('is-type-collapsing', mobileOrder && mobileTypeTransitioning);
    const mobileReportOpen = mobileOrder && addressSelected && !!selectedType && !mobileTypeTransitioning;
    const explicitActionWorkflow = !['project', 'contact'].includes(requestedWorkflow);
    setStepState('#rStepReport', mobileOrder ? mobileReportOpen : (explicitActionWorkflow && reportReady && hasAvailableActions), roofDecisionMade() ? 'complete' : (reportReady ? 'active' : 'locked'), mobileOrder ? false : reportCondensed, { hideHeadWhenCondensed: true });
    const roofChoice = $('#rMobileRoofChoice');
    if (roofChoice) roofChoice.hidden = !mobileOrder || !mobileReportOpen || !!window.Portal.ExteriorOrder?.offersChoice?.(selectedType) || mobileRoofOnlyChosen;
    $('#rOverlay')?.classList.toggle('mobile-scope-pending', mobileOrder && !mobileOrderScopeReady());
    setStepState('#rStepRoof', reportReady && roofNeedsPins, roofNeedsPins ? (locationConfirmed ? 'complete' : 'active') : 'locked', roofCondensed);
    setStepState('#rStepCustomer', customerOpen, customerOpen ? 'active' : 'locked', false);

    const roofFields = $('#rRoofReportFields');
    const roofSkip = $('#rRoofSkipSummary');
    if (roofFields) roofFields.style.display = roofNeedsPins ? '' : 'none';
    if (roofSkip) roofSkip.style.display = isProposalChoice() ? '' : 'none';
    if (!preserveRouteTab && !validPreviewTabs().includes(activePreviewTab)) setActivePreviewTab(projectDefaultPreviewTab());

    const reportSummary = $('#rReportSummary');
    const roofSummary = $('#rRoofSummary');
    const roofOnlySub = $('#rRoofOnlySub');
    if (roofOnlySub) roofOnlySub.textContent = roofOnlyPriceLabel();
    if (reportSummary) {
      const addOns = [];
      if (hasGutterAddon()) addOns.push('gutters');
      if (hasWeatherAddon()) addOns.push('weather');
      if (includeInstantPreview && hasSelectedAddons()) addOns.push('instant report');
      const expedite = hasSelectedAddons() ? selectedReportExpediteOption() : null;
      if (expedite && expedite.key !== 'no_rush') addOns.push(expedite.label);
      reportSummary.textContent = reportSelection === 'roof'
        ? `Order report${addOns.length ? ` + ${addOns.join(' + ')}` : ''}`
        : isProposalChoice()
          ? 'Build proposal'
          : isScheduleChoice()
            ? 'Schedule appointment'
          : '';
    }
    if (roofSummary) {
      roofSummary.textContent = locationConfirmed
        ? (pinCount() === 1 ? '1 structure confirmed' : `${pinCount()} structures confirmed`)
        : '';
    }

    document.querySelectorAll('.customer-report-tip .r-info-tip').forEach((tip) => {
      tip.classList.toggle('is-hidden', !hasSelectedAddons());
    });

    syncLeftColumnOverride();
    restoreDefaultLeftColumnState();
    renderTypeSelection();
    renderRoofChoice();
    renderProjectTodoDock();
    renderAfterHoursNotice();
    renderProposalSection();
    syncProjectNotesPlacement();
    renderPinInfo();
    renderConfirm();
    updateSubmitLabel();
    renderSigningOverlay();
    setProjectionMode(hasReportOrdered());
    if (hasReportOrdered()) renderMeasurementsPanel();
    if (activePreviewTab === 'schedule' && schedulePreviewAvailable()) renderSchedulePanel();
    updateModalTitle();
    syncProjectViewerTabs();
    renderCustomerPortalLink();
    syncMobileOrderPagination();
    syncOverviewMapMode();

    if (proposalSigningMode && proposalsEnabled()) {
      renderProposalPreview();
    } else if (activePreviewTab === 'proposal' && proposalsEnabled()) {
      renderProposalPreview();
    } else if (!preserveRouteTab && isScheduleChoice() && schedulePreviewAvailable() && activePreviewTab !== 'schedule') {
      setActivePreviewTab('schedule');
    } else if (!preserveRouteTab && !proposalWorkspaceOpen && isProposalChoice() && proposalsEnabled() && customerOpen) {
      setActivePreviewTab(projectDefaultPreviewTab());
    } else if (!preserveRouteTab && hasReportOrdered() && !validPreviewTabs().includes(activePreviewTab)) {
      setActivePreviewTab('measurements');
    } else if (!preserveRouteTab && !window.Portal.ExteriorOrder?.active() && hasSelectedAddons() && !hasReportOrdered() && activePreviewTab !== 'map' && !(activePreviewTab === 'schedule' && schedulePreviewAvailable())) {
      setActivePreviewTab('map');
    }
    syncReportExpediteMinuteRefresh();
    window.Portal.ExteriorOrder?.sync({type:selectedType,count:pinCount(),pins:getMarkersData(),showMap:()=>setActivePreviewTab('map'),showPhotos:()=>setActivePreviewTab('photos'),syncPhotoTabs:()=>syncProjectViewerTabs(),updateMobilePager:()=>syncMobileOrderPagination(),locationConfirmed,closed:reportOrderingClosed(),setPinConfirmed:value=>{locationConfirmed=!!value;renderConfirm();},getNotes:()=>$('#rTechNotes')?.value||'',setNotes:value=>{if($('#rTechNotes'))$('#rTechNotes').value=value;},getCc:()=>collectCcEmails(),getContacts:()=>collectContacts(),getAddress:()=>($('#rAddress')?.value||'').trim(),getTypeLabel:()=>TYPE_META[selectedType]?.label||selectedType,getInternalNotes:()=>($('#rProjectNotes')?.value||'').trim()||legacyProjectNotesText(),showInfo:key=>showAddonInfoModal(key),hoverInfo:element=>showAddonInfoPopout(element),hideInfo:()=>hideAddonInfoPopout(120),ordered:hasReportOrdered(),orderWorkflow:requestedWorkflow==='report',mobileOrder,addressSelected,typeTransitioning:mobileTypeTransitioning,refresh:()=>renderWorkflowState(),submit:()=>onSubmit({preventDefault(){}})});
    if (mobileOrder) renderConfirm();
  }

  function revealInLeftColumnIfBelow(target, options = {}){
    const scroller = document.querySelector('#rOverlay .r-scroll');
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!scroller || !el) return;
    requestAnimationFrame(() => {
      const scrollerRect = scroller.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (!elRect.height || elRect.top < scrollerRect.top || elRect.bottom <= scrollerRect.bottom - 12) return;
      const offset = Number(options.offset ?? 10);
      const desiredTop = scroller.scrollTop + (elRect.top - scrollerRect.top) - offset;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextTop = Math.min(maxTop, Math.max(0, desiredTop));
      if (nextTop > scroller.scrollTop + 4) scroller.scrollTo({ top: nextTop, behavior: 'smooth' });
    });
  }

  function scrollReportControlsToTop(){
    if (shouldUseMobileOrderPagination()) return;
    const scroller = document.querySelector('#rOverlay .r-scroll');
    const target = window.Portal.ExteriorOrder?.active()
      ? document.querySelector('#rExteriorOrder .ext-delivery-heading')
      : document.querySelector('#rRoofReportFields .r-addon-toggle.visible')
      || document.querySelector('#rExpeditePanel.visible')
      || document.querySelector('#rSubmit');
    if (!scroller || !target) return;
    requestAnimationFrame(() => {
      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      if (!targetRect.height) return;
      const desiredTop = scroller.scrollTop + (targetRect.top - scrollerRect.top) - 10;
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTo({ top: Math.min(maxTop, Math.max(0, desiredTop)), behavior: 'smooth' });
    });
  }

  function revealProposalSection(){
    const scrollWrap = document.querySelector('#rOverlay .r-scroll');
    const section = $('#rProposalSection');
    if (!scrollWrap || !section) return;
    const top = Math.max(0, section.offsetTop - 14);
    scrollWrap.scrollTo({ top, behavior: 'smooth' });
  }

  function getAfterHoursMessage(){
    const now = new Date();
    const pacificStr = now.toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { timeZone: 'America/Los_Angeles' });
    const pacific = new Date(pacificStr);
    const hour = pacific.getHours();
    if (hour >= 20) {
      return 'We are currently closed for the evening. Roof reports placed now will be processed first thing tomorrow morning.';
    }
    return null;
  }

  function renderAfterHoursNotice(){
    const ahMsg = (hasSelectedAddons() || window.Portal.ExteriorOrder?.active()) ? getAfterHoursMessage()?.replace(/Roof reports/g, 'Reports') : null;
    const message = $('#rAfterHoursMsg');
    const notice = $('#rAfterHours');
    if (!message || !notice) return;
    message.textContent = ahMsg || '';
    notice.classList.toggle('visible', !!ahMsg);
  }

  function bindProjectModalCloseControls(){
    const overlay = $('#rOverlay');
    const closeX = $('#rMapCloseX');
    if (closeX && !closeX.__fmCloseBound) {
      closeX.__fmCloseBound = true;
      closeX.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(); });
    }
    const fullscreenToggle = $('#rFullscreenToggle');
    if (fullscreenToggle && !fullscreenToggle.__fmFullscreenBound) {
      fullscreenToggle.__fmFullscreenBound = true;
      fullscreenToggle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleProjectModalFullscreen(); });
    }
    const mobileClose = $('#rMobileClose');
    if (mobileClose && !mobileClose.__fmCloseBound) {
      mobileClose.__fmCloseBound = true;
      mobileClose.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(); });
    }
    const leftTrayToggle = $('#rMobileLeftTrayToggle');
    if (leftTrayToggle && !leftTrayToggle.__fmLeftTrayBound) {
      leftTrayToggle.__fmLeftTrayBound = true;
      leftTrayToggle.addEventListener('click', () => setMobileLeftTrayOpen(!mobileLeftTrayOpen));
    }
    const leftTrayScrim = $('#rMobileLeftTrayScrim');
    if (leftTrayScrim && !leftTrayScrim.__fmLeftTrayBound) {
      leftTrayScrim.__fmLeftTrayBound = true;
      leftTrayScrim.addEventListener('click', () => setMobileLeftTrayOpen(false));
    }
    const defaultInfoToggle = $('#rMobileProjectInfoToggle');
    if (defaultInfoToggle && !defaultInfoToggle.__fmDefaultInfoBound) {
      defaultInfoToggle.__fmDefaultInfoBound = true;
      defaultInfoToggle.addEventListener('click', () => setMobileDefaultInfoTrayOpen(!mobileDefaultInfoTrayOpen));
    }
    const defaultInfoScrim = $('#rMobileDefaultInfoTrayScrim');
    if (defaultInfoScrim && !defaultInfoScrim.__fmDefaultInfoBound) {
      defaultInfoScrim.__fmDefaultInfoBound = true;
      defaultInfoScrim.addEventListener('click', () => setMobileDefaultInfoTrayOpen(false));
    }
    const mobileNotesLauncher = $('#rMobileProjectNotesLauncher');
    if (mobileNotesLauncher && !mobileNotesLauncher.__fmMobileNotesBound) {
      mobileNotesLauncher.__fmMobileNotesBound = true;
      mobileNotesLauncher.addEventListener('click', () => setMobileProjectNotesOpen(true));
    }
    const mobileNotesClose = $('#rMobileProjectNotesClose');
    if (mobileNotesClose && !mobileNotesClose.__fmMobileNotesBound) {
      mobileNotesClose.__fmMobileNotesBound = true;
      mobileNotesClose.addEventListener('click', () => setMobileProjectNotesOpen(false));
    }
    const mobileNotesScrim = $('#rMobileProjectNotesScrim');
    if (mobileNotesScrim && !mobileNotesScrim.__fmMobileNotesBound) {
      mobileNotesScrim.__fmMobileNotesBound = true;
      mobileNotesScrim.addEventListener('click', () => setMobileProjectNotesOpen(false));
    }
    const cancel = $('#rCancel');
    if (cancel && !cancel.__fmCloseBound) {
      cancel.__fmCloseBound = true;
      cancel.addEventListener('click', handleBackOrClose);
    }
    if (overlay && !overlay.__fmBackdropCloseBound) {
      overlay.__fmBackdropCloseBound = true;
      overlay.addEventListener('mousedown', (e) => { overlay.__downBackdrop = (e.target === overlay); });
      overlay.addEventListener('mouseup', (e) => { if (overlay.__downBackdrop && e.target === overlay) close(); overlay.__downBackdrop = false; });
    }
  }

  function ensureUI(){
    if (document.getElementById('rOverlay')) return;
    injectCSS('request', css);

    const el = document.createElement('div');
    el.className = 'r-overlay';
    el.id = 'rOverlay';
    el.innerHTML = `
      <div class="r-win">
        <div class="r-contact-contextbar" id="rContactContextBar"></div>
        ${String(projectModalRegionHtml('left'))}

        <div class="r-right" id="rMapWrap">
          <div class="r-modal-header">
            <div class="r-tabbar" id="rProjectViewerTabs"></div>
            <div class="modal-shell-actions">
              <button type="button" class="modal-shell-action" id="rProjectHeaderAction" hidden></button>
              <button type="button" class="modal-shell-btn" id="rFullscreenToggle" data-fm-tooltip="Fullscreen" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_0ce034af23e970","Open project fullscreen") ?? "Open project fullscreen")}"><i class="fas fa-up-right-and-down-left-from-center"></i></button>
              <button type="button" class="modal-shell-btn" id="rMapCloseX" data-fm-tooltip="Close" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
            </div>
          </div>
          <div class="r-mobile-project-title" data-project-identity-owner="modal-chrome">
            <button type="button" class="r-mobile-left-tray-toggle" id="rMobileLeftTrayToggle" aria-expanded="false"><i class="fas fa-chevron-right" id="rMobileLeftTrayChevron" aria-hidden="true"></i><span id="rMobileLeftTrayTitle"></span></button>
            <span class="r-mobile-project-tab-title"><i class="fas" id="rMobileProjectTabIcon" aria-hidden="true" hidden></i><span id="rMobileProjectTabTitle"></span></span>
            <button type="button" class="r-mobile-project-header-action" id="rMobileProjectHeaderAction" hidden></button>
            <button type="button" class="r-mobile-project-info-toggle" id="rMobileProjectInfoToggle" aria-expanded="false"><span class="r-mobile-project-title-text" id="rMobileProjectTitleText"></span><i class="fas fa-chevron-left" id="rMobileProjectInfoChevron" aria-hidden="true"></i></button>
          </div>
          <div class="r-project-shell-status" id="rProjectShellStatus" role="status" aria-live="polite"><div class="r-project-shell-status-card"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_4de8a87782a9e4","Loading project…") ?? "Loading project…")}</span></div></div>
          <div class="r-preview"><div class="r-preview-stage">
            ${String(projectModalAppPanelsHtml())}
          </div></div>
          <div class="r-proposal-topmode" id="rProposalTopMode"><div class="r-proposal-mode"><button type="button" class="r-proposal-mode-btn" data-proposal-mode="preview">${(globalThis.PlatformLanguage?.text("project-request","m_afff48796c3165","Preview") ?? "Preview")}</button><button type="button" class="r-proposal-mode-btn" data-proposal-mode="edit">${(globalThis.PlatformLanguage?.text("project-request","m_5b9378df7220c1","Edit") ?? "Edit")}</button></div></div>
          ${String(proposalMarkupDockHtml())}
          <div class="r-addon-info-popout" id="rAddonInfoPopout"></div>
        </div>
        <button type="button" class="r-mobile-left-tray-scrim" id="rMobileLeftTrayScrim" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_b9a40030066f65","Close project panel") ?? "Close project panel")}"></button>
        <button type="button" class="r-mobile-default-info-tray-scrim" id="rMobileDefaultInfoTrayScrim" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_ba681b9f330860","Close project details") ?? "Close project details")}"></button>
        <button type="button" class="r-mobile-project-notes-launcher" id="rMobileProjectNotesLauncher" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_e200ae071e12c3","Open project notes") ?? "Open project notes")}" hidden><i class="fas fa-comment-dots"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_d1e91b9e7610fa","Project Notes") ?? "Project Notes")}</span><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
        <button type="button" class="r-mobile-project-notes-scrim" id="rMobileProjectNotesScrim" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_10cef3d4a0821f","Close project notes") ?? "Close project notes")}"></button>
        <section class="r-mobile-project-notes-workspace" id="rMobileProjectNotesWorkspace" role="dialog" aria-modal="true" aria-labelledby="rMobileProjectNotesTitle">
          <header class="r-mobile-project-notes-head"><strong id="rMobileProjectNotesTitle">${(globalThis.PlatformLanguage?.text("project-request","m_d1e91b9e7610fa","Project Notes") ?? "Project Notes")}</strong><button type="button" class="r-mobile-project-notes-close" id="rMobileProjectNotesClose" aria-label="${(globalThis.PlatformLanguage?.text("project-request","m_10cef3d4a0821f","Close project notes") ?? "Close project notes")}"><i class="fas fa-xmark"></i></button></header>
          <div class="r-mobile-project-notes-body" id="rMobileProjectNotesBody"></div>
        </section>
        <button type="button" class="r-mobile-close" id="rMobileClose" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
        <div class="r-mobile-pager" id="rMobilePager">
          <button type="button" class="r-mobile-page-btn" id="rMobileBack"><i class="fas fa-arrow-left"></i><span>${(globalThis.PlatformLanguage?.text("project-request","m_121372231b5699","Back") ?? "Back")}</span></button>
          <button type="button" class="r-mobile-page-btn primary" id="rMobileNext" disabled><span>${(globalThis.PlatformLanguage?.text("project-request","m_5e03a7c216f500","Next") ?? "Next")}</span><i class="fas fa-arrow-right"></i></button>
          <button type="button" class="r-mobile-page-btn primary" id="rMobileOrder" disabled>${(globalThis.PlatformLanguage?.text("project-request","m_5a0d9c5a13439c","Order Report") ?? "Order Report")}</button>
        </div>
        <div class="r-save-toast" id="rSaveToast">${(globalThis.PlatformLanguage?.text("project-request","m_4bb4688766e904","Saved") ?? "Saved")}</div>
        <div class="r-signing-overlay" id="rSigningOverlay">
          <div class="r-signing-top">
            <button type="button" class="r-signing-back" id="rSigningBack"><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.text("project-request","m_206d31a7c795c4"," Back") ?? " Back")}</button>
          </div>
          <div class="r-signing-body">
            <div class="r-signing-sheet" id="rSigningSheet"></div>
          </div>
        </div>
        <div class="r-signature-modal" id="rSignatureModal">
          <div id="rSignatureModalMount"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
    syncContactsFeatureState();
    bindProjectModalCloseControls();
    bindProjectStageBarWheel();
    if (!projectShellLoading) mountProjectModalRegionApps('left');
    projectViewer = new window.Portal.ProjectViewer({
      root: el,
      tabsEl: $('#rProjectViewerTabs'),
      panelSelector: '.r-preview-panel',
      tabClass: 'r-tab',
      onTabChange: (tab) => {
        if (tab === 'proposal') {
          showProposalWorkspace({ history:'push', source:'project-tab' });
          return;
        }
        if (proposalWorkspaceOpen && proposals.length) {
          proposalActionExpanded = false;
          proposalSigningMode = false;
          if (tab === 'photos') setTimeout(revealCustomerSection, 40);
        }
        setActivePreviewTab(tab, { history:'push', source:'project-tab' });
      }
    });
    if (!projectShellLoading) mountProjectModalApps();
    syncProjectViewerTabs();
    if (!projectShellLoading) mountProjectModalRegionApps('left');
    bindProjectModalCloseControls();

    bindProjectModalFormControls();
  }

  let boundProjectForm = null;
  let projectFormListeners = null;
  function bindProjectModalFormControls(){
    const el = $('#rOverlay');
    const form = $('#rForm');
    if (!el || !form || boundProjectForm === form) return;
    projectFormListeners?.abort();
    projectFormListeners = new AbortController();
    boundProjectForm = form;
    $('#rProposalSend')?.addEventListener('click', () => {
      proposalActionExpanded = false;
      showToast((globalThis.PlatformLanguage?.text("project-request","m_4b185986cad257","Proposal ready") ?? "Proposal ready"), (globalThis.PlatformLanguage?.text("project-request","m_53f50f8bfd652f","Proposal prepared for sending.") ?? "Proposal prepared for sending."), true);
      renderActionRow();
    }, { signal: projectFormListeners.signal });
    $('#rProposalSign')?.addEventListener('click', () => {
      proposalActionExpanded = false;
      proposalSigningMode = true;
      proposalSigningSession = null;
      renderWorkflowState();
      renderSigningOverlay();
    }, { signal: projectFormListeners.signal });
    $('#rSignatureModal')?.addEventListener('click', (evt) => {
      if (evt.target === $('#rSignatureModal')) closeSignatureChooser();
    }, { signal: projectFormListeners.signal });
    $('#rMobileBack')?.addEventListener('click', mobileOrderGoBack, { signal: projectFormListeners.signal });
    $('#rMobileNext')?.addEventListener('click', mobileOrderGoNext, { signal: projectFormListeners.signal });
    $('#rMobilePinNext')?.addEventListener('click', mobileOrderGoNext, { signal: projectFormListeners.signal });
    $('#rMobileRoofChoice')?.addEventListener('click', event => {
      if (!event.target.closest('.r-mobile-roof-choice')) return;
      mobileRoofOnlyChosen = true;
      renderWorkflowState();
    }, { signal: projectFormListeners.signal });
    el.querySelector('.r-win')?.addEventListener('touchstart', handleMobileOrderSwipeStart, { ...({ passive: true }), signal: projectFormListeners.signal });
    el.querySelector('.r-win')?.addEventListener('touchend', handleMobileOrderSwipeEnd, { ...({ passive: true }), signal: projectFormListeners.signal });
    $('#rMobileOrder')?.addEventListener('click', () => {
      const submit = activeSubmitButton();
      if (!submit || submit.disabled) return;
      const form = $('#rForm');
      if (form?.requestSubmit) form.requestSubmit(submit);
      else submit.click();
    }, { signal: projectFormListeners.signal });
    $('#rContactContextBar')?.addEventListener('click', (event) => {
      const overview = event.target.closest('[data-contact-context-overview]');
      if (overview) {
        const context = activeContactContext;
        close({ skipHistory:true });
        if (context && window.Portal?.modules?.contacts?.open) {
          window.Portal.modules.contacts.open(context.contact || {}, { projects: context.projects || [] });
        }
        return;
      }
      const tab = event.target.closest('[data-contact-project-id]');
      if (!tab || !activeContactContext) return;
      const id = String(tab.dataset.contactProjectId || '').trim();
      if (!id || id === String(activeBaseProject?.id || '')) return;
      const project = (activeContactContext.projects || []).find((item) => String(item?.id || '') === id);
      if (project) openProject(project, { contactContext: activeContactContext });
    }, { signal: projectFormListeners.signal });
    const toggleProjectNoteHistory = () => {
      if (!expandedPlatformEnabled()) {
        proposalInternalNotesCollapsed = !proposalInternalNotesCollapsed;
        const notes = document.querySelector('#rOverlay .r-firstmeasure-notes');
        notes?.classList.toggle('notes-expanded', !proposalInternalNotesCollapsed);
        $('#rProjectNotesToggle')?.setAttribute('aria-expanded', String(!proposalInternalNotesCollapsed));
        $('#rProjectNotesToggle')?.setAttribute('aria-label', proposalInternalNotesCollapsed ? 'Expand internal notes' : 'Reduce internal notes');
        return;
      }
      if (!proposalInternalNotesCollapsed && !projectNoteHistoryClosing) {
        proposalInternalNotesCollapsed = true;
        projectNoteHistoryClosing = true;
        syncProjectNotesUi();
        window.clearTimeout(projectNoteHistoryCloseTimer);
        projectNoteHistoryCloseTimer = window.setTimeout(() => {
          projectNoteHistoryClosing = false;
          projectNoteHistoryCloseTimer = 0;
          syncProjectNotesUi();
        }, 520);
        return;
      }
      window.clearTimeout(projectNoteHistoryCloseTimer);
      projectNoteHistoryCloseTimer = 0;
      projectNoteHistoryClosing = false;
      proposalInternalNotesCollapsed = false;
      syncProjectNotesUi();
      const notesRoot = $('#rProjectNoteHistory')?.closest('.r-bottom-notes');
      notesRoot?.classList.add('opening');
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => notesRoot?.classList.remove('opening')));
    };
    $('#rProjectNotesToggle')?.addEventListener('click', toggleProjectNoteHistory, { signal: projectFormListeners.signal });
    $('#rProjectNotesToggle')?.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      toggleProjectNoteHistory();
    }, { signal: projectFormListeners.signal });
    const toggleProjectNoteVisibility = (event) => {
      event.stopPropagation();
      const menu = $('#rProjectNoteVisibilityMenu');
      if (!menu) return;
      if (menu.hidden) openProjectNoteVisibilityMenu();
      else closeProjectNoteVisibilityMenu();
    };
    $('#rProjectNoteVisibility')?.addEventListener('click', toggleProjectNoteVisibility, { signal: projectFormListeners.signal });
    $('#rProjectNoteVisibility')?.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      toggleProjectNoteVisibility(event);
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteVisibilityMenu')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-project-note-group]');
      const api = projectNotesApi();
      if (!button || !api) return;
      event.stopPropagation();
      const group = button.dataset.projectNoteGroup;
      if (group === 'everybody') projectNoteVisibility = [...api.GROUPS];
      else if (group === 'only_tagged') projectNoteVisibility = [];
      else projectNoteVisibility = projectNoteVisibility.includes(group) ? projectNoteVisibility.filter((item) => item !== group) : [...projectNoteVisibility, group];
      renderProjectNoteVisibilityMenu();
      positionProjectNoteVisibilityMenu();
    }, { signal: projectFormListeners.signal });
    projectNoteMentionController?.destroy?.();
    projectNoteMentionController = window.FirstMateTags?.attachMentionTextarea?.($('#rProjectNotes'), {
      orgId:projectOrgId(),
      includeAgents:true,
      onSelect:() => { autoSizeProjectNoteInput(); renderProjectNoteComposerMentions(); }
    }) || null;
    Promise.all([
      window.FirstMateTags?.listUsers?.(projectOrgId()) || Promise.resolve([]),
      window.FirstMateTags?.listAgentParticipants?.(projectOrgId()) || Promise.resolve([])
    ]).then(([users, agents]) => {
      projectNoteMentionDirectory = [...(Array.isArray(users) ? users : []), ...(Array.isArray(agents) ? agents : [])];
      renderProjectNoteHistory();
    }).catch(() => {});
    $('#rProjectNoteUpload')?.addEventListener('click', () => $('#rProjectNoteUploadInput')?.click(), { signal: projectFormListeners.signal });
    $('#rProjectNoteUploadInput')?.addEventListener('change', async (event) => {
      const inputFile = event.currentTarget;
      const file = inputFile.files?.[0];
      const button = $('#rProjectNoteUpload');
      const audioButton = $('#rProjectAudioNote');
      const api = projectNotesApi();
      inputFile.value = '';
      if (!file || !api?.prepareUpload || !activeBaseProject || pendingProjectAudio) return;
      if (button) button.disabled = true;
      if (audioButton) audioButton.disabled = true;
      try {
        pendingProjectAudio = await api.prepareUpload(activeBaseProject, file);
        if (pendingProjectAudio.text) {
          const noteInput = $('#rProjectNotes');
          if (noteInput) noteInput.value = [noteInput.value.trim(), pendingProjectAudio.text].filter(Boolean).join('\n');
        }
        editingProjectNoteId = '';
        syncProjectNotesUi();
      } catch (error) {
        pendingProjectAudio = null;
        if (button) button.disabled = false;
        if (audioButton) audioButton.disabled = false;
        showToast((globalThis.PlatformLanguage?.text("project-request","m_eba695c553b0b3","Upload failed") ?? "Upload failed"), String(error?.message || 'Could not attach this file to the note.'), false);
      }
    }, { signal: projectFormListeners.signal });
    $('#rProjectAudioNote')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const api = projectNotesApi();
      if (!api?.prepareAudioInline || !activeBaseProject || button.disabled || pendingProjectAudio) return;
      button.disabled = true;
      const uploadButton = $('#rProjectNoteUpload');
      if (uploadButton) uploadButton.disabled = true;
      const mount = $('#rProjectAudioPending');
      const removeAudio = () => {
        pendingProjectAudio = null;
        button.disabled = false;
        if (uploadButton) uploadButton.disabled = false;
      };
      try {
        pendingProjectAudio = await api.prepareAudioInline(activeBaseProject, mount, { onRemove:removeAudio });
        const input = $('#rProjectNotes');
        if (input) input.value = pendingProjectAudio.text;
        editingProjectNoteId = '';
        autoSizeProjectNoteInput();
        renderProjectNoteComposerMentions();
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('cancelled')) {
          showToast((globalThis.PlatformLanguage?.text("project-request","m_8373af9614b53c","Audio note failed") ?? "Audio note failed"), String(error?.message || 'Could not create the audio note.'), false);
        }
        button.disabled = false;
        if (uploadButton) uploadButton.disabled = false;
      }
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteAdd')?.addEventListener('click', commitProjectNote, { signal: projectFormListeners.signal });
    $('#rProjectNotes')?.addEventListener('input', (event) => {
      autoSizeProjectNoteInput();
      renderProjectNoteComposerMentions();
      // The mobile notes drawer lives outside the autosaving form.
      if (!expandedPlatformEnabled() && !event.target.closest('#rForm')) queueAutosaveNotice();
    }, { signal: projectFormListeners.signal });
    $('#rProjectNotes')?.addEventListener('scroll', () => {
      const highlights = $('#rProjectNoteHighlights');
      if (highlights) highlights.scrollTop = $('#rProjectNotes')?.scrollTop || 0;
    }, { ...({ passive:true }), signal: projectFormListeners.signal });
    $('#rProjectNotes')?.addEventListener('keydown', (event) => {
      if (!expandedPlatformEnabled()) return;
      if ((event.metaKey || event.ctrlKey) && String(event.key || '').toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
        const input = event.currentTarget;
        input.setSelectionRange(0, input.value.length);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commitProjectNote(); }
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteSearch')?.addEventListener('input', renderProjectNoteHistory, { signal: projectFormListeners.signal });
    $('#rProjectNoteSort')?.addEventListener('change', renderProjectNoteHistory, { signal: projectFormListeners.signal });
    $('#rProjectNoteHistory')?.addEventListener('mouseover', (event) => {
      const chip = event.target.closest('[data-project-note-mention-user]');
      if (chip) positionProjectNoteMentionCard(chip);
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteHistory')?.addEventListener('mouseout', (event) => {
      const chip = event.target.closest('[data-project-note-mention-user]');
      if (chip && !chip.contains(event.relatedTarget)) hideProjectNoteMentionCard(chip);
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteHistory')?.addEventListener('focusin', (event) => {
      const chip = event.target.closest('[data-project-note-mention-user]');
      if (chip) positionProjectNoteMentionCard(chip);
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteHistory')?.addEventListener('focusout', (event) => {
      const chip = event.target.closest('[data-project-note-mention-user]');
      if (chip) hideProjectNoteMentionCard(chip);
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteHistory')?.addEventListener('keydown', (event) => {
      const chip = event.target.closest('[data-project-note-mention-user]');
      if (!chip || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      openProjectNoteMentionUser(chip);
    }, { signal: projectFormListeners.signal });
    $('#rProjectNoteHistory')?.addEventListener('click', async (event) => {
      const mentionChip = event.target.closest('[data-project-note-mention-user]');
      if (mentionChip) {
        event.preventDefault();
        event.stopPropagation();
        openProjectNoteMentionUser(mentionChip);
        return;
      }
      const api = projectNotesApi();
      const edit = event.target.closest('[data-project-note-edit]');
      const remove = event.target.closest('[data-project-note-remove]');
      if (!api || (!edit && !remove) || !activeBaseProject) return;
      event.preventDefault();
      event.stopPropagation();
      const project = activeBaseProject;
      const noteId = (edit || remove).dataset.projectNoteEdit || (edit || remove).dataset.projectNoteRemove;
      if (edit) {
        const note = api.all(activeBaseProject).find((item) => item.id === noteId);
        if (!note) return;
        editingProjectNoteId = note.id;
        pendingProjectAudio = null;
        projectNoteVisibility = [...note.visibility];
        $('#rProjectNotes').value = note.text;
        projectNoteMentionController?.setSelectedMentions?.(note.mention_users || []);
        syncProjectNotesUi();
        autoSizeProjectNoteInput();
        $('#rProjectNotes').focus();
      } else {
        const confirmed = await window.confirm((globalThis.PlatformLanguage?.text("project-request","m_a5c3be1df7bbf2","Remove this project note?") ?? "Remove this project note?"));
        if (!confirmed || activeBaseProject !== project || !api.remove(project, noteId)) return;
        if (editingProjectNoteId === noteId) { editingProjectNoteId = ''; $('#rProjectNotes').value = ''; projectNoteMentionController?.setSelectedMentions?.([]); }
        syncProjectNotesUi();
        await persistProjectNoteMutation();
      }
    }, { signal: projectFormListeners.signal });
    // Channels-backed extras: edit-history popover, removed-note restore, and
    // inline replies, delegated on the same history container.
    projectNotesApi()?.bindHistoryExtras?.($('#rProjectNoteHistory'), () => activeBaseProject);
    window.addEventListener('fm:project-notes:refreshed', (event) => {
      if (projectText(event.detail?.projectId) && projectText(event.detail?.projectId) === projectText(activeBaseProject?.id)) renderProjectNoteHistory();
    }, { signal: projectFormListeners.signal });
    document.addEventListener('click', (event) => {
      if (event.target.closest('#rProjectNoteVisibility,#rProjectNoteVisibilityMenu')) return;
      closeProjectNoteVisibilityMenu();
    }, { signal: projectFormListeners.signal });
    window.addEventListener('resize', positionProjectNoteVisibilityMenu, { ...({ passive:true }), signal: projectFormListeners.signal });
    $('#rProposalAgentToggle')?.addEventListener('click', () => {
      proposalAgentCollapsed = !proposalAgentCollapsed;
      syncProposalAgentState();
    }, { signal: projectFormListeners.signal });
    $('#rOverlay .r-proposal-agent-head')?.addEventListener('click', (event) => {
      if (event.target.closest('button,a,.customer-report-tip')) return;
      proposalAgentCollapsed = !proposalAgentCollapsed;
      syncProposalAgentState();
    }, { signal: projectFormListeners.signal });
    $('#rProposalAgentPrompt')?.addEventListener('input', (event) => {
      proposalAgentPrompt = event.target.value || '';
      syncProposalAgentState();
    }, { signal: projectFormListeners.signal });
    $('#rProposalAgentDictate')?.addEventListener('click', toggleProposalAgentDictation, { signal: projectFormListeners.signal });
    $('#rProposalAgentSubmit')?.addEventListener('click', startProposalAgentProgress, { signal: projectFormListeners.signal });
    $('#rProposalBottomSend')?.addEventListener('click', () => {
      if (!proposals.length) return;
      enterProposalSendMode('edit', [proposalStableId(proposals[activeProposalIndex], activeProposalIndex)]);
    }, { signal: projectFormListeners.signal });
    window.addEventListener('resize', syncMobileOrderPagination, { signal: projectFormListeners.signal });

    // The configurable left-region app can replace its inner markup while the
    // modal stays open. Delegate from the stable overlay so the newly rendered
    // property-type buttons never lose their click handler.
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.r-type-btn');
      if (!btn || !btn.closest('#rTypeGroup')) return;
      selectProjectType(btn.dataset.type);
    }, { signal: projectFormListeners.signal });
    el.addEventListener('change', (e) => {
      if (e.target.matches('[data-property-type]') && !hasReportOrdered()) selectProjectType(e.target.value);
    }, { signal: projectFormListeners.signal });
    $('#rTypePill')?.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-type-pill]');
      if (!pill || !selectedType || hasReportOrdered()) return;
      typePickerExpanded = true;
      renderWorkflowState();
    }, { signal: projectFormListeners.signal });

    document.querySelectorAll('.r-toggle-btn[data-report-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        reportSelection = btn.dataset.reportChoice;
        normalizeReportSelection();
        locationConfirmed = !hasSelectedAddons();
        if (hasSelectedAddons()) preloadFirstReportCheckoutEligibility();
        if (isProposalChoice() && proposalsEnabled()) {
          launchProposalBuilder();
          renderWorkflowState();
          revealInLeftColumnIfBelow('#rProposalSection');
          queueAutosaveNotice();
          return;
        }
        if (isScheduleChoice()) {
          startAppointmentScheduling();
        }
        renderWorkflowState();
        revealInLeftColumnIfBelow(isScheduleChoice() ? '#rScheduleChoiceCard' : '#rReportOptionGroup');
        queueAutosaveNotice();
      }, { signal: projectFormListeners.signal });
    });
    $('#rExpeditePanel')?.addEventListener('click', (e) => {
      const optionBtn = e.target.closest('.r-expedite-btn[data-expedite-option]');
      if (optionBtn) {
        if (optionBtn.disabled) return;
        const option = reportExpediteOption(optionBtn.dataset.expediteOption);
        if (reportOrderingClosed() && option?.expedited) return;
        selectedReportExpedite = optionBtn.dataset.expediteOption === defaultReportExpediteOption()?.key
          ? null
          : optionBtn.dataset.expediteOption;
        normalizeReportSelection();
        renderWorkflowState();
        queueAutosaveNotice();
        return;
      }
    }, { signal: projectFormListeners.signal });
    $('#rReportOptionGroup')?.addEventListener('click', (e) => {
      if (openAddonInfoFromEvent(e)) return;
      const addon = e.target.closest('.r-addon-toggle[data-report-addon]');
      if (!addon || !hasSelectedAddons()) return;
      if (!roofReportControlsUnlocked()) return;
      if (addon.dataset.reportAddon === 'gutters') {
        if (!gutterReportsEnabled() || selectedType !== 'residential') return;
        includeGutterMeasurements = !includeGutterMeasurements;
      }
      if (addon.dataset.reportAddon === 'weather') {
        if (!weatherReportsEnabled()) return;
        includeWeatherReport = !includeWeatherReport;
      }
      if (addon.dataset.reportAddon === 'inspection') {
        if (!instantReportsEnabled()) return;
        includeInstantPreview = !includeInstantPreview;
      }
      normalizeReportSelection();
      renderWorkflowState();
      queueAutosaveNotice();
    }, { signal: projectFormListeners.signal });

    $('#rPinClear')?.addEventListener('click', () => {
      clearAllPins();
      locationConfirmed = false;
      renderWorkflowState();
      queueAutosaveNotice();
    }, { signal: projectFormListeners.signal });
    $('#rConfirm')?.setAttribute('role','checkbox');
    $('#rConfirm')?.setAttribute('tabindex','0');
    $('#rConfirm')?.addEventListener('keydown', event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();event.currentTarget.click();}}, { signal: projectFormListeners.signal });
    $('#rConfirm')?.addEventListener('click', () => {
      if (!hasSelectedAddons() || !addressSelected || pinCount() === 0) return;
      locationConfirmed = !locationConfirmed;
      renderWorkflowState();
      if (locationConfirmed) scrollReportControlsToTop();
      queueAutosaveNotice();
    }, { signal: projectFormListeners.signal });
    $('#rCcAdd')?.addEventListener('click', () => addCcRow(''), { signal: projectFormListeners.signal });
    $('#rAddContact')?.addEventListener('click', (event) => openContactPicker(event.currentTarget), { signal: projectFormListeners.signal });
    $('#rForm')?.addEventListener('submit', onSubmit, { signal: projectFormListeners.signal });
    $('#rAddress')?.addEventListener('focus', () => {
      initMapOnce();
      preferMapForNewProjectInput();
    }, { signal: projectFormListeners.signal });
    $('#rAddress')?.addEventListener('input', () => {
      if (shouldUseMobileOrderPagination() && addressSelected) {
        addressSelected = false;
        locationConfirmed = false;
        selectedType = null;
        mobileRoofOnlyChosen = false;
        mobileTypeTransitioning = false;
        typePickerExpanded = false;
        if (mobileTypeTransitionTimer) clearTimeout(mobileTypeTransitionTimer);
        clearAllPins({ silent: true });
        window.Portal.ExteriorOrder?.reset();
      }
      preferMapForNewProjectInput();
      renderWorkflowState();
    }, { signal: projectFormListeners.signal });
    $('#rForm')?.addEventListener('input', (e) => {
      if (e.target.matches('input, textarea, select')) queueAutosaveNotice();
      if (e.target.matches('#rAddress, [data-field="name"], [data-field="phone"], [data-field="email"]')) updateModalTitle();
      if (hasReportOrdered()) renderProjectViewerSummary();
      if (e.target.matches('[data-fm-cf-input]')) syncProjectCustomFieldValues();
      persistActiveBaseProject();
    }, { signal: projectFormListeners.signal });
    $('#rForm')?.addEventListener('change', (e) => {
      if (e.target.matches('input, textarea, select')) queueAutosaveNotice();
      if (e.target.matches('#rAddress, [data-field="name"], [data-field="phone"], [data-field="email"]')) updateModalTitle();
      if (hasReportOrdered()) renderProjectViewerSummary();
      if (e.target.matches('[data-fm-cf-input]')) syncProjectCustomFieldValues();
      persistActiveBaseProject();
    }, { signal: projectFormListeners.signal });
    document.addEventListener('keydown', handleGalleryKeydown, { signal: projectFormListeners.signal });
    document.addEventListener('keydown', handleProposalPreviewKeydown, { signal: projectFormListeners.signal });
    document.addEventListener('keydown', handleProjectModalKeydown, { signal: projectFormListeners.signal });
    bindProposalModeToggle();
    bindProposalMarkupToggle();
    addContactCard({}, { hydrate:true });
    renderPhotoGallery();
    bindAddonInfoInteractions();
  }

  function capturePendingOrder(){
    const contacts = collectContacts();
    const primary = primaryContact();
    const obj = {
      v: 3,
      ts: Date.now(),
      fields: {
        address: ($('#rAddress').value || '').trim(),
        residentName: primary.name || '',
        residentEmail: primary.email || '',
        residentPhone: primary.phone || '',
        contacts: JSON.stringify(contacts),
        project_title: manualProjectTitle(),
        projectNotes: ($('#rProjectNotes')?.value || '').trim(),
        lat: ($('#rLat').value || '').trim(),
        lng: ($('#rLng').value || '').trim(),
        custom_coords: ($('#rCustom').value || '0').trim(),
        address_components: ($('#rComps').value || '{}').trim(),
        issuerName: String(cfg.userName || ''),
        issuerEmail: String(cfg.userEmail || ''),
        project_type: selectedType || 'residential',
        wants_roof_report: hasSelectedAddons() ? '1' : '0',
        gutter_addon: hasGutterAddon() ? '1' : '0',
        weather_addon: hasWeatherAddon() ? '1' : '0',
        report_mode: selectedReportMode(),
        ...selectedReportExpeditePayload(),
        include_gutter_measurements: hasGutterAddon() ? '1' : '0',
        include_weather_report: hasWeatherAddon() ? '1' : '0',
        report_options: JSON.stringify({ selection: reportSelection, instant_preview: includeInstantPreview, weather_report: includeWeatherReport, expedite_option: selectedReportExpediteOption()?.key || null }),
        pins: JSON.stringify(getMarkersData()),
        cc_emails: JSON.stringify(collectCcEmails()),
        tech_notes: ($('#rTechNotes').value || '').trim(),
        platform_project_id: activeBaseProject?.id || '',
        base_project_id: activeBaseProject?.id || '',
        reorder_project_id: reorderSourceCanReopenInPlace && reorderMeasurementProjectId ? reorderMeasurementProjectId : '',
        source_project_id: reorderSourceCanReopenInPlace && reorderMeasurementProjectId ? reorderMeasurementProjectId : '',
        ...(window.Portal.ExteriorOrder?.payload() || {}),
      }
    };
    try { localStorage.setItem(PENDING_ORDER_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  async function ensureCreditsOrGate(){
    const price = currentPrice();
    const cachedBalance = Number(window.Portal?.credits?.lastCredits);
    if (Number.isFinite(cachedBalance) && cachedBalance < price) {
      capturePendingOrder();
      showToast((globalThis.PlatformLanguage?.text("project-request","m_a394c59c2a89db","No credits") ?? "No credits"), ((v0) => globalThis.PlatformLanguage?.text("project-request","m_b97feb346e3fae",`You need $${v0} to place this report order.`,{v0}) ?? `You need $${v0} to place this report order.`)(price), false);
      close();
      await openReportCreditGateTopup({
        label: window.Portal.ExteriorOrder?.active() ? 'this Full Structure report' : 'this roof report',
        required: price,
        balance: cachedBalance,
        context: 'credit_gate'
      });
      return false;
    }
    const refreshed = await window.Portal.credits.refreshCredits().catch(() => null);
    if (!refreshed?.ok) return true;
    const bal = window.Portal.credits.lastCredits ?? 0;
    if (bal >= price) return true;
    capturePendingOrder();
    showToast((globalThis.PlatformLanguage?.text("project-request","m_a394c59c2a89db","No credits") ?? "No credits"), ((v0) => globalThis.PlatformLanguage?.text("project-request","m_b97feb346e3fae",`You need $${v0} to place this report order.`,{v0}) ?? `You need $${v0} to place this report order.`)(price), false);
    close();
    await openReportCreditGateTopup({
      label: window.Portal.ExteriorOrder?.active() ? 'this Full Structure report' : 'this roof report',
      required: price,
      balance: bal,
      context: 'credit_gate'
    });
    return false;
  }

  const STREET_ABBREVS = {
    street: 'st', st: 'st', avenue: 'ave', ave: 'ave', boulevard: 'blvd', blvd: 'blvd',
    drive: 'dr', dr: 'dr', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl',
    lane: 'ln', ln: 'ln', road: 'rd', rd: 'rd', circle: 'cir', cir: 'cir',
    terrace: 'ter', ter: 'ter', trail: 'trl', trl: 'trl', way: 'way',
    highway: 'hwy', hwy: 'hwy', parkway: 'pkwy', pkwy: 'pkwy',
    expressway: 'expy', expy: 'expy', freeway: 'fwy', fwy: 'fwy',
    turnpike: 'tpke', tpke: 'tpke', pike: 'pike', square: 'sq', sq: 'sq',
    loop: 'loop', alley: 'aly', aly: 'aly', crossing: 'xing', xing: 'xing',
    point: 'pt', pt: 'pt', ridge: 'rdg', rdg: 'rdg', run: 'run', pass: 'pass',
  };
  const DIRECTIONAL_ABBREVS = {
    north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
    northeast: 'ne', ne: 'ne', northwest: 'nw', nw: 'nw', southeast: 'se', se: 'se', southwest: 'sw', sw: 'sw',
  };
  const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', 'rm', 'room', 'fl', 'floor', 'bldg', 'building', 'dept', 'department', 'lot', 'spc', 'space', 'trlr', 'trailer']);
  const STATE_NAMES = new Set(['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia']);

  function deepNormalizeAddress(raw){
    if (!raw) return { full: '', core: '', streetNum: '', streetWords: [] };
    let s = (raw || '').trim().toLowerCase();
    s = s.replace(/,?\s*(united states|usa|us)\s*$/i, '');
    s = s.replace(/\b\d{5}(-\d{4})?\b/g, '');
    s = s.replace(/,?\s*\b[a-z]{2}\s*$/, '');
    for (const st of STATE_NAMES) s = s.replace(new RegExp(',?\\s*' + st.replace(/ /g, '\\s+') + '\\s*$'), '');
    const commaIdx = s.lastIndexOf(',');
    if (commaIdx > 0) {
      const tail = s.substring(commaIdx + 1).trim();
      if (tail && /^[a-z\s]+$/.test(tail)) s = s.substring(0, commaIdx);
    }
    s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    let words = s.split(' ').map((w) => STREET_ABBREVS[w] || w).map((w) => DIRECTIONAL_ABBREVS[w] || w);
    const stripped = [];
    let skipNext = false;
    for (let i = 0; i < words.length; i++) {
      if (skipNext) { skipNext = false; continue; }
      if (UNIT_WORDS.has(words[i])) { skipNext = true; continue; }
      stripped.push(words[i]);
    }
    const full = stripped.join(' ');
    const streetNum = stripped.length > 0 && /^\d+$/.test(stripped[0]) ? stripped[0] : '';
    const streetWords = streetNum ? stripped.slice(1) : [...stripped];
    return { full, core: (streetNum + ' ' + streetWords.join(' ')).trim(), streetNum, streetWords };
  }

  function addressSimilarity(a, b){
    if (a.core === b.core) return 1;
    if (!a.core || !b.core) return 0;
    if (a.streetNum && b.streetNum && a.streetNum !== b.streetNum) return 0;
    const numMatch = (a.streetNum === b.streetNum) ? 1 : (!a.streetNum || !b.streetNum) ? 0.5 : 0;
    if (numMatch === 0) return 0;
    const setA = new Set(a.streetWords);
    const setB = new Set(b.streetWords);
    if (setA.size === 0 && setB.size === 0) return numMatch;
    let intersection = 0;
    for (const w of setA) if (setB.has(w)) intersection++;
    const union = new Set([...setA, ...setB]).size;
    return numMatch * 0.4 + (union > 0 ? (intersection / union) : 0) * 0.6;
  }

  function extractSearchQuery(address){
    try {
      const comps = JSON.parse($('#rComps')?.value || '{}');
      if (comps.street_number && comps.route) return `${comps.street_number} ${comps.route.split(' ')[0]}`;
    } catch (e) {}
    const norm = deepNormalizeAddress(address);
    if (norm.streetNum && norm.streetWords.length > 0) return `${norm.streetNum} ${norm.streetWords[0]}`;
    return address.substring(0, 40);
  }

  function isActiveReportOrderStatus(...values){
    return normalizedStatusList(values).some((status) => (
      status === 'submitted'
      || status === 'queued'
      || status === 'ready'
      || status === 'processing'
      || status === 'in_progress'
      || status === 'awaiting_review'
      || status === 'awaiting_manager_review'
      || status === 'pending_rejection'
      || status === 'correction_needed'
      || status === 'measurement_ordered'
    ));
  }

  function projectHasReportOrder(project = {}){
    const measurement = (project.measurement_project && typeof project.measurement_project === 'object')
      ? project.measurement_project
      : ((project.measurement && typeof project.measurement === 'object') ? project.measurement : {});
    const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
    const manifest = (project.manifest && typeof project.manifest === 'object' && !Array.isArray(project.manifest))
      ? project.manifest
      : ((raw.manifest && typeof raw.manifest === 'object' && !Array.isArray(raw.manifest)) ? raw.manifest : {});
    if (isRejectedStatus(project.status, measurement.status, raw.status, manifest.status)) return false;
    if (isCancelledStatus(project.status, project.workflow_state, measurement.status, raw.status, manifest.status)) return false;
    if (isActiveReportOrderStatus(project.status, project.workflow_state, measurement.status, raw.status, manifest.status)) return true;
    const measurementId = firstMeasurementId(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.folder,
      raw.id,
      raw.project_id,
      raw.measurement_project_id,
      manifest.folder,
      manifest.id,
      manifest.project_id,
      manifest.measurement_project_id,
      project.measurement_project_id,
      project.firstmeasure_project_id,
      project.firstmeasure_id,
      project.project_id,
      measurementIdFromAssetUrl(
        project.report_url,
        project.pdf_url,
        project.summary_url,
        project.xml_url,
        project.artifacts?.report_url,
        project.artifacts?.summary_url,
        project.assets?.report_url,
        project.assets?.summary_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url,
        manifest.report_url,
        manifest.pdf_url,
        manifest.summary_url,
        manifest.xml_url
      )
    );
    if (measurementId) return true;
    if (project.has_report || project.report_url || project.pdf_url || project.summary_url || project.xml_url) return true;
    if (project.instant_url || project.instant_pdf_url || project.assets?.instant_pdf_url || project.instant?.assets?.instant_pdf_url) return true;
    return false;
  }

  function isCurrentBaseProject(project = {}){
    const activeId = String(activeBaseProject?.id || '').trim();
    if (!activeId) return false;
    return [
      project.id,
      project.platform_project_id,
      project.base_project_id
    ].some((value) => String(value || '').trim() === activeId);
  }

  async function findDuplicateProject(address){
    if (!address) return null;
    try {
      const { data } = await postAction('list_projects', { filter: 'org', search: extractSearchQuery(address), limit: '30', page: '1', include_firstmeasure: '1', max_pages: '5' });
      const projects = data?.projects || [];
      const normNew = deepNormalizeAddress(address);
      let bestMatch = null;
      let bestScore = 0;
      for (const p of projects) {
        const measurement = (p.measurement_project && typeof p.measurement_project === 'object')
          ? p.measurement_project
          : ((p.measurement && typeof p.measurement === 'object') ? p.measurement : {});
        const raw = (measurement.raw && typeof measurement.raw === 'object') ? measurement.raw : {};
        const manifest = (raw.manifest && typeof raw.manifest === 'object') ? raw.manifest : {};
        if (isRejectedStatus(p.status, measurement.status, raw.status, manifest.status)) continue;
        if (isCancelledStatus(p.status, p.workflow_state, measurement.status, raw.status, manifest.status)) continue;
        if (isCurrentBaseProject(p)) continue;
        if (!projectHasReportOrder(p)) continue;
        const score = addressSimilarity(normNew, deepNormalizeAddress(p.address));
        if (score >= 0.7 && score > bestScore) { bestScore = score; bestMatch = p; }
      }
      return bestMatch;
    } catch (e) {
      console.warn('Duplicate check failed:', e);
      return null;
    }
  }

  function showDuplicateConfirm(existingProject, newAddress){
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'r-dup-overlay';
      const statusLabels = { submitted: 'In Progress', queued: 'In Progress', ready: 'In Progress', processing: 'In Progress', in_progress: 'In Progress', awaiting_review: 'Awaiting Review', awaiting_manager_review: 'Awaiting Review', correction_needed: 'Correction Needed', completed: 'Completed', pending_rejection: 'Pending Review' };
      const st = (existingProject.status || '').toLowerCase();
      const created = existingProject.created_at ? new Date(existingProject.created_at).toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      overlay.innerHTML = `<div class="r-dup-dialog"><div class="r-dup-icon"><i class="fas fa-exclamation-triangle"></i></div><div class="r-dup-title">${(globalThis.PlatformLanguage?.text("project-request","m_5586d2df7e38a9","Duplicate report detected") ?? "Duplicate report detected")}</div><div class="r-dup-body">${(globalThis.PlatformLanguage?.text("project-request","m_9ee3ae5b218a97","It looks like a roof report was already ordered for this address. Do you still want to place a new roof report order?") ?? "It looks like a roof report was already ordered for this address. Do you still want to place a new roof report order?")}</div><div class="r-dup-match"><div class="r-dup-match-addr">${String((existingProject.address || newAddress).replace(/</g, '&lt;'))}</div><div class="r-dup-match-meta">${((v1,v2) => globalThis.PlatformLanguage?.text("project-request","m_26a0ffb1c5f2ca",`Status: ${v1}${v2}`,{v1,v2}) ?? `Status: ${v1}${v2}`)(statusLabels[st] || existingProject.status || 'Unknown',created ? ' - Ordered: ' + created : '')}</div></div><div class="r-dup-actions"><button class="r-dup-btn" id="rDupCancel">${(globalThis.PlatformLanguage?.text("project-request","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><button class="r-dup-btn primary" id="rDupProceed">${(globalThis.PlatformLanguage?.text("project-request","m_a2c586200d3d66","Order Anyway") ?? "Order Anyway")}</button></div></div>`;
      document.body.appendChild(overlay);
      let modalHandle = null;
      function cleanup(result){
        modalHandle?.unregister?.();
        modalHandle = null;
        overlay.remove();
        resolve(result);
      }
      overlay.querySelector('#rDupCancel').addEventListener('click', () => cleanup(false));
      overlay.querySelector('#rDupProceed').addEventListener('click', () => cleanup(true));
      modalHandle = window.Portal?.modals?.register?.(overlay, {
        id: 'duplicate-report',
        closeOnEscape: true,
        closeOnBackdrop: true,
        onClose: () => cleanup(false)
      }) || null;
    });
  }

  async function onSubmit(e){
    e.preventDefault();
    if (!window.Portal.ExteriorOrder?.active() && selectedReportExpeditePricingPending()) {
      showToast((globalThis.PlatformLanguage?.text("project-request","m_de248990c3b2ce","Pricing still loading") ?? "Pricing still loading"), (globalThis.PlatformLanguage?.text("project-request","m_16748599c5acea","Please wait for the current expedited price before ordering.") ?? "Please wait for the current expedited price before ordering."), false);
      updateSubmitLabel();
      syncMobileOrderPagination();
      return;
    }
    if (!canSubmit()) {
      updateSubmitLabel();
      syncMobileOrderPagination();
      shakeMissingMobileOrderRequirement();
      return;
    }
    const contacts = collectContacts();
    const primary = primaryContact();

    if (hasReportOrdered()) {
      if (proposals.length) {
        if (!proposalWorkspaceOpen) {
          showProposalWorkspace();
          return;
        }
        enterProposalSendMode(proposalWorkspaceMode === 'edit' ? 'edit' : 'list', [proposalStableId(proposals[activeProposalIndex], activeProposalIndex)]);
        return;
      }
      proposalWorkspaceMode = 'list';
      proposalEditorMode = 'preview';
      proposalWorkspaceOpen = true;
      proposalActionExpanded = false;
      proposalSigningMode = false;
      showProposalWorkspace();
      return;
    }

    if (isScheduleChoice()) {
      if (scheduleHasDraft()) {
        await saveCalendarAppointment();
      } else {
        startAppointmentScheduling();
      }
      queueAutosaveNotice();
      return;
    }

    if (!hasSelectedAddons()) {
      if (isProposalReadyFlow()) {
        ensureProposalOnlyBaseProject();
        if (!proposalWorkspaceOpen) {
          showProposalWorkspace();
          return;
        }
        proposalWorkspaceMode = 'list';
        renderProposalSection();
        renderProposalPreview();
        return;
      }
      proposalWorkspaceMode = 'list';
      proposalEditorMode = 'preview';
      proposalWorkspaceOpen = true;
      proposalActionExpanded = false;
      proposalSigningMode = false;
      ensureProposalOnlyBaseProject();
      showProposalWorkspace();
      return;
    }

    const reorderSourceProjectId = reorderMeasurementProjectId || '';
    const pins = getMarkersData();
    if (!validateStructurePinLimitForSubmit(pins)) {
      updateSubmitLabel();
      syncMobileOrderPagination();
      return;
    }
    setSubmitBusyLabel(activeSubmitButton(), 'Ordering...');
    const ok = await ensureCreditsOrGate();
    if (!ok) return;

    const submitAddress = ($('#rAddress').value || '').trim();
    if (submitAddress && !reorderSourceProjectId) {
      const btn = activeSubmitButton();
      setSubmitBusyLabel(btn, 'Submitting...');
      const dup = await findDuplicateProject(submitAddress);
      if (dup) {
        btn.disabled = false;
        updateSubmitLabel();
        const proceed = await showDuplicateConfirm(dup, submitAddress);
        if (!proceed) return;
      }
      updateSubmitLabel();
    }

    const btn = activeSubmitButton();
    setSubmitBusyLabel(btn, 'Ordering');

    const primaryLat = pins[0]?.lat ?? ($('#rLat').value || '').trim();
    const primaryLng = pins[0]?.lng ?? ($('#rLng').value || '').trim();
    // Rejected measurements can be reopened in place. Cancelled measurements cannot, so
    // they create a fresh measurement order while staying attached to the same Platform project.
    const shouldReopenReorderSource = reorderSourceCanReopenInPlace && !!reorderSourceProjectId;
    const payload = {
      branch_id: window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || "default",
      address: ($('#rAddress').value || '').trim(),
      residentName: primary.name || '',
      residentEmail: primary.email || '',
      residentPhone: primary.phone || '',
      contacts: JSON.stringify(contacts),
      project_title: manualProjectTitle(),
      project_notes: legacyProjectNotesText(),
      lat: String(primaryLat),
      lng: String(primaryLng),
      custom_coords: pins.length > 0 ? '1' : ($('#rCustom').value || '0').trim(),
      address_components: ($('#rComps').value || '{}').trim(),
      issuerName: String(cfg.userName || ''),
      issuerEmail: String(cfg.userEmail || ''),
      project_type: selectedType,
      wants_roof_report: '1',
      gutter_addon: hasGutterAddon() ? '1' : '0',
      weather_addon: hasWeatherAddon() ? '1' : '0',
      report_mode: selectedReportMode(),
      ...selectedReportExpeditePayload(),
      include_gutter_measurements: hasGutterAddon() ? '1' : '0',
      include_weather_report: hasWeatherAddon() ? '1' : '0',
      report_options: JSON.stringify({ selection: reportSelection, instant_preview: includeInstantPreview, weather_report: includeWeatherReport, expedite_option: selectedReportExpediteOption()?.key || null }),
      pins: JSON.stringify(pins),
      cc_emails: JSON.stringify(collectCcEmails()),
      tech_notes: ($('#rTechNotes').value || '').trim(),
      platform_project_id: activeBaseProject?.id || '',
      base_project_id: activeBaseProject?.id || '',
      reorder_project_id: shouldReopenReorderSource ? reorderSourceProjectId : '',
      source_project_id: shouldReopenReorderSource ? reorderSourceProjectId : '',
      ...window.Portal.ExteriorOrder?.payload(),
    };
    try {
      const { data } = await postAction('queue', payload);
      if (!data || !data.success) {
        const msg = data?.message || data?.error || 'Submission failed.';
        if(window.Portal.ExteriorOrder?.active()) window.Portal.ExteriorOrder.failed(data);
        btn.disabled = false;
        updateSubmitLabel();
        if (String(msg).toLowerCase().includes('credit')) {
          capturePendingOrder();
          await openReportCreditGateTopup({
            label: window.Portal.ExteriorOrder?.active() ? 'this Full Structure report' : 'this roof report',
            required: currentPrice(),
            balance: Number(window.Portal?.credits?.lastCredits),
            context: 'server_credit_reject'
          });
          showToast((globalThis.PlatformLanguage?.text("project-request","m_a394c59c2a89db","No credits") ?? "No credits"), (globalThis.PlatformLanguage?.text("project-request","m_1c14a09330064b","Top up to submit this exact roof report order.") ?? "Top up to submit this exact roof report order."), false);
          return;
        }
        showToast((globalThis.PlatformLanguage?.text("project-request","m_be1a6bd83137b5","Order issue") ?? "Order issue"), msg, false);
        return;
      }
      try { localStorage.removeItem(PENDING_ORDER_KEY); } catch (ex) {}
      showToast(payload.measurement_scope === 'full_house' ? 'Full Structure report ordered' : 'Roof report ordered', getAfterHoursMessage() || 'Report is now processing.', true);
      const shouldUpdateExistingProject = !!String(payload.platform_project_id || payload.base_project_id || '').trim();
      reorderMeasurementProjectId = '';
      reorderSourceCanReopenInPlace = false;
      enterReportOrderedMode(data, payload);
      window.dispatchEvent(new CustomEvent(activeBaseProject ? 'fm:projects:optimistic-update' : 'fm:projects:optimistic-add', {
        detail: activeBaseProject
          ? { project: activeBaseProject, redraw: true }
          : payload
      }));
      trackRequestActivity({
        type: 'roof_report_ordered',
        summary: 'Ordered a roof report',
        target: {
          project_id: activeBaseProject?.id || data?.project?.id || data?.project_id || '',
          project_title: activeBaseProject?.title || payload.address || '',
          project_address: payload.address || ''
        },
        metadata: {
          report_mode: payload.report_mode || '',
          include_gutter_measurements: payload.include_gutter_measurements === '1' || payload.include_gutter_measurements === true,
          include_weather_report: payload.include_weather_report === '1' || payload.include_weather_report === true,
          expedite_option: payload.report_expedite_option || '',
          due_window: payload.report_due_window_label || ''
        }
      });
      if (shouldAutoOpenInstantFromMode(payload.report_mode)) {
        setActiveMeasurementTab('instant');
      }
      window.Portal.credits.refreshCredits().catch(() => null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    } catch (error) {
      btn.disabled = false;
      updateSubmitLabel();
      showToast((globalThis.PlatformLanguage?.text("project-request","m_cb54e163f7df44","Couldn’t submit order") ?? "Couldn’t submit order"), error?.message || 'Connection error. Please try again.', false);
      window.Portal.credits.refreshCredits().catch(() => null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    }
  }

  function googleMapsReady(...args){ return !!projectMapInvoke('googleMapsReady', args); }
  function setMapHint(...args){ return projectMapInvoke('setMapHint', args); }
  function syncOverviewMapMode(...args){ return projectMapInvoke('syncOverviewMapMode', args); }
  function initMapOnce(...args){ return projectMapInvoke('initMapOnce', args); }
  function initializeMapView(...args){ return projectMapInvoke('initializeMapView', args); }

  let projectFormHydrating = 0;
  function hydrateFromBaseProject(baseProject, options = {}){
    projectFormHydrating++;
    try {
    const base = baseProject || {};
    activeBaseProject = base;
    projectWorkPlanState = { projectId: '', plans: [], loaded: false };
    if (!options.deferRemoteContent) loadProjectWorkPlans().catch(() => null);
    activeBaseProject.events = Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [];
    addressSelected = !!base.address;
    locationConfirmed = !isUnfinishedReportDraft(base);
    selectedType = base.project_type || 'residential';
    typePickerExpanded = false;
    mobileTypeTransitioning = false;
    mobileRoofOnlyChosen = false;
    if (mobileTypeTransitionTimer) clearTimeout(mobileTypeTransitionTimer);
    const hasBaseMeasurement = projectHasReportOrder(base);
    reportSelection = hasBaseMeasurement || isUnfinishedReportDraft(base)
      ? 'roof'
      : (base.workflow_state === 'proposal_only' ? 'proposal' : reportSelection);
    includeGutterMeasurements = !!(base.measurement?.include_gutters || base.include_gutter_measurements);
    includeWeatherReport = !!(
      base.measurement?.include_weather_report
      || base.measurement_project?.include_weather_report
      || base.measurement?.weather_report_id
      || base.measurement_project?.weather_report_id
      || base.include_weather_report
      || base.weather_report_id
    );
    includeInstantPreview = !!base.measurement?.include_instant;
    selectedReportExpedite = base.report_expedite_option || base.measurement?.report_expedite_option || null;
    if ($('#rAddress')) $('#rAddress').value = base.address || '';
    if ($('#rLat')) $('#rLat').value = String(base.lat ?? base.latitude ?? '');
    if ($('#rLng')) $('#rLng').value = String(base.lng ?? base.longitude ?? '');
    if ($('#rCustom')) $('#rCustom').value = normalizeProjectPins(base).length ? '1' : '0';
    if ($('#rComps')) {
      const components = base.address_components || base.addressComponents || base.components || {};
      $('#rComps').value = typeof components === 'string' ? components : JSON.stringify(components || {});
    }
    if ($('#rProjectNotes')) $('#rProjectNotes').value = expandedPlatformEnabled() ? '' : (base.project_notes || '');
    const savedMeasurement = base.measurement_project || base.measurement || {};
    const savedManifest = savedMeasurement.raw?.manifest || savedMeasurement.manifest || {};
    if ($('#rTechNotes')) $('#rTechNotes').value = base.tech_notes ?? savedMeasurement.tech_notes ?? savedManifest.tech_notes ?? '';
    const savedCcEmails = base.cc_emails ?? savedMeasurement.cc_emails ?? savedManifest.cc_emails ?? [];
    if ($('#rCcList')) {
      $('#rCcList').replaceChildren();
      (Array.isArray(savedCcEmails) ? savedCcEmails : []).forEach((email) => addCcRow(email, { hydrate:true }));
    }
    editingProjectNoteId = '';
    pendingProjectAudio = null;
    projectNoteVisibility = [...(projectNotesApi()?.GROUPS || ['office', 'crew', 'sales'])];
    syncProjectNotesUi();
    projectPhotos = normalizeProjectPhotoList(base);
    syncProjectPhotosFromLibrary();
    proposals = Array.isArray(base.proposals) ? base.proposals : [];
    normalizeProposalCollection();
    proposalBackendLoadedProjectId = '';
    if ($('#rForm') && !options.deferRemoteContent) {
      hydrateProposalsFromBackend({ render: true, force: true })
        .then(() => renderProjectStageBar())
        .catch((error) => console.warn('Proposal load failed', error));
    }
    activeProposalIndex = proposals.length ? Math.min(activeProposalIndex, proposals.length - 1) : 0;
    if (reportSelection && !actionAvailable(reportSelection)) reportSelection = null;
    activePhotoIndex = 0;
    const contactList = $('#rContactList');
    if (contactList) contactList.innerHTML = '';
    const resolvedContacts = contactForProjectModal(base);
    const contacts = resolvedContacts.length ? resolvedContacts : [{ name: '', phone: '', email: '' }];
    const primaryIndex = contacts.findIndex((contact) => contact?.primary);
    primaryContactIndex = primaryIndex >= 0 ? primaryIndex : 0;
    if (contactList) contacts.forEach((contact) => addContactCard(contact, { hydrate:true }));
    renderProjectCustomFields();
    updateModalTitle();
    if (hasBaseMeasurement) {
      const measurementSource = (base.measurement_project && typeof base.measurement_project === 'object') ? base.measurement_project : (base.measurement || {});
      const measurementRaw = (measurementSource?.raw && typeof measurementSource.raw === 'object') ? measurementSource.raw : {};
      const measurementManifest = (measurementRaw.manifest && typeof measurementRaw.manifest === 'object') ? measurementRaw.manifest : measurementSource || {};
      const measurementStatus = String(
        measurementSource?.status
        || measurementRaw.status
        || measurementManifest.status
        || base.status
        || ''
      ).toLowerCase();
      const reportUrl = String(
        base.report_url
        || base.pdf_url
        || measurementSource?.report_url
        || measurementSource?.pdf_url
        || measurementRaw.report_url
        || measurementRaw.pdf_url
        || measurementManifest.report_url
        || measurementManifest.pdf_url
        || ''
      ).trim();
      const summaryUrl = String(
        base.summary_url
        || measurementSource?.summary_url
        || measurementRaw.summary_url
        || measurementManifest.summary_url
        || ''
      ).trim();
      const xmlUrl = String(
        base.xml_url
        || measurementSource?.xml_url
        || measurementRaw.xml_url
        || measurementManifest.xml_url
        || ''
      ).trim();
      const cancelledMeasurement = isCancelledStatus(
        measurementStatus,
        base.status,
        base.workflow_state
      );
      const rejectedMeasurement = isRejectedStatus(
        measurementStatus,
        base.status,
        base.workflow_state,
        measurementSource?.status,
        measurementRaw.status,
        measurementManifest.status
      );
      const releaseHeld = reportReleaseHoldIsActive(measurementManifest) || reportReleaseHoldIsActive(base);
      reportOrderState = {
        ordered: true,
        data: measurementRaw,
        payload: {},
        address: base.address || '',
        includeInspection: !!measurementSource?.include_instant,
        includeGutters: !!measurementSource?.include_gutters,
        includeWeather: !!(measurementSource?.include_weather_report || measurementManifest.include_weather_report || base.include_weather_report || measurementSource?.weather_report_id || measurementManifest.weather_report_id || base.weather_report_id),
        weatherReportId: measurementSource?.weather_report_id || measurementManifest.weather_report_id || base.weather_report_id || '',
        weatherReportPdfUrl: measurementSource?.weather_report_pdf_url || measurementManifest.weather_report_pdf_url || base.weather_report_pdf_url || '',
        isExpedited: !!(base.is_expedited || measurementSource?.is_expedited),
        reportExpediteOption: base.report_expedite_option || measurementSource?.report_expedite_option || '',
        reportExpediteLabel: base.report_expedite_label || measurementSource?.report_expedite_label || '',
        reportDueWindowStart: base.report_due_window_start || measurementSource?.report_due_window_start || '',
        reportDueWindowEnd: base.report_due_window_end || measurementSource?.report_due_window_end || '',
        reportDueWindowLabel: base.report_due_window_label || measurementSource?.report_due_window_label || '',
        reportProductionDeadlineAt: base.report_production_deadline_at || measurementSource?.report_production_deadline_at || measurementManifest.report_production_deadline_at || '',
        amountCharged: Number(base.amount_charged ?? measurementSource?.amount_charged ?? 0) || 0,
        expediteRefundStatus: base.report_expedite_refund_status || measurementSource?.report_expedite_refund_status || measurementManifest.report_expedite_refund_status || '',
        expediteRefundAmount: Number(base.report_expedite_refund_amount ?? measurementSource?.report_expedite_refund_amount ?? measurementManifest.report_expedite_refund_amount ?? 0) || 0,
        expediteRefundAt: base.report_expedite_refund_at || measurementSource?.report_expedite_refund_at || measurementManifest.report_expedite_refund_at || '',
        expediteRefundMessage: base.report_expedite_refund_message || measurementSource?.report_expedite_refund_message || measurementManifest.report_expedite_refund_message || '',
        status: cancelledMeasurement ? 'cancelled' : (rejectedMeasurement ? 'rejected_no_coverage' : measurementStatus),
        reportUrl: (cancelledMeasurement || rejectedMeasurement) ? '' : reportUrl,
        summaryUrl: (cancelledMeasurement || rejectedMeasurement) ? '' : summaryUrl,
        xmlUrl: (cancelledMeasurement || rejectedMeasurement) ? '' : xmlUrl,
        refundedAmount: Number(base.cancellation_refund_amount ?? measurementSource?.cancellation_refund_amount ?? 0) || 0,
        submittedAt: measurementSource?.submitted_at || base.updated_at || '',
        hasReadyReport: !cancelledMeasurement && !rejectedMeasurement && !releaseHeld && (
          isFirstMeasureReturnedReportStatus(measurementStatus, base.status)
          || !!reportUrl
          || !!summaryUrl
        ),
      };
      setActiveMeasurementTab(cancelledMeasurement ? 'standard' : (reportOrderState.includeInspection ? 'instant' : 'standard'));
      setProjectionMode(true);
      if (!options.preferredTab) setActivePreviewTab('measurements');
    }
    } finally { projectFormHydrating--; }
  }

  function resetNewProjectState(){
    if (mobileTypeTransitionTimer) clearTimeout(mobileTypeTransitionTimer);
    mobileTypeTransitioning = false;
    mobileRoofOnlyChosen = false;
    window.Portal.ExteriorOrder?.reset();
    activeBaseProject = null;
    projectWorkPlanState = { projectId: '', plans: [], loaded: false };
    resetCustomerPortalApp();
    viewingExistingProject = false;
    newProjectCreationSession = false;
    reportOrderState = null;
    requestedWorkflow = 'project';
    requestedDocumentType = '';
    requestedDocumentResume = null;
    docPickerDismissed = false;
    docPickerChoiceMade = false;
    docCreateLaunched = false;
    removeDocWorkflowPicker();
    projectTodoController?.destroy?.();
    projectTodoController = null;
    projectTodoLoadedFor = '';
    clearWeatherReportPoll();
    reorderMeasurementProjectId = '';
    reorderSourceCanReopenInPlace = false;
    resetProjectMapExpansionPreference();
    resetProjectMeasurementsApp();
    resetProjectScheduleApp();
    addressSelected = false;
    locationConfirmed = false;
    selectedType = null;
    typePickerExpanded = false;
    reportSelection = null;
    mobileOrderPage = 'location';
    selectedReportExpedite = null;
    includeGutterMeasurements = false;
    includeWeatherReport = false;
    includeInstantPreview = false;
    activePreviewTab = 'map';
    activePhotoIndex = 0;
    primaryContactIndex = 0;
    proposals = [];
    activeProposalIndex = 0;
    activeProposalPageIndex = 0;
    proposalEditorMode = 'preview';
    proposalWorkspaceMode = 'list';
    proposalWorkspaceOpen = false;
    proposalSettingsPanelOpen = false;
    proposalSendOrigin = 'list';
    proposalSendMessage = '';
    proposalSendIncludePdf = true;
    proposalSendIncludePortal = true;
    proposalSendSelectedIds = new Set();
    proposalSendContactKeys = new Set();
    proposalDeleteConfirmProposalId = null;
    proposalMarkupMode = false;
    proposalMarkupDockOpen = false;
    proposalMarkupPopover = null;
    proposalActionExpanded = false;
    proposalMeasurementsExpanded = false;
    proposalInternalNotesCollapsed = true;
    projectNoteHistoryClosing = false;
    window.clearTimeout(projectNoteHistoryCloseTimer);
    projectNoteHistoryCloseTimer = 0;
    proposalAgentCollapsed = true;
    proposalAgentPrompt = '';
    stopProposalAgentActivity();
    proposalSigningMode = false;
    proposalSignatureModalState = null;
    resetProposalTabModule();
    resetProjectPhotosTabModule();
    photoViewerOpen = false;
    clearAllPins();
    ['rAddress','rProjectNotes','rLat','rLng','rTechNotes'].forEach((id) => { const el = $('#' + id); if (el) el.value = ''; });
    const custom = $('#rCustom');
    const components = $('#rComps');
    const ccList = $('#rCcList');
    const contactList = $('#rContactList');
    if (custom) custom.value = '0';
    if (components) components.value = '{}';
    if (ccList) ccList.innerHTML = '';
    if (contactList) {
      contactList.innerHTML = '';
      addContactCard({}, { hydrate:true });
    }
    updateModalTitle();
  }

  function readStructureReorderPrefillFromUrl(){
    const params = new URLSearchParams(window.location.search || '');
    const sourceProjectId = String(params.get('reorder_project_id') || params.get('source_project_id') || '').trim();
    if (!sourceProjectId && params.get('prefill') !== 'previous_order') return null;
    let prefill = {};
    const rawPrefill = params.get('prefill_data');
    if (rawPrefill) {
      try {
        const parsed = JSON.parse(rawPrefill);
        if (parsed && typeof parsed === 'object') prefill = parsed;
      } catch (error) {
        console.warn('Could not parse reorder prefill data.', error);
      }
    }
    const projectType = String(params.get('project_type') || prefill.project_type || 'commercial')
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, '-');
    const normalizedType = projectType === 'multi-family' ? 'multifamily' : projectType;
    if (!['commercial', 'multifamily'].includes(normalizedType)) return null;
    const address = String(params.get('address') || prefill.address || '').trim();
    const reportExpediteOption = String(params.get('report_expedite_option') || prefill.report_expedite_option || 'standard_3_6').trim();
    const includeGuttersRaw = params.get('include_gutter_measurements') ?? prefill.include_gutter_measurements ?? false;
    const includeGutters = includeGuttersRaw === true || ['1', 'true', 'yes', 'on'].includes(String(includeGuttersRaw).toLowerCase());
    const pins = Array.isArray(prefill.pins) ? prefill.pins : [];
    return {
      reorder_source_project_id: sourceProjectId,
      workflow_state: 'reorder_prefill',
      address,
      project_type: normalizedType,
      lat: params.get('lat') || prefill.lat || '',
      lng: params.get('lng') || prefill.lng || '',
      pins,
      radius_meters: prefill.radius_meters || '',
      report_mode: prefill.report_mode || '',
      include_gutter_measurements: includeGutters,
      report_expedite_option: reportExpediteOption,
      cc_emails: Array.isArray(prefill.cc_emails) ? prefill.cc_emails : [],
      branding_defaults: prefill.branding_defaults || {},
      metadata: { ...(prefill.metadata || {}), reorder_source_project_id: sourceProjectId },
      measurement: {
        id: sourceProjectId,
        folder: sourceProjectId,
        status: 'rejected_no_coverage',
        include_gutters: includeGutters,
        include_instant: String(prefill.report_mode || '').includes('instant'),
        report_expedite_option: reportExpediteOption
      }
    };
  }

  async function openStructureReorderFromUrl(){
    const prefillProject = readStructureReorderPrefillFromUrl();
    if (!prefillProject) return false;
    if (!hasPerm('order_reports')) {
      showToast((globalThis.PlatformLanguage?.text("project-request","m_60fa00527e725c","Access denied") ?? "Access denied"), (globalThis.PlatformLanguage?.text("project-request","m_2cc90ca1575166","You do not have permission to reorder reports.") ?? "You do not have permission to reorder reports."), false);
      return false;
    }
    const measurementProbe = {
      id: prefillProject.reorder_source_project_id,
      project_id: prefillProject.reorder_source_project_id,
      folder: prefillProject.reorder_source_project_id
    };
    const existingProject = window.Portal.ProjectStore?.findByMeasurement?.(measurementProbe)
      || await window.Portal.ProjectStore?.findByMeasurementRemote?.(measurementProbe).catch(() => null)
      || null;
    const baseProject = existingProject
      ? {
          ...existingProject,
          ...prefillProject,
          id: existingProject.id,
          workflow_state: existingProject.workflow_state || 'reorder_prefill',
          measurement: {
            ...(existingProject.measurement || existingProject.measurement_project || {}),
            ...(prefillProject.measurement || {})
          },
          measurement_project: {
            ...(existingProject.measurement_project || existingProject.measurement || {}),
            ...(prefillProject.measurement || {})
          }
        }
      : prefillProject;
    open(baseProject, { fromReorder: true });
    showToast((globalThis.PlatformLanguage?.text("project-request","m_0cdd1397e79336","Reorder ready") ?? "Reorder ready"), (globalThis.PlatformLanguage?.text("project-request","m_2ab573f546afc1","The previous order settings were pre-filled with the corrected project type.") ?? "The previous order settings were pre-filled with the corrected project type."), true);
    return true;
  }

  function projectOpenId(project = activeBaseProject){
    return String(platformProjectId(project) || project?.id || '').trim();
  }

  function setProjectShellLoading(loading){
    projectShellLoading = !!loading;
    const overlay = $('#rOverlay');
    if (!overlay) return;
    overlay.classList.toggle('project-shell-loading', projectShellLoading);
    overlay.setAttribute('aria-busy', projectShellLoading ? 'true' : 'false');
  }

  function activeModalMatchesProject(projectId){
    const overlay = $('#rOverlay');
    return !!(overlay?.classList.contains('active') && projectId && projectOpenId() === String(projectId || '').trim());
  }

  function applyProjectOpenRouteOptions(options = {}){
    if (Object.prototype.hasOwnProperty.call(options, 'photo')) {
      pendingRoutePhotoId = String(options.photo || '').trim();
    }
    const requestedTab = pendingRoutePhotoId && projectPhotosEnabled()
      ? 'photos'
      : String(options.tab || '').trim();
    if (requestedTab) setActivePreviewTab(requestedTab, {
      syncRoute:options.fromRoute !== true,
      history:options.history || 'push',
      source:options.source || 'project-open'
    });
    if (options.fromRoute) {
      setProjectModalFullscreen(routeFullscreenEnabled(options.projectFullscreen), { syncRoute: false });
    }
  }

  function hydrateOpenProjectContent(project, options = {}, generation = projectOpenGeneration, expectedProjectId = ''){
    if (!project || generation !== projectOpenGeneration) return false;
    if (!$('#rOverlay')?.classList.contains('active')) return false;
    if (expectedProjectId && !activeModalMatchesProject(expectedProjectId)) return false;
    const desiredTab = String(
      (options.photo ? 'photos' : '')
      || options.tab
      || activePreviewTab
      || ''
    ).trim();
    const wasShellLoading = projectShellLoading;
    // The URL shell only knows an ID. Recover the report workflow once the saved draft arrives.
    if (isUnfinishedReportDraft(project)) requestedWorkflow = 'report';
    // Capabilities may have become ready after the routed shell was painted.
    // Create its controls before hydrating values into them.
    ensureProjectModalLeftRegion();
    hydrateFromBaseProject(project, { preferredTab:desiredTab });
    viewingExistingProject = true;
    setProjectShellLoading(false);
    // The routed shell is already the modal the user can see. Keep that exact
    // DOM mounted while the project record hydrates so loading content cannot
    // look like a second modal opening. Shell-only opens never mount app
    // handles, so the existing panels can safely be populated in place.
    if (wasShellLoading) {
      ensureProjectModalAppPanels();
      pruneStaleProjectModalAppPanels();
    }
    if (desiredTab) setActivePreviewTab(desiredTab, { syncRoute:false });
    renderContactContextBar();
    syncProjectViewerTabs();
    renderWorkflowState({ preserveRouteTab:options.fromRoute === true });
    mountProjectModalRegionApps('left');
    mountProjectModalApps();
    syncProjectModalAppActivation();
    const routePatch = options.routePatch && typeof options.routePatch === 'object' ? options.routePatch : {};
    if (!options.fromRoute) {
      syncActiveProjectRoute({
        ...routePatch,
        ...(options.photo ? { photo: options.photo, photoScope: 'project', projectTab: 'photos' } : {})
      });
    }
    if (validPreviewTabs().includes('map') || projectModalAppsShouldInlineMap()) scheduleProjectMapInitialize(project, 80);
    window.dispatchEvent(new CustomEvent('fm:project-modal:hydrated', { detail: { projectId: projectOpenId(project) } }));
    restoreProjectNoteRoute();
    return true;
  }

  function open(baseProject = null, options = {}){
    if (!baseProject && !hasPerm('order_reports')) {
      showToast((globalThis.PlatformLanguage?.text("project-request","m_60fa00527e725c","Access denied") ?? "Access denied"), (globalThis.PlatformLanguage?.text("project-request","m_3e88019828556d","You do not have permission to start this workflow.") ?? "You do not have permission to start this workflow."), false);
      return;
    }
    const continuingCreationSession = !!baseProject
      && newProjectCreationSession
      && projectOpenId(baseProject) === projectOpenId(activeBaseProject);
    const unfinishedReportDraft = !!baseProject && isUnfinishedReportDraft(baseProject);
    const nextRequestedWorkflow = baseProject
      ? (unfinishedReportDraft ? 'report' : 'project')
      : normalizeWorkflow(options.workflow || options.createWorkflow || options.intent);
    projectShellLoading = !!options.shellOnly;
    projectRouteBatching = true;
    ensureUI();
    setMobileProjectNotesOpen(false, { fromRoute:true });
    const overlay = $('#rOverlay');

    // Build the final state and presentation before exposing the overlay. The
    // mobile bottom-sheet class depends on viewingExistingProject, which used
    // to be cleared again by resetNewProjectState() after the overlay was made
    // visible. That produced a fullscreen/stacked paint followed by a second
    // bottom-sheet animation.
    resetNewProjectState();
    requestedWorkflow = nextRequestedWorkflow;
    requestedDocumentType = baseProject ? '' : String(options.documentType || '').trim().toLowerCase();
    requestedDocumentResume = baseProject ? null : (options.resumeDocument && typeof options.resumeDocument === 'object' ? options.resumeDocument : null);
    viewingExistingProject = !!baseProject;
    newProjectCreationSession = !baseProject || continuingCreationSession || unfinishedReportDraft;
    activeContactContext = baseProject ? normalizeContactContext(options.contactContext, baseProject) : null;
    modalInitialProjectIds = new Set((window.Portal.ProjectStore?.cachedIds?.() || []).map(String));
    ensureProjectModalLeftRegion();
    if (baseProject) hydrateFromBaseProject(baseProject, { deferRemoteContent: projectShellLoading, preferredTab:options.tab });
    else preloadFirstReportCheckoutEligibility();
    if (options.fromReorder) applyReorderPrefillState(baseProject || {});
    if (!baseProject) applyRequestedWorkflow();
    pendingRoutePhotoId = String(options.photo || '').trim();
    resetProjectModalAppPanels();
    setProjectModalFullscreen(!!(options.fromRoute && routeFullscreenEnabled(options.projectFullscreen)), { syncRoute: false });
    renderAfterHoursNotice();
    clearTimeout(autosaveDebounceTimer);
    clearTimeout(autosaveToastTimer);
    $('#rSaveToast')?.classList.remove('visible');
    closeSignatureChooser();
    setProjectionMode(hasReportOrdered());
    if (!baseProject) clearProjectRoute({ back:false, source:'new-project' });
    if (options.fromReorder) {
      setActivePreviewTab('map');
    } else {
      setActivePreviewTab(projectDefaultPreviewTab());
    }
    if (options.tab) setActivePreviewTab(options.tab);
    if (pendingRoutePhotoId && projectPhotosEnabled()) setActivePreviewTab('photos');
    renderContactContextBar();
    syncProjectViewerTabs();
    renderWorkflowState({ preserveRouteTab:options.fromRoute === true });
    syncContactsFeatureState();
    syncMobileProjectInfoNavigation();
    syncMobileLeftTray();
    syncMobileDefaultInfoTray();
    applyProjectModalPresentation();
    if (!projectShellLoading) {
      mountProjectModalRegionApps('left');
      syncProjectModalAppActivation();
    }
    renderProjectCustomFields();

    // Reveal one fully prepared shell. Remote project data and tab apps hydrate
    // inside this mounted modal instead of replacing it.
    overlay.classList.toggle('route-initial-open', !!options.fromRoute);
    setProjectShellLoading(projectShellLoading);
    overlay.classList.add('active');
    window.requestAnimationFrame(() => document.getElementById('fmProjectRoutePrecover')?.remove());
    requestModalHandle?.unregister?.();
    requestModalHandle = window.Portal?.modals?.register?.(overlay, {
      id: 'project-modal',
      closeOnEscape: true,
      closeOnBackdrop: false,
      onClose: () => close()
    }) || null;
    projectRouteBatching = false;
    const routePatch = options.routePatch && typeof options.routePatch === 'object' ? options.routePatch : {};
    if (!options.fromRoute) {
      syncActiveProjectRoute({
        ...routePatch,
        ...(pendingRoutePhotoId ? { photo: pendingRoutePhotoId, photoScope: 'project', projectTab: 'photos' } : {})
      }, {
        history:options.history || 'push',
        source:'project-open',
        ownedKeys:['project', 'projectTab']
      });
    }
    if (!projectShellLoading && options.proposalIntent) setTimeout(() => {
      applyProposalOpenIntent(options).catch((error) => console.warn('Proposal open intent failed', error));
    }, 0);
    if (!projectShellLoading && (validPreviewTabs().includes('map') || projectModalAppsShouldInlineMap())) scheduleProjectMapInitialize(baseProject, 120);
    else {
      clearTimeout(projectMapInitTimer);
      projectMapInitTimer = 0;
    }
    setTimeout(() => {
      if (!projectShellLoading && !hasReportOrdered()) {
        const firstContactName = document.querySelector('#rContactList [data-field="name"]');
        (firstContactName || $('#rAddress'))?.focus();
        if (!firstContactName) $('#rAddress')?.select?.();
      }
    }, 40);
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail: { open: true, id: 'request' } }));
  }

  function close(options = {}){
    projectOpenGeneration += 1;
    closeHeaderPropertyTypeMenu();
    closeProjectNoteVisibilityMenu();
    routeRestoreInFlight = false;
    routeRestorePromise = null;
    routeRestoreProjectId = '';
    projectShellLoading = false;
    clearTimeout(projectMapInitTimer);
    projectMapInitTimer = 0;
    clearTimeout(projectModalFullscreenTimer);
    projectModalFullscreenTimer = null;
    requestModalHandle?.unregister?.();
    requestModalHandle = null;
    closeContactPicker();
    closeContactActionMenu();
    activeContactContext = null;
    renderContactContextBar();
    setProjectPhotoFocus(false);
    pendingRoutePhotoId = '';
    if (!options.skipHistory && !options.fromRoute) {
      const closingRoute = window.Portal?.routeState?.get?.() || {};
      projectRouteClosePendingId = String(closingRoute.project || activeProjectRouteId() || '').trim();
      const closeResult = clearProjectRoute();
      if (!closeResult?.backed) projectRouteClosePendingId = '';
    }
    stopProposalAgentActivity();
    clearCancellationCountdown();
    stopReportExpediteMinuteRefresh();
    closeAddonInfoSurfaces();
    projectTodoController?.destroy?.();
    projectTodoController = null;
    projectTodoLoadedFor = '';
    const discarded = discardEmptyNewProjectDraft();
    disposeInstantMeasurement();
    mobileLeftTrayOpen = false;
    mobileDefaultInfoTrayOpen = false;
    setMobileProjectNotesOpen(false, { fromRoute:true });
    const ov = $('#rOverlay');
    if (ov) {
      ov.classList.remove('active', 'fullscreen', 'fullscreen-transitioning', 'route-initial-open', 'project-shell-loading', 'proposal-workspace', 'proposal-list-mode', 'proposal-edit-mode', 'proposal-send-mode', 'proposal-builder-mode', 'left-override', 'mobile-left-tray-mode', 'mobile-left-tray-open', 'mobile-default-info-tray-mode', 'mobile-default-info-tray-open', 'mobile-default-info-tray-entering', 'mobile-default-info-tray-leaving', 'mobile-default-info-tray-leaving-active', 'mobile-default-info-tray-resetting', 'mobile-project-notes-open', 'materials-workspace', 'money-workspace', 'schedule-workspace', 'entitlement-left-none', 'entitlement-mobile-fullscreen', 'entitlement-tab-icons', 'entitlement-hide-fullscreen');
      ov.setAttribute('aria-busy', 'false');
      delete ov.dataset.leftOverrideTab;
      delete ov.dataset.projectLeftMode;
      delete ov.dataset.projectTabMode;
    }
    projectModalFullscreen = false;
    proposalTabModule()?.deactivate?.();
    projectPhotosTabModule()?.deactivate?.();
    (window.Portal?.modules?.projectDocsTab || window.Portal?.ProjectDocsTab)?.deactivate?.();
    if (discarded) setTimeout(() => showToast((globalThis.PlatformLanguage?.text("project-request","m_b371ac5dc6d019","Empty project discarded") ?? "Empty project discarded"), (globalThis.PlatformLanguage?.text("project-request","m_e424d47363bdd1","No project was saved.") ?? "No project was saved."), true), 0);
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail: { open: false, id: 'request' } }));
  }

  function setPhotos(photos){
    projectPhotos = (photos || []).map(normalizePhoto).filter((photo) => photo.src);
    syncProjectPhotosFromLibrary();
    activePhotoIndex = 0;
    if (activeBaseProject) {
      activeBaseProject.photos = projectPhotos.map(serializablePhoto);
      activeBaseProject.thumbnail_photo_id = projectPhotoId(projectThumbnailPhoto());
      activeBaseProject.thumbnail_photo = serializablePhoto(projectThumbnailPhoto());
      persistActiveBaseProject();
    }
    renderPhotoGallery();
    queueAutosaveNotice();
  }

  function updateButtonVisibility(){
    const btn = document.getElementById('btnNewReq');
    if (!btn) return;
    btn.style.display = hasPerm('order_reports') ? '' : 'none';
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnNewReq');
    if (btn) btn.addEventListener('click', (event) => {
      event.preventDefault();
      open();
    });
    window.addEventListener('fm:new-project-workflow', (event) => {
      const workflow = event?.detail?.workflow || 'project';
      if (workflow === 'contact' && window.Portal?.modules?.contacts?.open) {
        window.Portal.modules.contacts.open();
        return;
      }
      open(null, { workflow, documentType: event?.detail?.documentType || '' });
    });
    loadBranchPresentationStyle().catch(() => null);
    loadBranchProposalTemplates().catch(() => null);
    loadBranchProjectConfig().catch(() => null);
    updateButtonVisibility();
    window.setTimeout(() => openStructureReorderFromUrl(), 250);
  });

  window.addEventListener('fm:perms:updated', updateButtonVisibility);
  window.addEventListener('fm:custom-fields:definitions-loaded', () => {
    if ($('#rOverlay')?.classList.contains('active')) renderProjectCustomFields();
  });
  window.addEventListener('fm:custom-fields:definitions-updated', () => {
    if ($('#rOverlay')?.classList.contains('active')) renderProjectCustomFields();
  });
  window.addEventListener('fm:project-config:updated', (event) => {
    branchProjectConfig = normalizeProjectConfig(event?.detail || branchProjectConfig);
    window.PlatformCelebrations?.configure?.({ mode: branchProjectConfig.celebrations_mode });
    updateModalTitle();
  });
  window.addEventListener('fm:terminology:updated', () => {
    if (projectViewer) syncProjectViewerTabs();
  });
  window.addEventListener('fm:theme:updated', () => {
    if (proposalsEnabled() && proposals.length && activePreviewTab === 'proposal') {
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
    }
  });
  window.addEventListener('resize', () => {
    if (proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal' && proposalWorkspaceMode === 'edit') {
      positionProposalWorkspaceChrome();
    }
  });
  window.addEventListener('fm:proposal-settings:updated', (event) => {
    if (event?.detail && typeof event.detail === 'object') branchPresentationStyle = event.detail;
    else loadBranchPresentationStyle().catch(() => null);
    if (proposalsEnabled() && activePreviewTab === 'proposal' && !proposalSettingsPanelOpen) {
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
    }
  });
  window.Portal.modules?.pricebook?.subscribe?.(() => {
    proposals.forEach((proposal) => syncProposalPricebookItems(proposal));
    if (proposalsEnabled() && proposals.length && activePreviewTab === 'proposal') {
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
    }
  });
  window.Portal.modules = window.Portal.modules || {};
  function mergeProjectForViewing(base = {}, incoming = {}){
    if (!base || base === incoming) return base || incoming;
    const merged = { ...base };
    const keepBetterArray = (key) => {
      const baseValue = Array.isArray(base?.[key]) ? base[key] : [];
      const incomingValue = Array.isArray(incoming?.[key]) ? incoming[key] : [];
      if (incomingValue.length) merged[key] = incomingValue;
      else if (baseValue.length) merged[key] = baseValue;
      else if (Object.prototype.hasOwnProperty.call(incoming || {}, key)) merged[key] = incomingValue;
    };
    const keepIncoming = (key) => {
      const value = incoming?.[key];
      if (value === undefined || value === null || value === '') return;
      if (['measurement_project_id', 'project_id', 'folder'].includes(key) && localIsPlatformProjectId(value)) return;
      merged[key] = value;
    };
    [
      'status',
      'has_report',
      'report_url',
      'pdf_url',
      'summary_url',
      'xml_url',
      'instant_url',
      'instant_pdf_url',
      'report_mode',
      'measurement_project_id',
      'project_id',
      'folder',
      'title',
      'project_title',
      'project_name',
      'projectName',
      'customer_name',
      'customerName',
      'primary_contact_name',
      'customer_email',
      'primary_contact_email',
      'customer_phone',
      'primary_contact_phone',
      'address',
      'project_type',
      'work_projection',
      'lifecycle'
    ].forEach(keepIncoming);
    ['contacts', 'photos', 'proposals', 'events'].forEach(keepBetterArray);
    if (incoming.manifest && typeof incoming.manifest === 'object') {
      merged.manifest = {
        ...(base.manifest && typeof base.manifest === 'object' ? base.manifest : {}),
        ...incoming.manifest
      };
    }
    if (incoming.artifacts && typeof incoming.artifacts === 'object') {
      merged.artifacts = {
        ...(base.artifacts && typeof base.artifacts === 'object' ? base.artifacts : {}),
        ...incoming.artifacts
      };
    }
    const baseMeasurement = (base.measurement_project && typeof base.measurement_project === 'object')
      ? base.measurement_project
      : ((base.measurement && typeof base.measurement === 'object') ? base.measurement : {});
    const incomingMeasurement = (incoming.measurement_project && typeof incoming.measurement_project === 'object')
      ? incoming.measurement_project
      : ((incoming.measurement && typeof incoming.measurement === 'object') ? incoming.measurement : {});
    const mergedMeasurement = { ...baseMeasurement, ...incomingMeasurement };
    if (Object.keys(mergedMeasurement).length) {
      merged.measurement = mergedMeasurement;
      merged.measurement_project = mergedMeasurement;
    }
    merged.id = base.id || incoming.id || merged.id;
    merged.workflow_state = base.workflow_state || incoming.workflow_state || merged.workflow_state;
    return merged;
  }

  function platformProjectId(project = {}){
    project = project || {};
    return projectText(project.platform_project_id, project.base_project_id, project.id);
  }

  function projectFromPlatformDocument(document){
    const data = document?.data && typeof document.data === 'object' ? document.data : null;
    if (!data) return null;
    const documentId = projectText(document.id);
    const id = projectText(data.platform_project_id, data.base_project_id, documentId, data.id);
    const contact = projectPrimaryContactAlias(data);
    const title = projectText(data.title, data.project_title, data.project_name, data.projectName, data.name);
    return {
      ...data,
      id,
      platform_project_id: projectText(data.platform_project_id, id),
      base_project_id: projectText(data.base_project_id, id),
      title: title || projectText(data.title),
      project_title: projectText(data.project_title, title),
      customer_name: projectText(data.customer_name, data.customerName, contact.name),
      primary_contact_name: projectText(data.primary_contact_name, contact.name),
      customer_email: projectText(data.customer_email, contact.email),
      primary_contact_email: projectText(data.primary_contact_email, contact.email),
      customer_phone: projectText(data.customer_phone, contact.phone),
      primary_contact_phone: projectText(data.primary_contact_phone, contact.phone)
    };
  }

  async function hydratePlatformProjectForOpen(project = {}){
    const id = platformProjectId(project);
    if (!localIsPlatformProjectId(id) || !window.PlatformAPI?.projects?.get) return project;
    const oid = projectOrgId();
    if (!oid) return project;
    const result = await window.PlatformAPI.projects.get(oid, id).catch(() => null);
    const remote = projectFromPlatformDocument(result?.document);
    if (!remote) return project;
    return mergeProjectForViewing(remote, project);
  }

  function localIsPlatformProjectId(value){
    return /^(project|base|__optimistic)_/i.test(String(value || '').trim());
  }

  function looksLikePlatformProjectRecord(project = {}){
    if (!project || typeof project !== 'object') return false;
    if (String(project.workflow_state || '').trim()) return true;
    if (localIsPlatformProjectId(project.platform_project_id) || localIsPlatformProjectId(project.base_project_id) || localIsPlatformProjectId(project.id)) return true;
    if (Array.isArray(project.photos) || Array.isArray(project.proposals) || Array.isArray(project.events) || Array.isArray(project.contacts)) return true;
    return [
      'title',
      'project_title',
      'project_name',
      'projectName',
      'work_projection',
      'project_notes',
      'customer',
      'customer_name',
      'primary_contact_name'
    ].some((key) => project[key] !== undefined && project[key] !== null && project[key] !== '');
  }

  function looksLikeMeasurementOnlyRecord(project = {}){
    if (!project || typeof project !== 'object' || looksLikePlatformProjectRecord(project)) return false;
    const measurement = (project.measurement_project && typeof project.measurement_project === 'object')
      ? project.measurement_project
      : ((project.measurement && typeof project.measurement === 'object') ? project.measurement : project);
    return [
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      project.project_id,
      project.folder,
      project.report_url,
      project.pdf_url,
      project.summary_url,
      project.xml_url,
      project.status
    ].some((value) => String(value || '').trim());
  }

  async function openProject(project, options = {}){
    const requestedProjectId = projectOpenId(project);
    if (requestedProjectId && activeModalMatchesProject(requestedProjectId) && !options.forceRefresh) {
      applyProjectOpenRouteOptions(options);
      return activeBaseProject;
    }
    const generation = ++projectOpenGeneration;
    const useMeasurementResolver = looksLikeMeasurementOnlyRecord(project);
    const immediate = useMeasurementResolver
      ? (window.Portal.ProjectStore?.ensureFromMeasurement?.(project) || project)
      : project;
    const base = useMeasurementResolver ? mergeProjectForViewing(immediate, project) : immediate;
    open(base, { ...options, history:options.history || (options.fromRoute ? 'replace' : 'push') });
    try {
      const resolved = !useMeasurementResolver
        ? await hydratePlatformProjectForOpen(project)
        : (await window.Portal.ProjectStore?.ensureFromMeasurementAsync?.(project) || immediate);
      const hydrated = useMeasurementResolver ? mergeProjectForViewing(resolved, project) : resolved;
      if (hydrated !== base || projectShellLoading) {
        hydrateOpenProjectContent(hydrated, options, generation, projectOpenId(base));
      }
      return hydrated;
    } catch (error) {
      if (generation === projectOpenGeneration) setProjectShellLoading(false);
      throw error;
    }
  }

  async function restoreRouteState(){
    const route = window.Portal?.routeState?.get?.() || {};
    const projectId = String(route.project || '').trim();
    if (projectRouteClosePendingId) {
      if (!projectId) projectRouteClosePendingId = '';
      else if (projectId === projectRouteClosePendingId) return;
      else projectRouteClosePendingId = '';
    }
    if (!route.project || route.photoScope === 'feed') {
      if ($('#rOverlay')?.classList.contains('active') && viewingExistingProject) close({ fromRoute:true });
      return;
    }
    const openOptions = {
      tab: route.photo ? 'photos' : (route.projectTab || route.tab),
      photo: route.photo,
      projectFullscreen: route.projectFullscreen,
      fromRoute: true
    };
    if (activeModalMatchesProject(projectId)) {
      applyProjectOpenRouteOptions(openOptions);
      if (routeRestorePromise) return routeRestorePromise;
      if (!projectShellLoading) return activeBaseProject;
    }
    if (routeRestoreInFlight && routeRestoreProjectId === projectId && routeRestorePromise) return routeRestorePromise;
    const generation = activeModalMatchesProject(projectId) ? projectOpenGeneration : ++projectOpenGeneration;
    if (!activeModalMatchesProject(projectId)) {
      const cached = window.Portal.ProjectStore?.get?.(projectId) || null;
      const seed = cached || {
        id: projectId,
        platform_project_id: projectId,
        base_project_id: projectId,
        title: (globalThis.PlatformLanguage?.text("project-request","m_4de8a87782a9e4","Loading project…") ?? "Loading project…"),
        __projectShellLoading: true
      };
      open(seed, { ...openOptions, shellOnly: !cached });
    }
    routeRestoreInFlight = true;
    routeRestoreProjectId = projectId;
    const restorePromise = Promise.resolve(window.Portal?.routeState?.resolveProject?.(projectId))
      .then((project) => {
        if (!project) return null;
        hydrateOpenProjectContent(project, openOptions, generation, projectId);
        return project;
      })
      .catch((error) => {
        console.warn('Could not restore project route', error);
        return null;
      })
      .finally(() => {
        if (routeRestorePromise !== restorePromise) return;
        routeRestoreInFlight = false;
        routeRestorePromise = null;
      });
    routeRestorePromise = restorePromise;
    return restorePromise;
  }

  function refreshProjectModalForAppFlags(){
    if (!document.querySelector('#rOverlay')) return;
    const restoredLeftRegion = ensureProjectModalLeftRegion();
    // Only hydrate newly created controls. Repeated settings updates must not
    // overwrite edits in an already populated project form.
    if (restoredLeftRegion && activeBaseProject) {
      hydrateFromBaseProject(activeBaseProject, { deferRemoteContent:true });
    }
    syncContactsFeatureState();
    if (projectShellLoading) {
      ensureProjectModalAppPanels();
      syncProjectViewerTabs();
      applyProjectModalPresentation();
      return;
    }
    ensureProjectModalAppPanels();
    renderProjectStageBar();
    const route = window.Portal?.routeState?.get?.() || {};
    const routedProjectId = String(route.project || '').trim();
    const routedTab = routedProjectId && routedProjectId === projectOpenId()
      ? String(route.projectTab || '').trim()
      : '';
    const availableTabs = validPreviewTabs();
    if (routedTab && availableTabs.includes(routedTab)) {
      setActivePreviewTab(routedTab, { syncRoute:false });
    } else if (!availableTabs.includes(activePreviewTab)) {
      setActivePreviewTab(projectDefaultPreviewTab(), { syncRoute:!routedTab });
    }
    renderWorkflowState({ preserveRouteTab:!!routedTab });
    window.Portal?.modules?.projectMap?.renderOverview?.();
    syncProjectViewerTabs();
    applyProjectModalPresentation();
    mountProjectModalRegionApps('left');
    mountProjectModalApps();
    syncProjectModalAppActivation();
  }

  function ensureProjectRequestStyles(){
    injectCSS('request', css);
  }

  /** My Projects → Drafts: reopen the doc-first session for a standalone
   *  document (editor on the right, attach-a-project picker on the left). */
  function openDocumentDraft(docRecord){
    if (!docRecord || typeof docRecord !== 'object' || !String(docRecord.id || '').trim()) return;
    open(null, {
      workflow: 'document',
      documentType: String(docRecord.document_type || '').trim().toLowerCase(),
      resumeDocument: docRecord
    });
  }

  window.Portal.modules.request = { open, openProject, openDocumentDraft, close, setPhotos, restoreRouteState, ensureStyles: ensureProjectRequestStyles, ensureProposalContext: installProposalContextAccessors };
  window.Portal?.navigation?.registerSchema?.('projectFullscreen', { history:'replace', scope:{ project:true } });
  window.Portal?.navigation?.registerSchema?.('projectNote', { history:'replace', scope:{ project:true } });
  window.Portal?.navigation?.registerSchema?.('projectNotes', { history:'push', values:['1'], default:'', scope:{ project:true } });
  window.Portal?.navigation?.registerHandler?.('project-modal', {
    priority:200,
    immediate:true,
    apply: () => restoreRouteState()
  });
  window.Portal?.navigation?.registerHandler?.('project-note-target', {
    priority:700,
    apply: () => restoreProjectNoteRoute()
  });
  window.Portal?.navigation?.registerHandler?.('project-mobile-notes-route', {
    priority:720,
    apply: (route) => {
      if (!activeModalMatchesProject(route.project)) return false;
      setMobileProjectNotesOpen(route.projectNotes === '1', { fromRoute:true });
      return true;
    }
  });
  window.addEventListener('fm:platform-session:updated', () => restoreRouteState());
  window.addEventListener('fm:work:updated', () => {
    if (!activeBaseProject?.id) return;
    loadProjectWorkPlans({ refresh: true }).catch(() => null);
    mountProjectTodoList({ force: true });
  });
  window.addEventListener('fm:app-flags:updated', () => {
    restoreRouteState();
    refreshProjectModalForAppFlags();
  });
  window.addEventListener('fm:capabilities:updated', () => refreshProjectModalForAppFlags());
  window.addEventListener('fm:app-entitlements:updated', (event) => {
    if (event?.detail?.source !== 'device') refreshProjectModalForAppFlags();
  });
  window.addEventListener('fm:device:updated', () => refreshProjectModalForAppFlags());
  window.setTimeout(() => restoreRouteState(), 0);
  window.setTimeout(() => restoreRouteState(), 900);
})();
