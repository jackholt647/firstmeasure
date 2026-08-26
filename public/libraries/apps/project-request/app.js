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
    residential: { label: 'Residential', icon: 'fa-house', price: PRICE_RESIDENTIAL },
    commercial: { label: 'Commercial', icon: 'fa-building', price: PRICE_COMMERCIAL },
    multifamily: { label: 'Multifamily', icon: 'fa-city', price: PRICE_MULTIFAMILY },
  };
  const REPORT_MODE_META = {
    full: { label: 'Standard' },
    both: { label: 'Standard + Instant Report' },
  };
  const FALLBACK_REPORT_EXPEDITE_OPTIONS = [
    { key: 'standard_3_6', label: 'Less than 7 hrs', startMinutes: 240, endMinutes: 420, productionDeadlineMinutes: 240, estimatedWaitMinutes: 240, busyLabel: "We aren't very busy", residentialPrice: 7, rushDelta: 0, expedited: false },
    { key: 'rush_1_3', label: 'Less than 3 hrs rush', startMinutes: 60, endMinutes: 180, productionDeadlineMinutes: 120, residentialPrice: 8.15, rushDelta: 1.15, expedited: true },
    { key: 'rush_under_1', label: 'Less than 1 hr rush', startMinutes: 50, endMinutes: 60, productionDeadlineMinutes: 50, residentialPrice: 10.45, rushDelta: 3.45, expedited: true },
  ];
  const PROJECT_CONFIG_MODULE_ID = 'project_configuration';
  const FALLBACK_PROJECT_STAGES = [
    { id: 'new_lead', label: 'New Lead' },
    { id: 'appointment_scheduled', label: 'Appointment Scheduled' },
    { id: 'drafting_proposal', label: 'Drafting Proposal' },
    { id: 'proposal_sent', label: 'Proposal Sent' },
    { id: 'newly_sold', label: 'Sold' },
    { id: 'project_started', label: 'Project Started' },
    { id: 'in_progress', label: 'In Progress' },
    { id: 'completed', label: 'Completed' },
    { id: 'cancelled', label: 'Cancelled' },
    { id: 'lost', label: 'Lost' }
  ];
  const INITIAL_PROJECT_STAGE_ID = 'new_lead';
  const PROPOSAL_COVER_DEFAULT_SIZE = 380;
  const PROPOSAL_THEMES = {
    margin: { label: 'Margin' },
    triangles: { label: 'Triangles' },
    clean: { label: 'Clean' },
  };
  const PRESENTATION_STYLE_MODULE_ID = 'presentation_style';
  const PROPOSAL_TEMPLATES_MODULE_ID = 'proposal_templates';
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
      description: 'A photo-forward proposal for jobs where visuals and simple pricing matter most.',
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

  let addressSelected = false;
  let locationConfirmed = false;
  let selectedType = null;
  let structurePinLimitNoticeActive = false;
  let typePickerExpanded = false;
  let reportSelection = null;
  let mobileOrderPage = 'location';
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
  let viewingExistingProject = false;
  let reportOrderState = null;
  let requestedWorkflow = 'project';
  let activeContactContext = null;
  let projectTodoController = null;
  let projectTodoLoadedFor = '';
  let reorderMeasurementProjectId = '';
  let reorderSourceCanReopenInPlace = false;
  let primaryContactIndex = 0;
  let contactPickerOptions = [];
  let contactPickerLoadPromise = null;
  let branchProjectConfig = { title_mode: 'customer_name' };
  let branchStageConfig = null;
  let branchStageConfigPromise = null;
  let modalInitialProjectIds = new Set();
  let requestModalHandle = null;
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
    .r-overlay{position:fixed;inset:0;z-index:2147483100;background:rgba(11,16,24,.58);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;opacity:0;transition:opacity .22s ease;width:var(--fm-visual-vw,100vw);height:var(--fm-visual-vh,100vh);overflow:hidden}
    .r-overlay.active{display:flex;opacity:1}
    .r-win{width:min(1720px,96vw);height:min(1180px,calc(var(--fm-visual-vh,100vh) * .92));background:#ffffff;border-radius:28px;box-shadow:0 36px 120px rgba(15,23,42,.28);overflow:hidden;display:flex;position:relative;animation:rUp .26s cubic-bezier(.22,1,.36,1)}
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
    .r-win.photo-focus .r-left{margin-left:max(-460px,-46%);transform:translateX(0);box-shadow:28px 0 60px rgba(15,23,42,.08)}
    .r-win.photo-focus .r-right{flex-basis:100%}
    .r-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-shrink:0;padding:0 0 4px;background:#ffffff}
    .r-scroll{flex:1;overflow:auto;padding-right:2px;min-height:0}
    .r-scroll-cue{position:absolute;left:calc(min(460px,46%) / 2);bottom:16px;transform:translateX(-50%);z-index:40;display:none;align-items:center;gap:7px;padding:8px 11px;border:1px solid rgba(15,23,42,.10);border-radius:999px;background:rgba(17,24,39,.86);color:#fff;font-size:11px;font-weight:1000;box-shadow:0 12px 28px rgba(15,23,42,.18);cursor:pointer;animation:rCueFloat 1.4s ease-in-out infinite}
    .r-scroll-cue.visible{display:flex}
    @keyframes rCueFloat{0%,100%{translate:0 0}50%{translate:0 4px}}
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
    .r-title-wrap{width:100%;min-width:0}
    .r-title{margin:0;font-size:22px;font-weight:1000;letter-spacing:-.4px;color:#101828}
    .r-title-input{width:100%;border:1px solid rgba(15,23,42,.12);border-radius:14px;padding:10px 12px;font:inherit;font-size:20px;font-weight:1000;letter-spacing:-.4px;color:#101828;outline:none}
    .r-title-input:focus{border-color:rgba(var(--primary-rgb,217,48,37),.45);box-shadow:0 0 0 4px rgba(var(--primary-rgb,217,48,37),.10)}
    .r-sub{margin:8px 0 0;color:#667085;font-weight:800;font-size:12px;line-height:1.55;max-width:44ch}
    .r-sub:empty{display:none}
    .r-stagebar{flex-shrink:0;margin:-2px 0 2px;position:relative}
    .r-stagebar[hidden]{display:none!important}
    .r-stage-track{overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:2px 1px 4px;scroll-behavior:smooth}
    .r-stage-track::-webkit-scrollbar{display:none}
    .r-stage-list{display:flex;align-items:center;gap:6px;min-width:max-content}
    .r-stage-pill{display:inline-flex;align-items:center;gap:5px;max-width:142px;min-height:25px;padding:4px 8px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:#f8fafc;color:#98a2b3;font-size:10.5px;font-weight:900;line-height:1;white-space:nowrap;letter-spacing:0}
    .r-stage-pill span{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .r-stage-pill i{font-size:9.5px;flex-shrink:0}
    .r-stage-pill.done{background:#ecfdf3;border-color:rgba(22,163,74,.18);color:#15803d}
    .r-stage-pill.current{background:#fffbeb;border-color:#fde68a;color:#92400e;font-weight:1000;box-shadow:inset 0 0 0 1px rgba(245,158,11,.12)}
    .r-stage-pill.upcoming{background:#f8fafc;border-color:rgba(15,23,42,.07);color:#9aa4b2}
    .r-stage-arrow{color:#cbd5e1;font-size:9px;flex:0 0 auto}
    .r-stagebar::before,.r-stagebar::after{content:'';position:absolute;top:0;bottom:0;width:18px;pointer-events:none;z-index:2}
    .r-stagebar::before{left:0;background:linear-gradient(90deg,#fff,rgba(255,255,255,0))}
    .r-stagebar::after{right:0;background:linear-gradient(270deg,#fff,rgba(255,255,255,0))}
    .modal-close-x{position:absolute;top:14px;right:14px;width:42px;height:42px;border-radius:14px;background:rgba(255,255,255,.88);backdrop-filter:blur(14px);border:1px solid rgba(15,23,42,.08);z-index:60;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;color:#344054;transition:.18s ease}
    .modal-close-x:hover{background:#fff;color:#101828;transform:translateY(-1px)}
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
    .r-step.is-condensed #rTypeGroup{display:none}
    .r-step.is-condensed #rTypePill{display:flex}
    .r-overlay.report-ordered #rTypeGroup{display:none}
    .r-overlay.report-ordered #rTypePill{display:flex}
    #rStepAddress{padding-top:8px}
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
    .r-workflow-todos{min-height:92px}
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
    .r-bottom-notes{transition:padding .18s ease}
    .r-bottom-notes-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .r-bottom-notes-head label{min-width:0}
    .r-bottom-notes-toggle{border:1px solid rgba(15,23,42,.1);background:#fff;color:#667085;border-radius:10px;width:32px;height:32px;display:none;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease;flex-shrink:0}
    .r-bottom-notes-toggle:hover{color:var(--primary-readable,var(--primary,#d93025));border-color:rgba(var(--primary-rgb,217,48,37),.22)}
    .r-bottom-notes-toggle i{transition:transform .18s ease}
    .r-bottom-notes textarea{min-height:82px}
    .r-overlay.proposal-workspace .r-bottom-notes{gap:8px}
    .r-overlay.proposal-workspace .r-bottom-notes-toggle{display:flex}
    .r-overlay.proposal-workspace .r-bottom-notes.collapsed textarea{display:none}
    .r-overlay.proposal-workspace .r-bottom-notes.collapsed .r-bottom-notes-toggle i{transform:rotate(180deg)}
    .r-proposal-agent{display:none;border-bottom:1px solid rgba(15,23,42,.08);padding-bottom:10px;gap:8px}
    .r-overlay.proposal-workspace .r-proposal-agent{display:flex}
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
    .r-tabbar{display:flex;gap:8px;padding:16px 18px 10px}
    .r-tabbar.single-tab{display:none}
    .r-tab{border:1px solid rgba(15,23,42,.1);background:rgba(255,255,255,.7);backdrop-filter:blur(10px);border-radius:14px;padding:10px 14px;font-size:12px;font-weight:1000;color:#344054;display:inline-flex;align-items:center;gap:8px;cursor:pointer;transition:.18s ease}
    .r-tab.active{background:#fff;border-color:rgba(var(--primary-rgb,217,48,37),.24);color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 16px 32px rgba(15,23,42,.08)}
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
    .r-preview{flex:1;position:relative;padding:16px 18px 18px}
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
    .r-photo-wrap{height:100%;padding:18px;background:#f8fafc;border-radius:24px;overflow:hidden}
    .r-photo-upload{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 14px;border-radius:12px;border:1px dashed rgba(15,23,42,.18);background:#fff;color:#475467;font-size:12px;font-weight:1000;cursor:pointer;transition:.14s ease}
    .r-photo-upload:hover{border-color:rgba(var(--primary-rgb,217,48,37),0.35);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),0.03)}
    .r-photo-empty{height:100%;border:2px dashed rgba(15,23,42,.14);border-radius:24px;background:#ffffff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#667085;text-align:center;padding:28px;transition:.16s ease}
    .r-photo-empty.dragover,.r-photo-stage.dragover,.r-photo-strip.dragover{border-color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),0.04)}
    .r-photo-empty i{width:54px;height:54px;border-radius:18px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px}
    .r-photo-empty strong{font-size:16px;color:#111827}
    .r-photo-empty-tile{width:min(108px,30vw);aspect-ratio:1/1;border:1px dashed rgba(15,23,42,.24);border-radius:20px;background:#f8fafc;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.16s ease}
    .r-photo-empty-tile:hover{background:#f1f5f9;border-color:rgba(15,23,42,.38)}
    .r-photo-empty-plus{font-size:38px;line-height:1;color:#98a2b3;font-weight:300}
    .r-photo-gallery{height:100%;display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:16px;min-height:0}
    .r-photo-gallery.is-grid{display:flex;flex-direction:column}
    .r-photo-grid-only{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;overflow:auto;padding-right:4px}
    .r-photo-gallery-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
    .r-photo-gallery-head strong{font-size:13px;font-weight:1000;color:#111827}
    .r-photo-gallery.viewer{display:flex;flex-direction:column;gap:12px}
    .r-photo-viewer-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .r-photo-viewer-title{flex:1;text-align:center;font-size:13px;font-weight:1000;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .r-photo-stage{position:relative;border-radius:24px;background:#ffffff;border:1px solid rgba(15,23,42,.08);overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:0;transition:.16s ease;flex:1}
    .r-photo-stage img,.r-photo-stage video{width:100%;height:100%;object-fit:contain;background:#101828}
    .r-photo-nav{position:absolute;top:50%;transform:translateY(-50%);width:42px;height:42px;border-radius:999px;border:1px solid rgba(15,23,42,.12);background:rgba(255,255,255,.92);display:flex;align-items:center;justify-content:center;cursor:pointer;color:#344054;box-shadow:0 12px 24px rgba(15,23,42,.12)}
    .r-photo-nav:hover{background:#fff}
    .r-photo-nav.prev{left:14px}
    .r-photo-nav.next{right:14px}
    .r-photo-count{position:absolute;left:16px;bottom:16px;padding:8px 12px;border-radius:999px;background:rgba(17,24,39,.78);color:#fff;font-size:11px;font-weight:1000}
    .r-photo-strip{border-radius:20px;background:#ffffff;border:1px solid rgba(15,23,42,.08);padding:10px;display:flex;gap:10px;overflow:auto;transition:.16s ease}
    .r-photo-thumb{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;padding:0;cursor:pointer;transition:.16s ease;display:block;overflow:hidden}
    .r-photo-strip .r-photo-thumb{min-width:104px;max-width:104px}
    .r-photo-thumb:hover{transform:translateY(-1px);box-shadow:0 12px 20px rgba(15,23,42,.08)}
    .r-photo-thumb.active{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),0.12)}
    .r-photo-thumb img,.r-photo-thumb video{width:100%;aspect-ratio:1/1;object-fit:cover;background:#eef2f6;display:block}
    .r-photo-thumb{position:relative}.r-photo-video-placeholder{width:100%;aspect-ratio:1/1;background:#101828;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px}.r-photo-video-badge{position:absolute;right:8px;bottom:8px;width:28px;height:28px;border-radius:999px;background:rgba(15,23,42,.76);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 8px 16px rgba(15,23,42,.16);pointer-events:none}
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
    .r-proposal-pages{display:flex;flex-direction:column;gap:18px;align-items:center}
    .r-proposal-empty{width:min(560px,100%);margin:auto;border:1px dashed rgba(15,23,42,.16);border-radius:18px;background:#fff;padding:34px;text-align:center;color:#667085;font-size:13px;font-weight:850}
    .r-proposal-empty i{display:block;font-size:24px;margin-bottom:10px;color:#98a2b3}
    .r-proposal-page-stack{position:relative;flex:0 0 auto;width:min(820px,100%);aspect-ratio:8.5/11;transition:transform .34s cubic-bezier(.22,1,.36,1)}
    .r-proposal-page-stack.insert-after{z-index:90;transform:translateY(-96px);animation:rProposalSplitUp .34s cubic-bezier(.22,1,.36,1)}
    .r-proposal-page-stack.insert-after + .r-proposal-page-stack{z-index:1;transform:translateY(96px);animation:rProposalSplitDown .34s cubic-bezier(.22,1,.36,1)}
    @keyframes rProposalSplitUp{from{transform:translateY(0)}to{transform:translateY(-96px)}}
    @keyframes rProposalSplitDown{from{transform:translateY(0)}to{transform:translateY(96px)}}
    .r-proposal-page{position:relative;overflow:hidden;width:100%;height:100%;min-height:0;max-height:100%;aspect-ratio:8.5/11;box-sizing:border-box;background:#fff;border:1px solid rgba(15,23,42,.08);box-shadow:0 18px 42px rgba(15,23,42,.14);padding:38px 42px;display:flex;flex-direction:column;gap:18px;font-family:var(--proposal-font-family,"Montserrat",Arial,sans-serif)}
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
    .r-proposal-cover-image-grid img{width:100%;height:100%;object-fit:cover;display:block;border-radius:16px}
    .r-proposal-cover-image-grid.count-1 img{transform-origin:center center}
    .r-proposal-cover-image-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:42px;color:#98a2b3;z-index:1}
    .r-proposal-cover-image-badge{position:absolute;right:12px;bottom:12px;padding:7px 10px;border-radius:999px;background:rgba(255,255,255,.92);border:1px solid rgba(15,23,42,.08);font-size:10px;font-weight:1000;color:#344054;z-index:2;opacity:0;transform:translateY(4px);transition:.18s ease}
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
    .r-overlay.proposal-workspace #rStepCustomer,
    .r-overlay.proposal-workspace #rStepAddress,
    .r-overlay.proposal-workspace #rStepType,
    .r-overlay.proposal-workspace #rStepReport,
    .r-overlay.proposal-workspace #rStepRoof{display:none!important}
    .r-proposal-listing{display:flex;flex-direction:column;gap:10px;min-height:calc(100vh - 320px)}
    .r-proposal-workspace-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:2px}
    .r-proposal-workspace-head > div{min-width:0;display:flex;flex-direction:column;gap:2px}
    .r-proposal-workspace-head strong{font-size:13px;font-weight:1000;color:#111827}
    .r-proposal-workspace-head span{font-size:10px;font-weight:900;color:#667085}
    .r-proposal-settings-link{height:32px;border:1px solid rgba(15,23,42,.1);background:#fff;color:#475467;border-radius:10px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:11px;font-weight:1000;cursor:pointer;transition:.16s ease;white-space:nowrap}
    .r-proposal-settings-link:hover{border-color:rgba(var(--primary-rgb,217,48,37),.24);color:var(--primary-readable,var(--primary,#d93025));background:rgba(var(--primary-rgb,217,48,37),.04)}
    .r-proposal-workspace-title{min-width:0;flex:1;border:0;background:transparent;color:#111827;font-size:13px;font-weight:1000;font-family:inherit;padding:7px 0}
    .r-proposal-workspace-title:focus{outline:none}
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
    .r-proposal-empty-list,.r-proposal-preview-empty{min-height:220px;border:1px dashed rgba(15,23,42,.12);border-radius:18px;background:rgba(255,255,255,.7);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px;color:#667085;padding:20px}
    .r-proposal-empty-list i,.r-proposal-preview-empty i{font-size:24px;color:var(--primary-readable,var(--primary,#d93025))}
    .r-proposal-empty-list strong,.r-proposal-preview-empty strong{font-size:13px;font-weight:1000;color:#111827}
    .r-proposal-empty-list span,.r-proposal-preview-empty span{font-size:11px;font-weight:800;line-height:1.45}
    .r-proposal-preview-empty{height:100%;border:0;background:#f8fafc;border-radius:0}
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
    .r-proposal-pitch-table{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;align-items:end;width:100%}
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
    .r-proposal-font-field{display:flex;flex-direction:column;gap:6px;border:1px solid rgba(15,23,42,.1);background:#fff;border-radius:13px;padding:9px}
    .r-proposal-font-field span{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
    .r-proposal-font-field select{width:100%;height:34px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#f8fafc;color:#111827;padding:0 9px;font:inherit;font-size:12px;font-weight:900;outline:none}
    .r-proposal-pages-list{display:flex;flex-direction:column;gap:4px;flex:1;min-height:0}
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
    .r-proposal-line-item{position:relative;display:grid;grid-template-columns:minmax(0,1.5fr) 90px 120px 120px;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid rgba(15,23,42,.08);overflow:visible}
    .r-proposal-line-item::before{content:'';position:absolute;left:-42px;top:0;bottom:0;width:42px}
    .r-proposal-line-item:last-child{border-bottom:0}
    .r-proposal-line-labelwrap{display:flex;flex-direction:column;gap:4px;min-width:0}
    .r-proposal-line-label{font-size:13px;line-height:1.55;color:#344054}
    .r-proposal-line-meta{font-size:10px;font-weight:900;letter-spacing:.03em;color:#667085;text-transform:uppercase}
    .r-proposal-line-delete{position:absolute;left:-34px;top:50%;transform:translateY(-50%) scale(.92);width:22px;height:22px;border-radius:999px;border:1px solid rgba(15,23,42,.08);background:rgba(255,255,255,.94);color:#98a2b3;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease,color .18s ease,border-color .18s ease,background .18s ease;z-index:2}
    .r-proposal-line-item:hover .r-proposal-line-delete,.r-proposal-line-item:focus-within .r-proposal-line-delete{opacity:1;pointer-events:auto;transform:translateY(-50%) scale(1)}
    .r-proposal-line-delete:hover{color:#b42318;border-color:rgba(180,35,24,.24);background:#fff}
    .r-proposal-addrow{display:grid;grid-template-columns:minmax(0,1.5fr) 90px 120px 120px;gap:12px;align-items:center;padding:12px 0;border:1px dashed rgba(15,23,42,.16);border-radius:14px;color:#667085;background:rgba(15,23,42,.02);cursor:pointer;transition:.16s ease}
    .r-proposal-addrow:hover{border-color:rgba(217,48,37,.26);background:rgba(217,48,37,.035);color:#b42318}
    .r-proposal-addrow span:first-child{padding-left:16px;font-weight:900}
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
    .r-proposal-payment-card.invalid .r-proposal-payment-row{color:#b42318}
    .r-proposal-payment-card.invalid .r-proposal-payment-row .r-proposal-editable{border-color:rgba(180,35,24,.2);background:rgba(180,35,24,.05)}
    .r-proposal-payment-percent{display:inline-flex;align-items:center;justify-content:flex-end;gap:2px;min-width:0;font-weight:900;color:#344054}
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
    .r-proposal-media-pane.is-editable::after{content:'Edit Photos';position:absolute;right:10px;bottom:10px;padding:6px 9px;border-radius:999px;background:rgba(255,255,255,.9);color:#344054;font-size:10px;font-weight:1000;opacity:0;transform:translateY(4px);transition:.18s ease}
    .r-proposal-media-pane.is-editable:hover::after{opacity:1;transform:translateY(0)}
    .r-proposal-media-gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:6px;padding:6px;height:100%;flex:1 1 auto;min-height:0;box-sizing:border-box;align-content:stretch}
    .r-proposal-media-gallery.count-1{grid-template-columns:1fr;grid-template-rows:1fr}
    .r-proposal-media-gallery.count-2{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:1fr}
    .r-proposal-media-gallery.count-3,.r-proposal-media-gallery.count-4{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}
    .r-proposal-media-gallery img{width:100%;height:100%;object-fit:cover;display:block;border-radius:10px;min-height:0}
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
    .r-proposal-media-pick-thumb{border:1px solid rgba(15,23,42,.08);border-radius:16px;background:#fff;overflow:hidden;cursor:pointer;transition:.16s ease}
    .r-proposal-media-pick-thumb.selected{border-color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 2px rgba(var(--primary-rgb,217,48,37),.12)}
    .r-proposal-media-pick-thumb img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block}
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
    @media (max-width:720px){
      .r-overlay{align-items:stretch}
      .r-win{width:var(--fm-visual-vw,100vw);height:var(--fm-visual-vh,100dvh);max-height:none;border-radius:0}
      .r-left{padding:12px;gap:8px;max-height:48%;flex-basis:auto}
      .r-scroll-cue{left:50%;bottom:calc(52% + 10px);padding:7px 10px;font-size:10px}
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
      .r-bottom-notes textarea{min-height:58px!important;height:58px;rows:2}
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
      .modal-close-x{display:flex;position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);right:8px;width:38px;height:38px;border-radius:12px;z-index:90}
      .r-project-hour-head,.r-project-day-head,.r-project-time,.r-cal-person,.r-cal-time{position:static}
      .r-photo-wrap{padding:20px}
      .r-photo-title{font-size:22px}
      .r-overlay.mobile-order .r-win{padding-bottom:50px;box-sizing:border-box}
      .r-overlay.mobile-order,
      .r-overlay.mobile-order .r-win,
      .r-overlay.mobile-order .r-left,
      .r-overlay.mobile-order .r-scroll{overflow-x:hidden}
      .r-overlay.mobile-order .r-top{display:block;overflow:hidden;padding-right:0}
      .r-overlay.mobile-order .r-title-wrap{overflow:hidden}
      .r-overlay.mobile-order .r-title,
      .r-overlay.mobile-order .r-title-input,
      .r-overlay.mobile-order .r-sub{display:block;max-width:none;white-space:nowrap;overflow:hidden;text-overflow:clip}
      .r-overlay.mobile-order .r-tabbar{display:none}
      .r-overlay.mobile-order .r-preview{padding:0}
      .r-overlay.mobile-order .r-preview-stage{border:0;border-radius:0;box-shadow:none;background:transparent;overflow:hidden}
      .r-overlay.mobile-order .r-preview-panel{border:0;border-radius:0;box-shadow:none}
      .r-overlay.mobile-order .r-preview-panel:not([data-panel="map"]){display:none!important}
      .r-overlay.mobile-order #rMapCloseX{display:none!important}
      .r-overlay.mobile-order .r-scroll-cue{display:none!important}
      .r-overlay.mobile-order .r-map-hint{top:0;left:0;right:0;width:auto;transform:none;box-sizing:border-box;border-radius:0 0 10px 10px;border-left:0;border-right:0;padding:5px 10px;min-height:24px;text-align:center;font-size:10.5px;line-height:1.2;box-shadow:0 6px 14px rgba(15,23,42,.10);background:rgba(255,255,255,.94)}
      .r-overlay.mobile-order .r-inline-label{display:none!important}
      .r-overlay.mobile-order .r-report-choice-row{display:none!important}
      .r-overlay.mobile-order #rReportOptionGroup{display:flex!important}
      .r-overlay.mobile-order #rRoofReportFields{display:flex!important}
      .r-overlay.mobile-order #rSubmit,
      .r-overlay.mobile-order #rExpediteSubmit{display:none!important}
      .r-overlay.mobile-order .r-mobile-close{display:flex;position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);right:8px;width:38px;height:38px;border-radius:12px;background:rgba(255,255,255,.88);backdrop-filter:blur(14px);border:1px solid rgba(15,23,42,.08);z-index:96;align-items:center;justify-content:center;cursor:pointer;font-size:15px;color:#344054}
      .r-overlay.mobile-order .r-mobile-pager{position:fixed;left:0;right:0;bottom:0;z-index:95;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px max(10px,env(safe-area-inset-left)) calc(6px + env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-left));background:rgba(255,255,255,.96);border-top:1px solid rgba(15,23,42,.10);box-shadow:0 -8px 22px rgba(15,23,42,.10);box-sizing:border-box}
      .r-overlay.mobile-order.mobile-order-location .r-mobile-pager{justify-content:flex-end}
      .r-mobile-page-btn{height:34px;border-radius:11px;border:1px solid rgba(15,23,42,.12);background:#fff;color:#344054;padding:0 12px;font-size:12px;font-weight:1000;display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}
      .r-mobile-page-btn.primary{flex:0 0 auto;min-width:96px;border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff);box-shadow:0 8px 18px rgba(var(--primary-rgb,217,48,37),.18)}
      .r-mobile-page-btn:disabled{background:#e5e7eb;border-color:#d1d5db;color:#667085;box-shadow:none;cursor:not-allowed}
      .r-overlay.mobile-order.mobile-order-location .r-left{flex:0 1 auto;gap:8px;max-height:calc(var(--fm-visual-vh,100dvh) - 230px);border-bottom:1px solid rgba(15,23,42,.08);padding-bottom:10px}
      .r-overlay.mobile-order.mobile-order-location .r-right{display:flex;flex:1 1 auto;min-height:180px}
      .r-overlay.mobile-order.mobile-order-location .r-form{gap:8px}
      .r-overlay.mobile-order.mobile-order-location .r-scroll{flex:0 1 auto}
      .r-overlay.mobile-order.mobile-order-location .r-step-body{gap:9px;padding-bottom:6px}
      .r-overlay.mobile-order.mobile-order-location #rStepType{margin-bottom:2px}
      .r-overlay.mobile-order.mobile-order-location #rStepTypeLabel{display:none!important}
      .r-overlay.mobile-order.mobile-order-location #rTypeGroup{display:grid!important}
      .r-overlay.mobile-order.mobile-order-location #rTypePill{display:none!important}
      .r-overlay.mobile-order.mobile-order-location .r-type-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:8px 6px;min-height:38px;min-width:0;gap:2px;box-sizing:border-box}
      .r-overlay.mobile-order.mobile-order-location .r-type-icon{display:none!important}
      .r-overlay.mobile-order.mobile-order-location .r-type-label{display:block!important;width:100%;min-width:0;font-size:10px;line-height:1.1;white-space:normal;overflow-wrap:anywhere}
      .r-overlay.mobile-order.mobile-order-location .r-type-price{display:block!important;width:100%;min-width:0;font-size:8.5px;line-height:1.1;white-space:normal;overflow-wrap:anywhere}
      .r-overlay.mobile-order.mobile-order-location #rStepReport .r-step-body{gap:9px;padding:0}
      .r-overlay.mobile-order.mobile-order-location #rRoofReportFields{gap:9px}
      .r-overlay.mobile-order.mobile-order-location #rConfirm{padding:8px 9px;border-radius:13px}
      @keyframes rMobileNeedShake{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px)}40%{transform:translateX(5px)}60%{transform:translateX(-3px)}80%{transform:translateX(3px)}}
      .r-overlay.mobile-order .r-mobile-needs-attention{animation:rMobileNeedShake .32s ease;border-color:rgba(180,35,24,.42)!important;box-shadow:0 0 0 3px rgba(180,35,24,.08)!important}
      .r-overlay.mobile-order.mobile-order-location #rStepCustomer,
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
      .r-overlay.mobile-order.mobile-order-final .r-left{flex:1 1 auto;height:100%;max-height:none;border-bottom:0}
      .r-overlay.mobile-order.mobile-order-details .r-right,
      .r-overlay.mobile-order.mobile-order-final .r-right{display:none}
      .r-overlay.mobile-order.mobile-order-details .r-scroll,
      .r-overlay.mobile-order.mobile-order-final .r-scroll{height:100%;overflow:auto}
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
      .r-overlay.mobile-order.mobile-order-details .r-scroll-cue,
      .r-overlay.mobile-order.mobile-order-final .r-scroll-cue{display:none!important}
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
      @media (prefers-reduced-motion:reduce){
        .r-overlay.mobile-order.mobile-page-anim-forward .r-left,
        .r-overlay.mobile-order.mobile-page-anim-forward .r-right,
        .r-overlay.mobile-order.mobile-page-anim-back .r-left,
        .r-overlay.mobile-order.mobile-page-anim-back .r-right{animation:none}
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
      && !hasReportOrdered()
      && !proposalWorkspaceOpen
      && actionAvailable('roof');
  }

  function mobileOrderReadyForDetails(){
    return !!(addressSelected && selectedType && pinCount() > 0 && locationConfirmed);
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
    return !!(reportExpediteOptionsEnabled() && hasSelectedAddons());
  }

  function mobileOrderReadyForFinal(){
    return mobileOrderUsesFinalPage() && mobileOrderReadyForDetails();
  }

  function mobileOrderPageIndex(page = mobileOrderPage){
    return page === 'final' ? 2 : (page === 'details' ? 1 : 0);
  }

  function setMobileOrderPage(page){
    const previous = mobileOrderPage;
    mobileOrderPage = page === 'final' ? 'final' : (page === 'details' ? 'details' : 'location');
    if ((mobileOrderPage === 'details' || mobileOrderPage === 'final') && !mobileOrderReadyForDetails()) mobileOrderPage = 'location';
    if (mobileOrderPage === 'final' && !mobileOrderUsesFinalPage()) mobileOrderPage = 'details';
    if (mobileOrderPage === 'final' && !mobileOrderReadyForFinal()) mobileOrderPage = 'details';
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
    setMobileOrderPage(mobileOrderPage === 'final' ? 'details' : 'location');
  }

  function mobileOrderGoNext(){
    if (!shouldUseMobileOrderPagination() || mobileOrderPage === 'final') return;
    if (mobileOrderPage === 'details') {
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
    if (mobile && (mobileOrderPage === 'details' || mobileOrderPage === 'final') && !mobileOrderReadyForDetails()) mobileOrderPage = 'location';
    if (mobile && mobileOrderPage === 'final' && !mobileOrderUsesFinalPage()) mobileOrderPage = 'details';
    if (mobile && mobileOrderPage === 'final' && !mobileOrderReadyForFinal()) mobileOrderPage = 'details';
    const hasFinalPage = mobile && mobileOrderUsesFinalPage();
    overlay.classList.toggle('mobile-order', mobile);
    overlay.classList.toggle('mobile-order-no-final', mobile && !hasFinalPage);
    overlay.classList.toggle('mobile-order-location', mobile && mobileOrderPage === 'location');
    overlay.classList.toggle('mobile-order-details', mobile && mobileOrderPage === 'details');
    overlay.classList.toggle('mobile-order-final', mobile && mobileOrderPage === 'final');
    const back = $('#rMobileBack');
    const next = $('#rMobileNext');
    const order = $('#rMobileOrder');
    if (back) back.style.display = mobile && mobileOrderPage !== 'location' ? '' : 'none';
    if (next) {
      const ready = mobileOrderPage === 'details' ? mobileOrderReadyForFinal() : mobileOrderReadyForDetails();
      next.style.display = mobile && (mobileOrderPage === 'location' || (mobileOrderPage === 'details' && hasFinalPage)) ? '' : 'none';
      next.disabled = mobile ? !ready : false;
      next.innerHTML = '<span>Next</span><i class="fas fa-arrow-right"></i>';
    }
    if (order) {
      const submit = activeSubmitButton();
      const orderVisible = mobile && (mobileOrderPage === 'final' || (mobileOrderPage === 'details' && !hasFinalPage));
      order.style.display = orderVisible ? '' : 'none';
      order.disabled = !orderVisible || !submit || submit.disabled;
      const label = submit?.textContent?.trim() || 'Order Roof Report';
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
    showToast('Pin limit', pinLimitMessage(maxPins || MAX_PINS_PER_STRUCTURE_REPORT), false);
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
  function appFeatureEnabled(group, flag, fallback = true){
    const appFlags = window.Portal?.appFlags;
    if (appFlags?.current?.()) {
      if (appFlags.has?.(group, flag)) return true;
      const value = appFlags.value?.(group, flag, undefined);
      return typeof value === 'boolean' ? value : fallback;
    }
    return fallback;
  }
  function appFlagValue(group, flag, fallback = null){
    const appFlags = window.Portal?.appFlags;
    if (appFlags?.current?.()) return appFlags.value?.(group, flag, fallback) ?? fallback;
    return fallback;
  }
  function projectPhotosEnabled(){ return appFeatureEnabled('platform', 'project_photos', false); }
  function projectDocsEnabled(){ return appFeatureEnabled('platform', 'project_docs', false); }
  function activeProjectRouteId(){
    return window.Portal?.routeState?.projectId?.(activeBaseProject) || String(activeBaseProject?.id || '').trim();
  }
  function routePhotoId(photo = {}){
    return window.Portal?.routeState?.mediaId?.(photo) || projectPhotoId(photo);
  }
  function syncActiveProjectRoute(extra = {}){
    const projectId = activeProjectRouteId();
    if (!projectId || !viewingExistingProject) return;
    const patch = { project: projectId, projectTab: activePreviewTab, ...extra };
    if ((patch.projectTab || activePreviewTab) !== 'photos' && !patch.photo) {
      patch.photo = null;
      patch.photoScope = null;
    }
    window.Portal?.routeState?.set?.(patch);
  }
  function clearProjectRoute(){
    window.Portal?.routeState?.set?.({ project: null, projectTab: null, photo: null, photoScope: null });
  }
  function preferMapForNewProjectInput(){
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
    if (['proposal', 'proposals'].includes(workflow)) return 'proposal';
    if (['appointment', 'schedule', 'scheduling'].includes(workflow)) return 'appointment';
    return 'project';
  }
  function workflowWantsAction(){
    return !['project', 'contact'].includes(requestedWorkflow) || !!reportSelection || hasReportOrdered();
  }
  function workflowActionKey(){
    if (requestedWorkflow === 'report') return 'roof';
    if (requestedWorkflow === 'proposal') return 'proposal';
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
    } else if (key === 'schedule' && schedulingEnabled()) {
      setTimeout(() => startAppointmentScheduling(), 0);
    }
  }
  function projectLeftColumnOverridden(tab = activePreviewTab){
    const id = String(tab || '').trim();
    return id === 'proposal' || id === 'schedule' || id === 'materials' || id === 'money';
  }
  function syncLeftColumnOverride(){
    const overlay = $('#rOverlay');
    if (!overlay) return false;
    const overridden = projectLeftColumnOverridden();
    overlay.classList.toggle('left-override', overridden);
    if (overridden) overlay.dataset.leftOverrideTab = activePreviewTab;
    else delete overlay.dataset.leftOverrideTab;
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
      label.textContent = 'Proposal';
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
    return !projectLeftColumnOverridden();
  }
  function hasGutterAddon(){ return gutterReportsEnabled() && selectedType === 'residential' && includeGutterMeasurements; }
  function hasWeatherAddon(){ return weatherReportsEnabled() && includeWeatherReport; }
  function roofDecisionMade(){ return reportSelection !== null; }
  function reportExpediteChoiceComplete(){ return !reportExpediteOptionsEnabled() || !hasSelectedAddons() || reportOrderingClosed() || !!selectedReportExpediteOption(); }
  function roofStepComplete(){ return isProposalChoice() || isScheduleChoice() || (hasSelectedAddons() && locationConfirmed && reportExpediteChoiceComplete()); }
  function customerStepVisible(){ return roofDecisionMade() && roofStepComplete(); }
  function canSubmit(){ return !!(addressSelected && selectedType && roofDecisionMade() && roofStepComplete()); }
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
    return currentPriceQuote().final_amount;
  }

  function projectMapModule(){
    return window.Portal?.modules?.projectMap || window.Portal?.ProjectMapApp || null;
  }

  let projectMapMounting = false;
  let projectMapInitTimer = 0;

  function mountProjectMapApp(context = {}){
    const app = projectMapModule();
    if (!app?.mount) return null;
    if (projectMapMounting) return app;
    const panelRoot = context.panelRoot || document.querySelector('#rOverlay .r-preview-panel[data-panel="map"]');
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
      return app;
    } finally {
      projectMapMounting = false;
    }
  }

  function projectMapInvoke(name, args = []){
    const app = mountProjectMapApp();
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

  function addCcRow(value){
    const list = $('#rCcList');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'r-cc-row';
    row.innerHTML = `<input class="r-inp" type="email" placeholder="email@example.com" value="${value || ''}"><div class="r-cc-remove" data-fm-tooltip="Remove"><i class="fas fa-times"></i></div>`;
    row.querySelector('.r-cc-remove').addEventListener('click', () => { row.remove(); queueAutosaveNotice(); });
    list.appendChild(row);
    queueAutosaveNotice();
    const inp = row.querySelector('input');
    if (inp) setTimeout(() => inp.focus(), 50);
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
    return {
      id,
      contact_id: id,
      record_project_id: projectText(card.dataset.contactRecordProjectId),
      name: (card.querySelector('[data-field="name"]')?.value || '').trim(),
      phone: (card.querySelector('[data-field="phone"]')?.value || '').trim(),
      email: (card.querySelector('[data-field="email"]')?.value || '').trim(),
      address: projectText(card.dataset.contactAddress),
      default_address: projectText(card.dataset.contactAddress),
      primary: card.classList.contains('primary')
    };
  }

  function applyContactToCard(card, contact = {}){
    if (!card) return;
    const id = projectText(contact.id, contact.contact_id) || `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    card.dataset.contactId = id;
    card.dataset.contactAddress = projectText(contact.address, contact.default_address);
    card.dataset.contactRecordProjectId = projectText(contact.record_project_id, contact.project_id);
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
        primary: true
      }],
      contact_id: id,
      primary_contact_id: id,
      contact_ids: [id],
      stage: INITIAL_PROJECT_STAGE_ID,
      stage_id: INITIAL_PROJECT_STAGE_ID,
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
    const currentContextId = projectText(activeContactContext?.contact?.id, activeContactContext?.contact?.contact_id);
    if (currentContextId && projectText(contact.id, contact.contact_id) === currentContextId) {
      close();
      window.Portal?.modules?.contacts?.open?.(activeContactContext.contact, { projects: activeContactContext.projects || [] });
      return;
    }
    close();
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
      ${isPrimary ? '' : '<button type="button" data-contact-menu-action="primary"><i class="fas fa-star"></i><span>Make primary</span></button>'}
      <button type="button" data-contact-menu-action="view"><i class="fas fa-address-book"></i><span>View contact</span></button>
      <button type="button" data-contact-menu-action="new"><i class="fas fa-plus"></i><span>New contact</span></button>
      <button type="button" class="danger" data-contact-menu-action="remove"${canRemove ? '' : ' disabled'}><i class="fas fa-times"></i><span>Remove from project</span></button>
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
    if (values.primary || index === primaryContactIndex) wrap.classList.add('primary');
    wrap.innerHTML = `
      <div class="r-mobile-customer-label">Customer Info</div>
      <div class="r-inline">
        <div class="r-group">
          <label>Name <span class="r-label-optional">- optional</span></label>
          <input class="r-inp" data-field="name" placeholder="Name" value="${escapeHtml(values.name || '')}">
        </div>
        <div class="r-group">
          <label>Phone <span class="r-label-optional">- optional</span></label>
          <input class="r-inp" data-field="phone" placeholder="Phone" type="tel" value="${escapeHtml(values.phone || '')}">
        </div>
      </div>
      <div class="r-contact-email-row">
        <div class="r-group">
          <label>Email <span class="r-label-optional">- optional</span></label>
          <input class="r-inp" data-field="email" placeholder="Email" type="email" value="${escapeHtml(values.email || '')}">
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
      <input class="r-contact-picker-search" id="rContactPickerSearch" placeholder="Search contacts">
      <div class="r-contact-picker-list" id="rContactPickerList"></div>
      <button type="button" class="r-contact-picker-new" id="rContactPickerNew"><i class="fas fa-plus"></i><span>Create new contact</span></button>
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
    return [...list.querySelectorAll('.r-contact-card')].map((card, index) => {
      const id = cardContactId(card);
      const address = projectText(card.dataset.contactAddress);
      return {
        id,
        contact_id: id,
        name: (card.querySelector('[data-field="name"]')?.value || '').trim(),
        phone: (card.querySelector('[data-field="phone"]')?.value || '').trim(),
        email: (card.querySelector('[data-field="email"]')?.value || '').trim(),
        address,
        default_address: address,
        primary: index === primaryContactIndex,
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
        ${tabs || '<div class="r-contact-context-empty">No other projects</div>'}
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
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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

  function normalizeProjectConfig(config){
    const mode = String(config?.title_mode || config?.project_title_mode || 'customer_name').trim();
    const celebrationMode = String(config?.celebrations_mode || config?.celebrations?.mode || 'on').trim();
    return {
      ...(config && typeof config === 'object' ? config : {}),
      title_mode: ['customer_name', 'address', 'manual'].includes(mode) ? mode : 'customer_name',
      celebrations_mode: ['on', 'small_only', 'off'].includes(celebrationMode) ? celebrationMode : 'on'
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

  function normalizeStageList(stages = []){
    const byId = new Map(FALLBACK_PROJECT_STAGES.map((stage) => [stage.id, { ...stage }]));
    const loaded = Array.isArray(stages) ? stages : [];
    loaded.forEach((stage) => {
      const id = cleanStageText(stage?.id || stage?.stage_id || stage);
      if (!id) return;
      const status = cleanStageText(stage?.status).toLowerCase();
      if (status === 'disabled' || status === 'archived') return;
      byId.set(id, {
        ...(byId.get(id) || {}),
        ...(stage && typeof stage === 'object' ? stage : {}),
        id,
        label: cleanStageText(stage?.label || stage?.name || byId.get(id)?.label) || humanizeStageId(id)
      });
    });
    const loadedIds = loaded.map((stage) => cleanStageText(stage?.id || stage?.stage_id || stage)).filter((id) => byId.has(id));
    const legacyDefaultOrders = [
      ['appointment_scheduled', 'newly_sold', 'project_started', 'in_progress', 'completed'],
      ['new_lead', 'contacting', 'appointment_scheduled', 'newly_sold', 'lost'],
      ['contacting', 'appointment_scheduled', 'newly_sold', 'lost']
    ];
    if (legacyDefaultOrders.some((order) => order.length === loadedIds.length && order.every((stage, index) => stage === loadedIds[index]))) {
      return FALLBACK_PROJECT_STAGES.map((stage) => ({ ...stage }));
    }
    const orderedIds = [...new Set([
      ...loadedIds,
      ...FALLBACK_PROJECT_STAGES.map((stage) => stage.id).filter((id) => !loadedIds.includes(id))
    ])];
    return orderedIds.map((id) => byId.get(id)).filter(Boolean);
  }

  function normalizeStagesModule(stagesRaw = {}, mappingsRaw = {}){
    const stagesData = stagesRaw?.data && typeof stagesRaw.data === 'object' ? stagesRaw.data : (stagesRaw || {});
    const mappingsData = mappingsRaw?.data && typeof mappingsRaw.data === 'object' ? mappingsRaw.data : (mappingsRaw || {});
    const labels = mappingsData?.labels?.stages && typeof mappingsData.labels.stages === 'object' ? mappingsData.labels.stages : {};
    const stageMap = stagesData?.stages && typeof stagesData.stages === 'object' ? stagesData.stages : {};
    const order = Array.isArray(stagesData?.order) ? stagesData.order : [];
    const stages = order.map((id) => ({
      ...(stageMap[id] || {}),
      id,
      label: cleanStageText(labels[id] || stageMap[id]?.label || stageMap[id]?.name) || humanizeStageId(id)
    }));
    Object.entries(stageMap).forEach(([id, stage]) => {
      if (stages.some((item) => item.id === id)) return;
      stages.push({ ...(stage || {}), id, label: cleanStageText(labels[id] || stage?.label || stage?.name) || humanizeStageId(id) });
    });
    return normalizeStageList(stages);
  }

  async function loadBranchStageConfig(options = {}){
    if (branchStageConfig && !options.refresh) return branchStageConfig;
    if (branchStageConfigPromise && !options.refresh) return branchStageConfigPromise;
    const oid = projectOrgId();
    const bid = currentBranchId();
    branchStageConfigPromise = (async () => {
      try {
        if (oid && window.PlatformScheduling?.loadBranchConfig) {
          const config = await window.PlatformScheduling.loadBranchConfig(oid, bid);
          branchStageConfig = normalizeStageList(config?.stages || []);
          renderProjectStageBar();
          return branchStageConfig;
        }
        if (window.Portal?.branchModules?.get) {
          const [stagesRaw, mappingsRaw] = await Promise.all([
            window.Portal.branchModules.get('stages').catch(() => null),
            window.Portal.branchModules.get('variable_mappings').catch(() => null)
          ]);
          branchStageConfig = normalizeStagesModule(stagesRaw, mappingsRaw);
          renderProjectStageBar();
          return branchStageConfig;
        }
      } catch (error) {
        console.warn('Unable to load project stages', error);
      } finally {
        branchStageConfigPromise = null;
      }
      branchStageConfig = normalizeStageList();
      renderProjectStageBar();
      return branchStageConfig;
    })();
    return branchStageConfigPromise;
  }

  function projectStageId(project = activeBaseProject){
    return cleanStageText(project?.stage || project?.stage_id || project?.mapped_stage?.id);
  }

  function projectStageHistory(project = activeBaseProject){
    return Array.isArray(project?.stage_history) ? project.stage_history.map((entry) => entry && typeof entry === 'object' ? entry : {}).filter(Boolean) : [];
  }

  function projectStageSequence(project = activeBaseProject){
    const currentId = projectStageId(project);
    if (!currentId) return [];
    const stages = normalizeStageList(branchStageConfig || []);
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const ordered = [...stages];
    const ensureStage = (id) => {
      const cleanId = cleanStageText(id);
      if (!cleanId || byId.has(cleanId)) return;
      const stage = { id: cleanId, label: humanizeStageId(cleanId) };
      byId.set(cleanId, stage);
      ordered.push(stage);
    };
    projectStageHistory(project).forEach((entry) => {
      ensureStage(entry.from || entry.stage || entry.stage_id);
      ensureStage(entry.to);
    });
    ensureStage(currentId);
    return ordered;
  }

  function completedProjectStageIds(project = activeBaseProject, stages = []){
    const currentId = projectStageId(project);
    const done = new Set();
    const history = projectStageHistory(project);
    history.forEach((entry) => {
      const from = cleanStageText(entry.from || entry.stage || entry.stage_id);
      const to = cleanStageText(entry.to);
      if (from && from !== currentId) done.add(from);
      if (to && to !== currentId && history.some((next) => cleanStageText(next.from || next.stage || next.stage_id) === to)) done.add(to);
    });
    return done;
  }

  function renderProjectStageBar(){
    const bar = document.getElementById('rProjectStageBar');
    if (!bar) return;
    if (!projectStagesEnabled()) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const currentId = projectStageId();
    if (projectLeftColumnOverridden() || !activeBaseProject || !currentId) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const stages = projectStageSequence();
    const currentIndex = stages.findIndex((stage) => stage.id === currentId);
    if (!stages.length || currentIndex < 0) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const done = completedProjectStageIds(activeBaseProject, stages);
    bar.hidden = false;
    bar.innerHTML = `
      <div class="r-stage-track" aria-label="Project stage progress">
        <div class="r-stage-list">
          ${stages.map((stage, index) => {
            const state = stage.id === currentId ? 'current' : (done.has(stage.id) ? 'done' : 'upcoming');
            const icon = state === 'done' ? 'fa-check' : (state === 'current' ? 'fa-circle-dot' : 'fa-circle');
            return `${index ? '<i class="fas fa-arrow-right r-stage-arrow" aria-hidden="true"></i>' : ''}
              <div class="r-stage-pill ${state}" data-stage-id="${escapeHtml(stage.id)}" ${state === 'current' ? 'data-current-stage="1"' : ''}>
                <i class="fas ${icon}" aria-hidden="true"></i><span>${escapeHtml(stage.label || humanizeStageId(stage.id))}</span>
              </div>`;
          }).join('')}
        </div>
      </div>
    `;
    requestAnimationFrame(() => {
      const current = bar.querySelector('[data-current-stage="1"]');
      current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  }

  function bindProjectStageBarWheel(){
    const bar = document.getElementById('rProjectStageBar');
    if (!bar || bar.__fmStageWheelBound) return;
    bar.__fmStageWheelBound = true;
    bar.addEventListener('wheel', (event) => {
      const track = bar.querySelector('.r-stage-track');
      if (!track || track.scrollWidth <= track.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      track.scrollLeft += delta;
    }, { passive: false });
  }

  function customerPortalProjectModule(){
    return window.Portal?.modules?.customerPortalProject || window.Portal?.ProjectCustomerPortalApp || null;
  }

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
      showToast('Copied', 'Customer portal link copied.', true);
    } catch (_) {
      showToast('Copy failed', 'Could not copy the customer portal link.', false);
    }
  }

  function renderCustomerPortalLink(){
    const mount = document.getElementById('rCustomerPortalLinkMount');
    if (!mount) return;
    const pid = customerPortalProjectId();
    if (projectLeftColumnOverridden() || !customerPortalEnabled() || !pid) {
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
          <div class="r-customer-portal-card-title"><i class="fas fa-link"></i><span>Customer Portal</span></div>
          <div class="r-customer-portal-card-status">${busy ? 'Loading' : (ready ? 'Ready' : 'Not created')}</div>
        </div>
        <div class="r-customer-portal-actions">
          <button type="button" class="${ready ? '' : 'primary'}" data-customer-portal-open-tab>${ready ? 'Manage' : 'Create Link'}</button>
          ${liveUrl ? `
            <button type="button" data-customer-portal-copy><i class="fas fa-copy"></i><span>Copy</span></button>
          ` : ''}
          ${previewUrl ? `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i><span>Open</span></a>` : ''}
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
        $('#rOverlay')?.classList.remove('proposal-workspace');
        syncLeftColumnOverride();
      },
      onReset: () => {
        $('#rOverlay')?.classList.remove('proposal-workspace');
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
  function queueAutosaveNotice(...args){ return proposalInvoke('queueAutosaveNotice', args); }
  function ensureProposalSignatureData(...args){ return proposalInvoke('ensureProposalSignatureData', args); }
  function ensureProposalSigningSession(...args){ return proposalInvoke('ensureProposalSigningSession', args); }
  function proposalSigningComplete(...args){ return proposalInvoke('proposalSigningComplete', args); }
  function proposalNextUnsignedTarget(...args){ return proposalInvoke('proposalNextUnsignedTarget', args); }
  function proposalTriangleHeaderVars(...args){ return proposalInvoke('proposalTriangleHeaderVars', args); }
  function proposalRenderSections(...args){ return proposalInvoke('proposalRenderSections', args); }
  function loadBranchPresentationStyle(...args){ return proposalInvoke('loadBranchPresentationStyle', args); }
  function hexToRgbString(...args){ return proposalInvoke('hexToRgbString', args); }
  function getProposalPrimaryColor(...args){ return proposalInvoke('getProposalPrimaryColor', args); }
  function getProposalAccentColor(...args){ return proposalInvoke('getProposalAccentColor', args); }
  function getProposalAccentReadableColor(...args){ return proposalInvoke('getProposalAccentReadableColor', args); }
  function proposalBrandLockup(...args){ return proposalInvoke('proposalBrandLockup', args); }
  function ensureProposalPageIds(...args){ return proposalInvoke('ensureProposalPageIds', args); }
  function loadBranchProposalTemplates(...args){ return proposalInvoke('loadBranchProposalTemplates', args); }
  function proposalPageMarkup(...args){ return proposalInvoke('proposalPageMarkup', args); }
  function proposalMarkupDockHtml(...args){ return proposalInvoke('proposalMarkupDockHtml', args); }
  function proposalStableId(...args){ return proposalInvoke('proposalStableId', args); }
  function normalizeProposalCollection(...args){ return proposalInvoke('normalizeProposalCollection', args); }
  function hydrateProposalsFromBackend(...args){ return proposalInvoke('hydrateProposalsFromBackend', args); }
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
    if (!projectLeftColumnOverridden()) {
      restoreDefaultLeftColumnState();
      return;
    }
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
    if (key === 'gutters') {
      return {
        title: 'Gutter report',
        body: 'Adds a dedicated gutter page to the standard residential report.',
        bullets: [
          'Active gutter linear feet calculated from eave runs.',
          'Stories by north, south, east, and west sides.',
          'Gutter diagram with each run labeled.',
          'Miter counts for outside 90, inside 90, and non-90 corners.'
        ],
        sample: {
          label: 'Download sample gutter report',
          url: 'samples/gutter_sample.pdf'
        }
      };
    }
    if (key === 'inspection') {
      return {
        title: 'Instant report',
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
        title: 'Historical weather report',
        body: 'Adds a severe-weather history report for the property.',
        bullets: [
          'Broad hail, wind, and tornado event history for the address.',
          'Nearby event records grouped by date with distance and magnitude details.',
          'Map-style exhibits, warning context, and summary tables.',
          'Useful for claim review, customer conversations, and project documentation.'
        ],
        sample: {
          label: 'Download sample weather report',
          url: 'samples/weather_sample.pdf'
        }
      };
    }
    return {
      title: 'Add-on',
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
    return `<div class="r-addon-info-price">$${escapeHtml(fmtMoney(unit))} / structure x ${count} ${structureLabel} = $${escapeHtml(fmtMoney(total))}</div>`;
  }

  function addonInfoIcon(key){
    const info = reportAddonInfo(key);
    return `<span class="r-info-tip r-addon-info-trigger" data-addon-info-trigger="${escapeHtml(key)}" role="button" tabindex="0" aria-label="${escapeHtml(info.title)} information"><i class="fas fa-info"></i></span>`;
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
      return '<span class="r-expedite-price is-loading" aria-label="Loading current price"></span>';
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
    const start = isStandard ? 240 : Number(option?.baseStartMinutes ?? option?.base_start_minutes ?? option?.startMinutes ?? 180);
    const end = isStandard ? 420 : Number(option?.baseEndMinutes ?? option?.base_end_minutes ?? option?.endMinutes ?? 360);
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
    const parts = new Intl.DateTimeFormat('en-US', {
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
        _pricingAuthoritative: true
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
        ? `<span class="r-viewer-type-tag" aria-label="Project type"><i class="fas ${icon}"></i> ${label}</span>`
        : `<button type="button" class="r-viewer-type-tag" data-type-pill aria-label="Change project type"><i class="fas ${icon}"></i> ${label} <i class="fas fa-chevron-down"></i></button>`;
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
            <strong>${escapeHtml(reportExpediteBusyLabel(defaultOption))}</strong>
            <span>Estimated wait time right now</span>
          </div>
          <div class="r-expedite-eta">${escapeHtml(reportExpediteEstimatedWaitLabel(defaultOption))}</div>
        </div>
        <div class="r-expedite-bar" style="--wait-position:${position}%"><span class="r-expedite-marker" aria-hidden="true"></span></div>
        <div class="r-expedite-bar-labels"><span>3 hrs</span><span>6 hrs</span></div>`;
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
              ${isStandard ? '' : '<span class="r-expedite-pill">Expedited</span>'}
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
        ? `<i class="fas fa-bolt"></i><span>Includes free expedite. ${uses} free expedite use${uses === 1 ? '' : 's'} remaining.</span>`
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
      mount.innerHTML = '<div class="pai-today-list"><div class="pai-state">Project to-dos will appear here once this project is saved.</div></div>';
      return;
    }
    if (!orgId || !window.PlatformActionItems?.renderTodayList) {
      mount.innerHTML = '<div class="pai-today-list"><div class="pai-state">Project to-dos are not available.</div></div>';
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
      completedOpen: true
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
        <button type="button" class="r-addon-info-modal-close" aria-label="Close"><i class="fas fa-times"></i></button>
        ${reportAddonInfoHtml(key)}
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
      el.innerHTML = `<i class="fas fa-percent"></i><span>${quote.discount_percent}% referral discount applied. <s>$${fmtMoney(quote.original_amount)}</s>$${fmtMoney(quote.final_amount)} total.</span>`;
    } else {
      el.innerHTML = `<i class="fas fa-percent"></i><span>Your ${discount.discount_percent}% referral discount applies to standard report base pricing.</span>`;
    }
    el.classList.add('visible');
  }

  function renderConfirm(){
    const wrap = $('#rConfirm');
    const tx = $('#rConfirmTx');
    const ic = $('#rConfirmIc');
    if (!wrap || !tx || !ic) return;

    wrap.classList.remove('active', 'checked');

    if (!hasSelectedAddons()) {
      tx.textContent = 'Skip roof-report placement and continue to customer details.';
      ic.innerHTML = `<i class="far fa-square"></i>`;
      return;
    }
    if (!addressSelected || pinCount() === 0) {
      tx.textContent = 'Place at least one pin on the map.';
      ic.innerHTML = `<i class="far fa-square"></i>`;
      return;
    }

    wrap.classList.add('active');
    if (!locationConfirmed) {
      tx.textContent = 'I have placed a pin on every structure to be included in this report';
      ic.innerHTML = `<i class="far fa-square"></i>`;
      return;
    }

    wrap.classList.add('checked');
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
        <button type="button" class="r-signing-back" id="rSigningBack"><i class="fas fa-arrow-left"></i> Back</button>
        <div class="r-signing-actions">
          ${canFinish ? `<button type="button" class="r-signing-finish" id="rSigningFinishTop"><i class="fas fa-paper-plane"></i> Finish and Send</button>` : `<button type="button" class="r-signing-next" id="rSigningNext"><i class="fas fa-arrow-right"></i> Next Signature</button>`}
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
      showToast('Signed', 'Signed proposal prepared for sending.', true);
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

  function setActivePreviewTab(tab){
    const previousTab = activePreviewTab;
    if (tab === 'photos' && !projectPhotosEnabled()) tab = 'map';
    if (tab === 'docs' && !projectDocsEnabled()) tab = 'map';
    if (tab === 'schedule' && !schedulePreviewAvailable()) tab = 'map';
    if (tab === 'proposal' && !proposalsEnabled()) tab = 'map';
    if (tab === 'materials' && !materialsEnabled()) tab = 'map';
    if (tab === 'measurements' && !reportsEnabled()) tab = 'map';
    if (tab === 'money' && !moneyEnabled()) tab = 'map';
    if (tab === 'customer_portal' && !customerPortalEnabled()) tab = 'map';
    const allowed = validPreviewTabs();
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
    syncLeftColumnOverride();
    ensureProjectModalAppPanels();
    mountProjectModalRegionApps('left');
    if (projectViewer && projectViewer.activeTab !== activePreviewTab) {
      projectViewer.activeTab = activePreviewTab;
      projectViewer.render?.();
    }
    document.querySelectorAll('.r-preview-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.panel === activePreviewTab);
    });
    syncProjectModalAppActivation(previousTab);
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
    syncActiveProjectRoute();
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
        return proposals;
      },
      getBranchProjectConfig: () => branchProjectConfig,
      getReportOrderState: () => reportOrderState,
      setReportOrderState: (nextState) => {
        reportOrderState = nextState || null;
        return reportOrderState;
      },
      persistProject: () => persistActiveBaseProject(),
      autosaveSoon: () => queueAutosaveNotice(),
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

  function projectModalTabId(meta = {}){
    const explicit = meta.app?.projectModalTabId || meta.app?.tabId;
    if (explicit) return String(explicit);
    const appId = String(meta.id || '');
    return appId.startsWith(PROJECT_MODAL_APP_PREFIX) ? appId.slice(PROJECT_MODAL_APP_PREFIX.length) : appId;
  }

  function firstMeasureOrderServices(){
    return {
      buildTypeButtons: () => buildTypeButtons(),
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
      host,
      projectWorkspace: host,
      overlayRoot: $('#rOverlay'),
      leftRoot: extra.leftRoot || $('#rProposalSection'),
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

  function mountProjectModalRegionApps(region){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.mount) return;
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
      runtime.mount({ main: root, left: context.leftRoot, overlay: $('#rOverlay') }, app.appId, context)
        .then((handle) => {
          projectModalRegionAppHandles.set(key, handle);
          handle?.setActive?.(true);
          if (region === 'left') bindProjectStageBarWheel();
        })
        .catch((error) => {
          projectModalRegionAppHandles.delete(key);
          console.warn(`Project modal region app mount failed for ${app.appId}`, error);
        });
    });
  }

  function projectModalApps(options = {}){
    const runtime = window.FirstMateEmbeddableApps;
    if (!runtime?.listApps) return [];
    const context = projectModalRuntimeContext();
    const apps = runtime.listApps(context)
      .filter((meta) => meta?.id && meta.id !== 'project.request')
      .filter((meta) => meta.app?.kind === 'project_modal_app' || String(meta.id || '').startsWith(PROJECT_MODAL_APP_PREFIX))
      .filter((meta) => projectModalAppFeatureEnabled(projectModalTabId(meta)))
      .map((meta) => ({
        ...meta,
        id: projectModalTabId(meta),
        appId: meta.id,
        label: meta.label || meta.title || projectModalTabId(meta),
        title: meta.title || meta.label || projectModalTabId(meta),
        icon: meta.icon || '',
        panelHtml: meta.app?.panelHtml,
        app: meta.app
      }));
    return options.includeInlineMap || !projectModalAppsShouldInlineMap(apps)
      ? apps
      : apps.filter((app) => app.id !== 'map');
  }

  function projectModalAppsShouldInlineMap(apps = projectModalApps({ includeInlineMap: true })){
    const ids = (apps || []).map((app) => app?.id).filter(Boolean);
    return ids.length === 2 && ids.includes('map') && ids.includes('measurements');
  }

  function projectModalAppFeatureEnabled(tabId){
    const tab = String(tabId || '').trim();
    if (tab === 'photos') return projectPhotosEnabled();
    if (tab === 'docs') return projectDocsEnabled();
    if (tab === 'schedule') return schedulePreviewAvailable();
    if (tab === 'proposal') return proposalsEnabled();
    if (tab === 'materials') return materialsEnabled();
    if (tab === 'measurements') return reportsEnabled();
    if (tab === 'money') return moneyEnabled();
    if (tab === 'customer_portal') return customerPortalEnabled();
    return true;
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
          <h3>${escapeHtml(tab?.label || tab?.title || tab?.id || 'Project app')} unavailable</h3>
          <p>${escapeHtml(error?.message || `Could not ${phase || 'load'} this project app.`)}</p>
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
    const host = projectWorkspaceHost();
    const active = app.id === activePreviewTab;
    const leftRoot = $('#rProposalSection');
    const overlayRoot = $('#rOverlay');
    return runtime.mount({ main: panelRoot, left: leftRoot, overlay: overlayRoot }, app.appId, projectModalRuntimeContext({
      active,
      roots: { main: panelRoot, left: leftRoot, overlay: overlayRoot },
      panelRoot,
      previewRoot: panelRoot,
      leftRoot,
      overlayRoot,
      host,
      projectWorkspace: host
    })).then((handle) => {
      projectModalAppHandles.set(app.appId, handle);
      handle?.setActive?.(active);
      return handle;
    }).catch((error) => {
      projectModalAppHandles.delete(app.appId);
      renderProjectModalTabError(app, 'mount', error);
      console.warn(`Project modal app mount failed for ${app.appId}`, error);
      return null;
    });
  }

  function projectModalAppRuntimeContext(app, active){
    const panelRoot = document.querySelector(`#rOverlay .r-preview-panel[data-panel="${cssEscape(app?.id || '')}"]`);
    const leftRoot = $('#rProposalSection');
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
      projectWorkspace: host
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
    projectModalApps().forEach((tab) => {
      if (!tabs.some((entry) => entry.id === tab.id)) {
        tabs.push({
          id: tab.id,
          label: tab.id === 'map' ? projectOverviewTabLabel() : (tab.label || tab.title || tab.id),
          icon: tab.icon || '',
          pending: !!tab.pending,
          disabled: !!tab.disabled
        });
      }
    });
    if (!projectModalAppsShouldInlineMap() && !tabs.some((entry) => entry.id === 'map')) {
      tabs.unshift({ id:'map', label: projectOverviewTabLabel(), icon:'fa-table-columns' });
    }
    return tabs;
  }

  function syncProjectViewerTabs(){
    ensureProjectModalAppPanels();
    projectViewer?.setTabs(projectViewerTabs());
  }

  function validPreviewTabs(){
    const tabs = [];
    projectModalApps().forEach((app) => {
      if (!tabs.includes(app.id)) tabs.push(app.id);
    });
    if (!projectModalAppsShouldInlineMap() && !tabs.includes('map')) tabs.unshift('map');
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
    return projectOverviewIsMapOnly() ? 'Map' : 'Overview';
  }

  function projectDefaultPreviewTab(){
    return projectModalAppsShouldInlineMap() ? 'measurements' : 'map';
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
    return firstMeasurementId(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.folder,
      raw.id,
      raw.project_id,
      reportOrderState?.data?.folder,
      reportOrderState?.data?.project?.id,
      reportOrderState?.data?.project?.project_id,
      activeBaseProject?.measurement_project_id,
      activeBaseProject?.project_id,
      activeBaseProject?.folder,
      measurementIdFromAssetUrl(
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
      )
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
      <div class="r-viewer-item"><div class="r-viewer-k">Address</div><div class="r-viewer-v">${escapeHtml(($('#rAddress')?.value || reportOrderState?.address || '—').trim() || '—')}</div></div>
      <div class="r-viewer-item"><div class="r-viewer-k">Project Type</div><div class="r-viewer-v">${escapeHtml(TYPE_META[selectedType]?.label || selectedType || '—')}</div></div>
      <div class="r-viewer-item"><div class="r-viewer-k">Customer</div><div class="r-viewer-v">${contactLines.length ? contactLines.map(escapeHtml).join('<br>') : '—'}</div></div>
    `;
  }

  function syncProjectNotesPlacement(){
    const notes = document.querySelector('#rOverlay .r-bottom-notes');
    const inlineMount = $('#rInlineNotesMount');
    const mobileDetailMount = $('#rMobileInternalNotesMount');
    const bottomMount = document.querySelector('#rOverlay .r-left-bottom');
    if (!notes || !inlineMount || !bottomMount) return;
    const mobileInline = !projectLeftColumnOverridden() && window.matchMedia?.('(max-width: 720px)')?.matches;
    const target = mobileInline ? (mobileDetailMount || inlineMount) : bottomMount;
    if (notes.parentElement !== target) target.appendChild(notes);
    const proposalNotesMode = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    notes.classList.toggle('collapsed', proposalNotesMode && proposalInternalNotesCollapsed);
    notes.querySelector('.r-bottom-notes-toggle')?.setAttribute('aria-expanded', proposalNotesMode && !proposalInternalNotesCollapsed ? 'true' : 'false');
    inlineMount.classList.toggle('has-notes', mobileInline);
    mobileDetailMount?.classList.toggle('has-notes', mobileInline);
    syncProposalAgentState();
    syncProposalBottomSendState();
  }

  function updateModalTitle(){
    const titleWrap = document.querySelector('#rOverlay .r-title-wrap');
    const sub = document.querySelector('#rOverlay .r-sub');
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
    const computed = savedTitle || (mode === 'address'
      ? (address || customerName || 'New Project')
      : (customerName || address || 'New Project'));
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
    if (!activeBaseProject && requestedWorkflow === 'contact') ensureContactOnlyBaseProject();
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
      project_notes: ($('#rProjectNotes')?.value || '').trim(),
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      stage: activeBaseProject.stage || activeBaseProject.stage_id || INITIAL_PROJECT_STAGE_ID,
      stage_id: activeBaseProject.stage_id || activeBaseProject.stage || INITIAL_PROJECT_STAGE_ID,
      workflow_state: nextWorkflowState,
      measurement: measurementProject,
      measurement_project: measurementProject,
      events: Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [],
      proposals
    });
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
      project_notes: ($('#rProjectNotes')?.value || '').trim(),
      stage: INITIAL_PROJECT_STAGE_ID,
      stage_id: INITIAL_PROJECT_STAGE_ID,
      workflow_state: 'draft',
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      measurement: {},
      measurement_project: {},
      events: [],
      proposals,
      updated_at: new Date().toISOString()
    });
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
      project_notes: ($('#rProjectNotes')?.value || '').trim(),
      stage: INITIAL_PROJECT_STAGE_ID,
      stage_id: INITIAL_PROJECT_STAGE_ID,
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
    window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    return activeBaseProject;
  }

  function ensureProposalOnlyBaseProject(){
    if (!window.Portal.ProjectStore) return null;
    if (activeBaseProject) {
      activeBaseProject.workflow_state = activeBaseProject.workflow_state || 'proposal_only';
      persistActiveBaseProject();
      return activeBaseProject;
    }
    activeBaseProject = window.Portal.ProjectStore.save({
      id: `project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      title: manualProjectTitle(),
      address: ($('#rAddress')?.value || '').trim(),
      project_type: selectedType || 'residential',
      contacts: collectContacts(),
      project_notes: ($('#rProjectNotes')?.value || '').trim(),
      stage: INITIAL_PROJECT_STAGE_ID,
      stage_id: INITIAL_PROJECT_STAGE_ID,
      photos: projectPhotos.map(serializablePhoto),
      thumbnail_photo_id: projectPhotoId(projectThumbnailPhoto()),
      thumbnail_photo: serializablePhoto(projectThumbnailPhoto()),
      workflow_state: 'proposal_only',
      measurement: {},
      measurement_project: {},
      events: [],
      proposals,
      updated_at: new Date().toISOString()
    });
    return activeBaseProject;
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
        card.innerHTML = `<strong>Report canceled</strong>This report order was canceled. You can reorder it from the Reports tab.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      if (reportOrderIsRejected()) {
        card.innerHTML = `<strong>Report rejected</strong>This report order was rejected. You can review it from the Reports tab.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      if (reportOrderIsStaleSubmitted()) {
        card.innerHTML = `<strong>Report not active</strong>This report order stalled before processing. You can reorder it from the Reports tab.`;
        renderProjectViewerSummary();
        updateModalTitle();
        return;
      }
      if (!reportOrderIsActivelyPending() && !reportOrderIsCompleteLike()) {
        card.innerHTML = `<strong>Report not active</strong>This project does not have an active report order.`;
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

  function renderWorkflowState(){
    if (workflowRenderInProgress) return;
    const now = Date.now();
    if (now - workflowRenderLastAt < 32) {
      if (!workflowRenderScheduled) {
        workflowRenderScheduled = true;
        requestAnimationFrame(() => {
          workflowRenderScheduled = false;
          renderWorkflowState();
        });
      }
      return;
    }
    workflowRenderLastAt = now;
    workflowRenderInProgress = true;
    try {
      renderWorkflowStateBody();
    } finally {
      workflowRenderInProgress = false;
    }
  }

  function renderWorkflowStateBody(){
    normalizeReportSelection();
    if (shouldLockReportOrderingWorkflow()) {
      reportSelection = 'roof';
      if (!hasReportOrdered() && activePreviewTab !== 'map') setActivePreviewTab('map');
    }
    if (shouldUseMobileOrderPagination()) {
      reportSelection = 'roof';
      setActivePreviewTab('map');
    }
    const hasAddress = !!(($('#rAddress')?.value || '').trim());
    const typeReady = addressSelected || hasAddress;
    const reportReady = addressSelected && !!selectedType;
    const customerOpen = true;
    const typeCondensed = reportReady && !typePickerExpanded;
    let availableActions = availableProjectActions();
    if (workflowWantsAction() && autoSelectOnlyAction(availableActions)) availableActions = availableProjectActions();
    const roofNeedsPins = hasSelectedAddons();
    const hasAvailableActions = availableActions.length > 0;
    const reportCondensed = roofDecisionMade();
    const roofCondensed = false;

    setStepState('#rStepAddress', true, addressSelected ? 'complete' : 'active', typeReady);
    setStepState('#rStepType', typeReady, selectedType ? 'complete' : (typeReady ? 'active' : 'locked'), typeCondensed, { hidePrices: isProposalChoice() || isScheduleChoice() || typeCondensed });
    const mobileOrder = shouldUseMobileOrderPagination();
    const mobileReportOpen = mobileOrder && (addressSelected || mobileOrderPage !== 'location');
    const explicitActionWorkflow = !['project', 'contact'].includes(requestedWorkflow);
    setStepState('#rStepReport', mobileReportOpen || (explicitActionWorkflow && reportReady && hasAvailableActions), roofDecisionMade() ? 'complete' : (reportReady ? 'active' : 'locked'), mobileOrder ? false : reportCondensed, { hideHeadWhenCondensed: true });
    setStepState('#rStepRoof', reportReady && roofNeedsPins, roofNeedsPins ? (locationConfirmed ? 'complete' : 'active') : 'locked', roofCondensed);
    setStepState('#rStepCustomer', customerOpen, customerOpen ? 'active' : 'locked', false);

    const roofFields = $('#rRoofReportFields');
    const roofSkip = $('#rRoofSkipSummary');
    if (roofFields) roofFields.style.display = roofNeedsPins ? '' : 'none';
    if (roofSkip) roofSkip.style.display = isProposalChoice() ? '' : 'none';
    if (!projectPhotosEnabled() && activePreviewTab === 'photos') setActivePreviewTab('map');
    if (!projectDocsEnabled() && activePreviewTab === 'docs') setActivePreviewTab('map');
    if (!schedulePreviewAvailable() && activePreviewTab === 'schedule') setActivePreviewTab('map');
    if (!proposalsEnabled() && activePreviewTab === 'proposal') setActivePreviewTab('map');
    if (!reportsEnabled() && activePreviewTab === 'measurements') setActivePreviewTab('map');

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
    } else if (isScheduleChoice() && schedulePreviewAvailable() && activePreviewTab !== 'schedule') {
      setActivePreviewTab('schedule');
    } else if (!proposalWorkspaceOpen && isProposalChoice() && proposalsEnabled() && customerOpen) {
      setActivePreviewTab(projectDefaultPreviewTab());
    } else if (hasReportOrdered() && !validPreviewTabs().includes(activePreviewTab)) {
      setActivePreviewTab('measurements');
    } else if (hasSelectedAddons() && !hasReportOrdered() && activePreviewTab !== 'map' && !(activePreviewTab === 'schedule' && schedulePreviewAvailable())) {
      setActivePreviewTab('map');
    }
    syncReportExpediteMinuteRefresh();
    requestAnimationFrame(updateScrollCue);
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
    const target = document.querySelector('#rRoofReportFields .r-addon-toggle.visible')
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
    const pacificStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const pacific = new Date(pacificStr);
    const hour = pacific.getHours();
    if (hour >= 20) {
      return 'We are currently closed for the evening. Roof reports placed now will be processed first thing tomorrow morning.';
    }
    return null;
  }

  function renderAfterHoursNotice(){
    const ahMsg = hasSelectedAddons() ? getAfterHoursMessage() : null;
    $('#rAfterHoursMsg').textContent = ahMsg || '';
    $('#rAfterHours').classList.toggle('visible', !!ahMsg);
  }

  function bindProjectModalCloseControls(){
    const overlay = $('#rOverlay');
    const closeX = $('#rMapCloseX');
    if (closeX && !closeX.__fmCloseBound) {
      closeX.__fmCloseBound = true;
      closeX.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(); });
    }
    const mobileClose = $('#rMobileClose');
    if (mobileClose && !mobileClose.__fmCloseBound) {
      mobileClose.__fmCloseBound = true;
      mobileClose.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); close(); });
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
        ${projectModalRegionHtml('left')}

        <div class="r-right" id="rMapWrap">
          <div class="r-tabbar" id="rProjectViewerTabs"></div>
          <div class="r-preview"><div class="r-preview-stage">
            ${projectModalAppPanelsHtml()}
          </div></div>
          <div class="r-proposal-topmode" id="rProposalTopMode"><div class="r-proposal-mode"><button type="button" class="r-proposal-mode-btn" data-proposal-mode="preview">Preview</button><button type="button" class="r-proposal-mode-btn" data-proposal-mode="edit">Edit</button></div></div>
          ${proposalMarkupDockHtml()}
          <div class="modal-close-x" id="rMapCloseX" data-fm-tooltip="Close"><i class="fas fa-times"></i></div>
          <div class="r-addon-info-popout" id="rAddonInfoPopout"></div>
        </div>
        <button type="button" class="r-scroll-cue" id="rScrollCue"><i class="fas fa-chevron-down"></i><span>Scroll for more</span></button>
        <button type="button" class="r-mobile-close" id="rMobileClose" data-fm-tooltip="Close"><i class="fas fa-times"></i></button>
        <div class="r-mobile-pager" id="rMobilePager">
          <button type="button" class="r-mobile-page-btn" id="rMobileBack"><i class="fas fa-arrow-left"></i><span>Back</span></button>
          <button type="button" class="r-mobile-page-btn primary" id="rMobileNext" disabled><span>Next</span><i class="fas fa-arrow-right"></i></button>
          <button type="button" class="r-mobile-page-btn primary" id="rMobileOrder" disabled>Order Report</button>
        </div>
        <div class="r-save-toast" id="rSaveToast">Saved</div>
        <div class="r-signing-overlay" id="rSigningOverlay">
          <div class="r-signing-top">
            <button type="button" class="r-signing-back" id="rSigningBack"><i class="fas fa-arrow-left"></i> Back</button>
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
    mountProjectModalRegionApps('left');
    projectViewer = new window.Portal.ProjectViewer({
      root: el,
      tabsEl: $('#rProjectViewerTabs'),
      panelSelector: '.r-preview-panel',
      tabClass: 'r-tab',
      onTabChange: (tab) => {
        if (tab === 'proposal') {
          showProposalWorkspace();
          return;
        }
        if (proposalWorkspaceOpen && proposals.length) {
          proposalActionExpanded = false;
          proposalSigningMode = false;
          if (tab === 'photos') setTimeout(revealCustomerSection, 40);
        }
        setActivePreviewTab(tab);
      }
    });
    mountProjectModalApps();
    syncProjectViewerTabs();
    mountProjectModalRegionApps('left');
    bindProjectModalCloseControls();

    $('#rProposalSend')?.addEventListener('click', () => {
      proposalActionExpanded = false;
      showToast('Proposal ready', 'Proposal prepared for sending.', true);
      renderActionRow();
    });
    $('#rProposalSign')?.addEventListener('click', () => {
      proposalActionExpanded = false;
      proposalSigningMode = true;
      proposalSigningSession = null;
      renderWorkflowState();
      renderSigningOverlay();
    });
    $('#rSignatureModal').addEventListener('click', (evt) => {
      if (evt.target === $('#rSignatureModal')) closeSignatureChooser();
    });
    $('#rOverlay .r-scroll')?.addEventListener('scroll', updateScrollCue, { passive: true });
    $('#rScrollCue')?.addEventListener('click', () => {
      const scroller = $('#rOverlay .r-scroll');
      if (!scroller) return;
      scroller.scrollTo({
        top: Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + Math.max(140, scroller.clientHeight * 0.72)),
        behavior: 'smooth'
      });
    });
    $('#rMobileBack')?.addEventListener('click', mobileOrderGoBack);
    $('#rMobileNext')?.addEventListener('click', mobileOrderGoNext);
    el.querySelector('.r-win')?.addEventListener('touchstart', handleMobileOrderSwipeStart, { passive: true });
    el.querySelector('.r-win')?.addEventListener('touchend', handleMobileOrderSwipeEnd, { passive: true });
    $('#rMobileOrder')?.addEventListener('click', () => {
      const submit = activeSubmitButton();
      if (!submit || submit.disabled) return;
      const form = $('#rForm');
      if (form?.requestSubmit) form.requestSubmit(submit);
      else submit.click();
    });
    $('#rContactContextBar')?.addEventListener('click', (event) => {
      const overview = event.target.closest('[data-contact-context-overview]');
      if (overview) {
        const context = activeContactContext;
        close();
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
    });
    $('#rProjectNotesToggle')?.addEventListener('click', () => {
      proposalInternalNotesCollapsed = !proposalInternalNotesCollapsed;
      syncProjectNotesPlacement();
    });
    $('#rProposalAgentToggle')?.addEventListener('click', () => {
      proposalAgentCollapsed = !proposalAgentCollapsed;
      syncProposalAgentState();
    });
    $('#rProposalAgentPrompt')?.addEventListener('input', (event) => {
      proposalAgentPrompt = event.target.value || '';
      syncProposalAgentState();
    });
    $('#rProposalAgentDictate')?.addEventListener('click', toggleProposalAgentDictation);
    $('#rProposalAgentSubmit')?.addEventListener('click', startProposalAgentProgress);
    $('#rProposalBottomSend')?.addEventListener('click', () => {
      if (!proposals.length) return;
      enterProposalSendMode('edit', [proposalStableId(proposals[activeProposalIndex], activeProposalIndex)]);
    });
    window.addEventListener('resize', updateScrollCue);
    window.addEventListener('resize', syncMobileOrderPagination);

    $('#rTypeGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.r-type-btn');
      if (!btn) return;
      const previousType = selectedType;
      selectedType = btn.dataset.type;
      typePickerExpanded = false;
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
      revealInLeftColumnIfBelow('#rStepReport');
      queueAutosaveNotice();
    });
    $('#rTypePill')?.addEventListener('click', (e) => {
      const pill = e.target.closest('[data-type-pill]');
      if (!pill || !selectedType || hasReportOrdered()) return;
      typePickerExpanded = true;
      renderWorkflowState();
    });

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
      });
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
    });
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
    });

    $('#rPinClear').addEventListener('click', () => {
      clearAllPins();
      locationConfirmed = false;
      renderWorkflowState();
      queueAutosaveNotice();
    });
    $('#rConfirm').addEventListener('click', () => {
      if (!hasSelectedAddons() || !addressSelected || pinCount() === 0) return;
      locationConfirmed = !locationConfirmed;
      renderWorkflowState();
      if (locationConfirmed) scrollReportControlsToTop();
      queueAutosaveNotice();
    });
    $('#rCcAdd').addEventListener('click', () => addCcRow(''));
    $('#rAddContact')?.addEventListener('click', (event) => openContactPicker(event.currentTarget));
    $('#rForm').addEventListener('submit', onSubmit);
    $('#rAddress')?.addEventListener('focus', () => {
      initMapOnce();
      preferMapForNewProjectInput();
    });
    $('#rAddress')?.addEventListener('input', preferMapForNewProjectInput);
    $('#rForm').addEventListener('input', (e) => {
      if (e.target.matches('input, textarea, select')) queueAutosaveNotice();
      if (e.target.matches('#rAddress, [data-field="name"], [data-field="phone"], [data-field="email"]')) updateModalTitle();
      if (hasReportOrdered()) renderProjectViewerSummary();
      persistActiveBaseProject();
    });
    $('#rForm').addEventListener('change', (e) => {
      if (e.target.matches('input, textarea, select')) queueAutosaveNotice();
      if (e.target.matches('#rAddress, [data-field="name"], [data-field="phone"], [data-field="email"]')) updateModalTitle();
      if (hasReportOrdered()) renderProjectViewerSummary();
      persistActiveBaseProject();
    });
    document.addEventListener('keydown', handleGalleryKeydown);
    document.addEventListener('keydown', handleProposalPreviewKeydown);
    document.addEventListener('keydown', handleProjectModalKeydown);
    bindProposalModeToggle();
    bindProposalMarkupToggle();
    addContactCard();
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
        projectNotes: ($('#rProjectNotes').value || '').trim(),
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
      }
    };
    try { localStorage.setItem(PENDING_ORDER_KEY, JSON.stringify(obj)); } catch (e) {}
  }

  async function ensureCreditsOrGate(){
    const price = currentPrice();
    const cachedBalance = Number(window.Portal?.credits?.lastCredits);
    if (Number.isFinite(cachedBalance) && cachedBalance < price) {
      capturePendingOrder();
      showToast('No credits', `You need $${price} to place this roof report order.`, false);
      close();
      await openReportCreditGateTopup({
        label: 'this roof report',
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
    showToast('No credits', `You need $${price} to place this roof report order.`, false);
    close();
    await openReportCreditGateTopup({
      label: 'this roof report',
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
      const created = existingProject.created_at ? new Date(existingProject.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      overlay.innerHTML = `<div class="r-dup-dialog"><div class="r-dup-icon"><i class="fas fa-exclamation-triangle"></i></div><div class="r-dup-title">Duplicate report detected</div><div class="r-dup-body">It looks like a roof report was already ordered for this address. Do you still want to place a new roof report order?</div><div class="r-dup-match"><div class="r-dup-match-addr">${(existingProject.address || newAddress).replace(/</g, '&lt;')}</div><div class="r-dup-match-meta">Status: ${statusLabels[st] || existingProject.status || 'Unknown'}${created ? ' - Ordered: ' + created : ''}</div></div><div class="r-dup-actions"><button class="r-dup-btn" id="rDupCancel">Cancel</button><button class="r-dup-btn primary" id="rDupProceed">Order Anyway</button></div></div>`;
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
    if (selectedReportExpeditePricingPending()) {
      showToast('Pricing still loading', 'Please wait for the current expedited price before ordering.', false);
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
      address: ($('#rAddress').value || '').trim(),
      residentName: primary.name || '',
      residentEmail: primary.email || '',
      residentPhone: primary.phone || '',
      contacts: JSON.stringify(contacts),
      project_title: manualProjectTitle(),
      project_notes: ($('#rProjectNotes').value || '').trim(),
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
    };
    try {
      const { data } = await postAction('queue', payload);
      if (!data || !data.success) {
        const msg = data?.error || 'Submission failed.';
        btn.disabled = false;
        updateSubmitLabel();
        if (String(msg).toLowerCase().includes('credit')) {
          capturePendingOrder();
          await openReportCreditGateTopup({
            label: 'this roof report',
            required: currentPrice(),
            balance: Number(window.Portal?.credits?.lastCredits),
            context: 'server_credit_reject'
          });
          showToast('No credits', 'Top up to submit this exact roof report order.', false);
          return;
        }
        showToast('Order issue', msg, false);
        return;
      }
      try { localStorage.removeItem(PENDING_ORDER_KEY); } catch (ex) {}
      showToast('Roof report ordered', getAfterHoursMessage() || 'Report is now processing.', true);
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
      showToast('Couldn’t submit order', error?.message || 'Connection error. Please try again.', false);
      window.Portal.credits.refreshCredits().catch(() => null);
      window.dispatchEvent(new CustomEvent('fm:projects:refresh', { detail: { redraw: true } }));
    }
  }

  function googleMapsReady(...args){ return !!projectMapInvoke('googleMapsReady', args); }
  function setMapHint(...args){ return projectMapInvoke('setMapHint', args); }
  function syncOverviewMapMode(...args){ return projectMapInvoke('syncOverviewMapMode', args); }
  function initMapOnce(...args){ return projectMapInvoke('initMapOnce', args); }
  function initializeMapView(...args){ return projectMapInvoke('initializeMapView', args); }

  function hydrateFromBaseProject(baseProject){
    const base = baseProject || {};
    activeBaseProject = base;
    activeBaseProject.events = Array.isArray(activeBaseProject.events) ? activeBaseProject.events : [];
    addressSelected = !!base.address;
    locationConfirmed = true;
    selectedType = base.project_type || 'residential';
    typePickerExpanded = false;
    const hasBaseMeasurement = projectHasReportOrder(base);
    reportSelection = hasBaseMeasurement ? 'roof' : (base.workflow_state === 'proposal_only' ? 'proposal' : reportSelection);
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
    if ($('#rProjectNotes')) $('#rProjectNotes').value = base.project_notes || '';
    projectPhotos = normalizeProjectPhotoList(base);
    syncProjectPhotosFromLibrary();
    proposals = Array.isArray(base.proposals) ? base.proposals : [];
    normalizeProposalCollection();
    proposalBackendLoadedProjectId = '';
    hydrateProposalsFromBackend({ render: true, force: true }).catch((error) => console.warn('Proposal load failed', error));
    activeProposalIndex = proposals.length ? Math.min(activeProposalIndex, proposals.length - 1) : 0;
    if (reportSelection && !actionAvailable(reportSelection)) reportSelection = null;
    activePhotoIndex = 0;
    $('#rContactList').innerHTML = '';
    const resolvedContacts = contactForProjectModal(base);
    const contacts = resolvedContacts.length ? resolvedContacts : [{ name: '', phone: '', email: '' }];
    const primaryIndex = contacts.findIndex((contact) => contact?.primary);
    primaryContactIndex = primaryIndex >= 0 ? primaryIndex : 0;
    contacts.forEach((contact) => addContactCard(contact));
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
      setActivePreviewTab('measurements');
    }
  }

  function resetNewProjectState(){
    activeBaseProject = null;
    resetCustomerPortalApp();
    viewingExistingProject = false;
    reportOrderState = null;
    requestedWorkflow = 'project';
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
    $('#rCustom').value = '0';
    $('#rComps').value = '{}';
    $('#rCcList').innerHTML = '';
    $('#rContactList').innerHTML = '';
    addContactCard();
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
      showToast('Access denied', 'You do not have permission to reorder reports.', false);
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
    showToast('Reorder ready', 'The previous order settings were pre-filled with the corrected project type.', true);
    return true;
  }

  function open(baseProject = null, options = {}){
    if (!baseProject && !hasPerm('order_reports')) {
      showToast('Access denied', 'You do not have permission to start this workflow.', false);
      return;
    }
    ensureUI();
    const overlay = $('#rOverlay');
    syncContactsFeatureState();
    overlay.classList.add('active');
    requestModalHandle?.unregister?.();
    requestModalHandle = window.Portal?.modals?.register?.(overlay, {
      id: 'project-modal',
      closeOnEscape: true,
      closeOnBackdrop: false,
      onClose: () => close()
    }) || null;
    resetNewProjectState();
    requestedWorkflow = baseProject ? 'project' : normalizeWorkflow(options.workflow || options.createWorkflow || options.intent);
    activeContactContext = baseProject ? normalizeContactContext(options.contactContext, baseProject) : null;
    modalInitialProjectIds = new Set((window.Portal.ProjectStore?.cachedIds?.() || []).map(String));
    viewingExistingProject = !!baseProject;
    if (baseProject) hydrateFromBaseProject(baseProject);
    else preloadFirstReportCheckoutEligibility();
    if (options.fromReorder) applyReorderPrefillState(baseProject || {});
    if (!baseProject) applyRequestedWorkflow();
    pendingRoutePhotoId = String(options.photo || '').trim();
    resetProjectModalAppPanels();
    renderAfterHoursNotice();
    clearTimeout(autosaveDebounceTimer);
    clearTimeout(autosaveToastTimer);
    $('#rSaveToast')?.classList.remove('visible');
    closeSignatureChooser();
    setProjectionMode(hasReportOrdered());
    if (!baseProject) clearProjectRoute();
    if (options.fromReorder) {
      setActivePreviewTab('map');
    } else {
      setActivePreviewTab(projectDefaultPreviewTab());
    }
    if (options.tab) setActivePreviewTab(options.tab);
    if (pendingRoutePhotoId && projectPhotosEnabled()) setActivePreviewTab('photos');
    renderContactContextBar();
    syncProjectViewerTabs();
    renderWorkflowState();
    mountProjectModalRegionApps('left');
    syncProjectModalAppActivation();
    syncActiveProjectRoute(pendingRoutePhotoId ? { photo: pendingRoutePhotoId, photoScope: 'project', projectTab: 'photos' } : {});
    if (options.proposalIntent) setTimeout(() => {
      applyProposalOpenIntent(options).catch((error) => console.warn('Proposal open intent failed', error));
    }, 0);
    scheduleProjectMapInitialize(baseProject, 120);
    setTimeout(() => {
      if (!hasReportOrdered()) {
        const firstContactName = document.querySelector('#rContactList [data-field="name"]');
        (firstContactName || $('#rAddress'))?.focus();
        if (!firstContactName) $('#rAddress')?.select?.();
      }
    }, 40);
    window.dispatchEvent(new CustomEvent('fm:modal:open', { detail: { open: true, id: 'request' } }));
  }

  function close(){
    clearTimeout(projectMapInitTimer);
    projectMapInitTimer = 0;
    requestModalHandle?.unregister?.();
    requestModalHandle = null;
    closeContactPicker();
    closeContactActionMenu();
    activeContactContext = null;
    renderContactContextBar();
    setProjectPhotoFocus(false);
    pendingRoutePhotoId = '';
    clearProjectRoute();
    stopProposalAgentActivity();
    clearCancellationCountdown();
    stopReportExpediteMinuteRefresh();
    closeAddonInfoSurfaces();
    projectTodoController?.destroy?.();
    projectTodoController = null;
    projectTodoLoadedFor = '';
    const discarded = discardEmptyNewProjectDraft();
    disposeInstantMeasurement();
    const ov = $('#rOverlay');
    if (ov) {
      ov.classList.remove('active', 'proposal-workspace', 'left-override', 'materials-workspace', 'money-workspace', 'schedule-workspace');
      delete ov.dataset.leftOverrideTab;
    }
    proposalTabModule()?.deactivate?.();
    projectPhotosTabModule()?.deactivate?.();
    (window.Portal?.modules?.projectDocsTab || window.Portal?.ProjectDocsTab)?.deactivate?.();
    if (discarded) setTimeout(() => showToast('Empty project discarded', 'No project was saved.', true), 0);
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
      open(null, { workflow });
    });
    loadBranchPresentationStyle().catch(() => null);
    loadBranchProposalTemplates().catch(() => null);
    loadBranchProjectConfig().catch(() => null);
    loadBranchStageConfig().catch(() => null);
    updateButtonVisibility();
    window.setTimeout(() => openStructureReorderFromUrl(), 250);
  });

  window.addEventListener('fm:perms:updated', updateButtonVisibility);
  window.addEventListener('fm:project-config:updated', (event) => {
    branchProjectConfig = normalizeProjectConfig(event?.detail || branchProjectConfig);
    window.PlatformCelebrations?.configure?.({ mode: branchProjectConfig.celebrations_mode });
    updateModalTitle();
  });
  function handleStageModuleUpdated(event){
    const moduleId = cleanStageText(event?.detail?.moduleId || event?.detail?.module_id || event?.detail?.id);
    if (moduleId !== 'stages' && moduleId !== 'variable_mappings') return;
    branchStageConfig = null;
    loadBranchStageConfig({ refresh: true }).catch(() => null);
  }
  window.addEventListener('fm:branch-module:updated', handleStageModuleUpdated);
  window.addEventListener('fm:settings-pages:module-updated', handleStageModuleUpdated);
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
      'stage',
      'stage_id'
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
      'stage',
      'stage_id',
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
    const useMeasurementResolver = looksLikeMeasurementOnlyRecord(project);
    const resolved = !useMeasurementResolver
      ? await hydratePlatformProjectForOpen(project)
      : (await window.Portal.ProjectStore?.ensureFromMeasurementAsync?.(project) || window.Portal.ProjectStore?.ensureFromMeasurement?.(project) || project);
    const base = useMeasurementResolver ? mergeProjectForViewing(resolved, project) : resolved;
    open(base, options);
  }

  async function restoreRouteState(){
    const route = window.Portal?.routeState?.get?.() || {};
    if (!route.project || route.photoScope === 'feed' || routeRestoreInFlight) return;
    routeRestoreInFlight = true;
    try {
      if (route.projectTab || route.tab) {
        await window.Portal?.appFlags?.load?.().catch(() => null);
      }
      const project = await window.Portal?.routeState?.resolveProject?.(route.project);
      if (!project) return;
      await openProject(project, {
        tab: route.photo ? 'photos' : (route.projectTab || route.tab),
        photo: route.photo,
        fromRoute: true
      });
    } catch (error) {
      console.warn('Could not restore project route', error);
    } finally {
      routeRestoreInFlight = false;
    }
  }

  function refreshProjectModalForAppFlags(){
    if (!document.querySelector('#rOverlay')) return;
    syncContactsFeatureState();
    renderProjectStageBar();
    if (!validPreviewTabs().includes(activePreviewTab)) setActivePreviewTab(projectDefaultPreviewTab());
    renderWorkflowState();
    window.Portal?.modules?.projectMap?.renderOverview?.();
    syncProjectViewerTabs();
    mountProjectModalRegionApps('left');
    mountProjectModalApps();
    syncProjectModalAppActivation();
  }

  function ensureProjectRequestStyles(){
    injectCSS('request', css);
  }

  window.Portal.modules.request = { open, openProject, close, setPhotos, restoreRouteState, ensureStyles: ensureProjectRequestStyles, ensureProposalContext: installProposalContextAccessors };
  window.addEventListener('popstate', () => restoreRouteState());
  window.addEventListener('fm:platform-session:updated', () => restoreRouteState());
  window.addEventListener('fm:app-flags:updated', () => {
    restoreRouteState();
    refreshProjectModalForAppFlags();
  });
  window.setTimeout(() => restoreRouteState(), 900);
})();
