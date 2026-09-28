/* public/libraries/apps/proposals/project.js
 *
 * ============================== DEPRECATED ==============================
 * LEGACY proposals app (2026-08): superseded by the document engine
 * (apps/documents + doc-model/doc-editor/doc-renderer) surfaced through the
 * unified project "Docs" tab (apps/docs/project.js). Do NOT build new
 * features here and do NOT surface this tab in new work.
 *
 * The module still loads because live code depends on its exports:
 *   - apps/documents/project.js — scope-workflow + scope-generation bridges
 *     (startProjectScopeWorkflow, renderProjectScopeBuilder,
 *     proposalBuilderScopeForTemplate) until they move into the workflow
 *     runtime at legacy teardown.
 *   - customer_portal/*, proposal_renderer.html — render historical signed
 *     proposals through Portal.modules.proposalsTab.
 * The project-modal tab registration below is kept but hidden
 * (visible:false) so the code stays reachable for debugging old records —
 * flip it back to true locally if you ever need the legacy tab.
 * ========================================================================
 *
 * Project modal Proposals tab lifecycle.
 *
 * The request modal owns the modal shell and tab transitions. This module owns
 * the Proposals tab mount points, editor, previewer, manager, send flow, and
 * PDF actions.
 */
(function(){
  if (!window.Portal) return;

  const Portal = window.Portal;
  const runtime = window.FirstMateEmbeddableApps;
  const util = Portal.util || {};
  const $ = util.$ || ((sel, root = document) => root.querySelector(sel));
  const cfg = Portal.cfg || window.__APP || {};
  const escapeHtml = util.escapeHtml || ((value) => String(value ?? '').replace(/[&<>"']/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[match])));
  const injectCSS = util.injectCSS || (() => {});
  const fmUrl = util.fmUrl || ((path) => String(path || ''));
  const fmJson = util.fmJson || null;
  const fmPost = util.fmPost || null;
  const platformJson = util.platformJson || null;
  const currentActor = util.currentActor || (() => ({}));
  const formatDate = util.formatDate || ((value) => String(value || ''));
  const showToast = (Portal.ui && typeof Portal.ui.showToast === 'function') ? Portal.ui.showToast : (() => {});

  const state = {
    mounted: false,
    active: false,
    host: null,
    model: null,
    context: null,
    leftRoot: null,
    previewRoot: null,
    overlayRoot: null,
    renderDepth: 0,
    pendingPreviewScrollTop: null,
    readOnlyPresentationStyleLoad: null,
    richToolbarResizeBound: false
  };
  const proposalAutoPlayedVideoKeys = new Set();

  const PROPOSAL_PREVIEW_PAGE_WIDTH = 820;
  const PROPOSAL_PAPER_SIZES = Object.freeze({
    letter: Object.freeze({ key: 'letter', label: (globalThis.PlatformLanguage?.text("proposals","m_510d950619c4d1","Letter") ?? "Letter"), detail: '8.5 × 11 in', widthIn: 8.5, heightIn: 11, cssWidth: '8.5in', cssHeight: '11in' }),
    legal: Object.freeze({ key: 'legal', label: (globalThis.PlatformLanguage?.text("proposals","m_80080614b45493","Legal") ?? "Legal"), detail: '8.5 × 14 in', widthIn: 8.5, heightIn: 14, cssWidth: '8.5in', cssHeight: '14in' }),
    a4: Object.freeze({ key: 'a4', label: 'A4', detail: '210 × 297 mm', widthIn: 210 / 25.4, heightIn: 297 / 25.4, cssWidth: '210mm', cssHeight: '297mm' })
  });
  const PROPOSAL_LETTER_PAGE_HEIGHT = PROPOSAL_PREVIEW_PAGE_WIDTH * PROPOSAL_PAPER_SIZES.letter.heightIn / PROPOSAL_PAPER_SIZES.letter.widthIn;

  function normalizeProposalPaperSize(value){
    const key = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
    if (key === 'legal' || key === 'us-legal') return 'legal';
    if (key === 'a4' || key === 'iso-a4') return 'a4';
    return 'letter';
  }

  function getProposalPaperSize(proposal = proposals?.[activeProposalIndex]){
    const key = normalizeProposalPaperSize(proposal?.paperSize || proposal?.paper_size);
    return PROPOSAL_PAPER_SIZES[key] || PROPOSAL_PAPER_SIZES.letter;
  }

  function proposalPaperDimensions(proposal = proposals?.[activeProposalIndex]){
    const paper = getProposalPaperSize(proposal);
    const widthPx = PROPOSAL_PREVIEW_PAGE_WIDTH * paper.widthIn / PROPOSAL_PAPER_SIZES.letter.widthIn;
    return {
      ...paper,
      widthPx,
      heightPx: widthPx * paper.heightIn / paper.widthIn,
      widthPt: paper.widthIn * 72,
      heightPt: paper.heightIn * 72
    };
  }

  function proposalPageCssVariables(proposal = proposals?.[activeProposalIndex]){
    const dimensions = proposalPaperDimensions(proposal);
    return `--proposal-page-base-width:${dimensions.widthPx.toFixed(3)}px;--proposal-page-base-height:${dimensions.heightPx.toFixed(3)}px`;
  }

  function proposalPageHeightDelta(proposal = proposals?.[activeProposalIndex]){
    return proposalPaperDimensions(proposal).heightPx - PROPOSAL_LETTER_PAGE_HEIGHT;
  }
  const PROPOSAL_DEFAULT_SALES_TAX_PERCENT = 0;
  const PROPOSAL_DEFAULT_PAYMENT_SCHEDULE = [
    { key: 'deposit', label: (globalThis.PlatformLanguage?.text("proposals","m_894309a0cbf8a4","Deposit") ?? "Deposit"), percent: 30, due_rule: 'on_signature' },
    { key: 'progress', label: (globalThis.PlatformLanguage?.text("proposals","m_f74b29ad49ce79","Progress Payment") ?? "Progress Payment"), percent: 30, due_rule: 'manual' },
    { key: 'final', label: (globalThis.PlatformLanguage?.text("proposals","m_a9a97324d639c3","Final Payment") ?? "Final Payment"), percent: 40, due_rule: 'project_completion' },
  ];
  const PROPOSAL_PAYMENT_ROWS = [
    { key: 'deposit', labelField: 'depositLabel', amountField: 'depositAmount', percentField: 'depositPercent', defaultLabel: 'Deposit', due_rule: 'on_signature' },
    { key: 'progress', labelField: 'completionLabel', amountField: 'completionAmount', percentField: 'completionPercent', defaultLabel: 'Progress Payment', due_rule: 'manual' },
    { key: 'final', labelField: 'financedLabel', amountField: 'financedAmount', percentField: 'financedPercent', defaultLabel: 'Final Payment', due_rule: 'project_completion' },
  ];
  const PROPOSAL_FULL_ROOF_WORKFLOW = [
    'Sign proposal',
    'Deposit Paid',
    'Welcome call',
    'Schedule project with customer',
    'Schedule material deliveries',
    'Schedule crew arrival',
    'Schedule disposal equipment',
    'Start project',
    'Collect progress payment',
    'Finish project',
    'Collect final payment',
    'Thank you call'
  ];
  const PROPOSAL_REPAIR_WORKFLOW = [
    'Sign proposal',
    'Welcome call',
    'Schedule the project with the repairman',
    'The repairman arrives',
    'The project is paid and closed out',
    'Thank you call'
  ];
  const PROPOSAL_BUILDER_TEMPLATES = [
    {
      id: 'roof_replacement',
      name: 'Roof Replacement',
      label: (globalThis.PlatformLanguage?.text("proposals","m_f61704621c060b","Project Piece") ?? "Project Piece"),
      description: (globalThis.PlatformLanguage?.text("proposals","m_374a375092faec","Replacement scope with per-structure measurements, roofing materials, deliveries, and production scheduling.") ?? "Replacement scope with per-structure measurements, roofing materials, deliveries, and production scheduling."),
      details: 'A roof replacement includes the materials and labor needed to replace one or more roof structures. Measurements can be pulled from the roof report and updated during the first workflow step.',
      icon: 'fa-house-chimney',
      color: '#dc2626',
      workflow_steps: PROPOSAL_FULL_ROOF_WORKFLOW
    },
    {
      id: 'repairs',
      name: 'Repairs',
      label: (globalThis.PlatformLanguage?.text("proposals","m_f61704621c060b","Project Piece") ?? "Project Piece"),
      description: (globalThis.PlatformLanguage?.text("proposals","m_2a5b6132b2a466","Repair-first scope with a lighter workflow and closeout path.") ?? "Repair-first scope with a lighter workflow and closeout path."),
      details: 'Repairs are designed for focused work performed by a repair technician or small crew. They usually have a shorter schedule, simpler payment path, and fewer material-delivery requirements than a replacement.',
      icon: 'fa-screwdriver-wrench',
      color: '#eab308',
      workflow_steps: PROPOSAL_REPAIR_WORKFLOW
    },
    {
      id: 'gutters',
      name: 'Gutters',
      label: (globalThis.PlatformLanguage?.text("proposals","m_f61704621c060b","Project Piece") ?? "Project Piece"),
      description: (globalThis.PlatformLanguage?.text("proposals","m_008fd0b95a704b","Gutter scope with material, run length, and installation scheduling details.") ?? "Gutter scope with material, run length, and installation scheduling details."),
      details: 'Gutters covers removing existing gutters where needed and installing new gutter runs, downspouts, and related accessories. It can be estimated as its own project piece or alongside roofing work.',
      icon: 'fa-water',
      color: '#2563eb',
      workflow_steps: PROPOSAL_FULL_ROOF_WORKFLOW
    },
    {
      id: 'maintenance',
      name: 'Maintenance',
      label: (globalThis.PlatformLanguage?.text("proposals","m_f61704621c060b","Project Piece") ?? "Project Piece"),
      description: (globalThis.PlatformLanguage?.text("proposals","m_613cd5fd842991","Recurring or one-time maintenance work for upkeep, inspection, and minor service tasks.") ?? "Recurring or one-time maintenance work for upkeep, inspection, and minor service tasks."),
      details: 'Maintenance is designed for lighter upkeep work, inspections, cleaning, sealing, and minor service tasks that do not fit a replacement or repair scope.',
      icon: 'fa-clipboard-check',
      color: '#0d9488',
      workflow_steps: PROPOSAL_REPAIR_WORKFLOW
    },
    {
      id: 'siding_replacement',
      name: 'Siding Replacement',
      label: (globalThis.PlatformLanguage?.text("proposals","m_f61704621c060b","Project Piece") ?? "Project Piece"),
      description: (globalThis.PlatformLanguage?.text("proposals","m_993980429157e6","Siding replacement scope for exterior wall areas, materials, color, and crew scheduling.") ?? "Siding replacement scope for exterior wall areas, materials, color, and crew scheduling."),
      details: 'A siding replacement is designed for replacing exterior siding on one or more areas of the project. It can carry its own materials, color, workflow steps, and production planning.',
      icon: 'fa-layer-group',
      color: '#16a34a',
      workflow_steps: PROPOSAL_FULL_ROOF_WORKFLOW
    },
    {
      id: 'manual',
      name: 'Manual',
      label: (globalThis.PlatformLanguage?.text("proposals","m_6edcf7d7d41112","Custom") ?? "Custom"),
      description: (globalThis.PlatformLanguage?.text("proposals","m_b1bfb276d0573e","Start with a blank proposal and build it by hand.") ?? "Start with a blank proposal and build it by hand."),
      details: 'Manual is for unusual scopes that do not fit a saved project type yet. It uses the default company color and keeps the proposal editable by hand.',
      icon: 'fa-pen-to-square',
      color: 'var(--primary,#d93025)',
      manual: true,
      workflow_steps: []
    }
  ];
  const PROPOSAL_SCOPE_TEMPLATE_CATALOG = [...PROPOSAL_BUILDER_TEMPLATES];
  let proposalScopeTemplatesLoaded = false;
  let proposalScopeTemplatesPromise = null;

  function scopeTemplateWorkflowSteps(definition = {}){
    const steps = [];
    const visit = (nodes = []) => (Array.isArray(nodes) ? nodes : []).forEach((node) => {
      if (node?.actionable === true && node?.title) steps.push(String(node.title));
      visit(node?.children);
    });
    visit(definition?.work_plan?.root_nodes);
    return steps;
  }

  async function loadProposalScopeTemplates(options = {}){
    if (proposalScopeTemplatesLoaded && !options.refresh) return PROPOSAL_BUILDER_TEMPLATES;
    if (proposalScopeTemplatesPromise && !options.refresh) return proposalScopeTemplatesPromise;
    const orgId = typeof projectOrgId === 'function' ? projectOrgId() : String(cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || '').trim();
    if (!orgId || !window.PlatformAPI?.scopes?.list) return PROPOSAL_BUILDER_TEMPLATES;
    proposalScopeTemplatesPromise = window.PlatformAPI.scopes.list(orgId, proposalBranchId(), { include_disabled: true }).then((result) => {
      const templates = (Array.isArray(result?.templates) ? result.templates : []).map((record) => {
        const definition = record?.definition && typeof record.definition === 'object' ? record.definition : record;
        return {
          id: String(record.id || definition.id || '').trim(),
          name: String(record.name || definition.name || 'Project Piece').trim(),
          label: String(definition.label || (record.id === 'manual' ? 'Custom' : 'Project Piece')).trim(),
          description: String(record.description || definition.description || '').trim(),
          details: String(record.details || definition.details || '').trim(),
          icon: String(record.icon || definition.icon || 'fa-diagram-project').trim(),
          color: String(record.color || definition.color || 'var(--primary,#d93025)').trim(),
          enabled: record.enabled !== false,
          manual: String(record.id || definition.id) === 'manual',
          workflow_steps: scopeTemplateWorkflowSteps(definition),
          scope_template_version: Number(record.version || 1) || 1,
          scope_template_version_id: String(record.version_id || '').trim(),
          backend_definition: definition
        };
      }).filter((template) => template.id);
      // Keep disabled definitions available for historical project scopes, but
      // expose only enabled definitions as choices for new work.
      PROPOSAL_SCOPE_TEMPLATE_CATALOG.splice(0, PROPOSAL_SCOPE_TEMPLATE_CATALOG.length, ...templates);
      PROPOSAL_BUILDER_TEMPLATES.splice(0, PROPOSAL_BUILDER_TEMPLATES.length, ...templates.filter((template) => template.enabled));
      proposalScopeTemplatesLoaded = true;
      if (proposalWorkspaceMode === 'builder' && ['select', 'scope_choice'].includes(proposalBuilderState?.mode)) refreshProposalBuilderViews({ quiet: true });
      return PROPOSAL_BUILDER_TEMPLATES;
    }).catch((error) => {
      console.warn('Scope templates could not be loaded', error);
      return PROPOSAL_BUILDER_TEMPLATES;
    }).finally(() => { proposalScopeTemplatesPromise = null; });
    return proposalScopeTemplatesPromise;
  }
  const PROPOSAL_BUILDER_BRAND_LOGOS = {
    gaf: '/images/brand-logos/gaf.svg',
    owens_corning: '/images/brand-logos/owens-corning.svg',
    malarkey: '/images/brand-logos/malarkey.svg',
    certainteed: '/images/brand-logos/certainteed.svg',
  };
  let proposalSendAllowMultipleSelection = false;
  let proposalListMenuProposalId = '';
  let proposalBuilderState = null;
  let proposalBuilderContext = null;
  let proposalBuilderSearchRefreshTimer = null;
  let proposalBuilderQuietRender = false;
  let proposalBuilderMobileKeyboardBlurTimer = null;
  let proposalLineChoicePopoverState = null;
  let proposalLineMenuState = null;
  let proposalVariationMenuState = null;
  let proposalScopeExpanded = false;
  let proposalStyleTemplatesExpanded = false;
  let proposalStylesExpanded = false;
  let proposalPagesExpanded = true;
  const proposalMeasurementSourcePromises = new Map();


  // BEGIN LEGACY PROPOSAL ENGINE
  function proposalNumericValue(value){
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value ?? '').replace(/,/g, '').trim();
    if (!text) return null;
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : null;
  }

  function titleFromKey(value){
    return String(value || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'Option';
  }

  function normalizeProposalMeasurements(input = {}){
    const numeric = (value, fallback = 0) => {
      const next = proposalNumericValue(value);
      return Number.isFinite(next) ? next : fallback;
    };
    const whole = (value, fallback = 0) => Math.max(0, Math.round(numeric(value, fallback)));
    const customFormulaValues = Object.fromEntries(Object.entries(input || {})
      .filter(([key, value]) => /^custom_[a-z0-9_]+$/.test(key) && Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Number(value)]));
    const rawStructureMeasurements = Array.isArray(input.structureMeasurements) ? input.structureMeasurements : [];
    const structureCount = Math.max(1, rawStructureMeasurements.length || whole(input.structureCount ?? input.structures, 1));
    let flatRoofSquares = whole(input.flatRoofSquares, 0);
    let pitch2to4Squares = whole(input.pitch2to4Squares, 0);
    let pitch4to6Squares = whole(input.pitch4to6Squares, 0);
    let pitch6to8Squares = whole(input.pitch6to8Squares, 0);
    let pitch9to12Squares = whole(input.pitch9to12Squares, 0);
    let pitch13PlusSquares = whole(input.pitch13PlusSquares, 0);
    let shingleSquares = pitch2to4Squares + pitch4to6Squares + pitch6to8Squares + pitch9to12Squares + pitch13PlusSquares;
    let roofSquares = shingleSquares + flatRoofSquares;
    const suppliedRoofSquares = whole(input.roofSquares, 0);
    const suppliedShingleSquares = whole(input.shingleSquares, 0);
    if (roofSquares <= 0 && suppliedRoofSquares > 0) {
      pitch4to6Squares = suppliedRoofSquares;
      shingleSquares = suppliedRoofSquares;
      roofSquares = suppliedRoofSquares;
    } else if (shingleSquares <= 0 && suppliedShingleSquares > 0) {
      pitch4to6Squares = suppliedShingleSquares;
      shingleSquares = suppliedShingleSquares;
      roofSquares = shingleSquares + flatRoofSquares;
    } else if (suppliedRoofSquares > roofSquares) {
      roofSquares = suppliedRoofSquares;
    }
    return {
      ...customFormulaValues,
      flatRoofSquares,
      pitch2to4Squares,
      pitch4to6Squares,
      pitch6to8Squares,
      pitch9to12Squares,
      pitch13PlusSquares,
      shingleSquares,
      roofSquares,
      wastePercent: whole(input.wastePercent, 0),
      eavesLf: whole(input.eavesLf, 0),
      rakesLf: whole(input.rakesLf, 0),
      hipsLf: whole(input.hipsLf, 0),
      ridgesLf: whole(input.ridgesLf, 0),
      valleyLf: whole(input.valleyLf, 0),
      transitionsLf: whole(input.transitionsLf, 0),
      sideWallLf: whole(input.sideWallLf, 0),
      headWallLf: whole(input.headWallLf, 0),
      gutterLf: whole(input.gutterLf, 0),
      downspoutLf: whole(input.downspoutLf, 0),
      structures: structureCount,
      structureCount,
      structureMeasurements: rawStructureMeasurements.map((structure, index) => ({
        name: String(structure?.name || structure?.label || (structureCount === 1 ? 'Single structure' : `Structure ${index + 1}`)),
        flatRoofSquares: whole(structure?.flatRoofSquares, 0),
        pitch2to4Squares: whole(structure?.pitch2to4Squares, 0),
        pitch4to6Squares: whole(structure?.pitch4to6Squares, 0),
        pitch6to8Squares: whole(structure?.pitch6to8Squares, 0),
        pitch9to12Squares: whole(structure?.pitch9to12Squares, 0),
        pitch13PlusSquares: whole(structure?.pitch13PlusSquares, 0),
        shingleSquares: whole(structure?.shingleSquares, 0),
        roofSquares: whole(structure?.roofSquares, 0),
        eavesLf: whole(structure?.eavesLf, 0),
        rakesLf: whole(structure?.rakesLf, 0),
        hipsLf: whole(structure?.hipsLf, 0),
        ridgesLf: whole(structure?.ridgesLf, 0),
        valleyLf: whole(structure?.valleyLf, 0),
        transitionsLf: whole(structure?.transitionsLf, 0),
        sideWallLf: whole(structure?.sideWallLf, 0),
        headWallLf: whole(structure?.headWallLf, 0),
        gutterLf: whole(structure?.gutterLf, 0),
        downspoutLf: whole(structure?.downspoutLf, 0),
        chimneysEa: whole(structure?.chimneysEa, 0),
        skylightsEa: whole(structure?.skylightsEa, 0),
        pipeBootsEa: whole(structure?.pipeBootsEa, 0),
        roofVentsEa: whole(structure?.roofVentsEa, 0),
        ridgeVentLf: whole(structure?.ridgeVentLf, 0),
        boxVentsEa: whole(structure?.boxVentsEa, 0),
      })),
      chimneysEa: whole(input.chimneysEa, 0),
      skylightsEa: whole(input.skylightsEa, 0),
      pipeBootsEa: whole(input.pipeBootsEa, 0),
      roofVentsEa: whole(input.roofVentsEa, 0),
      ridgeVentLf: whole(input.ridgeVentLf, 0),
      boxVentsEa: whole(input.boxVentsEa, 0),
    };
  }

  function defaultProposalMeasurements(){
    return normalizeProposalMeasurements({
      structures: Math.max(1, pinCount() || 1),
      ...(window.FirstMateCustomFields?.valuesForFormula?.(typeof activeBaseProject !== 'undefined' ? activeBaseProject : window.activeBaseProject || {}) || {})
    });
  }

  function firstMeasurementId(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text && !/^project_/i.test(text) && !/^base_/i.test(text)) return text;
    }
    return '';
  }

  function measurementIdFromAssetUrl(...values){
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (!text) continue;
      const match = text.match(/\/projects\/([^/?#]+)/i);
      const id = match ? firstMeasurementId(decodeURIComponent(match[1] || '')) : '';
      if (id) return id;
    }
    return '';
  }

  function activeReportOrderData(){
    return window.reportOrderState && typeof window.reportOrderState === 'object' ? (window.reportOrderState.data || {}) : {};
  }

  function activeMeasurementProjectId(){
    const project = typeof activeBaseProject !== 'undefined' ? activeBaseProject : window.activeBaseProject;
    const measurement = project?.measurement_project || project?.measurement || {};
    const raw = measurement?.raw && typeof measurement.raw === 'object' ? measurement.raw : {};
    const reportData = activeReportOrderData();
    return firstMeasurementId(
      measurement.id,
      measurement.project_id,
      measurement.folder,
      measurement.measurement_project_id,
      raw.folder,
      raw.id,
      raw.project_id,
      project?.measurement_project_id,
      reportData?.folder,
      reportData?.project?.id,
      reportData?.project?.project_id,
      measurementIdFromAssetUrl(
        project?.report_url,
        project?.pdf_url,
        project?.summary_url,
        project?.xml_url,
        measurement.report_url,
        measurement.pdf_url,
        measurement.summary_url,
        measurement.xml_url,
        raw.report_url,
        raw.pdf_url,
        raw.summary_url,
        raw.xml_url,
        window.reportOrderState?.reportUrl,
        window.reportOrderState?.summaryUrl,
        window.reportOrderState?.xmlUrl
      )
    );
  }

  function firstNumberFromObject(source, keys = []){
    if (!source || typeof source !== 'object') return null;
    const normalizeKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliases = new Set();
    (keys || []).map(normalizeKey).filter(Boolean).forEach((key) => {
      aliases.add(key);
      aliases.add(`${key}sum`);
      aliases.add(`${key}total`);
      aliases.add(`${key}value`);
    });
    const valueKeys = ['value', 'amount', 'total', 'measurement', 'quantity', 'number', 'area', 'length', 'count'];
    for (const key of keys) {
      const value = key.split('.').reduce((item, part) => item && typeof item === 'object' ? item[part] : undefined, source);
      const number = proposalNumericValue(value);
      if (Number.isFinite(number) && number > 0) return number;
    }
    const seen = new Set();
    const scan = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = scan(item);
          if (found != null) return found;
        }
        return null;
      }
      for (const [key, item] of Object.entries(value)) {
        if (!aliases.has(normalizeKey(key))) continue;
        const number = proposalNumericValue(item);
        if (Number.isFinite(number) && number > 0) return number;
      }
      const label = normalizeKey(value.key || value.name || value.label || value.title || value.type || value.field || value.metric);
      if (label && aliases.has(label)) {
        for (const key of valueKeys) {
          const number = proposalNumericValue(value[key]);
          if (Number.isFinite(number) && number > 0) return number;
        }
      }
      for (const item of Object.values(value)) {
        const found = scan(item);
        if (found != null) return found;
      }
      return null;
    };
    return scan(source);
  }

  function meters2ToProposalSquares(value){
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return null;
    return Math.round(((number * 10.7639104167) / 100) * 10) / 10;
  }

  function pitchDegreesToRise12(degrees){
    const number = proposalNumericValue(degrees);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.round(Math.tan((number * Math.PI) / 180) * 12));
  }

  function pitchBucketForRise(rise){
    const value = proposalNumericValue(rise);
    if (!Number.isFinite(value)) return 'pitch4to6Squares';
    if (value <= 2) return 'flatRoofSquares';
    if (value <= 4) return 'pitch2to4Squares';
    if (value <= 6) return 'pitch4to6Squares';
    if (value <= 8) return 'pitch6to8Squares';
    if (value <= 12) return 'pitch9to12Squares';
    return 'pitch13PlusSquares';
  }

  function proposalMeasurementsFromRoofSegments(source){
    const found = [];
    const seen = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const areaMeters = proposalNumericValue(value.roof_area_meters2 ?? value.area_meters2 ?? value.area_m2 ?? value.roofAreaMeters2);
      const areaSqft = proposalNumericValue(value.roof_area_sqft ?? value.area_sqft ?? value.roofAreaSqft);
      const areaSquares = proposalNumericValue(value.roof_squares ?? value.squares ?? value.roofSquares);
      const pitchRise = proposalNumericValue(value.pitch_rise ?? value.pitchRise ?? value.pitch);
      const pitchDegrees = proposalNumericValue(value.pitch_degrees ?? value.pitchDegrees ?? value.slope_degrees);
      const squares = areaSquares
        ?? (areaSqft ? Math.round((areaSqft / 100) * 10) / 10 : null)
        ?? meters2ToProposalSquares(areaMeters);
      if (squares && (pitchRise != null || pitchDegrees != null || areaMeters != null || areaSqft != null)) {
        found.push({
          squares,
          rise: pitchRise ?? pitchDegreesToRise12(pitchDegrees),
        });
      }
      Object.values(value).forEach(visit);
    };
    visit(source);
    if (!found.length) return null;
    const grouped = normalizeProposalMeasurements({});
    found.forEach((segment) => {
      const bucket = pitchBucketForRise(segment.rise);
      grouped[bucket] = Math.round((Number(grouped[bucket] || 0) + Number(segment.squares || 0)) * 10) / 10;
    });
    return normalizeProposalMeasurements(grouped);
  }

  function proposalStructureListFromSource(source){
    const candidates = [
      source?.structures,
      source?.structureMeasurements,
      source?.structure_measurements,
      source?.instant_structures_json?.structures,
      source?.instant_structures_json?.structureMeasurements,
      source?.measurements_json?.structures,
      source?.measurement_json?.structures,
      source?.report_json?.structures,
      source?.summary_json?.structures,
      source?.report_data?.structures,
      source?.measurement_data?.structures,
      source?.measurement_data_json?.structures,
      source?.report?.structures,
      source?.result?.structures,
      source?.results?.structures,
      source?.data?.structures,
    ];
    return candidates.find((value) => Array.isArray(value) && value.length && value.every((item) => item && typeof item === 'object')) || [];
  }

  function proposalDistanceBetweenPoints(a, b){
    if (!a || !b) return null;
    const dx = (Number(a.x) || 0) - (Number(b.x) || 0);
    const dy = (Number(a.y) || 0) - (Number(b.y) || 0);
    const dz = (Number(a.z) || 0) - (Number(b.z) || 0);
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(distance) ? distance : null;
  }

  function proposalLineLength(line = {}){
    const explicit = proposalNumericValue(line.length_ft ?? line.lengthFt ?? line.length_lf ?? line.lengthLf ?? line.length);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return proposalDistanceBetweenPoints(line.start, line.end) || 0;
  }

  function proposalLineTypeBucket(type){
    const clean = String(type || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean.includes('ridge')) return 'ridgesLf';
    if (clean.includes('hip')) return 'hipsLf';
    if (clean.includes('eave')) return 'eavesLf';
    if (clean.includes('rake')) return 'rakesLf';
    if (clean.includes('valley')) return 'valleyLf';
    if (clean.includes('headwall') || clean.includes('apron')) return 'headWallLf';
    if (clean.includes('sidewall') || clean.includes('stepflashing')) return 'sideWallLf';
    if (clean.includes('trans')) return 'transitionsLf';
    return '';
  }

  function proposalStructureMeasurementsFromStructure(structure = {}, index = 0){
    const measurements = {
      name: String(structure.name || structure.label || structure.title || (index === 0 ? 'Single structure' : `Structure ${index + 1}`)),
    };
    (Array.isArray(structure.lines) ? structure.lines : []).forEach((line) => {
      const bucket = proposalLineTypeBucket(line?.type || line?.manualType || line?.label || line?.name);
      if (!bucket) return;
      measurements[bucket] = Number(measurements[bucket] || 0) + proposalLineLength(line);
    });
    const direct = normalizeProposalMeasurements({
      flatRoofSquares: firstNumberFromObject(structure, ['flatRoofSquares', 'flat_roof_squares', 'flat_squares']),
      pitch2to4Squares: firstNumberFromObject(structure, ['pitch2to4Squares', 'pitch_2_4_squares', '2_4_squares']),
      pitch4to6Squares: firstNumberFromObject(structure, ['pitch4to6Squares', 'pitch_4_6_squares', '4_6_squares']),
      pitch6to8Squares: firstNumberFromObject(structure, ['pitch6to8Squares', 'pitch_6_8_squares', '6_8_squares']),
      pitch9to12Squares: firstNumberFromObject(structure, ['pitch9to12Squares', 'pitch_9_12_squares', '9_12_squares']),
      pitch13PlusSquares: firstNumberFromObject(structure, ['pitch13PlusSquares', 'pitch_13_plus_squares', '13_plus_squares']),
      roofSquares: firstNumberFromObject(structure, ['roofSquares', 'roof_squares', 'total_squares']),
      shingleSquares: firstNumberFromObject(structure, ['shingleSquares', 'shingle_squares']),
      eavesLf: measurements.eavesLf || firstNumberFromObject(structure, ['eavesLf', 'eaves_lf', 'eave_length']),
      rakesLf: measurements.rakesLf || firstNumberFromObject(structure, ['rakesLf', 'rakes_lf', 'rake_length']),
      hipsLf: measurements.hipsLf || firstNumberFromObject(structure, ['hipsLf', 'hips_lf', 'hip_length']),
      ridgesLf: measurements.ridgesLf || firstNumberFromObject(structure, ['ridgesLf', 'ridges_lf', 'ridge_length']),
      valleyLf: measurements.valleyLf || firstNumberFromObject(structure, ['valleyLf', 'valley_lf', 'valley_length']),
      transitionsLf: measurements.transitionsLf || firstNumberFromObject(structure, ['transitionsLf', 'transitions_lf', 'transition_lf']),
      sideWallLf: measurements.sideWallLf || firstNumberFromObject(structure, ['sideWallLf', 'side_wall_lf', 'sidewall_lf']),
      headWallLf: measurements.headWallLf || firstNumberFromObject(structure, ['headWallLf', 'head_wall_lf', 'headwall_lf']),
      chimneysEa: firstNumberFromObject(structure, ['chimneysEa', 'chimneys', 'chimney_count']),
      skylightsEa: firstNumberFromObject(structure, ['skylightsEa', 'skylights', 'skylight_count']),
      pipeBootsEa: firstNumberFromObject(structure, ['pipeBootsEa', 'pipe_boots', 'pipe_boot_count']),
      roofVentsEa: firstNumberFromObject(structure, ['roofVentsEa', 'roof_vents', 'roof_vent_count']),
      ridgeVentLf: firstNumberFromObject(structure, ['ridgeVentLf', 'ridge_vent_lf', 'ridge_vent_length']),
      boxVentsEa: firstNumberFromObject(structure, ['boxVentsEa', 'box_vents', 'box_vent_count']),
    });
    return { ...direct, ...measurements };
  }

  function proposalAggregateStructureMeasurements(structures = []){
    const keys = [
      'flatRoofSquares', 'pitch2to4Squares', 'pitch4to6Squares', 'pitch6to8Squares', 'pitch9to12Squares', 'pitch13PlusSquares',
      'eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf', 'transitionsLf', 'sideWallLf', 'headWallLf', 'gutterLf', 'downspoutLf',
      'chimneysEa', 'skylightsEa', 'pipeBootsEa', 'roofVentsEa', 'ridgeVentLf', 'boxVentsEa'
    ];
    const aggregate = {};
    structures.forEach((structure) => {
      keys.forEach((key) => { aggregate[key] = Number(aggregate[key] || 0) + Number(structure?.[key] || 0); });
    });
    return normalizeProposalMeasurements({
      ...aggregate,
      structureCount: Math.max(1, structures.length || 1),
      structureMeasurements: structures,
    });
  }

  function proposalStructureMeasurementsFromSource(source){
    const structures = proposalStructureListFromSource(source);
    if (!structures.length) return [];
    return structures.map((structure, index) => ({
      ...proposalStructureMeasurementsFromStructure(structure, index),
      name: structures.length === 1 ? 'Single structure' : String(structure?.name || structure?.label || structure?.title || ((v0) => globalThis.PlatformLanguage?.text("proposals","m_e2943d71f406cb",`Structure ${v0}`,{v0}) ?? `Structure ${v0}`)(index + 1)),
    }));
  }

  function proposalVentilationSuggestionFromSource(source, structures = []){
    const explicitRidge = firstNumberFromObject(source, ['ridgeVentLf', 'ridge_vent_lf', 'ridge_vent_length', 'ridge_vent_linear_feet', 'required_ridge_vent_lf', 'suggested_ridge_vent_lf']);
    const explicitBox = firstNumberFromObject(source, ['boxVentsEa', 'box_vents', 'box_vent_count', 'required_box_vents', 'suggested_box_vents', 'box_vent_quantity']);
    const ventSettings = source?.ventSettings || source?.vent_settings || source?.report?.ventSettings || source?.data?.ventSettings || {};
    const reportSuggestsRidge = explicitRidge > 0 || ventSettings.include === true || String(ventSettings.type || ventSettings.mode || ventSettings.recommendation || '').toLowerCase().includes('ridge');
    if (reportSuggestsRidge) {
      const excluded = new Set((Array.isArray(ventSettings.excludedRidges) ? ventSettings.excludedRidges : []).map((value) => String(value)));
      const derivedRidge = structures.reduce((sum, structure, structureIndex) => {
        return sum + (Array.isArray(structure?.lines) ? structure.lines : []).reduce((lineSum, line, lineIndex) => {
          if (proposalLineTypeBucket(line?.type || line?.label || line?.name) !== 'ridgesLf') return lineSum;
          const id = String(line.id ?? line.key ?? lineIndex);
          if (excluded.has(id) || excluded.has(`${structureIndex}:${id}`)) return lineSum;
          return lineSum + proposalLineLength(line);
        }, 0);
      }, 0);
      const ridgeVentLf = explicitRidge || derivedRidge;
      if (ridgeVentLf > 0) return { ridgeVentLf, boxVentsEa: 0 };
    }
    if (explicitBox > 0) return { ridgeVentLf: 0, boxVentsEa: explicitBox };
    return { ridgeVentLf: 0, boxVentsEa: 0 };
  }

  function xmlTextToMeasurementObject(xmlText){
    const text = String(xmlText || '').trim();
    if (!text || typeof DOMParser === 'undefined') return {};
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return {};
      const out = {};
      const xmlAttr = (node, name) => node?.getAttribute?.(name) ?? '';
      const xmlPointCoordinates = (node) => {
        const data = xmlAttr(node, 'data');
        if (data) {
          const parts = data.split(',').map((part) => proposalNumericValue(part));
          return parts.length >= 3 ? { x: parts[0] || 0, y: parts[1] || 0, z: parts[2] || 0 } : null;
        }
        const x = proposalNumericValue(xmlAttr(node, 'x'));
        const y = proposalNumericValue(xmlAttr(node, 'y'));
        const z = proposalNumericValue(xmlAttr(node, 'z'));
        return x == null || y == null ? null : { x, y, z: z || 0 };
      };
      const addNumber = (key, value) => {
        const number = proposalNumericValue(value);
        if (!key || !Number.isFinite(number) || number <= 0) return;
        out[key] = Number(out[key] || 0) + number;
      };
      const addValue = (key, value) => {
        const cleanKey = String(key || '').trim();
        const number = proposalNumericValue(value);
        if (!cleanKey || !Number.isFinite(number) || number <= 0) return;
        if (out[cleanKey] == null) out[cleanKey] = number;
        else {
          const sumKey = `${cleanKey}_sum`;
          out[sumKey] = Number(out[sumKey] || out[cleanKey] || 0) + number;
        }
      };
      const walk = (el, path = []) => {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName || '';
        const nextPath = [...path, tag].filter(Boolean);
        const children = Array.from(el.children || []);
        const rawText = children.length ? '' : String(el.textContent || '').trim();
        if (rawText) {
          addValue(tag, rawText);
          addValue(nextPath.join('_'), rawText);
        }
        const label = el.getAttribute?.('name') || el.getAttribute?.('label') || el.getAttribute?.('type') || el.getAttribute?.('key');
        if (label && rawText) addValue(label, rawText);
        Array.from(el.attributes || []).forEach((attr) => {
          addValue(`${tag}_${attr.name}`, attr.value);
          if (label) addValue(`${label}_${attr.name}`, attr.value);
        });
        children.forEach((child) => walk(child, nextPath));
      };
      walk(doc.documentElement);

      const pointById = new Map();
      const pointByIndex = new Map();
      Array.from(doc.querySelectorAll('POINT')).forEach((node, index) => {
        const point = xmlPointCoordinates(node);
        if (!point) return;
        const id = xmlAttr(node, 'id') || String(index + 1);
        const explicitIndex = xmlAttr(node, 'index') || String(index + 1);
        pointById.set(id, point);
        pointByIndex.set(String(explicitIndex), point);
        pointByIndex.set(String(index + 1), point);
      });

      Array.from(doc.querySelectorAll('LINE')).forEach((node) => {
        const bucket = proposalLineTypeBucket(xmlAttr(node, 'type'));
        if (!bucket) return;
        let length = proposalNumericValue(xmlAttr(node, 'length')) ?? proposalNumericValue(xmlAttr(node, 'length_ft'));
        if (length == null) {
          const path = xmlAttr(node, 'path').split(',').map((part) => part.trim()).filter(Boolean);
          const start = xmlAttr(node, 'start') || path[0] || '';
          const end = xmlAttr(node, 'end') || path[path.length - 1] || '';
          length = proposalDistanceBetweenPoints(pointById.get(start) || pointByIndex.get(start), pointById.get(end) || pointByIndex.get(end));
        }
        addNumber(bucket, length);
      });

      const pitchBuckets = {};
      let totalAreaSqft = 0;
      let faceCount = 0;
      Array.from(doc.querySelectorAll('SURFACE, FACE')).forEach((node) => {
        const polygon = node.matches('FACE') ? node.querySelector('POLYGON') : null;
        const type = String(xmlAttr(node, 'type') || xmlAttr(polygon, 'type') || '').trim().toLowerCase();
        const area = proposalNumericValue(xmlAttr(node, 'area')) ?? proposalNumericValue(xmlAttr(polygon, 'size')) ?? proposalNumericValue(xmlAttr(polygon, 'area'));
        if (!Number.isFinite(area) || area <= 0) return;
        if (type && type !== 'roof' && !node.matches('SURFACE')) return;
        faceCount += 1;
        totalAreaSqft += area;
        const pitch = proposalNumericValue(xmlAttr(node, 'pitch')) ?? proposalNumericValue(xmlAttr(polygon, 'pitch'));
        const bucket = pitchBucketForRise(pitch);
        pitchBuckets[bucket] = Number(pitchBuckets[bucket] || 0) + (area / 100);
      });
      if (totalAreaSqft > 0) {
        out.roof_area_sqft = Math.round(totalAreaSqft);
        out.total_roof_area_sqft = Math.round(totalAreaSqft);
        out.roofSquares = Math.round((totalAreaSqft / 100) * 10) / 10;
        out.total_squares = out.roofSquares;
        out.shingleSquares = out.roofSquares;
        Object.entries(pitchBuckets).forEach(([key, value]) => {
          out[key] = Math.round(Number(value || 0) * 10) / 10;
        });
      }
      if (faceCount > 0) out.facet_count = faceCount;
      return out;
    } catch (error) {
      return {};
    }
  }

  async function fetchProposalArtifact(projectId, fileName, type = 'json'){
    if (!projectId || !fileName || !fmUrl) return null;
    try {
      const response = await fetch(fmUrl(`projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(fileName)}`));
      if (!response.ok) return null;
      if (type === 'text') return await response.text();
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  async function fetchProposalTextUrl(url){
    const textUrl = String(url || '').trim();
    if (!textUrl) return null;
    try {
      const response = await fetch(textUrl, { credentials: 'include' });
      if (!response.ok) return null;
      return await response.text();
    } catch (error) {
      return null;
    }
  }

  async function loadProposalMeasurementSource(projectId){
    if (!projectId || !fmJson) return {};
    if (proposalMeasurementCache.has(projectId)) return proposalMeasurementCache.get(projectId);
    if (proposalMeasurementSourcePromises.has(projectId)) return proposalMeasurementSourcePromises.get(projectId);
    const loadPromise = (async () => {
      proposalMeasurementLoads.add(projectId);
      try {
        const data = await fmJson(`projects/${encodeURIComponent(projectId)}`);
        const project = data?.project && typeof data.project === 'object' ? data.project : {};
        const manifest = project?.manifest && typeof project.manifest === 'object' ? project.manifest : {};
        const files = Array.isArray(project.files) ? project.files : [];
        const names = new Set(files.map((file) => String(file?.name || '')));
        const fileByLower = new Map(files.map((file) => [String(file?.name || '').toLowerCase(), String(file?.name || '')]));
        const artifactName = (name) => fileByLower.get(String(name || '').toLowerCase()) || '';
        const source = {
          detail: data,
          project,
          manifest,
          pdf_state: project?.pdf_state && typeof project.pdf_state === 'object' ? project.pdf_state : {},
          app_metadata: project?.app_metadata && typeof project.app_metadata === 'object' ? project.app_metadata : {},
          insights: project?.insights && typeof project.insights === 'object' ? project.insights : {}
        };
        const xmlName = artifactName('model_data.xml');
        let xml = null;
        if (xmlName) {
          xml = await fetchProposalArtifact(projectId, xmlName, 'text');
        }
        if (!xml) {
          const activeProject = typeof activeBaseProject !== 'undefined' ? activeBaseProject : window.activeBaseProject;
          const activeMeasurement = activeProject?.measurement_project || activeProject?.measurement || {};
          const activeRaw = activeMeasurement?.raw && typeof activeMeasurement.raw === 'object' ? activeMeasurement.raw : {};
          const xmlUrl = [
            activeProject?.xml_url,
            activeProject?.model_data_url,
            activeMeasurement.xml_url,
            activeMeasurement.model_data_url,
            activeRaw.xml_url,
            activeRaw.model_data_url
          ].map((value) => String(value || '').trim()).find((value) => value && value.includes(`/projects/${encodeURIComponent(projectId)}/`));
          xml = await fetchProposalTextUrl(xmlUrl);
        }
        if (xml) {
          const xmlMeasurements = xmlTextToMeasurementObject(xml);
          source.model_data_xml = xmlMeasurements;
          Object.assign(source, xmlMeasurements);
        }
        for (const fileName of ['measurements.json', 'measurement.json', 'measurement-data.json', 'report.json', 'summary.json', 'insights.json', 'instant-structures.json']) {
          const matchedName = artifactName(fileName);
          if (!matchedName) continue;
          const json = await fetchProposalArtifact(projectId, matchedName, 'json');
          if (json) source[fileName.replace(/[^a-z0-9]/gi, '_')] = json;
        }
        proposalMeasurementCache.set(projectId, source);
        return source;
      } catch (error) {
        return {};
      } finally {
        proposalMeasurementLoads.delete(projectId);
        proposalMeasurementSourcePromises.delete(projectId);
      }
    })();
    proposalMeasurementSourcePromises.set(projectId, loadPromise);
    return loadPromise;
  }

  function requestProposalMeasurementHydration(proposal){
    const projectId = activeMeasurementProjectId();
    if (!proposal || !projectId || proposalMeasurementLoads.has(projectId)) return;
    proposal.measurement_source = 'loading';
    const project = typeof activeBaseProject !== 'undefined' ? activeBaseProject : window.activeBaseProject;
    const sharedMeasurements = window.FirstMeasureAPI?.roofMeasurements;
    const load = sharedMeasurements?.load
      ? sharedMeasurements.load(project || {}, { reportOrderState: window.reportOrderState || {} })
      : loadProposalMeasurementSource(projectId).then((source) => ({ source, measurements: firstMeasureProposalMeasurements(source) }));
    load.then((result) => {
      if (!result) return;
      const hydrated = result.measurements || firstMeasureProposalMeasurements(result.source || {});
      if (!proposalMeasurementsHaveValues(hydrated || {})) {
        if (proposal.measurement_source === 'loading') proposal.measurement_source = 'manual_needed';
        renderProposalSection();
        return;
      }
      proposal.measurements = hydrated;
      proposal.measurement_source = 'firstmeasure';
      syncProposalPricebookItems(proposal);
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
    });
  }

  function firstMeasureProposalMeasurements(extraSource = {}){
    const project = typeof activeBaseProject !== 'undefined' ? activeBaseProject : window.activeBaseProject;
    const reportData = activeReportOrderData();
    const sharedMeasurements = window.FirstMeasureAPI?.roofMeasurements;
    if (sharedMeasurements?.fromProject) {
      const canonical = sharedMeasurements.fromProject(project || {}, {
        reportOrderState: window.reportOrderState || {},
        source: extraSource
      });
      if (sharedMeasurements.hasValues?.(canonical.measurements)) return normalizeProposalMeasurements(canonical.measurements);
    }
    const projectMeasurement = project?.measurement && typeof project.measurement === 'object' ? project.measurement : {};
    const projectMeasurementProject = project?.measurement_project && typeof project.measurement_project === 'object' ? project.measurement_project : {};
    const proposalRecords = [
      ...(typeof proposals !== 'undefined' && Array.isArray(proposals) ? proposals : []),
      ...(Array.isArray(project?.proposals) ? project.proposals : []),
    ];
    const seenProposalMeasurements = new Set();
    const proposalMeasurementSources = proposalRecords
      .map((proposal) => proposal?.measurements && typeof proposal.measurements === 'object' ? proposal.measurements : null)
      .filter((measurements) => {
        if (!measurements || !proposalMeasurementsHaveValues(normalizeProposalMeasurements(measurements))) return false;
        const key = JSON.stringify(measurements);
        if (seenProposalMeasurements.has(key)) return false;
        seenProposalMeasurements.add(key);
        return true;
      });
    const measurement = {
      ...reportData,
      ...projectMeasurement,
      ...projectMeasurementProject,
      ...proposalMeasurementSources.reduce((merged, measurements) => ({ ...merged, ...measurements }), {}),
    };
    const raw = {
      ...(reportData.raw && typeof reportData.raw === 'object' ? reportData.raw : {}),
      ...(projectMeasurement.raw && typeof projectMeasurement.raw === 'object' ? projectMeasurement.raw : {}),
      ...(projectMeasurementProject.raw && typeof projectMeasurementProject.raw === 'object' ? projectMeasurementProject.raw : {}),
      ...(measurement.raw && typeof measurement.raw === 'object' ? measurement.raw : {}),
    };
    const source = {
      ...raw,
      ...measurement,
      ...(extraSource && typeof extraSource === 'object' ? extraSource : {}),
      measurement,
      raw,
      report: measurement?.report,
      result: measurement?.result,
      results: measurement?.results,
      data: measurement?.data,
      measurements: measurement?.measurements,
      proposalMeasurements: proposalMeasurementSources,
      activeProjectMeasurement: project?.measurement,
      activeProjectMeasurementProject: project?.measurement_project,
    };
    const squaresFromSqft = (keys) => {
      const value = firstNumberFromObject(source, keys);
      return value == null ? null : Math.round((value / 100) * 10) / 10;
    };
    const squaresFromMeters2 = (keys) => meters2ToProposalSquares(firstNumberFromObject(source, keys));
    const segmentMeasurements = proposalMeasurementsFromRoofSegments(source);
    const sourceStructures = proposalStructureListFromSource(source);
    const structureMeasurements = proposalStructureMeasurementsFromSource(source);
    const structureAggregate = structureMeasurements.length ? proposalAggregateStructureMeasurements(structureMeasurements) : null;
    const ventilationSuggestion = proposalVentilationSuggestionFromSource(source, sourceStructures);
    const extracted = normalizeProposalMeasurements({
      structureCount: structureMeasurements.length || firstNumberFromObject(source, ['structure_count', 'building_count', 'pins_count']) || Math.max(1, pinCount() || 1),
      structureMeasurements,
      flatRoofSquares: structureAggregate?.flatRoofSquares || (firstNumberFromObject(source, ['flatRoofSquares', 'flat_roof_squares', 'flat_squares', 'flat', 'low_slope', 'low_slope_squares']) ?? squaresFromSqft(['flat_roof_sqft', 'flat_roof_area_sqft', 'flat_area_sqft', 'low_slope_sqft']) ?? squaresFromMeters2(['flat_roof_meters2', 'flat_roof_area_meters2', 'low_slope_meters2']) ?? segmentMeasurements?.flatRoofSquares),
      pitch2to4Squares: structureAggregate?.pitch2to4Squares || (firstNumberFromObject(source, ['pitch2to4Squares', 'pitch_2_4_squares', 'pitch_2to4_squares', '2_4_squares', '2to4', '2-4']) ?? squaresFromSqft(['pitch_2_4_sqft', 'pitch_2to4_sqft']) ?? segmentMeasurements?.pitch2to4Squares),
      pitch4to6Squares: structureAggregate?.pitch4to6Squares || (firstNumberFromObject(source, ['pitch4to6Squares', 'pitch_4_6_squares', 'pitch_4to6_squares', '4_6_squares', '4to6', '4-6']) ?? squaresFromSqft(['pitch_4_6_sqft', 'pitch_4to6_sqft']) ?? segmentMeasurements?.pitch4to6Squares),
      pitch6to8Squares: structureAggregate?.pitch6to8Squares || (firstNumberFromObject(source, ['pitch6to8Squares', 'pitch_6_8_squares', 'pitch_6to8_squares', '6_8_squares', '6to8', '6-8']) ?? squaresFromSqft(['pitch_6_8_sqft', 'pitch_6to8_sqft']) ?? segmentMeasurements?.pitch6to8Squares),
      pitch9to12Squares: structureAggregate?.pitch9to12Squares || (firstNumberFromObject(source, ['pitch9to12Squares', 'pitch_9_12_squares', 'pitch_9to12_squares', '9_12_squares', '9to12', '9-12']) ?? squaresFromSqft(['pitch_9_12_sqft', 'pitch_9to12_sqft']) ?? segmentMeasurements?.pitch9to12Squares),
      pitch13PlusSquares: structureAggregate?.pitch13PlusSquares || (firstNumberFromObject(source, ['pitch13PlusSquares', 'pitch_13_plus_squares', 'pitch_13plus_squares', '13_plus_squares', '13plus', '13+']) ?? squaresFromSqft(['pitch_13_plus_sqft', 'pitch_13plus_sqft']) ?? segmentMeasurements?.pitch13PlusSquares),
      wastePercent: firstNumberFromObject(source, ['wastePercent', 'waste_percent']),
      eavesLf: structureAggregate?.eavesLf || firstNumberFromObject(source, ['eavesLf', 'eaves_lf', 'eave_length', 'eaves', 'eave']),
      rakesLf: structureAggregate?.rakesLf || firstNumberFromObject(source, ['rakesLf', 'rakes_lf', 'rake_length', 'rakes', 'rake']),
      hipsLf: structureAggregate?.hipsLf || firstNumberFromObject(source, ['hipsLf', 'hips_lf', 'hip_length', 'hips', 'hip']),
      ridgesLf: structureAggregate?.ridgesLf || firstNumberFromObject(source, ['ridgesLf', 'ridges_lf', 'ridge_length', 'ridges', 'ridge']),
      valleyLf: structureAggregate?.valleyLf || firstNumberFromObject(source, ['valleyLf', 'valley_lf', 'valleys_lf', 'valley_length', 'valleys', 'valley']),
      transitionsLf: structureAggregate?.transitionsLf || firstNumberFromObject(source, ['transitionsLf', 'transitions_lf', 'transition_lf', 'transitions']),
      sideWallLf: structureAggregate?.sideWallLf || firstNumberFromObject(source, ['sideWallLf', 'side_wall_lf', 'sidewall_lf', 'sidewall', 'step_flashing_lf', 'step_flashing']),
      headWallLf: structureAggregate?.headWallLf || firstNumberFromObject(source, ['headWallLf', 'head_wall_lf', 'headwall_lf', 'headwall', 'apron_flashing_lf', 'apron_flashing']),
      gutterLf: structureAggregate?.gutterLf || firstNumberFromObject(source, ['gutterLf', 'gutters_lf', 'gutter_lf']),
      downspoutLf: structureAggregate?.downspoutLf || firstNumberFromObject(source, ['downspoutLf', 'downspouts_lf', 'downspout_lf']),
      chimneysEa: structureAggregate?.chimneysEa || firstNumberFromObject(source, ['chimneysEa', 'chimneys', 'chimney_count', 'chimneyCount']),
      skylightsEa: structureAggregate?.skylightsEa || firstNumberFromObject(source, ['skylightsEa', 'skylights', 'skylight_count', 'skylightCount']),
      pipeBootsEa: structureAggregate?.pipeBootsEa || firstNumberFromObject(source, ['pipeBootsEa', 'pipe_boots', 'pipe_boot_count', 'pipe_jacks', 'pipe_jack_count', 'plumbing_vents', 'plumbing_vent_count']),
      roofVentsEa: structureAggregate?.roofVentsEa || firstNumberFromObject(source, ['roofVentsEa', 'roof_vents', 'roof_vent_count', 'vents', 'vent_count']),
      ridgeVentLf: ventilationSuggestion.ridgeVentLf || firstNumberFromObject(source, ['ridgeVentLf', 'ridge_vent_lf', 'ridge_vent_length']),
      boxVentsEa: ventilationSuggestion.ridgeVentLf > 0 ? 0 : (ventilationSuggestion.boxVentsEa || firstNumberFromObject(source, ['boxVentsEa', 'box_vents', 'box_vent_count'])),
    });
    const totalSquares = firstNumberFromObject(source, ['roofSquares', 'roof_squares', 'total_squares', 'totalSquares', 'squares', 'roofing_squares', 'total_roof_squares', 'totalRoofSquares'])
      ?? squaresFromSqft(['roof_sqft', 'roofSqft', 'roof_area_sqft', 'roofAreaSqft', 'total_roof_area_sqft', 'totalRoofAreaSqft', 'total_roof_sqft', 'totalRoofSqft', 'total_area_sqft', 'totalAreaSqft', 'area_sqft', 'areaSqft', 'roof_area', 'roofarea', 'total_roof_area', 'total_area'])
      ?? squaresFromMeters2(['total_roof_area_meters2', 'totalRoofAreaMeters2', 'whole_roof_area_meters2', 'roof_area_meters2', 'roofAreaMeters2', 'area_meters2', 'areaMeters2']);
    if (totalSquares && extracted.roofSquares <= 0) {
      const roundedSquares = Math.max(0, Math.round(Number(totalSquares) || 0));
      extracted.pitch4to6Squares = roundedSquares;
      extracted.shingleSquares = roundedSquares;
      extracted.roofSquares = roundedSquares;
    }
    return proposalMeasurementsHaveValues(extracted) ? extracted : null;
  }

  function proposalMeasurementsHaveValues(measurements = {}){
    return ['roofSquares', 'shingleSquares', 'flatRoofSquares', 'pitch2to4Squares', 'pitch4to6Squares', 'pitch6to8Squares', 'pitch9to12Squares', 'pitch13PlusSquares', 'eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf', 'transitionsLf', 'sideWallLf', 'headWallLf', 'gutterLf', 'downspoutLf', 'chimneysEa', 'skylightsEa', 'pipeBootsEa', 'roofVentsEa', 'ridgeVentLf', 'boxVentsEa']
      .some((key) => Number(measurements[key] || 0) > 0);
  }

  function proposalMeasurementsLookPlaceholder(measurements = {}){
    return Number(measurements.flatRoofSquares) === 2
      && Number(measurements.pitch2to4Squares) === 3
      && Number(measurements.pitch4to6Squares) === 3
      && Number(measurements.pitch6to8Squares) === 7
      && Number(measurements.pitch9to12Squares) === 4
      && Number(measurements.pitch13PlusSquares) === 1;
  }

  function ensureProposalMeasurements(proposal){
    if (!proposal) return defaultProposalMeasurements();
    const current = proposal.measurements || {};
    const currentNormalized = normalizeProposalMeasurements(current);
    if (!proposalMeasurementsHaveValues(currentNormalized) || proposalMeasurementsLookPlaceholder(currentNormalized)) {
      const firstMeasure = firstMeasureProposalMeasurements();
      if (firstMeasure) {
        proposal.measurements = firstMeasure;
        proposal.measurement_source = 'firstmeasure';
      } else {
        proposal.measurements = defaultProposalMeasurements();
        proposal.measurement_source = activeMeasurementProjectId() ? 'loading' : 'manual_needed';
        if (activeMeasurementProjectId()) requestProposalMeasurementHydration(proposal);
      }
    } else {
      proposal.measurements = currentNormalized;
      proposal.measurement_source ||= 'manual';
    }
    proposal.measurements = {
      ...proposal.measurements,
      ...(window.FirstMateCustomFields?.valuesForFormula?.(activeBaseProject || {}) || {})
    };
    return proposal.measurements;
  }

  function syncMeasurementsIntoProposalScope(scope, measurements){
    if (!scope || typeof scope !== 'object') return scope;
    const normalized = normalizeProposalMeasurements(measurements || {});
    scope.measurements = { ...(scope.measurements && typeof scope.measurements === 'object' ? scope.measurements : {}), ...normalized };
    const pieces = Array.isArray(scope.pieces) ? scope.pieces : [];
    const roofPieces = pieces.filter((piece) => {
      const templateId = String(piece?.templateId || piece?.template_id || piece?.scope_template_id || piece?.type || '').trim();
      return ['roof_replacement', 'full_roof', 'partial_roof'].includes(templateId);
    });
    const targets = roofPieces.length === 1 ? roofPieces : (pieces.length === 1 ? pieces : []);
    targets.forEach((piece) => {
      piece.measurements = { ...(piece.measurements && typeof piece.measurements === 'object' ? piece.measurements : {}), ...normalized };
    });
    return scope;
  }

  function syncProposalMeasurementsToScope(proposal){
    if (!proposal) return defaultProposalMeasurements();
    const measurements = normalizeProposalMeasurements(proposal.measurements || {});
    proposal.measurements = measurements;
    syncMeasurementsIntoProposalScope(proposal.scope, measurements);
    if (proposal.scope?.source === 'project_scope' && activeBaseProject) {
      syncMeasurementsIntoProposalScope(activeBaseProject.scope, measurements);
      syncMeasurementsIntoProposalScope(activeBaseProject.project_scope, measurements);
    }
    return measurements;
  }

  function buildLinkedPricebookLineItem(itemId, proposal, overrides = {}){
    const pricebook = getPricebookModule();
    if (!pricebook?.lineItemFromPricebook) return null;
    const measurements = ensureProposalMeasurements(proposal);
    return pricebook.lineItemFromPricebook(itemId, measurements, overrides);
  }

  function proposalMoneyCents(value){
    if (value && typeof value === 'object') {
      if (Number.isFinite(Number(value.amount_cents))) return Math.round(Number(value.amount_cents));
      if (Number.isFinite(Number(value.cents))) return Math.round(Number(value.cents));
      if (Number.isFinite(Number(value.amount))) return Math.round(Number(value.amount) * 100);
    }
    const parsed = Number(String(value ?? '').replace(/[$,\s]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }

  function proposalScopeItemSelected(item = {}){
    if (item.disabled === true || item.enabled === false) return false;
    const selection = item.selection && typeof item.selection === 'object' ? item.selection : {};
    const mode = String(selection.mode || 'fixed');
    if (mode === 'fixed') return true;
    return selection.selected === true;
  }

  function proposalScopeItemEnabled(item = {}){
    return item.disabled !== true && item.enabled !== false;
  }

  function proposalScopeItemIsDiscount(item = {}){
    return item.item_kind === 'discount' || item.kind === 'discount' || item.type === 'discount' || item.is_discount === true;
  }

  function proposalScopeItemIsSection(item = {}){
    return item.item_kind === 'section' || item.kind === 'section' || item.type === 'section' || item.is_section === true;
  }

  function proposalScopeDiscountCents(item = {}){
    if (!proposalScopeItemIsDiscount(item)) return 0;
    const computed = Number(item.computed_discount_cents ?? item.computedDiscountCents);
    if (Number.isFinite(computed) && computed > 0) return Math.round(computed);
    const explicit = Number(item.discount_amount_cents ?? item.discountAmountCents);
    if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
    const value = proposalMoneyCents(item.discount_amount ?? item.discountAmount ?? item.amount ?? item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice);
    return Math.abs(value);
  }

  function proposalScopeItemOwnCents(item = {}){
    if (!proposalScopeItemSelected(item) || item.price_driving === false) return 0;
    if (proposalScopeItemIsDiscount(item)) return -proposalScopeDiscountCents(item);
    const explicit = proposalMoneyCents(item.amount || item.total || item.total_price);
    if (explicit > 0) return explicit;
    const qty = Number(normalizeProposalNumber(item.quantity || 1) || 1);
    const unit = proposalMoneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice);
    return Math.round(Math.max(0, qty) * unit);
  }

  function proposalScopeItemTotalCents(item = {}){
    if (!proposalScopeItemSelected(item)) return 0;
    const own = proposalScopeItemOwnCents(item);
    const children = (Array.isArray(item.children) ? item.children : []).reduce((sum, child) => sum + proposalScopeItemTotalCents(child), 0);
    return own + children;
  }

  function proposalScopeItemTotalCentsWithoutDiscounts(item = {}){
    if (!proposalScopeItemSelected(item)) return 0;
    const own = proposalScopeItemIsDiscount(item) ? 0 : proposalScopeItemOwnCents(item);
    const children = (Array.isArray(item.children) ? item.children : []).reduce((sum, child) => sum + proposalScopeItemTotalCentsWithoutDiscounts(child), 0);
    return own + children;
  }

  function proposalRefreshDiscountAmounts(proposal){
    const scope = normalizeExistingProposalScope(proposal);
    const roots = Array.isArray(scope.root_items) ? scope.root_items : [];
    const subtotalCents = roots.reduce((sum, item) => sum + proposalScopeItemTotalCentsWithoutDiscounts(item), 0);
    walkProposalScopeItems(roots, (item) => {
      if (!proposalScopeItemIsDiscount(item)) return;
      const mode = String(item.discount_mode || item.discountMode || 'amount');
      if (mode === 'percent') {
        const percent = Number(normalizeProposalNumber(item.discount_percent ?? item.discountPercent ?? item.quantity ?? 0) || 0);
        item.computed_discount_cents = Math.round(Math.max(0, subtotalCents) * Math.max(0, percent) / 100);
      } else {
        item.computed_discount_cents = proposalScopeDiscountCents({ ...item, computed_discount_cents: 0 });
      }
    });
    return subtotalCents;
  }

  function proposalScopeItemPreviewCents(item = {}){
    const clone = JSON.parse(JSON.stringify(item || {}));
    clone.selection = { ...(clone.selection || {}), selected: true };
    clone.included = false;
    clone.price_driving = clone.price_driving !== false;
    return proposalScopeItemTotalCents(clone);
  }

  function proposalBuilderScopeTotalRange(builder = proposalBuilderState){
    const root = builder?.root;
    if (!root) return null;
    proposalRefreshDiscountAmounts({ scope:{ root_items:[root] } });
    const current = proposalScopeItemTotalCents(root);
    let minimum = current;
    let maximum = current;
    const choiceGroups = new Map();
    walkProposalScopeItems([root], (item) => {
      const selection = item?.selection && typeof item.selection === 'object' ? item.selection : {};
      if (!proposalSelectionAllowsCustomer(selection)) return;
      const mode = String(selection.mode || 'fixed');
      const value = proposalScopeItemPreviewCents(item);
      if (mode === 'optional') {
        if (selection.selected === true) minimum -= value;
        else maximum += value;
        return;
      }
      if (mode !== 'choice') return;
      const groupId = String(selection.group_id || selection.groupId || item.id || '').trim();
      if (!groupId) return;
      const group = choiceGroups.get(groupId) || { values:[], current:0 };
      group.values.push(value);
      if (selection.selected === true) group.current = value;
      choiceGroups.set(groupId, group);
    });
    choiceGroups.forEach((group) => {
      if (!group.values.length) return;
      const selected = group.current || Math.min(...group.values);
      minimum += Math.min(...group.values) - selected;
      maximum += Math.max(...group.values) - selected;
    });
    return {
      minimum: Math.max(0, Math.round(minimum)),
      maximum: Math.max(0, Math.round(Math.max(minimum, maximum)))
    };
  }

  function proposalBuilderScopeTotalHtml(builder = proposalBuilderState, options = {}){
    const range = proposalBuilderScopeTotalRange(builder);
    const label = options.label || 'Scope total';
    const amount = !range
      ? 'Estimate pending'
      : (range.minimum === range.maximum
        ? proposalCurrencyDisplay(range.minimum / 100)
        : `${proposalCurrencyDisplay(range.minimum / 100)} – ${proposalCurrencyDisplay(range.maximum / 100)}`);
    return `<div class="r-builder-scope-total${options.compact ? ' compact' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(amount)}</strong></div>`;
  }

  function proposalBuilderSyncScopeTotals(root = document){
    if (!proposalBuilderState?.root || !root?.querySelectorAll) return;
    root.querySelectorAll('.r-builder-scope-total').forEach((current) => {
      const replacement = document.createElement('div');
      replacement.innerHTML = proposalBuilderScopeTotalHtml(proposalBuilderState, {
        compact: current.classList.contains('compact'),
        label: current.querySelector('span')?.textContent || (globalThis.PlatformLanguage?.htmlText("proposals","m_e881a88a6aa034","Scope total") ?? "Scope total")
      }).trim();
      const next = replacement.firstElementChild;
      if (next) current.replaceWith(next);
    });
  }

  function proposalScopeItemDescriptionVisible(item = {}){
    if (item.show_description === false || item.showDescription === false) return false;
    return item.show_description === true || item.showDescription === true || !!String(item.description || '').trim();
  }

  function resolveProposalScopeVariation(item = {}){
    const variationId = String(item.variation_selection?.selected_variation_id || item.variation_selection?.selectedVariationId || item.variation_selection?.default_variation_id || '').trim();
    if (!variationId || !Array.isArray(item.variations)) return item;
    const variation = item.variations.find((entry) => String(entry.id || '') === variationId);
    if (!variation?.overrides || typeof variation.overrides !== 'object') return item;
    return {
      ...item,
      ...variation.overrides,
      variables: { ...(item.variables || {}), ...(variation.overrides.variables || {}) },
      measurements: { ...(item.measurements || {}), ...(variation.overrides.measurements || {}) },
      media_refs: variation.overrides.media_refs || item.media_refs || [],
      id: item.id,
      children: item.children || [],
      variations: item.variations,
      variation_selection: item.variation_selection,
      selected_variation_id: variation.id,
      selected_variation_label: variation.label || variation.name || variation.id
    };
  }

  function buildLinkedPricebookScopeItem(itemId, proposal, overrides = {}){
    const pricebook = getPricebookModule();
    const measurements = ensureProposalMeasurements(proposal);
    if (pricebook?.scopeItemFromPricebook) return pricebook.scopeItemFromPricebook(itemId, measurements, overrides);
    const lineItem = buildLinkedPricebookLineItem(itemId, proposal, overrides);
    return lineItem ? {
      id: `scope_${lineItem.pricebookItemId || itemId}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'scope_item',
      pricebook_ref: { item_id: lineItem.pricebookItemId || itemId },
      name: lineItem.label || itemId,
      unit: lineItem.unit || 'ea',
      quantity: lineItem.quantity || '1',
      unit_price: proposalMoneyCents(lineItem.unitPrice) / 100,
      base_price: proposalMoneyCents(lineItem.unitPrice) / 100,
      amount: lineItem.amount,
      included: false,
      price_driving: true,
      selection: { mode: 'fixed', selected: true, selectable_by: ['internal'] },
      children: []
    } : null;
  }

  function seedProposalPricingFromPricebook(proposal){
    const pricebook = getPricebookModule();
    if (!proposal) return [];
    const measurements = ensureProposalMeasurements(proposal);
    const items = pricebook?.defaultLineItems?.(measurements) || [];
    return items.length ? items : [{ label: (globalThis.PlatformLanguage?.text("proposals","m_3cab406acb39e4","New Line Item") ?? "New Line Item"), quantity: '1', unitPrice: '$0.00', amount: '$0.00' }];
  }

  function seedProposalScopeFromPricebook(proposal){
    const pricebook = getPricebookModule();
    if (!proposal) return [];
    const measurements = ensureProposalMeasurements(proposal);
    const items = pricebook?.defaultScopeItems?.(measurements) || [];
    if (items.length) return items;
    return seedProposalPricingFromPricebook(proposal).map((item, index) => ({
      id: `scope_manual_${Date.now().toString(36)}_${index}`,
      type: 'scope_item',
      pricebook_ref: item.pricebookItemId ? { item_id: item.pricebookItemId } : {},
      name: item.label || `Line Item ${index + 1}`,
      unit: item.unit || 'ea',
      quantity: item.quantity || '1',
      unit_price: proposalMoneyCents(item.unitPrice) / 100,
      base_price: proposalMoneyCents(item.unitPrice) / 100,
      amount: item.amount,
      included: false,
      price_driving: true,
      selection: { mode: 'fixed', selected: true, selectable_by: ['internal'] },
      children: []
    }));
  }

  function ensureProposalScope(proposal, options = {}){
    if (!proposal) return { schema_version: 1, root_items: [] };
    const seed = options.seed !== false;
    const scope = proposal.scope && typeof proposal.scope === 'object' ? proposal.scope : {};
    if (!Array.isArray(scope.root_items) || !scope.root_items.length) {
      proposal.scope = {
        schema_version: 1,
        root_items: seed ? seedProposalScopeFromPricebook(proposal) : [],
        variables: {},
        measurements: {},
        selection_state: {}
      };
    } else {
      proposal.scope = {
        schema_version: Number(scope.schema_version || 1) || 1,
        root_items: scope.root_items,
        variables: scope.variables && typeof scope.variables === 'object' ? scope.variables : {},
        measurements: scope.measurements && typeof scope.measurements === 'object' ? scope.measurements : {},
        selection_state: scope.selection_state && typeof scope.selection_state === 'object' ? scope.selection_state : {}
      };
    }
    return proposal.scope;
  }

  function normalizeExistingProposalScope(proposal){
    return ensureProposalScope(proposal, { seed: false });
  }

  function walkProposalScopeItems(items, visitor, depth = 0){
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      visitor(item, depth, index);
      walkProposalScopeItems(item.children || [], visitor, depth + 1);
    });
  }

  function findProposalScopeItem(proposal, itemId){
    let found = null;
    walkProposalScopeItems(normalizeExistingProposalScope(proposal).root_items, (item) => {
      if (!found && String(item.id || '') === String(itemId || '')) found = item;
    });
    return found;
  }

  function findProposalScopeItemContext(proposal, itemId){
    const scope = normalizeExistingProposalScope(proposal);
    const targetId = String(itemId || '');
    let found = null;
    const visit = (items, parent = null) => {
      if (!Array.isArray(items) || found) return;
      items.forEach((item, index) => {
        if (found || !item) return;
        if (String(item.id || '') === targetId) {
          found = { item, parent, items, index };
          return;
        }
        visit(item.children || [], item);
      });
    };
    visit(scope.root_items || [], null);
    return found;
  }

  function proposalSelectionAllowsCustomer(selection = {}){
    const selectableBy = Array.isArray(selection.selectable_by || selection.selectableBy) ? (selection.selectable_by || selection.selectableBy) : [];
    if (selection.customer_visible === true) return true;
    if (selection.customer_visible === false) return false;
    return selectableBy.includes('customer');
  }

  function proposalScopeItemHasCustomerChoice(proposal, item){
    const selection = item?.selection && typeof item.selection === 'object' ? item.selection : {};
    if (String(selection.mode || '') !== 'choice') return false;
    const group = proposalScopeChoiceGroup(proposal, item);
    return group.items.some((entry) => proposalSelectionAllowsCustomer(entry.selection || {}));
  }

  function proposalSelectionGroupTitle(groupId){
    const key = String(groupId || '').trim().split(':').pop();
    return ({
      shingle_profile: 'Shingle Profile',
      underlayment_profile: 'Underlayment',
      leak_barrier_profile: 'Ice & Water Barrier'
    }[key] || titleFromKey(key));
  }

  function proposalSelectionGroupMetadata(proposal, groupId, context = null){
    const key = String(groupId || '').trim();
    if (!key) return {};
    const candidates = [];
    const addGroups = (item) => {
      if (!item || typeof item !== 'object') return;
      const groups = item.selection_groups || item.selectionGroups;
      if (Array.isArray(groups)) candidates.push(...groups);
    };
    addGroups(context?.parent);
    addGroups(context?.item);
    (context?.items || []).forEach(addGroups);
    (normalizeExistingProposalScope(proposal).root_items || []).forEach(addGroups);
    return candidates.find((entry) => String(entry?.id || entry?.group_id || entry?.groupId || '').trim() === key) || {};
  }

  function proposalChoiceGroupTitle(proposal, groupId, context = null, items = []){
    const displayGroupId = String(groupId || '').trim().split(':').pop();
    const metadata = proposalSelectionGroupMetadata(proposal, groupId, context) || proposalSelectionGroupMetadata(proposal, displayGroupId, context);
    const fromGroup = String(metadata.title || metadata.label || metadata.name || metadata.prompt || '').trim();
    if (fromGroup) return fromGroup;
    const fromSelection = items
      .map((entry) => entry?.selection || {})
      .map((selection) => String(selection.group_title || selection.groupTitle || selection.group_label || selection.groupLabel || '').trim())
      .find(Boolean);
    return fromSelection || proposalSelectionGroupTitle(displayGroupId);
  }

  function proposalCustomerChoiceOptions(proposal, item){
    const source = item?.__scopeItemId ? findProposalScopeItem(proposal, item.__scopeItemId) : item;
    if (!source || proposalScopeItemIsSection(source) || proposalScopeItemIsDiscount(source)) return [];
    const group = proposalScopeChoiceGroup(proposal, source);
    const options = (group.items.length ? group.items : [source])
      .filter((entry) => proposalSelectionAllowsCustomer(entry.selection || {}) || entry.selection?.selected === true);
    return options.length > 1 ? options : [];
  }

  function proposalChoiceGridColumnCount(count = 0){
    const value = Math.max(0, Number(count || 0));
    if (value <= 0) return 0;
    if (value <= 4) return value;
    return Math.min(4, Math.ceil(value / 2));
  }

  function proposalChoiceGridRowCount(count = 0){
    const columns = proposalChoiceGridColumnCount(count);
    return columns > 0 ? Math.ceil(Number(count || 0) / columns) : 0;
  }

  function proposalChoiceOptionLogo(option = {}){
    const text = String(`${option.brand || ''} ${option.manufacturer || ''} ${option.name || ''} ${option.display_name || ''}`).toLowerCase();
    if (text.includes('owens')) return PROPOSAL_BUILDER_BRAND_LOGOS.owens_corning;
    if (text.includes('malarkey')) return PROPOSAL_BUILDER_BRAND_LOGOS.malarkey;
    if (text.includes('certainteed') || text.includes('certain teed')) return PROPOSAL_BUILDER_BRAND_LOGOS.certainteed;
    if (text.includes('gaf')) return PROPOSAL_BUILDER_BRAND_LOGOS.gaf;
    return '';
  }

  function proposalScopeItemVariationVisible(item = {}){
    return item.show_variations !== false && item.showVariations !== false && item.variations_enabled !== false && item.variationsEnabled !== false;
  }

  function proposalScopeItemVariationEditable(item = {}){
    return proposalScopeItemVariationVisible(item) && item.variation_editable !== false && item.variationEditable !== false;
  }

  function proposalScopeItemVariationOptions(item = {}){
    return Array.isArray(item.variations) ? item.variations.filter((entry) => entry?.id) : [];
  }

  function proposalSelectedVariationId(item = {}){
    const selection = item.variation_selection || item.variationSelection || {};
    return String(selection.selected_variation_id || selection.selectedVariationId || selection.default_variation_id || selection.defaultVariationId || '').trim();
  }

  function proposalSelectedVariation(item = {}){
    const options = proposalScopeItemVariationOptions(item);
    const selectedId = proposalSelectedVariationId(item) || String(options[0]?.id || '');
    return options.find((entry) => String(entry.id || '') === selectedId) || options[0] || null;
  }

  function proposalVariationDisplayLabel(item = {}){
    const variation = proposalSelectedVariation(item);
    return variation ? (variation.label || variation.name || variation.id || '') : '';
  }

  function proposalVariationColorValue(variation = null){
    const raw = String(
      variation?.color
      || variation?.swatch
      || variation?.hex
      || variation?.overrides?.variables?.color
      || variation?.variables?.color
      || ''
    ).trim();
    if (!raw) return '';
    const named = {
      charcoal: '#3f3f46',
      shakewood: '#8a6f4d',
      weathered_wood: '#8b8072',
      weatheredwood: '#8b8072',
      white: '#f8fafc',
      gray: '#94a3b8',
      grey: '#94a3b8',
      tan: '#c6a875',
      black: '#111827',
      brown: '#7c4a2d'
    };
    const clean = raw.toLowerCase().replace(/[^a-z0-9#(),.% -]/g, '').replace(/\s+/g, '_');
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw) || /^rgba?\(/i.test(raw) || /^hsla?\(/i.test(raw)) return raw;
    return named[clean] || '';
  }

  function proposalScopeChoiceGroup(proposal, item){
    const context = findProposalScopeItemContext(proposal, item?.id);
    const selection = item?.selection && typeof item.selection === 'object' ? item.selection : {};
    const groupId = String(selection.group_id || '').trim();
    const siblings = context?.items || normalizeExistingProposalScope(proposal).root_items || [];
    if (!groupId) return { groupId: '', title: '', metadata: {}, items: item ? [item] : [], context };
    const items = siblings.filter((entry) => String(entry?.selection?.group_id || '') === groupId && String(entry?.selection?.mode || '') === 'choice');
    const metadata = proposalSelectionGroupMetadata(proposal, groupId, context);
    return {
      groupId,
      title: proposalChoiceGroupTitle(proposal, groupId, context, items),
      metadata,
      items,
      context
    };
  }

  function proposalSelectCustomerChoiceOption(proposal, page, optionItemId){
    const context = findProposalScopeItemContext(proposal, optionItemId);
    if (!context?.item) return false;
    const group = proposalScopeChoiceGroup(proposal, context.item);
    if (!group.items.length) return false;
    const targetId = String(optionItemId || '');
    group.items.forEach((option) => {
      option.selection = option.selection && typeof option.selection === 'object' ? option.selection : {};
      option.selection.mode = 'choice';
      option.selection.group_id = group.groupId || option.selection.group_id || context.item.selection?.group_id || '';
      option.selection.group_behavior = 'single';
      const selected = String(option.id || '') === targetId;
      option.selection.selected = selected;
      option.selection.default_selected = selected;
      if (selected) {
        option.selection.customer_visible = true;
        proposalBuilderSetCustomerSelectable(option.selection, true);
      }
    });
    recomputeProposalPricing(page, proposal);
    return true;
  }

  function proposalCssAttrEscape(value){
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function ensureProposalLineChoiceGroup(proposal, itemId){
    const context = findProposalScopeItemContext(proposal, itemId);
    const item = context?.item;
    if (!item) return null;
    item.selection = item.selection && typeof item.selection === 'object' ? { ...item.selection } : {};
    if (String(item.selection.mode || '') !== 'choice' || !item.selection.group_id) {
      item.selection.mode = 'choice';
      item.selection.group_id = `proposal_choice_${String(item.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      item.selection.group_behavior = 'single';
      item.selection.group_title = `${item.display_name || item.name || 'Proposal'} Options`;
      item.selection.selected = true;
      item.selection.default_selected = true;
    }
    item.selection.customer_visible = true;
    proposalBuilderSetCustomerSelectable(item.selection, true);
    return item;
  }

  function proposalCloneChoiceOption(sourceItem, index){
    const clone = JSON.parse(JSON.stringify(sourceItem || {}));
    clone.id = `scope_choice_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 7)}`;
    clone.name = `${sourceItem?.display_name || sourceItem?.name || 'Option'} Option`;
    clone.display_name = clone.name;
    clone.selection = {
      ...(sourceItem?.selection || {}),
      mode: 'choice',
      selected: false,
      default_selected: false,
      customer_visible: true,
      selectable_by: ['internal', 'customer']
    };
    clone.children = Array.isArray(clone.children) ? clone.children : [];
    return clone;
  }

  function proposalApplyLineChoiceSettings(proposal, page, form){
    const itemId = form?.dataset?.choiceScopeItem || '';
    const context = findProposalScopeItemContext(proposal, itemId);
    if (!context?.item) return;
    const item = ensureProposalLineChoiceGroup(proposal, itemId);
    const group = proposalScopeChoiceGroup(proposal, item);
    const selectedId = form.querySelector('input[name="proposal-choice-selected"]:checked')?.value || item.id;
    const groupTitle = String(form.querySelector('[data-choice-group-title]')?.value || group.title || '').trim();
    group.items.forEach((option) => {
      const optionId = String(option.id || '');
      const safeOptionId = proposalCssAttrEscape(optionId);
      const labelInput = form.querySelector(`[data-choice-option-label="${safeOptionId}"]`);
      const quantityInput = form.querySelector(`[data-choice-option-quantity="${safeOptionId}"]`);
      const priceInput = form.querySelector(`[data-choice-option-price="${safeOptionId}"]`);
      const customerInput = form.querySelector(`[data-choice-option-customer="${safeOptionId}"]`);
      option.display_name = labelInput?.value || option.display_name || option.name || 'Option';
      option.name = option.display_name;
      if (quantityInput) {
        option.quantity = normalizeProposalNumber(quantityInput.value || 0);
        option.manualQuantity = true;
      }
      if (priceInput) {
        const nextPrice = Number(normalizeProposalNumber(priceInput.value || 0) || 0);
        option.unit_price = nextPrice;
        option.base_price = nextPrice;
        option.manualUnitPrice = true;
      }
      option.selection = option.selection && typeof option.selection === 'object' ? option.selection : {};
      option.selection.mode = 'choice';
      option.selection.group_id = group.groupId || item.selection.group_id;
      option.selection.group_behavior = 'single';
      if (groupTitle) option.selection.group_title = groupTitle;
      option.selection.selected = optionId === selectedId;
      option.selection.default_selected = option.selection.selected;
      option.selection.customer_visible = customerInput?.checked === true || option.selection.selected === true;
      proposalBuilderSetCustomerSelectable(option.selection, option.selection.customer_visible === true);
    });
    if (!group.items.some((option) => option.selection?.selected)) {
      group.items[0].selection.selected = true;
      group.items[0].selection.default_selected = true;
      group.items[0].selection.customer_visible = true;
      proposalBuilderSetCustomerSelectable(group.items[0].selection, true);
    }
    recomputeProposalPricing(page, proposal);
  }

  function proposalChoiceSelectionTitle(group = {}, selected = null){
    const rawTitle = String(group.title || selected?.selection?.group_title || selected?.display_name || selected?.name || 'Choice').trim();
    const baseTitle = rawTitle.replace(/\s+selection$/i, '').trim() || 'Choice';
    return `${baseTitle} Selection`;
  }

  function proposalAddLineChoiceOption(proposal, page, itemId, form = null){
    const item = ensureProposalLineChoiceGroup(proposal, itemId);
    if (!item) return null;
    if (form) proposalApplyLineChoiceSettings(proposal, page, form);
    const context = findProposalScopeItemContext(proposal, item.id);
    if (!context?.items) return null;
    const group = proposalScopeChoiceGroup(proposal, item);
    const option = proposalCloneChoiceOption(item, group.items.length);
    option.selection.group_id = group.groupId || item.selection.group_id;
    context.items.splice(context.index + 1, 0, option);
    recomputeProposalPricing(page, proposal);
    return option;
  }

  function proposalRemoveLineChoiceOption(proposal, page, itemId, removeId, form = null){
    const item = ensureProposalLineChoiceGroup(proposal, itemId);
    if (!item) return;
    if (form) proposalApplyLineChoiceSettings(proposal, page, form);
    const group = proposalScopeChoiceGroup(proposal, item);
    if (group.items.length <= 1) return;
    const removeContext = findProposalScopeItemContext(proposal, removeId);
    if (!removeContext?.items) return;
    const wasSelected = removeContext.item?.selection?.selected === true;
    removeContext.items.splice(removeContext.index, 1);
    if (wasSelected) {
      const nextGroup = proposalScopeChoiceGroup(proposal, item);
      const next = nextGroup.items[0];
      if (next) {
        next.selection ||= {};
        next.selection.selected = true;
        next.selection.default_selected = true;
        next.selection.customer_visible = true;
        proposalBuilderSetCustomerSelectable(next.selection, true);
      }
    }
    recomputeProposalPricing(page, proposal);
  }

  function proposalPricingRowsForPage(page, proposal, options = {}){
    if (Array.isArray(page?.lineItems) && page.lineItems.some((item) => item?.__scopeItemId || item?.__logicalLineItemIndex !== undefined)) {
      return options.includeDisabledRows ? page.lineItems : page.lineItems.filter((item) => item.__isDisabled !== true);
    }
    proposalRefreshDiscountAmounts(proposal);
    const scope = normalizeExistingProposalScope(proposal);
    const view = page.scope_view && typeof page.scope_view === 'object' ? page.scope_view : {
      root_item_id: page.scope_root_id || 'root',
      render_depth: page.render_depth ?? 1,
      show_included_items: page.show_included_items !== false,
      show_unselected_options: page.show_unselected_options === true
    };
    const rootId = String(view.root_item_id || view.scope_root_id || 'root');
    const maxDepth = Math.max(12, Number(view.render_depth ?? 12) || 12);
    const showIncluded = view.show_included_items !== false;
    const showUnselected = view.show_unselected_options === true;
    const includeDisabledRows = options.includeDisabledRows === true;
    const roots = rootId === 'root' ? scope.root_items : [findProposalScopeItem(proposal, rootId)].filter(Boolean);
    const rows = [];
    const quantityDisplay = (item) => {
      const qty = Number(normalizeProposalNumber(item.quantity || 0) || 0);
      const unit = String(item.unit || '').trim();
      if (!Number.isFinite(qty) || qty <= 0) return '';
      if (qty === 1 && (!unit || unit === 'ea')) return '';
      const cleanQty = Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(2)));
      return unit ? `${cleanQty} ${unit}` : cleanQty;
    };
    const add = (rawItem, depth) => {
      const item = resolveProposalScopeVariation(rawItem || {});
      const selected = proposalScopeItemSelected(item);
      const disabled = !proposalScopeItemEnabled(rawItem) || !proposalScopeItemEnabled(item);
      const totalCents = proposalScopeItemTotalCents(rawItem);
      const ownCents = proposalScopeItemOwnCents(rawItem);
      const isDiscount = proposalScopeItemIsDiscount(rawItem) || proposalScopeItemIsDiscount(item);
      const childItems = Array.isArray(rawItem.children) ? rawItem.children : [];
      const isSection = proposalScopeItemIsSection(rawItem) || proposalScopeItemIsSection(item);
      const hasChildren = childItems.some((child) => proposalScopeItemSelected(child) && (proposalScopeItemTotalCents(child) > 0 || proposalScopeItemIsSection(child) || child.price_driving === false));
      const isCategory = isSection || childItems.length > 0 || hasChildren;
      const hasQuantity = Number(normalizeProposalNumber(item.quantity || 0) || 0) > 0;
      const shouldShow = ((selected || showUnselected) || (includeDisabledRows && disabled))
        && (showIncluded || item.included !== true)
        && (hasQuantity || isCategory || totalCents > 0 || isDiscount)
        && (isCategory || totalCents > 0 || ownCents > 0 || isDiscount || item.price_driving === false || (includeDisabledRows && (selected || disabled)));
      if (shouldShow) {
        const unitCents = proposalMoneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice);
        const isIncluded = item.included === true;
        const discountMode = String(item.discount_mode || item.discountMode || 'amount');
        const discountPercent = Number(normalizeProposalNumber(item.discount_percent ?? item.discountPercent ?? item.quantity ?? 0) || 0);
        const displayQuantity = isCategory || isDiscount ? '' : quantityDisplay(item);
        const displayUnitPrice = isIncluded || isCategory || isDiscount || !displayQuantity ? '' : proposalCurrencyDisplay(unitCents / 100);
        const displayAmount = isIncluded
          ? 'Included'
          : (isDiscount
            ? (discountMode === 'percent' ? `${proposalPercentDisplay(discountPercent)}% ${proposalSignedCurrencyDisplay(totalCents / 100)}` : proposalSignedCurrencyDisplay(totalCents / 100))
            : proposalCurrencyDisplay(totalCents / 100));
        rows.push({
          ...item,
          __scopeItemId: rawItem.id,
          __scopeDepth: depth,
          __hasChildren: hasChildren,
          __isCategory: isCategory,
          __isSection: isSection,
          __isIncluded: isIncluded,
          __isDisabled: disabled,
          __isDiscount: isDiscount,
          description: item.description || '',
          show_description: proposalScopeItemDescriptionVisible(item),
          label: item.display_name || item.name || 'Line item',
          quantity: displayQuantity,
          unitPrice: displayUnitPrice,
          amount: displayAmount,
          rawQuantity: item.quantity || '',
          rawUnitPrice: proposalCurrencyDisplay(unitCents / 100),
          __choiceOptionCount: proposalCustomerChoiceOptions(proposal, rawItem).length,
          __variationLabel: proposalVariationDisplayLabel(rawItem),
          __variationVisible: !isCategory && !isDiscount && proposalScopeItemVariationVisible(rawItem) && proposalScopeItemVariationOptions(rawItem).length > 0,
          __variationEditable: !isCategory && !isDiscount && proposalScopeItemVariationEditable(rawItem),
          autoDerived: !!item.formula || !!item.formula_config,
        });
      }
      if (depth >= maxDepth) return;
      (rawItem.children || []).forEach((child) => add(child, depth + 1));
    };
    roots.forEach((item) => add(item, 0));
    return rows.length ? rows : (page.lineItems || []);
  }

  function createManualProposalScopeItem(item = {}, index = 0){
    const isDiscount = item.item_kind === 'discount' || item.kind === 'discount' || item.type === 'discount' || item.is_discount === true;
    const isSection = item.item_kind === 'section' || item.kind === 'section' || item.type === 'section' || item.is_section === true;
    return {
      id: item.id || `scope_manual_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'scope_item',
      item_kind: isDiscount ? 'discount' : (isSection ? 'section' : (item.item_kind || item.itemKind || 'line_item')),
      is_discount: isDiscount,
      is_section: isSection,
      name: item.name || item.label || (isDiscount ? 'Discount' : (isSection ? 'New Section' : 'New Line Item')),
      display_name: item.display_name || item.displayName || item.label || item.name || (isDiscount ? 'Discount' : (isSection ? 'New Section' : 'New Line Item')),
      description: item.description || '',
      unit: item.unit || 'ea',
      quantity: item.quantity || (isDiscount || isSection ? '0' : '1'),
      unit_price: proposalMoneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice ?? '$0.00') / 100,
      base_price: proposalMoneyCents(item.base_price ?? item.basePrice ?? item.unit_price ?? item.unitPrice ?? '$0.00') / 100,
      included: item.included === true,
      price_driving: isSection ? false : (item.price_driving !== false && item.priceDriving !== false),
      discount_mode: item.discount_mode || item.discountMode || (isDiscount ? 'amount' : ''),
      discount_amount: item.discount_amount ?? item.discountAmount ?? (isDiscount ? '0' : ''),
      discount_percent: item.discount_percent ?? item.discountPercent ?? '',
      variables: item.variables && typeof item.variables === 'object' ? item.variables : {},
      measurements: item.measurements && typeof item.measurements === 'object' ? item.measurements : {},
      media_refs: Array.isArray(item.media_refs || item.mediaRefs || item.images) ? [...(item.media_refs || item.mediaRefs || item.images)] : [],
      selection: item.selection && typeof item.selection === 'object' ? item.selection : { mode: 'fixed', selected: true, selectable_by: ['internal'] },
      variations: Array.isArray(item.variations) ? item.variations : [],
      children: Array.isArray(item.children) ? item.children : []
    };
  }

  function proposalScopeChildrenForPage(page, proposal){
    const scope = ensureProposalScope(proposal, { seed: false });
    const view = page?.scope_view && typeof page.scope_view === 'object' ? page.scope_view : {};
    const rootId = String(view.root_item_id || page?.scope_root_id || 'root');
    if (!rootId || rootId === 'root') return scope.root_items;
    const root = findProposalScopeItem(proposal, rootId);
    if (!root) return scope.root_items;
    root.children = Array.isArray(root.children) ? root.children : [];
    return root.children;
  }

  function proposalScopeChildrenForTarget(page, proposal, parentItemId = ''){
    const parentId = String(parentItemId || '').trim();
    if (!parentId || parentId === 'root') return proposalScopeChildrenForPage(page, proposal);
    const parent = findProposalScopeItem(proposal, parentId);
    if (!parent) return proposalScopeChildrenForPage(page, proposal);
    parent.children = Array.isArray(parent.children) ? parent.children : [];
    return parent.children;
  }

  function replaceProposalScopeItem(proposal, itemId, nextItem){
    const replace = (items) => {
      if (!Array.isArray(items)) return false;
      const index = items.findIndex((item) => String(item.id || '') === String(itemId || ''));
      if (index >= 0) {
        items[index] = nextItem;
        return true;
      }
      return items.some((item) => replace(item.children));
    };
    return replace(ensureProposalScope(proposal).root_items);
  }

  function deleteProposalScopeItem(proposal, itemId){
    const remove = (items) => {
      if (!Array.isArray(items)) return false;
      const before = items.length;
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (String(items[index]?.id || '') === String(itemId || '')) items.splice(index, 1);
      }
      if (items.length !== before) return true;
      return items.some((item) => remove(item.children));
    };
    return remove(ensureProposalScope(proposal).root_items);
  }

  function proposalBuilderTemplateById(templateId){
    const id = String(templateId || '');
    const normalized = id === 'full_roof' || id === 'partial_roof'
      ? 'roof_replacement'
      : id === 'roof_repair'
        ? 'repairs'
        : id === 'gutter_replacement'
          ? 'gutters'
          : id;
    return PROPOSAL_SCOPE_TEMPLATE_CATALOG.find((template) => template.id === normalized)
      || PROPOSAL_BUILDER_TEMPLATES[0]
      || PROPOSAL_SCOPE_TEMPLATE_CATALOG[0];
  }

  function fallbackRoofReplacementScopeItem(measurements = {}){
    const squares = Math.max(1, Number(measurements.shingleSquares || measurements.roofSquares || 1));
    return {
      id: `scope_roof_replacement_${Math.random().toString(36).slice(2, 8)}`,
      type: 'scope_item',
      name: 'Roof Replacement',
      display_name: 'Roof Replacement',
      unit: 'ea',
      quantity: '1',
      unit_price: 0,
      base_price: 0,
      selection: { mode: 'fixed', selected: true, selectable_by: ['internal'] },
      selection_groups: [{ id: 'shingle_profile', title: (globalThis.PlatformLanguage?.text("proposals","m_56113e0902b7bd","Shingle Profile") ?? "Shingle Profile"), behavior: 'single', required: true, selectable_by: ['internal', 'customer'] }],
      variables: {},
      measurements,
      children: [
        {
          id: `scope_architectural_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Architectural Shingles',
          display_name: 'Architectural Shingles',
          unit: 'sq',
          quantity: String(squares),
          unit_price: 365,
          base_price: 365,
          included: false,
          price_driving: true,
          selection: { mode: 'choice', group_id: 'shingle_profile', group_behavior: 'single', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          variation_selection: { default_variation_id: 'charcoal', selectable_by: ['internal', 'customer'] },
          variations: [
            { id: 'charcoal', label: (globalThis.PlatformLanguage?.text("proposals","m_81a362b3060e14","Charcoal") ?? "Charcoal"), overrides: { variables: { color: 'charcoal' } } },
            { id: 'weathered_wood', label: (globalThis.PlatformLanguage?.text("proposals","m_eb63978deca3de","Weathered Wood") ?? "Weathered Wood"), overrides: { variables: { color: 'weathered_wood' } } }
          ],
          children: []
        },
        {
          id: `scope_three_tab_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Three-Tab Shingles',
          display_name: 'Three-Tab Shingles',
          unit: 'sq',
          quantity: String(squares),
          unit_price: 315,
          base_price: 315,
          included: false,
          price_driving: true,
          selection: { mode: 'choice', group_id: 'shingle_profile', group_behavior: 'single', selected: false, default_selected: false, selectable_by: ['internal', 'customer'] },
          variation_selection: { default_variation_id: 'charcoal', selectable_by: ['internal', 'customer'] },
          variations: [
            { id: 'charcoal', label: (globalThis.PlatformLanguage?.text("proposals","m_81a362b3060e14","Charcoal") ?? "Charcoal"), overrides: { variables: { color: 'charcoal' } } },
            { id: 'weathered_wood', label: (globalThis.PlatformLanguage?.text("proposals","m_eb63978deca3de","Weathered Wood") ?? "Weathered Wood"), overrides: { variables: { color: 'weathered_wood' } } }
          ],
          children: []
        },
        {
          id: `scope_ice_water_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'New Ice and Water Around Perimeter',
          display_name: 'New Ice and Water Around Perimeter',
          unit: 'sq',
          quantity: String(Math.max(1, Math.round(((Number(measurements.eavesLf || 0) + Number(measurements.rakesLf || 0)) / 100) * 10) / 10 || 1)),
          unit_price: 78,
          base_price: 78,
          included: false,
          price_driving: true,
          selection: { mode: 'optional', selected: false, default_selected: false, selectable_by: ['internal', 'customer'] },
          children: []
        }
      ]
    };
  }

  function proposalBuilderSimpleScopeItem(templateId, measurements){
    const template = proposalBuilderTemplateById(templateId || 'manual');
    const unitPrice = template.id === 'repairs' ? 850 : template.id === 'gutters' ? 2400 : template.id === 'siding_replacement' ? 6800 : template.id === 'maintenance' ? 450 : 0;
    return {
      id: `scope_${template.id}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'scope_item',
      name: template.name || 'Manual Scope',
      display_name: template.name || 'Manual Scope',
      unit: 'scope',
      quantity: 1,
      unit_price: unitPrice,
      base_price: unitPrice,
      included: true,
      price_driving: true,
      measurements: normalizeProposalMeasurements(measurements || {}),
      selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
      children: template.id === 'repairs' ? [
        {
          id: `scope_repair_labor_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Repair Labor',
          display_name: 'Repair Labor',
          unit: 'scope',
          quantity: 1,
          unit_price: 650,
          base_price: 650,
          included: true,
          price_driving: true,
          selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        },
        {
          id: `scope_repair_materials_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Repair Materials Allowance',
          display_name: 'Repair Materials Allowance',
          unit: 'allowance',
          quantity: 1,
          unit_price: 200,
          base_price: 200,
          included: true,
          price_driving: true,
          selection: { mode: 'optional', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        }
      ] : template.id === 'maintenance' ? [
        {
          id: `scope_maintenance_visit_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Maintenance Visit',
          display_name: 'Maintenance Visit',
          unit: 'visit',
          quantity: 1,
          unit_price: 300,
          base_price: 300,
          included: true,
          price_driving: true,
          selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        },
        {
          id: `scope_maintenance_materials_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Maintenance Materials Allowance',
          display_name: 'Maintenance Materials Allowance',
          unit: 'allowance',
          quantity: 1,
          unit_price: 150,
          base_price: 150,
          included: true,
          price_driving: true,
          selection: { mode: 'optional', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        }
      ] : template.id === 'gutters' ? [
        {
          id: `scope_gutter_material_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Gutter Materials',
          display_name: 'Gutter Materials',
          unit: 'lf',
          quantity: String(Math.max(1, Math.round(Number(measurements.gutterLf || 0) || 120))),
          unit_price: 12,
          base_price: 12,
          included: true,
          price_driving: true,
          selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        },
        {
          id: `scope_gutter_labor_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Gutter Labor',
          display_name: 'Gutter Labor',
          unit: 'lf',
          quantity: String(Math.max(1, Math.round(Number(measurements.gutterLf || 0) || 120))),
          unit_price: 8,
          base_price: 8,
          included: true,
          price_driving: true,
          selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        }
      ] : template.id === 'siding_replacement' ? [
        {
          id: `scope_siding_material_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Siding Materials',
          display_name: 'Siding Materials',
          unit: 'sq',
          quantity: 1,
          unit_price: 4200,
          base_price: 4200,
          included: true,
          price_driving: true,
          selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        },
        {
          id: `scope_siding_labor_${Math.random().toString(36).slice(2, 8)}`,
          type: 'scope_item',
          name: 'Siding Labor',
          display_name: 'Siding Labor',
          unit: 'scope',
          quantity: 1,
          unit_price: 2600,
          base_price: 2600,
          included: true,
          price_driving: true,
          selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal', 'customer'] },
          children: []
        }
      ] : []
    };
  }

  function proposalBuilderScopeForTemplate(templateId, measurements){
    if (proposalBuilderTemplateById(templateId).id !== 'roof_replacement') return proposalBuilderSimpleScopeItem(templateId, measurements);
    const pricebook = getPricebookModule();
    const fromPricebook = pricebook?.scopeItemFromPricebook?.('roof_replacement', measurements || {});
    if (fromPricebook?.children?.length) {
      walkProposalScopeItems([fromPricebook], (item) => {
        const ref = item.pricebook_ref || {};
        if (String(ref.item_id || ref.catalog_item_id || '').includes('weatherwatch') || /weatherwatch|ice|water/i.test(String(item.name || ''))) {
          item.name = 'New Ice and Water Around Perimeter';
          item.display_name = 'New Ice and Water Around Perimeter';
        }
      });
      proposalBuilderEnsureRoofReportComponents(fromPricebook, measurements);
      proposalBuilderReplaceShingleChoices(fromPricebook, measurements);
      proposalBuilderReplaceTypedChoices(fromPricebook, measurements, {
        groupId: 'underlayment_profile',
        items: proposalBuilderCommonUnderlaymentItems(),
        defaultId: 'underlayment',
        customerIds: ['underlayment', 'gaf_feltbuster', 'gaf_tiger_paw']
      });
      proposalBuilderReplaceTypedChoices(fromPricebook, measurements, {
        groupId: 'leak_barrier_profile',
        items: proposalBuilderCommonLeakBarrierItems(),
        defaultId: 'ice_water',
        customerIds: ['ice_water', 'gaf_weatherwatch', 'owens_weatherlock']
      });
      return proposalBuilderApplyRoofInclusions(fromPricebook);
    }
    return proposalBuilderApplyRoofInclusions(fallbackRoofReplacementScopeItem(measurements));
  }

  function proposalBuilderEnsureRoofReportComponents(rootItem, measurements){
    const pricebook = getPricebookModule();
    if (!rootItem || !pricebook?.scopeItemFromPricebook) return rootItem;
    const existingRefs = new Set();
    walkProposalScopeItems([rootItem], (item) => {
      const ref = item.pricebook_ref || {};
      const id = String(ref.item_id || ref.catalog_item_id || '').trim();
      if (id) existingRefs.add(id);
    });
    const requiredRefs = ['headwall_flashing', 'sidewall_flashing', 'pipe_boot', 'skylight_flashing', 'chimney_flashing', 'gutter_replace', 'downspout'];
    rootItem.children = Array.isArray(rootItem.children) ? rootItem.children : [];
    requiredRefs.forEach((itemId) => {
      if (existingRefs.has(itemId)) return;
      const child = pricebook.scopeItemFromPricebook(itemId, measurements || {});
      if (child) rootItem.children.push(child);
    });
    return rootItem;
  }

  function proposalBuilderPricebookItemsByType(itemTypeId, options = {}){
    const pricebook = getPricebookModule();
    const state = pricebook?.getState?.();
    const items = Array.isArray(state?.items) ? state.items : [];
    const wantedType = String(itemTypeId || '').trim();
    return items.filter((item) => {
      if (wantedType && String(item.itemTypeId || '') !== wantedType) return false;
      if (options.category && String(item.category || '') !== options.category) return false;
      return true;
    });
  }

  function proposalBuilderCommonShingleItems(){
    const preferred = ['gaf_ns', 'gaf_hd', 'gaf_uhdz', 'gaf_camelot_ii', 'gaf_slateline', 'gaf_grand_sequoia', 'owens_duration', 'malarkey_vista', 'certainteed_landmark'];
    const byId = new Map(proposalBuilderPricebookItemsByType('field_shingles', { category: 'shingle_roofs' }).map((item) => [String(item.id || ''), item]));
    return preferred.map((id) => byId.get(id)).filter(Boolean);
  }

  function proposalBuilderCommonUnderlaymentItems(){
    const preferred = ['underlayment', 'gaf_shinglemate', 'gaf_feltbuster', 'gaf_tiger_paw'];
    const byId = new Map(proposalBuilderPricebookItemsByType('underlayment', { category: 'underlayments' }).map((item) => [String(item.id || ''), item]));
    return preferred.map((id) => byId.get(id)).filter(Boolean);
  }

  function proposalBuilderCommonLeakBarrierItems(){
    const preferred = ['ice_water', 'gaf_weatherwatch', 'owens_weatherlock'];
    const byId = new Map(proposalBuilderPricebookItemsByType('leak_barrier', { category: 'leak_barriers' }).map((item) => [String(item.id || ''), item]));
    return preferred.map((id) => byId.get(id)).filter(Boolean);
  }

  function proposalBuilderScopeItemFromPricebook(itemId, measurements, overrides = {}){
    const pricebook = getPricebookModule();
    if (!pricebook?.scopeItemFromPricebook) return null;
    return pricebook.scopeItemFromPricebook(itemId, measurements || {}, overrides);
  }

  function proposalBuilderConfigureChoiceItem(item, groupId, selected = false, customerVisible = false){
    if (!item) return item;
    item.selection = {
      ...(item.selection || {}),
      mode: 'choice',
      group_id: groupId,
      group_behavior: 'single',
      selected,
      default_selected: selected,
      customer_visible: customerVisible,
      selectable_by: selected || customerVisible ? ['internal', 'customer'] : ['internal']
    };
    return item;
  }

  function proposalBuilderReplaceShingleChoices(rootItem, measurements){
    if (!rootItem?.children?.length) return rootItem;
    const groupId = 'shingle_profile';
    const common = proposalBuilderCommonShingleItems();
    if (!common.length) return rootItem;
    const currentChoices = [];
    rootItem.children = rootItem.children.filter((child) => {
      if (child.selection?.mode === 'choice' && child.selection?.group_id === groupId) {
        currentChoices.push(child);
        return false;
      }
      return true;
    });
    const selectedRef = currentChoices.find((item) => item.selection?.selected === true)?.pricebook_ref?.item_id || 'gaf_hd';
    const defaultCustomerIds = new Set(['gaf_ns', 'gaf_hd', 'gaf_uhdz']);
    const choices = common.map((item) => {
      const selected = String(item.id || '') === String(selectedRef || '') || (!common.some((entry) => String(entry.id || '') === String(selectedRef || '')) && item.id === 'gaf_hd');
      const scopeItem = proposalBuilderScopeItemFromPricebook(item.id, measurements, {
        selection: {
          mode: 'choice',
          group_id: groupId,
          group_behavior: 'single',
          selected,
          default_selected: selected,
          customer_visible: defaultCustomerIds.has(item.id),
          selectable_by: ['internal', ...(defaultCustomerIds.has(item.id) ? ['customer'] : [])]
        }
      });
      return proposalBuilderConfigureChoiceItem(scopeItem, groupId, selected, defaultCustomerIds.has(item.id));
    }).filter(Boolean);
    rootItem.children.push(...choices);
    return rootItem;
  }

  function proposalBuilderReplaceTypedChoices(rootItem, measurements, config = {}){
    if (!rootItem?.children?.length) return rootItem;
    const groupId = config.groupId || '';
    const common = config.items || [];
    if (!groupId || !common.length) return rootItem;
    const candidateIds = new Set(common.map((item) => String(item.id || '')));
    const currentChoices = [];
    rootItem.children = rootItem.children.filter((child) => {
      const refId = String(child.pricebook_ref?.item_id || child.pricebook_ref?.catalog_item_id || '');
      const isExistingChoice = child.selection?.mode === 'choice' && child.selection?.group_id === groupId;
      const isCandidate = candidateIds.has(refId);
      if (isExistingChoice || isCandidate) {
        currentChoices.push(child);
        return false;
      }
      return true;
    });
    const fallbackId = config.defaultId || common[0]?.id || '';
    const selectedRef = currentChoices.find((item) => item.selection?.selected === true)?.pricebook_ref?.item_id || fallbackId;
    const defaultCustomerIds = new Set(config.customerIds || []);
    const choices = common.map((item) => {
      const selected = String(item.id || '') === String(selectedRef || '') || (!common.some((entry) => String(entry.id || '') === String(selectedRef || '')) && item.id === fallbackId);
      const scopeItem = proposalBuilderScopeItemFromPricebook(item.id, measurements, {
        selection: {
          mode: 'choice',
          group_id: groupId,
          group_behavior: 'single',
          selected,
          default_selected: selected,
          customer_visible: defaultCustomerIds.has(item.id),
          selectable_by: ['internal', ...(defaultCustomerIds.has(item.id) ? ['customer'] : [])]
        }
      });
      return proposalBuilderConfigureChoiceItem(scopeItem, groupId, selected, defaultCustomerIds.has(item.id));
    }).filter(Boolean);
    rootItem.children.push(...choices);
    return rootItem;
  }

  function proposalBuilderApplyRoofInclusions(rootItem){
    const pricedGroups = new Set(['shingle_profile', 'underlayment_profile', 'leak_barrier_profile']);
    walkProposalScopeItems(rootItem?.children || [], (item) => {
      if (!item) return;
      if (item.selection?.mode === 'choice' && pricedGroups.has(String(item.selection.group_id || ''))) {
        item.included = false;
        item.price_driving = true;
        return;
      }
      item.included = true;
      item.price_driving = item.price_driving !== false;
    });
    return rootItem;
  }

  function proposalBuilderStepsForRoot(template, root){
    return [
      { type: 'measurements', id: 'measurements', title: ((v0) => globalThis.PlatformLanguage?.text("proposals","m_87b031a8ecaf5c",`${v0} Measurements`,{v0}) ?? `${v0} Measurements`)(root.display_name || root.name || template.name), item: root },
      ...proposalBuilderCollectSelectionSteps(root),
      { type: 'discounts', id: 'discounts', title: (globalThis.PlatformLanguage?.text("proposals","m_b23f7b8d1ec24f","Discounts") ?? "Discounts") },
      { type: 'review', id: 'review', title: (globalThis.PlatformLanguage?.text("proposals","m_b0bb1e74e2a6d3","Review") ?? "Review") }
    ];
  }

  function proposalBuilderPieceId(templateId){
    return `piece_${String(templateId || 'scope').replace(/[^a-z0-9_-]+/gi, '_')}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function proposalBuilderTemplateColor(template){
    return template?.color || 'var(--primary,#d93025)';
  }

  function proposalBuilderSelectedPieces(builder = proposalBuilderState){
    return Array.isArray(builder?.pieces) ? builder.pieces : [];
  }

  function proposalBuilderPieceById(pieceId, builder = proposalBuilderState){
    return proposalBuilderSelectedPieces(builder).find((piece) => piece.id === pieceId) || null;
  }

  function proposalBuilderPieceMeasurements(piece = {}, fallback = proposalBuilderState?.measurements || {}){
    return normalizeProposalMeasurements(piece.measurements || fallback || {});
  }

  function proposalBuilderStructureCountLabel(count = 0, noun = 'structure'){
    const value = Math.max(0, Number(count || 0) || 0);
    return `${value} ${noun}${value === 1 ? '' : 's'}`;
  }

  function proposalBuilderPieceDisplayName(piece = {}, fallbackTemplate = null){
    return String(piece.sectionName || piece.name || fallbackTemplate?.name || 'Project Piece').trim() || 'Project Piece';
  }

  function proposalBuilderScopePieces(builder = proposalBuilderState){
    if (Array.isArray(builder?.scopePieces) && builder.scopePieces.length) return builder.scopePieces;
    const rootChildren = Array.isArray(builder?.root?.children) ? builder.root.children : [];
    return rootChildren.filter((item) => item?.scope_piece_id || item?.scope_template_id);
  }

  function proposalBuilderScopeRootItems(builder = proposalBuilderState){
    const pieces = proposalBuilderScopePieces(builder);
    if (pieces.length) return pieces.map((item) => cloneProposalJson(item)).filter(Boolean);
    return builder?.root ? [cloneProposalJson(builder.root)] : [];
  }

  function proposalBuilderTemplateListName(pieces = proposalBuilderSelectedPieces()){
    const names = (pieces || []).map((piece) => piece.name).filter(Boolean);
    if (!names.length) return 'Project Scope';
    const unique = [...new Set(names)];
    if (unique.length === 1) return unique[0];
    if (unique.length === 2) return `${unique[0]} + ${unique[1]}`;
    return `${unique[0]} + ${unique.length - 1} more`;
  }

  function proposalBuilderApplyPieceMetadata(root, piece, template){
    if (!root) return root;
    const pieceId = piece?.id || proposalBuilderPieceId(template?.id || 'scope');
    const color = piece?.color || proposalBuilderTemplateColor(template);
    root.scope_piece_id = pieceId;
    root.scope_template_id = template?.id || piece?.templateId || '';
    root.scope_template_name = template?.name || piece?.name || root.display_name || root.name || 'Project Piece';
    root.scope_color = color;
    root.workflow_steps = Array.isArray(template?.workflow_steps) ? [...template.workflow_steps] : [];
    root.display_name = piece?.name || template?.name || root.display_name || root.name;
    root.name = root.display_name;
    walkProposalScopeItems([root], (item) => {
      if (!item || !item.selection?.group_id) return;
      item.selection.group_id = `${pieceId}:${item.selection.group_id}`;
    });
    return root;
  }

  function proposalBuilderProjectRootFromPieces(pieces = [], measurements = {}){
    const scopePieces = pieces.map((piece, index) => {
      const template = proposalBuilderTemplateById(piece.templateId || piece.id || 'manual');
      const pieceMeasurements = proposalBuilderPieceMeasurements(piece, measurements);
      const root = proposalBuilderScopeForTemplate(template.id, pieceMeasurements);
      root.measurements = { ...(root.measurements || {}), ...pieceMeasurements };
      return proposalBuilderApplyPieceMetadata(root, {
        ...piece,
        name: proposalBuilderPieceDisplayName(piece, template),
        color: piece.color || proposalBuilderTemplateColor(template)
      }, template);
    }).filter(Boolean);
    const root = {
      id: `scope_project_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'scope_group',
      name: 'Project Scope',
      display_name: 'Project Scope',
      unit: 'scope',
      quantity: 1,
      unit_price: 0,
      base_price: 0,
      included: true,
      price_driving: false,
      selection: { mode: 'fixed', selected: true, default_selected: true, selectable_by: ['internal'] },
      children: scopePieces
    };
    root.measurements = { ...(root.measurements || {}), ...measurements };
    return { root, scopePieces };
  }

  function proposalBuilderStepsForPieces(pieces = [], root, scopePieces = []){
    const steps = [];
    scopePieces.forEach((pieceRoot, pieceIndex) => {
      const piece = pieces[pieceIndex] || {};
      const template = proposalBuilderTemplateById(piece.templateId || pieceRoot.scope_template_id || 'manual');
      proposalBuilderStepsForRoot(template, pieceRoot)
        .filter((step) => !['discounts', 'review'].includes(step.type))
        .forEach((step) => {
          steps.push({
            ...step,
            id: `${pieceRoot.scope_piece_id || piece.id || pieceIndex}:${step.id}`,
            title: step.type === 'measurements' ? 'Measurements' : (step.title || ''),
            pieceId: pieceRoot.scope_piece_id || piece.id || String(pieceIndex),
            pieceName: proposalBuilderPieceDisplayName(piece, template),
            pieceColor: pieceRoot.scope_color || proposalBuilderTemplateColor(template)
          });
        });
    });
    steps.push({ type: 'discounts', id: 'discounts', title: (globalThis.PlatformLanguage?.text("proposals","m_b23f7b8d1ec24f","Discounts") ?? "Discounts") });
    steps.push({ type: 'review', id: 'review', title: (globalThis.PlatformLanguage?.text("proposals","m_b0bb1e74e2a6d3","Review") ?? "Review") });
    return steps;
  }

  function proposalBuilderAddPiece(templateId){
    const template = proposalBuilderTemplateById(templateId || 'manual');
    const current = proposalBuilderSelectedPieces();
    const measurements = normalizeProposalMeasurements(proposalBuilderState?.measurements || defaultProposalMeasurements());
    proposalBuilderState = {
      ...(proposalBuilderState || { mode: 'select' }),
      mode: 'select',
      query: proposalBuilderState?.query || '',
      pieces: [
        ...current,
        {
          id: proposalBuilderPieceId(template.id),
          templateId: template.id,
          name: template.name,
          sectionName: template.name,
          color: proposalBuilderTemplateColor(template),
          measurements,
          workflow_steps: Array.isArray(template.workflow_steps) ? [...template.workflow_steps] : [],
          scope_template_version: Number(template.scope_template_version || 1) || 1,
          scope_template_version_id: String(template.scope_template_version_id || '')
        }
      ]
    };
  }

  function proposalBuilderRemovePiece(pieceId){
    const nextPieces = proposalBuilderSelectedPieces().filter((piece) => piece.id !== pieceId);
    proposalBuilderState = { ...(proposalBuilderState || { mode: 'select' }), mode: 'select', pieces: nextPieces };
  }

  function proposalBuilderRemoveWorkflowPiece(pieceId){
    if (!proposalBuilderState?.root) {
      proposalBuilderRemovePiece(pieceId);
      return;
    }
    const pieces = proposalBuilderSelectedPieces().filter((piece) => piece.id !== pieceId);
    if (!pieces.length) {
      returnProposalBuilderToTypePicker();
      return;
    }
    proposalBuilderState.pieces = pieces;
    const measurements = normalizeProposalMeasurements(proposalBuilderState.measurements || {});
    const built = proposalBuilderProjectRootFromPieces(pieces, measurements);
    proposalBuilderState.root = built.root;
    proposalBuilderState.scopePieces = built.scopePieces;
    proposalBuilderState.steps = proposalBuilderStepsForPieces(pieces, built.root, built.scopePieces);
    proposalBuilderState.stepIndex = Math.min(proposalBuilderState.stepIndex || 0, proposalBuilderState.steps.length - 1);
    proposalBuilderState.openPieceMenu = '';
  }

  async function proposalBuilderConfirmRemovePiece(pieceId){
    const piece = proposalBuilderPieceById(pieceId);
    if (!piece) return;
    const ok = await (Portal.ui?.confirm?.(((v0) => globalThis.PlatformLanguage?.text("proposals","m_454559d371cc68",`Remove ${v0} from this scope?`,{v0}) ?? `Remove ${v0} from this scope?`)(proposalBuilderPieceDisplayName(piece)), {
      title: (globalThis.PlatformLanguage?.text("proposals","m_7a6a5f10b83ab4","Remove section") ?? "Remove section"),
      okLabel: 'Remove',
      cancelLabel: 'Keep',
      danger: true
    }) || Promise.resolve(false));
    if (!ok) return;
    proposalBuilderRemoveWorkflowPiece(pieceId);
    refreshProposalBuilderViews({ quiet: true });
  }

  function proposalBuilderRefreshAfterPieceMeasurementChange(){
    if (!proposalBuilderState?.root) return;
    rebuildProposalBuilderRoot();
    refreshProposalBuilderViews({ quiet: true });
  }

  function proposalBuilderPieceNeedsPreparedMeasurements(piece = {}){
    const measurements = normalizeProposalMeasurements(piece.measurements || {});
    return !proposalMeasurementsHaveValues(measurements) || proposalMeasurementsLookPlaceholder(measurements);
  }

  function proposalBuilderApplyPreparedMeasurementsToPieces(pieces = [], measurements = {}){
    const prepared = normalizeProposalMeasurements(measurements || {});
    pieces.forEach((piece) => {
      const isRoof = proposalBuilderTemplateById(piece.templateId || piece.id || '').id === 'roof_replacement';
      if (isRoof && proposalBuilderPieceNeedsPreparedMeasurements(piece)) piece.measurements = cloneProposalJson(prepared);
    });
  }

  function proposalBuilderUpdateSectionName(pieceId, value){
    const piece = proposalBuilderPieceById(pieceId);
    if (!piece) return;
    const next = String(value || '').trim();
    piece.sectionName = next || piece.name || proposalBuilderTemplateById(piece.templateId || 'manual').name;
    proposalBuilderRefreshAfterPieceMeasurementChange();
  }

  function proposalBuilderAddStructure(pieceId){
    const piece = proposalBuilderPieceById(pieceId);
    if (!piece) return;
    const current = proposalBuilderStructureSections(piece.measurements || proposalBuilderState?.measurements || {});
    const source = current[current.length - 1] || normalizeProposalMeasurements(piece.measurements || proposalBuilderState?.measurements || {});
    const next = { ...source, name: `Structure ${current.length + 1}` };
    const structures = [...current, next];
    piece.measurements = {
      ...proposalAggregateStructureMeasurements(structures),
      structureMeasurements: structures,
      structureCount: structures.length
    };
    proposalBuilderRefreshAfterPieceMeasurementChange();
  }

  function proposalBuilderRemoveStructure(pieceId, index){
    const piece = proposalBuilderPieceById(pieceId);
    if (!piece) return;
    const structureIndex = Math.max(0, Number(index || 0) || 0);
    const structures = proposalBuilderStructureSections(piece.measurements || proposalBuilderState?.measurements || {}).filter((_, itemIndex) => itemIndex !== structureIndex);
    if (!structures.length) return;
    piece.measurements = {
      ...proposalAggregateStructureMeasurements(structures),
      structureMeasurements: structures,
      structureCount: structures.length
    };
    proposalBuilderRefreshAfterPieceMeasurementChange();
  }

  async function startProposalBuilderWorkflowFromPieces(){
    const pieces = proposalBuilderSelectedPieces();
    if (!pieces.length) {
      showToast((globalThis.PlatformLanguage?.text("proposals","m_9f569783731101","Add work to the project") ?? "Add work to the project"), (globalThis.PlatformLanguage?.text("proposals","m_175682de3101e0","Choose at least one project type before continuing.") ?? "Choose at least one project type before continuing."), false);
      return;
    }
    const roofPiece = pieces.find((piece) => proposalBuilderTemplateById(piece.templateId).id === 'roof_replacement');
    const measurementTemplate = roofPiece?.templateId || pieces[0]?.templateId || 'manual';
    if (!roofPiece) {
      const measurements = defaultProposalMeasurements();
      const built = proposalBuilderProjectRootFromPieces(pieces, measurements);
      proposalBuilderState = {
        template: { id: 'project_scope', name: proposalBuilderTemplateListName(pieces) },
        pieces,
        scopePieces: built.scopePieces,
        stepIndex: 0,
        query: '',
        measurements,
        measurementSource: 'manual_needed',
        root: built.root,
        steps: proposalBuilderStepsForPieces(pieces, built.root, built.scopePieces)
      };
      proposalWorkspaceMode = 'builder';
      refreshProposalBuilderViews({ quiet: true });
      return;
    }
    proposalBuilderState = { ...(proposalBuilderState || {}), mode: 'loading', template: { name: 'Project Scope' }, pieces };
    proposalWorkspaceMode = 'builder';
    refreshProposalBuilderViews({ quiet: true });
    try {
      const prepared = await proposalBuilderMeasurementsForTemplate(measurementTemplate);
      const measurements = prepared.measurements || defaultProposalMeasurements();
      proposalBuilderApplyPreparedMeasurementsToPieces(pieces, measurements);
      const built = proposalBuilderProjectRootFromPieces(pieces, measurements);
      proposalBuilderState = {
        template: { id: 'project_scope', name: proposalBuilderTemplateListName(pieces) },
        pieces,
        scopePieces: built.scopePieces,
        stepIndex: 0,
        query: '',
        measurements,
        measurementSource: prepared.source,
        root: built.root,
        steps: proposalBuilderStepsForPieces(pieces, built.root, built.scopePieces)
      };
    } catch (error) {
      console.warn('Proposal builder preparation failed', error);
      const measurements = defaultProposalMeasurements();
      proposalBuilderApplyPreparedMeasurementsToPieces(pieces, measurements);
      const built = proposalBuilderProjectRootFromPieces(pieces, measurements);
      proposalBuilderState = {
        template: { id: 'project_scope', name: proposalBuilderTemplateListName(pieces) },
        pieces,
        scopePieces: built.scopePieces,
        stepIndex: 0,
        query: '',
        measurements,
        measurementSource: 'manual_needed',
        root: built.root,
        steps: proposalBuilderStepsForPieces(pieces, built.root, built.scopePieces)
      };
    }
    proposalWorkspaceMode = 'builder';
    refreshProposalBuilderViews({ quiet: true });
  }

  function projectScopeFromBuilder(builder = {}){
    if (!builder?.root) return null;
    const measurements = normalizeProposalMeasurements(builder.measurements || {});
    const pieces = proposalBuilderSelectedPieces(builder);
    return {
      schema_version: 1,
      kind: 'project_scope',
      status: 'defined',
      template: {
        id: builder.template?.id || '',
        name: builder.template?.name || proposalBuilderTemplateListName(pieces) || 'Custom Scope'
      },
      pieces: pieces.map((piece) => cloneProposalJson(piece)).filter(Boolean),
      root_items: proposalBuilderScopeRootItems(builder),
      variables: {},
      measurements,
      measurement_source: builder.measurementSource || (proposalMeasurementsHaveValues(measurements) ? 'firstmeasure' : 'manual_needed'),
      selection_state: {},
      completed_at: new Date().toISOString()
    };
  }

  function projectHasDefinedScope(project = activeBaseProject){
    const scope = project?.scope && typeof project.scope === 'object' ? project.scope : null;
    return !!(scope && Array.isArray(scope.root_items) && scope.root_items.length);
  }

  function projectScopeLabel(scope = activeBaseProject?.scope){
    const root = Array.isArray(scope?.root_items) ? scope.root_items[0] : null;
    return scope?.template?.name || root?.display_name || root?.name || 'Project Scope';
  }

  function applyProjectScopeToProposal(proposal, scope = activeBaseProject?.scope){
    if (!proposal || !scope || typeof scope !== 'object') return proposal;
    const clonedScope = cloneProposalJson(scope) || {};
    const measurements = normalizeProposalMeasurements(clonedScope.measurements || proposal.measurements || {});
    proposal.measurements = measurements;
    proposal.measurement_source = clonedScope.measurement_source || proposal.measurement_source || (proposalMeasurementsHaveValues(measurements) ? 'firstmeasure' : 'manual_needed');
    proposal.scope = {
      schema_version: Number(clonedScope.schema_version || 1) || 1,
      template: clonedScope.template && typeof clonedScope.template === 'object' ? clonedScope.template : {},
      pieces: Array.isArray(clonedScope.pieces) ? clonedScope.pieces : [],
      root_items: Array.isArray(clonedScope.root_items) ? clonedScope.root_items : [],
      variables: clonedScope.variables && typeof clonedScope.variables === 'object' ? clonedScope.variables : {},
      measurements,
      selection_state: clonedScope.selection_state && typeof clonedScope.selection_state === 'object' ? clonedScope.selection_state : {},
      source: 'project_scope'
    };
    proposal.scope_template = { ...(proposal.scope.template || {}) };
    proposal.pages = (proposal.pages || []).map((page) => page.kind === 'pricing' ? {
      ...page,
      scope_view: {
        root_item_id: 'root',
        render_depth: 12,
        show_included_items: true,
        show_unselected_options: false
      },
      lineItems: []
    } : page);
    proposal.pages.forEach((page) => {
      if (page.kind === 'pricing') recomputeProposalPricing(page, proposal);
    });
    ensureProposalSignatureData(proposal, false);
    return proposal;
  }

  function createProposalFromProjectScope(scope = activeBaseProject?.scope){
    ensureProposalOnlyBaseProject();
    const proposal = normalizeProposalRecord(buildProposalFromForm(), proposals.length);
    proposal.title = ((v0) => globalThis.PlatformLanguage?.text("proposals","m_0220b604aaca90",`${v0} Proposal`,{v0}) ?? `${v0} Proposal`)(projectScopeLabel(scope));
    applyProjectScopeToProposal(proposal, scope);
    proposals = [...proposals, proposal];
    if (activeBaseProject) activeBaseProject.proposals = proposals;
    activeProposalIndex = proposals.length - 1;
    enterProposalEditMode(activeProposalIndex);
    queueAutosaveNotice();
    saveProposalToBackend(activeProposalIndex, { silent: true }).catch((error) => console.warn('Initial proposal save failed', error));
    return proposal;
  }

  async function proposalBuilderMeasurementsForTemplate(templateId){
    if (proposalBuilderTemplateById(templateId).id !== 'roof_replacement') {
      return { measurements: defaultProposalMeasurements(), source: 'manual_needed' };
    }
    const local = firstMeasureProposalMeasurements();
    if (proposalMeasurementsHaveValues(local || {})) {
      return { measurements: local, source: 'firstmeasure' };
    }
    const projectId = activeMeasurementProjectId();
    if (projectId) {
      const project = typeof activeBaseProject !== 'undefined' ? activeBaseProject : window.activeBaseProject;
      const sharedMeasurements = window.FirstMeasureAPI?.roofMeasurements;
      const result = sharedMeasurements?.load
        ? await sharedMeasurements.load(project || {}, { reportOrderState: window.reportOrderState || {} })
        : { source: await loadProposalMeasurementSource(projectId) };
      const hydrated = result.measurements || firstMeasureProposalMeasurements(result.source || {});
      if (proposalMeasurementsHaveValues(hydrated || {})) {
        return { measurements: hydrated, source: 'firstmeasure' };
      }
    }
    return { measurements: defaultProposalMeasurements(), source: projectId ? 'manual_needed' : 'manual_needed' };
  }

  function proposalBuilderSetCustomerSelectable(selection = {}, enabled = false){
    const current = Array.isArray(selection.selectable_by) ? selection.selectable_by : Array.isArray(selection.selectableBy) ? selection.selectableBy : ['internal'];
    const next = new Set(current.map((item) => String(item || '').trim()).filter(Boolean));
    next.add('internal');
    if (enabled) next.add('customer');
    else next.delete('customer');
    selection.selectable_by = [...next];
    delete selection.selectableBy;
    return selection;
  }

  function proposalBuilderCollectSelectionSteps(scopeItem){
    const groups = new Map();
    const optionals = [];
    walkProposalScopeItems([scopeItem], (item) => {
      const selection = item.selection && typeof item.selection === 'object' ? item.selection : {};
      const mode = String(selection.mode || 'fixed');
      if (mode === 'choice' && selection.group_id) {
        const groupId = String(selection.group_id || '');
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, title: proposalChoiceGroupTitle({ scope: { root_items: [scopeItem] } }, groupId), items: [] });
        groups.get(groupId).items.push(item);
      } else if (mode === 'optional') {
        optionals.push(item);
      }
    });
    const steps = [];
    groups.forEach((group) => {
      if (group.items.length > 1) steps.push({ type: 'choice', id: `choice:${group.id}`, title: group.title, group_id: group.id, items: group.items });
    });
    optionals.forEach((item) => steps.push({ type: 'optional', id: `optional:${item.id}`, title: item.display_name || item.name || 'Optional Item', item }));
    return steps;
  }

  async function proposalBuilderPrepare(templateId){
    const template = proposalBuilderTemplateById(templateId);
    const prepared = await proposalBuilderMeasurementsForTemplate(template.id);
    const measurements = prepared.measurements || defaultProposalMeasurements();
    const root = proposalBuilderScopeForTemplate(template.id, measurements);
    root.measurements = { ...(root.measurements || {}), ...measurements };
    return {
      template,
      stepIndex: 0,
      query: '',
      measurements,
      measurementSource: prepared.source,
      root,
      steps: proposalBuilderStepsForRoot(template, root)
    };
  }

  function openProposalBuilderTemplatePicker(){
    proposalBuilderState = { mode: 'select', query: '' };
    proposalBuilderContext = null;
    proposalWorkspaceMode = 'builder';
    proposalEditorMode = 'preview';
    renderProposalSection();
    renderProposalPreview();
  }

  function returnProposalBuilderToTypePicker(){
    const pieces = proposalBuilderSelectedPieces(proposalBuilderState);
    proposalBuilderState = { mode: 'select', query: '', pieces };
    if (proposalBuilderContext?.mode === 'scope') {
      refreshProposalBuilderViews();
      return;
    }
    openProposalBuilderTemplatePicker();
  }

  async function startProposalBuilderWorkflow(templateId){
    const template = proposalBuilderTemplateById(templateId);
    if (template.manual && !proposalBuilderContext) {
      createManualProposalAndEdit();
      return;
    }
    proposalBuilderState = { mode: 'loading', template, query: '', loadsRoofMeasurements: template.id === 'roof_replacement' };
    proposalWorkspaceMode = 'builder';
    refreshProposalBuilderViews();
    try {
      proposalBuilderState = await proposalBuilderPrepare(templateId);
    } catch (error) {
      console.warn('Proposal builder preparation failed', error);
      const measurements = defaultProposalMeasurements();
      const root = proposalBuilderScopeForTemplate(template.id, measurements);
      proposalBuilderState = {
        template,
        stepIndex: 0,
        query: '',
        measurements,
        measurementSource: 'manual_needed',
        root,
        steps: proposalBuilderStepsForRoot(template, root)
      };
    }
    proposalWorkspaceMode = 'builder';
    refreshProposalBuilderViews();
  }

  function finishProposalBuilderWorkflow(){
    const builder = proposalBuilderState;
    if (!builder?.root) return;
    if (proposalBuilderContext?.mode === 'scope') {
      const scope = projectScopeFromBuilder(builder);
      const onComplete = proposalBuilderContext.onComplete;
      proposalBuilderState = null;
      const previousContext = proposalBuilderContext;
      proposalBuilderContext = null;
      if (typeof onComplete === 'function') {
        onComplete(scope, previousContext);
        return;
      }
    }
    const proposal = normalizeProposalRecord(buildProposalFromForm(), proposals.length);
    const builderPieces = proposalBuilderSelectedPieces(builder);
    proposal.title = ((v0) => globalThis.PlatformLanguage?.text("proposals","m_0220b604aaca90",`${v0} Proposal`,{v0}) ?? `${v0} Proposal`)(builder.template?.name || proposalBuilderTemplateListName(builderPieces));
    proposal.measurements = normalizeProposalMeasurements(builder.measurements || {});
    proposal.measurement_source = builder.measurementSource || (proposalMeasurementsHaveValues(proposal.measurements) ? 'firstmeasure' : 'manual_needed');
    proposal.scope = {
      schema_version: 1,
      template: {
        id: builder.template?.id || '',
        name: builder.template?.name || proposalBuilderTemplateListName(builderPieces) || 'Custom Scope'
      },
      pieces: builderPieces.map((piece) => cloneProposalJson(piece)).filter(Boolean),
      root_items: proposalBuilderScopeRootItems(builder),
      variables: {},
      measurements: proposal.measurements,
      selection_state: {}
    };
    proposal.scope_template = { ...(proposal.scope.template || {}) };
    proposal.pages = proposal.pages.map((page) => page.kind === 'pricing' ? {
      ...page,
      scope_view: {
        root_item_id: 'root',
        render_depth: 12,
        show_included_items: true,
        show_unselected_options: false
      },
      lineItems: []
    } : page);
    proposal.pages.forEach((page) => {
      if (page.kind === 'pricing') recomputeProposalPricing(page, proposal);
    });
    ensureProposalSignatureData(proposal, false);
    proposals = [...proposals, proposal];
    if (activeBaseProject) activeBaseProject.proposals = proposals;
    proposalBuilderState = null;
    activeProposalIndex = proposals.length - 1;
    enterProposalEditMode(activeProposalIndex);
    queueAutosaveNotice();
    saveProposalToBackend(activeProposalIndex, { silent: true }).catch((error) => console.warn('Initial proposal save failed', error));
  }

  function saveProjectScope(scope){
    if (!scope || typeof scope !== 'object') return null;
    const nextProject = {
      ...(activeBaseProject || {}),
      scope: cloneProposalJson(scope),
      project_scope: cloneProposalJson(scope)
    };
    activeBaseProject = nextProject;
    try { state.host?.setProject?.(nextProject); } catch (_) {}
    try { state.host?.persistProject?.(); } catch (_) { persistActiveBaseProject?.(); }
    return nextProject.scope;
  }

  function startProjectScopeWorkflow(options = {}){
    proposalBuilderContext = {
      mode: 'scope',
      source: options.source || 'scope_tab',
      render: typeof options.render === 'function' ? options.render : null,
      onComplete: typeof options.onComplete === 'function' ? options.onComplete : null,
      onCancel: typeof options.onCancel === 'function' ? options.onCancel : null,
      showBack: options.showBack !== false
    };
    proposalBuilderState = { mode: 'select', query: '' };
    if (proposalBuilderContext.render) proposalBuilderContext.render();
    else refreshProposalBuilderViews();
  }

  function openProjectScopeWorkflow(options = {}){
    const existingScope = options.scope || activeBaseProject?.scope || null;
    const hasExisting = projectHasDefinedScope({ scope: existingScope });
    startProjectScopeWorkflow(options);
    if (hasExisting) {
      const template = proposalBuilderTemplateById(existingScope.template?.id || '');
      const root = cloneProposalJson(existingScope.root_items[0]);
      const measurements = normalizeProposalMeasurements(existingScope.measurements || root?.measurements || {});
      proposalBuilderState = {
        template: {
          ...template,
          id: existingScope.template?.id || template.id,
          name: existingScope.template?.name || template.name
        },
        stepIndex: 0,
        query: '',
        measurements,
        measurementSource: existingScope.measurement_source || 'project_scope',
        root,
        steps: proposalBuilderStepsForRoot(template, root)
      };
      if (proposalBuilderContext?.render) proposalBuilderContext.render();
      else refreshProposalBuilderViews();
    }
  }

  function startProposalScopeThenCreate(){
    proposalWorkspaceMode = 'builder';
    proposalEditorMode = 'preview';
    proposalWorkspaceOpen = true;
    proposalBuilderContext = null;
    loadProposalScopeTemplates().catch(() => null);
    startProjectScopeWorkflow({
      source: 'proposal_builder',
      showBack: true,
      onComplete: (scope) => {
        saveProjectScope(scope);
        createProposalFromProjectScope(scope);
      },
      onCancel: () => enterProposalListMode(activeProposalIndex)
    });
    showProposalWorkspace();
  }

  function syncProposalPricebookItems(proposal){
    if (!proposal?.pages?.length) return;
    ensureProposalMeasurements(proposal);
    ensureProposalScope(proposal);
    proposal.pages.forEach((page) => {
      if (page.kind !== 'pricing') return;
      recomputeProposalPricing(page, proposal, { seedScope: true });
    });
  }

  function proposalUsedPricebookState(proposal){
    const usedItemIds = new Set();
    const usedCategories = new Set();
    walkProposalScopeItems(normalizeExistingProposalScope(proposal).root_items, (item) => {
      const ref = item.pricebook_ref || {};
      if (ref.item_id || ref.catalog_item_id) usedItemIds.add(ref.item_id || ref.catalog_item_id);
      if (item.category) usedCategories.add(item.category);
    });
    return { usedItemIds: [...usedItemIds], usedCategories: [...usedCategories] };
  }

  function proposalPricebookOpenState(proposal){
    const measurements = ensureProposalMeasurements(proposal);
    const usage = proposalUsedPricebookState(proposal);
    return {
      usedItemIds: usage.usedItemIds,
      usedCategories: usage.usedCategories,
      initialExpandedCategories: {
        misc: usage.usedCategories.includes('misc'),
        disposal: true,
        shingle_roofs: measurements.shingleSquares > 0 || usage.usedCategories.includes('shingle_roofs'),
        leak_barriers: measurements.shingleSquares > 0 || usage.usedCategories.includes('leak_barriers'),
        flashing: measurements.rakesLf > 0 || measurements.valleyLf > 0 || measurements.sideWallLf > 0 || measurements.headWallLf > 0 || usage.usedCategories.includes('flashing'),
        accessories: measurements.skylightsEa > 0 || measurements.chimneysEa > 0 || usage.usedCategories.includes('accessories'),
        gutters: measurements.gutterLf > 0 || measurements.downspoutLf > 0 || usage.usedCategories.includes('gutters'),
        flat_roofs: measurements.flatRoofSquares > 0 || usage.usedCategories.includes('flat_roofs'),
        flat_roof_accessories: measurements.flatRoofSquares > 0 || measurements.transitionsLf > 0 || measurements.chimneysEa > 0 || usage.usedCategories.includes('flat_roof_accessories'),
      },
    };
  }

  function showAutosaveNotice(){
    const toast = $('#rSaveToast');
    if (!toast) return;
    if (shouldUseMobileOrderPagination()) {
      toast.classList.remove('visible');
      return;
    }
    toast.classList.add('visible');
    clearTimeout(autosaveToastTimer);
    autosaveToastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 950);
  }

  function queueAutosaveNotice(){
    if (suppressAutosaveNotice) return;
    markActiveProposalLocalMutation();
    queueProposalBackendAutosave();
    if (shouldUseMobileOrderPagination()) {
      $('#rSaveToast')?.classList.remove('visible');
      clearTimeout(autosaveDebounceTimer);
      return;
    }
    clearTimeout(autosaveDebounceTimer);
    autosaveDebounceTimer = setTimeout(showAutosaveNotice, 420);
  }

  function proposalContactFallback(contacts){
    return contacts.length ? contacts : [{ name: 'Customer', phone: '', email: '' }];
  }

  function formatProposalPhone(raw){
    const value = String(raw || '').trim();
    const digits = value.replace(/\D/g, '');
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    return value;
  }

  function proposalPreparedForText(contacts){
    return proposalContactFallback(contacts || []).map((contact) => {
      return [contact.name, contact.email, formatProposalPhone(contact.phone)].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n') || 'Customer';
  }

  function normalizeProposalPlainText(value){
    return String(value ?? '')
      .replace(/&lt;br\s*\/?&gt;/gi, '\n')
      .replace(/&lt;\/(div|p)&gt;/gi, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function proposalPreparedForShouldRefresh(value, contacts){
    const normalized = normalizeProposalPlainText(value);
    const contactList = proposalContactFallback(contacts || []);
    const generated = proposalPreparedForText(contactList);
    if (!normalized || normalized === 'Customer') return true;
    if (/<[^>]+>/i.test(String(value || ''))) return true;
    if (/&lt;[^&]+&gt;/i.test(String(value || ''))) return true;
    if (normalized === generated) return false;
    const namesOnly = contactList.map((contact) => contact.name).filter(Boolean).join('\n\n');
    if (normalized === namesOnly) return true;
    return contactList.some((contact) => {
      const name = String(contact.name || '').trim();
      const email = String(contact.email || '').trim();
      const phone = formatProposalPhone(contact.phone);
      return name && normalized.includes(name) && ((email && !normalized.includes(email)) || (phone && !normalized.includes(phone)));
    });
  }

  function proposalPreparedByText(){
    return String(cfg.userName || cfg.userEmail || 'First Mate');
  }

  function proposalCustomerPrimaryContact(proposal){
    return proposalContactFallback(proposal?.contacts || collectContacts())[0] || { name: 'Customer', phone: '', email: '' };
  }

  function proposalTodayText(){
    return new Date().toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month:'long', day:'numeric', year:'numeric' });
  }

  function proposalNumericCurrency(value){
    return Number(normalizeProposalNumber(value || 0) || 0);
  }

  function proposalPricingSubtotal(proposal){
    const scope = proposal?.scope && typeof proposal.scope === 'object' ? proposal.scope : null;
    if (Array.isArray(scope?.root_items) && scope.root_items.length) {
      return scope.root_items.reduce((sum, item) => sum + proposalScopeItemTotalCents(item), 0) / 100;
    }
    return (proposal?.pages || []).filter((page) => page.kind === 'pricing').reduce((sum, page) => {
      return sum + (page.lineItems || []).reduce((pageSum, item) => pageSum + proposalNumericCurrency(item.amount || 0), 0);
    }, 0);
  }

  function proposalPricingSummary(proposal){
    const subtotal = proposalPricingSubtotal(proposal);
    const signaturePage = (proposal?.pages || []).find((page) => page.kind === 'signature');
    const tax = signaturePage?.showTax === false ? 0 : proposalNumericCurrency(signaturePage?.taxAmount || 0);
    return {
      subtotal,
      tax,
      total: subtotal + tax,
    };
  }

  function proposalSignatureTemplateName(proposal, signer){
    if (signer === 'company') return proposalPreparedByText();
    return proposalCustomerPrimaryContact(proposal).name || 'Customer';
  }

  function proposalSignatureTemplate(proposal, signer){
    proposal.signatures ||= {};
    return proposal.signatures[signer] || null;
  }

  function proposalSignedSlot(page, slotKey){
    if (proposalSigningMode) return proposalSigningSession?.pageSlots?.[page?.id]?.[slotKey] || null;
    const slots = page?.signedSlots && typeof page.signedSlots === 'object' ? page.signedSlots : {};
    return slots[slotKey] || null;
  }

  function proposalRenderSignatureValue(signature){
    if (!signature) return '';
    if (signature.type === 'draw' && signature.dataUrl) {
      return `<span class="r-proposal-signature-script"><img src="${String(escapeHtml(signature.dataUrl))}" alt="${(globalThis.PlatformLanguage?.htmlText("proposals","m_8625881623433e","Signature") ?? "Signature")}"></span>`;
    }
    const style = signature.style || 'style-classic';
    return `<span class="r-proposal-signature-script ${escapeHtml(style)}">${escapeHtml(signature.text || signature.name || 'Signature')}</span>`;
  }

  function ensureProposalSignatureData(proposal, signingNow = false){
    if (!proposal) return;
    const customer = proposalCustomerPrimaryContact(proposal);
    const preparedBy = proposalPreparedByText();
    const today = proposalTodayText();
    proposal.signatures ||= {};
    proposal.pages = (proposal.pages || []).map((page) => {
      if (page.kind === 'signature') {
        const pricingSubtotal = proposalPricingSubtotal(proposal);
        const defaultSchedule = proposalDefaultPaymentSchedule();
        page.customerSignatureLabel ||= 'Customer Signature';
        page.customerPrintedNameLabel ||= 'Customer Printed Name';
        page.companySignatureLabel ||= 'Company Representative Signature';
        page.companyRepresentativeLabel ||= 'Company Representative';
        page.dateLabel ||= 'Date';
        page.requireCompanySignature = page.requireCompanySignature !== false;
        page.showDate = page.showDate !== false;
        page.showTax = page.showTax !== false;
        page.pricingSummaryTitle ||= 'Contract Amount';
        page.paymentScheduleTitle ||= 'Payment Schedule';
        page.depositLabel ||= defaultSchedule[0]?.label || 'Deposit';
        page.completionLabel ||= defaultSchedule[1]?.label || 'Progress Payment';
        page.financedLabel ||= defaultSchedule[2]?.label || 'Final Payment';
        page.customerPrintedNameValue = page.customerPrintedNameValue || customer.name || 'Customer';
        page.companyRepresentativeValue = page.companyRepresentativeValue || preparedBy;
        if (signingNow || !page.dateValue) page.dateValue = today;
        if (page.taxRatePercent === undefined || page.taxRatePercent === null || page.taxRatePercent === '') page.taxRatePercent = proposalPercentDisplay(proposalDefaultSalesTaxPercent());
        const taxRate = page.showTax === false ? 0 : proposalPercentValue(page.taxRatePercent, 0);
        const taxAmount = pricingSubtotal * (taxRate / 100);
        page.taxAmount = proposalCurrencyDisplay(taxAmount);
        page.subtotalValue = proposalCurrencyDisplay(pricingSubtotal);
        page.taxValue = proposalCurrencyDisplay(taxAmount);
        page.totalValue = proposalCurrencyDisplay(pricingSubtotal + taxAmount);
        PROPOSAL_PAYMENT_ROWS.forEach((row, index) => {
          if (page[row.percentField] === undefined || page[row.percentField] === null || page[row.percentField] === '') {
            page[row.percentField] = proposalPercentDisplay(defaultSchedule[index]?.percent || 0);
          } else {
            page[row.percentField] = proposalPercentDisplay(page[row.percentField]);
          }
          page[row.labelField] ||= defaultSchedule[index]?.label || row.defaultLabel;
        });
        const total = pricingSubtotal + taxAmount;
        const validSchedule = proposalPaymentScheduleValid(page);
        const firstAmount = total * (proposalPercentValue(page.depositPercent, 0) / 100);
        const secondAmount = total * (proposalPercentValue(page.completionPercent, 0) / 100);
        const thirdAmount = validSchedule
          ? Math.max(0, total - firstAmount - secondAmount)
          : total * (proposalPercentValue(page.financedPercent, 0) / 100);
        page.depositAmount = proposalCurrencyDisplay(firstAmount);
        page.completionAmount = proposalCurrencyDisplay(secondAmount);
        page.financedAmount = proposalCurrencyDisplay(thirdAmount);
        page.paymentSchedulePercentTotal = proposalPercentDisplay(proposalPaymentPercentSum(page));
        page.paymentScheduleValid = validSchedule;
        syncProposalPaymentScheduleExport(proposal, page);
      }
      if (page.kind === 'fine_print') {
        page.customerSignatureLabel ||= 'Customer Signature';
        page.requireCustomerSignature = page.requireCustomerSignature !== false;
        page.customerPrintedNameValue = page.customerPrintedNameValue || customer.name || 'Customer';
      }
      return page;
    });
  }

  function proposalSignatureTargets(proposal){
    const targets = [];
    (proposal?.pages || []).forEach((page) => {
      if (page.kind === 'signature') {
        targets.push({ pageId: page.id, slotKey: 'customerSignature', signer: 'customer' });
        if (page.requireCompanySignature !== false) targets.push({ pageId: page.id, slotKey: 'companySignature', signer: 'company' });
      }
      if (page.kind === 'fine_print' && page.requireCustomerSignature !== false) {
        targets.push({ pageId: page.id, slotKey: 'customerSignature', signer: 'customer' });
      }
    });
    return targets;
  }

  function ensureProposalSigningSession(proposal){
    if (!proposal) return null;
    if (!proposalSigningSession || proposalSigningSession.proposalId !== proposal.id) {
      proposalSigningSession = {
        proposalId: proposal.id,
        pageSlots: {},
        signerTemplates: { ...(proposal.signatures || {}) },
      };
    }
    return proposalSigningSession;
  }

  function proposalSigningComplete(proposal){
    const session = ensureProposalSigningSession(proposal);
    return proposalSignatureTargets(proposal).every((target) => session?.pageSlots?.[target.pageId]?.[target.slotKey]);
  }

  function proposalNextUnsignedTarget(proposal){
    const session = ensureProposalSigningSession(proposal);
    return proposalSignatureTargets(proposal).find((target) => !session?.pageSlots?.[target.pageId]?.[target.slotKey]) || null;
  }

  function proposalCoverImages(proposal){
    const ids = proposal?.coverImageIds?.length ? proposal.coverImageIds : (proposal?.coverImage ? [proposal.coverImage] : []);
    const images = ids.map((id) => proposalPhotoById(id)).filter(Boolean);
    if (images.length) return images;
    const thumbnail = projectThumbnailPhoto();
    return thumbnail ? [thumbnail] : [];
  }

  function proposalCoverImage(proposal){
    return proposalCoverImages(proposal)[0]?.src || proposalCoverImages(proposal)[0]?.thumb || '';
  }

  function proposalMediaKind(media = {}){
    const metadata = media?.metadata && typeof media.metadata === 'object' ? media.metadata : {};
    const explicit = String(media?.media_type || media?.mediaType || media?.type || metadata.media_type || metadata.mediaType || '').trim().toLowerCase();
    if (explicit.startsWith('video')) return 'video';
    const mime = String(media?.mime_type || media?.mimeType || media?.content_type || media?.contentType || metadata.mime_type || metadata.content_type || '').trim().toLowerCase();
    if (mime.startsWith('video/')) return 'video';
    const source = String(media?.src || media?.url || media?.original || media?.file_url || media?.label || '').trim().toLowerCase();
    return /\.(mp4|mov|m4v|webm|ogv)(?:[?#].*)?$/.test(source) ? 'video' : 'image';
  }

  function proposalMediaIsVideo(media = {}){
    return proposalMediaKind(media) === 'video';
  }

  function proposalMediaSource(media = {}){
    const mediaId = String(media?.media_id || media?.mediaId || '').trim();
    const apiSource = mediaId && projectOrgId() && window.PlatformAPI?.media?.fileUrl
      ? window.PlatformAPI.media.fileUrl(projectOrgId(), mediaId, 'original')
      : '';
    return String(media?.src || media?.url || media?.original || media?.file_url || apiSource || '').trim();
  }

  function proposalMediaThumbnail(media = {}){
    const mediaId = String(media?.media_id || media?.mediaId || '').trim();
    const apiThumbnail = mediaId && projectOrgId() && window.PlatformAPI?.media?.thumbnailUrl
      ? window.PlatformAPI.media.thumbnailUrl(projectOrgId(), mediaId, 1280)
      : '';
    const explicit = String(media?.thumb || media?.thumbnail || media?.thumbnail_url || media?.poster || apiThumbnail || '').trim();
    return explicit || (proposalMediaIsVideo(media) ? '' : proposalMediaSource(media));
  }

  function proposalVideoKey(media = {}, placement = ''){
    return [placement, projectPhotoId(media), media?.media_id, proposalMediaSource(media)].filter(Boolean).join(':');
  }

  function proposalMediaVisualHtml(media = {}, placement = '', options = {}){
    const source = proposalMediaSource(media);
    const thumbnail = proposalMediaThumbnail(media);
    const alt = escapeHtml(media?.alt || media?.label || (proposalMediaIsVideo(media) ? 'Proposal video' : 'Proposal image'));
    const style = options.style ? ` style="${escapeHtml(options.style)}"` : '';
    if (media?.uploading) return `<span class="r-proposal-media-processing"${String(style)}><i class="fas fa-spinner fa-spin"></i><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_7244c568a68bff","Processing") ?? "Processing")}</strong></span>`;
    if (!proposalMediaIsVideo(media)) return source || thumbnail ? `<img src="${escapeHtml(thumbnail || source)}" alt="${alt}"${style}>` : '';
    if (!source) return thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="${alt}"${style}>` : '';
    const key = proposalVideoKey(media, placement);
    return `
      <span class="r-proposal-video-frame">
        <video class="r-proposal-video-player" data-proposal-video="true" data-proposal-video-key="${escapeHtml(key)}" src="${escapeHtml(source)}"${thumbnail ? ` poster="${escapeHtml(thumbnail)}"` : ''} controls playsinline preload="metadata"></video>
        <video class="r-proposal-video-print-fallback" src="${escapeHtml(source)}" muted playsinline preload="metadata" aria-label="${alt}"></video>
        ${thumbnail ? `<img class="r-proposal-video-print-thumbnail" src="${escapeHtml(thumbnail)}" alt="${alt}" onerror="this.remove()">` : ''}
      </span>
    `;
  }

  function bindProposalVideoPlayback(root = document){
    root.__proposalVideoObserver?.disconnect?.();
    const videos = Array.from(root.querySelectorAll?.('video[data-proposal-video="true"]') || []);
    if (!videos.length) return;
    videos.forEach((video) => {
      video.addEventListener('play', () => {
        proposalAutoPlayedVideoKeys.add(video.dataset.proposalVideoKey || video.currentSrc || video.src);
      });
    });
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const video = entry.target;
        const key = video.dataset.proposalVideoKey || video.currentSrc || video.src;
        if (!entry.isIntersecting || entry.intersectionRatio < 0.999 || proposalAutoPlayedVideoKeys.has(key)) return;
        proposalAutoPlayedVideoKeys.add(key);
        video.muted = true;
        video.play().catch(() => proposalAutoPlayedVideoKeys.delete(key));
      });
    }, { threshold: [1] });
    videos.forEach((video) => observer.observe(video));
    root.__proposalVideoObserver = observer;
  }

  function proposalPageSubtitle(page){
    if (page.kind === 'cover') return 'Cover page';
    if (page.kind === 'scope') return 'Image and text layout';
    if (page.kind === 'pricing') return 'Pricing and totals';
    if (page.kind === 'marketing') return 'Full-page marketing insert';
    if (page.kind === 'measurement_insert') return 'FirstMeasure summary page';
    if (page.kind === 'image_text') return 'Image and text layout';
    if (page.kind === 'signature') return 'Signature and approval';
    if (page.kind === 'fine_print') return 'Fine print and final signature';
    return '';
  }

  function proposalDisplayTitle(page){
    if (!page) return '';
    if (page.kind === 'marketing') {
      const assets = getOrganizationMarketingPages();
      return assets.find((asset) => asset.id === page.assetId)?.title || page.title || (globalThis.PlatformLanguage?.text("proposals","m_f8e8c0748ca369","Marketing Page") ?? "Marketing Page");
    }
    if (page.kind === 'cover') return page.heading || page.title || (globalThis.PlatformLanguage?.text("proposals","m_03779727637975","Cover") ?? "Cover");
    return page.title || '';
  }

  function proposalTriangleHeaderVars(page){
    const title = proposalDisplayTitle(page) || '';
    const chars = Math.max(6, title.length || 0);
    const width = Math.max(32, Math.min(72, 18 + (chars * 3.3)));
    const accentWidth = Math.max(width + 7, Math.min(68, width + 10));
    return `--triangle-header-width:${width}%;--triangle-accent-width:${accentWidth}%`;
  }

  function getOrganizationMarketingPages(){
    const style = getBranchPresentationStyle();
    const pages = style.orgProposalPages || style.organizationProposalPages || style.marketing_pages || style.marketingPages || style.brandAssets || cfg.orgProposalPages || cfg.organizationProposalPages || cfg.marketingPages || cfg.brandAssets || [];
    if (Array.isArray(pages) && pages.length) {
      return pages.map((page, index) => ({
        id: String(page.id || page.key || `marketing_${index + 1}`),
        title: String(page.title || page.name || `Marketing Page ${index + 1}`),
        subtitle: String(page.subtitle || page.description || 'Organization marketing insert'),
        image: page.image || page.thumb || page.preview || '',
        url: page.url || page.href || page.pdf || '',
        pdf: page.pdf || '',
        page: Number(page.page || page.page_number || 1) || 1,
      }));
    }
    return [
      { id: 'marketing_shingles', title: (globalThis.PlatformLanguage?.text("proposals","m_030b5b67872c2f","Premium Shingles") ?? "Premium Shingles"), subtitle: (globalThis.PlatformLanguage?.text("proposals","m_68eb049e29bfb1","Manufacturer brochure preview") ?? "Manufacturer brochure preview"), image: '' },
      { id: 'marketing_warranty', title: (globalThis.PlatformLanguage?.text("proposals","m_5740544c77b1fd","Warranty Coverage") ?? "Warranty Coverage"), subtitle: (globalThis.PlatformLanguage?.text("proposals","m_5d867e8e05b8b1","Coverage and workmanship preview") ?? "Coverage and workmanship preview"), image: '' },
    ];
  }

  function proposalMeasurementInsertAssets(){
    const projectId = activeMeasurementProjectId();
    const cached = projectId ? primeMeasurementAssetCacheFromKnownUrls(projectId) : null;
    if (projectId && !cached?.hasCheckedArtifacts && !measurementAssetLoads.has(projectId)) {
      loadMeasurementAssets(projectId).then((assets) => {
        if (assets?.hasCheckedArtifacts && proposalsEnabled() && activePreviewTab === 'proposal' && proposalWorkspaceOpen) {
          renderProposalSection();
          renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        }
      }).catch(() => null);
    }
    const assets = [];
    const addPdfPages = (source, title, subtitle, url, count = 6) => {
      if (!url) return;
      for (let page = 1; page <= count; page += 1) {
        assets.push({
          id: `${source}_${page}`,
          source,
          page,
          title: `${title} ${page}`,
          subtitle,
          url,
          pdf: url,
          renderMode: 'canvas',
        });
      }
    };
    addPdfPages('summary', 'Summary Page', 'Customer-facing summary', cached?.summaryUrl || '', 6);
    return assets;
  }

  function proposalFullPageAssetUrl(asset = {}){
    const url = String(asset.pdf || asset.url || asset.image || asset.preview || asset.thumb || '').trim();
    if (!url) return '';
    if (asset.pdf || /\.pdf(?:$|[?#])/i.test(url)) {
      const page = Math.max(1, Number(asset.page || 1) || 1);
      const glue = url.includes('#') ? '&' : '#';
      return `${url}${glue}page=${page}&view=Fit`;
    }
    return url;
  }

  function proposalFullPageInsertMarkup(page, assets, options = {}){
    const isEdit = !!options.isEdit;
    const emptyTitle = options.emptyTitle || 'Select a page';
    const emptySubtitle = options.emptySubtitle || 'Choose one of the available full-page inserts.';
    const active = assets.find((asset) => asset.id === page.assetId) || assets[0] || null;
    const url = proposalFullPageAssetUrl(active);
    const isPdf = !!(active?.pdf || /\.pdf(?:$|[?#])/i.test(url));
    const renderCanvas = isPdf && active?.renderMode === 'canvas';
    return `
      <div class="r-proposal-full-insert">
        ${url ? (
          renderCanvas
            ? `<div class="r-proposal-pdf-canvas-page" data-pdf-canvas-url="${String(escapeHtml(active.pdf || active.url || ''))}" data-pdf-canvas-page="${String(escapeHtml(String(active.page || 1)))}"><div class="r-proposal-full-placeholder"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_67a76a9542dd32","Rendering page...") ?? "Rendering page...")}</strong><span>${String(escapeHtml(active?.title || page.title || (globalThis.PlatformLanguage?.text("proposals","m_c82963ef8940ce","Summary page") ?? "Summary page")))}</span></div></div>`
            : (isPdf
              ? `<iframe src="${escapeHtml(url)}" title="${escapeHtml(active?.title || page.title || (globalThis.PlatformLanguage?.text("proposals","m_a467ce931afad1","Proposal insert") ?? "Proposal insert"))}"></iframe>`
            : `<img src="${escapeHtml(url)}" alt="${escapeHtml(active?.title || page.title || (globalThis.PlatformLanguage?.text("proposals","m_a467ce931afad1","Proposal insert") ?? "Proposal insert"))}">`
            )
        ) : `
          <div class="r-proposal-full-placeholder">
            <strong>${escapeHtml(active?.title || emptyTitle)}</strong>
            <span>${escapeHtml(active?.subtitle || emptySubtitle)}</span>
          </div>
        `}
      </div>
      ${isEdit ? `
        <div class="r-proposal-full-select">
          ${assets.length ? assets.map((asset) => `<button type="button" class="r-proposal-full-option${asset.id === active?.id ? ' active' : ''}" data-full-insert-asset="${escapeHtml(asset.id)}"><strong>${escapeHtml(asset.title)}</strong><span>${escapeHtml(asset.subtitle || '')}</span></button>`).join('') : `<div class="r-proposal-full-placeholder" style="min-height:104px;padding:16px"><strong>${escapeHtml(emptyTitle)}</strong><span>${escapeHtml(emptySubtitle)}</span></div>`}
        </div>
      ` : ''}
    `;
  }

  function proposalIsFullPageInsert(page){
    return ['marketing', 'measurement_insert'].includes(String(page?.kind || ''));
  }

  async function ensureProposalPdfJs(){
    if (window.pdfjsLib || window['pdfjs-dist/build/pdf']) return window.pdfjsLib || window['pdfjs-dist/build/pdf'];
    if (!proposalPdfJsLoading) {
      proposalPdfJsLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.onload = () => {
          const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
          if (!lib) {
            reject(new Error('PDF.js loaded but did not expose a runtime.'));
            return;
          }
          lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          resolve(lib);
        };
        script.onerror = () => reject(new Error('Unable to load PDF.js.'));
        document.head.appendChild(script);
      }).catch((error) => {
        proposalPdfJsLoading = null;
        throw error;
      });
    }
    return proposalPdfJsLoading;
  }

  async function proposalPdfDocument(url){
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) return null;
    if (proposalPdfDocumentCache.has(cleanUrl)) return proposalPdfDocumentCache.get(cleanUrl);
    const lib = await ensureProposalPdfJs();
    const loadingTask = lib.getDocument({
      url: cleanUrl,
      withCredentials: true,
      disableAutoFetch: false,
      disableStream: false,
    });
    const promise = loadingTask.promise.catch((error) => {
      proposalPdfDocumentCache.delete(cleanUrl);
      throw error;
    });
    proposalPdfDocumentCache.set(cleanUrl, promise);
    return promise;
  }

  async function renderProposalPdfCanvasPage(el){
    if (!el || el.dataset.rendered === 'true') return;
    const url = String(el.dataset.pdfCanvasUrl || '').trim();
    const requestedPage = Math.max(1, Number(el.dataset.pdfCanvasPage || 1) || 1);
    if (!url) return;
    el.dataset.rendered = 'pending';
    try {
      const doc = await proposalPdfDocument(url);
      const pageNumber = Math.max(1, Math.min(doc.numPages || requestedPage, requestedPage));
      const page = await doc.getPage(pageNumber);
      const box = el.getBoundingClientRect();
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.max(0.2, Math.min(
        (box.width || 820) / unscaled.width,
        (box.height || 1061) / unscaled.height,
        2.5
      ));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      el.innerHTML = '';
      el.appendChild(canvas);
      el.dataset.rendered = 'true';
      window.__proposalPdfCanvasReady = true;
    } catch (error) {
      console.warn('Unable to render proposal PDF page', error);
      el.dataset.rendered = 'error';
      el.innerHTML = `<div class="r-proposal-full-placeholder"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_960234df0d1ec7","Summary unavailable") ?? "Summary unavailable")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_96d8de038acc80","Could not render this Summary PDF page.") ?? "Could not render this Summary PDF page.")}</span></div>`;
    }
  }

  function renderProposalPdfCanvasPages(root = document){
    const targets = Array.from(root.querySelectorAll?.('[data-pdf-canvas-url]') || []);
    if (!targets.length) {
      window.__proposalPdfCanvasReady = true;
      return;
    }
    window.__proposalPdfCanvasReady = false;
    Promise.all(targets.map(renderProposalPdfCanvasPage)).finally(() => {
      window.__proposalPdfCanvasReady = true;
    });
  }

  function createProposalMediaBlock(type = 'image_text', previous = null){
    return {
      id: createProposalPageId(),
      type,
      ratio: previous?.ratio ?? PROPOSAL_IMAGE_TEXT_DEFAULT.ratio,
      height: previous?.height ?? PROPOSAL_IMAGE_TEXT_DEFAULT.height,
      imageLeft: previous?.imageLeft ?? PROPOSAL_IMAGE_TEXT_DEFAULT.imageLeft,
      imageIds: type === 'text' ? [] : [...(previous?.imageIds || [])].slice(0, 4),
      text: type === 'image' ? '' : (previous?.text || ''),
    };
  }

  function defaultImageTextBlock(previous = null){
    return createProposalMediaBlock('image_text', previous);
  }

  function proposalMediaBlockMaxHeight(blockEl){
    const pageContent = blockEl?.closest('.r-proposal-page-content');
    if (!blockEl || !pageContent) return 420;
    const contentRect = pageContent.getBoundingClientRect();
    const blockRect = blockEl.getBoundingClientRect();
    const available = contentRect.bottom - blockRect.top - 18;
    return Math.max(160, Math.min(420, Math.floor(available)));
  }

  function proposalPricingMetrics(theme = 'margin', proposal = proposals?.[activeProposalIndex]){
    const pageHeightDelta = proposalPageHeightDelta(proposal);
    if (theme === 'triangles') {
      return { bodyHeight: 680 + pageHeightDelta, lineHeight: 32, addRowHeight: 50, totalHeight: 54, choiceRowHeight: 34 };
    }
    if (theme === 'clean') {
      return { bodyHeight: 860 + pageHeightDelta, lineHeight: 32, addRowHeight: 50, totalHeight: 54, choiceRowHeight: 34 };
    }
    return { bodyHeight: 830 + pageHeightDelta, lineHeight: 32, addRowHeight: 50, totalHeight: 54, choiceRowHeight: 34 };
  }

  function proposalPricingCapacity(theme = 'margin', { isFinal = false, isEdit = false, proposal = proposals?.[activeProposalIndex] } = {}){
    const metrics = proposalPricingMetrics(theme, proposal);
    let available = metrics.bodyHeight;
    if (isFinal) {
      available -= metrics.totalHeight;
    }
    return Math.max(1, Math.floor(available / metrics.lineHeight));
  }

  function proposalPricingRowHeight(item = {}, theme = 'margin', proposal = proposals?.[activeProposalIndex]){
    const metrics = proposalPricingMetrics(theme, proposal);
    const dimensions = proposalPaperDimensions(proposal);
    const widthRatio = Math.max(0.7, dimensions.widthPx / PROPOSAL_PREVIEW_PAGE_WIDTH);
    const labelLength = proposalPlainTextLength(item.label || item.name || '').length;
    const descriptionLength = item.show_description ? proposalPlainTextLength(item.description || '').length : 0;
    const depthReserve = Math.max(0, Number(item.__scopeDepth || 0)) * 3;
    const labelCharsPerLine = Math.max(18, Math.floor((theme === 'margin' ? 35 : 42) * widthRatio) - depthReserve);
    const descriptionCharsPerLine = Math.max(24, Math.floor((theme === 'margin' ? 52 : 60) * widthRatio) - depthReserve);
    const labelLines = Math.max(1, Math.ceil(Math.max(1, labelLength) / labelCharsPerLine));
    const descriptionLines = descriptionLength ? Math.max(1, Math.ceil(descriptionLength / descriptionCharsPerLine)) : 0;
    const descriptionReserve = descriptionLines * 18;
    const wrappingReserve = Math.max(0, labelLines - 1) * 17;
    const choiceReserve = proposalChoiceGridRowCount(item.__choiceOptionCount || 0) * (metrics.choiceRowHeight || 36);
    const base = item.__isCategory ? metrics.lineHeight + 6 : metrics.lineHeight;
    return base + wrappingReserve + descriptionReserve + choiceReserve;
  }

  function proposalTakePricingRows(items = [], cursor = 0, availableHeight = 0, theme = 'margin', minimumRemaining = 0, proposal = proposals?.[activeProposalIndex]){
    let height = 0;
    let take = 0;
    while (cursor + take < items.length) {
      const remainingAfter = items.length - (cursor + take + 1);
      if (minimumRemaining > 0 && remainingAfter < minimumRemaining) break;
      const nextHeight = proposalPricingRowHeight(items[cursor + take], theme, proposal);
      if (take > 0 && height + nextHeight > availableHeight) break;
      height += nextHeight;
      take += 1;
    }
    return Math.max(1, take);
  }

  function proposalSplitPricingSections(page, proposalOrTheme = 'margin', themeOrIsEdit = undefined, explicitIsEdit = undefined){
    const proposal = proposalOrTheme && typeof proposalOrTheme === 'object' ? proposalOrTheme : proposals[activeProposalIndex];
    const theme = typeof proposalOrTheme === 'string' ? proposalOrTheme : (typeof themeOrIsEdit === 'string' ? themeOrIsEdit : (proposal?.theme || 'margin'));
    const isEdit = typeof explicitIsEdit === 'boolean'
      ? explicitIsEdit
      : (typeof themeOrIsEdit === 'boolean' ? themeOrIsEdit : proposalEditorMode === 'edit');
    const items = proposalPricingRowsForPage(page, proposal, { includeDisabledRows: isEdit }).map((item, index) => ({ ...item, __logicalLineItemIndex: item.__logicalLineItemIndex ?? index }));
    if (!items.length) {
      return [{
        ...page,
        lineItems: [],
        showAddRow: isEdit,
        showTotal: true,
      }];
    }
    const metrics = proposalPricingMetrics(theme, proposal);
    const finalHeight = metrics.bodyHeight - metrics.totalHeight;
    const continuedHeight = metrics.bodyHeight;
    const finalCapacity = proposalPricingCapacity(theme, { isFinal: true, isEdit, proposal });
    const sections = [];
    let cursor = 0;
    while (cursor < items.length) {
      const remaining = items.length - cursor;
      const isFinal = remaining <= finalCapacity;
      const take = isFinal
        ? Math.min(remaining, proposalTakePricingRows(items, cursor, finalHeight, theme, 0, proposal))
        : proposalTakePricingRows(items, cursor, continuedHeight, theme, 1, proposal);
      const endsHere = cursor + take >= items.length;
      sections.push({
        ...page,
        lineItems: items.slice(cursor, cursor + take),
        showAddRow: endsHere && isEdit,
        showTotal: endsHere,
      });
      cursor += take;
    }
    return sections;
  }

  function appendProposalLineItem(page, proposal = null, item = null, parentItemId = ''){
    if (!page || page.kind !== 'pricing') return -1;
    if (proposal) {
      const children = proposalScopeChildrenForTarget(page, proposal, parentItemId);
      const nextScopeItem = createManualProposalScopeItem(item || {}, children.length);
      children.push(nextScopeItem);
      recomputeProposalPricing(page, proposal);
      const rows = proposalPricingRowsForPage(page, proposal);
      const rowIndex = rows.findIndex((row) => row.__scopeItemId === nextScopeItem.id);
      return rowIndex >= 0 ? rowIndex : rows.length - 1;
    }
    const nextItem = item ? { ...item } : { label: (globalThis.PlatformLanguage?.text("proposals","m_3cab406acb39e4","New Line Item") ?? "New Line Item"), quantity: '1', unitPrice: '$0.00', amount: '$0.00' };
    page.lineItems = [...(page.lineItems || []), nextItem];
    recomputeProposalPricing(page, proposal);
    return page.lineItems.length - 1;
  }

  function appendProposalSectionLineItem(page, proposal = null, item = null, parentItemId = ''){
    return appendProposalLineItem(page, proposal, {
      item_kind: 'section',
      is_section: true,
      label: item?.label || item?.name || 'New Section',
      name: item?.name || item?.label || 'New Section',
      display_name: item?.display_name || item?.displayName || item?.label || 'New Section',
      quantity: '0',
      unitPrice: '$0.00',
      unit_price: 0,
      base_price: 0,
      price_driving: false,
      children: [],
      ...(item || {}),
    }, parentItemId);
  }

  function appendProposalDiscountLineItem(page, proposal = null, item = null, parentItemId = ''){
    return appendProposalLineItem(page, proposal, {
      item_kind: 'discount',
      is_discount: true,
      label: item?.label || item?.name || 'Discount',
      name: item?.name || item?.label || 'Discount',
      display_name: item?.display_name || item?.displayName || item?.label || 'Discount',
      quantity: item?.quantity || '0',
      unitPrice: item?.unitPrice || '$0.00',
      unit_price: item?.unit_price ?? item?.unitPrice ?? '$0.00',
      base_price: item?.base_price ?? item?.basePrice ?? item?.unit_price ?? item?.unitPrice ?? '$0.00',
      discount_mode: item?.discount_mode || item?.discountMode || 'amount',
      discount_amount: item?.discount_amount ?? item?.discountAmount ?? '0',
      discount_percent: item?.discount_percent ?? item?.discountPercent ?? '',
      price_driving: true,
      included: false
    }, parentItemId);
  }

  function proposalPlainTextLength(html = ''){
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function proposalIntroReserve(page, includeAddPicker){
    const addPickerReserve = includeAddPicker ? 96 : 0;
    const introHidden = page?.showIntro === false;
    if (page.kind === 'scope') {
      if (introHidden) return addPickerReserve;
      const text = proposalPlainTextLength(page.summary || '');
      const explicitLines = text ? text.split('\n').length : 1;
      const wrappedLines = Math.max(explicitLines, Math.ceil(Math.max(1, text.length) / 72));
      return 106 + (wrappedLines * 22) + addPickerReserve;
    }
    if (page.kind === 'image_text') {
      return (introHidden ? 0 : 74) + addPickerReserve;
    }
    return addPickerReserve;
  }

  function proposalMediaPageLimit(page, includeAddPicker = false, proposal = proposals?.[activeProposalIndex]){
    return Math.max(
      180,
      PROPOSAL_MEDIA_PAGE_HEIGHT + proposalPageHeightDelta(proposal)
        - PROPOSAL_MEDIA_BOTTOM_GUTTER
        - proposalIntroReserve(page, includeAddPicker)
    );
  }

  function proposalMediaBlockHeight(block){
    return Math.max(120, Number(block?.height || PROPOSAL_IMAGE_TEXT_DEFAULT.height));
  }

  function proposalMediaSectionUsed(blocks){
    return (blocks || []).reduce((total, block, index) => {
      return total + proposalMediaBlockHeight(block) + (index > 0 ? PROPOSAL_MEDIA_BLOCK_GAP : 0);
    }, 0);
  }

  function proposalSplitContentBlocks(page, isEdit = proposalEditorMode === 'edit', proposal = proposals?.[activeProposalIndex]){
    const blocks = page.blocks || [];
    const sections = [];
    let current = [];
    let used = 0;
    let physicalIndex = 0;
    const pageLimit = (index, includeAddPicker = false) => proposalMediaPageLimit({ ...page, showIntro: index === 0 }, includeAddPicker, proposal);
    const pushSection = (showAddBlock = false) => {
      sections.push({
        physicalIndex,
        page: {
          ...page,
          blocks: current.map((entry) => ({ ...entry })),
          showIntro: physicalIndex === 0,
          allowBlockEditing: isEdit,
          showAddBlock,
        },
      });
    };
    blocks.forEach((block, blockIndex) => {
      const entry = { ...block, __logicalBlockIndex: blockIndex };
      const height = proposalMediaBlockHeight(entry);
      const added = height + (current.length ? PROPOSAL_MEDIA_BLOCK_GAP : 0);
      const limit = pageLimit(physicalIndex, false);
      if (current.length && used + added > limit) {
        pushSection(false);
        current = [];
        used = 0;
        physicalIndex += 1;
      }
      current.push(entry);
      used += height + (current.length > 1 ? PROPOSAL_MEDIA_BLOCK_GAP : 0);
    });
    while (isEdit && current.length > 1 && proposalMediaSectionUsed(current) > pageLimit(physicalIndex, true)) {
      const overflow = current.pop();
      pushSection(false);
      current = overflow ? [overflow] : [];
      physicalIndex += 1;
    }
    if (!current.length) current = [];
    pushSection(isEdit);
    return sections;
  }

  function proposalSplitFinePrintSections(page, proposal = proposals?.[activeProposalIndex]){
    const body = String(page?.body || '');
    const plain = proposalPlainTextLength(body);
    const signatureReserve = page?.requireCustomerSignature === false ? 0 : 150;
    const pageContentHeight = PROPOSAL_ITEM_PAGE_HEIGHT + proposalPageHeightDelta(proposal);
    const firstCapacity = Math.max(240, Math.floor((pageContentHeight - 210 - signatureReserve) * 2.15));
    const continuedCapacity = Math.max(260, Math.floor((pageContentHeight - 96 - signatureReserve) * 2.35));
    if (!plain || plain.length <= firstCapacity) {
      return [{
        physicalIndex: 0,
        page: {
          ...page,
          bodyChunk: body,
          showSignature: true,
        },
      }];
    }
    const words = body.split(/\s+/).filter(Boolean);
    const sections = [];
    let current = [];
    let currentLen = 0;
    let physicalIndex = 0;
    let cursor = 0;
    while (cursor < words.length) {
      const capacity = physicalIndex === 0 ? firstCapacity : continuedCapacity;
      const nextWord = words[cursor];
      const added = nextWord.length + (current.length ? 1 : 0);
      if (current.length && currentLen + added > capacity) {
        sections.push({
          physicalIndex,
          page: {
            ...page,
            bodyChunk: current.join(' '),
            showSignature: false,
          },
        });
        current = [];
        currentLen = 0;
        physicalIndex += 1;
        continue;
      }
      current.push(nextWord);
      currentLen += added;
      cursor += 1;
    }
    sections.push({
      physicalIndex,
      page: {
        ...page,
        bodyChunk: current.join(' '),
        showSignature: true,
      },
    });
    return sections;
  }

  function proposalSectionPageCount(page, theme = proposals[activeProposalIndex]?.theme || 'margin', proposal = proposals?.[activeProposalIndex]){
    if (!page) return 1;
    if (page.kind === 'pricing') return proposalSplitPricingSections(page, proposal, theme).length;
    if (page.kind === 'image_text' || page.kind === 'scope') return proposalSplitContentBlocks(page, proposalEditorMode === 'edit', proposal).length;
    if (page.kind === 'fine_print') return proposalSplitFinePrintSections(page, proposal).length;
    return 1;
  }

  function proposalPageEnabled(page){
    return page?.enabled !== false;
  }

  function firstEnabledProposalPageIndex(proposal, fallback = 0){
    const pages = Array.isArray(proposal?.pages) ? proposal.pages : [];
    const found = pages.findIndex(proposalPageEnabled);
    return found >= 0 ? found : Math.max(0, Math.min(fallback, pages.length - 1));
  }

  function normalizeActiveProposalPage(proposal){
    if (!proposal?.pages?.length) {
      activeProposalPageIndex = 0;
      return;
    }
    activeProposalPageIndex = Math.max(0, Math.min(activeProposalPageIndex, proposal.pages.length - 1));
    if (!proposalPageEnabled(proposal.pages[activeProposalPageIndex])) {
      activeProposalPageIndex = firstEnabledProposalPageIndex(proposal, activeProposalPageIndex);
    }
  }

  function proposalRenderSections(proposal, options = {}){
    const sections = [];
    const isEditRender = options.viewMode === 'edit';
    (proposal?.pages || []).forEach((page, logicalIndex) => {
      if (!proposalPageEnabled(page)) return;
      if (page.kind === 'pricing') {
        const chunks = proposalSplitPricingSections(page, proposal, proposal?.theme || 'margin', isEditRender);
        for (let i = 0; i < chunks.length; i += 1) {
          sections.push({
            logicalIndex,
            physicalIndex: i,
            physicalCount: chunks.length,
            page: chunks[i],
          });
        }
        return;
      }
      if (page.kind === 'image_text' || page.kind === 'scope') {
        const blockSections = proposalSplitContentBlocks(page, isEditRender, proposal);
        blockSections.forEach((entry) => {
          sections.push({
            logicalIndex,
            physicalIndex: entry.physicalIndex,
            physicalCount: blockSections.length,
            page: entry.page,
          });
        });
        return;
      }
      if (page.kind === 'fine_print') {
        const textSections = proposalSplitFinePrintSections(page, proposal);
        textSections.forEach((entry) => {
          sections.push({
            logicalIndex,
            physicalIndex: entry.physicalIndex,
            physicalCount: textSections.length,
            page: entry.page,
          });
        });
        return;
      }
      sections.push({ logicalIndex, physicalIndex: 0, physicalCount: 1, page });
    });
    return sections;
  }

  function normalizeProposalNumber(value){
    const cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
    const parts = cleaned.split('.');
    return `${parts[0] || ''}${parts.length > 1 ? '.' + parts.slice(1).join('').replaceAll('.', '') : ''}`;
  }

  function normalizeProposalInteger(value){
    return String(value ?? '').replace(/\D/g, '');
  }

  function proposalCurrencyEditText(value){
    const normalized = normalizeProposalNumber(value);
    return normalized || '0.00';
  }

  function proposalCurrencyDisplay(value){
    const num = Number(normalizeProposalNumber(value || 0) || 0);
    return `$${num.toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function proposalSignedCurrencyDisplay(value){
    const num = Number(value || 0);
    const abs = Math.abs(Number.isFinite(num) ? num : Number(normalizeProposalNumber(value || 0) || 0));
    const text = `$${abs.toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return num < 0 ? `-${text}` : text;
  }

  function proposalPercentValue(value, fallback = 0){
    const text = String(value ?? '').trim();
    const firstNumber = text.match(/\d+(?:\.\d+)?/);
    const number = Number(firstNumber ? firstNumber[0] : normalizeProposalNumber(text));
    return Number.isFinite(number) ? number : fallback;
  }

  function proposalPercentDisplay(value){
    const number = proposalPercentValue(value, 0);
    return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2))).replace(/\.00$/, '');
  }

  function proposalDefaultSettings(){
    const defaults = getBranchPresentationStyle().proposal_defaults || {};
    return defaults && typeof defaults === 'object' ? defaults : {};
  }

  function proposalDefaultSalesTaxPercent(){
    return Math.max(0, proposalPercentValue(proposalDefaultSettings().sales_tax_percent, PROPOSAL_DEFAULT_SALES_TAX_PERCENT));
  }

  function proposalDefaultPaymentSchedule(){
    const configured = Array.isArray(proposalDefaultSettings().payment_schedule) ? proposalDefaultSettings().payment_schedule : [];
    const source = configured.length ? configured : PROPOSAL_DEFAULT_PAYMENT_SCHEDULE;
    return PROPOSAL_PAYMENT_ROWS.map((row, index) => {
      const item = source[index] && typeof source[index] === 'object' ? source[index] : {};
      return {
        ...row,
        label: String(item.label || row.defaultLabel).trim() || row.defaultLabel,
        percent: proposalPercentValue(item.percent, PROPOSAL_DEFAULT_PAYMENT_SCHEDULE[index]?.percent || 0),
        due_rule: String(item.due_rule || item.dueRule || row.due_rule || 'manual').trim() || row.due_rule || 'manual',
      };
    });
  }

  function proposalPaymentPercentSum(page){
    return PROPOSAL_PAYMENT_ROWS.reduce((sum, row) => sum + proposalPercentValue(page?.[row.percentField], 0), 0);
  }

  function proposalPaymentScheduleValid(page){
    return Math.abs(proposalPaymentPercentSum(page) - 100) < 0.01;
  }

  function proposalPaymentScheduleItems(page){
    return PROPOSAL_PAYMENT_ROWS.map((row, index) => ({
      label: String(page?.[row.labelField] || row.defaultLabel).trim() || row.defaultLabel,
      percent: proposalPercentValue(page?.[row.percentField], 0),
      amount: proposalCurrencyDisplay(page?.[row.amountField] || 0),
      amount_cents: Math.round(proposalNumericCurrency(page?.[row.amountField] || 0) * 100),
      due_rule: String(page?.paymentScheduleDueRules?.[index] || row.due_rule || 'manual').trim() || 'manual',
      grace_days: 1
    })).filter((item) => item.amount_cents > 0);
  }

  function syncProposalPaymentScheduleExport(proposal, page){
    if (!proposal || !page || page.kind !== 'signature') return;
    proposal.payment = {
      ...(proposal.payment && typeof proposal.payment === 'object' ? proposal.payment : {}),
      sales_tax_percent: proposalPercentValue(page.taxRatePercent, 0),
      schedule: proposalPaymentScheduleItems(page)
    };
  }

  function proposalStylePreview(theme){
    return `
      <div class="r-proposal-style-mini ${theme}">
        ${theme === 'triangles' ? '<div class="mini-corner"></div>' : ''}
        <div class="mini-lines"><span></span><span class="short"></span><span></span></div>
      </div>
    `;
  }

  function getBranchPresentationStyle(){
    return branchPresentationStyle && typeof branchPresentationStyle === 'object' ? branchPresentationStyle : {};
  }

  function platformTheme(){
    return (window.Portal?.currentTheme && typeof window.Portal.currentTheme === 'object')
      ? window.Portal.currentTheme
      : ((window.__APP?.theme && typeof window.__APP.theme === 'object') ? window.__APP.theme : {});
  }

  function proposalPlatformApiBaseUrl(){
    const configured = String(window.__APP?.platformApiBase || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const host = String(location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return '';
    return `${location.origin}/v1/platform`;
  }

  function proposalMediaUrl(mediaId){
    const id = String(mediaId || '').trim();
    const orgId = String(cfg.userOrgId || cfg.orgId || window.__APP?.userOrgId || '').trim();
    if (!id || !orgId) return '';
    if (window.PlatformAPI?.media?.fileUrl) return window.PlatformAPI.media.fileUrl(orgId, id, 'original');
    const base = proposalPlatformApiBaseUrl();
    return base ? `${base}/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(id)}/file?variant=original` : '';
  }

  function normalizeProposalLogoUrl(value){
    const raw = String(value || '').trim();
    if (!raw || raw === '/images/logo_red.png') return '';
    if (/^(https?:|blob:|data:)/i.test(raw)) return raw;
    if (raw.startsWith('/v1/')) {
      try { return new URL(raw, proposalPlatformApiBaseUrl()).href; } catch(e) { return raw; }
    }
    if (raw.startsWith('/')) return raw;
    if (raw.startsWith('organizations/')) return `${proposalPlatformApiBaseUrl()}/${raw}`;
    return raw;
  }

  function logoFromBrandObject(object){
    const obj = object && typeof object === 'object' ? object : {};
    const branding = obj.branding && typeof obj.branding === 'object' ? obj.branding : {};
    if (branding.logo_media_id) return proposalMediaUrl(branding.logo_media_id);
    if (obj.logo_media_id) return proposalMediaUrl(obj.logo_media_id);
    return normalizeProposalLogoUrl(
      branding.logo_url ||
      branding.logoUrl ||
      branding.logo ||
      branding.companyLogo ||
      branding.brandLogo ||
      obj.companyLogo ||
      obj.logoUrl ||
      obj.logo ||
      obj.brandLogo ||
      obj.orgLogo ||
      ''
    );
  }

  async function loadBranchPresentationStyle(){
    if (!window.Portal.branchModules?.get) return;
    try {
      const doc = await window.Portal.branchModules.get(PRESENTATION_STYLE_MODULE_ID);
      branchPresentationStyle = doc?.data && typeof doc.data === 'object' ? doc.data : {};
      if (proposalsEnabled() && proposals.length && activePreviewTab === 'proposal') {
        renderProposalSection();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      }
    } catch (e) {
      if (Number(e?.status || 0) !== 404) console.warn('Unable to load branch presentation style module', e);
    }
  }

  function getProposalBrandLogo(){
    const style = getBranchPresentationStyle();
    return logoFromBrandObject(style) || normalizeProposalLogoUrl(platformTheme().logo) || logoFromBrandObject(cfg);
  }

  function getProposalBrandName(){
    const style = getBranchPresentationStyle();
    const branding = style.branding && typeof style.branding === 'object' ? style.branding : {};
    return style.companyName || style.orgName || style.brandName || branding.companyName || branding.name || platformTheme().name || cfg.companyName || cfg.orgName || cfg.brandName || 'FirstMate';
  }

  function proposalBrandColorCandidates(){
    return [
      styleColor('branding.colors.primary'),
      styleColor('branding.primary'),
      styleColor('primaryColor'),
      styleColor('brandPrimary'),
      platformTheme().primary,
      platformTheme().accent,
      platformTheme().primaryColor,
      cssThemeColor('--primary'),
      cfg?.branding?.colors?.accent,
      cfg?.branding?.primary,
      cfg?.branding?.colors?.primary,
      cfg.primaryColor,
      cfg.brandPrimary,
      cfg.companyPrimary,
      cfg.brandColor,
      cfg.companyColor,
    ];
  }

  function proposalAccentColorCandidates(){
    return [
      styleColor('branding.colors.secondary'),
      styleColor('secondaryColor'),
      styleColor('brandSecondary'),
      styleColor('accentColor'),
      platformTheme().secondary,
      platformTheme().secondaryColor,
      cssThemeColor('--secondary'),
      cfg?.branding?.colors?.secondary,
      cfg.secondaryColor,
      cfg.brandSecondary,
      cfg.companySecondary,
      cfg.accentColor,
      cfg.companyAccent,
      cfg.brandAccent,
    ];
  }

  function styleColor(path){
    const style = getBranchPresentationStyle();
    return String(path || '').split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, style);
  }

  function cssThemeColor(name){
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    } catch (e) {
      return '';
    }
  }

  function normalizeProposalHexColor(value, fallback){
    const color = String(value || '').trim();
    if (!color) return fallback;
    const short = color.match(/^#([0-9a-f]{3})$/i);
    if (short) {
      const chars = short[1].split('');
      return `#${chars.map((char) => char + char).join('')}`.toLowerCase();
    }
    const full = color.match(/^#([0-9a-f]{6})$/i);
    if (full) return `#${full[1].toLowerCase()}`;
    return fallback;
  }

  function normalizeProposalFontFamily(value, fallback = 'Montserrat'){
    const font = String(value || '').trim();
    return PROPOSAL_FONT_OPTIONS.includes(font) ? font : fallback;
  }

  function proposalFontStack(font){
    return `"${normalizeProposalFontFamily(font).replace(/["\\]/g, '')}",Arial,sans-serif`;
  }

  function normalizeProposalImageRef(value){
    if (!value) return null;
    if (typeof value === 'string') {
      const src = value.trim();
      return src ? { src, thumb: src } : null;
    }
    if (typeof value !== 'object') return null;
    const mediaId = String(value.media_id || value.mediaId || '').trim();
    const orgId = projectOrgId();
    const mediaOriginal = mediaId && orgId && window.PlatformAPI?.media?.fileUrl
      ? window.PlatformAPI.media.fileUrl(orgId, mediaId, 'original')
      : '';
    const mediaThumb = mediaId && orgId && window.PlatformAPI?.media?.thumbnailUrl
      ? window.PlatformAPI.media.thumbnailUrl(orgId, mediaId, 320)
      : '';
    const src = String(value.src || value.url || value.original || value.file_url || mediaOriginal || '').trim();
    const thumb = String(value.thumb || value.thumbnail || value.thumbnail_url || mediaThumb || src).trim();
    if (!src && !thumb && !mediaId) return null;
    return {
      id: String(value.id || value.photo_id || mediaId || src || thumb).trim(),
      media_id: mediaId,
      src,
      thumb: thumb || src,
      alt: String(value.alt || value.label || 'Co-branded logo').trim(),
      label: String(value.label || value.alt || 'Co-branded logo').trim(),
    };
  }

  function hexToRgbString(hex){
    const match = String(hex || '').trim().match(/^#([0-9a-f]{6})$/i);
    if (!match) return '217,48,37';
    const value = match[1];
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ].join(',');
  }

  function getProposalPrimaryColor(){
    const proposal = proposals[activeProposalIndex];
    const value = proposal?.primaryColor || proposal?.brandColors?.primary || proposalBrandColorCandidates().find(Boolean);
    return normalizeProposalHexColor(value, '#d93025');
  }

  function getProposalAccentColor(){
    const proposal = proposals[activeProposalIndex];
    const value = proposal?.secondaryColor || proposal?.accentColor || proposal?.brandColors?.secondary || proposalAccentColorCandidates().find(Boolean);
    return normalizeProposalHexColor(value, '#f3b5b0');
  }

  function getProposalAccentReadableColor(){
    const accent = getProposalAccentColor();
    return accent.toLowerCase() === '#f3b5b0' ? '#b42318' : accent;
  }

  function getProposalFontFamily(proposal = proposals[activeProposalIndex]){
    const defaults = getBranchPresentationStyle().proposal_defaults || {};
    return normalizeProposalFontFamily(
      proposal?.fontFamily ||
      proposal?.font_family ||
      proposal?.typography?.font_family ||
      defaults.font_family ||
      getBranchPresentationStyle().proposal_font_family ||
      getBranchPresentationStyle().font_family ||
      'Montserrat'
    );
  }

  function proposalLogoMarkup(className = '', large = false){
    const logo = getProposalBrandLogo();
    const classes = `r-proposal-page-logoimg${large ? ' large' : ''}${className ? ' ' + className : ''}`;
    if (logo) return `<img src="${escapeHtml(logo)}" alt="${escapeHtml(getProposalBrandName())}" class="${classes}">`;
    return `<div class="r-proposal-page-logo ${className}">${escapeHtml(getProposalBrandName())}</div>`;
  }

  function proposalCoBrandLogo(proposal = proposals[activeProposalIndex]){
    return normalizeProposalImageRef(proposal?.coBrandLogo || proposal?.co_brand_logo || proposal?.cobrand_logo || proposal?.cobrandLogo);
  }

  function proposalImageFallbackAttrs(primaryUrl = '', fallbackUrl = ''){
    const primary = String(primaryUrl || '').trim();
    const fallback = String(fallbackUrl || '').trim();
    if (!fallback || fallback === primary) {
      return ` onerror="this.closest('.r-proposal-cobrand')?.classList.add('load-failed')"`;
    }
    return ` data-fallback-src="${escapeHtml(fallback)}" onerror="if(this.dataset.fallbackSrc&&this.src!==this.dataset.fallbackSrc){this.src=this.dataset.fallbackSrc;this.removeAttribute('data-fallback-src')}else{this.closest('.r-proposal-cobrand')?.classList.add('load-failed')}"`;
  }

  function proposalCoBrandMarkup(mode = 'preview'){
    const isEdit = mode === 'edit';
    const logo = proposalCoBrandLogo();
    if (logo) {
      const primary = logo.src || logo.thumb;
      const fallback = logo.thumb && logo.thumb !== primary ? logo.thumb : '';
      return `<span class="r-proposal-cobrand${String(isEdit ? ' editable' : '')}" ${String(isEdit ? 'data-proposal-cobrand-pick="true" data-fm-tooltip="Change co-brand logo"' : '')}><img src="${String(escapeHtml(primary))}" alt="${String(escapeHtml(logo.alt || 'Co-branded logo'))}"${String(proposalImageFallbackAttrs(primary, fallback))}><span class="r-proposal-cobrand-error">${(globalThis.PlatformLanguage?.htmlText("proposals","m_66ebc4c46751c1","Logo unavailable") ?? "Logo unavailable")}</span>${String(isEdit ? `<button type="button" class="r-proposal-cobrand-remove" data-proposal-cobrand-remove="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_700473b6840e61","Remove co-brand logo") ?? "Remove co-brand logo")}"><i class="fas fa-times"></i></button>` : '')}</span>`;
    }
    return isEdit ? `<button type="button" class="r-proposal-cobrand-add" data-proposal-cobrand-pick="true" data-fm-tooltip="Add co-brand logo" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_11859195a90244","Add co-brand logo") ?? "Add co-brand logo")}"><i class="fas fa-plus"></i></button>` : '';
  }

  function proposalBrandLockup(theme = 'margin', mode = 'preview', large = false){
    return `<div class="r-proposal-brand-lockup ${theme === 'triangles' ? 'triangles' : ''}">${proposalLogoMarkup('', large)}${proposalCoBrandMarkup(mode)}</div>`;
  }

  function normalizeProposalBrandingMediaItem(item, index = 0){
    const orgId = projectOrgId();
    if (window.PlatformAPI?.brandingMedia?.imageRef && orgId && (item?.id || item?.media_id)) {
      return window.PlatformAPI.brandingMedia.imageRef(orgId, item, {
        label: item?.metadata?.label || item?.file_name || `Branding image ${index + 1}`
      });
    }
    return normalizeProposalImageRef({
      ...item,
      id: item?.id || item?.media_id || item?.src || item?.url,
      media_id: item?.media_id || item?.id,
      src: item?.src || item?.url || '',
      thumb: item?.thumb || item?.thumbnail || item?.url || item?.src || '',
      label: item?.label || item?.metadata?.label || item?.file_name || `Branding image ${index + 1}`,
      alt: item?.alt || item?.metadata?.label || item?.file_name || `Branding image ${index + 1}`
    });
  }

  async function loadProposalBrandingMedia({ force = false } = {}){
    const orgId = projectOrgId();
    if (!orgId || !window.PlatformAPI?.brandingMedia?.list) return proposalBrandingMedia;
    if (proposalBrandingMediaLoaded && !force) return proposalBrandingMedia;
    try {
      const result = await window.PlatformAPI.brandingMedia.list(orgId, { imageOnly: true });
      proposalBrandingMedia = (Array.isArray(result?.media) ? result.media : [])
        .map(normalizeProposalBrandingMediaItem)
        .filter((item) => item?.src || item?.thumb || item?.media_id);
      proposalBrandingMediaLoaded = true;
    } catch (error) {
      console.warn('Unable to load branding media', error);
    }
    return proposalBrandingMedia;
  }

  async function uploadProposalBrandingFiles(fileList, purpose = 'co_brand_logo'){
    const files = [...(fileList || [])].filter((file) => file && String(file.type || '').toLowerCase().startsWith('image/'));
    if (!files.length) return [];
    if (!(await ensurePhotoStorageCapacity(files))) return [];
    const orgId = projectOrgId();
    if (!orgId || !window.PlatformAPI?.brandingMedia?.upload) return files.map((file, index) => normalizeProposalImageRef(normalizePhoto(file, index))).filter(Boolean);
    const added = [];
    for (const file of files) {
      try {
        const upload = await window.PlatformAPI.brandingMedia.upload(orgId, file, {
          slot: purpose,
          purpose,
          thumbnails: true,
          compression: { quality: 0.92, max_width: 2400, max_height: 2400 },
          metadata: {
            label: file.name || 'Branding image',
            source: 'proposal_branding_picker'
          }
        });
        const item = upload?.media;
        const ref = normalizeProposalBrandingMediaItem(item, proposalBrandingMedia.length + added.length);
        if (ref) added.push(ref);
      } catch (error) {
        console.warn('Branding media upload failed', error);
      }
    }
    if (added.length) {
      proposalBrandingMedia = [...added, ...proposalBrandingMedia.filter((item) => !added.some((next) => projectPhotoId(next) === projectPhotoId(item)))];
      proposalBrandingMediaLoaded = true;
    }
    return added;
  }

  function createProposalPageId(){
    return `pp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function ensureProposalPageIds(proposal){
    if (!proposal?.pages) return;
    proposal.pages.forEach((page) => {
      if (!page.id) page.id = createProposalPageId();
      if (page.kind === 'cover') {
        const contacts = proposal.contacts || collectContacts();
        page.preparedFor = typeof page.preparedFor !== 'string' || proposalPreparedForShouldRefresh(page.preparedFor, contacts)
          ? proposalPreparedForText(contacts)
          : normalizeProposalPlainText(page.preparedFor);
      }
    });
  }

  function cloneMarkupState(markup){
    return JSON.parse(JSON.stringify(markup || { pages: {}, history: [], historyIndex: -1 }));
  }

  function ensureProposalMarkup(proposal){
    if (!proposal) return null;
    ensureProposalPageIds(proposal);
    normalizeActiveProposalPage(proposal);
    if (!proposal.markup || typeof proposal.markup !== 'object') {
      proposal.markup = { pages: {}, history: [], historyIndex: -1 };
    }
    proposal.markup.pages ||= {};
    proposal.pages.forEach((page) => {
      proposal.markup.pages[page.id] ||= [];
    });
    if (!Array.isArray(proposal.markup.history)) proposal.markup.history = [];
    if (!Number.isInteger(proposal.markup.historyIndex)) proposal.markup.historyIndex = -1;
    if (!proposal.markup.history.length) {
      proposal.markup.history = [cloneMarkupState({ pages: proposal.markup.pages })];
      proposal.markup.historyIndex = 0;
    }
    return proposal.markup;
  }

  function getPageMarkupItems(proposal, page){
    const markup = ensureProposalMarkup(proposal);
    return markup?.pages?.[page?.id] || [];
  }

  function pushProposalMarkupHistory(proposal){
    const markup = ensureProposalMarkup(proposal);
    if (!markup) return;
    markup.history = markup.history.slice(0, markup.historyIndex + 1);
    markup.history.push(cloneMarkupState({ pages: markup.pages }));
    if (markup.history.length > 60) markup.history.shift();
    markup.historyIndex = markup.history.length - 1;
  }

  function restoreProposalMarkupHistory(proposal, nextIndex){
    const markup = ensureProposalMarkup(proposal);
    if (!markup || nextIndex < 0 || nextIndex >= markup.history.length) return false;
    const snapshot = cloneMarkupState(markup.history[nextIndex]);
    markup.pages = snapshot.pages || {};
    proposal.pages.forEach((page) => {
      markup.pages[page.id] ||= [];
    });
    markup.historyIndex = nextIndex;
    return true;
  }

  function proposalMarkupSvgPath(points){
    if (!points?.length) return '';
    return points.map((point, index) => `${index ? 'L' : 'M'} ${(point.x * 100).toFixed(3)} ${(point.y * 100).toFixed(3)}`).join(' ');
  }

  function proposalMarkupSizeLabel(size = proposalMarkupStrokeSize){
    return `${Number(size).toFixed(1)}x`;
  }

  function getProposalFieldStyles(page, fieldPath){
    const styles = page?.fieldStyles?.[fieldPath];
    const defaultTextAlign = /^blocks\.\d+\.text$/.test(fieldPath || '') && ['image_text', 'scope'].includes(page?.kind) ? 'center' : '';
    const defaultVAlign = /^blocks\.\d+\.text$/.test(fieldPath || '') && ['image_text', 'scope'].includes(page?.kind) ? 'center' : '';
    return {
      textAlign: styles?.textAlign || defaultTextAlign,
      verticalAlign: styles?.verticalAlign || defaultVAlign,
      color: normalizeProposalHexColor(styles?.color || '', ''),
    };
  }

  function setProposalFieldStyles(page, fieldPath, patch){
    if (!page || !fieldPath) return;
    page.fieldStyles ||= {};
    const current = getProposalFieldStyles(page, fieldPath);
    page.fieldStyles[fieldPath] = {
      ...current,
      ...patch,
    };
  }

  function sanitizeProposalRichHtml(value){
    if (!value) return '';
    const template = document.createElement('template');
    template.innerHTML = String(value);
    const allowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'DIV', 'P', 'SPAN', 'UL', 'OL', 'LI', 'FONT']);
    const allowedCss = new Set(['color', 'text-align']);
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!allowedTags.has(child.tagName)) {
            child.replaceWith(...Array.from(child.childNodes));
            return;
          }
          Array.from(child.attributes).forEach((attr) => {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
              child.removeAttribute(attr.name);
              return;
            }
            if (name === 'style') {
              const nextStyle = attr.value.split(';').map((part) => part.trim()).filter(Boolean).filter((part) => allowedCss.has(part.split(':')[0].trim().toLowerCase()));
              if (nextStyle.length) child.setAttribute('style', nextStyle.join('; '));
              else child.removeAttribute('style');
              return;
            }
            if (child.tagName === 'FONT' && name === 'color') return;
            if (name !== 'href') child.removeAttribute(attr.name);
          });
          if (child.tagName === 'FONT') {
            const span = document.createElement('span');
            const color = normalizeProposalHexColor(child.getAttribute('color') || '', '');
            if (color) span.style.color = color;
            span.innerHTML = child.innerHTML;
            child.replaceWith(span);
            walk(span);
            return;
          }
          walk(child);
        } else if (child.nodeType === Node.COMMENT_NODE) {
          child.remove();
        }
      });
    };
    walk(template.content);
    return template.innerHTML;
  }

  function proposalMarkupCursorSvg(tool = proposalMarkupTool){
    const color = encodeURIComponent(proposalMarkupStrokeColor);
    const radius = Math.max(5, Math.round(proposalMarkupStrokeSize * 2.6));
    if (tool === 'eraser') {
      const dash = Math.max(2, Math.round(radius / 2));
      const size = radius * 2 + 8;
      const center = Math.round(size / 2);
      return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'%3E%3Ccircle cx='${center}' cy='${center}' r='${radius}' fill='none' stroke='%23111827' stroke-width='1.5' stroke-dasharray='${dash} ${dash}'/%3E%3C/svg%3E") ${center} ${center}, cell`;
    }
    const size = radius * 2 + 10;
    const center = Math.round(size / 2);
    return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'%3E%3Ccircle cx='${center}' cy='${center}' r='${radius}' fill='${color}' fill-opacity='.18' stroke='${color}' stroke-width='1.5'/%3E%3C/svg%3E") ${center} ${center}, crosshair`;
  }

  function pointToPercent(point){
    return {
      x: `${(point.x * 100).toFixed(3)}%`,
      y: `${(point.y * 100).toFixed(3)}%`,
    };
  }

  function distanceToSegment(point, start, end){
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (!dx && !dy) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / ((dx * dx) + (dy * dy))));
    const proj = { x: start.x + dx * t, y: start.y + dy * t };
    return Math.hypot(point.x - proj.x, point.y - proj.y);
  }

  function splitStrokeByErase(points, point, radius){
    const segments = [];
    let current = [];
    (points || []).forEach((strokePoint) => {
      const hit = Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= radius;
      if (hit) {
        if (current.length > 1) segments.push(current);
        current = [];
        return;
      }
      current.push(strokePoint);
    });
    if (current.length > 1) segments.push(current);
    return segments;
  }

  function currentProposalPage(){
    return proposals[activeProposalIndex]?.pages?.[activeProposalPageIndex] || null;
  }

  function findNearestMarkupItem(items, point){
    let best = null;
    items.forEach((item, index) => {
      let score = Infinity;
      if (item.type === 'text') {
        score = Math.hypot((item.x || 0) - point.x, (item.y || 0) - point.y);
      } else if (item.type === 'stroke') {
        score = (item.points || []).reduce((min, strokePoint) => Math.min(min, Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y)), Infinity);
      } else if (item.type === 'arrow') {
        score = distanceToSegment(point, { x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
      }
      if (score < (best?.score ?? Infinity)) best = { index, score };
    });
    return best && best.score <= 0.035 ? best.index : -1;
  }

  function proposalArrowGeometry(item){
    const x1 = Number(item?.x1 || 0);
    const y1 = Number(item?.y1 || 0);
    const x2 = Number(item?.x2 || 0);
    const y2 = Number(item?.y2 || 0);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 0.0001;
    const ux = dx / length;
    const uy = dy / length;
    const headLength = Math.max(0.018, Math.min(0.11, length * 0.28));
    const headSpread = headLength * 0.72;
    const tipX = x2 + (ux * headLength * 0.2);
    const tipY = y2 + (uy * headLength * 0.2);
    const backX = tipX - (ux * headLength);
    const backY = tipY - (uy * headLength);
    const leftX = backX + (-uy * headSpread);
    const leftY = backY + (ux * headSpread);
    const rightX = backX - (-uy * headSpread);
    const rightY = backY - (ux * headSpread);
    return {
      shaft: { x1, y1, x2: tipX, y2: tipY },
      left: { x1: tipX, y1: tipY, x2: leftX, y2: leftY },
      right: { x1: tipX, y1: tipY, x2: rightX, y2: rightY },
    };
  }

  function proposalMarkupHtml(proposal, page){
    const items = getPageMarkupItems(proposal, page);
    return `
      <div class="r-proposal-page-markup" data-markup-page-id="${page.id}">
        <div class="r-proposal-page-markup-surface">
          <svg class="r-proposal-page-markup-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            ${items.filter((item) => item.type === 'stroke').map((item) => `<path class="r-proposal-page-markup-path" d="${proposalMarkupSvgPath(item.points)}" style="stroke:${escapeHtml(item.color || '#111111')};stroke-width:${escapeHtml(String(item.size || 2.2))}"></path>`).join('')}
            ${items.filter((item) => item.type === 'arrow').map((item) => {
              const geom = proposalArrowGeometry(item);
              const style = `stroke:${escapeHtml(item.color || '#111111')};stroke-width:${escapeHtml(String(item.size || 2.2))}`;
              return `
                <line class="r-proposal-page-markup-arrow" data-markup-arrow-id="${escapeHtml(item.id)}" data-arrow-part="shaft" x1="${(geom.shaft.x1 * 100).toFixed(3)}" y1="${(geom.shaft.y1 * 100).toFixed(3)}" x2="${(geom.shaft.x2 * 100).toFixed(3)}" y2="${(geom.shaft.y2 * 100).toFixed(3)}" style="${style}"></line>
                <line class="r-proposal-page-markup-arrow" data-markup-arrow-id="${escapeHtml(item.id)}" data-arrow-part="left" x1="${(geom.left.x1 * 100).toFixed(3)}" y1="${(geom.left.y1 * 100).toFixed(3)}" x2="${(geom.left.x2 * 100).toFixed(3)}" y2="${(geom.left.y2 * 100).toFixed(3)}" style="${style}"></line>
                <line class="r-proposal-page-markup-arrow" data-markup-arrow-id="${escapeHtml(item.id)}" data-arrow-part="right" x1="${(geom.right.x1 * 100).toFixed(3)}" y1="${(geom.right.y1 * 100).toFixed(3)}" x2="${(geom.right.x2 * 100).toFixed(3)}" y2="${(geom.right.y2 * 100).toFixed(3)}" style="${style}"></line>
              `;
            }).join('')}
          </svg>
          ${items.filter((item) => item.type === 'text').map((item) => `
            <div class="r-proposal-page-markup-text" data-markup-text-id="${escapeHtml(item.id)}" style="left:${(item.x * 100).toFixed(3)}%;top:${(item.y * 100).toFixed(3)}%;color:${escapeHtml(item.color || '#111111')}">${escapeHtml(item.text || '')}</div>
          `).join('')}
          ${proposalMarkupMode ? items.filter((item) => item.type === 'text').map((item) => `
            <button type="button" class="r-proposal-page-markup-delete" data-markup-delete-id="${escapeHtml(item.id)}" style="left:calc(${(item.x * 100).toFixed(3)}% + 88px);top:calc(${(item.y * 100).toFixed(3)}% - 10px)"><i class="fas fa-times"></i></button>
          `).join('') : ''}
          ${proposalMarkupMode ? items.filter((item) => item.type === 'arrow').map((item) => `
            <button type="button" class="r-proposal-page-markup-delete" data-markup-delete-id="${escapeHtml(item.id)}" style="left:${(((item.x1 + item.x2) / 2) * 100).toFixed(3)}%;top:${(((item.y1 + item.y2) / 2) * 100).toFixed(3)}%"><i class="fas fa-times"></i></button>
          `).join('') : ''}
          ${proposalMarkupMode ? items.filter((item) => item.type === 'arrow').map((item) => `
            <div class="r-proposal-page-markup-handle" data-markup-handle-id="${escapeHtml(item.id)}" data-markup-handle-kind="arrow-start" style="left:${(item.x1 * 100).toFixed(3)}%;top:${(item.y1 * 100).toFixed(3)}%"></div>
            <div class="r-proposal-page-markup-handle" data-markup-handle-id="${escapeHtml(item.id)}" data-markup-handle-kind="arrow-end" style="left:${(item.x2 * 100).toFixed(3)}%;top:${(item.y2 * 100).toFixed(3)}%"></div>
          `).join('') : ''}
          ${proposalMarkupMode ? items.filter((item) => item.type === 'text').map((item) => `
            <div class="r-proposal-page-markup-handle" data-markup-handle-id="${escapeHtml(item.id)}" data-markup-handle-kind="text" style="left:${(item.x * 100).toFixed(3)}%;top:${(item.y * 100).toFixed(3)}%"></div>
          `).join('') : ''}
        </div>
      </div>
    `;
  }

  function createProposalPage(template, proposal){
    const notes = proposal?.notes || 'Included';
    const imageTextPage = (title = 'Image & Text') => ({
      id: createProposalPageId(),
      kind: 'image_text',
      title,
      kicker: 'Image & Text',
      blocks: [defaultImageTextBlock()],
    });
    if (template === 'cover') {
      const address = proposal?.address || 'Project Address';
      const preparedFor = proposalPreparedForText(proposal?.contacts || []);
      return {
        id: createProposalPageId(),
        kind: 'cover',
        title: (globalThis.PlatformLanguage?.text("proposals","m_beb8a8d9234a67","Section Cover") ?? "Section Cover"),
        kicker: '',
        heading: address,
        preparedFor,
        preparedBy: proposalPreparedByText(),
        date: new Date().toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month:'long', day:'numeric', year:'numeric' }),
        coverImageEnabled: true,
        coverImageIds: proposalCoverImages(proposal).map((image) => projectPhotoId(image)),
        coverImageWidth: PROPOSAL_COVER_DEFAULT_SIZE,
        coverImageHeight: PROPOSAL_COVER_DEFAULT_SIZE,
        coverImageZoom: 1,
        coverImagePanX: 0,
        coverImagePanY: 0,
      };
    }
    if (template === 'pricing') {
      return {
        id: createProposalPageId(),
        kind: 'pricing',
          title: (globalThis.PlatformLanguage?.text("proposals","m_d87a18f6ea7ea3","Estimate") ?? "Estimate"),
        kicker: 'Pricing',
        scope_view: {
          root_item_id: 'root',
          render_depth: 12,
          show_included_items: true,
          show_unselected_options: false
        },
        notes,
        total: proposalCurrencyDisplay(0),
      };
    }
    if (template === 'marketing') {
      const asset = getOrganizationMarketingPages()[0];
      return {
        id: createProposalPageId(),
        kind: 'marketing',
        title: asset?.title || (globalThis.PlatformLanguage?.text("proposals","m_f8e8c0748ca369","Marketing Page") ?? "Marketing Page"),
        kicker: 'Marketing',
        assetId: asset?.id || '',
      };
    }
    if (template === 'measurement_insert') {
      const asset = proposalMeasurementInsertAssets()[0];
      return {
        id: createProposalPageId(),
        kind: 'measurement_insert',
        title: (globalThis.PlatformLanguage?.text("proposals","m_8bd65d84aabcd5","FirstMeasure") ?? "FirstMeasure"),
        kicker: 'Measurements',
        assetId: asset?.id || '',
        measurementSource: asset?.source || 'report',
        measurementPage: asset?.page || 1,
      };
    }
    if (['image', 'text', 'image_text', 'summary', 'details', 'scope'].includes(template)) return imageTextPage('Image & Text');
    if (template === 'signature') {
      const customer = proposalCustomerPrimaryContact(proposal);
      const schedule = proposalDefaultPaymentSchedule();
      return {
        id: createProposalPageId(),
        kind: 'signature',
        title: (globalThis.PlatformLanguage?.text("proposals","m_23bdcfd5ce7509","Authorization") ?? "Authorization"),
        kicker: 'Signature',
        summary: 'Please review and sign where indicated to approve this proposal.',
        customerSignatureLabel: 'Customer Signature',
        customerPrintedNameLabel: 'Customer Printed Name',
        customerPrintedNameValue: customer.name || 'Customer',
        companySignatureLabel: 'Company Representative Signature',
        companyRepresentativeLabel: 'Company Representative',
        companyRepresentativeValue: proposalPreparedByText(),
        dateLabel: 'Date',
        dateValue: proposalTodayText(),
        pricingSummaryTitle: 'Contract Amount',
        paymentScheduleTitle: 'Payment Schedule',
        requireCompanySignature: true,
        showDate: true,
        showTax: true,
        taxRatePercent: proposalPercentDisplay(proposalDefaultSalesTaxPercent()),
        depositLabel: schedule[0]?.label || 'Deposit',
        depositPercent: proposalPercentDisplay(schedule[0]?.percent || 30),
        depositAmount: '$0.00',
        completionLabel: schedule[1]?.label || 'Progress Payment',
        completionPercent: proposalPercentDisplay(schedule[1]?.percent || 30),
        completionAmount: '$0.00',
        financedLabel: schedule[2]?.label || 'Final Payment',
        financedPercent: proposalPercentDisplay(schedule[2]?.percent || 40),
        financedAmount: '$0.00',
        taxAmount: '$0.00',
        signedSlots: {},
      };
    }
    if (template === 'fine_print') {
      return {
        id: createProposalPageId(),
        kind: 'fine_print',
        title: (globalThis.PlatformLanguage?.text("proposals","m_fd7326e5624473","Terms and Conditions") ?? "Terms and Conditions"),
        kicker: 'Fine Print',
        summary: '',
        body: 'Owner authorizes the contractor to perform the work described in this proposal and to furnish the required labor and materials. Any concealed deck repairs, permit fees, or code-required upgrades discovered after work begins will be documented and approved before additional charges are incurred. Final payment is due according to the agreed schedule once the contracted scope is substantially complete.',
        requireCustomerSignature: true,
        customerSignatureLabel: 'Customer Signature',
        signedSlots: {},
      };
    }
    return {
      id: createProposalPageId(),
      kind: 'image_text',
      title: (globalThis.PlatformLanguage?.text("proposals","m_23783e95fc3139","Image & Text") ?? "Image & Text"),
      kicker: 'Image & Text',
      blocks: [defaultImageTextBlock()],
    };
  }

  function normalizeProposalTemplate(template, index = 0){
    const source = template && typeof template === 'object' ? template : {};
    const validPageTemplates = new Set(['cover', 'pricing', 'marketing', 'measurement_insert', 'image_text', 'signature', 'fine_print']);
    const normalizePageTemplateName = (value) => {
      const name = String(value || 'image_text').trim();
      if (['image', 'text', 'summary', 'details', 'scope'].includes(name)) return 'image_text';
      return validPageTemplates.has(name) ? name : 'image_text';
    };
    const normalizePage = (page) => {
      if (typeof page === 'string') return { template: normalizePageTemplateName(page), enabled: true };
      const pageObject = page && typeof page === 'object' ? page : {};
      const templateName = normalizePageTemplateName(pageObject.template || pageObject.type || pageObject.kind);
      return {
        template: templateName,
        enabled: pageObject.enabled !== false,
      };
    };
    const pages = Array.isArray(source.pages) ? source.pages.map(normalizePage).filter(Boolean) : [];
    return {
      id: String(source.id || `proposal_template_${index}`).trim(),
      name: String(source.name || 'Proposal Template').trim(),
      description: String(source.description || '').trim(),
      theme: PROPOSAL_THEMES[source.theme] ? source.theme : 'margin',
      fontFamily: normalizeProposalFontFamily(source.fontFamily || source.font_family || source.typography?.font_family || '', ''),
      primaryColor: normalizeProposalHexColor(source.primaryColor || source.brandColors?.primary || '', ''),
      secondaryColor: normalizeProposalHexColor(source.secondaryColor || source.accentColor || source.brandColors?.secondary || '', ''),
      coBrandLogo: normalizeProposalImageRef(source.coBrandLogo || source.co_brand_logo || source.cobrandLogo || source.cobrand_logo),
      createdBy: String(source.createdBy || source.created_by || (source.preset ? 'FirstMate' : 'Unknown user')).trim(),
      preset: source.preset === true,
      created_at: source.created_at || source.createdAt || source.used_at || new Date(0).toISOString(),
      used_at: source.used_at || source.usedAt || source.created_at || source.createdAt || '',
      pages: pages.length ? pages : ['cover', 'image_text', 'pricing', 'signature'].map((name) => ({ template: name, enabled: true })),
    };
  }

  function proposalTemplatesCustom(){
    return Array.isArray(branchProposalTemplates?.templates)
      ? branchProposalTemplates.templates.map((template, index) => normalizeProposalTemplate(template, index))
      : [];
  }

  function allProposalTemplates(){
    const templates = [
      ...proposalTemplatesCustom(),
      ...DEFAULT_PROPOSAL_TEMPLATES.map((template, index) => normalizeProposalTemplate(template, index)),
    ];
    return templates.sort((a, b) => {
      const aTime = Date.parse(a.used_at || a.created_at || '') || 0;
      const bTime = Date.parse(b.used_at || b.created_at || '') || 0;
      return bTime - aTime;
    });
  }

  function visibleProposalTemplates(){
    return allProposalTemplates().slice(0, 3);
  }

  function proposalTemplatePageType(page){
    if (!page || typeof page !== 'object') return 'image_text';
    if (page.kind === 'cover') return 'cover';
    if (page.kind === 'pricing') return 'pricing';
    if (page.kind === 'marketing') return 'marketing';
    if (page.kind === 'measurement_insert') return 'measurement_insert';
    if (page.kind === 'image_text') return 'image_text';
    if (page.kind === 'signature') return 'signature';
    if (page.kind === 'fine_print') return 'fine_print';
    if (page.kind === 'scope') return 'image_text';
    return 'image_text';
  }

  function proposalTemplateCreatorName(){
    return String(
      cfg.userName ||
      cfg.userFullName ||
      cfg.userEmail ||
      window.__APP?.userName ||
      window.__APP?.userEmail ||
      'Unknown user'
    ).trim();
  }

  function proposalTemplateSnapshot(proposal, name, description){
    return normalizeProposalTemplate({
      id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      description,
      theme: PROPOSAL_THEMES[proposal?.theme] ? proposal.theme : 'margin',
      fontFamily: getProposalFontFamily(proposal),
      primaryColor: normalizeProposalHexColor(proposal?.primaryColor || proposal?.brandColors?.primary || '', ''),
      secondaryColor: normalizeProposalHexColor(proposal?.secondaryColor || proposal?.accentColor || proposal?.brandColors?.secondary || '', ''),
      coBrandLogo: proposalCoBrandLogo(proposal),
      createdBy: proposalTemplateCreatorName(),
      preset: false,
      created_at: new Date().toISOString(),
      used_at: new Date().toISOString(),
      pages: (proposal?.pages || []).map((page) => ({
        template: proposalTemplatePageType(page),
        enabled: proposalPageEnabled(page),
      })),
    });
  }

  async function loadBranchProposalTemplates(){
    if (!window.Portal.branchModules?.get) return;
    try {
      const doc = await window.Portal.branchModules.get(PROPOSAL_TEMPLATES_MODULE_ID);
      const data = doc?.data && typeof doc.data === 'object' ? doc.data : {};
      branchProposalTemplates = {
        ...(data || {}),
        templates: Array.isArray(data.templates) ? data.templates.map((template, index) => normalizeProposalTemplate(template, index)) : [],
      };
      if (proposalsEnabled() && proposals.length && activePreviewTab === 'proposal') renderProposalSection();
    } catch (e) {
      branchProposalTemplates = { templates: [] };
      if (Number(e?.status || 0) !== 404) console.warn('Unable to load branch proposal templates module', e);
    }
  }

  async function saveBranchProposalTemplates(){
    if (!window.Portal.branchModules?.save) return null;
    return await window.Portal.branchModules.save(
      PROPOSAL_TEMPLATES_MODULE_ID,
      { templates: proposalTemplatesCustom() },
      { kind: 'branch_proposal_templates', source: 'proposal_builder' }
    );
  }

  function applyProposalTemplate(template){
    const proposal = proposals[activeProposalIndex];
    if (!proposal) return;
    const normalized = normalizeProposalTemplate(template);
    proposal.theme = normalized.theme || proposal.theme || 'margin';
    proposal.fontFamily = normalized.fontFamily || getProposalFontFamily(proposal);
    proposal.font_family = proposal.fontFamily;
    proposal.primaryColor = normalized.primaryColor || '';
    proposal.secondaryColor = normalized.secondaryColor || '';
    if (normalized.coBrandLogo) {
      proposal.coBrandLogo = normalized.coBrandLogo;
      proposal.co_brand_logo = normalized.coBrandLogo;
    } else {
      delete proposal.coBrandLogo;
      delete proposal.co_brand_logo;
    }
    proposal.brandColors = {
      ...(proposal.brandColors && typeof proposal.brandColors === 'object' ? proposal.brandColors : {}),
      primary: proposal.primaryColor,
      secondary: proposal.secondaryColor,
    };
    proposal.pages = normalized.pages.map((entry) => {
      const page = createProposalPage(entry.template || 'image_text', proposal);
      page.enabled = entry.enabled !== false;
      if (page.kind === 'pricing') recomputeProposalPricing(page, proposal, { seedScope: true });
      return page;
    });
    if (!proposal.pages.length) proposal.pages = ['cover', 'image_text', 'pricing', 'signature'].map((name) => createProposalPage(name, proposal));
    proposal.markup = { pages: {}, history: [], historyIndex: -1 };
    ensureProposalPageIds(proposal);
    ensureProposalSignatureData(proposal, false);
    proposalSigningMode = false;
    proposalInsertIndex = null;
    proposalDeleteConfirmPageId = null;
    activeProposalPageIndex = firstEnabledProposalPageIndex(proposal, 0);
    const customIndex = proposalTemplatesCustom().findIndex((item) => item.id === normalized.id);
    if (customIndex >= 0) {
      const nextTemplates = proposalTemplatesCustom();
      nextTemplates[customIndex] = { ...nextTemplates[customIndex], used_at: new Date().toISOString() };
      branchProposalTemplates.templates = nextTemplates;
      saveBranchProposalTemplates().catch((error) => console.warn('Unable to update proposal template usage', error));
    }
    renderProposalSection();
    renderProposalPreview();
    queueAutosaveNotice();
    showToast((globalThis.PlatformLanguage?.text("proposals","m_98a22b3cdd029c","Template applied") ?? "Template applied"), normalized.name, true);
  }

  function closeProposalTemplateModal(overlay, handle){
    handle?.unregister?.();
    overlay?.remove?.();
  }

  function openProposalTemplateBrowser(){
    const templates = allProposalTemplates();
    const overlay = document.createElement('div');
    overlay.className = 'r-proposal-template-modal';
    overlay.innerHTML = `
      <div class="r-proposal-template-dialog" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_72e41c1a3890b2","Proposal templates") ?? "Proposal templates")}">
        <div class="r-proposal-template-head">
          <div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_7191381c946a85","Proposal Templates") ?? "Proposal Templates")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_7c770e46b73005","Choose a saved page and style configuration.") ?? "Choose a saved page and style configuration.")}</span></div>
          <button type="button" class="r-proposal-template-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-proposal-template-body">
          ${String(templates.map((template) => `
            <div class="r-proposal-template-list-item">
              <div>
                <strong>${escapeHtml(template.name)}</strong>
                <p>${escapeHtml(template.description || 'No description')}</p>
                <div class="r-proposal-template-meta">${escapeHtml(template.createdBy || 'Unknown user')}${template.preset ? ' • Built-in' : ' • Custom'} • ${escapeHtml(PROPOSAL_THEMES[template.theme]?.label || 'Style')}</div>
              </div>
              <button type="button" class="r-proposal-template-use" data-template-use="${escapeHtml(template.id)}">${(globalThis.PlatformLanguage?.htmlText("proposals","m_fccaa3fc954540","Use") ?? "Use")}</button>
            </div>
          `).join(''))}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const handle = window.Portal?.modals?.register?.(overlay, {
      id: 'proposal-template-browser',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: () => closeProposalTemplateModal(overlay, handle),
    }) || null;
    overlay.querySelector('.r-proposal-template-close')?.addEventListener('click', () => closeProposalTemplateModal(overlay, handle));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeProposalTemplateModal(overlay, handle);
    });
    overlay.querySelectorAll('[data-template-use]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const template = templates.find((item) => item.id === btn.dataset.templateUse);
        if (template) applyProposalTemplate(template);
        closeProposalTemplateModal(overlay, handle);
      });
    });
  }

  function openProposalTemplateCreateModal(){
    const proposal = proposals[activeProposalIndex];
    if (!proposal) return;
    const overlay = document.createElement('div');
    overlay.className = 'r-proposal-template-modal';
    overlay.innerHTML = `
      <div class="r-proposal-template-dialog small" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_e4bc9153ec3019","Save proposal template") ?? "Save proposal template")}">
        <div class="r-proposal-template-head">
          <div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_01f55bbd02d499","Save current settings as new template") ?? "Save current settings as new template")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_18aab175baeae7","Stores the current pages and style for reuse.") ?? "Stores the current pages and style for reuse.")}</span></div>
          <button type="button" class="r-proposal-template-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
        </div>
        <form class="r-proposal-template-form">
          <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_8cf345002184e5","Name") ?? "Name")}<input type="text" name="name" required maxlength="80" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_c4b7cbfdc9b700","Template name") ?? "Template name")}"></label>
          <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_aa136ecb65672f","Description") ?? "Description")}<textarea name="description" rows="3" maxlength="240" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_2c57df25177a8a","When should this template be used?") ?? "When should this template be used?")}"></textarea></label>
          <div class="r-proposal-template-error" aria-live="polite"></div>
          <div class="r-proposal-template-footer">
            <button type="button" class="r-proposal-template-action secondary" data-template-cancel="true">${(globalThis.PlatformLanguage?.htmlText("proposals","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
            <button type="submit" class="r-proposal-template-action primary">${(globalThis.PlatformLanguage?.htmlText("proposals","m_5bab3e72de1ebf","Save") ?? "Save")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    const handle = window.Portal?.modals?.register?.(overlay, {
      id: 'proposal-template-create',
      closeOnEscape: true,
      closeOnBackdrop: true,
      onClose: () => closeProposalTemplateModal(overlay, handle),
    }) || null;
    const close = () => closeProposalTemplateModal(overlay, handle);
    overlay.querySelector('.r-proposal-template-close')?.addEventListener('click', close);
    overlay.querySelector('[data-template-cancel]')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    const nameInput = overlay.querySelector('input[name="name"]');
    requestAnimationFrame(() => nameInput?.focus());
    overlay.querySelector('form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const name = String(new FormData(form).get('name') || '').trim();
      const description = String(new FormData(form).get('description') || '').trim();
      const error = overlay.querySelector('.r-proposal-template-error');
      if (!name) {
        if (error) error.textContent = (globalThis.PlatformLanguage?.text("proposals","m_16790afa26845a","Name is required.") ?? "Name is required.");
        return;
      }
      const template = proposalTemplateSnapshot(proposal, name, description);
      branchProposalTemplates.templates = [template, ...proposalTemplatesCustom().filter((item) => item.id !== template.id)];
      try {
        await saveBranchProposalTemplates();
        renderProposalSection();
        close();
        showToast((globalThis.PlatformLanguage?.text("proposals","m_280361a1d8400b","Template saved") ?? "Template saved"), name, true);
      } catch (saveError) {
        console.warn('Unable to save proposal template', saveError);
        if (error) error.textContent = (globalThis.PlatformLanguage?.text("proposals","m_1c67e4e41eaf70","Could not save this template. Please try again.") ?? "Could not save this template. Please try again.");
      }
    });
  }

  function proposalEditableTag(tag, className, fieldPath, value, options = {}){
    const fieldStyles = options.page && fieldPath ? getProposalFieldStyles(options.page, fieldPath) : { textAlign: '', verticalAlign: '', color: '' };
    const isPreview = !!options.preview;
    const editableValue = options.type === 'currency' && !options.derived && !options.preview
      ? proposalCurrencyEditText(value)
      : value;
    const attrs = [
      `class="r-proposal-editable ${className || ''}${options.derived ? ' is-derived' : ''}${isPreview ? ' is-preview' : ''}${options.rich ? ' is-rich' : ''}"`,
      `data-proposal-field="${fieldPath}"`,
      'spellcheck="false"',
    ];
    if (!options.derived && !isPreview) attrs.push('contenteditable="true"');
    if (options.type) attrs.push(`data-proposal-type="${options.type}"`);
    if (options.type === 'currency' || options.type === 'number') attrs.push('inputmode="decimal"');
    if (options.type === 'integer') attrs.push('inputmode="numeric"');
    if (options.rich) attrs.push('data-proposal-rich="true"');
    if (options.placeholder && !isPreview && !options.derived) attrs.push(`data-proposal-placeholder="${escapeHtml(options.placeholder)}"`);
    if (options.derived) attrs.push('data-proposal-derived="true"');
    if (isPreview) attrs.push('data-proposal-readonly="true"', 'tabindex="-1"');
    else if (!options.derived) attrs.push('tabindex="0"');
    if (options.rich && fieldStyles.textAlign) attrs.push(`data-text-align="${escapeHtml(fieldStyles.textAlign)}"`);
    if (options.rich && fieldStyles.verticalAlign) attrs.push(`data-v-align="${escapeHtml(fieldStyles.verticalAlign)}"`);
    if (options.rich && fieldStyles.color) attrs.push(`style="--proposal-text-color:${escapeHtml(fieldStyles.color)}"`);
    return `<${tag} ${attrs.join(' ')}>${options.rich ? sanitizeProposalRichHtml(editableValue ?? '') : escapeHtml(editableValue ?? '')}</${tag}>`;
  }

  function recomputeProposalPricing(page, proposal = proposals[activeProposalIndex], options = {}){
    if (!page || page.kind !== 'pricing') return;
    const scope = options.seedScope ? ensureProposalScope(proposal, { seed: true }) : normalizeExistingProposalScope(proposal);
    if (scope?.root_items?.length) {
      proposalRefreshDiscountAmounts(proposal);
      page.total = proposalCurrencyDisplay(scope.root_items.reduce((sum, item) => sum + proposalScopeItemTotalCents(item), 0) / 100);
      return;
    }
    page.lineItems = (page.lineItems || []).map((item) => {
      const linked = item.pricebookItemId ? buildLinkedPricebookLineItem(item.pricebookItemId, proposal, item) : null;
      const quantity = linked && !item.manualQuantity
        ? Number(normalizeProposalNumber(linked.quantity || 0) || 0)
        : Number(normalizeProposalNumber(item.quantity || 0) || 0);
      const unitPrice = linked && !item.manualUnitPrice
        ? Number(normalizeProposalNumber(linked.unitPrice || 0) || 0)
        : Number(normalizeProposalNumber(item.unitPrice || 0) || 0);
      return {
        ...item,
        label: linked?.label || item.label,
        unit: linked?.unit || item.unit || '',
        formula: linked?.formula || item.formula || '',
        autoDerived: linked ? !item.manualQuantity : !!item.autoDerived,
        quantity: String(Number(quantity.toFixed(2))),
        unitPrice: proposalCurrencyDisplay(unitPrice),
        amount: proposalCurrencyDisplay(quantity * unitPrice),
      };
    });
    page.total = proposalCurrencyDisplay(page.lineItems.reduce((sum, item) => {
      const amount = Number(normalizeProposalNumber(item.amount || 0) || 0);
      return sum + amount;
    }, 0));
  }

  function proposalLineChoiceSettingsButtonHtml(item, index, proposal){
    if (!item.__scopeItemId || item.__isCategory) return '';
    const enabled = proposalScopeItemHasCustomerChoice(proposal, item);
    if (!enabled) return '';
    return `
      <button type="button" class="r-proposal-choice-settings-btn active" data-proposal-choice-settings="${String(index)}" data-scope-item-id="${String(escapeHtml(item.__scopeItemId))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_d0427160cb4be8","Edit customer choices") ?? "Edit customer choices")}" data-fm-tooltip="Customer choice settings">
        <i class="fas fa-gear"></i>
      </button>
    `;
  }

  function proposalLineChoiceSettingsPopoverHtml(proposal, page = null){
    const state = proposalLineChoicePopoverState;
    if (!state || state.proposalIndex !== activeProposalIndex) return '';
    if (page && page.__renderLogicalIndex !== undefined && Number(page.__renderLogicalIndex) !== Number(state.pageIndex)) return '';
    if (Array.isArray(page?.lineItems) && page.lineItems.length && !page.lineItems.some((row) => String(row?.__scopeItemId || '') === String(state.itemId || ''))) return '';
    const sourcePage = proposal?.pages?.[state.pageIndex];
    const item = findProposalScopeItem(proposal, state.itemId);
    if (!proposal || !sourcePage || !item) return '';
    const ensured = ensureProposalLineChoiceGroup(proposal, item.id);
    const group = proposalScopeChoiceGroup(proposal, ensured);
    const options = group.items.length ? group.items : [ensured];
    const selected = options.find((option) => option.selection?.selected) || options[0];
    const title = proposalChoiceSelectionTitle(group, selected);
    return `
      <div class="r-proposal-choice-backdrop" data-choice-popover-backdrop="true"></div>
      <form class="r-proposal-choice-popover" data-choice-popover="true" data-choice-scope-item="${String(escapeHtml(ensured.id))}" data-choice-page-index="${String(escapeHtml(String(state.pageIndex)))}" role="dialog" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_32d23e5cca90ea","Customer choice settings") ?? "Customer choice settings")}">
        <div class="r-proposal-choice-popover-head">
          <span>
            <strong>${String(escapeHtml(title))}</strong>
            <em>${String(escapeHtml(selected?.display_name || selected?.name || ensured.display_name || ensured.name || 'Selected option'))}</em>
          </span>
          <button type="button" class="r-proposal-choice-close" data-choice-popover-close="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-proposal-choice-help">${(globalThis.PlatformLanguage?.htmlText("proposals","m_2fb8cdedab49ad","Choose which options customers can see and which one is currently selected.") ?? "Choose which options customers can see and which one is currently selected.")}</div>
        <label class="r-proposal-choice-group-title">
          <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_fd63804ea1e590","Choice group title") ?? "Choice group title")}</span>
          <input data-choice-group-title value="${String(escapeHtml(group.title || ''))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_fd63804ea1e590","Choice group title") ?? "Choice group title")}">
        </label>
        <div class="r-proposal-choice-options">
          ${String(options.map((option, optionIndex) => {
            const optionId = String(option.id || '');
            const customerVisible = proposalSelectionAllowsCustomer(option.selection || {}) || option.id === selected.id;
            const logo = proposalChoiceOptionLogo(option);
            return `
              <div class="r-proposal-choice-option${option.id === selected.id ? ' selected' : ''}${customerVisible ? ' customer-visible' : ''}">
                <label class="r-proposal-choice-radio" data-fm-tooltip="Selected option">
                  <input type="radio" name="proposal-choice-selected" value="${escapeHtml(optionId)}" ${option.id === selected.id ? 'checked' : ''}>
                  <span></span>
                </label>
                <div class="r-proposal-choice-fields">
                  <div class="r-proposal-choice-name-row">
                    ${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}
                    <input class="r-proposal-choice-name" data-choice-option-label="${escapeHtml(optionId)}" value="${escapeHtml(option.display_name || option.name || `Option ${optionIndex + 1}`)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_ca125d59fcd810","Option name") ?? "Option name")}">
                  </div>
                  <div class="r-proposal-choice-grid">
                    <label><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_1a29aea570fbc4","Qty") ?? "Qty")}</span><input data-choice-option-quantity="${escapeHtml(optionId)}" value="${escapeHtml(option.quantity || '')}" inputmode="decimal"></label>
                    <label><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_8edfc0dd24bef1","Unit $") ?? "Unit $")}</span><input data-choice-option-price="${escapeHtml(optionId)}" value="${escapeHtml(String(option.unit_price ?? option.unitPrice ?? option.base_price ?? ''))}" inputmode="decimal"></label>
                  </div>
                </div>
                <label class="r-proposal-choice-customer">
                  <input type="checkbox" data-choice-option-customer="${escapeHtml(optionId)}" ${customerVisible ? 'checked' : ''} ${option.id === selected.id ? 'disabled' : ''}>
                  <span class="r-proposal-choice-switch" aria-hidden="true"></span>
                  <em>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ae8e4953e07d70","Customer") ?? "Customer")}</em>
                </label>
                ${options.length > 1 && option.id !== selected.id ? `<button type="button" class="r-proposal-choice-remove" data-choice-option-remove="${escapeHtml(optionId)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_bdf76cad510e9f","Remove option") ?? "Remove option")}"><i class="fas fa-trash"></i><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_4fc60207629a44","Delete") ?? "Delete")}</span></button>` : ''}
              </div>
            `;
          }).join(''))}
        </div>
        <div class="r-proposal-choice-popover-actions">
          <button type="button" class="r-proposal-choice-add" data-choice-option-add="true"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_e7713012500e3b"," Add option") ?? " Add option")}</button>
          <button type="submit" class="r-proposal-choice-save">${(globalThis.PlatformLanguage?.htmlText("proposals","m_5bab3e72de1ebf","Save") ?? "Save")}</button>
        </div>
      </form>
    `;
  }

  function proposalDisableCustomerChoices(proposal, itemId){
    const item = findProposalScopeItem(proposal, itemId);
    if (!item) return;
    const group = proposalScopeChoiceGroup(proposal, item);
    const items = group.items.length ? group.items : [item];
    items.forEach((option) => {
      option.selection = option.selection && typeof option.selection === 'object' ? option.selection : {};
      option.selection.customer_visible = false;
      proposalBuilderSetCustomerSelectable(option.selection, false);
    });
  }

  function proposalToggleLineFeature(proposal, page, itemId, feature){
    const item = findProposalScopeItem(proposal, itemId);
    if (!item) return;
    if (feature === 'included') {
      item.included = item.included !== true;
    } else if (feature === 'disabled') {
      item.disabled = item.disabled !== true;
      item.enabled = item.disabled ? false : true;
      if (item.disabled) proposalLineChoicePopoverState = null;
    } else if (feature === 'description') {
      const next = !proposalScopeItemDescriptionVisible(item);
      item.show_description = next;
      item.showDescription = next;
      if (next && !String(item.description || '').trim()) item.description = 'Description';
    } else if (feature === 'customer_choice') {
      if (proposalScopeItemHasCustomerChoice(proposal, item)) {
        proposalDisableCustomerChoices(proposal, item.id);
        proposalLineChoicePopoverState = null;
      } else {
        ensureProposalLineChoiceGroup(proposal, item.id);
      }
    } else if (feature === 'variations') {
      const next = !proposalScopeItemVariationVisible(item);
      item.show_variations = next;
      item.showVariations = next;
      item.variations_enabled = next;
      item.variationsEnabled = next;
      if (!next) {
        item.variation_editable = false;
        item.variationEditable = false;
        proposalVariationMenuState = null;
      }
    } else if (feature === 'variation_editable') {
      if (!proposalScopeItemVariationVisible(item)) return;
      const next = !proposalScopeItemVariationEditable(item);
      item.variation_editable = next;
      item.variationEditable = next;
    }
    recomputeProposalPricing(page, proposal);
  }

  function proposalLineMoreMenuHtml(item, index, proposal, page){
    if (!item.__scopeItemId) return '';
    const enabled = item.__isDisabled !== true;
    const included = item.__isIncluded === true;
    const hasDescription = proposalScopeItemDescriptionVisible(item);
    const hasCustomerChoice = !item.__isCategory && proposalScopeItemHasCustomerChoice(proposal, item);
    const sourceItem = findProposalScopeItem(proposal, item.__scopeItemId) || item;
    const hasVariations = !item.__isCategory && !item.__isDiscount && proposalScopeItemVariationOptions(sourceItem).length > 0;
    const variationsVisible = hasVariations && proposalScopeItemVariationVisible(sourceItem);
    const variationsEditable = hasVariations && proposalScopeItemVariationEditable(sourceItem);
    const menuOpen = proposalLineMenuState
      && proposalLineMenuState.proposalIndex === activeProposalIndex
      && Number(proposalLineMenuState.pageIndex) === Number(page?.__renderLogicalIndex ?? activeProposalPageIndex)
      && String(proposalLineMenuState.itemId || '') === String(item.__scopeItemId || '');
    const check = (active) => `<span class="r-proposal-line-more-check">${active ? '<i class="fas fa-check"></i>' : ''}</span>`;
    return `
      <div class="r-proposal-line-more-wrap">
        <button type="button" class="r-proposal-line-more-btn${String(menuOpen ? ' active' : '')}" data-proposal-line-menu="${String(index)}" data-scope-item-id="${String(escapeHtml(item.__scopeItemId))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_181a0d84020677","Line item settings") ?? "Line item settings")}" data-fm-tooltip="More settings">...</button>
        ${String(menuOpen ? `
          <div class="r-proposal-line-more-menu" role="menu">
            <button type="button" data-line-feature-toggle="included" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${check(included)}<span>${included ? 'Marked included' : 'Mark included'}</span></button>
            <button type="button" data-line-feature-toggle="disabled" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${check(!enabled)}<span>${enabled ? 'Disable row' : 'Disabled'}</span></button>
            <button type="button" data-line-feature-toggle="description" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${check(hasDescription)}<span>${hasDescription ? 'Show description' : 'Add description'}</span></button>
            ${item.__isCategory ? '' : `<button type="button" data-line-feature-toggle="customer_choice" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${check(hasCustomerChoice)}<span>${hasCustomerChoice ? 'Customer choices on' : 'Enable customer choices'}</span></button>`}
            ${hasVariations ? `<button type="button" data-line-feature-toggle="variations" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${check(variationsVisible)}<span>${variationsVisible ? 'Variations shown' : 'Show variations'}</span></button>` : ''}
            ${hasVariations ? `<button type="button" class="${variationsVisible ? '' : 'is-muted'}" data-line-feature-toggle="variation_editable" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${check(variationsEditable)}<span>${variationsVisible ? (variationsEditable ? 'Variations editable' : 'Variation fixed') : 'Variations hidden'}</span></button>` : ''}
          </div>
        ` : '')}
      </div>
    `;
  }

  function proposalVariationCellHtml(item = {}, index = 0, proposal = null, page = null, isEdit = false){
    if (!item.__variationVisible) return '<div class="r-proposal-variation-cell"></div>';
    const sourceItem = proposal ? findProposalScopeItem(proposal, item.__scopeItemId) : null;
    const options = proposalScopeItemVariationOptions(sourceItem || item);
    const selected = proposalSelectedVariation(sourceItem || item);
    const label = item.__variationLabel || selected?.label || selected?.name || selected?.id || 'Variation';
    const selectedColor = proposalVariationColorValue(selected);
    const menuOpen = proposalVariationMenuState
      && proposalVariationMenuState.proposalIndex === activeProposalIndex
      && Number(proposalVariationMenuState.pageIndex) === Number(page?.__renderLogicalIndex ?? activeProposalPageIndex)
      && String(proposalVariationMenuState.itemId || '') === String(item.__scopeItemId || '');
    const editable = isEdit && item.__variationEditable;
    return `
      <div class="r-proposal-variation-cell${menuOpen ? ' open' : ''}">
        <${editable ? 'button type="button"' : 'div'} class="r-proposal-variation-pill${editable ? '' : ' locked'}" ${editable ? `data-proposal-variation-menu="${index}" data-scope-item-id="${escapeHtml(item.__scopeItemId)}"` : ''}>
          ${selectedColor ? `<em class="r-proposal-variation-swatch" style="--variation-color:${escapeHtml(selectedColor)}"></em>` : ''}
          <span>${escapeHtml(label)}</span>${editable ? '<i class="fas fa-chevron-down"></i>' : ''}
        </${editable ? 'button' : 'div'}>
        ${menuOpen ? `
          <div class="r-proposal-variation-menu" role="menu">
            ${options.map((option) => {
              const optionId = String(option.id || '');
              const active = String(selected?.id || '') === optionId;
              const color = proposalVariationColorValue(option);
              return `<button type="button" data-proposal-variation-select="${escapeHtml(optionId)}" data-scope-item-id="${escapeHtml(item.__scopeItemId)}">${active ? '<i class="fas fa-check"></i>' : '<span></span>'}<span>${color ? `<em class="r-proposal-variation-swatch" style="--variation-color:${escapeHtml(color)}"></em>` : ''}${escapeHtml(option.label || option.name || option.id)}</span></button>`;
            }).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  function proposalChoiceOptionsHtml(item = {}, proposal = null){
    const options = proposalCustomerChoiceOptions(proposal, item);
    if (!options.length) return '';
    const columns = proposalChoiceGridColumnCount(options.length);
    const group = proposalScopeChoiceGroup(proposal, options[0] || item);
    return `
      <div class="r-proposal-choice-grid-row" style="--proposal-depth:${Math.max(0, Number(item.__scopeDepth || 0))};--choice-cols:${columns}" data-choice-group-id="${escapeHtml(group.groupId || '')}" data-choice-group-title="${escapeHtml(group.title || '')}">
        ${options.map((option) => {
          const selected = option.selection?.selected === true;
          const label = option.display_name || option.name || 'Option';
          const description = String(option.description || '').trim();
          const logo = proposalChoiceOptionLogo(option);
          const amount = option.included === true
            ? 'Included'
            : proposalCurrencyDisplay(proposalScopeItemPreviewCents(option) / 100);
          return `
            <div class="r-proposal-choice-mini${selected ? ' selected' : ''}${logo ? ' has-logo' : ''}" role="button" tabindex="0" data-choice-scope-item="${escapeHtml(option.id || '')}" data-choice-group-id="${escapeHtml(group.groupId || '')}">
              ${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(amount)}</strong>
              ${(description || logo) ? `
                <div class="r-proposal-choice-hover">
                  ${logo ? `<img src="${escapeHtml(logo)}" alt="">` : ''}
                  <b>${escapeHtml(label)}</b>
                  ${description ? `<p>${escapeHtml(description)}</p>` : ''}
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function proposalScopedAddActionsHtml(item = {}, page = null){
    if (!item.__scopeItemId || !item.__isCategory) return '';
    const parentId = escapeHtml(item.__scopeItemId);
    const depth = Math.max(0, Number(item.__scopeDepth || 0) + 1);
    return `
      <div class="r-proposal-section-actions" style="--proposal-depth:${String(depth)}">
        <button type="button" data-proposal-add-line-item="true" data-proposal-add-parent="${String(parentId)}"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_c0bcf12c6a1e9c"," Line") ?? " Line")}</button>
        <button type="button" data-proposal-add-section="true" data-proposal-add-parent="${String(parentId)}"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_81f4bc2bd8937b"," Subsection") ?? " Subsection")}</button>
        <button type="button" data-proposal-add-discount="true" data-proposal-add-parent="${String(parentId)}"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a4f54fa12746a6"," Discount") ?? " Discount")}</button>
      </div>
    `;
  }

  function proposalScopedAddActionsAfterRowHtml(lineItems = [], currentIndex = 0, page = null){
    const actionBars = [];
    for (let index = currentIndex; index >= 0; index -= 1) {
      const item = lineItems[index];
      if (!item?.__scopeItemId || !item.__isCategory || index > currentIndex) continue;
      const depth = Math.max(0, Number(item.__scopeDepth || 0));
      let endIndex = index;
      for (let nextIndex = index + 1; nextIndex < lineItems.length; nextIndex += 1) {
        const nextDepth = Math.max(0, Number(lineItems[nextIndex]?.__scopeDepth || 0));
        if (nextDepth <= depth) break;
        endIndex = nextIndex;
      }
      if (endIndex === currentIndex) actionBars.push(proposalScopedAddActionsHtml(item, page));
    }
    return actionBars.join('');
  }

  function proposalGlobalAddActionsHtml(){
    return `
      <div class="r-proposal-addrow-bar">
        <button type="button" class="r-proposal-addrow" data-proposal-add-section="true" data-proposal-add-parent="root"><span><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_e3b4bee808777f"," Add Section") ?? " Add Section")}</span></button>
        <button type="button" class="r-proposal-addrow r-proposal-add-discount" data-proposal-add-discount="true" data-proposal-add-parent="root"><span><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_10fb4e65806d7e"," Discount Section") ?? " Discount Section")}</span></button>
      </div>
    `;
  }

  function proposalDiscountModeControlHtml(item, index){
    const mode = String(item.discount_mode || item.discountMode || 'amount') === 'percent' ? 'percent' : 'amount';
    return ("\n      <div class=\"r-proposal-discount-mode\" role=\"group\" aria-label=\"" + (globalThis.PlatformLanguage?.text("proposals","m_e74253fae77214","Discount type") ?? "Discount type") + "\">\n        <button type=\"button\" class=\"" + String(mode === 'amount' ? 'active' : '') + "\" data-discount-mode-toggle=\"amount\" data-discount-row=\"" + String(index) + "\">$</button>\n        <button type=\"button\" class=\"" + String(mode === 'percent' ? 'active' : '') + "\" data-discount-mode-toggle=\"percent\" data-discount-row=\"" + String(index) + "\">%</button>\n      </div>\n    ");
  }

  function proposalDiscountEditValue(item){
    const mode = String(item.discount_mode || item.discountMode || 'amount') === 'percent' ? 'percent' : 'amount';
    if (mode === 'percent') return proposalPercentDisplay(item.discount_percent ?? item.discountPercent ?? item.quantity ?? 0);
    return proposalCurrencyEditText(item.discount_amount ?? item.discountAmount ?? item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice ?? 0);
  }

  function proposalMediaBlocksMarkup(page, blocks, isEdit, showAddPicker, maybeEditable){
    return `
      <div class="r-proposal-media-stack">
        ${blocks.map((block, index) => {
          const blockType = block.type || 'image_text';
          const hasImage = blockType !== 'text';
          const hasText = blockType !== 'image';
          const images = (block.imageIds || []).map((id) => proposalPhotoById(id)).filter(Boolean);
          const ratioA = Math.max(30, Math.min(70, Number(block.ratio || PROPOSAL_IMAGE_TEXT_DEFAULT.ratio)));
          const ratioB = 100 - ratioA;
          const logicalIndex = block.__logicalBlockIndex ?? index;
          const columns = hasImage && hasText
            ? (block.imageLeft === false ? `${ratioB}fr 14px ${ratioA}fr` : `${ratioA}fr 14px ${ratioB}fr`)
            : '1fr';
          const deleteArmed = proposalDeleteConfirmBlockId === `${page.id}:${block.id || logicalIndex}`;
          return `
            <div class="r-proposal-media-block${hasImage && hasText && block.imageLeft === false ? ' flip' : ''}${blockType === 'image' ? ' image-only' : ''}${blockType === 'text' ? ' text-only' : ''}" data-media-block="${logicalIndex}" style="grid-template-columns:${columns};height:${Math.max(140, Number(block.height || PROPOSAL_IMAGE_TEXT_DEFAULT.height))}px">
              ${isEdit ? `
                <button type="button" class="r-proposal-media-delete${deleteArmed ? ' armed' : ''}" data-media-remove="${logicalIndex}" data-media-remove-id="${escapeHtml(block.id || String(logicalIndex))}" data-fm-tooltip="${deleteArmed ? 'Confirm delete' : 'Delete block'}">${deleteArmed ? 'Delete' : '<i class="fas fa-times"></i>'}</button>
                <div class="r-proposal-media-controls">
                  ${hasImage && hasText ? `<button type="button" class="r-proposal-media-btn icon" data-media-flip="${logicalIndex}" data-fm-tooltip="Flip sides"><i class="fas fa-right-left"></i></button>` : ''}
                </div>
              ` : ''}
              ${hasImage ? `
                <div class="r-proposal-media-visual">
                  <div class="r-proposal-media-pane${images.length ? ' has-image' : ''}${isEdit ? ' is-editable' : ''}" data-media-pick="${logicalIndex}">
                    ${images.length ? `
                      <div class="r-proposal-media-gallery count-${Math.min(images.length, 4)}">
                        ${images.slice(0, 4).map((image, mediaIndex) => proposalMediaVisualHtml(image, `${page.id}:block:${logicalIndex}:${mediaIndex}`)).join('')}
                      </div>
                    ` : (isEdit ? `<div class="r-proposal-media-placeholder">+</div>` : '')}
                  </div>
                </div>
              ` : ''}
              ${hasImage && hasText ? `<div class="r-proposal-media-divider">${isEdit ? `<div class="r-proposal-media-grab" data-media-divider="${logicalIndex}"><i class="fas fa-grip-lines"></i></div>` : ''}</div>` : ''}
              ${hasText ? `
                <div class="r-proposal-media-text">
                  ${maybeEditable('div', 'r-proposal-edit-paragraph', `blocks.${logicalIndex}.text`, block.text || '', { rich: true, placeholder: (globalThis.PlatformLanguage?.htmlText("proposals","m_4cef5c4621cdbb","Add supporting copy here.") ?? "Add supporting copy here.") })}
                </div>
              ` : ''}
              ${isEdit ? `<div class="r-proposal-media-heightgrab" data-media-heightgrab="${logicalIndex}"><i class="fas fa-grip-lines"></i></div>` : ''}
            </div>
          `;
        }).join('')}
        ${showAddPicker ? `
          <div class="r-proposal-media-addpicker">
            <button type="button" class="r-proposal-media-addoption" data-media-add-block="image">
              <i class="fas fa-photo-film"></i>
              <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_49e775f365e4e6","Media") ?? "Media")}</strong>
            </button>
            <button type="button" class="r-proposal-media-addoption" data-media-add-block="text">
              <i class="fas fa-font"></i>
              <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_124287f184b88b","Text") ?? "Text")}</strong>
            </button>
            <button type="button" class="r-proposal-media-addoption" data-media-add-block="image_text">
              <i class="fas fa-table-columns"></i>
              <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_31e604323d895e","Media and Text") ?? "Media and Text")}</strong>
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  function proposalPageMarkup(page, mode){
    const isEdit = mode === 'edit';
    const isSigning = mode === 'signing';
    const maybeEditable = (tag, className, fieldPath, value, options = {}) => proposalEditableTag(tag, className, fieldPath, value, { ...options, page, preview: !isEdit });
    if (page.kind === 'cover') {
      const coverImages = page.coverImageEnabled === false ? [] : proposalCoverImages(page);
      const coverWidth = Math.max(180, Math.min(520, Number(page.coverImageWidth || PROPOSAL_COVER_DEFAULT_SIZE)));
      const coverHeight = Math.max(180, Math.min(520, Number(page.coverImageHeight || PROPOSAL_COVER_DEFAULT_SIZE)));
      const coverZoom = Math.max(1, Math.min(3, Number(page.coverImageZoom || 1)));
      const coverPanX = Number(page.coverImagePanX || 0);
      const coverPanY = Number(page.coverImagePanY || 0);
      const singleCoverIsVideo = coverImages.length === 1 && proposalMediaIsVideo(coverImages[0]);
      return `
        ${String(page.kicker ? `<div class="r-proposal-kicker">${escapeHtml(page.kicker)}</div>` : '')}
        <div class="r-proposal-cover-shell">
          <div class="r-proposal-cover-stage${String(page.coverImageEnabled === false ? ' is-hidden' : '')}" style="width:${String(coverWidth)}px;max-width:100%;height:${String(page.coverImageEnabled === false ? 0 : coverHeight)}px">
            ${String(isEdit ? `
              <div class="r-proposal-cover-toggle-anchor">
              <button type="button" class="r-proposal-media-btn r-proposal-cover-toggle" data-cover-toggle="true">${page.coverImageEnabled === false ? 'Show Cover Image' : 'Hide Cover Image'}</button>
              </div>
            ` : '')}
            <div class="r-proposal-cover-image${String(isEdit ? ' is-editable' : '')}${String(coverImages.length ? '' : ' is-empty')}" data-cover-pick="true" style="${String(page.coverImageEnabled === false ? 'display:none' : '')};width:${String(coverWidth)}px;max-width:100%;height:${String(coverHeight)}px">
              ${String(isEdit && coverImages.length === 1 && !singleCoverIsVideo && page.coverImageEnabled !== false ? `<button type="button" class="r-proposal-media-btn r-proposal-cover-editbtn" data-cover-adjust-toggle="true">${proposalCoverAdjustOpen ? 'Done' : 'Adjust'}</button>` : '')}
              ${String(isEdit && coverImages.length === 1 && !singleCoverIsVideo && page.coverImageEnabled !== false ? `
                <div class="r-proposal-cover-adjust${proposalCoverAdjustOpen ? ' visible' : ''}" id="rProposalCoverAdjust">
                  <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_e847735cf5a416","Zoom") ?? "Zoom")}<input type="range" min="1" max="3" step="0.02" value="${coverZoom}" data-cover-adjust="zoom"></label>
                </div>
              ` : '')}
              ${String(coverImages.length ? `
                <div class="r-proposal-cover-image-grid count-${Math.min(coverImages.length, 4)}">
                  ${coverImages.slice(0, 4).map((image, index) => proposalMediaVisualHtml(image, `${page.id}:cover:${index}`, {
                    style: index === 0 && coverImages.length === 1 && !proposalMediaIsVideo(image) ? `object-position:center center;transform:translate(${coverPanX}px,${coverPanY}px) scale(${coverZoom})` : ''
                  })).join('')}
                </div>
              ` : (isEdit ? `<div class="r-proposal-cover-image-empty">+</div>` : ''))}
              ${String(isEdit ? `<div class="r-proposal-cover-image-badge">${coverImages.length ? 'Edit Cover Media' : 'Add Cover Media'}</div>` : '')}
              ${String(isEdit ? `<div class="r-proposal-cover-widthgrab" data-cover-widthgrab="true"><i class="fas fa-grip-lines"></i></div><div class="r-proposal-cover-heightgrab" data-cover-heightgrab="true"><i class="fas fa-grip-lines"></i></div><div class="r-proposal-cover-cornergrab" data-cover-cornergrab="true"><i class="fas fa-up-right-and-down-left-from-center"></i></div>` : '')}
            </div>
          </div>
        </div>
        ${String(maybeEditable('h2', 'r-proposal-edit-heading', 'heading', page.heading || ''))}
        <div class="r-proposal-meta">
          <div class="r-proposal-meta-card wide"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_61509e0741be13","Prepared For") ?? "Prepared For")}</strong>${String(maybeEditable('div', 'r-proposal-edit-meta multiline', 'preparedFor', page.preparedFor || ''))}</div>
          <div class="r-proposal-meta-card"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_cb120770e6931f","Prepared By") ?? "Prepared By")}</strong>${String(maybeEditable('div', 'r-proposal-edit-meta', 'preparedBy', page.preparedBy || ''))}</div>
          <div class="r-proposal-meta-card"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_2a0b11100c22a4","Date") ?? "Date")}</strong>${String(maybeEditable('div', 'r-proposal-edit-meta', 'date', page.date || ''))}</div>
        </div>
      `;
    }
    if (page.kind === 'scope') {
      const blocks = page.blocks || [];
      return `
        ${page.showIntro === false ? '' : `${maybeEditable('div', 'r-proposal-page-title', 'title', page.title || (globalThis.PlatformLanguage?.text("proposals","m_23783e95fc3139","Image & Text") ?? "Image & Text"))}
        ${maybeEditable('div', 'r-proposal-edit-paragraph', 'summary', page.summary || '', { rich: true })}`}
        ${proposalMediaBlocksMarkup(page, blocks, !!page.allowBlockEditing, isEdit && page.showAddBlock !== false, maybeEditable)}
      `;
    }
    if (page.kind === 'marketing') {
      const assets = getOrganizationMarketingPages();
      const active = assets.find((asset) => asset.id === page.assetId) || assets[0];
      page.assetId ||= active?.id || '';
      return `
        ${proposalFullPageInsertMarkup(page, assets, {
          isEdit,
          emptyTitle: active?.title || (globalThis.PlatformLanguage?.text("proposals","m_f8e8c0748ca369","Marketing Page") ?? "Marketing Page"),
          emptySubtitle: active?.subtitle || 'Choose a marketing insert for this page.'
        })}
      `;
    }
    if (page.kind === 'measurement_insert') {
      const assets = proposalMeasurementInsertAssets();
      const active = assets.find((asset) => asset.id === page.assetId) || assets[0];
      page.assetId ||= active?.id || '';
      return `
        ${proposalFullPageInsertMarkup(page, assets, {
          isEdit,
          emptyTitle: 'FirstMeasure',
          emptySubtitle: assets.length ? 'Choose a page from the customer-facing measurement report.' : 'No customer-facing measurement report is available for this project yet.'
        })}
      `;
    }
    if (page.kind === 'image_text') {
      const blocks = page.blocks || [];
      return `
        ${page.showIntro === false ? '' : maybeEditable('div', 'r-proposal-page-title', 'title', page.title || (globalThis.PlatformLanguage?.text("proposals","m_23783e95fc3139","Image & Text") ?? "Image & Text"))}
        ${proposalMediaBlocksMarkup(page, blocks, !!page.allowBlockEditing, isEdit && page.showAddBlock !== false, maybeEditable)}
      `;
    }
    if (page.kind === 'signature') {
      const customerSignature = proposalSignedSlot(page, 'customerSignature');
      const companySignature = proposalSignedSlot(page, 'companySignature');
      const scheduleInvalid = !proposalPaymentScheduleValid(page);
      const scheduleTotal = proposalPercentDisplay(proposalPaymentPercentSum(page));
      const paymentScheduleRows = PROPOSAL_PAYMENT_ROWS.map((row, rowIndex) => {
        const label = page[row.labelField] || row.defaultLabel;
        const amount = page[row.amountField] || '$0.00';
        if (!isEdit) {
          return `
            <div class="r-proposal-payment-row preview">
              <span class="r-proposal-payment-label">${escapeHtml(label)}</span>
              <span class="r-proposal-payment-amount">${escapeHtml(amount)}</span>
            </div>
          `;
        }
        return `
          <div class="r-proposal-payment-row">
            <span class="r-proposal-payment-percent">${maybeEditable('div', 'r-proposal-edit-percent', `paymentSchedule.${rowIndex}.percent`, page[row.percentField] || '0', { type: 'number' })}<em>%</em></span>
            <span class="r-proposal-payment-label">${maybeEditable('span', 'r-proposal-edit-payment-label', `paymentSchedule.${rowIndex}.label`, label)}</span>
            ${maybeEditable('div', 'r-proposal-edit-rowvalue', `paymentSchedule.${rowIndex}.amount`, amount, { type: 'currency' })}
          </div>
        `;
      }).join('');
      return `
        <div class="r-proposal-page-title">${String(escapeHtml(page.title || (globalThis.PlatformLanguage?.text("proposals","m_23bdcfd5ce7509","Authorization") ?? "Authorization")))}</div>
        ${String(maybeEditable('div', 'r-proposal-edit-paragraph r-proposal-signature-intro', 'summary', page.summary || '', { rich: true }))}
        <div class="r-proposal-signature-stack">
          <div class="r-proposal-signature-grid">
            <div class="r-proposal-signature-left">
              <div class="r-proposal-signature-group">
                <div class="r-proposal-signature-box${String(isSigning ? ' is-signing' : '')}${String(customerSignature ? ' signed' : '')}" data-sign-slot="${String(isSigning ? 'customerSignature' : '')}" data-sign-signer="customer">
                  <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_bbe64fb68b2f9f","Customer Signature") ?? "Customer Signature")}</strong>
                  <div class="r-proposal-signature-value">${String(customerSignature ? proposalRenderSignatureValue(customerSignature) : (isSigning ? `<button type="button" class="r-proposal-signature-tab">${(globalThis.PlatformLanguage?.htmlText("proposals","m_709d4ebff0e0da","Tap to Sign") ?? "Tap to Sign")}</button>` : ''))}</div>
                  <div class="r-proposal-signature-line"></div>
                  <div class="r-proposal-signature-autofill">${String(maybeEditable('div', 'r-proposal-edit-meta', 'customerPrintedNameValue', page.customerPrintedNameValue || 'Customer'))}</div>
                </div>
              </div>
              ${String(page.requireCompanySignature === false ? '' : `
                <div class="r-proposal-signature-group">
                  <div class="r-proposal-signature-box${isSigning ? ' is-signing' : ''}${companySignature ? ' signed' : ''}" data-sign-slot="${isSigning ? 'companySignature' : ''}" data-sign-signer="company">
                    <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9edc96d5f6e438","Company Representative") ?? "Company Representative")}</strong>
                    <div class="r-proposal-signature-value">${companySignature ? proposalRenderSignatureValue(companySignature) : (isSigning ? `<button type="button" class="r-proposal-signature-tab">${(globalThis.PlatformLanguage?.htmlText("proposals","m_709d4ebff0e0da","Tap to Sign") ?? "Tap to Sign")}</button>` : '')}</div>
                    <div class="r-proposal-signature-line"></div>
                    <div class="r-proposal-signature-autofill">${maybeEditable('div', 'r-proposal-edit-meta', 'companyRepresentativeValue', page.companyRepresentativeValue || proposalPreparedByText())}</div>
                  </div>
                </div>
              `)}
              ${String(page.showDate === false ? '' : `
                <div class="r-proposal-signature-group">
                  <div class="r-proposal-signature-box compact">
                    <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_2a0b11100c22a4","Date") ?? "Date")}</strong>
                    <div class="r-proposal-signature-autofill">${maybeEditable('div', 'r-proposal-edit-meta', 'dateValue', page.dateValue || proposalTodayText())}</div>
                  </div>
                </div>
              `)}
              ${String(isEdit ? `
                <div class="r-proposal-signature-options">
                <button type="button" class="r-proposal-signature-option" data-signature-option="require-company"><i class="fas ${page.requireCompanySignature === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.requireCompanySignature === false ? 'No company representative signature required' : 'Require company representative signature'}</button>
                  <button type="button" class="r-proposal-signature-option" data-signature-option="show-date"><i class="fas ${page.showDate === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.showDate === false ? 'Date hidden' : 'Show date'}</button>
                </div>
              ` : '')}
            </div>
            <div class="r-proposal-signature-right">
              <div class="r-proposal-financial-card">
                <div class="r-proposal-financial-head">
                  <strong>${String(escapeHtml(page.pricingSummaryTitle || 'Contract Amount'))}</strong>
                </div>
                <div class="r-proposal-financial-rows">
                  <div class="r-proposal-financial-row"><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_2fc5623e2a7511","Subtotal") ?? "Subtotal")}</span><span>${String(escapeHtml(page.subtotalValue || '$0.00'))}</span></div>
                  ${String(page.showTax === false ? '' : `<div class="r-proposal-financial-row tax"><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ccb84c048a1a17","Sales Tax") ?? "Sales Tax")}</span>${isEdit ? `<span class="r-proposal-tax-rate">${maybeEditable('div', 'r-proposal-edit-percent', 'taxRatePercent', page.taxRatePercent || '0', { type: 'number' })}<em>%</em></span>` : ''}<span>${escapeHtml(page.taxAmount || '$0.00')}</span></div>`)}
                  <div class="r-proposal-financial-row total"><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9403c7637d4905","Total") ?? "Total")}</span><span>${String(escapeHtml(page.totalValue || '$0.00'))}</span></div>
                </div>
              </div>
              <div class="r-proposal-payment-card${String(isEdit && scheduleInvalid ? ' invalid' : '')}">
                <strong>${String(escapeHtml(page.paymentScheduleTitle || 'Payment Schedule'))}</strong>
                ${String(paymentScheduleRows)}
                ${String(isEdit && scheduleInvalid ? `<div class="r-proposal-payment-warning">${((v0) => globalThis.PlatformLanguage?.htmlText("proposals","m_40c4e9e3dc4c0a",`Payment schedule is ${v0}%. It must add up to 100%.`,{v0}) ?? `Payment schedule is ${v0}%. It must add up to 100%.`)(escapeHtml(scheduleTotal))}</div>` : '')}
                ${String(isEdit ? `<div class="r-proposal-payment-options"><button type="button" class="r-proposal-signature-option" data-signature-option="show-tax"><i class="fas ${page.showTax === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.showTax === false ? 'No sales tax' : 'Show sales tax'}</button></div>` : '')}
              </div>
            </div>
          </div>
        </div>
      `;
    }
    if (page.kind === 'fine_print') {
      const customerSignature = proposalSignedSlot(page, 'customerSignature');
      const finePrintBody = page.bodyChunk || page.body || '';
      const finePrintBodyMarkup = page.showSignature === true && finePrintBody === (page.body || '')
        ? maybeEditable('div', 'r-proposal-edit-paragraph r-proposal-fineprint-copy', 'body', finePrintBody, { rich: true })
        : `<div class="r-proposal-editable r-proposal-edit-paragraph r-proposal-fineprint-copy is-preview is-rich">${sanitizeProposalRichHtml(finePrintBody)}</div>`;
      return `
        <div class="r-proposal-page-title">${escapeHtml(page.title || (globalThis.PlatformLanguage?.text("proposals","m_fd7326e5624473","Terms and Conditions") ?? "Terms and Conditions"))}</div>
        <div class="r-proposal-fineprint">
          ${page.summary ? maybeEditable('div', 'r-proposal-edit-paragraph', 'summary', page.summary || '', { rich: true }) : ''}
          ${finePrintBodyMarkup}
          ${page.requireCustomerSignature === false ? `${isEdit ? `<button type="button" class="r-proposal-signature-option" data-fineprint-signature-toggle="true"><i class="fas fa-toggle-off"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_c330f82bee60aa","No signature required") ?? "No signature required")}</button>` : ''}` : `
          ${page.showSignature === false ? '' : `
            <div class="r-proposal-signature-box${String(isSigning ? ' is-signing' : '')}${String(customerSignature ? ' signed' : '')}" data-sign-slot="${String(isSigning ? 'customerSignature' : '')}" data-sign-signer="customer">
              <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_bbe64fb68b2f9f","Customer Signature") ?? "Customer Signature")}</strong>
              ${String(isEdit ? `<button type="button" class="r-proposal-fineprint-toggle" data-fineprint-signature-toggle="true"><i class="fas ${page.requireCustomerSignature === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.requireCustomerSignature === false ? 'No signature required' : 'Signature Required'}</button>` : '')}
              <div class="r-proposal-signature-value">${String(customerSignature ? proposalRenderSignatureValue(customerSignature) : (isSigning ? `<button type="button" class="r-proposal-signature-tab">${(globalThis.PlatformLanguage?.htmlText("proposals","m_709d4ebff0e0da","Tap to Sign") ?? "Tap to Sign")}</button>` : ''))}</div>
              <div class="r-proposal-signature-line"></div>
              <div class="r-proposal-signature-autofill">${String(maybeEditable('div', 'r-proposal-edit-meta', 'customerPrintedNameValue', page.customerPrintedNameValue || proposalCustomerPrimaryContact(proposals[activeProposalIndex]).name || 'Customer'))}</div>
            </div>
          `}
          `}
        </div>
      `;
    }
    const proposal = proposals[activeProposalIndex];
    const lineItems = proposalPricingRowsForPage(page, proposal, { includeDisabledRows: isEdit });
    const pageTotal = proposal?.scope?.root_items?.length
      ? proposalCurrencyDisplay(proposal.scope.root_items.reduce((sum, item) => sum + proposalScopeItemTotalCents(item), 0) / 100)
      : (page.total || '$0.00');
    return `
      <div class="r-proposal-page-title">${escapeHtml(String(page.title || '') === 'Estimated Proposal' ? 'Estimate' : (page.title || (globalThis.PlatformLanguage?.text("proposals","m_d87a18f6ea7ea3","Estimate") ?? "Estimate")))}</div>
      <div class="r-proposal-list">
        <div class="r-proposal-line-items">
          ${lineItems.map((item, index) => `
            <div class="r-proposal-line-item${item.__scopeDepth ? ` depth-${item.__scopeDepth}` : ''}${item.__isCategory ? ' is-category' : ''}${item.__isIncluded ? ' is-included' : ''}${item.__isDisabled ? ' is-disabled' : ''}${item.__isDiscount ? ' is-discount' : ''}${proposalLineMenuState && proposalLineMenuState.proposalIndex === activeProposalIndex && Number(proposalLineMenuState.pageIndex) === Number(page?.__renderLogicalIndex ?? activeProposalPageIndex) && String(proposalLineMenuState.itemId || '') === String(item.__scopeItemId || '') ? ' is-menu-open' : ''}" data-scope-item-id="${escapeHtml(item.__scopeItemId || '')}" style="--proposal-depth:${Math.max(0, Number(item.__scopeDepth || 0))}">
              ${isEdit ? `<button type="button" class="r-proposal-line-delete" data-proposal-delete-line-item="${String(item.__logicalLineItemIndex ?? index)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_68bd9e1480ed7a","Delete line item") ?? "Delete line item")}"><i class="fas fa-times"></i></button>` : ''}
              ${isEdit ? proposalLineMoreMenuHtml(item, index, proposal, page) : ''}
              <div class="r-proposal-line-labelwrap">
                <div class="r-proposal-line-labelrow">
                  ${maybeEditable('div', 'r-proposal-line-label', `lineItems.${item.__logicalLineItemIndex ?? index}.label`, item.label || item.name || '')}
                  ${isEdit ? proposalLineChoiceSettingsButtonHtml(item, index, proposal) : ''}
                </div>
                ${!item.show_description ? '' : maybeEditable('div', 'r-proposal-line-description', `lineItems.${item.__logicalLineItemIndex ?? index}.description`, item.description || '', { rich: false })}
              </div>
              ${proposalVariationCellHtml(item, item.__logicalLineItemIndex ?? index, proposal, page, isEdit)}
              <div class="r-proposal-row-value quantity-cell">${item.__isDiscount && isEdit ? proposalDiscountModeControlHtml(item, item.__logicalLineItemIndex ?? index) : (item.quantity ? maybeEditable('div', 'r-proposal-edit-rowvalue', `lineItems.${item.__logicalLineItemIndex ?? index}.quantity`, item.quantity, { type: 'number' }) : '')}</div>
              <div class="r-proposal-row-value unit-cell">${item.__isDiscount && isEdit ? maybeEditable('div', 'r-proposal-edit-rowvalue r-proposal-discount-value', `lineItems.${item.__logicalLineItemIndex ?? index}.discountValue`, proposalDiscountEditValue(item), { type: 'number' }) : (item.unitPrice ? maybeEditable('div', 'r-proposal-edit-rowvalue', `lineItems.${item.__logicalLineItemIndex ?? index}.unitPrice`, item.unitPrice, { type: 'currency' }) : '')}</div>
              <div class="r-proposal-row-value amount-cell">${item.__isIncluded ? `<span class="r-proposal-included-badge">${(globalThis.PlatformLanguage?.htmlText("proposals","m_f02be43cb91cd2","Included") ?? "Included")}</span>` : proposalEditableTag('div', `r-proposal-edit-rowvalue${item.__isDiscount ? ' r-proposal-discount-amount' : ''}`, `lineItems.${item.__logicalLineItemIndex ?? index}.amount`, item.amount || '$0.00', { derived: true, preview: !isEdit })}</div>
            </div>
            ${proposalChoiceOptionsHtml(item, proposal)}
            ${isEdit ? proposalScopedAddActionsAfterRowHtml(lineItems, index, page) : ''}
          `).join('')}
          ${isEdit && page.showAddRow !== false ? proposalGlobalAddActionsHtml() : ''}
        </div>
      </div>
      ${page.showTotal === false ? '' : `<div class="r-proposal-total${String(page.showTotal ? ' is-final-page-total' : '')}"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9403c7637d4905","Total") ?? "Total")}</strong>${String(proposalEditableTag('div', 'r-proposal-edit-total', 'total', pageTotal, { derived: true, preview: !isEdit }))}</div>`}
    `;
  }

  function setProposalField(proposalIndex, pageIndex, fieldPath, value){
    const proposal = proposals[proposalIndex];
    const page = proposal?.pages?.[pageIndex];
    if (!proposal || !page) return;
    if (fieldPath.startsWith('contacts.')) {
      const [, contactIndexStr, fieldName] = fieldPath.split('.');
      const contactIndex = Number(contactIndexStr);
      page.contacts = proposalContactFallback(page.contacts || []).map((contact) => ({ ...contact }));
      if (!page.contacts[contactIndex]) page.contacts[contactIndex] = { name: '', phone: '', email: '' };
      page.contacts[contactIndex][fieldName] = value;
    } else if (fieldPath.startsWith('lineItems.')) {
      const [, itemIndexStr, fieldName] = fieldPath.split('.');
      const itemIndex = Number(itemIndexStr);
      const scopeRow = proposalPricingRowsForPage(page, proposal, { includeDisabledRows: proposalEditorMode === 'edit' })[itemIndex];
      const scopeItem = scopeRow?.__scopeItemId ? findProposalScopeItem(proposal, scopeRow.__scopeItemId) : null;
      if (scopeItem) {
        if (fieldName === 'quantity') {
          scopeItem.quantity = normalizeProposalNumber(value);
          scopeItem.manualQuantity = true;
        } else if (fieldName === 'unitPrice') {
          const nextPrice = Number(normalizeProposalNumber(value) || 0);
          scopeItem.unit_price = nextPrice;
          scopeItem.base_price = nextPrice;
          scopeItem.manualUnitPrice = true;
        } else if (fieldName === 'amount') {
          return;
        } else if (fieldName === 'label') {
          scopeItem.name = value;
          scopeItem.display_name = value;
        } else if (fieldName === 'discountMode') {
          scopeItem.discount_mode = String(value || 'amount') === 'percent' ? 'percent' : 'amount';
        } else if (fieldName === 'discountValue') {
          if (String(scopeItem.discount_mode || 'amount') === 'percent') {
            scopeItem.discount_percent = normalizeProposalNumber(value);
            scopeItem.quantity = scopeItem.discount_percent;
          } else {
            const nextPrice = Number(normalizeProposalNumber(value) || 0);
            scopeItem.discount_amount = String(nextPrice);
            scopeItem.unit_price = nextPrice;
            scopeItem.base_price = nextPrice;
          }
        } else {
          scopeItem[fieldName] = value;
        }
        recomputeProposalPricing(page, proposal);
        return;
      }
      page.lineItems = (page.lineItems || []).map((item) => ({ ...item }));
      if (!page.lineItems[itemIndex]) page.lineItems[itemIndex] = { label: '', quantity: '0', unitPrice: '$0.00', amount: '$0.00' };
      if (fieldName === 'quantity') {
        page.lineItems[itemIndex][fieldName] = normalizeProposalNumber(value);
        page.lineItems[itemIndex].manualQuantity = true;
      } else if (fieldName === 'unitPrice') {
        page.lineItems[itemIndex][fieldName] = proposalCurrencyDisplay(value);
        page.lineItems[itemIndex].manualUnitPrice = true;
      } else if (fieldName === 'amount') {
        return;
      } else {
        page.lineItems[itemIndex][fieldName] = value;
      }
      recomputeProposalPricing(page, proposal);
    } else if (page.kind === 'signature' && fieldPath.startsWith('paymentSchedule.')) {
      const [, rowIndexStr, fieldName] = fieldPath.split('.');
      const rowIndex = Number(rowIndexStr);
      const row = PROPOSAL_PAYMENT_ROWS[rowIndex];
      if (!row) return;
      if (fieldName === 'label') {
        page[row.labelField] = value;
      } else if (fieldName === 'percent') {
        page[row.percentField] = proposalPercentDisplay(value);
        if (rowIndex < PROPOSAL_PAYMENT_ROWS.length - 1) {
          const first = proposalPercentValue(page.depositPercent, 0);
          const second = proposalPercentValue(page.completionPercent, 0);
          page.financedPercent = proposalPercentDisplay(Math.max(0, 100 - first - second));
        }
      } else if (fieldName === 'amount') {
        const total = proposalNumericCurrency(page.totalValue || 0);
        const amount = proposalNumericCurrency(value || 0);
        page[row.percentField] = proposalPercentDisplay(total > 0 ? (amount / total) * 100 : 0);
        if (rowIndex < PROPOSAL_PAYMENT_ROWS.length - 1) {
          const first = proposalPercentValue(page.depositPercent, 0);
          const second = proposalPercentValue(page.completionPercent, 0);
          page.financedPercent = proposalPercentDisplay(Math.max(0, 100 - first - second));
        }
      }
      ensureProposalSignatureData(proposal, false);
    } else if (fieldPath.startsWith('blocks.')) {
      const [, blockIndexStr, fieldName] = fieldPath.split('.');
      const blockIndex = Number(blockIndexStr);
      page.blocks = (page.blocks || []).map((block) => ({ ...block }));
      if (!page.blocks[blockIndex]) page.blocks[blockIndex] = defaultImageTextBlock();
      page.blocks[blockIndex][fieldName] = value;
    } else {
      if (fieldPath === 'total') return;
      if (page.kind === 'signature' && fieldPath === 'taxRatePercent') {
        page.taxRatePercent = proposalPercentDisplay(value);
        ensureProposalSignatureData(proposal, false);
      } else if (page.kind === 'signature' && fieldPath === 'taxAmount') {
        const subtotal = proposalNumericCurrency(page.subtotalValue || 0);
        const tax = proposalNumericCurrency(value || 0);
        page.taxRatePercent = proposalPercentDisplay(subtotal > 0 ? (tax / subtotal) * 100 : 0);
        ensureProposalSignatureData(proposal, false);
      } else {
        page[fieldPath] = value;
      }
    }
    if (page.kind === 'cover' && fieldPath === 'heading') proposal.title = value || 'Proposal';
    if (page.kind === 'scope' && fieldPath === 'summary') proposal.notes = value;
    if (page.kind === 'pricing') {
      recomputeProposalPricing(page, proposal);
      ensureProposalSignatureData(proposal, false);
    }
    if (page.kind === 'signature') syncProposalPaymentScheduleExport(proposal, page);
    queueAutosaveNotice();
  }

  function proposalMarkupDockHtml(){
    if (window.FirstMateMarkup?.proposalDockHtml) return window.FirstMateMarkup.proposalDockHtml();
    return `
      <div class="r-proposal-markupdock" id="rProposalMarkupDock">
        <button type="button" class="r-proposal-markup-btn" id="rProposalMarkupToggle" data-fm-tooltip="Markup"><i class="fas fa-pen"></i></button>
        <div class="r-proposal-markup-tools">
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupEraser" data-fm-tooltip="Eraser"><i class="fas fa-eraser"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupArrow" data-fm-tooltip="Arrow"><i class="fas fa-arrow-right"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupText" data-fm-tooltip="Text"><i class="fas fa-font"></i></button>
          <div style="position:relative">
            <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupSize" data-fm-tooltip="Size"><span class="r-proposal-markup-tool-size">2.2x</span></button>
            <div class="r-proposal-markup-pop" id="rProposalMarkupSizePop"><div class="r-proposal-markup-slider"><input type="range" min="1.2" max="8" step="0.2"></div></div>
          </div>
          <div style="position:relative">
            <button type="button" class="r-proposal-markup-tool swatch" id="rProposalMarkupColor" data-fm-tooltip="Color"><span class="r-proposal-markup-tool-swatch"></span></button>
            <div class="r-proposal-markup-pop" id="rProposalMarkupColorPop">${window.FirstMateMarkup?.markupColorPaletteHtml ? window.FirstMateMarkup.markupColorPaletteHtml(proposalMarkupStrokeColor) : `<div class="r-proposal-markup-recent empty"></div><div class="r-proposal-markup-colorbox">
              <button type="button" class="r-proposal-markup-color" data-markup-color="#111111" style="background:#111111"></button>
              <button type="button" class="r-proposal-markup-color" data-markup-color="#d93025" style="background:#d93025"></button>
              <button type="button" class="r-proposal-markup-color" data-markup-color="#2563eb" style="background:#2563eb"></button>
              <button type="button" class="r-proposal-markup-color" data-markup-color="#15803d" style="background:#15803d"></button>
              <button type="button" class="r-proposal-markup-color" data-markup-color="#fbbc04" style="background:#fbbc04"></button>
              <label class="r-proposal-markup-color custom"><input type="color" value="#111111"></label>
            </div>`}</div>
          </div>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupUndo" data-fm-tooltip="Undo"><i class="fas fa-undo"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupRedo" data-fm-tooltip="Redo"><i class="fas fa-redo"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupClear" data-fm-tooltip="Clear page"><i class="fas fa-trash"></i></button>
          <button type="button" class="r-proposal-markup-tool" id="rProposalMarkupClose" data-fm-tooltip="Close markup"><i class="fas fa-times"></i></button>
        </div>
      </div>`;
  }

  function closeProposalPhotoPicker(){
    proposalPhotoPicker?.close?.();
    proposalPhotoPicker = null;
    document.getElementById('rProposalPhotoPicker')?.remove();
  }

  function replaceResolvedProposalMedia(event){
    if (!state.mounted) return;
    const detail = event?.detail || {};
    const placeholderId = String(detail.placeholderId || '').trim();
    const mediaId = String(detail.mediaId || projectPhotoId(detail.photo) || '').trim();
    if (!placeholderId || !mediaId || placeholderId === mediaId) return;
    const eventProjectId = String(detail.projectId || '').trim();
    const activeProjectId = String(activeBaseProject?.platform_project_id || activeBaseProject?.base_project_id || activeBaseProject?.project_id || activeBaseProject?.id || '').trim();
    if (eventProjectId && activeProjectId && eventProjectId !== activeProjectId) return;
    const replaceIds = (owner, key) => {
      if (!Array.isArray(owner?.[key]) || !owner[key].includes(placeholderId)) return false;
      owner[key] = owner[key].map((id) => String(id || '').trim() === placeholderId ? mediaId : id);
      return true;
    };
    let changed = false;
    proposals.forEach((proposal) => {
      let proposalChanged = replaceIds(proposal, 'coverImageIds');
      if (String(proposal.coverImage || '').trim() === placeholderId) {
        proposal.coverImage = mediaId;
        proposalChanged = true;
      }
      (proposal.pages || []).forEach((page) => {
        if (replaceIds(page, 'coverImageIds')) proposalChanged = true;
        (page.blocks || []).forEach((block) => {
          if (replaceIds(block, 'imageIds')) proposalChanged = true;
        });
      });
      if (proposalChanged) {
        markProposalLocalMutation(proposal);
        changed = true;
      }
    });
    if (!changed) return;
    if (state.active) {
      const scrollTop = $('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0;
      renderProposalSection();
      renderProposalPreview(scrollTop);
    }
    queueAutosaveNotice();
  }

  function openProposalPhotoPicker(pageIndex, blockIndex, options = {}){
    closeProposalPhotoPicker();
    const mode = options.mode || 'block';
    const proposal = proposals[activeProposalIndex];
    const page = proposal?.pages?.[pageIndex];
    const existing = mode === 'cover'
      ? new Set(page?.coverImageIds || [])
      : new Set(page?.blocks?.[blockIndex]?.imageIds || []);
    if (window.Portal?.PhotoFeed?.openProjectMediaPicker) {
      const projectId = String(activeBaseProject?.platform_project_id || activeBaseProject?.base_project_id || activeBaseProject?.project_id || activeBaseProject?.id || '').trim();
      const picker = window.Portal.PhotoFeed.openProjectMediaPicker({
        id: 'proposal-photo-picker',
        projectId,
        title: mode === 'cover' ? 'Select Cover Media' : 'Select Project Media',
        subtitle: (globalThis.PlatformLanguage?.text("proposals","m_2e3afd86287208","Choose photos or videos from this project, or upload new media.") ?? "Choose photos or videos from this project, or upload new media."),
        photos: projectPhotos,
        getPhotos: () => projectPhotos,
        selectedIds: [...existing],
        multiple: true,
        imageOnly: false,
        onUpload: async (files) => {
          const added = await addPhotoFiles(files) || [];
          return {
            photos: added,
            selectedIds: added.map((photo) => projectPhotoId(photo)).filter(Boolean)
          };
        },
        onConfirm: (chosen, selectedIds) => {
          const proposal = proposals[activeProposalIndex];
          const page = proposal?.pages?.[pageIndex];
          if (!proposal || !page) return;
          const ids = selectedIds?.length ? selectedIds : chosen.map((photo) => projectPhotoId(photo)).filter(Boolean);
          if (mode === 'cover') {
            page.coverImageEnabled = true;
            page.coverImageIds = ids;
            proposal.coverImageIds = [...page.coverImageIds];
          } else {
            if (!['image_text', 'scope'].includes(page.kind)) return;
            page.blocks = (page.blocks || []).map((block) => ({ ...block }));
            page.blocks[blockIndex] ||= defaultImageTextBlock();
            page.blocks[blockIndex].imageIds = ids;
          }
          renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
          queueAutosaveNotice();
        },
        onClose: () => {
          proposalPhotoPicker = null;
        },
      });
      proposalPhotoPicker = picker;
      const photosTab = window.Portal?.modules?.projectPhotosTab || window.Portal?.ProjectPhotosTab || null;
      Promise.resolve(photosTab?.invoke?.('loadOwnedProjectMedia'))
        .then((photos) => {
          if (proposalPhotoPicker === picker && Array.isArray(photos)) picker?.refresh?.(photos);
        })
        .catch(() => null);
      return;
    }
    proposalPhotoPicker = { pageIndex, blockIndex, mode, selected: existing };
    const mount = document.createElement('div');
    mount.id = 'rProposalPhotoPicker';
    mount.className = 'r-proposal-media-pick';
    const selectedCount = () => proposalPhotoPicker?.selected?.size || 0;
    const render = () => {
      const availableMedia = projectPhotos.filter((item) => item && (proposalMediaSource(item) || proposalMediaThumbnail(item)));
      const hasPhotos = !!availableMedia.length;
      mount.innerHTML = `
        <div class="r-proposal-media-pick-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><strong>${String(mode === 'cover' ? 'Select Cover Media' : 'Select Project Media')}</strong><button type="button" class="r-proposal-media-btn" id="rProposalPhotoPickerClose">${(globalThis.PlatformLanguage?.htmlText("proposals","m_3742924668fb10","Close") ?? "Close")}</button></div>
          ${String(hasPhotos ? `
            <div class="r-proposal-media-pick-grid">
              ${availableMedia.map((photo, index) => {
                const photoId = projectPhotoId(photo, String(index));
                const thumbnail = proposalMediaThumbnail(photo);
                const preview = thumbnail
                  ? `<img src="${escapeHtml(thumbnail)}" alt="">`
                  : `<video src="${escapeHtml(proposalMediaSource(photo))}" muted playsinline preload="metadata"></video>`;
                return `<button type="button" class="r-proposal-media-pick-thumb${proposalPhotoPicker.selected.has(photoId) ? ' selected' : ''}" data-proposal-pick-photo="${escapeHtml(photoId)}">${preview}${proposalMediaIsVideo(photo) ? '<span class="r-proposal-media-pick-video"><i class="fas fa-play"></i></span>' : ''}</button>`;
              }).join('')}
            </div>
          ` : `
            <div class="r-photo-empty" id="rProposalPhotoDropZone" style="height:240px">
              <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_72c4eca00405ce","No media uploaded yet") ?? "No media uploaded yet")}</strong>
              <div>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a5e1cd4c41f31c","This project does not have any photos or videos yet.") ?? "This project does not have any photos or videos yet.")}</div>
              <div class="r-photo-empty-tile" id="rProposalPhotoUploadEmpty">
                <div class="r-photo-empty-plus">+</div>
              </div>
            </div>
          `)}
          <div class="r-proposal-media-pick-actions">
            <div><button type="button" class="r-proposal-media-btn" id="rProposalPhotoUploadInline">${(globalThis.PlatformLanguage?.htmlText("proposals","m_e5de0091a812d9","Upload Media") ?? "Upload Media")}</button><input type="file" id="rProposalPhotoUploadInlineInput" accept="image/*,video/*" multiple style="display:none"></div>
            <button type="button" class="r-btn primary" id="rProposalPhotoPickerAdd"${String(hasPhotos ? '' : ' style="display:none"')}>${String(selectedCount() ? `Add ${selectedCount()} item${selectedCount() === 1 ? '' : 's'}` : 'Add media')}</button>
          </div>
        </div>
      `;
      mount.querySelectorAll('[data-proposal-pick-photo]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.proposalPickPhoto;
          if (proposalPhotoPicker.selected.has(id)) proposalPhotoPicker.selected.delete(id);
          else proposalPhotoPicker.selected.add(id);
          render();
        });
      });
      mount.querySelector('#rProposalPhotoPickerClose')?.addEventListener('click', closeProposalPhotoPicker);
      mount.querySelector('#rProposalPhotoUploadEmpty')?.addEventListener('click', () => mount.querySelector('#rProposalPhotoUploadInlineInput')?.click());
      mount.querySelector('#rProposalPhotoUploadInline')?.addEventListener('click', () => mount.querySelector('#rProposalPhotoUploadInlineInput')?.click());
      mount.querySelector('#rProposalPhotoUploadInlineInput')?.addEventListener('change', async (e) => {
        const added = await addPhotoFiles(e.target.files) || [];
        added.forEach((photo) => proposalPhotoPicker.selected.add(projectPhotoId(photo)));
        render();
      });
      ['dragenter', 'dragover'].forEach((name) => {
        mount.querySelector('#rProposalPhotoDropZone')?.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          mount.querySelector('#rProposalPhotoDropZone')?.classList.add('dragover');
        });
      });
      ['dragleave', 'drop'].forEach((name) => {
        mount.querySelector('#rProposalPhotoDropZone')?.addEventListener(name, async (e) => {
          e.preventDefault();
          e.stopPropagation();
          mount.querySelector('#rProposalPhotoDropZone')?.classList.remove('dragover');
          if (name === 'drop') {
            const added = await addPhotoFiles(e.dataTransfer?.files) || [];
            added.forEach((photo) => proposalPhotoPicker.selected.add(projectPhotoId(photo)));
            render();
          }
        });
      });
      mount.querySelector('#rProposalPhotoPickerAdd')?.addEventListener('click', () => {
        const proposal = proposals[activeProposalIndex];
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page) return;
        if (mode === 'cover') {
          page.coverImageEnabled = true;
          page.coverImageIds = [...proposalPhotoPicker.selected];
          proposal.coverImageIds = [...page.coverImageIds];
        } else {
          if (!['image_text', 'scope'].includes(page.kind)) return;
          page.blocks = (page.blocks || []).map((block) => ({ ...block }));
          page.blocks[blockIndex] ||= defaultImageTextBlock();
          page.blocks[blockIndex].imageIds = [...proposalPhotoPicker.selected];
        }
        closeProposalPhotoPicker();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    };
    mount.addEventListener('click', (e) => {
      if (e.target === mount) closeProposalPhotoPicker();
    });
    document.body.appendChild(mount);
    render();
  }

  async function openProposalCoBrandPicker(){
    closeProposalPhotoPicker();
    const proposal = proposals[activeProposalIndex];
    if (!proposal) return;
    const current = proposalCoBrandLogo(proposal);
    let brandingMedia = await loadProposalBrandingMedia();
    if (current && !brandingMedia.some((item) => projectPhotoId(item) === projectPhotoId(current))) {
      brandingMedia = [current, ...brandingMedia];
      proposalBrandingMedia = brandingMedia;
    }
    if (!window.Portal?.PhotoFeed?.openProjectMediaPicker) {
      showToast((globalThis.PlatformLanguage?.text("proposals","m_34b14f07ea63ca","Photo picker unavailable") ?? "Photo picker unavailable"), (globalThis.PlatformLanguage?.text("proposals","m_5b9f832bc9db10","The shared photo library is not loaded yet.") ?? "The shared photo library is not loaded yet."), false);
      return;
    }
    proposalPhotoPicker = window.Portal.PhotoFeed.openProjectMediaPicker({
      id: 'proposal-cobrand-picker',
      title: (globalThis.PlatformLanguage?.text("proposals","m_c8bd33b0986bb6","Select Co-brand Logo") ?? "Select Co-brand Logo"),
      subtitle: (globalThis.PlatformLanguage?.text("proposals","m_0b049fd2c10123","Choose a company branding image or upload a reusable co-brand logo.") ?? "Choose a company branding image or upload a reusable co-brand logo."),
      photos: brandingMedia,
      getPhotos: () => proposalBrandingMedia,
      selectedIds: current ? [projectPhotoId(current)].filter(Boolean) : [],
      multiple: false,
      imageOnly: true,
      onUpload: async (files) => {
        const added = await uploadProposalBrandingFiles(files, 'co_brand_logo') || [];
        return {
          photos: added,
          selectedIds: added.map((photo) => projectPhotoId(photo)).filter(Boolean)
        };
      },
      onConfirm: (chosen, selectedIds = []) => {
        const selected = new Set((selectedIds || []).map((id) => String(id || '').trim()).filter(Boolean));
        const fromSelectedId = proposalBrandingMedia.find((item) => {
          const keys = [projectPhotoId(item), item?.id, item?.photo_id, item?.media_id, item?.src, item?.thumb]
            .map((value) => String(value || '').trim())
            .filter(Boolean);
          return keys.some((key) => selected.has(key));
        });
        const logo = normalizeProposalImageRef(chosen?.[0] || fromSelectedId || null);
        if (!logo) {
          showToast((globalThis.PlatformLanguage?.text("proposals","m_87684c51af18a2","Logo not selected") ?? "Logo not selected"), (globalThis.PlatformLanguage?.text("proposals","m_9520a4adb27f80","That branding image could not be loaded. Try another logo or upload it again.") ?? "That branding image could not be loaded. Try another logo or upload it again."), false);
          return false;
        }
        if (!(logo.src || logo.thumb)) {
          showToast((globalThis.PlatformLanguage?.text("proposals","m_66ebc4c46751c1","Logo unavailable") ?? "Logo unavailable"), (globalThis.PlatformLanguage?.text("proposals","m_1c8bf75dc492cb","That branding image is missing a usable image file. Try another logo or upload it again.") ?? "That branding image is missing a usable image file. Try another logo or upload it again."), false);
          return false;
        }
        proposal.coBrandLogo = logo;
        proposal.co_brand_logo = logo;
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        renderProposalSection();
        queueAutosaveNotice();
        return true;
      },
      onClose: () => {
        proposalPhotoPicker = null;
      },
    });
  }

  function handleProposalPreviewKeydown(e){
    if (!proposalsEnabled() || activePreviewTab !== 'proposal' || !proposals.length) return;
    const proposal = proposals[activeProposalIndex];
    if (!proposal) return;
    const wrap = $('#rProposalPreview .r-proposal-wrap');
    const editingMarkupText = !!document.querySelector('#rProposalPreview .r-proposal-page-markup-editor');
    if (e.key === 'Escape' && editingMarkupText) return;
    if (e.key === 'Escape' && proposalInsertIndex !== null) {
      e.preventDefault();
      proposalInsertIndex = null;
      renderProposalPreview(wrap?.scrollTop ?? 0);
      return;
    }
    if (!proposalMarkupMode || !(e.ctrlKey || e.metaKey)) return;
    const markup = ensureProposalMarkup(proposal);
    const lower = e.key.toLowerCase();
    if (lower === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (restoreProposalMarkupHistory(proposal, markup.historyIndex - 1)) {
        queueAutosaveNotice();
        renderProposalPreview(wrap?.scrollTop ?? 0);
      }
      return;
    }
    if (lower === 'y' || (lower === 'z' && e.shiftKey)) {
      e.preventDefault();
      if (restoreProposalMarkupHistory(proposal, markup.historyIndex + 1)) {
        queueAutosaveNotice();
        renderProposalPreview(wrap?.scrollTop ?? 0);
      }
    }
  }

  function openProposalInsertChooser(insertAfter, behavior = 'smooth'){
    if (!proposals.length) return;
    proposalInsertIndex = insertAfter;
    setActivePreviewTab('proposal');
    renderProposalSection();
    renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
    setTimeout(() => {
      const wrap = $('#rProposalPreview .r-proposal-wrap');
      const insertEl = document.querySelector(`#rProposalPreview [data-insert-index="${insertAfter}"]`);
      if (!wrap || !insertEl) return;
      const wrapRect = wrap.getBoundingClientRect();
      const insertRect = insertEl.getBoundingClientRect();
      const nextTop = wrap.scrollTop + (insertRect.top - wrapRect.top) - ((wrap.clientHeight - insertRect.height) / 2);
      wrap.scrollTo({ top: Math.max(0, nextTop), behavior });
    }, 30);
  }

  function buildProposalFromForm(){
    const contacts = collectContacts();
    const now = new Date();
    const address = ($('#rAddress')?.value || '').trim();
    const notes = ($('#rProjectNotes')?.value || '').trim();
    const firstMeasureMeasurements = firstMeasureProposalMeasurements();
    const defaultSchedule = proposalDefaultPaymentSchedule();
    const proposal = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      title: proposalDefaultTitle(proposals.length),
      createdAt: now.toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month:'short', day:'numeric', year:'numeric' }),
      address,
      notes,
      contacts,
      measurements: firstMeasureMeasurements || defaultProposalMeasurements(),
      measurement_source: firstMeasureMeasurements ? 'firstmeasure' : 'manual_needed',
      theme: getBranchPresentationStyle().default_theme || 'margin',
      fontFamily: getProposalFontFamily(null),
      signatures: {},
      coverImageIds: proposalCoverImages().map((image) => projectPhotoId(image)),
      pages: [
        {
          id: createProposalPageId(),
          kind: 'cover',
          title: (globalThis.PlatformLanguage?.text("proposals","m_03779727637975","Cover") ?? "Cover"),
          kicker: '',
          heading: address || 'New Project',
          preparedFor: proposalPreparedForText(contacts),
          preparedBy: proposalPreparedByText(),
          date: now.toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month:'long', day:'numeric', year:'numeric' }),
          coverImageEnabled: true,
          coverImageIds: proposalCoverImages().map((image) => projectPhotoId(image)),
          coverImageWidth: PROPOSAL_COVER_DEFAULT_SIZE,
          coverImageHeight: PROPOSAL_COVER_DEFAULT_SIZE,
          coverImageZoom: 1,
          coverImagePanX: 0,
          coverImagePanY: 0,
        },
        {
          id: createProposalPageId(),
          kind: 'image_text',
          title: (globalThis.PlatformLanguage?.text("proposals","m_23783e95fc3139","Image & Text") ?? "Image & Text"),
          kicker: 'Image & Text',
          blocks: [defaultImageTextBlock()],
        },
        {
          id: createProposalPageId(),
          kind: 'pricing',
          title: (globalThis.PlatformLanguage?.text("proposals","m_d87a18f6ea7ea3","Estimate") ?? "Estimate"),
          kicker: 'Pricing',
          scope_view: {
            root_item_id: 'root',
            render_depth: 12,
            show_included_items: true,
            show_unselected_options: false
          },
          notes: notes || 'Included',
          total: proposalCurrencyDisplay(0),
        },
        {
          id: createProposalPageId(),
          kind: 'signature',
          title: (globalThis.PlatformLanguage?.text("proposals","m_23bdcfd5ce7509","Authorization") ?? "Authorization"),
          kicker: 'Signature',
          summary: 'Please review and sign where indicated to approve this proposal.',
          customerSignatureLabel: 'Customer Signature',
          customerPrintedNameLabel: 'Customer Printed Name',
          customerPrintedNameValue: proposalCustomerPrimaryContact({ contacts }).name || 'Customer',
          companySignatureLabel: 'Company Representative Signature',
          companyRepresentativeLabel: 'Company Representative',
          companyRepresentativeValue: proposalPreparedByText(),
          dateLabel: 'Date',
          dateValue: proposalTodayText(),
          pricingSummaryTitle: 'Contract Amount',
          paymentScheduleTitle: 'Payment Schedule',
          requireCompanySignature: true,
          showDate: true,
          showTax: true,
          taxRatePercent: proposalPercentDisplay(proposalDefaultSalesTaxPercent()),
          depositLabel: defaultSchedule[0]?.label || 'Deposit',
          depositPercent: proposalPercentDisplay(defaultSchedule[0]?.percent || 30),
          depositAmount: '$0.00',
          completionLabel: defaultSchedule[1]?.label || 'Progress Payment',
          completionPercent: proposalPercentDisplay(defaultSchedule[1]?.percent || 30),
          completionAmount: '$0.00',
          financedLabel: defaultSchedule[2]?.label || 'Final Payment',
          financedPercent: proposalPercentDisplay(defaultSchedule[2]?.percent || 40),
          financedAmount: '$0.00',
          taxAmount: '$0.00',
          signedSlots: {},
        },
        {
          id: createProposalPageId(),
          kind: 'fine_print',
          title: (globalThis.PlatformLanguage?.text("proposals","m_fd7326e5624473","Terms and Conditions") ?? "Terms and Conditions"),
          kicker: 'Fine Print',
          summary: '',
          body: 'Owner authorizes the contractor to perform the work described in this proposal and to furnish the required labor and materials. Any concealed deck repairs, permit fees, or code-required upgrades discovered after work begins will be documented and approved before additional charges are incurred. Final payment is due according to the agreed schedule once the contracted scope is substantially complete.',
          requireCustomerSignature: true,
          customerSignatureLabel: 'Customer Signature',
          signedSlots: {},
        }
      ]
    };
    ensureProposalScope(proposal);
    recomputeProposalPricing(proposal.pages[2], proposal, { seedScope: true });
    ensureProposalSignatureData(proposal);
    return proposal;
  }

  function proposalStableId(proposal, index = 0){
    if (!proposal) return '';
    if (!proposal.id) proposal.id = `proposal_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`;
    return String(proposal.id);
  }

  function proposalLocalVersion(proposal){
    return Number(proposal?.__localMutationVersion || 0) || 0;
  }

  function setProposalLocalVersion(proposal, version){
    if (!proposal || typeof proposal !== 'object') return;
    try {
      Object.defineProperty(proposal, '__localMutationVersion', {
        value: version,
        configurable: true,
        writable: true,
        enumerable: false
      });
    } catch (_) {
      proposal.__localMutationVersion = version;
    }
  }

  function markProposalLocalMutation(proposal){
    if (!proposal || typeof proposal !== 'object') return 0;
    proposalLocalMutationVersion += 1;
    setProposalLocalVersion(proposal, proposalLocalMutationVersion);
    return proposalLocalMutationVersion;
  }

  function proposalBySaveKey(index, key){
    const direct = proposals[index];
    if (direct && proposalStableId(direct, index) === key) return { proposal: direct, index };
    const foundIndex = proposals.findIndex((item, itemIndex) => proposalStableId(item, itemIndex) === key);
    return foundIndex >= 0 ? { proposal: proposals[foundIndex], index: foundIndex } : { proposal: null, index };
  }

  function markActiveProposalLocalMutation(){
    if (!proposalsEnabled() || !proposalWorkspaceOpen || activePreviewTab !== 'proposal') return;
    const proposal = proposals[activeProposalIndex];
    if (proposal) markProposalLocalMutation(proposal);
  }

  function proposalIndexLabel(index = 0){
    let n = Math.max(0, Number(index) || 0);
    let label = '';
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  function proposalDefaultTitle(index = 0){
    const defaults = getBranchPresentationStyle().proposal_defaults || {};
    const prefix = String(defaults.default_title_prefix || 'Proposal').trim() || 'Proposal';
    return `${prefix} ${proposalIndexLabel(index)}`;
  }

  function normalizeProposalPageRecord(page){
    if (!page || typeof page !== 'object') return page;
    const kind = String(page.kind || page.template || page.type || '').trim();
    if (['scope', 'summary', 'details', 'image', 'text', 'image_text'].includes(kind)) {
      page.kind = 'image_text';
      page.title = String(page.title || '').trim() || 'Image & Text';
      page.kicker = String(page.kicker || '').trim() || 'Image & Text';
      const summary = String(page.summary || '').trim();
      page.blocks = Array.isArray(page.blocks) && page.blocks.length ? page.blocks : [defaultImageTextBlock()];
      if (summary) {
        const firstTextBlock = page.blocks.find((block) => block && block.type !== 'image');
        if (firstTextBlock && (!firstTextBlock.text || firstTextBlock.text === 'Add supporting copy here.')) firstTextBlock.text = summary;
      }
    }
    if (Array.isArray(page.blocks)) {
      page.blocks = page.blocks.map((block) => {
        if (block?.text === 'Add supporting copy here.') return { ...block, text: '' };
        return block;
      });
    }
    return page;
  }

  function normalizeProposalRecord(proposal, index = 0){
    if (!proposal || typeof proposal !== 'object') return proposal;
    proposalStableId(proposal, index);
    proposal.status = ['draft', 'sent', 'viewed', 'signed', 'expired', 'archived', 'void', 'discarded'].includes(String(proposal.status || '').toLowerCase())
      ? String(proposal.status).toLowerCase()
      : 'draft';
    const currentTitle = String(proposal.title || '').trim();
    const addressTitle = String(proposal.address || activeBaseProject?.address || $('#rAddress')?.value || '').trim();
    if (!currentTitle || (addressTitle && currentTitle === addressTitle)) proposal.title = proposalDefaultTitle(index);
    proposal.createdAt = proposal.createdAt || proposal.created_at || new Date().toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month:'short', day:'numeric', year:'numeric' });
    proposal.created_at = proposal.created_at || new Date().toISOString();
    proposal.fontFamily = getProposalFontFamily(proposal);
    proposal.font_family = proposal.fontFamily;
    proposal.paperSize = normalizeProposalPaperSize(proposal.paperSize || proposal.paper_size);
    proposal.paper_size = proposal.paperSize;
    proposal.typography = {
      ...(proposal.typography && typeof proposal.typography === 'object' ? proposal.typography : {}),
      font_family: proposal.fontFamily
    };
    const coBrandLogo = proposalCoBrandLogo(proposal);
    if (coBrandLogo) {
      proposal.coBrandLogo = coBrandLogo;
      proposal.co_brand_logo = coBrandLogo;
    }
    proposal.pages = Array.isArray(proposal.pages) ? proposal.pages.map(normalizeProposalPageRecord).filter(Boolean) : [];
    if (proposal.scope) normalizeExistingProposalScope(proposal);
    return proposal;
  }

  function normalizeProposalCollection(){
    proposals = Array.isArray(proposals) ? proposals.map(normalizeProposalRecord).filter(Boolean) : [];
    activeProposalIndex = proposals.length ? Math.max(0, Math.min(activeProposalIndex, proposals.length - 1)) : 0;
    if (proposals.length) normalizeActiveProposalPage(proposals[activeProposalIndex]);
  }

  function proposalDisplayName(proposal, index = 0){
    return (proposal?.title || proposalDefaultTitle(index)).trim?.() || proposalDefaultTitle(index);
  }

  function proposalStatusLabel(status){
    const value = String(status || 'draft').toLowerCase();
    if (value === 'sent') return 'Sent';
    if (value === 'viewed') return 'Viewed';
    if (value === 'signed') return 'Signed';
    if (value === 'expired') return 'Expired';
    if (value === 'archived') return 'Archived';
    if (value === 'void') return 'Void';
    if (value === 'discarded') return 'Discarded';
    return 'Draft';
  }

  function proposalApiReady(){
    return proposalsEnabled() && !!(window.ProposalsAPI?.projects && window.ProposalsAPI?.proposals && projectOrgId());
  }

  function proposalBranchId(){
    return String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || activeBaseProject?.branch_id || 'default').trim() || 'default';
  }

  function cloneProposalJson(value){
    try { return JSON.parse(JSON.stringify(value ?? null)); } catch (_) { return value; }
  }

  function proposalContacts(){
    return collectContacts()
      .map((contact, index) => ({
        id: String(contact.id || '').trim(),
        role: contact.role || 'customer',
        name: String(contact.name || '').trim(),
        email: String(contact.email || '').trim(),
        phone: String(contact.phone || '').trim(),
        source: 'project_contact',
        index
      }))
      .filter((contact) => contact.name || contact.email || contact.phone || contact.id);
  }

  function proposalThemeKey(value, fallback = 'margin'){
    let key = '';
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      key = String(value.key || value.id || value.theme || value.name || '').trim();
    } else {
      key = String(value || '').trim();
    }
    if (key && PROPOSAL_THEMES[key]) return key;
    return PROPOSAL_THEMES[fallback] ? fallback : 'margin';
  }

  function proposalThemePayload(value){
    const key = proposalThemeKey(value);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value, key };
    }
    return { key };
  }

  function proposalEditablePayload(proposal = {}){
    syncProposalMeasurementsToScope(proposal);
    const editable = cloneProposalJson(proposal) || {};
    const rawTheme = editable.theme ?? proposal.theme;
    [
      'proposal_api_id', 'proposalApiId', 'backend_id', 'backendId', 'proposal_id', 'proposalId',
      'revision', 'organization_id', 'organizationId', 'project_id', 'projectId', 'branch_id', 'branchId',
      'contacts', 'delivery', 'pdf', 'resources',
      'created_by_user_id', 'updated_by_user_id', 'updated_at'
    ].forEach((key) => { delete editable[key]; });
    editable.schema_version = 1;
    editable.title = proposalDisplayName(proposal, proposals.indexOf(proposal));
    editable.pages = Array.isArray(editable.pages) ? editable.pages : [];
    editable.scope = editable.scope && typeof editable.scope === 'object' ? editable.scope : ensureProposalScope(proposal);
    editable.theme_key = proposalThemeKey(rawTheme);
    editable.theme = proposalThemePayload(rawTheme);
    editable.resources = {
      ...(editable.resources && typeof editable.resources === 'object' ? editable.resources : {}),
      ...(proposal.resources && typeof proposal.resources === 'object' ? proposal.resources : {})
    };
    return editable;
  }

  function proposalApiPayload(proposal, index = 0){
    const editable = proposalEditablePayload(proposal);
    const payload = {
      title: proposalDisplayName(proposal, index),
      status: String(proposal?.status || 'draft').trim().toLowerCase() || 'draft',
      branch_id: proposalBranchId(),
      contacts: proposalContacts(),
      delivery: proposal?.delivery && typeof proposal.delivery === 'object' ? cloneProposalJson(proposal.delivery) : {},
      editable,
      resources: editable.resources || {},
      metadata: {
        source: 'portal_project_viewer'
      }
    };
    const localId = String(proposal?.id || '').trim();
    if (localId.startsWith('proposal_')) payload.id = localId;
    return payload;
  }

  function localProposalFromApi(apiProposal = {}, index = 0){
    const editable = apiProposal.editable && typeof apiProposal.editable === 'object' ? cloneProposalJson(apiProposal.editable) : {};
    const theme = proposalThemeKey(editable.theme || editable.theme_key || apiProposal.theme);
    const local = {
      ...(editable || {}),
      id: String(apiProposal.id || editable.id || '').trim() || `proposal_${Date.now().toString(36)}_${index}`,
      proposal_api_id: String(apiProposal.id || '').trim(),
      revision: Number(apiProposal.revision || 0) || undefined,
      organization_id: String(apiProposal.organization_id || '').trim(),
      project_id: String(apiProposal.project_id || '').trim(),
      branch_id: String(apiProposal.branch_id || '').trim(),
      contacts: Array.isArray(apiProposal.contacts) ? apiProposal.contacts : Array.isArray(apiProposal.participants) ? apiProposal.participants : [],
      title: String(apiProposal.title || editable.title || proposalDefaultTitle(index)).trim(),
      theme,
      theme_key: theme,
      status: String(apiProposal.status || editable.status || 'draft').trim().toLowerCase(),
      resources: apiProposal.resources && typeof apiProposal.resources === 'object' ? apiProposal.resources : (editable.resources || {}),
      delivery: apiProposal.delivery && typeof apiProposal.delivery === 'object' ? apiProposal.delivery : {},
      pdf: apiProposal.pdf && typeof apiProposal.pdf === 'object' ? apiProposal.pdf : {},
      createdAt: apiProposal.created_at || editable.createdAt,
      created_at: apiProposal.created_at || editable.created_at || new Date().toISOString(),
      updated_at: apiProposal.updated_at || editable.updated_at || ''
    };
    return normalizeProposalRecord(local, index);
  }

  function mergeSavedProposal(index, apiProposal){
    const current = proposals[index] || {};
    const saved = localProposalFromApi(apiProposal, index);
    const localVersion = proposalLocalVersion(current);
    proposals[index] = normalizeProposalRecord({
      ...current,
      ...saved,
      pages: Array.isArray(saved.pages) ? saved.pages : current.pages,
      theme: saved.theme || current.theme,
      proposal_api_id: saved.proposal_api_id || current.proposal_api_id,
      revision: saved.revision || current.revision
    }, index);
    setProposalLocalVersion(proposals[index], localVersion);
    if (activeBaseProject) activeBaseProject.proposals = proposals;
    return proposals[index];
  }

  function mergeSavedProposalMetadata(index, apiProposal, key = ''){
    const current = proposalBySaveKey(index, key || proposalStableId(proposals[index], index));
    const currentProposal = current.proposal || proposals[index] || {};
    const targetIndex = current.index;
    const saved = localProposalFromApi(apiProposal, targetIndex);
    const localVersion = proposalLocalVersion(currentProposal);
    proposals[targetIndex] = normalizeProposalRecord({
      ...currentProposal,
      proposal_api_id: saved.proposal_api_id || currentProposal.proposal_api_id,
      proposalApiId: saved.proposal_api_id || currentProposal.proposalApiId,
      backend_id: saved.proposal_api_id || currentProposal.backend_id,
      revision: saved.revision || currentProposal.revision,
      organization_id: saved.organization_id || currentProposal.organization_id,
      project_id: saved.project_id || currentProposal.project_id,
      branch_id: saved.branch_id || currentProposal.branch_id,
      contacts: Array.isArray(saved.contacts) ? saved.contacts : currentProposal.contacts,
      delivery: saved.delivery && typeof saved.delivery === 'object' ? saved.delivery : currentProposal.delivery,
      pdf: saved.pdf && typeof saved.pdf === 'object' ? saved.pdf : currentProposal.pdf,
      updated_at: saved.updated_at || currentProposal.updated_at,
      created_at: saved.created_at || currentProposal.created_at,
      status: saved.status || currentProposal.status
    }, targetIndex);
    setProposalLocalVersion(proposals[targetIndex], localVersion);
    if (activeBaseProject) activeBaseProject.proposals = proposals;
    return proposals[targetIndex];
  }

  function proposalsApiRouteMissing(error){
    const message = String(error?.message || error?.data?.message || error?.data?.error || error?.responseText || '').toLowerCase();
    return Number(error?.status || 0) === 404 && (
      message.includes('/v1/proposals')
      || message.includes('route post:')
      || message.includes('route get:')
      || message.includes('route patch:')
      || message.includes('not found')
    );
  }

  function proposalApiErrorMessage(error, fallback = 'Could not complete this proposal request.'){
    const data = error?.data && typeof error.data === 'object' ? error.data : {};
    const issues = Array.isArray(data.issues) ? data.issues : [];
    if (issues.length) {
      const issue = issues[0] || {};
      const path = Array.isArray(issue.path) ? issue.path.filter(Boolean).join('.') : '';
      const message = String(issue.message || data.message || data.error || error?.message || '').trim();
      return `${path ? `${path}: ` : ''}${message || fallback}`;
    }
    return String(data.message || data.error || error?.message || fallback).trim() || fallback;
  }

  function ensureProposalErrorToast(){
    let el = document.getElementById('rProposalErrorToast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'rProposalErrorToast';
    el.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483640',
      'display:none',
      'align-items:flex-start',
      'gap:10px',
      'width:min(520px,calc(100vw - 36px))',
      'padding:12px',
      'border-radius:16px',
      'border:1px solid #f4b4ae',
      'background:rgba(255,255,255,.98)',
      'box-shadow:0 18px 50px rgba(0,0,0,.18)',
      'color:#111827'
    ].join(';');
    el.innerHTML = `
      <div style="width:36px;height:36px;border-radius:14px;background:#fce8e6;border:1px solid #f4b4ae;color:#c5221f;display:flex;align-items:center;justify-content:center;flex:0 0 auto"><i class="fas fa-triangle-exclamation"></i></div>
      <div style="min-width:0;flex:1">
        <div data-proposal-error-title style="font-size:13px;font-weight:1000;color:#111827"></div>
        <div data-proposal-error-message style="font-size:12px;font-weight:800;color:#667085;margin-top:3px;line-height:1.35;white-space:normal;overflow-wrap:anywhere"></div>
      </div>
      <button type="button" data-proposal-error-close aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_54fe29d1908de6","Dismiss") ?? "Dismiss")}" style="width:32px;height:32px;border-radius:12px;border:1px solid rgba(0,0,0,.08);background:#fff;color:#475467;cursor:pointer;flex:0 0 auto"><i class="fas fa-times"></i></button>
    `;
    el.querySelector('[data-proposal-error-close]')?.addEventListener('click', () => {
      el.style.display = 'none';
      clearTimeout(showProposalError._timer);
    });
    document.body.appendChild(el);
    return el;
  }

  function showProposalError(title, error, fallback){
    const message = proposalApiErrorMessage(error, fallback);
    showToast(title, message, false);
    const el = ensureProposalErrorToast();
    const titleEl = el.querySelector('[data-proposal-error-title]');
    const messageEl = el.querySelector('[data-proposal-error-message]');
    if (titleEl) titleEl.textContent = title || 'Proposal error';
    if (messageEl) messageEl.textContent = message;
    el.style.display = 'flex';
    clearTimeout(showProposalError._timer);
    showProposalError._timer = setTimeout(() => {
      el.style.display = 'none';
    }, 7000);
    return message;
  }

  async function saveProposalEmbeddedFallback(index = activeProposalIndex){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return null;
    ensureProposalOnlyBaseProject();
    if (!activeBaseProject) return null;
    activeBaseProject.proposals = proposals;
    persistActiveBaseProject();
    if (window.Portal.ProjectStore?.saveRemote) {
      const saved = await window.Portal.ProjectStore.saveRemote(activeBaseProject).catch((error) => {
        console.warn('Embedded proposal project save failed', error);
        return null;
      });
      if (saved) activeBaseProject = { ...activeBaseProject, ...saved, proposals };
    }
    return proposal;
  }

  async function ensureProposalBackendProject(){
    ensureProposalOnlyBaseProject();
    if (!activeBaseProject?.id) return null;
    activeBaseProject.proposals = proposals;
    if (!window.Portal.ProjectStore?.saveRemote) return activeBaseProject;
    const saved = await window.Portal.ProjectStore.saveRemote(activeBaseProject);
    if (saved) {
      activeBaseProject = { ...activeBaseProject, ...saved, proposals };
    }
    return activeBaseProject;
  }

  async function saveProposalToBackend(index = activeProposalIndex, { silent = false, throwOnError = false } = {}){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal || !proposalApiReady()) return null;
    const key = proposalStableId(proposal, index);
    if (proposalSaveInFlight.has(key)) {
      proposalSaveRetryNeeded.add(key);
      return proposalSaveInFlight.get(key).promise;
    }
    const startVersion = proposalLocalVersion(proposal);
    const promise = (async () => {
      const project = await ensureProposalBackendProject();
      const orgId = projectOrgId();
      const projectId = String(project?.id || activeBaseProject?.id || '').trim();
      if (!orgId || !projectId) return null;
      const payload = proposalApiPayload(proposal, index);
      const backendId = proposalBackendId(proposal);
      let response = null;
      if (backendId) {
        response = await window.ProposalsAPI.proposals.patch(orgId, backendId, payload).catch(async (error) => {
          if (Number(error?.status || 0) !== 404) throw error;
          return await window.ProposalsAPI.projects.create(orgId, projectId, payload);
        });
      } else {
        response = await window.ProposalsAPI.projects.create(orgId, projectId, payload);
      }
      const current = proposalBySaveKey(index, key);
      const changedSinceRequest = current.proposal && proposalLocalVersion(current.proposal) > startVersion;
      const saved = response?.proposal
        ? (changedSinceRequest ? mergeSavedProposalMetadata(index, response.proposal, key) : mergeSavedProposal(index, response.proposal))
        : null;
      if (changedSinceRequest) proposalSaveRetryNeeded.add(key);
      if (saved && !silent) showToast((globalThis.PlatformLanguage?.text("proposals","m_bb452fdc7430c2","Proposal saved") ?? "Proposal saved"), proposalDisplayName(saved, index), true);
      return saved;
    })();
    proposalSaveInFlight.set(key, { promise, startVersion });
    try {
      return await promise;
    } catch (error) {
      console.warn('Proposal save failed', error);
      if (proposalsApiRouteMissing(error)) {
        await saveProposalEmbeddedFallback(index);
        if (!silent) showToast((globalThis.PlatformLanguage?.text("proposals","m_3215a0950be6db","Proposal API unavailable") ?? "Proposal API unavailable"), (globalThis.PlatformLanguage?.text("proposals","m_c3bd54413fcd74","The proposals backend route is not mounted on the running server. Saved this draft on the project for now.") ?? "The proposals backend route is not mounted on the running server. Saved this draft on the project for now."), false);
        return proposals[index] || null;
      }
      if (throwOnError) throw error;
      if (!silent) showProposalError('Proposal save failed', error, 'Could not save this proposal.');
      return null;
    } finally {
      proposalSaveInFlight.delete(key);
      if (proposalSaveRetryNeeded.delete(key)) {
        setTimeout(() => {
          const current = proposalBySaveKey(index, key);
          if (current.proposal) saveProposalToBackend(current.index, { silent: true }).catch((error) => console.warn('Proposal follow-up autosave failed', error));
        }, 0);
      }
    }
  }

  function queueProposalBackendAutosave(index = activeProposalIndex){
    if (!proposalApiReady() || !proposalWorkspaceOpen || !proposals.length) return;
    clearTimeout(proposalAutosaveTimer);
    proposalAutosaveTimer = setTimeout(() => {
      saveProposalToBackend(index, { silent: true }).catch((error) => console.warn('Proposal autosave failed', error));
    }, 650);
  }

  async function hydrateProposalsFromBackend({ render = true, force = false } = {}){
    if (!proposalApiReady() || !activeBaseProject?.id) return false;
    const projectId = String(activeBaseProject.id || '').trim();
    if (!force && proposalBackendLoadedProjectId === projectId) return false;
    const requestId = ++proposalHydrateRequestId;
    const startMutationVersion = proposalLocalMutationVersion;
    try {
      const result = await window.ProposalsAPI.projects.list(projectOrgId(), projectId);
      if (requestId !== proposalHydrateRequestId) return false;
      if (proposalLocalMutationVersion !== startMutationVersion) return false;
      proposalBackendLoadedProjectId = projectId;
      const remote = (Array.isArray(result?.proposals) ? result.proposals : [])
        .filter((proposal) => !['archived', 'void', 'discarded'].includes(String(proposal.status || '').toLowerCase()))
        .map(localProposalFromApi);
      if (remote.length || !proposals.length) {
        proposals = remote;
        if (activeBaseProject) activeBaseProject.proposals = proposals;
        normalizeProposalCollection();
        if (render && proposalsEnabled() && activePreviewTab === 'proposal') {
          renderProposalSection();
          renderProposalPreview();
        }
        return true;
      }
    } catch (error) {
      console.warn('Unable to load proposals from backend', error);
    }
    return false;
  }

  async function sendProposalToBackend(index, options = {}){
    normalizeProposalCollection();
    const proposal = proposals[index];
    const orgId = projectOrgId();
    if (!proposal || !orgId || !proposalApiReady() || !window.ProposalsAPI?.proposals?.send) {
      throw new Error('The proposals API is required to send a proposal to the customer portal.');
    }
    const saved = await saveProposalToBackend(index, { silent: true, throwOnError: true });
    const current = proposals[index] || saved || proposal;
    const backendId = proposalBackendId(current);
    if (!backendId) throw new Error('The proposal could not be saved before sending.');
    const documentHtml = proposalPdfDocumentHtml(current, index);
    const recipients = selectedProposalRecipients();
    if (!recipients.length) throw new Error('Add a valid email address for at least one selected customer before sending.');
    const response = await window.ProposalsAPI.proposals.send(orgId, backendId, {
      expected_revision: Number(current.revision || saved?.revision || 0) || undefined,
      recipients,
      include_pdf: options.include_pdf !== false,
      include_portal: options.include_portal !== false,
      message: String(options.message || '').trim(),
      html: documentHtml,
      document_html: documentHtml
    });
    if (response?.proposal) mergeSavedProposal(index, response.proposal);
    const next = proposals[index] || current;
    if (response?.snapshot) {
      const snapshotDelivery = response.snapshot.delivery && typeof response.snapshot.delivery === 'object' ? response.snapshot.delivery : {};
      next.delivery = {
        ...(next.delivery && typeof next.delivery === 'object' ? next.delivery : {}),
        current_snapshot_id: response.snapshot.id || response.snapshot.snapshot_id || '',
        current_public_token: snapshotDelivery.public_token || response.snapshot.public_token || '',
        state: 'sent',
        sent_at: response.proposal?.delivery?.sent_at || snapshotDelivery.sent_at || new Date().toISOString()
      };
      next.snapshot_id = response.snapshot.id || next.snapshot_id;
      next.public_token = snapshotDelivery.public_token || next.public_token;
    }
    next.status = 'sent';
    next.sent_at = next.delivery?.sent_at || new Date().toISOString();
    if (activeBaseProject) activeBaseProject.proposals = proposals;
    let customerPortal = null;
    if (options.include_portal !== false && activeBaseProject?.id && window.PlatformAPI?.customerPortals?.ensure) {
      const contacts = Array.isArray(activeBaseProject.contacts) ? activeBaseProject.contacts : [];
      const primary = contacts.find((entry) => entry?.primary === true) || contacts.find((entry) => entry?.name || entry?.email || entry?.phone) || {};
      const contactId = String(primary.id || primary.contact_id || activeBaseProject.contact_id || activeBaseProject.primary_contact_id || '').trim();
      const contact = {
        ...(contactId ? { id: contactId, contact_id: contactId } : {}),
        name: String(primary.name || activeBaseProject.customer_name || activeBaseProject.primary_contact_name || '').trim(),
        email: String(primary.email || activeBaseProject.customer_email || activeBaseProject.primary_contact_email || '').trim(),
        phone: String(primary.phone || activeBaseProject.customer_phone || activeBaseProject.primary_contact_phone || '').trim()
      };
      customerPortal = await window.PlatformAPI.customerPortals.ensure(orgId, activeBaseProject.id, {
        contact_id: contactId,
        customer: contact
      }).catch((error) => {
        console.warn('Customer portal provisioning after proposal send failed', error);
        return null;
      });
      if (customerPortal) {
        const portalLoad = callHost('loadCustomerPortal', { silent: true })
          || (typeof loadCustomerPortal === 'function' ? loadCustomerPortal({ silent: true }) : null);
        if (portalLoad && typeof portalLoad.catch === 'function') await portalLoad.catch(() => null);
        callHost('renderCustomerPortalLink');
      }
    }
    return { proposal: next, response, customerPortal };
  }

  function proposalHasCustomerSignature(proposal){
    if (!proposal || typeof proposal !== 'object') return false;
    const signatures = proposal.signatures && typeof proposal.signatures === 'object' ? proposal.signatures : {};
    if (signatures.customer || signatures.customerSignature) return true;
    if (proposal.customer_signed_at || proposal.customerSignedAt || proposal.signed_at || proposal.signedAt) return true;
    return (Array.isArray(proposal.pages) ? proposal.pages : []).some((page) => {
      const slots = page?.signedSlots && typeof page.signedSlots === 'object' ? page.signedSlots : {};
      return !!(slots.customerSignature || slots.customer || page.customerSignature || page.customer_signed_at || page.customerSignedAt);
    });
  }

  function proposalHasView(proposal){
    if (!proposal || typeof proposal !== 'object') return false;
    const delivery = proposal.delivery && typeof proposal.delivery === 'object' ? proposal.delivery : {};
    const analytics = proposal.analytics && typeof proposal.analytics === 'object' ? proposal.analytics : {};
    return !!(
      proposal.viewed_at || proposal.viewedAt || proposal.first_viewed_at || proposal.firstViewedAt || proposal.customer_viewed_at || proposal.customerViewedAt || proposal.last_viewed_at || proposal.lastViewedAt ||
      delivery.viewed_at || delivery.viewedAt || delivery.first_viewed_at || delivery.firstViewedAt ||
      analytics.viewed_at || analytics.viewedAt || analytics.first_viewed_at || analytics.firstViewedAt ||
      String(proposal.delivery_status || proposal.deliveryStatus || delivery.status || '').toLowerCase() === 'viewed'
    );
  }

  function proposalDeliveryStatus(proposal){
    if (String(proposal?.status || '').toLowerCase() === 'expired' || String(proposal?.delivery?.state || '').toLowerCase() === 'expired') return 'expired';
    if (proposalHasCustomerSignature(proposal)) return 'signed';
    if (proposalHasView(proposal)) return 'viewed';
    return 'unviewed';
  }

  function proposalDeliveryLabel(status){
    const value = String(status || '').toLowerCase();
    if (value === 'signed') return 'Signed';
    if (value === 'expired') return 'Expired';
    if (value === 'viewed') return 'Viewed';
    return 'Unviewed';
  }

  function proposalStatusBadgesHtml(proposal = {}){
    const deliveryStatus = proposalDeliveryStatus(proposal);
    const sent = ['sent', 'viewed', 'signed'].includes(String(proposal.status || '').toLowerCase());
    return ("\n      <div class=\"r-proposal-status-row\" aria-label=\"" + (globalThis.PlatformLanguage?.text("proposals","m_a53c07d30c69ec","Proposal status") ?? "Proposal status") + "\">\n        " + String(sent ? `<span class="r-proposal-status-badge r-proposal-delivery-badge ${escapeHtml(deliveryStatus)}">${escapeHtml(proposalDeliveryLabel(deliveryStatus))}</span>` : '') + "\n        <span class=\"r-proposal-status-badge " + String(escapeHtml(proposal.status || 'draft')) + "\">" + String(escapeHtml(proposalStatusLabel(proposal.status))) + "</span>\n      </div>\n    ");
  }

  function proposalIsExpired(proposal = {}){
    return String(proposal?.status || '').toLowerCase() === 'expired'
      || String(proposal?.delivery?.state || '').toLowerCase() === 'expired';
  }

  async function saveProposalMetadataChange(index, successTitle, successMessage){
    if (activeBaseProject) activeBaseProject.proposals = proposals;
    markProposalLocalMutation(proposals[index]);
    renderProposalSection();
    renderProposalPreview();
    const saved = await saveProposalToBackend(index, { silent: true }).catch((error) => {
      console.warn('Proposal metadata save failed', error);
      return null;
    });
    if (!saved) await saveProposalEmbeddedFallback(index).catch((error) => console.warn('Proposal project fallback save failed', error));
    showToast(successTitle, successMessage, true);
  }

  async function unsendProposal(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    const id = proposalStableId(proposal, index);
    proposal.status = 'draft';
    proposal.sent_at = '';
    proposal.public_token = '';
    proposal.snapshot_id = '';
    proposal.delivery = {
      ...(proposal.delivery && typeof proposal.delivery === 'object' ? proposal.delivery : {}),
      state: 'not_sent',
      sent_at: '',
      expired_at: '',
      current_snapshot_id: '',
      current_public_token: '',
      public_token: '',
      has_unpublished_changes: false
    };
    proposalListMenuProposalId = '';
    proposalDeleteConfirmProposalId = null;
    await saveProposalMetadataChange(index, 'Proposal unsent', `${proposalDisplayName(proposal, index)} was removed from the customer portal.`);
    if (proposalSendSelectedIds?.has?.(id)) proposalSendSelectedIds.delete(id);
  }

  async function markProposalRecent(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    const now = new Date().toISOString();
    proposal.status = 'sent';
    proposal.sent_at = proposal.sent_at || now;
    proposal.delivery = {
      ...(proposal.delivery && typeof proposal.delivery === 'object' ? proposal.delivery : {}),
      state: 'sent',
      sent_at: proposal.delivery?.sent_at || proposal.sent_at || now,
      expired_at: '',
      has_unpublished_changes: false
    };
    proposalListMenuProposalId = '';
    proposalDeleteConfirmProposalId = null;
    await saveProposalMetadataChange(index, 'Proposal restored', `${proposalDisplayName(proposal, index)} is available in the customer portal again.`);
  }

  function proposalContactKey(contact = {}, index = 0){
    return contact.email || contact.phone || contact.name || `contact_${index}`;
  }

  function proposalContactLabel(contact = {}){
    return [contact.name, contact.email, contact.phone].filter(Boolean).join(' - ') || 'Customer';
  }

  function proposalRecipientEmailIsValid(value){
    const email = String(value || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  async function saveProposalRecipientEmail(contact = {}, index = 0, value = ''){
    const email = String(value || '').trim();
    if (!proposalRecipientEmailIsValid(email)) throw new Error('Enter a valid customer email address.');
    const locator = {
      contact_id: String(contact.id || contact.contact_id || '').trim(),
      index,
      email
    };
    let saved = callHost('saveContactEmail', locator);
    if (saved !== undefined) saved = await Promise.resolve(saved);
    if (!saved) {
      const projectContacts = Array.isArray(activeBaseProject?.contacts) ? activeBaseProject.contacts : [];
      const contactIndex = locator.contact_id
        ? projectContacts.findIndex((entry) => String(entry?.id || entry?.contact_id || '').trim() === locator.contact_id)
        : Math.max(0, Math.min(index, Math.max(0, projectContacts.length - 1)));
      const next = {
        ...(projectContacts[contactIndex] || contact || {}),
        email,
        primary: projectContacts[contactIndex]?.primary ?? contact.primary ?? contactIndex === 0
      };
      if (contactIndex >= 0 && projectContacts.length) projectContacts[contactIndex] = next;
      else projectContacts.push(next);
      if (activeBaseProject) {
        activeBaseProject.contacts = projectContacts;
        if (next.primary || projectContacts.length === 1) {
          activeBaseProject.customer_email = email;
          activeBaseProject.primary_contact_email = email;
        }
      }
      const persisted = callHost('persistProject') || (typeof persistActiveBaseProject === 'function' ? persistActiveBaseProject() : null);
      if (persisted && typeof persisted.then === 'function') await persisted;
      saved = next;
    }
    return { ...contact, ...saved, email };
  }

  function selectedProposalRecipients(){
    const selectedKeys = new Set([...proposalSendContactKeys].map((key) => String(key || '').trim()).filter(Boolean));
    return collectContacts()
      .map((contact, index) => ({ contact, key: proposalContactKey(contact, index) }))
      .filter((entry) => !selectedKeys.size || selectedKeys.has(entry.key))
      .map((entry) => ({
        ...entry.contact,
        role: entry.contact.role || 'customer',
        name: String(entry.contact.name || '').trim(),
        email: String(entry.contact.email || '').trim(),
        phone: String(entry.contact.phone || '').trim()
      }))
      .filter((contact) => proposalRecipientEmailIsValid(contact.email));
  }

  function selectedProposalIdsForSend(){
    normalizeProposalCollection();
    const ids = [...proposalSendSelectedIds].filter((id) => proposals.some((proposal, index) => proposalStableId(proposal, index) === id));
    if (ids.length) return ids;
    const fallbackId = proposalStableId(proposals[activeProposalIndex], activeProposalIndex);
    return fallbackId ? [fallbackId] : [];
  }

  function syncProposalNotesPlacement(){
    if (typeof syncProjectNotesPlacement === 'function') syncProjectNotesPlacement();
    else callHost('syncProjectNotesPlacement');
    if (proposalWorkspaceMode !== 'edit') return;
    const agentMount = document.querySelector('#rOverlay #rProposalAgentRailMount');
    if (!agentMount) return;
    const agent = document.querySelector('#rOverlay #rProposalAgent');
    if (agent && agentMount && agent.parentElement !== agentMount) agentMount.appendChild(agent);
    document.querySelector('#rOverlay #rProposalAgentRailSection')?.classList.toggle('has-mounted', !!(agent && agentMount && agent.parentElement === agentMount));
    document.querySelector('#rOverlay #rProposalNotesRailSection')?.classList.remove('has-mounted');
  }

  function syncProposalRoute(mode, options = {}){
    const id = proposals.length ? proposalStableId(proposals[activeProposalIndex], activeProposalIndex) : '';
    if (window.Portal?.navigation?.applying || options.updateRoute === false) return;
    window.Portal?.navigation?.write?.({ proposal:id || null, proposalMode:mode || 'list' }, { history:options.history || 'push', source:'project-proposal-mode', ownedKeys:['proposal','proposalMode'] });
  }

  function enterProposalListMode(index = activeProposalIndex, options = {}){
    normalizeProposalCollection();
    clearProposalSettingsPanel();
    proposalWorkspaceMode = 'list';
    proposalEditorMode = 'preview';
    proposalMarkupMode = false;
    proposalMarkupDockOpen = false;
    proposalMarkupPopover = null;
    proposalSigningMode = false;
    proposalSigningSession = null;
    proposalBuilderState = null;
    proposalDeleteConfirmProposalId = null;
    proposalListMenuProposalId = '';
    activeProposalIndex = proposals.length ? Math.max(0, Math.min(index, proposals.length - 1)) : 0;
    syncProposalRoute('list', options);
    renderProposalSection();
    renderProposalPreview();
    bindProposalMarkupToggle();
  }

  function enterProposalEditMode(index = activeProposalIndex, options = {}){
    normalizeProposalCollection();
    if (!proposals.length) return;
    clearProposalSettingsPanel();
    proposalWorkspaceMode = 'edit';
    proposalEditorMode = 'edit';
    proposalMarkupMode = false;
    proposalMarkupPopover = null;
    proposalSigningMode = false;
    proposalSigningSession = null;
    proposalDeleteConfirmProposalId = null;
    proposalListMenuProposalId = '';
    activeProposalIndex = Math.max(0, Math.min(index, proposals.length - 1));
    syncProposalRoute('edit', options);
    activeProposalPageIndex = 0;
    if (proposals[activeProposalIndex]?.pages?.some?.((page) => page.kind === 'pricing')) ensureProposalScope(proposals[activeProposalIndex], { seed: true });
    normalizeActiveProposalPage(proposals[activeProposalIndex]);
    renderProposalSection();
    renderProposalPreview();
    syncProposalNotesPlacement();
    bindProposalModeToggle();
    bindProposalMarkupToggle();
  }

  function enterProposalSendMode(origin = 'list', ids = null, options = {}){
    normalizeProposalCollection();
    if (!proposals.length) return;
    clearProposalSettingsPanel();
    proposalWorkspaceMode = 'send';
    proposalSendOrigin = origin || 'list';
    proposalListMenuProposalId = '';
    proposalEditorMode = 'preview';
    proposalMarkupMode = false;
    proposalMarkupDockOpen = false;
    proposalMarkupPopover = null;
    const fallbackId = proposalStableId(proposals[activeProposalIndex], activeProposalIndex);
    syncProposalRoute('send', options);
    proposalSendSelectedIds = new Set([...(ids && ids.length ? ids : [fallbackId])].filter(Boolean));
    if (!proposalSendMessage) {
      const primary = primaryContact();
      proposalSendMessage = `Hi ${primary.name || 'there'},\n\nHere is your proposal for review.`;
    }
    const proposalDefaults = getBranchPresentationStyle().proposal_defaults || {};
    proposalSendIncludePdf = proposalDefaults.send_include_pdf !== false;
    proposalSendIncludePortal = customerPortalEnabled() && proposalDefaults.send_include_portal !== false;
    if (typeof proposalSendAllowMultipleSelection === 'undefined') proposalSendAllowMultipleSelection = false;
    if (!proposalSendContactKeys.size) {
      proposalSendContactKeys = new Set(collectContacts().map(proposalContactKey).filter(Boolean));
    }
    renderProposalSection();
    renderProposalPreview();
    syncProposalNotesPlacement();
    bindProposalMarkupToggle();
  }

  function createManualProposalAndEdit(){
    ensureProposalOnlyBaseProject();
    const proposal = normalizeProposalRecord(createProposalFromFormAndTrack('proposal_list_create'), proposals.length);
    activeProposalIndex = proposals.findIndex((item) => item === proposal);
    if (activeProposalIndex < 0) activeProposalIndex = proposals.length - 1;
    activeProposalPageIndex = 0;
    enterProposalEditMode(activeProposalIndex);
    queueAutosaveNotice();
    saveProposalToBackend(activeProposalIndex, { silent: true }).catch((error) => console.warn('Initial proposal save failed', error));
  }

  function createNewProposalAndEdit(){
    if (projectHasDefinedScope(activeBaseProject)) {
      proposalBuilderState = { mode: 'scope_choice', query: '' };
      proposalBuilderContext = null;
      proposalWorkspaceMode = 'builder';
      proposalEditorMode = 'preview';
      proposalWorkspaceOpen = true;
      renderProposalSection();
      renderProposalPreview();
      return;
    }
    startProposalScopeThenCreate();
  }

  function duplicateProposal(index){
    normalizeProposalCollection();
    const source = proposals[index];
    if (!source) return;
    const clone = JSON.parse(JSON.stringify(source));
    clone.id = `proposal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    delete clone.proposal_api_id;
    delete clone.proposalApiId;
    delete clone.backend_id;
    delete clone.backendId;
    delete clone.proposal_id;
    delete clone.proposalId;
    delete clone.revision;
    delete clone.organization_id;
    delete clone.project_id;
    clone.title = proposalDefaultTitle(proposals.length);
    clone.status = 'draft';
    clone.createdAt = new Date().toLocaleDateString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { month:'short', day:'numeric', year:'numeric' });
    clone.created_at = new Date().toISOString();
    delete clone.sent_at;
    proposals = [...proposals.slice(0, index + 1), normalizeProposalRecord(clone, index + 1), ...proposals.slice(index + 1)];
    activeProposalIndex = index + 1;
    proposalDeleteConfirmProposalId = null;
    renderProposalSection();
    renderProposalPreview();
    queueAutosaveNotice();
    showToast((globalThis.PlatformLanguage?.text("proposals","m_797e352038a0fa","Proposal duplicated") ?? "Proposal duplicated"), proposalDisplayName(clone, activeProposalIndex), true);
  }

  function removeProposal(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    const proposalId = proposalStableId(proposal, index);
    if (proposalDeleteConfirmProposalId !== proposalId) {
      proposalDeleteConfirmProposalId = proposalId;
      proposalListMenuProposalId = proposalId;
      renderProposalSection();
      return;
    }
    const backendId = proposalBackendId(proposal);
    if (backendId && proposalApiReady()) {
      window.ProposalsAPI.proposals.archive(projectOrgId(), backendId, {
        expected_revision: Number(proposal.revision || 0) || undefined,
        reason: 'Deleted from project proposal list'
      }).catch((error) => console.warn('Proposal archive failed', error));
    }
    proposals = proposals.filter((_, itemIndex) => itemIndex !== index);
    proposalSendSelectedIds.delete(proposalId);
    proposalDeleteConfirmProposalId = null;
    proposalListMenuProposalId = '';
    activeProposalIndex = Math.max(0, Math.min(index, proposals.length - 1));
    if (!proposals.length) proposalWorkspaceMode = 'list';
    renderProposalSection();
    renderProposalPreview();
    queueAutosaveNotice();
    showToast((globalThis.PlatformLanguage?.text("proposals","m_95e8e1ab53d594","Proposal deleted") ?? "Proposal deleted"), (globalThis.PlatformLanguage?.text("proposals","m_37dcbe0308f8f6","The proposal was removed from this project.") ?? "The proposal was removed from this project."), true);
  }

  function proposalBackendId(proposal){
    const explicit = String(proposal?.proposal_api_id || proposal?.proposalApiId || proposal?.backend_id || proposal?.backendId || proposal?.proposal_id || proposal?.proposalId || '').trim();
    if (explicit) return explicit;
    const id = String(proposal?.id || '').trim();
    if (!id) return '';
    return (proposal?.revision || proposal?.organization_id || proposal?.project_id) ? id : '';
  }

  function proposalPdfFileName(proposal, index = 0){
    const title = proposalDisplayName(proposal, index).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'proposal';
    return `${title}.pdf`;
  }

  function proposalPlainTextForPdf(value){
    return String(value ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\r/g, '')
      .trim();
  }

  function proposalPagePdfText(page = {}, proposal = {}){
    const kind = String(page.kind || '').toLowerCase();
    const lines = [];
    lines.push(proposalPlainTextForPdf(page.title || page.heading || page.kicker || 'Proposal Page'));
    if (kind === 'pricing') {
      proposalPricingRowsForPage(page, proposal).forEach((item) => {
        lines.push(`${proposalPlainTextForPdf(item.label || item.name || 'Line item')}  ${proposalPlainTextForPdf(item.quantity || '1')}  ${proposalPlainTextForPdf(item.total || item.amount || '')}`);
      });
      if (page.total) lines.push(`Total: ${proposalPlainTextForPdf(page.total)}`);
    } else if (kind === 'signature') {
      lines.push(proposalPlainTextForPdf(page.summary || 'Approval'));
      lines.push(`${proposalPlainTextForPdf(page.depositLabel || 'Deposit')}: ${proposalPlainTextForPdf(page.depositAmount || '$0.00')}`);
      lines.push(`${proposalPlainTextForPdf(page.completionLabel || 'Balance')}: ${proposalPlainTextForPdf(page.completionAmount || '$0.00')}`);
    } else {
      lines.push(proposalPlainTextForPdf(page.summary || page.body || page.description || ''));
      (Array.isArray(page.blocks) ? page.blocks : []).forEach((block) => lines.push(proposalPlainTextForPdf(block.text || block.body || '')));
    }
    if (!lines.some((line) => line.trim())) lines.push(proposalDisplayName(proposal, proposals.indexOf(proposal)));
    return lines.filter((line) => String(line || '').trim()).join('\n\n');
  }

  function wrapPdfLine(text, max = 86){
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    words.forEach((word) => {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= max) current = next;
      else {
        if (current) lines.push(current);
        current = word;
      }
    });
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  function pdfEscape(value){
    return String(value ?? '').replace(/[\\()]/g, '\\$&').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  }

  function proposalLocalPdfBlob(proposal, index = 0){
    const title = proposalDisplayName(proposal, index);
    const paper = proposalPaperDimensions(proposal);
    const pages = (Array.isArray(proposal?.pages) ? proposal.pages : []).filter(proposalPageEnabled);
    const pageTexts = (pages.length ? pages : [{ title, body: 'No visible proposal pages are available.' }])
      .map((page) => proposalPagePdfText(page, proposal));
    const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const addObject = (body) => {
      objects.push(body);
      return objects.length;
    };
    const pageRefs = [];
    pageTexts.forEach((text, pageIndex) => {
      const contentLines = [];
      contentLines.push('BT');
      contentLines.push('/F1 18 Tf');
      contentLines.push(`56 ${Math.max(100, paper.heightPt - 52).toFixed(3)} Td`);
      contentLines.push(`(${pdfEscape(pageIndex === 0 ? title : `Page ${pageIndex + 1}`)}) Tj`);
      contentLines.push('/F1 10 Tf');
      contentLines.push('0 -28 Td');
      String(text || '').split(/\n+/).flatMap((line) => wrapPdfLine(line)).slice(0, 42).forEach((line, lineIndex) => {
        if (lineIndex > 0) contentLines.push('0 -15 Td');
        contentLines.push(`(${pdfEscape(line)}) Tj`);
      });
      contentLines.push('ET');
      const stream = contentLines.join('\n');
      const contentRef = addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageRef = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${paper.widthPt.toFixed(3)} ${paper.heightPt.toFixed(3)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`);
      pageRefs.push(pageRef);
    });
    objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[1] = `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, objectIndex) => {
      offsets.push(pdf.length);
      pdf += `${objectIndex + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Blob([pdf], { type: 'application/pdf' });
  }

  function downloadProposalBlob(blob, proposal, index = 0){
    const objectUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = proposalPdfFileName(proposal, index);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
  }

  function proposalRenderedPageStackHtml(proposal, options = {}){
    const viewMode = options.viewMode || 'preview';
    const includeInsertControls = options.includeInsertControls === true && viewMode === 'edit';
    const renderSections = proposalRenderSections(proposal, { viewMode });
    const measurementInsertAvailable = includeInsertControls && proposalMeasurementInsertAssets().length > 0;
    if (!renderSections.length) {
      return `<div class="r-proposal-empty"><i class="fas fa-eye-slash"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_bf885ce41c4755","All proposal pages are hidden. Re-enable a page from the left column to show it here.") ?? "All proposal pages are hidden. Re-enable a page from the left column to show it here.")}</div>`;
    }
    return renderSections.map((entry, overallIndex) => {
      const pageForRender = { ...(entry.page || {}), __renderLogicalIndex: entry.logicalIndex, __renderStackIndex: overallIndex };
      const fullPageInsert = proposalIsFullPageInsert(pageForRender);
      return `
      <div class="r-proposal-page-stack${includeInsertControls && proposalInsertIndex === entry.logicalIndex ? ' insert-after' : ''}" data-proposal-stack-index="${overallIndex}">
        <section class="r-proposal-page theme-${proposal.theme || 'margin'} kind-${escapeHtml(pageForRender?.kind || 'page')}${fullPageInsert ? ' is-full-replacement' : ''}${options.activePages !== false && entry.logicalIndex === activeProposalPageIndex ? ' is-active' : ''}${overallIndex === 0 ? ' is-cover' : ' is-inner'}" data-proposal-page-index="${entry.logicalIndex}" style="${proposal.theme === 'triangles' && overallIndex !== 0 && !fullPageInsert ? proposalTriangleHeaderVars(pageForRender) : ''}">
          ${fullPageInsert ? '' : '<div class="r-proposal-page-shape-top"></div>'}
          ${!fullPageInsert && proposal.theme === 'margin' && overallIndex === 0 ? `<div class="r-proposal-margin-logo">${proposalBrandLockup('margin', viewMode)}</div>` : ''}
          ${!fullPageInsert && proposal.theme === 'triangles' && overallIndex === 0 ? `<div class="r-proposal-triangle-logo">${proposalBrandLockup('triangles', viewMode, true)}</div>` : ''}
          ${fullPageInsert ? '' : `<div class="r-proposal-page-header">
            ${proposalBrandLockup('clean', viewMode)}
            <div class="r-proposal-page-number">${overallIndex === 0 ? '' : String(overallIndex + 1).padStart(2, '0')}</div>
          </div>`}
          <div class="r-proposal-page-content">
            ${proposalPageMarkup(pageForRender, viewMode)}
          </div>
          ${proposalMarkupHtml(proposal, pageForRender)}
        </section>
        ${includeInsertControls ? `
          <div class="r-proposal-page-insert${String(proposalInsertIndex === entry.logicalIndex ? ' active' : '')}" data-mode="${String(viewMode)}" data-insert-index="${String(entry.logicalIndex)}">
            <button type="button" class="r-proposal-page-insert-btn" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_4d405fa2a01074","Add page") ?? "Add page")}"><i class="fas fa-plus"></i></button>
            <div class="r-proposal-page-insert-picker">
              <div class="r-proposal-page-insert-rail">
                <button type="button" class="r-proposal-page-option" data-page-template="cover"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_03779727637975","Cover") ?? "Cover")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_7c6a9d2904569b","Section intro") ?? "Section intro")}</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="image_text"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_23783e95fc3139","Image & Text") ?? "Image & Text")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_8052ece1e905b8","Custom page") ?? "Custom page")}</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="pricing"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_d9a8c9c7287681","Pricing") ?? "Pricing")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_097dfe4a1638f4","Line items") ?? "Line items")}</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="marketing"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_8e9b5bbafdd085","Marketing") ?? "Marketing")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_2906da0a2eeebe","Brochure insert") ?? "Brochure insert")}</span></button>
                ${String(measurementInsertAvailable ? `<button type="button" class="r-proposal-page-option" data-page-template="measurement_insert"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_8bd65d84aabcd5","FirstMeasure") ?? "FirstMeasure")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ae873abaa56707","Measurements") ?? "Measurements")}</span></button>` : '')}
                <button type="button" class="r-proposal-page-option" data-page-template="signature"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_8625881623433e","Signature") ?? "Signature")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_4b0e87150376c9","Approval page") ?? "Approval page")}</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="fine_print"><div class="r-proposal-page-option-mini"></div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_291c87b6d706e4","Fine Print") ?? "Fine Print")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_03df2498905529","Terms and signature") ?? "Terms and signature")}</span></button>
              </div>
              <button type="button" class="r-proposal-page-insert-close" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_2d70f5e4f9fcd7","Cancel add page") ?? "Cancel add page")}"><i class="fas fa-times"></i></button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
    }).join('');
  }

  function proposalBaseStylesheetText(){
    return document.getElementById('css_request')?.textContent || '';
  }

  function proposalPdfDocumentHtml(proposal, index = 0){
    ensureProposalPageIds(proposal);
    normalizeActiveProposalPage(proposal);
    ensureProposalMarkup(proposal);
    ensureProposalSignatureData(proposal, false);
    const primaryColor = getProposalPrimaryColor();
    const accentColor = getProposalAccentColor();
    const accentReadable = getProposalAccentReadableColor();
    const fontFamily = getProposalFontFamily(proposal);
    const paper = proposalPaperDimensions(proposal);
    const title = escapeHtml(proposalDisplayName(proposal, index));
    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${title}</title>
          <style>
            ${proposalBaseStylesheetText()}
            @page{size:${paper.cssWidth} ${paper.cssHeight};margin:0}
            html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
            body{width:${paper.cssWidth}}
            .r-proposal-pdf-doc{--primary:${primaryColor};--primary-readable:${primaryColor};--primary-rgb:${hexToRgbString(primaryColor)};--accent:${accentColor};--accent-readable:${accentReadable};--accent-rgb:${hexToRgbString(accentReadable)};--accent-soft:${accentColor}66;--proposal-font-family:${proposalFontStack(fontFamily)};background:#fff;color:#111827}
            .r-proposal-pdf-doc .r-proposal-wrap{height:auto;min-height:0;overflow:visible;background:#fff;padding:0}
            .r-proposal-pdf-doc .r-proposal-pages{--proposal-page-scale:1;--proposal-page-base-width:${paper.cssWidth}!important;--proposal-page-base-height:${paper.cssHeight}!important;gap:0;padding:0;align-items:center;background:#fff}
            .r-proposal-pdf-doc .r-proposal-page-stack{width:${paper.cssWidth};height:${paper.cssHeight};margin:0;break-after:page;page-break-after:always;display:flex;justify-content:center;transform:none!important}
            .r-proposal-pdf-doc .r-proposal-page-stack:last-child{break-after:auto;page-break-after:auto}
            .r-proposal-pdf-doc .r-proposal-page{width:${paper.cssWidth};height:${paper.cssHeight};min-height:0;max-height:${paper.cssHeight};max-width:none;aspect-ratio:auto;overflow:hidden;border:0;box-shadow:none;box-sizing:border-box;transform:none!important}
            .r-proposal-pdf-doc .r-proposal-page.is-active{box-shadow:none}
            .r-proposal-pdf-doc .r-proposal-video-player{display:none!important}
            .r-proposal-pdf-doc .r-proposal-video-print-thumbnail{display:block!important;width:100%;height:100%;object-fit:cover}
            .r-proposal-pdf-doc .r-proposal-video-print-fallback{display:block!important;width:100%;height:100%;object-fit:cover}
            .r-proposal-pdf-doc .r-proposal-video-print-placeholder{display:flex!important;width:100%;height:100%;align-items:center;justify-content:center;background:#101828;color:#fff}
            .r-proposal-pdf-doc :is(button,.r-proposal-page-insert,.r-proposal-media-btn,.r-proposal-cover-widthgrab,.r-proposal-cover-heightgrab,.r-proposal-cover-cornergrab,.r-proposal-line-delete,.r-proposal-line-more-wrap,.r-proposal-line-more-menu,.r-proposal-choice-settings-btn,.r-proposal-choice-backdrop,.r-proposal-choice-popover,.r-proposal-page-markup-delete,.r-proposal-page-markup-handle,.r-proposal-signature-option,.r-proposal-payment-options,.r-proposal-marketing-select,.r-proposal-full-select){display:none!important}
            .r-proposal-pdf-doc [contenteditable="true"]{outline:0!important}
          </style>
        </head>
        <body>
          <main class="r-proposal-pdf-doc" data-proposal-paper-size="${paper.key}">
            <div class="r-proposal-wrap">
              <div class="r-proposal-pages" style="${proposalPageCssVariables(proposal)}">
                ${proposalRenderedPageStackHtml(proposal, { viewMode: 'preview', activePages: false })}
              </div>
            </div>
          </main>
          <script>
          (function(){
            window.__proposalPdfCanvasReady = false;
            function loadPdfJs(){
              if (window.pdfjsLib || window['pdfjs-dist/build/pdf']) return Promise.resolve(window.pdfjsLib || window['pdfjs-dist/build/pdf']);
              return new Promise(function(resolve,reject){
                var script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
                script.onload = function(){
                  var lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
                  if (!lib) { reject(new Error('PDF.js unavailable')); return; }
                  lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                  resolve(lib);
                };
                script.onerror = function(){ reject(new Error('Unable to load PDF.js')); };
                document.head.appendChild(script);
              });
            }
            function renderTarget(lib, el){
              var url = el.getAttribute('data-pdf-canvas-url') || '';
              var requested = Math.max(1, Number(el.getAttribute('data-pdf-canvas-page') || 1) || 1);
              if (!url) return Promise.resolve();
              return lib.getDocument({ url: url, withCredentials: true }).promise.then(function(doc){
                return doc.getPage(Math.max(1, Math.min(doc.numPages || requested, requested)));
              }).then(function(page){
                var box = el.getBoundingClientRect();
                var unscaled = page.getViewport({ scale: 1 });
                var scale = Math.max(0.2, Math.min((box.width || 820) / unscaled.width, (box.height || 1061) / unscaled.height, 2.5));
                var viewport = page.getViewport({ scale: scale });
                var canvas = document.createElement('canvas');
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function(){
                  el.innerHTML = '';
                  el.appendChild(canvas);
                });
              }).catch(function(){
                el.innerHTML = '<div class="r-proposal-full-placeholder"><strong>Summary unavailable</strong><span>Could not render this Summary PDF page.</span></div>';
              });
            }
            var targets = Array.prototype.slice.call(document.querySelectorAll('[data-pdf-canvas-url]'));
            if (!targets.length) { window.__proposalPdfCanvasReady = true; return; }
            loadPdfJs().then(function(lib){
              return Promise.all(targets.map(function(el){ return renderTarget(lib, el); }));
            }).finally(function(){ window.__proposalPdfCanvasReady = true; });
          })();
          </script>
        </body>
      </html>`;
  }

  async function proposalBackendPdfUrl(index){
    normalizeProposalCollection();
    let proposal = proposals[index];
    const orgId = projectOrgId();
    if (!proposal || !orgId || !window.ProposalsAPI?.proposals?.generatePdf) return '';
    const saved = await saveProposalToBackend(index, { silent: true, throwOnError: true });
    proposal = saved || proposals[index];
    const proposalId = proposalBackendId(proposal);
    if (!proposalId) return '';
    const result = await window.ProposalsAPI.proposals.generatePdf(orgId, proposalId, {
      store: true,
      title: proposalDisplayName(proposal, index)
    });
    const mediaId = result?.media_ref?.media_id || result?.media?.id || result?.media?.media_id || '';
    proposal.pdf = {
      ...(proposal.pdf && typeof proposal.pdf === 'object' ? proposal.pdf : {}),
      latest_media_id: mediaId || proposal.pdf?.latest_media_id || '',
      latest_media_ref: result?.media_ref || proposal.pdf?.latest_media_ref || null,
      page_count: result?.page_count || proposal.pdf?.page_count || 0
    };
    return window.ProposalsAPI.proposals.pdfUrl(orgId, proposalId, mediaId ? { media_id: mediaId } : {});
  }

  function openProposalPdfUrl(url, proposal, index = 0, download = false){
    if (!url) return false;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    if (download) link.download = proposalPdfFileName(proposal, index);
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  async function downloadProposalPdfUrl(url, proposal, index = 0){
    if (!url) return false;
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include'
    });
    if (!response.ok) {
      const error = new Error(`PDF download failed (${response.status}) ${url}`);
      error.status = response.status;
      error.responseText = await response.text().catch(() => '');
      throw error;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = proposalPdfFileName(proposal, index);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    }
    return true;
  }

  function syncProposalDownloadButtons(){
    document.querySelectorAll('[data-proposal-download]').forEach((btn) => {
      const index = Number(btn.dataset.proposalDownload || 0);
      const loading = proposalPdfDownloadInFlight.has(index);
      btn.disabled = loading;
      btn.classList.toggle('loading', loading);
      btn.dataset.fmTooltip = loading ? 'Generating PDF...' : 'Download PDF';
      btn.innerHTML = loading ? '<i class="fas fa-circle-notch fa-spin"></i>' : '<i class="fas fa-download"></i>';
    });
  }

  async function printProposal(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    try {
      const url = await proposalBackendPdfUrl(index);
      if (!openProposalPdfUrl(url, proposal, index)) throw new Error('The proposal PDF is not available.');
    } catch (error) {
      console.warn('Unable to open proposal PDF for printing', error);
      showToast((globalThis.PlatformLanguage?.text("proposals","m_7b10bb52d50afc","Could not generate proposal PDF") ?? "Could not generate proposal PDF"), error?.message || 'Try again.', false);
    }
  }

  async function downloadProposalPdf(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    if (proposalPdfDownloadInFlight.has(index)) return;
    proposalPdfDownloadInFlight.add(index);
    syncProposalDownloadButtons();
    let backendError = null;
    try {
      try {
        const url = await proposalBackendPdfUrl(index);
        if (await downloadProposalPdfUrl(url, proposals[index] || proposal, index)) {
          showToast((globalThis.PlatformLanguage?.text("proposals","m_8925e2e8ee9078","PDF downloaded") ?? "PDF downloaded"), (globalThis.PlatformLanguage?.text("proposals","m_bc4ca948c69e7d","The generated proposal PDF was downloaded.") ?? "The generated proposal PDF was downloaded."), true);
          return;
        }
      } catch (error) {
        backendError = error;
        console.warn('Proposal PDF generation failed', error);
      }
      if (backendError && proposalsApiRouteMissing(backendError)) {
        const fallbackProposal = proposals[index] || proposal;
        await saveProposalEmbeddedFallback(index);
        downloadProposalBlob(proposalLocalPdfBlob(fallbackProposal, index), fallbackProposal, index);
        showToast((globalThis.PlatformLanguage?.text("proposals","m_8925e2e8ee9078","PDF downloaded") ?? "PDF downloaded"), (globalThis.PlatformLanguage?.text("proposals","m_eb3d3e77f96bcd","The proposals API route is not mounted, so a local PDF was downloaded instead.") ?? "The proposals API route is not mounted, so a local PDF was downloaded instead."), false);
        return;
      }
      if (!backendError) {
        const fallbackProposal = proposals[index] || proposal;
        await saveProposalEmbeddedFallback(index);
        downloadProposalBlob(proposalLocalPdfBlob(fallbackProposal, index), fallbackProposal, index);
        showToast((globalThis.PlatformLanguage?.text("proposals","m_8925e2e8ee9078","PDF downloaded") ?? "PDF downloaded"), (globalThis.PlatformLanguage?.text("proposals","m_fff3fcb171cf23","A local PDF was downloaded because the backend PDF URL was unavailable.") ?? "A local PDF was downloaded because the backend PDF URL was unavailable."), false);
        return;
      }
      showProposalError('Download failed', backendError, 'Could not generate a PDF for this proposal.');
    } finally {
      proposalPdfDownloadInFlight.delete(index);
      syncProposalDownloadButtons();
    }
  }

  function createProposalFromFormAndTrack(source = 'proposal_builder'){
    const proposal = normalizeProposalRecord(buildProposalFromForm(), proposals.length);
    proposals = [...proposals, proposal];
    trackRequestActivity({
      type: 'proposal_started',
      summary: 'Started a proposal',
      target: {
        project_id: activeBaseProject?.id || '',
        project_title: activeBaseProject?.title || proposal.title || proposal.address || '',
        project_address: activeBaseProject?.address || proposal.address || '',
        proposal_id: proposal.id || ''
      },
      metadata: {
        proposal_id: proposal.id || '',
        source
      }
    });
    return proposal;
  }

  function closeSignatureChooser(){
    proposalSignatureModalState = null;
    $('#rSignatureModal')?.classList.remove('active');
    $('#rSignatureModalMount') && ($('#rSignatureModalMount').innerHTML = '');
  }

  function applySignatureToPageSlot(page, slotKey, signer, signature){
    if (!page || !slotKey || !signature) return;
    const session = ensureProposalSigningSession(proposals[activeProposalIndex]);
    session.pageSlots[page.id] ||= {};
    session.pageSlots[page.id][slotKey] = {
      ...signature,
      signer,
      signedAt: proposalTodayText(),
    };
    if (page.kind === 'signature') page.dateValue = proposalTodayText();
  }

  function scrollSigningToTarget(target){
    const wrap = $('#rSigningSheet .r-proposal-wrap');
    const slot = target ? $('#rSigningSheet [data-proposal-page-index="' + target.pageIndex + '"] [data-sign-slot="' + target.slotKey + '"]') : null;
    if (!wrap || !slot) return;
    const wrapRect = wrap.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const nextTop = wrap.scrollTop + (slotRect.top - wrapRect.top) - ((wrap.clientHeight - slotRect.height) / 2);
    wrap.scrollTo({ top: Math.max(0, nextTop), behavior: 'smooth' });
  }

  function openSignatureChooser(page, slotKey, signer){
    const proposal = proposals[activeProposalIndex];
    if (!proposal || !page) return;
    const session = ensureProposalSigningSession(proposal);
    const existingPlaced = session?.pageSlots?.[page.id]?.[slotKey];
    const existingTemplate = session?.signerTemplates?.[signer] || proposalSignatureTemplate(proposal, signer);
    if (existingTemplate && !existingPlaced) {
      applySignatureToPageSlot(page, slotKey, signer, existingTemplate);
      renderSigningOverlay($('#rSigningSheet .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
      return;
    }
    proposalSignatureModalState = {
      pageId: page.id,
      slotKey,
      signer,
      mode: existingTemplate?.type === 'draw' ? 'draw' : 'adopt',
      adoptName: existingTemplate?.text || existingTemplate?.name || proposalSignatureTemplateName(proposal, signer),
      adoptStyle: existingTemplate?.style || 'style-classic',
      drawDataUrl: existingTemplate?.type === 'draw' ? existingTemplate.dataUrl : '',
    };
    renderSignatureChooser();
  }

  function renderSignatureChooser(){
    const modal = $('#rSignatureModal');
    const mount = $('#rSignatureModalMount');
    const state = proposalSignatureModalState;
    if (!modal || !mount) return;
    if (!state) {
      modal.classList.remove('active');
      mount.innerHTML = '';
      return;
    }
    const previewHtml = state.mode === 'draw' && state.drawDataUrl
      ? ("<img src=\"" + String(escapeHtml(state.drawDataUrl)) + "\" alt=\"" + (globalThis.PlatformLanguage?.text("proposals","m_31584781a18ece","Signature preview") ?? "Signature preview") + "\">")
      : `<div class="r-signature-preview-text ${escapeHtml(state.adoptStyle || 'style-classic')}">${escapeHtml(state.adoptName || proposalSignatureTemplateName(proposals[activeProposalIndex], state.signer))}</div>`;
    mount.innerHTML = `
      <div class="r-signature-modal-card">
        <div class="r-signature-modal-top">
          <div>
            <h3 class="r-signature-modal-title">${(globalThis.PlatformLanguage?.htmlText("proposals","m_f621ef7381123f","Choose Your Signature") ?? "Choose Your Signature")}</h3>
            <p class="r-signature-modal-sub">${((v0) => globalThis.PlatformLanguage?.htmlText("proposals","m_79f01ba310c6af",`Create a signature for ${v0} and place it where required.`,{v0}) ?? `Create a signature for ${v0} and place it where required.`)(escapeHtml(state.signer === 'company' ? 'the company representative' : 'the customer'))}</p>
          </div>
          <button type="button" class="r-signature-modal-close" id="rSignatureModalClose"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-signature-modal-body">
          <div class="r-signature-modal-main">
            <div class="r-signature-mode-row">
              <button type="button" class="r-signature-mode-btn${String(state.mode === 'adopt' ? ' active' : '')}" data-signature-mode="adopt"><i class="fas fa-signature"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9da8fd9620e2d7"," Adopt") ?? " Adopt")}</button>
              <button type="button" class="r-signature-mode-btn${String(state.mode === 'draw' ? ' active' : '')}" data-signature-mode="draw"><i class="fas fa-pen-fancy"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_bc8d4740027256"," Draw") ?? " Draw")}</button>
            </div>
            ${String(state.mode === 'adopt' ? `
              <input type="text" class="r-signature-adopt-name" id="rSignatureAdoptName" value="${escapeHtml(state.adoptName || '')}" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_7f88f89133cbc4","Type the signer name") ?? "Type the signer name")}">
              <div class="r-signature-style-grid">
                <button type="button" class="r-signature-style-btn${state.adoptStyle === 'style-classic' ? ' active' : ''}" data-signature-style="style-classic"><div class="r-signature-style-sample style-classic">${escapeHtml(state.adoptName || 'Signature')}</div></button>
                <button type="button" class="r-signature-style-btn${state.adoptStyle === 'style-elegant' ? ' active' : ''}" data-signature-style="style-elegant"><div class="r-signature-style-sample style-elegant">${escapeHtml(state.adoptName || 'Signature')}</div></button>
                <button type="button" class="r-signature-style-btn${state.adoptStyle === 'style-modern' ? ' active' : ''}" data-signature-style="style-modern"><div class="r-signature-style-sample style-modern">${escapeHtml(state.adoptName || 'Signature')}</div></button>
              </div>
            ` : `
              <div class="r-signature-draw-wrap">
                <div class="r-signature-draw-pad" id="rSignatureDrawPad">
                  <div class="r-signature-draw-hint">${(globalThis.PlatformLanguage?.htmlText("proposals","m_16dcd60135fed3","Draw your signature here") ?? "Draw your signature here")}</div>
                  <canvas id="rSignatureDrawCanvas"></canvas>
                </div>
                <div><button type="button" class="r-signature-secondary" id="rSignatureClear">${(globalThis.PlatformLanguage?.htmlText("proposals","m_506191e24dd383","Clear") ?? "Clear")}</button></div>
              </div>
            `)}
          </div>
          <div class="r-signature-side">
            <div>
              <strong style="display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085">${(globalThis.PlatformLanguage?.htmlText("proposals","m_afff48796c3165","Preview") ?? "Preview")}</strong>
              <div class="r-signature-preview-box">${String(previewHtml)}</div>
            </div>
            <div class="r-signature-modal-actions">
              <button type="button" class="r-signature-secondary" id="rSignatureCancel">${(globalThis.PlatformLanguage?.htmlText("proposals","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button>
              <button type="button" class="r-signature-apply" id="rSignatureApply">${(globalThis.PlatformLanguage?.htmlText("proposals","m_616c05f23b9f04","Use Signature") ?? "Use Signature")}</button>
            </div>
          </div>
        </div>
      </section>
    `;
    const syncSignaturePreview = () => {
      const preview = mount.querySelector('.r-signature-preview-box');
      if (!preview) return;
      if (proposalSignatureModalState?.mode === 'draw' && proposalSignatureModalState.drawDataUrl) {
        preview.innerHTML = ("<img src=\"" + String(escapeHtml(proposalSignatureModalState.drawDataUrl)) + "\" alt=\"" + (globalThis.PlatformLanguage?.htmlText("proposals","m_31584781a18ece","Signature preview") ?? "Signature preview") + "\">");
        return;
      }
      preview.innerHTML = `<div class="r-signature-preview-text ${escapeHtml(proposalSignatureModalState?.adoptStyle || 'style-classic')}">${escapeHtml(proposalSignatureModalState?.adoptName || proposalSignatureTemplateName(proposals[activeProposalIndex], proposalSignatureModalState?.signer))}</div>`;
      mount.querySelectorAll('.r-signature-style-sample').forEach((sample) => {
        sample.textContent = proposalSignatureModalState?.adoptName || 'Signature';
      });
    };
    modal.classList.add('active');
    mount.querySelector('#rSignatureModalClose')?.addEventListener('click', closeSignatureChooser);
    mount.querySelector('#rSignatureCancel')?.addEventListener('click', closeSignatureChooser);
    mount.querySelectorAll('[data-signature-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        proposalSignatureModalState.mode = btn.dataset.signatureMode || 'adopt';
        renderSignatureChooser();
      });
    });
    mount.querySelector('#rSignatureAdoptName')?.addEventListener('input', (evt) => {
      proposalSignatureModalState.adoptName = evt.target.value;
      syncSignaturePreview();
    });
    mount.querySelectorAll('[data-signature-style]').forEach((btn) => {
      btn.addEventListener('click', () => {
        proposalSignatureModalState.adoptStyle = btn.dataset.signatureStyle || 'style-classic';
        mount.querySelectorAll('[data-signature-style]').forEach((item) => item.classList.toggle('active', item === btn));
        syncSignaturePreview();
      });
    });
    const canvas = mount.querySelector('#rSignatureDrawCanvas');
    if (canvas) {
      const wrap = mount.querySelector('#rSignatureDrawPad');
      const ctx = canvas.getContext('2d');
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(320, Math.floor((wrap?.clientWidth || 640) - 2));
      const height = Math.max(220, Math.floor((wrap?.clientHeight || 300) - 2));
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.scale(ratio, ratio);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 2.4;
      if (state.drawDataUrl) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, width, height);
        img.src = state.drawDataUrl;
      }
      let drawing = false;
      const pointOf = (evt) => {
        const rect = canvas.getBoundingClientRect();
        return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
      };
      const start = (evt) => {
        drawing = true;
        const point = pointOf(evt);
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
      };
      const move = (evt) => {
        if (!drawing) return;
        const point = pointOf(evt);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        proposalSignatureModalState.drawDataUrl = canvas.toDataURL('image/png');
        syncSignaturePreview();
      };
      const end = () => {
        drawing = false;
        proposalSignatureModalState.drawDataUrl = canvas.toDataURL('image/png');
        syncSignaturePreview();
      };
      canvas.addEventListener('pointerdown', start);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointerleave', end);
      mount.querySelector('#rSignatureClear')?.addEventListener('click', () => {
        ctx.clearRect(0, 0, width, height);
        proposalSignatureModalState.drawDataUrl = '';
        syncSignaturePreview();
      });
    }
    mount.querySelector('#rSignatureApply')?.addEventListener('click', () => {
      const proposal = proposals[activeProposalIndex];
      const modalState = proposalSignatureModalState;
      const session = ensureProposalSigningSession(proposal);
      const page = proposal?.pages?.find((entry) => entry.id === modalState?.pageId);
      if (!proposal || !modalState || !page) return;
      const signature = modalState.mode === 'draw'
        ? (modalState.drawDataUrl ? { type: 'draw', dataUrl: modalState.drawDataUrl, name: proposalSignatureTemplateName(proposal, modalState.signer) } : null)
        : { type: 'adopt', text: modalState.adoptName || proposalSignatureTemplateName(proposal, modalState.signer), name: modalState.adoptName || proposalSignatureTemplateName(proposal, modalState.signer), style: modalState.adoptStyle || 'style-classic' };
      if (!signature) return;
      session.signerTemplates[modalState.signer] = { ...signature };
      applySignatureToPageSlot(page, modalState.slotKey, modalState.signer, signature);
      ensureProposalSignatureData(proposal, true);
      closeSignatureChooser();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      renderSigningOverlay($('#rSigningSheet .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
    });
  }

  function closeProposalPricebookSuggest(){
    proposalPricebookSuggest?.remove?.();
    proposalPricebookSuggest = null;
  }

  function applyPricebookItemToRow(pageIndex, itemIndex, itemId){
    const proposal = proposals[activeProposalIndex];
    const page = proposal?.pages?.[pageIndex];
    if (!proposal || !page || page.kind !== 'pricing') return;
    const scopeRow = proposalPricingRowsForPage(page, proposal, { includeDisabledRows: proposalEditorMode === 'edit' })[itemIndex];
    const nextScope = buildLinkedPricebookScopeItem(itemId, proposal);
    if (scopeRow?.__scopeItemId && nextScope) {
      replaceProposalScopeItem(proposal, scopeRow.__scopeItemId, nextScope);
      recomputeProposalPricing(page, proposal);
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
      return;
    }
    const next = buildLinkedPricebookLineItem(itemId, proposal);
    if (!next) return;
    page.lineItems = (page.lineItems || []).map((item, index) => index === itemIndex ? { ...next } : item);
    recomputeProposalPricing(page, proposal);
    renderProposalSection();
    renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
    queueAutosaveNotice();
  }

  function showProposalPricebookSuggest(field, pageIndex, itemIndex){
    const pricebook = getPricebookModule();
    if (!pricebook?.getSuggestions) return;
    const query = (field.textContent || '').trim();
    const suggestions = pricebook.getSuggestions(query).slice(0, 6);
    if (!suggestions.length) {
      closeProposalPricebookSuggest();
      return;
    }
    closeProposalPricebookSuggest();
    const rect = field.getBoundingClientRect();
    const mount = document.createElement('div');
    mount.className = 'r-pricebook-suggest';
    mount.innerHTML = `
      <div class="r-pricebook-suggest-head">
        <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a144b901b1559e","Pricebook Items") ?? "Pricebook Items")}</strong>
        <button type="button" class="r-proposal-pricebook-btn" data-open-pricebook-inline="true"><i class="fas fa-book"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_b4cc6d9b173a93"," Edit") ?? " Edit")}</button>
      </div>
      <div class="r-pricebook-suggest-list">
        ${String(suggestions.map((item) => `<button type="button" class="r-pricebook-suggest-item" data-pricebook-item="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.formula)} · $${Number(item.unitPrice || 0).toFixed(2)} / ${escapeHtml(item.unit)}</span></button>`).join(''))}
      </div>
    `;
    mount.style.left = `${Math.max(16, Math.min(window.innerWidth - 376, rect.left))}px`;
    mount.style.top = `${Math.min(window.innerHeight - 320, rect.bottom + 8)}px`;
    mount.addEventListener('mousedown', (e) => e.preventDefault());
    mount.querySelectorAll('[data-pricebook-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyPricebookItemToRow(pageIndex, itemIndex, btn.dataset.pricebookItem);
        closeProposalPricebookSuggest();
      });
    });
    mount.querySelector('[data-open-pricebook-inline]')?.addEventListener('click', () => {
      openProposalPricebookEditor();
      closeProposalPricebookSuggest();
    });
    document.body.appendChild(mount);
    proposalPricebookSuggest = mount;
  }

  function openProposalPricebookEditor(){
    const pricebook = getPricebookModule();
    if (!pricebook?.open) return;
    const proposal = proposals[activeProposalIndex];
    pricebook.open(proposalPricebookOpenState(proposal));
  }

  function proposalListMoreMenuHtml(proposal, index, id, locked = false){
    const isOpen = proposalListMenuProposalId === id;
    const isExpired = proposalIsExpired(proposal);
    const wasSent = !!(proposal.sent_at || proposal.delivery?.sent_at || ['sent', 'viewed', 'signed', 'expired'].includes(String(proposal.status || '').toLowerCase()));
    const deleteConfirm = proposalDeleteConfirmProposalId === id;
    return `<span class="r-proposal-more-wrap">
      <button type="button" data-proposal-more="${index}" data-fm-tooltip="More"><i class="fas fa-ellipsis"></i></button>
      ${isOpen ? `<div class="r-proposal-more-menu">
        ${wasSent && !locked ? `<button type="button" data-proposal-unsend="${String(index)}"><i class="fas fa-eye-slash"></i><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_c7e03d62b71812","Unsend") ?? "Unsend")}</span></button>` : ''}
        ${isExpired && !locked ? `<button type="button" data-proposal-recent="${String(index)}"><i class="fas fa-clock-rotate-left"></i><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_fec172c2f71d24","Recent") ?? "Recent")}</span></button>` : ''}
        <button type="button" class="danger ${deleteConfirm ? 'confirm' : ''}" data-proposal-delete="${index}"><i class="fas fa-trash"></i><span>${deleteConfirm ? 'Confirm delete' : 'Delete'}</span></button>
      </div>` : ''}
    </span>`;
  }

  function renderProposalListSection(section, label, list){
    normalizeProposalCollection();
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    if (section) {
      section.classList.toggle('visible', visible);
      section.classList.remove('mode-list', 'mode-edit', 'mode-send');
      section.classList.add('mode-list');
    }
    if (label) label.hidden = visible;
    // The left region container is SHARED with other tabs (comms takes it
    // over on the Comms tab). Only paint proposal cards into it while the
    // proposal workspace is actually showing — rendering while hidden both
    // leaks proposal cards into other tabs and wipes their content.
    if (!visible) return;
    list.innerHTML = `
      <div class="r-proposal-workspace-head">
        <div>
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_3129f3f0e39249","Proposals") ?? "Proposals")}</strong>
          <span>${String(proposals.length ? `${proposals.length} saved for this project` : 'Create proposal variants for this project')}</span>
        </div>
        <button type="button" class="r-proposal-settings-link" id="rProposalSettingsOpen"><i class="fas fa-gear"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ddb7c9bb87ac18"," Settings") ?? " Settings")}</button>
      </div>
      <button type="button" class="r-proposal-add-card" id="rProposalCreateNew">
        <i class="fas fa-plus"></i>
        <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ec4e891c415879","Create New Proposal") ?? "Create New Proposal")}</span>
      </button>
      <div class="r-proposal-list-view">
        ${String(proposals.length ? proposals.map((proposal, index) => {
          const id = proposalStableId(proposal, index);
          const isActive = index === activeProposalIndex;
          const locked = proposalDeliveryStatus(proposal) === 'signed' || String(proposal.status || '').toLowerCase() === 'signed' || proposal.editable === false || proposal.locked === true;
          return `
            <div class="r-proposal-list-card${isActive ? ' active' : ''}" data-proposal-select="${index}" role="button" tabindex="0">
              <div class="r-proposal-list-main">
                <strong>${escapeHtml(proposalDisplayName(proposal, index))}</strong>
                <span>${escapeHtml(proposal.createdAt || proposal.created_at || 'Draft')}</span>
              </div>
              <div class="r-proposal-list-side">
                ${proposalStatusBadgesHtml(proposal)}
                <div class="r-proposal-list-actions">
                  <button type="button" ${locked ? 'disabled' : `data-proposal-edit="${index}"`} data-fm-tooltip="${locked ? 'Signed proposals require a change order' : 'Edit'}"><i class="fas fa-pen"></i></button>
                  <button type="button" data-proposal-download="${index}" data-fm-tooltip="Download PDF"><i class="fas fa-download"></i></button>
                  <button type="button" data-proposal-print="${index}" data-fm-tooltip="Print"><i class="fas fa-print"></i></button>
                  <button type="button" data-proposal-copy="${index}" data-fm-tooltip="Duplicate"><i class="fas fa-copy"></i></button>
                  <button type="button" ${locked ? 'disabled' : `data-proposal-send="${index}"`} data-fm-tooltip="${locked ? 'Signed proposals require a change order' : 'Send'}"><i class="fas fa-paper-plane"></i></button>
                  ${proposalListMoreMenuHtml(proposal, index, id, locked)}
                </div>
              </div>
            </div>
          `;
        }).join('') : `
          <div class="r-proposal-empty-list">
            <i class="fas fa-file-signature"></i>
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_b5828f5fd0c36d","No proposals yet") ?? "No proposals yet")}</strong>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_7feb0c701cff3e","Create the first draft, then duplicate it when you want variants.") ?? "Create the first draft, then duplicate it when you want variants.")}</span>
          </div>
        `)}
      </div>
    `;
    list.querySelector('#rProposalCreateNew')?.addEventListener('click', createNewProposalAndEdit);
    list.querySelector('#rProposalSettingsOpen')?.addEventListener('click', () => {
      openProposalSettingsPanel();
    });
    list.querySelectorAll('[data-proposal-select]').forEach((card) => {
      card.addEventListener('click', () => {
        clearProposalSettingsPanel();
        activeProposalIndex = Number(card.dataset.proposalSelect || 0);
        proposalEditorMode = 'preview';
        syncProposalRoute('list');
        proposalDeleteConfirmProposalId = null;
        proposalListMenuProposalId = '';
        renderProposalSection();
        renderProposalPreview();
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        card.click();
      });
    });
    list.querySelectorAll('[data-proposal-edit]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        enterProposalEditMode(Number(btn.dataset.proposalEdit || 0));
      });
    });
    list.querySelectorAll('[data-proposal-copy]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        duplicateProposal(Number(btn.dataset.proposalCopy || 0));
      });
    });
    list.querySelectorAll('[data-proposal-download]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        downloadProposalPdf(Number(btn.dataset.proposalDownload || 0));
      });
    });
    list.querySelectorAll('[data-proposal-print]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        printProposal(Number(btn.dataset.proposalPrint || 0));
      });
    });
    list.querySelectorAll('[data-proposal-send]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(btn.dataset.proposalSend || 0);
        activeProposalIndex = index;
        proposalListMenuProposalId = '';
        enterProposalSendMode('list', [proposalStableId(proposals[index], index)]);
      });
    });
    list.querySelectorAll('[data-proposal-more]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const index = Number(btn.dataset.proposalMore || 0);
        const proposal = proposals[index];
        const id = proposalStableId(proposal, index);
        proposalListMenuProposalId = proposalListMenuProposalId === id ? '' : id;
        proposalDeleteConfirmProposalId = null;
        renderProposalSection();
      });
    });
    list.querySelectorAll('[data-proposal-unsend]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        unsendProposal(Number(btn.dataset.proposalUnsend || 0));
      });
    });
    list.querySelectorAll('[data-proposal-recent]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        markProposalRecent(Number(btn.dataset.proposalRecent || 0));
      });
    });
    list.querySelectorAll('[data-proposal-delete]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeProposal(Number(btn.dataset.proposalDelete || 0));
      });
    });
  }

  function proposalBuilderTemplateTile(template, options = {}){
    const style = `--scope-color:${escapeHtml(proposalBuilderTemplateColor(template))}`;
    const selectedCount = proposalBuilderSelectedPieces().filter((piece) => piece.templateId === template.id).length;
    return `
      <div class="r-builder-project-type-tile${String(template.manual ? ' manual' : '')}${String(options.compact ? ' compact' : '')}${String(selectedCount ? ' selected' : '')}" style="${String(style)}">
        <button type="button" class="r-builder-template-info" data-builder-template-info="${String(escapeHtml(template.id))}" aria-label="${((v5) => globalThis.PlatformLanguage?.htmlText("proposals","m_9abbf702a7be6b",`More information about ${v5}`,{v5}) ?? `More information about ${v5}`)(escapeHtml(template.name))}"><i class="fas fa-circle-info"></i></button>
        <button type="button" class="r-builder-template-add" data-builder-add-template="${String(escapeHtml(template.id))}" aria-pressed="${String(selectedCount ? 'true' : 'false')}">
          <span class="r-builder-type-icon"><i class="fas ${String(escapeHtml(template.icon || 'fa-file-lines'))}"></i></span>
          <strong>${String(escapeHtml(template.name))}</strong>
          <span>${String(escapeHtml(template.description || ''))}</span>
          ${String(selectedCount ? `<em class="r-builder-template-selected"><i class="fas fa-check"></i>${selectedCount}</em>` : '')}
        </button>
      </div>
    `;
  }

  function ensureProposalBuilderAnimationStyles(){
    injectCSS('proposal-builder-animations', `
      @keyframes rBuilderPaneIn{from{opacity:0;transform:translateY(14px) scale(.992)}to{opacity:1;transform:translateY(0) scale(1)}}
      @keyframes rBuilderSearchIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
      .r-builder-wrap{background:#f3f6f9;overflow:hidden}
      .r-builder-step-pane{animation:rBuilderPaneIn .32s cubic-bezier(.22,1,.36,1) both}
      .r-builder-no-pane-animation .r-builder-step-pane{animation:none}
      .r-builder-picker-shell{height:100%;min-height:0;display:flex;flex-direction:column;gap:0}
      .r-builder-template-toolbar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:2px 2px 18px;border-bottom:1px solid rgba(15,23,42,.09)}
      .r-builder-template-title{min-width:0;display:grid;gap:4px}
      .r-builder-template-title strong{font-size:20px;font-weight:1000;line-height:1.15;color:#101828}
      .r-builder-template-title span{font-size:11px;font-weight:800;line-height:1.35;color:#667085}
      .r-builder-template-search{width:min(340px,48%);height:40px;flex:0 1 340px;border:1px solid rgba(15,23,42,.14);border-radius:10px;background:#fff;display:flex;align-items:center;gap:9px;padding:0 12px;color:#98a2b3;box-sizing:border-box}
      .r-builder-template-search:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.10)}
      .r-builder-template-search input{width:100%;min-width:0;border:0;background:transparent;padding:0;font-size:12px;font-weight:850;color:#111827;outline:none}
      .r-builder-template-search input::placeholder{color:#98a2b3}
      .r-builder-template-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:18px 2px 24px}
      .r-builder-template-quick-label{display:flex;align-items:center;gap:7px;margin-bottom:10px;font-size:10px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase;color:#667085}
      .r-builder-template-quick-label i{color:var(--primary,#d93025)}
      .r-builder-template-divider{height:1px;background:rgba(15,23,42,.10);margin:18px 0}
      .r-builder-template-empty{grid-column:1/-1;padding:34px 16px;border:1px dashed rgba(15,23,42,.16);border-radius:10px;background:#f8fafc;text-align:center;color:#667085;font-size:12px;font-weight:850}
      .r-builder-step-pane .r-builder-template-grid{grid-template-columns:repeat(auto-fit,minmax(150px,190px))!important;justify-content:start;align-items:stretch;gap:10px}
      .r-builder-project-type-tile{position:relative;min-height:146px;border:1px solid rgba(15,23,42,.08);border-top:4px solid var(--scope-color,var(--primary,#d93025));border-radius:8px;background:#fff;box-shadow:0 8px 18px rgba(15,23,42,.045);overflow:hidden;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
      .r-builder-project-type-tile:hover{transform:translateY(-1px);border-color:rgba(15,23,42,.16);box-shadow:0 14px 26px rgba(15,23,42,.08)}
      .r-builder-template-add{width:100%;height:100%;min-height:142px;border:0;background:transparent;color:#111827;text-align:left;padding:14px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;cursor:pointer}
      .r-builder-template-add:focus-visible{outline:2px solid var(--scope-color,var(--primary,#d93025));outline-offset:-2px;border-radius:5px}
      .r-builder-template-add strong{font-size:12px;font-weight:1000;line-height:1.2;padding-right:28px;color:#111827}
      .r-builder-template-add span:not(.r-builder-type-icon){font-size:10.5px;font-weight:800;line-height:1.35;color:#667085;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .r-builder-type-icon{width:30px;height:30px;border-radius:8px;background:color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 14%,#fff);color:var(--scope-color,var(--primary,#d93025));display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex:0 0 auto}
      .r-builder-template-info{position:absolute;top:9px;right:9px;z-index:2;width:28px;height:28px;border:1px solid rgba(15,23,42,.10);border-radius:999px;background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .r-builder-template-info:hover{border-color:var(--scope-color,var(--primary,#d93025));color:var(--scope-color,var(--primary,#d93025))}
      .r-builder-active-scope{border:1px solid rgba(15,23,42,.10);border-radius:10px;background:#fff;padding:12px;display:grid;gap:12px;min-height:0}
      .r-builder-active-scope.empty{align-content:start;color:#667085;background:#fff}
      .r-builder-scope-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:10px;border-bottom:1px solid rgba(15,23,42,.08)}
      .r-builder-scope-heading-copy{min-width:0;display:grid;gap:2px}
      .r-builder-scope-heading-copy strong{font-size:12px;font-weight:1000;color:#111827}
      .r-builder-scope-heading-copy span{font-size:10px;font-weight:850;color:#667085}
      .r-builder-scope-build{min-width:0;height:38px;border:1px solid var(--primary,#d93025);border-radius:9px;background:var(--primary,#d93025);color:#fff;padding:0 13px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-size:11px;font-weight:1000;white-space:nowrap;cursor:pointer;box-shadow:0 7px 16px rgba(var(--primary-rgb,217,48,37),.18)}
      .r-builder-scope-build:hover:not(:disabled){filter:brightness(.96);transform:translateY(-1px)}
      .r-builder-scope-build:disabled{border-color:#d0d5dd;background:#eaecf0;color:#98a2b3;box-shadow:none;cursor:not-allowed}
      .r-builder-scope-empty{display:grid;gap:5px;justify-items:center}
      .r-builder-scope-empty i{width:34px;height:34px;border-radius:999px;background:#eef2f6;color:#667085;display:inline-flex;align-items:center;justify-content:center}
      .r-builder-scope-empty strong{font-size:13px;font-weight:1000;color:#344054}
      .r-builder-scope-empty span{font-size:11px;font-weight:850;color:#667085}
      .r-builder-active-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,190px));gap:10px;align-items:stretch;justify-content:start}
      .r-builder-active-piece{position:relative;min-height:118px;border:1px solid rgba(15,23,42,.08);border-top:4px solid var(--scope-color,var(--primary,#d93025));border-radius:8px;background:#fff;box-shadow:0 8px 18px rgba(15,23,42,.045);padding:13px 12px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
      .r-builder-active-piece i:not(.fa-xmark){width:30px;height:30px;border-radius:8px;background:color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 14%,#fff);color:var(--scope-color,var(--primary,#d93025));display:inline-flex;align-items:center;justify-content:center;font-size:13px}
      .r-builder-active-piece strong{font-size:12px;font-weight:1000;color:#111827;line-height:1.2;padding-right:26px}
      .r-builder-active-piece span{font-size:10.5px;font-weight:850;color:#667085;line-height:1.35;text-transform:none}
      .r-builder-remove-piece{width:28px;height:28px;border:1px solid rgba(15,23,42,.10);border-radius:999px;background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .r-builder-active-piece .r-builder-remove-piece{position:absolute;top:9px;right:9px}
      .r-builder-remove-piece:hover{border-color:#fecaca;color:#b42318;background:#fff5f5}
      .r-builder-sidebar-shell{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px}
      .r-builder-picker-sidebar-head{padding-bottom:4px}
      .r-builder-picker-sidebar-head strong{font-size:18px!important;line-height:1.15}
      .r-builder-picker-sidebar-head>div{align-self:center}
      .r-builder-sidebar-shell>.r-builder-active-scope{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;padding-right:calc(12px + var(--fm-scrollbar-content-gap,10px));scrollbar-gutter:stable}
      .r-builder-sidebar-shell .r-builder-active-list{grid-template-columns:1fr}
      .r-builder-sidebar-shell .r-builder-active-piece{min-height:64px;padding:10px;display:grid;grid-template-columns:30px minmax(0,1fr) 28px;grid-template-rows:auto auto;column-gap:9px;row-gap:2px;align-items:center}
      .r-builder-sidebar-shell .r-builder-active-piece>i{grid-row:1/3}
      .r-builder-sidebar-shell .r-builder-active-piece strong{grid-column:2;grid-row:1;padding-right:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-builder-sidebar-shell .r-builder-active-piece>span{grid-column:2;grid-row:2}
      .r-builder-sidebar-shell .r-builder-active-piece .r-builder-remove-piece{position:static;grid-column:3;grid-row:1/3}
      .r-builder-sidebar-shell .r-builder-scope-empty{min-height:150px;align-content:center;padding:12px}
      .r-builder-sidebar-list{display:flex;flex-direction:column;gap:0;min-height:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;padding-right:var(--fm-scrollbar-content-gap,10px);border-top:1px solid rgba(15,23,42,.08);scrollbar-gutter:stable}
      .r-builder-sidebar-footer{flex:0 0 auto;margin-top:auto;padding-top:10px;border-top:1px solid rgba(15,23,42,.09);background:#fff;display:grid;gap:9px}
      .r-builder-sidebar-actions{position:static;margin:0;padding:0;background:transparent;display:grid;gap:8px}
      .r-builder-scope-total{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:0 2px;color:#475467}
      .r-builder-scope-total span{font-size:10px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase}
      .r-builder-scope-total strong{font-size:14px;font-weight:1000;color:#101828;white-space:nowrap}
      .r-builder-scope-total.compact{padding:0;gap:6px;display:grid;align-items:start}
      .r-builder-scope-total.compact span{font-size:9px;letter-spacing:.04em}
      .r-builder-scope-total.compact strong{font-size:12px;line-height:1.15;color:#101828}
      .r-builder-main-actions{position:sticky;bottom:0;margin-top:auto;padding:12px 0 0;background:linear-gradient(to bottom,rgba(243,246,249,0),#f3f6f9 12px);display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:3}
      .r-builder-main-actions .r-proposal-template-action{width:auto;min-width:120px}
      .r-builder-main-actions .r-proposal-template-action.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
      .r-builder-sidebar-section{border-bottom:1px solid rgba(15,23,42,.08);background:#fff}
      .r-builder-sidebar-section-head{width:100%;border:0;background:#fff;padding:9px 0 9px 8px;text-align:left;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;cursor:pointer;border-left:4px solid var(--scope-color,var(--primary,#d93025))}
      .r-builder-sidebar-section-head strong{font-size:11px;font-weight:1000;color:#111827;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-builder-sidebar-section-head span{font-size:10px;font-weight:900;text-transform:none;color:#667085;display:inline-flex;align-items:center;gap:6px}
      .r-builder-sidebar-substeps{display:grid;gap:0;padding:0 0 6px 12px}
      .r-builder-sidebar-step{width:100%;border:0;border-left:2px solid transparent;background:#fff;padding:7px 7px 7px 8px;text-align:left;display:grid;grid-template-columns:20px minmax(0,1fr);gap:7px;align-items:center;cursor:pointer}
      .r-builder-sidebar-step.active{border-left-color:var(--scope-color,var(--primary,#d93025));background:color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 8%,#fff)}
      .r-builder-sidebar-step:hover{background:#f8fafc}
      .r-builder-sidebar-step-mark{width:20px;height:20px;border-radius:999px;background:#eef2f6;color:#667085;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:1000}
      .r-builder-sidebar-step.active .r-builder-sidebar-step-mark{background:var(--scope-color,var(--primary,#d93025));color:#fff}
      .r-builder-sidebar-step.done .r-builder-sidebar-step-mark{background:#12b76a;color:#fff}
      .r-builder-sidebar-step strong{font-size:11px;font-weight:950;color:#111827;line-height:1.22;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .r-builder-sidebar-step span{font-size:9.5px;font-weight:800;color:#667085;text-transform:none}
      .r-builder-section-menu-btn{width:26px;height:26px;border:1px solid rgba(15,23,42,.08);border-radius:999px;background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .r-builder-section-menu-btn:hover{border-color:rgba(15,23,42,.18);color:#344054}
      .r-builder-section-menu-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center}
      .r-builder-section-menu{position:absolute;right:0;top:30px;z-index:20;width:170px;border:1px solid rgba(15,23,42,.10);border-radius:8px;background:#fff;box-shadow:0 18px 40px rgba(15,23,42,.16);padding:6px;display:grid;gap:4px}
      .r-builder-section-menu button{height:34px;border:0;border-radius:6px;background:#fff;color:#344054;text-align:left;padding:0 9px;font-size:11px;font-weight:900;cursor:pointer}
      .r-builder-section-menu button:hover{background:#f8fafc}
      .r-builder-section-menu button.danger{color:#b42318}
      .r-builder-section-fields{display:grid;gap:12px;border:1px solid rgba(15,23,42,.08);border-radius:8px;background:#f8fafc;padding:12px;margin-bottom:12px}
      .r-builder-section-name label{display:block;font-size:11px;font-weight:900;color:#667085;margin-bottom:6px}
      .r-builder-section-name input{width:100%;height:38px;border:1px solid rgba(15,23,42,.14);border-radius:8px;background:#fff;color:#111827;padding:0 11px;font-size:13px;font-weight:900;outline:none;box-sizing:border-box}
      .r-builder-structure-actions{display:flex;justify-content:flex-end;gap:8px}
      .r-builder-structure-action{height:32px;border:1px solid rgba(15,23,42,.10);border-radius:8px;background:#fff;color:#344054;padding:0 10px;font-size:11px;font-weight:900;display:inline-flex;align-items:center;gap:7px;cursor:pointer}
      .r-builder-structure-action:hover{border-color:rgba(15,23,42,.18);background:#f8fafc}
      .r-builder-structure-action.danger{color:#b42318}
      .r-builder-structure-warning{font-size:11px;font-weight:900;color:#b42318;background:#fff1f3;border:1px solid #fecdd3;border-radius:8px;padding:7px 9px;line-height:1.35}
      .r-builder-info-backdrop{position:absolute;inset:0;z-index:80;background:rgba(15,23,42,.36);display:flex;align-items:center;justify-content:center;padding:20px}
      .r-builder-info-modal{width:min(720px,100%);max-height:min(760px,calc(100vh - 40px));overflow:auto;border-radius:10px;background:#fff;box-shadow:0 30px 80px rgba(15,23,42,.24);border:1px solid rgba(15,23,42,.10);display:grid;grid-template-columns:minmax(190px,.75fr) minmax(0,1.25fr)}
      .r-builder-info-workflow{padding:16px;border-right:1px solid rgba(15,23,42,.08);background:#f8fafc}
      .r-builder-info-workflow strong,.r-builder-info-copy strong{font-size:13px;font-weight:1000;color:#111827}
      .r-builder-info-steps{margin:12px 0 0;padding:0;list-style:none;display:grid;gap:7px}
      .r-builder-info-steps li{display:grid;grid-template-columns:22px 1fr;gap:7px;align-items:start;font-size:11px;font-weight:850;color:#475467;line-height:1.25}
      .r-builder-info-steps em{width:22px;height:22px;border-radius:999px;background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:10px;font-weight:1000;border:1px solid rgba(15,23,42,.08)}
      .r-builder-info-copy{padding:16px;display:grid;gap:12px;align-content:start}
      .r-builder-info-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
      .r-builder-info-title{display:flex;align-items:center;gap:10px;min-width:0}
      .r-builder-info-title i{width:34px;height:34px;border-radius:9px;background:color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 14%,#fff);color:var(--scope-color,var(--primary,#d93025));display:inline-flex;align-items:center;justify-content:center}
      .r-builder-info-title span{display:block;font-size:11px;font-weight:850;color:#667085;text-transform:none;margin-top:2px}
      .r-builder-info-close{width:32px;height:32px;border:1px solid rgba(15,23,42,.10);border-radius:999px;background:#fff;color:#667085;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
      .r-builder-info-copy p{margin:0;font-size:12px;font-weight:850;line-height:1.55;color:#475467}
      .r-builder-info-add{height:38px;border:0;border-radius:8px;background:var(--scope-color,var(--primary,#d93025));color:#fff;font-size:12px;font-weight:1000;cursor:pointer}
      @media(max-width:720px){.r-builder-info-modal{grid-template-columns:1fr}.r-builder-info-workflow{border-right:0;border-bottom:1px solid rgba(15,23,42,.08)}}
      .r-builder-step-pane .r-builder-template-grid .r-proposal-template-card{min-height:118px;border-radius:8px;padding:13px 12px;justify-content:flex-start;gap:8px;box-shadow:0 8px 18px rgba(15,23,42,.045)}
      .r-builder-step-pane .r-builder-template-grid .r-proposal-template-card strong{display:flex;flex-direction:column;align-items:flex-start;gap:8px;font-size:12px;line-height:1.2}
      .r-builder-step-pane .r-builder-template-grid .r-proposal-template-card strong i{width:30px;height:30px;border-radius:8px;background:#f2f4f7;color:#475467;display:inline-flex;align-items:center;justify-content:center;font-size:13px}
      .r-builder-step-pane .r-builder-template-grid .r-proposal-template-card.manual strong i{background:rgba(var(--primary-rgb,217,48,37),.12);color:var(--primary-readable,var(--primary,#d93025))}
      .r-builder-step-pane .r-builder-template-grid .r-proposal-template-card span{position:static;opacity:1;transform:none;pointer-events:auto;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;font-size:10.5px;line-height:1.35;color:#667085}
      .r-builder-choice-card,.r-builder-option-tile{transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .22s ease,border-color .18s ease,background .18s ease,color .18s ease}
      .r-builder-choice-card:hover,.r-builder-option-tile:hover{transform:translateY(-2px);box-shadow:0 18px 32px rgba(15,23,42,.1)!important}
      .r-builder-choice-card{border:1px solid rgba(15,23,42,.12);background:#fff;border-radius:18px;padding:14px;display:flex;flex-direction:column;gap:12px;box-shadow:0 8px 18px rgba(15,23,42,.035);opacity:1}
      .r-builder-choice-card.customer-visible{border-color:rgba(var(--primary-rgb,217,48,37),.24);background:rgba(var(--primary-rgb,217,48,37),.045);opacity:1;box-shadow:0 12px 24px rgba(15,23,42,.06)}
      .r-builder-choice-card.active{transform:translateY(-1px);border-color:rgba(var(--primary-rgb,217,48,37),.7);background:rgba(var(--primary-rgb,217,48,37),.13);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.18),0 18px 34px rgba(15,23,42,.11);opacity:1}
      .r-builder-choice-card:not(.customer-visible):not(.active) .r-builder-choice-main strong,.r-builder-choice-card:not(.customer-visible):not(.active) .r-builder-choice-main span,.r-builder-choice-card:not(.customer-visible):not(.active) .r-builder-choice-main .r-builder-choice-price{color:#98a2b3!important}
      .r-builder-choice-main{border:0;background:transparent;padding:0;text-align:left;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;cursor:pointer}
      .r-builder-choice-card.has-mark .r-builder-choice-main{grid-template-columns:38px minmax(0,1fr) auto}
      .r-builder-choice-mark{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;color:#667085;font-size:16px;font-weight:1000;overflow:hidden}
      .r-builder-choice-mark.brand-gaf{background:#d71920;color:#fff;font-size:13px;letter-spacing:.02em}
      .r-builder-choice-mark.brand-owens-corning{background:#c8102e;color:#fff;font-size:12px;letter-spacing:.02em}
      .r-builder-choice-mark.brand-malarkey{background:#fff}
      .r-builder-choice-mark.brand-certainteed{background:#fff}
      .r-builder-choice-mark[class*="brand-"]{border-radius:0;background:transparent;overflow:visible}
      .r-builder-choice-mark img{width:100%;height:100%;object-fit:contain;display:block}
      .r-builder-choice-card:not(.customer-visible):not(.active) .r-builder-choice-mark{opacity:.45;filter:grayscale(1)}
      .r-builder-choice-state{font-size:10px;font-weight:850;text-transform:none;letter-spacing:0;color:#98a2b3}
      .r-builder-choice-card.customer-visible .r-builder-choice-state{color:var(--primary,#d93025)}
      .r-builder-choice-card.active .r-builder-choice-state{color:#9f1f17}
      .r-builder-search-panel{animation:rBuilderSearchIn .22s cubic-bezier(.22,1,.36,1) both}
      .r-builder-search-backdrop{position:fixed;inset:0;z-index:2600;background:rgba(15,23,42,.46);display:flex;align-items:flex-start;justify-content:center;padding:72px 18px 24px;box-sizing:border-box}
      .r-builder-search-modal{width:min(760px,calc(100vw - 36px));max-height:min(720px,calc(100vh - 96px));overflow:auto;border:1px solid rgba(15,23,42,.12);background:#fff;border-radius:18px;box-shadow:0 28px 90px rgba(15,23,42,.28);padding:14px;display:flex;flex-direction:column;gap:12px}
      .r-builder-search-modal-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
      .r-builder-search-modal-head strong{display:block;font-size:15px;font-weight:1000;color:#111827}
      .r-builder-search-modal-head span{display:block;margin-top:2px;font-size:11px;font-weight:800;color:#667085}
      .r-builder-search-close{width:32px;height:32px;border:0;border-radius:10px;background:#f2f4f7;color:#667085;display:flex;align-items:center;justify-content:center;cursor:pointer}
      .r-builder-search-close:hover{background:#e4e7ec;color:#111827}
      .r-builder-review-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
      .r-builder-review-grid .r-proposal-list-card{min-height:74px}
      .r-builder-switch input{position:absolute;opacity:0;pointer-events:none}
      .r-builder-switch-track{width:38px;height:22px;border-radius:999px;background:#d0d5dd;padding:2px;display:inline-flex;align-items:center;justify-content:flex-start;transition:background .22s ease,box-shadow .22s ease}
      .r-builder-switch-track span{width:18px;height:18px;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.22);transform:translateX(0);transition:transform .24s cubic-bezier(.22,1,.36,1)}
      .r-builder-switch input:checked + .r-builder-switch-track{background:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.13)}
      .r-builder-switch input:checked + .r-builder-switch-track span{transform:translateX(16px)}
      .r-builder-switch input:disabled + .r-builder-switch-track{opacity:.72}
      .r-builder-switch.mini .r-builder-switch-track{width:32px;height:18px}
      .r-builder-switch.mini .r-builder-switch-track span{width:14px;height:14px}
      .r-builder-switch.mini input:checked + .r-builder-switch-track span{transform:translateX(14px)}
      .r-builder-structure-sections{display:flex;flex-direction:column;gap:12px}
      .r-builder-structure-card{border:1px solid rgba(15,23,42,.1);border-radius:14px;background:#fff;padding:12px;display:flex;flex-direction:column;gap:10px}
      .r-builder-structure-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .r-builder-structure-card-head strong{font-size:12px;font-weight:1000;color:#111827}
      .r-builder-structure-card-head span{font-size:10px;font-weight:850;color:#667085;text-transform:none;letter-spacing:0}
      @media(max-width:720px){
        .r-builder-template-toolbar{align-items:stretch;flex-direction:column;gap:12px}
        .r-builder-template-search{width:100%;flex-basis:40px}
        .r-builder-step-pane .r-builder-template-grid{grid-template-columns:repeat(auto-fit,minmax(136px,1fr))!important}
        .r-builder-step-pane .r-builder-template-grid .r-proposal-template-card{min-height:112px}
        #rProposalPreview .r-builder-mobile-wrap{padding:0;overflow:hidden;background:#f3f6f9}
        #rProposalPreview .r-builder-mobile-shell{position:relative;height:100%;min-height:0;overflow:hidden;display:flex;flex-direction:column}
        #rProposalPreview .r-builder-mobile-content{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:18px 14px 122px;display:flex;flex-direction:column;gap:14px}
        #rProposalPreview .r-builder-mobile-head{display:flex;align-items:center;min-height:38px}
        #rProposalPreview .r-builder-mobile-head div{min-width:0;display:flex;flex-direction:column;gap:3px}
        #rProposalPreview .r-builder-mobile-head strong{font-size:16px;font-weight:1000;line-height:1.15;color:#101828}
        #rProposalPreview .r-builder-mobile-head span{font-size:11px;font-weight:850;line-height:1.3;color:#667085}
        #rProposalPreview .r-builder-mobile-footer{position:absolute;z-index:4;right:0;bottom:0;left:0;padding:10px 14px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(15,23,42,.10);background:#fff;box-shadow:0 -8px 20px rgba(15,23,42,.06)}
        #rProposalPreview .r-builder-mobile-picker-footer{position:absolute;z-index:4;right:0;bottom:0;left:0;padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px));border-top:2px solid rgba(15,23,42,.18);background:#fff;box-shadow:0 -8px 20px rgba(15,23,42,.08)}
        /* The phone keyboard owns the lower viewport while someone is typing.
           Send the dock below it rather than letting it cover the active field. */
        #rProposalPreview .r-builder-mobile-shell.keyboard-active .r-builder-mobile-footer,
        #rProposalPreview .r-builder-mobile-shell.keyboard-active .r-builder-mobile-picker-footer{opacity:0;pointer-events:none;transform:translateY(calc(100% + env(safe-area-inset-bottom,0px)));transition:opacity .12s ease,transform .16s ease}
        #rProposalPreview .r-builder-mobile-shell:has(.r-builder-mobile-picker-footer) .r-builder-mobile-content{padding-bottom:190px}
        #rProposalPreview .r-builder-mobile-shell.keyboard-active .r-builder-mobile-content{padding-bottom:18px}
        #rProposalPreview .r-builder-mobile-step-nav{display:flex;align-items:center;justify-content:space-between;gap:5px;margin:0 0 10px}
        #rProposalPreview .r-builder-mobile-step{position:relative;flex:1 1 0;min-width:0;height:30px;padding:0;border:0;background:transparent;color:#98a2b3;display:flex;align-items:center;justify-content:center;cursor:pointer}
        #rProposalPreview .r-builder-mobile-step::before{content:'';position:absolute;z-index:0;top:14px;left:-50%;right:50%;height:2px;background:#e4e7ec}
        #rProposalPreview .r-builder-mobile-step:first-child::before{display:none}
        #rProposalPreview .r-builder-mobile-step.complete::before,#rProposalPreview .r-builder-mobile-step.active::before{background:var(--primary,#d93025)}
        #rProposalPreview .r-builder-mobile-step span{position:relative;z-index:1;width:24px;height:24px;border:2px solid #d0d5dd;border-radius:999px;background:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:1000;line-height:1}
        #rProposalPreview .r-builder-mobile-step.complete span{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:#fff}
        #rProposalPreview .r-builder-mobile-step.active span{border-color:var(--primary,#d93025);color:var(--primary-readable,var(--primary,#d93025));box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.10)}
        #rProposalPreview .r-builder-mobile-footer .r-builder-main-actions{position:static;margin:0;padding:0;background:transparent;display:grid;grid-template-columns:1fr 1.35fr;gap:8px}
        #rProposalPreview .r-builder-mobile-footer .r-builder-main-actions .r-proposal-template-action{width:100%;min-width:0;min-height:42px}
        #rProposalPreview .r-builder-mobile-content .r-proposal-settings{margin:0}
        #rProposalPreview .r-builder-mobile-content:has(.r-builder-picker-shell){overflow:hidden;padding-bottom:14px}
        #rProposalPreview .r-builder-mobile-content .r-builder-picker-shell{height:auto;flex:1 1 auto;min-height:0;overflow:hidden}
        #rProposalPreview .r-builder-mobile-content .r-builder-template-scroll{padding:14px 6px 18px;min-height:0;overflow:auto}
        #rProposalPreview .r-builder-mobile-content .r-builder-project-type-tile{min-height:92px;border-radius:12px}
        #rProposalPreview .r-builder-mobile-content .r-builder-template-add{position:relative;min-height:88px;padding:11px 10px;gap:6px}
        #rProposalPreview .r-builder-mobile-content .r-builder-template-add span:not(.r-builder-type-icon){display:none}
        #rProposalPreview .r-builder-mobile-content .r-builder-template-add strong{padding-right:24px;font-size:11px}
        #rProposalPreview .r-builder-mobile-content .r-builder-template-info{top:7px;right:7px;width:25px;height:25px}
        #rProposalPreview .r-builder-mobile-content .r-builder-project-type-tile.selected{border-color:var(--scope-color,var(--primary,#d93025));box-shadow:0 0 0 2px color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 22%,transparent)}
        #rProposalPreview .r-builder-mobile-content .r-builder-template-selected{position:absolute;right:8px;bottom:8px;min-width:19px;height:19px;padding:0 4px;border-radius:999px;background:var(--scope-color,var(--primary,#d93025));color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:3px;font-size:9px;font-style:normal;font-weight:1000}
        #rProposalPreview .r-builder-mobile-picker-scope{flex:0 0 auto;margin:0;padding:0;background:transparent}
        #rProposalPreview .r-builder-mobile-active-scope{display:flex;flex-direction:column;gap:8px}
        #rProposalPreview .r-builder-mobile-active-scope>strong{font-size:11px;font-weight:1000;letter-spacing:.05em;text-transform:uppercase;color:#475467}
        #rProposalPreview .r-builder-mobile-piece-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;padding:6px 2px 2px 6px;overflow:visible}
        #rProposalPreview .r-builder-mobile-piece{position:relative;min-width:0;aspect-ratio:1;border:1px solid color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 30%,#d0d5dd);border-radius:11px;background:color-mix(in srgb,var(--scope-color,var(--primary,#d93025)) 12%,#fff);color:var(--scope-color,var(--primary,#d93025));display:flex;align-items:center;justify-content:center;font-size:20px}
        #rProposalPreview .r-builder-mobile-piece-remove{position:absolute;z-index:2;top:-6px;left:-6px;width:20px;height:20px;padding:0;border:1px solid #fff;border-radius:999px;background:#344054;color:#fff;box-shadow:0 2px 6px rgba(15,23,42,.24);display:inline-flex;align-items:center;justify-content:center;font-size:9px;cursor:pointer}
        #rProposalPreview .r-builder-mobile-scope-footer{display:flex;align-items:center;justify-content:space-between;gap:10px}
        #rProposalPreview .r-builder-mobile-scope-footer>div{min-width:0;display:grid;gap:2px}
        #rProposalPreview .r-builder-mobile-scope-footer>div>span{font-size:11px;font-weight:900;color:#667085}
        #rProposalPreview .r-builder-mobile-scope-footer .r-builder-scope-build{height:34px;min-width:0;padding:0 11px;border-radius:9px;font-size:11px;box-shadow:none}
        #rProposalPreview .r-builder-mobile-footer>.r-builder-scope-total{margin:0 0 8px;display:flex;align-items:baseline}
        #rProposalPreview .r-builder-mobile-footer>.r-builder-scope-total.compact strong{font-size:13px}
      }
    `);
  }

  function proposalBuilderSwitchHtml(id, checked){
    return `
      <label class="r-builder-switch" style="display:flex;gap:8px;align-items:center;font-size:11px;font-weight:900;color:#667085;white-space:nowrap;cursor:pointer">
        <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a665c868fcd7d6","Customer can change") ?? "Customer can change")}</span>
        <input type="checkbox" data-builder-customer-toggle="${String(escapeHtml(id))}"${String(checked ? ' checked' : '')}>
        <span class="r-builder-switch-track"><span></span></span>
      </label>
    `;
  }

  function proposalBuilderMiniSwitchHtml(attrs = '', checked = false, label = ''){
    return `
      <label class="r-builder-switch mini" style="display:flex;gap:7px;align-items:center;font-size:10px;font-weight:950;color:#667085;white-space:nowrap;cursor:pointer">
        <input type="checkbox" ${attrs}${checked ? ' checked' : ''}>
        <span class="r-builder-switch-track"><span></span></span>
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }

  function proposalBuilderStepsHtml(builder){
    const activeStep = builder.steps?.[builder.stepIndex] || {};
    const color = activeStep.pieceColor || 'var(--primary,#d93025)';
    return `<div style="display:flex;gap:6px;margin:0 0 12px">${(builder.steps || []).map((step, index) => `
      <span style="height:8px;flex:1;border-radius:999px;background:${index <= builder.stepIndex ? escapeHtml(color) : '#e4e7ec'}"></span>
    `).join('')}</div>`;
  }

  function proposalBuilderMobileStepNavHtml(builder = {}){
    const steps = Array.isArray(builder.steps) ? builder.steps : [];
    if (!steps.length) return '';
    return ("\n      <nav class=\"r-builder-mobile-step-nav\" aria-label=\"" + (globalThis.PlatformLanguage?.text("proposals","m_617df52e2403db","Proposal setup steps") ?? "Proposal setup steps") + "\">\n        " + String(steps.map((step, index) => {
          const active = index === builder.stepIndex;
          const complete = index < builder.stepIndex;
          return `<button type="button" class="r-builder-mobile-step${active ? ' active' : ''}${complete ? ' complete' : ''}" data-builder-step="${index}" aria-current="${active ? 'step' : 'false'}" aria-label="${((v4,v5) => globalThis.PlatformLanguage?.htmlText("proposals","m_8934bbea9ff9ad",`Step ${v4}: ${v5}`,{v4,v5}) ?? `Step ${v4}: ${v5}`)(index + 1,escapeHtml(step.title || 'Proposal setup'))}">
            <span>${complete ? '<i class="fas fa-check"></i>' : index + 1}</span>
          </button>`;
        }).join('')) + "\n      </nav>\n    ");
  }

  function proposalBuilderMobileHeaderHtml(builder = {}){
    const step = builder.steps?.[builder.stepIndex] || {};
    return `
      <header class="r-builder-mobile-head">
        <div>
          <strong>${String(escapeHtml(builder.template?.name || 'Proposal setup'))}</strong>
          <span>${((v1,v2,v3) => globalThis.PlatformLanguage?.htmlText("proposals","m_c43453776c71a8",`Step ${v1} of ${v2}: ${v3}`,{v1,v2,v3}) ?? `Step ${v1} of ${v2}: ${v3}`)((Number(builder.stepIndex) || 0) + 1,(builder.steps || []).length,escapeHtml(step.title || 'Set up your proposal'))}</span>
        </div>
      </header>
    `;
  }

  function proposalBuilderMeasurementFieldLabel(key){
    if (key === 'roofSquares') return 'Total Squares';
    if (key === 'shingleSquares') return 'Pitched Squares';
    if (key === 'flatRoofSquares') return 'Flat Squares';
    if (key === 'ridgeVentLf') return 'Ridge Vent (LF)';
    const field = [...PROPOSAL_PITCH_FIELDS, ...PROPOSAL_MEASUREMENT_FIELDS].find((item) => item.key === key);
    return field?.label || titleFromKey(key);
  }

  function proposalBuilderMeasurementInput(key, measurements, options = {}){
    const dataAttr = options.structureIndex != null
      ? `data-builder-structure-index="${escapeHtml(String(options.structureIndex))}" data-builder-structure-measurement="${escapeHtml(key)}" `
      : `data-builder-measurement="${escapeHtml(key)}" `;
    const calculatedAttr = options.readonly
      ? `data-builder-calculated="${escapeHtml(key)}"${options.structureIndex != null ? ` data-builder-structure-index="${escapeHtml(String(options.structureIndex))}"` : ''} `
      : '';
    return `
      <div class="r-proposal-measure-group">
        <label>${escapeHtml(proposalBuilderMeasurementFieldLabel(key))}${options.readonly ? ' (calculated)' : ''}</label>
        <input type="number" min="0" step="1" ${options.readonly ? 'readonly tabindex="-1" ' : ''}${options.readonly ? calculatedAttr : dataAttr}value="${escapeHtml(String(Math.round(Number(measurements[key] ?? 0) || 0)))}">
      </div>
    `;
  }

  function proposalBuilderStructureSections(measurements = {}){
    const normalized = normalizeProposalMeasurements(measurements || {});
    const structures = Array.isArray(normalized.structureMeasurements) && normalized.structureMeasurements.length
      ? normalized.structureMeasurements
      : [{ ...normalized, name: 'Single structure' }];
    return structures.map((structure, index) => {
      const section = normalizeProposalMeasurements(structure || {});
      return {
        ...section,
        name: structures.length === 1 ? 'Single structure' : String(structure?.name || `Structure ${index + 1}`),
      };
    });
  }

  function proposalBuilderStructurePreviouslyUsed(builder = proposalBuilderState, step = {}, structure = {}, structureIndex = 0){
    const piece = proposalBuilderPieceById(step.pieceId, builder);
    if (!piece) return false;
    const pieceIndex = proposalBuilderSelectedPieces(builder).findIndex((entry) => entry.id === piece.id);
    if (pieceIndex <= 0) return false;
    const structureName = String(structure.name || `Structure ${structureIndex + 1}`).trim().toLowerCase();
    return proposalBuilderSelectedPieces(builder).slice(0, pieceIndex).some((previous) => {
      if (previous.templateId !== piece.templateId) return false;
      return proposalBuilderStructureSections(previous.measurements || builder.measurements || {}).some((entry, index) => {
        const previousName = String(entry.name || `Structure ${index + 1}`).trim().toLowerCase();
        return previousName === structureName;
      });
    });
  }

  function proposalBuilderStructureUsedWarning(builder = proposalBuilderState, step = {}, structure = {}, index = 0){
    if (!proposalBuilderStructurePreviouslyUsed(builder, step, structure, index)) return '';
    const piece = proposalBuilderPieceById(step.pieceId, builder);
    const template = proposalBuilderTemplateById(piece?.templateId || 'manual');
    return `This structure was already used in a previous ${String(template.name || 'section').toLowerCase()}.`;
  }

  function proposalBuilderSectionFieldsHtml(builder = {}, step = {}, structures = []){
    if (!step.pieceId) return '';
    const piece = proposalBuilderPieceById(step.pieceId, builder);
    if (!piece) return '';
    const template = proposalBuilderTemplateById(piece.templateId || 'manual');
    return `
      <div class="r-builder-section-fields">
        <div class="r-builder-section-name">
          <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_f42d20e25c0c5e","Section Name") ?? "Section Name")}</label>
          <input data-builder-section-name="${String(escapeHtml(piece.id))}" value="${String(escapeHtml(proposalBuilderPieceDisplayName(piece, template)))}" placeholder="${String(escapeHtml(template.name || 'Project Piece'))}">
        </div>
        <div class="r-builder-structure-actions">
          <button type="button" class="r-builder-structure-action" data-builder-add-structure="${String(escapeHtml(piece.id))}"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_eeef1a0ad4fc61","Add structure") ?? "Add structure")}</button>
        </div>
      </div>
    `;
  }

  function proposalBuilderStructureMeasurementHtml(structure, index, fields, context = {}){
    const pitchFields = fields.pitchFields;
    const detailFields = fields.detailFields;
    const warning = proposalBuilderStructureUsedWarning(context.builder, context.step, structure, index);
    const canRemove = context.canRemove !== false;
    return `
      <div class="r-builder-structure-card">
        <div class="r-builder-structure-card-head">
          <strong>${escapeHtml(structure.name || (index === 0 ? 'Single structure' : `Structure ${index + 1}`))}</strong>
          <span style="display:inline-flex;align-items:center;gap:8px"><span data-builder-structure-total="${escapeHtml(String(index))}">${escapeHtml(`${Math.round(Number(structure.roofSquares || 0))} squares`)}</span>
            ${context.pieceId && canRemove ? `<button type="button" class="r-builder-structure-action danger" data-builder-remove-structure="${String(escapeHtml(context.pieceId))}" data-builder-remove-structure-index="${String(escapeHtml(String(index)))}"><i class="fas fa-minus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_f643f568915438","Remove") ?? "Remove")}</button>` : ''}
          </span>
        </div>
        ${warning ? `<div class="r-builder-structure-warning">${escapeHtml(warning)}</div>` : ''}
        <div class="r-proposal-measure-grid" style="padding:0;grid-template-columns:repeat(auto-fit,minmax(112px,1fr))">
          ${pitchFields.map((key) => proposalBuilderMeasurementInput(key, structure, { structureIndex: index })).join('')}
        </div>
        <div class="r-proposal-measure-grid" style="padding:0;grid-template-columns:repeat(3,minmax(112px,1fr))">
          ${proposalBuilderMeasurementInput('shingleSquares', structure, { readonly: true, structureIndex: index })}
          ${proposalBuilderMeasurementInput('flatRoofSquares', structure, { structureIndex: index })}
          ${proposalBuilderMeasurementInput('roofSquares', structure, { readonly: true, structureIndex: index })}
        </div>
        <div class="r-proposal-measure-grid" style="padding:0;grid-template-columns:repeat(auto-fit,minmax(112px,1fr))">
          ${detailFields.map((key) => proposalBuilderMeasurementInput(key, structure, { structureIndex: index, integer: key.endsWith('Ea') })).join('')}
        </div>
      </section>
    `;
  }

  function proposalBuilderMeasurementHtml(builder, step){
    const piece = step.pieceId ? proposalBuilderPieceById(step.pieceId, builder) : null;
    const measurements = piece ? proposalBuilderPieceMeasurements(piece, builder.measurements || {}) : normalizeProposalMeasurements(builder.measurements || {});
    const pitchFields = PROPOSAL_PITCH_FIELDS.filter((field) => field.key !== 'flatRoofSquares').map((field) => field.key);
    const detailFields = ['wastePercent', 'eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf', 'transitionsLf', 'sideWallLf', 'headWallLf', 'gutterLf', 'downspoutLf', 'chimneysEa', 'skylightsEa', 'pipeBootsEa', 'roofVentsEa', 'ridgeVentLf', 'boxVentsEa'];
    const structures = proposalBuilderStructureSections(measurements);
    const sectionTitle = piece ? `${proposalBuilderPieceDisplayName(piece, proposalBuilderTemplateById(piece.templateId || 'manual'))} - ${proposalBuilderStructureCountLabel(structures.length)}` : (step.title || (globalThis.PlatformLanguage?.text("proposals","m_ae873abaa56707","Measurements") ?? "Measurements"));
    return `
      <div class="r-proposal-settings">
        <div class="r-proposal-settings-head"><strong>${escapeHtml(sectionTitle)}</strong><span>${structures.length > 1 ? `${structures.length} structures` : 'Single structure'}</span></div>
        ${proposalBuilderSectionFieldsHtml(builder, step, structures)}
        <div class="r-builder-structure-sections">
          ${structures.map((structure, index) => proposalBuilderStructureMeasurementHtml(structure, index, { pitchFields, detailFields }, { builder, step, pieceId: piece?.id || '', canRemove: structures.length > 1 })).join('')}
        </div>
      </div>
    `;
  }

  function proposalBuilderOptionTileHtml({ active = false, title = '', price = '', description = '', attrs = '', icon = 'fa-circle' } = {}){
    return `
      <button type="button" class="r-builder-option-tile${active ? ' active' : ''}" ${attrs} style="border:1px solid ${active ? 'rgba(var(--primary-rgb,217,48,37),.46)' : 'rgba(15,23,42,.1)'};background:${active ? 'rgba(var(--primary-rgb,217,48,37),.07)' : '#fff'};border-radius:16px;padding:16px;text-align:left;cursor:pointer;display:grid;grid-template-columns:34px 1fr auto;gap:12px;align-items:center;min-height:92px;box-shadow:${active ? '0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)' : '0 10px 22px rgba(15,23,42,.05)'}">
        <i class="fas ${escapeHtml(icon)}" style="width:34px;height:34px;border-radius:12px;background:${active ? 'var(--primary,#d93025)' : '#f2f4f7'};color:${active ? '#fff' : '#667085'};display:flex;align-items:center;justify-content:center"></i>
        <div style="min-width:0;display:flex;flex-direction:column;gap:4px">
          <strong style="font-size:14px;font-weight:1000;color:#111827;line-height:1.2">${escapeHtml(title || 'Option')}</strong>
          ${description ? `<div style="font-size:11px;font-weight:800;color:#667085;line-height:1.35">${escapeHtml(description)}</div>` : ''}
        </div>
        <div style="font-size:16px;font-weight:1000;color:#111827;white-space:nowrap">${escapeHtml(price || '$0')}</div>
      </button>
    `;
  }

  function proposalBuilderChoiceItemPricebookItem(item = {}){
    const id = item.pricebook_ref?.item_id || item.pricebook_ref?.catalog_item_id || '';
    return id ? getPricebookModule()?.getItem?.(id) : null;
  }

  function proposalBuilderChoiceItemTypeId(item = {}){
    const pricebookItem = proposalBuilderChoiceItemPricebookItem(item);
    return pricebookItem?.itemTypeId || item.itemTypeId || item.variables?.itemTypeId || '';
  }

  function proposalBuilderChoiceIsShingleGroup(step = {}){
    return String(step.group_id || '') === 'shingle_profile'
      || (step.items || []).some((item) => proposalBuilderChoiceItemTypeId(item) === 'field_shingles');
  }

  function proposalBuilderCustomerVisible(item = {}){
    const selection = item.selection || {};
    const hasSelectableBy = Array.isArray(selection.selectable_by);
    const customerSelectable = hasSelectableBy && selection.selectable_by.includes('customer');
    if (selection.customer_visible === true) return hasSelectableBy ? customerSelectable : true;
    if (selection.customer_visible === false) return false;
    return customerSelectable;
  }

  function proposalBuilderChoiceBrand(item = {}, pricebookItem = null){
    const text = [
      item.manufacturer,
      item.variantGroupId,
      item.variant_group_id,
      item.variantGroupName,
      item.variant_group_name,
      pricebookItem?.manufacturer,
      pricebookItem?.variantGroupId,
      pricebookItem?.variant_group_id,
      pricebookItem?.variantGroupName,
      pricebookItem?.variant_group_name,
      item.display_name,
      item.name,
    ].filter(Boolean).join(' ').toLowerCase();
    if (/\bowens\b|\bowens_corning\b|owens corning/.test(text)) return 'owens_corning';
    if (/\bmalarkey\b/.test(text)) return 'malarkey';
    if (/\bcertainteed\b|certain teed/.test(text)) return 'certainteed';
    if (/\bgaf\b/.test(text)) return 'gaf';
    return '';
  }

  function proposalBuilderChoiceMarkHtml(item = {}, pricebookItem = null){
    const icon = item.icon || item.icon_class || item.iconClass || pricebookItem?.icon || pricebookItem?.icon_class || pricebookItem?.iconClass || '';
    if (icon) {
      const iconText = String(icon);
      if (/^(https?:)?\/\//.test(iconText) || iconText.includes('/') || /\.(png|jpe?g|svg|webp)$/i.test(iconText)) {
        return `<span class="r-builder-choice-mark"><img src="${escapeHtml(iconText)}" alt=""></span>`;
      }
      const iconClass = iconText.includes(' ') ? iconText : iconText.includes('fa-') ? `fas ${iconText}` : `fas fa-${iconText}`;
      return `<span class="r-builder-choice-mark"><i class="${escapeHtml(iconClass)}"></i></span>`;
    }
    const brand = proposalBuilderChoiceBrand(item, pricebookItem);
    const src = PROPOSAL_BUILDER_BRAND_LOGOS[brand];
    if (src) return ("<span class=\"r-builder-choice-mark brand-" + String(escapeHtml(brand.replace(/_/g, '-'))) + "\" aria-label=\"" + ((v1) => globalThis.PlatformLanguage?.text("proposals","m_284af142776c08",`${v1} logo`,{v1}) ?? `${v1} logo`)(escapeHtml(titleFromKey(brand))) + "\"><img src=\"" + String(escapeHtml(src)) + "\" alt=\"\"></span>");
    return '';
  }

  function proposalBuilderChoiceTileHtml(item, step, selected, customerSelectable){
    const active = item === selected;
    const customerVisible = proposalBuilderCustomerVisible(item);
    const pricebookItem = proposalBuilderChoiceItemPricebookItem(item);
    const meta = [pricebookItem?.variantGroupName, pricebookItem?.variantRole, item.formula].filter(Boolean).join(' - ');
    const stateText = active ? 'Selected' : customerVisible ? 'Available to customer' : 'Internal only';
    const canToggleCustomer = customerSelectable && !active;
    const markHtml = proposalBuilderChoiceMarkHtml(item, pricebookItem);
    return `
      <div class="r-builder-choice-card${active ? ' active' : ''}${customerVisible ? ' customer-visible' : ''}${markHtml ? ' has-mark' : ''}" role="button" tabindex="0" data-builder-choice="${escapeHtml(step.group_id)}" data-builder-choice-item="${escapeHtml(item.id)}">
        <div class="r-builder-choice-main">
          ${markHtml}
          <span style="min-width:0;display:flex;flex-direction:column;gap:5px">
            <strong style="font-size:15px;font-weight:1000;color:#111827;line-height:1.2">${escapeHtml(item.display_name || item.name || 'Option')}</strong>
            <span style="font-size:11px;font-weight:800;color:#667085;line-height:1.35">${escapeHtml(item.description || meta || 'Price-book shingle option')}</span>
          </span>
          <span class="r-builder-choice-price" style="font-size:17px;font-weight:1000;color:#111827;white-space:nowrap">${escapeHtml(proposalCurrencyDisplay(proposalScopeItemPreviewCents(item) / 100))}</span>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid rgba(15,23,42,.08);padding-top:10px">
          <span class="r-builder-choice-state">${escapeHtml(stateText)}</span>
          ${customerSelectable ? proposalBuilderMiniSwitchHtml(`data-builder-customer-option="${escapeHtml(item.id)}"${canToggleCustomer ? '' : ' disabled'}`, customerVisible, 'Customer') : ''}
        </div>
      </div>
    `;
  }

  function proposalBuilderSortedChoiceItems(step = {}){
    return [...(step.items || [])];
  }

  function proposalBuilderSearchCandidates(step = {}){
    const typeId = proposalBuilderChoiceItemTypeId(step.items?.[0] || {});
    const existing = new Set((step.items || []).map((item) => String(item.pricebook_ref?.item_id || item.pricebook_ref?.catalog_item_id || '')));
    const query = String(proposalBuilderState?.pricebookSearch?.query || '').trim().toLowerCase();
    return proposalBuilderPricebookItemsByType(typeId, { category: 'shingle_roofs' })
      .filter((item) => !existing.has(String(item.id || '')))
      .filter((item) => {
        if (!query) return true;
        return `${item.name} ${item.variantName || ''} ${item.variantGroupName || ''} ${item.manufacturer || ''}`.toLowerCase().includes(query);
      })
      .slice(0, 8);
  }

  function proposalBuilderChoiceSearchHtml(step = {}){
    if (!proposalBuilderChoiceIsShingleGroup(step)) return '';
    const open = proposalBuilderState?.pricebookSearch?.groupId === step.group_id;
    const candidates = open ? proposalBuilderSearchCandidates(step) : [];
    return `
      <div style="display:flex;flex-direction:column;gap:10px">
        <button type="button" data-builder-pricebook-toggle="${String(escapeHtml(step.group_id))}" style="width:max-content;border:1px solid rgba(15,23,42,.1);background:#fff;color:#344054;border-radius:12px;padding:9px 12px;font-size:11px;font-weight:1000;display:flex;align-items:center;gap:8px;cursor:pointer"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_809de729b1919e"," Add shingle") ?? " Add shingle")}</button>
        ${String(open ? `
          <div class="r-builder-search-backdrop" data-builder-pricebook-close>
          <div class="r-builder-search-panel r-builder-search-modal" role="dialog" aria-modal="true" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_6f42ac1c339952","Add shingle") ?? "Add shingle")}" data-builder-pricebook-modal>
            <div class="r-builder-search-modal-head">
              <div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_6f42ac1c339952","Add shingle") ?? "Add shingle")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a28421203810c9","Search the price book and add another customer-visible option.") ?? "Search the price book and add another customer-visible option.")}</span></div>
              <button type="button" class="r-builder-search-close" data-builder-pricebook-close aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_581e6e2a759706","Close add shingle") ?? "Close add shingle")}"><i class="fas fa-xmark"></i></button>
            </div>
            <input data-builder-pricebook-query value="${escapeHtml(proposalBuilderState?.pricebookSearch?.query || '')}" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_f3189dbe87971a","Search shingle price book") ?? "Search shingle price book")}" style="width:100%;border:1px solid rgba(15,23,42,.14);border-radius:12px;padding:10px 12px;font-size:12px;font-weight:850;outline:none;box-sizing:border-box">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">
              ${candidates.length ? candidates.map((item) => `
                <button type="button" data-builder-add-pricebook="${escapeHtml(item.id)}" data-builder-add-group="${escapeHtml(step.group_id)}" style="border:1px solid rgba(15,23,42,.08);background:#f8fafc;border-radius:12px;padding:10px;text-align:left;display:flex;justify-content:space-between;gap:10px;cursor:pointer">
                  <span style="display:flex;flex-direction:column;gap:3px"><strong style="font-size:11px;color:#111827">${escapeHtml(item.name)}</strong><span style="font-size:10px;font-weight:850;color:#667085">${escapeHtml([item.variantGroupName, item.variantRole].filter(Boolean).join(' - ') || 'Shingle')}</span></span>
                  <span style="font-size:11px;font-weight:1000;color:#111827">$${Number(item.unitPrice || item.unit_price || 0).toFixed(0)}</span>
                </button>
              `).join('') : `<div style="font-size:11px;font-weight:850;color:#667085;padding:8px">${(globalThis.PlatformLanguage?.htmlText("proposals","m_fba496098e9a0f","No matching shingles found.") ?? "No matching shingles found.")}</div>`}
            </div>
          </div>
          </div>
        ` : '')}
      </div>
    `;
  }

  function proposalBuilderChoiceHtml(step){
    const selected = step.items.find((item) => item.selection?.selected === true) || step.items.find((item) => item.selection?.default_selected === true) || step.items[0];
    const customerSelectable = step.items.some((item) => (item.selection?.selectable_by || []).includes('customer'));
    if (selected?.selection && customerSelectable) {
      selected.selection.customer_visible = true;
      proposalBuilderSetCustomerSelectable(selected.selection, true);
    }
    const sortedItems = proposalBuilderSortedChoiceItems(step);
    return `
      <div class="r-proposal-settings">
        <div class="r-proposal-settings-head"><strong>${escapeHtml(step.title || (globalThis.PlatformLanguage?.text("proposals","m_11c5bb08f73ea7","Choose one") ?? "Choose one"))}</strong>${proposalBuilderSwitchHtml(step.id, customerSelectable)}</div>
        <div class="r-builder-choice-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">
          ${sortedItems.map((item) => proposalBuilderChoiceTileHtml(item, step, selected, customerSelectable)).join('')}
        </div>
        ${proposalBuilderChoiceSearchHtml(step)}
      </div>
    `;
  }

  function proposalBuilderOptionalHtml(step){
    const item = step.item || {};
    const selected = item.selection?.selected === true;
    const customerSelectable = (item.selection?.selectable_by || []).includes('customer');
    return `
      <div class="r-proposal-settings">
        <div class="r-proposal-settings-head"><strong>${escapeHtml(step.title || item.display_name || item.name || 'Optional add-on')}</strong>${proposalBuilderSwitchHtml(step.id, customerSelectable)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
          ${proposalBuilderOptionTileHtml({
            active: selected,
            title: item.display_name || item.name || 'Optional add-on',
            price: proposalCurrencyDisplay(proposalScopeItemPreviewCents(item) / 100),
            description: `${selected ? 'Included in this proposal.' : 'Not included yet.'}${item.description ? ` ${item.description}` : ''}`,
            icon: selected ? 'fa-toggle-on' : 'fa-toggle-off',
            attrs: `data-builder-optional="${escapeHtml(item.id)}"`
          })}
        </div>
      </div>
    `;
  }

  function proposalBuilderDiscountItems(builder = proposalBuilderState){
    return (builder?.root?.children || []).filter((item) => proposalScopeItemIsDiscount(item));
  }

  function proposalBuilderAddDiscount(mode = 'amount'){
    if (!proposalBuilderState?.root) return;
    proposalBuilderState.root.children = Array.isArray(proposalBuilderState.root.children) ? proposalBuilderState.root.children : [];
    const index = proposalBuilderState.root.children.length;
    const item = createManualProposalScopeItem({
      item_kind: 'discount',
      is_discount: true,
      name: mode === 'percent' ? 'Percentage Discount' : 'Discount',
      display_name: mode === 'percent' ? 'Percentage Discount' : 'Discount',
      discount_mode: mode === 'percent' ? 'percent' : 'amount',
      discount_percent: mode === 'percent' ? '10' : '',
      quantity: mode === 'percent' ? '10' : '0',
      discount_amount: mode === 'amount' ? '0' : '',
      unit_price: mode === 'amount' ? 0 : 0,
      base_price: 0
    }, index);
    proposalBuilderState.root.children.push(item);
    proposalRefreshDiscountAmounts({ scope: { root_items: [proposalBuilderState.root] } });
  }

  function proposalBuilderDiscountsHtml(builder){
    proposalRefreshDiscountAmounts({ scope: { root_items: [builder.root] } });
    const discounts = proposalBuilderDiscountItems(builder);
    return `
      <div class="r-proposal-settings">
        <div class="r-proposal-settings-head"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_b23f7b8d1ec24f","Discounts") ?? "Discounts")}</strong><span>${String(escapeHtml(proposalCurrencyDisplay(proposalScopeItemTotalCents(builder.root || {}) / 100)))}</span></div>
        <div class="r-builder-discount-actions">
          <button type="button" data-builder-add-discount="amount"><i class="fas fa-dollar-sign"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_fe7dbcfbb0c582"," Add Amount") ?? " Add Amount")}</button>
          <button type="button" data-builder-add-discount="percent"><i class="fas fa-percent"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_62804058b8be63"," Add Percent") ?? " Add Percent")}</button>
        </div>
        <div class="r-builder-discount-list">
          ${String(discounts.length ? discounts.map((item) => {
            const mode = String(item.discount_mode || 'amount') === 'percent' ? 'percent' : 'amount';
            const amountText = mode === 'percent'
              ? `${proposalPercentDisplay(item.discount_percent ?? item.quantity ?? 0)}% ${proposalSignedCurrencyDisplay(proposalScopeItemTotalCents(item) / 100)}`
              : proposalSignedCurrencyDisplay(proposalScopeItemTotalCents(item) / 100);
            return `
              <div class="r-builder-discount-row" data-builder-discount="${escapeHtml(item.id)}">
                <input data-builder-discount-field="name" value="${escapeHtml(item.display_name || item.name || 'Discount')}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_4a3589501ecc1f","Discount name") ?? "Discount name")}">
                <div class="r-proposal-discount-mode">
                  <button type="button" class="${mode === 'amount' ? 'active' : ''}" data-builder-discount-mode="amount" data-builder-discount-id="${escapeHtml(item.id)}">$</button>
                  <button type="button" class="${mode === 'percent' ? 'active' : ''}" data-builder-discount-mode="percent" data-builder-discount-id="${escapeHtml(item.id)}">%</button>
                </div>
                <input data-builder-discount-field="value" value="${escapeHtml(mode === 'percent' ? proposalPercentDisplay(item.discount_percent ?? item.quantity ?? 0) : proposalCurrencyEditText(item.discount_amount ?? item.unit_price ?? 0))}" inputmode="decimal" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_792f935ba82291","Discount value") ?? "Discount value")}">
                <strong>${escapeHtml(amountText)}</strong>
                <button type="button" data-builder-remove-discount="${escapeHtml(item.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_691d860b768692","Remove discount") ?? "Remove discount")}"><i class="fas fa-times"></i></button>
              </div>
            `;
          }).join('') : `<div class="r-builder-discount-empty">${(globalThis.PlatformLanguage?.htmlText("proposals","m_0254795a80cfc0","No discounts added yet.") ?? "No discounts added yet.")}</div>`)}
        </div>
      </div>
    `;
  }

  function proposalBuilderReviewHtml(builder){
    const selected = [];
    const isScope = proposalBuilderContext?.mode === 'scope';
    walkProposalScopeItems([builder.root], (item) => { if (proposalScopeItemSelected(item)) selected.push(item); });
    return `
      <div class="r-proposal-settings">
        <div class="r-proposal-settings-head"><strong>${isScope ? 'Ready to Save Scope' : 'Ready to Create'}</strong><span>${escapeHtml(proposalCurrencyDisplay(proposalScopeItemTotalCents(builder.root || {}) / 100))}</span></div>
        <div class="r-builder-review-grid">
          ${selected.slice(0, 10).map((item) => `<div class="r-proposal-list-card"><div class="r-proposal-list-main"><strong>${escapeHtml(item.display_name || item.name || 'Scope item')}</strong><span>${escapeHtml(proposalCurrencyDisplay(proposalScopeItemTotalCents(item) / 100))}</span></div></div>`).join('')}
        </div>
      </div>
    `;
  }

  function proposalBuilderLoadingHtml(builder = {}){
    const title = proposalBuilderContext?.mode === 'scope' ? 'Project Scope' : 'Proposal Workflow';
    const loadsRoofMeasurements = builder.loadsRoofMeasurements !== false;
    return `
      <div class="r-proposal-workspace-head"><div style="width:36px"></div><div><strong>${String(escapeHtml(builder.template?.name || title))}</strong><span>${String(loadsRoofMeasurements ? 'Loading roof report measurements...' : 'Loading project types...')}</span></div></div>
      <div class="r-proposal-settings" style="min-height:160px;align-items:center;justify-content:center;text-align:center">
        <i class="fas fa-spinner fa-spin" style="font-size:22px;color:var(--primary,#d93025)"></i>
        <strong style="font-size:13px;color:#111827">${(globalThis.PlatformLanguage?.htmlText("proposals","m_dc799f9c4180c9","Preparing workflow") ?? "Preparing workflow")}</strong>
        <span style="font-size:12px;font-weight:800;color:#667085">${String(loadsRoofMeasurements ? 'Pulling measurements from the current roof report when available.' : 'Loading the available project types.')}</span>
      </div>
    `;
  }

  function proposalBuilderActiveScopeHtml(builder = {}, options = {}){
    const pieces = proposalBuilderSelectedPieces(builder);
    const buildLabel = proposalBuilderContext?.mode === 'scope' ? 'Build scope' : 'Build proposal';
    if (options.compact) {
      return `
        <section class="r-builder-mobile-active-scope" data-builder-active-scope data-builder-compact-scope="true">
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ff35e566b4739b","Active scope") ?? "Active scope")}</strong>
          <div class="r-builder-mobile-piece-grid">
            ${String(pieces.map((piece, index) => {
              const template = proposalBuilderTemplateById(piece.templateId || 'manual');
              const label = escapeHtml(piece.name || template.name || `Project piece ${index + 1}`);
              return `
                <div class="r-builder-mobile-piece" style="--scope-color:${escapeHtml(piece.color || proposalBuilderTemplateColor(template))}" title="${label}">
                  <button type="button" class="r-builder-mobile-piece-remove" data-builder-remove-piece="${escapeHtml(piece.id)}" aria-label="${((v3) => globalThis.PlatformLanguage?.htmlText("proposals","m_f2da0f4d54d9d9",`Remove ${v3}`,{v3}) ?? `Remove ${v3}`)(label)}"><i class="fas fa-xmark"></i></button>
                  <i class="fas ${escapeHtml(template.icon || 'fa-file-lines')}" aria-hidden="true"></i>
                </div>
              `;
            }).join(''))}
          </div>
          <div class="r-builder-mobile-scope-footer">
            <div><span>${((v1,v2) => globalThis.PlatformLanguage?.htmlText("proposals","m_327f02c35dd934",`${v1} piece${v2}`,{v1,v2}) ?? `${v1} piece${v2}`)(pieces.length,pieces.length === 1 ? '' : 's')}</span>${String(proposalBuilderScopeTotalHtml(builder, { compact:true }))}</div>
            <button type="button" class="r-builder-scope-build" data-builder-start-scope ${String(pieces.length ? '' : 'disabled')}>${String(escapeHtml(buildLabel))} <i class="fas fa-arrow-right"></i></button>
          </div>
        </section>
      `;
    }
    const heading = `
      <div class="r-builder-scope-heading">
        <div class="r-builder-scope-heading-copy">
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ff35e566b4739b","Active scope") ?? "Active scope")}</strong>
          <span>${((v0,v1) => globalThis.PlatformLanguage?.htmlText("proposals","m_742fad511164a9",`${v0} project piece${v1}`,{v0,v1}) ?? `${v0} project piece${v1}`)(pieces.length,pieces.length === 1 ? '' : 's')}</span>
        </div>
        <button type="button" class="r-builder-scope-build" data-builder-start-scope ${String(pieces.length ? '' : 'disabled')}>
          ${String(escapeHtml(buildLabel))} <i class="fas fa-arrow-right"></i>
        </button>
      </div>
    `;
    if (!pieces.length) {
      return `
        <div class="r-builder-active-scope empty" data-builder-active-scope>
          ${String(heading)}
          <div class="r-builder-scope-empty">
            <i class="fas fa-plus"></i>
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9f569783731101","Add work to the project") ?? "Add work to the project")}</strong>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a7b987f011048f","Choose one or more project templates.") ?? "Choose one or more project templates.")}</span>
          </div>
        </div>
      `;
    }
    return `
      <div class="r-builder-active-scope" data-builder-active-scope>
        ${heading}
        <div class="r-builder-active-list">
          ${pieces.map((piece, index) => `
            <div class="r-builder-active-piece" style="--scope-color:${String(escapeHtml(piece.color || 'var(--primary,#d93025)'))}">
              <i class="fas ${String(escapeHtml(proposalBuilderTemplateById(piece.templateId || 'manual').icon || 'fa-file-lines'))}"></i>
              <strong>${String(escapeHtml(piece.name || 'Project Piece'))}</strong>
              <span>${((v3) => globalThis.PlatformLanguage?.htmlText("proposals","m_490cd09fa0c5b6",`Piece ${v3}`,{v3}) ?? `Piece ${v3}`)(index + 1)}</span>
              <button type="button" class="r-builder-remove-piece" data-builder-remove-piece="${String(escapeHtml(piece.id))}" aria-label="${((v5) => globalThis.PlatformLanguage?.htmlText("proposals","m_267054a63cc396",`Remove ${v5}`,{v5}) ?? `Remove ${v5}`)(escapeHtml(piece.name || 'project piece'))}"><i class="fas fa-xmark"></i></button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function proposalBuilderTemplateCollectionsHtml(builder = {}){
    const query = String(builder.query || '').trim().toLowerCase();
    const matches = PROPOSAL_BUILDER_TEMPLATES.filter((template) => {
      return !query || `${template.name} ${template.description}`.toLowerCase().includes(query);
    });
    const quick = query ? [] : matches.filter((template) => !template.manual).slice(0, 3);
    const quickIds = new Set(quick.map((template) => template.id));
    const remaining = matches.filter((template) => !quickIds.has(template.id));
    if (!PROPOSAL_BUILDER_TEMPLATES.length) {
      return `<div class="r-builder-template-empty">${(globalThis.PlatformLanguage?.htmlText("proposals","m_6b20090f010db2","No project scopes are enabled for this company. An administrator can enable them in Company Settings &gt; Scope Flags.") ?? "No project scopes are enabled for this company. An administrator can enable them in Company Settings &gt; Scope Flags.")}</div>`;
    }
    if (!matches.length) {
      return `<div class="r-builder-template-empty">${((v0) => globalThis.PlatformLanguage?.htmlText("proposals","m_09745e6dc60f71",`No project templates match “${v0}”.`,{v0}) ?? `No project templates match “${v0}”.`)(escapeHtml(builder.query || ''))}</div>`;
    }
    return `
      ${quick.length ? `
        <div class="r-builder-template-quick-label"><i class="fas fa-bolt"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9235212a89ec97"," Quick access") ?? " Quick access")}</div>
        <div class="r-proposal-template-row r-builder-template-grid">${String(quick.map((template) => proposalBuilderTemplateTile(template)).join(''))}</div>
      ` : ''}
      ${quick.length && remaining.length ? '<div class="r-builder-template-divider" role="separator"></div>' : ''}
      ${remaining.length ? `<div class="r-proposal-template-row r-builder-template-grid">${remaining.map((template) => proposalBuilderTemplateTile(template, { compact: true })).join('')}</div>` : ''}
    `;
  }

  function proposalBuilderInfoModalHtml(builder = {}){
    const template = builder.infoTemplateId ? proposalBuilderTemplateById(builder.infoTemplateId) : null;
    if (!template || !builder.infoTemplateId) return '';
    const steps = Array.isArray(template.workflow_steps) ? template.workflow_steps : [];
    return `
      <div class="r-builder-info-backdrop" data-builder-info-close>
        <div class="r-builder-info-modal" style="--scope-color:${String(escapeHtml(proposalBuilderTemplateColor(template)))}" role="dialog" aria-modal="true" aria-label="${((v1) => globalThis.PlatformLanguage?.htmlText("proposals","m_6e4ba38fa02b85",`${v1} information`,{v1}) ?? `${v1} information`)(escapeHtml(template.name))}">
          <aside class="r-builder-info-workflow">
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_7dbbeae35a4717","Workflow") ?? "Workflow")}</strong>
            <ol class="r-builder-info-steps">
              ${String(steps.length ? steps.map((step, index) => `<li><em>${index + 1}</em><span>${escapeHtml(step)}</span></li>`).join('') : `<li><em>1</em><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_082d7b8324f933","Custom workflow to be defined.") ?? "Custom workflow to be defined.")}</span></li>`)}
            </ol>
          </aside>
          <section class="r-builder-info-copy">
            <div class="r-builder-info-head">
              <div class="r-builder-info-title"><i class="fas ${String(escapeHtml(template.icon || 'fa-file-lines'))}"></i><div><strong>${String(escapeHtml(template.name))}</strong><span>${String(escapeHtml(template.label || 'Template'))}</span></div></div>
              <button type="button" class="r-builder-info-close" data-builder-info-close aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_3742924668fb10","Close") ?? "Close")}"><i class="fas fa-xmark"></i></button>
            </div>
            <p>${String(escapeHtml(template.details || template.description || ''))}</p>
            <button type="button" class="r-builder-info-add" data-builder-info-add="${String(escapeHtml(template.id))}">${(globalThis.PlatformLanguage?.htmlText("proposals","m_d7eada214f81cc","Add to Scope") ?? "Add to Scope")}</button>
          </section>
        </div>
      </div>
    `;
  }

  function proposalBuilderTemplatePickerHtml(builder = {}, options = {}){
    const mobileScopeSummary = options.mobile === true;
    return `
      <div class="r-builder-picker-shell" data-builder-picker-shell>
        <div class="r-builder-template-toolbar">
          <div class="r-builder-template-title">
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_94dffcbc385b13","Project templates") ?? "Project templates")}</strong>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_377c4308c31feb","Choose the work that belongs in this project scope.") ?? "Choose the work that belongs in this project scope.")}</span>
          </div>
          <label class="r-builder-template-search">
            <i class="fas fa-search" aria-hidden="true"></i>
            <input data-builder-search value="${String(escapeHtml(builder.query || ''))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_7f0fd4e2e8569b","Search templates") ?? "Search templates")}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_447ed55d415261","Search project templates") ?? "Search project templates")}">
          </label>
        </div>
        <div class="r-builder-template-scroll">
          <div data-builder-template-collections>${String(proposalBuilderTemplateCollectionsHtml(builder))}</div>
        </div>
        ${String(mobileScopeSummary ? `<div class="r-builder-mobile-picker-scope">${proposalBuilderActiveScopeHtml(builder, { compact:true })}</div>` : '')}
      </div>
    `;
  }

  function proposalBuilderModalMount(){
    const host = state.previewRoot || document.querySelector('#rProposalPreview') || document.querySelector('.r-preview-panel.active') || document.body;
    if (!host) return null;
    document.querySelectorAll('#rBuilderInfoModalLayer').forEach((node) => {
      if (node.parentElement !== host) node.remove();
    });
    const computed = window.getComputedStyle ? window.getComputedStyle(host) : null;
    if (computed?.position === 'static') host.style.position = 'relative';
    let layer = host.querySelector(':scope > #rBuilderInfoModalLayer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'rBuilderInfoModalLayer';
      host.appendChild(layer);
    }
    return layer;
  }

  function proposalBuilderSyncInfoModal(){
    const layer = proposalBuilderModalMount();
    if (!layer) return;
    layer.innerHTML = proposalBuilderInfoModalHtml(proposalBuilderState || {});
    bindProposalBuilderControls(layer);
  }

  function proposalBuilderSyncPickerActions(){
    const hasPieces = proposalBuilderSelectedPieces().length > 0;
    document.querySelectorAll('[data-builder-start-scope]').forEach((button) => {
      button.disabled = !hasPieces;
      if (hasPieces) button.removeAttribute('disabled');
      else button.setAttribute('disabled', '');
    });
  }

  function proposalBuilderSyncActiveScope(root = document){
    const current = root.querySelector?.('[data-builder-active-scope]');
    if (!current) return false;
    const compact = current.dataset.builderCompactScope === 'true';
    const wrap = document.createElement('div');
    wrap.innerHTML = proposalBuilderActiveScopeHtml(proposalBuilderState || { mode: 'select' }, { compact }).trim();
    const next = wrap.firstElementChild;
    if (!next) return false;
    current.replaceWith(next);
    bindProposalBuilderControls(next);
    proposalBuilderSyncPickerActions();
    return true;
  }

  function proposalBuilderRenderTemplateLists(root = document){
    const builder = proposalBuilderState || { mode: 'select', query: '' };
    const collections = root.querySelector?.('[data-builder-template-collections]');
    if (!collections) return;
    collections.innerHTML = proposalBuilderTemplateCollectionsHtml(builder);
    bindProposalBuilderControls(collections);
  }

  function proposalBuilderUpdatePicker(root = document, options = {}){
    const changed = proposalBuilderSyncActiveScope(root);
    if (options.templates) proposalBuilderRenderTemplateLists(root);
    proposalBuilderSyncInfoModal();
    proposalBuilderSyncPickerActions();
    if (changed || options.templates) return true;
    return false;
  }

  function proposalBuilderStepBodyHtml(builder = {}){
    const step = builder.steps?.[builder.stepIndex] || builder.steps?.[0];
    if (!step) return '';
    if (step.type === 'measurements') return proposalBuilderMeasurementHtml(builder, step);
    if (step.type === 'choice') return proposalBuilderChoiceHtml(step);
    if (step.type === 'optional') return proposalBuilderOptionalHtml(step);
    if (step.type === 'discounts') return proposalBuilderDiscountsHtml(builder);
    return proposalBuilderReviewHtml(builder);
  }

  function proposalBuilderWorkflowHtml(builder = {}){
    const step = builder.steps?.[builder.stepIndex] || builder.steps?.[0];
    if (!step) return proposalBuilderTemplatePickerHtml({ mode: 'select', query: '' });
    const body = proposalBuilderStepBodyHtml(builder);
    const isScope = proposalBuilderContext?.mode === 'scope';
    const title = isScope ? 'Project Scope' : 'Proposal Workflow';
    const doneLabel = isScope ? 'Save Scope' : 'Create Proposal';
    const canGoBack = builder.stepIndex > 0 || isScope;
    const backAttr = builder.stepIndex > 0 ? 'data-builder-prev' : 'data-builder-scope-type-picker';
    const backLabel = builder.stepIndex > 0 ? 'Back' : 'Project Type';
    return `
      <div class="r-proposal-workspace-head">
        ${canGoBack ? `<button type="button" class="r-proposal-back" ${backAttr} aria-label="${escapeHtml(backLabel)}"><i class="fas fa-arrow-left"></i></button>` : '<div style="width:36px"></div>'}
        <div><strong>${escapeHtml(builder.template?.name || title)}</strong><span>${escapeHtml(step.title || '')}</span></div>
      </div>
      ${proposalBuilderStepsHtml(builder)}
      ${body}
      <div class="r-proposal-template-actions" style="grid-template-columns:${canGoBack ? '1fr 1fr' : '1fr'}">
        ${canGoBack ? `<button type="button" class="r-proposal-template-action" ${backAttr}>${escapeHtml(backLabel)}</button>` : ''}
        <button type="button" class="r-proposal-template-action" data-builder-next>${step.type === 'review' ? doneLabel : 'Next'}</button>
      </div>
    `;
  }

  function proposalBuilderMainActionsHtml(builder = {}, options = {}){
    const step = builder.steps?.[builder.stepIndex] || builder.steps?.[0];
    if (!step) return '';
    const isScope = proposalBuilderContext?.mode === 'scope';
    const canGoBack = builder.stepIndex > 0 || isScope;
    const backAttr = builder.stepIndex > 0 ? 'data-builder-prev' : 'data-builder-scope-type-picker';
    const backLabel = options.mobile ? 'Back' : (builder.stepIndex > 0 ? 'Back' : 'Project Type');
    const doneLabel = isScope ? 'Save Scope' : 'Create Proposal';
    return `
      <div class="r-builder-main-actions">
        ${canGoBack ? `<button type="button" class="r-proposal-template-action" ${backAttr}>${escapeHtml(backLabel)}</button>` : '<span></span>'}
        <button type="button" class="r-proposal-template-action primary" data-builder-next>${step.type === 'review' ? doneLabel : 'Next'}</button>
      </div>
    `;
  }

  function proposalBuilderHtml(builder = {}, options = {}){
    if (builder.mode === 'loading') return proposalBuilderLoadingHtml(builder);
    if (builder.mode === 'scope_choice') return proposalBuilderScopeChoiceHtml(builder);
    if (!builder.root) return proposalBuilderTemplatePickerHtml(builder, options);
    return proposalBuilderWorkflowHtml(builder);
  }

  function proposalBuilderScopeChoiceHtml(){
    const scope = activeBaseProject?.scope || {};
    return `
      <div class="r-proposal-template-picker">
        <div class="r-proposal-template-head">
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_6a4cec49d93dbd","Project Scope") ?? "Project Scope")}</strong>
          <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_998f1f386e91fe","This project already has a scope. Use it for this proposal or define a new scope.") ?? "This project already has a scope. Use it for this proposal or define a new scope.")}</span>
        </div>
        <div class="r-proposal-template-row">
          <button type="button" class="r-proposal-template-card" data-builder-use-project-scope>
            <i class="fas fa-clipboard-check"></i>
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ec84ead3213c98","Use Existing Project Scope") ?? "Use Existing Project Scope")}</strong>
            <span>${String(escapeHtml(projectScopeLabel(scope)))}</span>
          </button>
          <button type="button" class="r-proposal-template-card" data-builder-new-project-scope>
            <i class="fas fa-pen-ruler"></i>
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_d50ef111f157c1","Set New Scope") ?? "Set New Scope")}</strong>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9d943cbf4e93bd","Run the scope workflow again and save it to the project.") ?? "Run the scope workflow again and save it to the project.")}</span>
          </button>
        </div>
      </div>
    `;
  }

  function proposalBuilderSidebarStepHtml(step, index, builder){
    const active = index === builder.stepIndex;
    const done = index < builder.stepIndex;
    const color = step.pieceColor || 'var(--primary,#d93025)';
    return `
      <button type="button" class="r-builder-sidebar-step ${active ? 'active' : ''} ${done ? 'done' : ''}" data-builder-step="${index}" style="--scope-color:${escapeHtml(color)}">
        <span class="r-builder-sidebar-step-mark">${done ? '<i class="fas fa-check"></i>' : index + 1}</span>
        <span style="min-width:0;display:flex;flex-direction:column;gap:2px">
          <strong>${escapeHtml(step.title || ((v0) => globalThis.PlatformLanguage?.text("proposals","m_cbcc38f502bd4b",`Step ${v0}`,{v0}) ?? `Step ${v0}`)(index + 1))}</strong>
          <span>${active ? 'Current' : done ? 'Complete' : 'Upcoming'}</span>
        </span>
      </button>
    `;
  }

  function proposalBuilderSidebarGroupedStepsHtml(builder = {}){
    const steps = builder.steps || [];
    const workflowSteps = steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => entry.step.pieceId);
    const tailSteps = steps
      .map((step, index) => ({ step, index }))
      .filter((entry) => !entry.step.pieceId);
    const groups = new Map();
    workflowSteps.forEach((entry) => {
      const id = entry.step.pieceId || 'scope';
      if (!groups.has(id)) groups.set(id, { name: entry.step.pieceName || 'Project Piece', color: entry.step.pieceColor || 'var(--primary,#d93025)', entries: [] });
      groups.get(id).entries.push(entry);
    });
    const collapsed = builder.collapsedPieces && typeof builder.collapsedPieces === 'object' ? builder.collapsedPieces : {};
    const expanded = builder.expandedPieces && typeof builder.expandedPieces === 'object' ? builder.expandedPieces : {};
    const groupHtml = [...groups.entries()].map(([id, group]) => {
      const done = group.entries.every((entry) => entry.index < builder.stepIndex);
      const active = group.entries.some((entry) => entry.index === builder.stepIndex);
      const open = expanded[id] === true || (collapsed[id] !== true && active);
      const piece = proposalBuilderPieceById(id, builder);
      const structures = piece ? proposalBuilderStructureSections(piece.measurements || builder.measurements || {}) : [];
      const suffix = structures.length ? ` - ${proposalBuilderStructureCountLabel(structures.length)}` : '';
      const menuOpen = builder.openPieceMenu === id;
      return `
        <section class="r-builder-sidebar-section" style="--scope-color:${String(escapeHtml(group.color))}">
          <div class="r-builder-sidebar-section-head">
            <strong>${String(escapeHtml(group.name))}${String(escapeHtml(suffix))}</strong>
            <span style="color:${String(done ? '#15803d' : active ? escapeHtml(group.color) : '#667085')}">
              <span class="r-builder-section-menu-wrap">
                <button type="button" class="r-builder-section-menu-btn" data-builder-piece-menu="${String(escapeHtml(id))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_bf0970982d20c9","Section actions") ?? "Section actions")}"><i class="fas fa-ellipsis"></i></button>
                ${String(menuOpen ? `<div class="r-builder-section-menu"><button type="button" class="danger" data-builder-remove-piece-confirm="${escapeHtml(id)}">${(globalThis.PlatformLanguage?.htmlText("proposals","m_7a6a5f10b83ab4","Remove section") ?? "Remove section")}</button></div>` : '')}
              </span>
              <button type="button" class="r-builder-section-menu-btn" data-builder-piece-toggle="${String(escapeHtml(id))}" aria-expanded="${String(open ? 'true' : 'false')}" aria-label="${((v8) => globalThis.PlatformLanguage?.htmlText("proposals","m_6376b6bad9b805",`${v8} section`,{v8}) ?? `${v8} section`)(open ? 'Collapse' : 'Expand')}"><i class="fas ${String(open ? 'fa-chevron-up' : 'fa-chevron-down')}"></i></button>
              ${String(done ? 'Done' : active ? 'Active' : 'Open')}
            </span>
          </div>
          ${String(open ? `<div class="r-builder-sidebar-substeps">${group.entries.map((entry) => proposalBuilderSidebarStepHtml(entry.step, entry.index, builder)).join('')}</div>` : '')}
        </section>
      `;
    }).join('');
    const tailActive = tailSteps.some((entry) => entry.index === builder.stepIndex);
    const tailDone = tailSteps.length && tailSteps.every((entry) => entry.index < builder.stepIndex);
    const tailOpen = expanded.__final === true || (collapsed.__final !== true && tailActive);
    const tailHtml = tailSteps.length ? `<section class="r-builder-sidebar-section" style="--scope-color:var(--primary,#d93025)"><button type="button" class="r-builder-sidebar-section-head" data-builder-piece-toggle="__final" aria-expanded="${String(tailOpen ? 'true' : 'false')}"><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_da7158eec1e24b","Finalize") ?? "Finalize")}</strong><span>${String(tailDone ? 'Done' : tailActive ? 'Active' : 'Open')} <i class="fas ${String(tailOpen ? 'fa-chevron-up' : 'fa-chevron-down')}"></i></span></button>${String(tailOpen ? `<div class="r-builder-sidebar-substeps">${tailSteps.map((entry) => proposalBuilderSidebarStepHtml(entry.step, entry.index, builder)).join('')}</div>` : '')}</section>` : '';
    return `${groupHtml}${tailHtml}`;
  }

  function proposalBuilderSidebarHtml(builder = {}){
    const isScope = proposalBuilderContext?.mode === 'scope';
    const scopeNoBack = isScope && proposalBuilderContext?.showBack === false;
    const title = 'Project Scope';
    const pickerLabel = 'Project Type';
    const doneLabel = isScope ? 'Save Scope' : 'Create Proposal';
    if (builder.mode === 'loading') {
      const loadsRoofMeasurements = builder.loadsRoofMeasurements !== false;
      return `
        <div class="r-proposal-workspace-head">${scopeNoBack ? '<div style="width:36px"></div>' : `<button type="button" class="r-proposal-back" data-builder-cancel-to-list aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_121372231b5699","Back") ?? "Back")}"><i class="fas fa-arrow-left"></i></button>`}<div><strong>${escapeHtml(builder.template?.name || title)}</strong><span>${loadsRoofMeasurements ? 'Preparing measurements' : 'Preparing workflow'}</span></div></div>
        <div class="r-proposal-settings" style="gap:8px"><strong style="font-size:12px;color:#111827">${loadsRoofMeasurements ? 'Loading roof report' : 'Loading project type'}</strong><span style="font-size:11px;font-weight:800;color:#667085;line-height:1.4">${loadsRoofMeasurements ? 'Pulling report measurements before the workflow starts.' : 'Preparing the selected project workflow.'}</span></div>
      `;
    }
    if (builder.mode === 'scope_choice') {
      return `
        <div class="r-proposal-workspace-head"><button type="button" class="r-proposal-back" data-builder-cancel-to-list aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_121372231b5699","Back") ?? "Back")}"><i class="fas fa-arrow-left"></i></button><div><strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_6a4cec49d93dbd","Project Scope") ?? "Project Scope")}</strong><span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ae5c3544315a73","Choose how to scope this proposal.") ?? "Choose how to scope this proposal.")}</span></div></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button type="button" style="width:100%;border:1px solid rgba(var(--primary-rgb,217,48,37),.38);background:rgba(var(--primary-rgb,217,48,37),.07);border-radius:14px;padding:10px;text-align:left;display:grid;grid-template-columns:26px 1fr;gap:9px;align-items:center">
            <span style="width:26px;height:26px;border-radius:999px;background:var(--primary,#d93025);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:1000">1</span>
            <span style="display:flex;flex-direction:column;gap:2px"><strong style="font-size:11px;font-weight:1000;color:#111827">${(globalThis.PlatformLanguage?.htmlText("proposals","m_6a4cec49d93dbd","Project Scope") ?? "Project Scope")}</strong><span style="font-size:10px;font-weight:800;color:#667085;letter-spacing:0">${(globalThis.PlatformLanguage?.htmlText("proposals","m_e17f9eaa3f43a2","Current") ?? "Current")}</span></span>
          </button>
        </div>
      `;
    }
    if (!builder.root) {
      return `
        <div class="r-builder-sidebar-shell">
          <div class="r-proposal-workspace-head r-builder-picker-sidebar-head">${scopeNoBack ? '' : `<button type="button" class="r-proposal-back" data-builder-template-picker-back aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_121372231b5699","Back") ?? "Back")}"><i class="fas fa-arrow-left"></i></button>`}<div><strong>${escapeHtml(pickerLabel)}</strong></div></div>
          ${proposalBuilderActiveScopeHtml(builder)}
          ${proposalBuilderScopeTotalHtml(builder)}
        </div>
      `;
    }
    const step = builder.steps?.[builder.stepIndex] || builder.steps?.[0] || {};
    const scopeBackAttr = isScope ? 'data-builder-scope-type-picker' : 'data-builder-cancel-to-list';
    const canGoBack = builder.stepIndex > 0 || isScope;
    const actionBackAttr = builder.stepIndex > 0 ? 'data-builder-prev' : scopeBackAttr;
    const actionBackLabel = builder.stepIndex > 0 ? 'Back' : 'Project Type';
    return `
      <div class="r-builder-sidebar-shell">
        <div class="r-proposal-workspace-head">${isScope || !scopeNoBack ? `<button type="button" class="r-proposal-back" ${scopeBackAttr} aria-label="${isScope ? 'Project Type' : 'Back'}"><i class="fas fa-arrow-left"></i></button>` : '<div style="width:36px"></div>'}<div><strong>${escapeHtml(builder.template?.name || title)}</strong><span>${escapeHtml(step.title || '')}</span></div></div>
        <div class="r-builder-sidebar-list">${proposalBuilderSelectedPieces(builder).length ? proposalBuilderSidebarGroupedStepsHtml(builder) : (builder.steps || []).map((item, index) => proposalBuilderSidebarStepHtml(item, index, builder)).join('')}</div>
        <div class="r-builder-sidebar-footer">
          ${proposalBuilderScopeTotalHtml(builder)}
          <div class="r-builder-sidebar-actions" style="grid-template-columns:${canGoBack ? '1fr 1fr' : '1fr'}">
            ${canGoBack ? `<button type="button" class="r-proposal-template-action" ${actionBackAttr}>${escapeHtml(actionBackLabel)}</button>` : ''}
            <button type="button" class="r-proposal-template-action" data-builder-next>${step.type === 'review' ? doneLabel : 'Next'}</button>
          </div>
        </div>
      </div>
    `;
  }

  function refreshProposalBuilderViews(options = {}){
    if (proposalBuilderContext?.render) {
      proposalBuilderContext.render(options);
      return;
    }
    const previousQuietRender = proposalBuilderQuietRender;
    proposalBuilderQuietRender = !!options.quiet;
    try {
      renderProposalSection();
      renderProposalPreview();
    } finally {
      proposalBuilderQuietRender = previousQuietRender;
    }
  }

  function rebuildProposalBuilderRoot(){
    if (!proposalBuilderState?.root || !proposalBuilderState?.template) return;
    const measurements = normalizeProposalMeasurements(proposalBuilderState.measurements || {});
    proposalBuilderState.measurements = measurements;
    if (proposalBuilderSelectedPieces().length) {
      const pieces = proposalBuilderSelectedPieces();
      const built = proposalBuilderProjectRootFromPieces(pieces, measurements);
      proposalBuilderState.root = built.root;
      proposalBuilderState.scopePieces = built.scopePieces;
      proposalBuilderState.steps = proposalBuilderStepsForPieces(pieces, built.root, built.scopePieces);
      proposalBuilderState.stepIndex = Math.min(proposalBuilderState.stepIndex || 0, proposalBuilderState.steps.length - 1);
      return;
    }
    proposalBuilderState.root = proposalBuilderScopeForTemplate(proposalBuilderState.template.id, measurements);
    proposalBuilderState.root.measurements = { ...(proposalBuilderState.root.measurements || {}), ...measurements };
    proposalBuilderState.steps = proposalBuilderStepsForRoot(proposalBuilderState.template, proposalBuilderState.root);
    proposalBuilderState.stepIndex = Math.min(proposalBuilderState.stepIndex || 0, proposalBuilderState.steps.length - 1);
  }

  function updateProposalBuilderMeasurement(key, value){
    if (!proposalBuilderState?.root) return;
    const number = Math.max(0, Number(value || 0) || 0);
    const step = proposalBuilderState.steps?.[proposalBuilderState.stepIndex] || {};
    const piece = step.pieceId ? proposalBuilderPieceById(step.pieceId) : null;
    const measurements = { ...((piece?.measurements) || proposalBuilderState.measurements || {}) };
    measurements[key] = number;
    if (key === 'shingleSquares') {
      PROPOSAL_PITCH_FIELDS.filter((field) => field.key !== 'flatRoofSquares').forEach((field) => { measurements[field.key] = 0; });
      measurements.pitch4to6Squares = number;
    }
    if (piece) piece.measurements = measurements;
    else proposalBuilderState.measurements = measurements;
    rebuildProposalBuilderRoot();
  }

  function updateProposalBuilderStructureMeasurement(index, key, value){
    if (!proposalBuilderState?.root) return;
    const structureIndex = Math.max(0, Number(index || 0) || 0);
    const number = Math.max(0, Number(value || 0) || 0);
    const step = proposalBuilderState.steps?.[proposalBuilderState.stepIndex] || {};
    const piece = step.pieceId ? proposalBuilderPieceById(step.pieceId) : null;
    const current = normalizeProposalMeasurements(piece?.measurements || proposalBuilderState.measurements || {});
    const structures = proposalBuilderStructureSections(current).map((structure) => ({ ...structure }));
    if (!structures[structureIndex]) return;
    structures[structureIndex][key] = number;
    if (key === 'shingleSquares') {
      PROPOSAL_PITCH_FIELDS.filter((field) => field.key !== 'flatRoofSquares').forEach((field) => { structures[structureIndex][field.key] = 0; });
      structures[structureIndex].pitch4to6Squares = number;
    }
    const aggregate = proposalAggregateStructureMeasurements(structures);
    const nextMeasurements = {
      ...current,
      ...aggregate,
      structures: structures.length,
      structureCount: structures.length,
      structureMeasurements: structures,
    };
    if (piece) piece.measurements = nextMeasurements;
    else proposalBuilderState.measurements = nextMeasurements;
    rebuildProposalBuilderRoot();
  }

  function syncProposalBuilderCalculatedMeasurements(root, structureIndex = null){
    if (!root || !proposalBuilderState?.root) return;
    const step = proposalBuilderState.steps?.[proposalBuilderState.stepIndex] || {};
    const piece = step.pieceId ? proposalBuilderPieceById(step.pieceId) : null;
    const current = normalizeProposalMeasurements(piece?.measurements || proposalBuilderState.measurements || {});
    const measurements = structureIndex == null
      ? current
      : proposalBuilderStructureSections(current)[Math.max(0, Number(structureIndex || 0))];
    if (!measurements) return;
    const indexSelector = structureIndex == null ? '' : `[data-builder-structure-index="${Math.max(0, Number(structureIndex || 0))}"]`;
    ['shingleSquares', 'roofSquares'].forEach((key) => {
      const input = root.querySelector(`[data-builder-calculated="${key}"]${indexSelector}`);
      if (input) input.value = String(Math.round(Number(measurements[key] || 0)));
    });
    if (structureIndex != null) {
      const total = root.querySelector(`[data-builder-structure-total="${Math.max(0, Number(structureIndex || 0))}"]`);
      if (total) total.textContent = ((v0) => globalThis.PlatformLanguage?.text("proposals","m_1ba62891df5e0b",`${v0} squares`,{v0}) ?? `${v0} squares`)(Math.round(Number(measurements.roofSquares || 0)));
    }
  }

  function proposalBuilderRefreshSteps(){
    if (!proposalBuilderState?.root || !proposalBuilderState?.template) return;
    if (proposalBuilderSelectedPieces().length) {
      proposalBuilderState.steps = proposalBuilderStepsForPieces(proposalBuilderSelectedPieces(), proposalBuilderState.root, proposalBuilderScopePieces());
      proposalBuilderState.stepIndex = Math.min(proposalBuilderState.stepIndex || 0, proposalBuilderState.steps.length - 1);
      return;
    }
    proposalBuilderState.steps = proposalBuilderStepsForRoot(proposalBuilderState.template, proposalBuilderState.root);
    proposalBuilderState.stepIndex = Math.min(proposalBuilderState.stepIndex || 0, proposalBuilderState.steps.length - 1);
  }

  function proposalBuilderStepCategoryId(index, builder = proposalBuilderState){
    const step = builder?.steps?.[index];
    return step ? (step.pieceId || '__final') : '';
  }

  function proposalBuilderMoveToStep(index, options = {}){
    if (!proposalBuilderState?.root) return;
    const maxIndex = Math.max(0, (proposalBuilderState.steps?.length || 1) - 1);
    const currentCategoryId = proposalBuilderStepCategoryId(proposalBuilderState.stepIndex);
    const nextIndex = Math.max(0, Math.min(maxIndex, Number(index || 0)));
    const nextCategoryId = proposalBuilderStepCategoryId(nextIndex);
    proposalBuilderState.stepIndex = nextIndex;
    if (options.revealCategory && nextCategoryId && nextCategoryId !== currentCategoryId) {
      proposalBuilderState.collapsedPieces = { ...(proposalBuilderState.collapsedPieces || {}) };
      delete proposalBuilderState.collapsedPieces[nextCategoryId];
    }
  }

  function proposalBuilderSetChoiceSelected(groupId, itemId){
    let selectedItem = null;
    let customerSelectable = false;
    walkProposalScopeItems([proposalBuilderState.root], (item) => {
      if (item.selection?.group_id !== groupId) return;
      if ((item.selection.selectable_by || []).includes('customer')) customerSelectable = true;
    });
    walkProposalScopeItems([proposalBuilderState.root], (item) => {
      if (item.selection?.group_id !== groupId) return;
      const selected = item.id === itemId;
      item.selection.selected = selected;
      item.selection.default_selected = selected;
      if (selected) {
        selectedItem = item;
        if (customerSelectable || (item.selection.selectable_by || []).includes('customer')) {
          item.selection.customer_visible = true;
          proposalBuilderSetCustomerSelectable(item.selection, true);
        }
      }
    });
    return selectedItem;
  }

  function proposalBuilderSetCustomerOption(itemId, enabled){
    const item = findProposalScopeItem({ scope: { root_items: [proposalBuilderState.root] } }, itemId || '');
    if (!item?.selection) return;
    if (item.selection.selected === true && enabled === false) {
      item.selection.customer_visible = true;
      proposalBuilderSetCustomerSelectable(item.selection, true);
      return;
    }
    item.selection.customer_visible = !!enabled;
    proposalBuilderSetCustomerSelectable(item.selection, !!enabled);
  }

  function proposalBuilderAddPricebookChoice(itemId, groupId){
    if (!proposalBuilderState?.root) return;
    const measurements = normalizeProposalMeasurements(proposalBuilderState.measurements || {});
    const item = proposalBuilderScopeItemFromPricebook(itemId, measurements, {
      selection: {
        mode: 'choice',
        group_id: groupId,
        group_behavior: 'single',
        selected: false,
        default_selected: false,
        customer_visible: true,
        selectable_by: ['internal', 'customer']
      }
    });
    if (!item) return;
    proposalBuilderConfigureChoiceItem(item, groupId, false, true);
    proposalBuilderState.root.children = Array.isArray(proposalBuilderState.root.children) ? proposalBuilderState.root.children : [];
    proposalBuilderState.root.children.push(item);
    proposalBuilderState.pricebookSearch = { groupId, query: '' };
    proposalBuilderRefreshSteps();
  }

  function bindProposalBuilderMobileKeyboard(root){
    const shell = root.querySelector?.('.r-builder-mobile-shell');
    if (!shell || shell.dataset.keyboardBinding === 'true') return;
    shell.dataset.keyboardBinding = 'true';
    const editableSelector = 'input, textarea, select, [contenteditable="true"]';
    const setKeyboardActive = (active) => shell.classList.toggle('keyboard-active', active);
    shell.addEventListener('focusin', (event) => {
      if (!event.target.matches?.(editableSelector)) return;
      clearTimeout(proposalBuilderMobileKeyboardBlurTimer);
      setKeyboardActive(true);
    });
    shell.addEventListener('focusout', () => {
      clearTimeout(proposalBuilderMobileKeyboardBlurTimer);
      proposalBuilderMobileKeyboardBlurTimer = setTimeout(() => {
        const focused = document.activeElement;
        setKeyboardActive(!!(focused && shell.contains(focused) && focused.matches?.(editableSelector)));
      }, 120);
    });
  }

  function bindProposalBuilderControls(root){
    bindProposalBuilderMobileKeyboard(root);
    root.querySelectorAll('[data-builder-cancel-to-list]').forEach((btn) => btn.addEventListener('click', () => {
      if (proposalBuilderContext?.mode === 'scope') {
        const onCancel = proposalBuilderContext.onCancel;
        proposalBuilderState = null;
        proposalBuilderContext = null;
        if (typeof onCancel === 'function') onCancel();
        else refreshProposalBuilderViews();
        return;
      }
      proposalBuilderState = null;
      enterProposalListMode(activeProposalIndex);
      renderProposalPreview();
    }));
    root.querySelectorAll('[data-builder-template-picker-back]').forEach((btn) => btn.addEventListener('click', () => {
      if (proposalBuilderContext?.mode === 'scope') {
        const onCancel = proposalBuilderContext.onCancel;
        proposalBuilderState = null;
        proposalBuilderContext = null;
        if (typeof onCancel === 'function') onCancel();
        else refreshProposalBuilderViews();
        return;
      }
      if (proposalBuilderState?.root || proposalBuilderState?.mode === 'loading') openProposalBuilderTemplatePicker();
      else enterProposalListMode(activeProposalIndex);
    }));
    root.querySelectorAll('[data-builder-search]').forEach((input) => input.addEventListener('input', (event) => {
      proposalBuilderState = { ...(proposalBuilderState || { mode: 'select' }), mode: 'select', query: event.target.value || '' };
      clearTimeout(proposalBuilderSearchRefreshTimer);
      proposalBuilderSearchRefreshTimer = setTimeout(() => proposalBuilderRenderTemplateLists(document), 140);
    }));
    root.querySelectorAll('[data-builder-add-template]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderAddPiece(btn.dataset.builderAddTemplate || 'manual');
      proposalBuilderUpdatePicker(document, { templates:true });
    }));
    root.querySelectorAll('[data-builder-remove-piece]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderRemovePiece(btn.dataset.builderRemovePiece || '');
      proposalBuilderUpdatePicker(document, { templates:true });
    }));
    root.querySelectorAll('[data-builder-piece-menu]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!proposalBuilderState) return;
      const pieceId = btn.dataset.builderPieceMenu || '';
      proposalBuilderState.openPieceMenu = proposalBuilderState.openPieceMenu === pieceId ? '' : pieceId;
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-remove-piece-confirm]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      proposalBuilderConfirmRemovePiece(btn.dataset.builderRemovePieceConfirm || '');
    }));
    root.querySelectorAll('[data-builder-template-info]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      proposalBuilderState = { ...(proposalBuilderState || { mode: 'select' }), mode: 'select', infoTemplateId: btn.dataset.builderTemplateInfo || '' };
      proposalBuilderSyncInfoModal();
    }));
    root.querySelectorAll('[data-builder-info-close]').forEach((node) => node.addEventListener('click', (event) => {
      if (event.currentTarget.classList?.contains('r-builder-info-backdrop') && event.target !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      if (proposalBuilderState) proposalBuilderState.infoTemplateId = '';
      proposalBuilderSyncInfoModal();
    }));
    root.querySelectorAll('[data-builder-info-add]').forEach((btn) => btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      proposalBuilderAddPiece(btn.dataset.builderInfoAdd || 'manual');
      if (proposalBuilderState) proposalBuilderState.infoTemplateId = '';
      proposalBuilderUpdatePicker(document, { templates:true });
    }));
    root.querySelectorAll('[data-builder-start-scope]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.disabled) return;
      startProposalBuilderWorkflowFromPieces();
    }));
    root.querySelectorAll('[data-builder-scope-type-picker]').forEach((btn) => btn.addEventListener('click', () => {
      returnProposalBuilderToTypePicker();
    }));
    root.querySelectorAll('[data-builder-use-project-scope]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderState = null;
      proposalBuilderContext = null;
      createProposalFromProjectScope(activeBaseProject?.scope);
    }));
    root.querySelectorAll('[data-builder-new-project-scope]').forEach((btn) => btn.addEventListener('click', () => {
      startProposalScopeThenCreate();
    }));
    root.querySelectorAll('[data-builder-prev]').forEach((btn) => btn.addEventListener('click', () => {
      if (!proposalBuilderState?.root) return;
      proposalBuilderMoveToStep(proposalBuilderState.stepIndex - 1);
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-step]').forEach((btn) => btn.addEventListener('click', () => {
      if (!proposalBuilderState?.root) return;
      const index = Math.max(0, Math.min(proposalBuilderState.steps.length - 1, Number(btn.dataset.builderStep || 0)));
      proposalBuilderMoveToStep(index, { revealCategory: true });
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-piece-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      if (!proposalBuilderState?.root) return;
      const pieceId = btn.dataset.builderPieceToggle || '';
      if (!pieceId) return;
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      proposalBuilderState.collapsedPieces = { ...(proposalBuilderState.collapsedPieces || {}) };
      proposalBuilderState.expandedPieces = { ...(proposalBuilderState.expandedPieces || {}) };
      if (isOpen) {
        proposalBuilderState.collapsedPieces[pieceId] = true;
        delete proposalBuilderState.expandedPieces[pieceId];
      } else {
        proposalBuilderState.expandedPieces[pieceId] = true;
        delete proposalBuilderState.collapsedPieces[pieceId];
      }
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-next]').forEach((btn) => btn.addEventListener('click', () => {
      if (!proposalBuilderState?.root) return;
      const step = proposalBuilderState.steps[proposalBuilderState.stepIndex] || proposalBuilderState.steps[0];
      if (step?.type === 'review') finishProposalBuilderWorkflow();
      else {
        proposalBuilderMoveToStep(proposalBuilderState.stepIndex + 1, { revealCategory: true });
        refreshProposalBuilderViews({ quiet: true });
      }
    }));
    root.querySelectorAll('[data-builder-measurement]').forEach((input) => input.addEventListener('input', () => {
      updateProposalBuilderMeasurement(input.dataset.builderMeasurement, input.value);
      syncProposalBuilderCalculatedMeasurements(root);
    }));
    root.querySelectorAll('[data-builder-structure-measurement]').forEach((input) => input.addEventListener('input', () => {
      updateProposalBuilderStructureMeasurement(input.dataset.builderStructureIndex, input.dataset.builderStructureMeasurement, input.value);
      syncProposalBuilderCalculatedMeasurements(root, input.dataset.builderStructureIndex);
    }));
    const builderMeasurementInputs = [...root.querySelectorAll('[data-builder-measurement], [data-builder-structure-measurement]')];
    builderMeasurementInputs.forEach((input) => input.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const currentIndex = builderMeasurementInputs.indexOf(input);
      const nextInput = builderMeasurementInputs[currentIndex + (event.shiftKey ? -1 : 1)];
      if (!nextInput) return;
      event.preventDefault();
      nextInput.focus();
      nextInput.select?.();
    }));
    root.querySelectorAll('[data-builder-section-name]').forEach((input) => input.addEventListener('change', () => {
      proposalBuilderUpdateSectionName(input.dataset.builderSectionName || '', input.value);
    }));
    root.querySelectorAll('[data-builder-add-structure]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderAddStructure(btn.dataset.builderAddStructure || '');
    }));
    root.querySelectorAll('[data-builder-remove-structure]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderRemoveStructure(btn.dataset.builderRemoveStructure || '', btn.dataset.builderRemoveStructureIndex || 0);
    }));
    root.querySelectorAll('[data-builder-choice]').forEach((btn) => btn.addEventListener('click', (event) => {
      if (event.target.closest('[data-builder-customer-option], .r-builder-switch')) return;
      proposalBuilderSetChoiceSelected(btn.dataset.builderChoice || '', btn.dataset.builderChoiceItem || '');
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-choice]').forEach((btn) => btn.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key) || event.target.closest('[data-builder-customer-option], .r-builder-switch')) return;
      event.preventDefault();
      proposalBuilderSetChoiceSelected(btn.dataset.builderChoice || '', btn.dataset.builderChoiceItem || '');
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-customer-option]').forEach((input) => input.addEventListener('change', () => {
      proposalBuilderSetCustomerOption(input.dataset.builderCustomerOption || '', input.checked);
      proposalBuilderRefreshSteps();
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-customer-option]').forEach((input) => input.addEventListener('click', (event) => {
      event.stopPropagation();
    }));
    root.querySelectorAll('[data-builder-pricebook-toggle]').forEach((btn) => btn.addEventListener('click', () => {
      const groupId = btn.dataset.builderPricebookToggle || '';
      const open = proposalBuilderState?.pricebookSearch?.groupId === groupId;
      proposalBuilderState.pricebookSearch = open ? null : { groupId, query: '' };
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-pricebook-close]').forEach((node) => node.addEventListener('click', (event) => {
      if (event.currentTarget.classList?.contains('r-builder-search-backdrop') && event.target !== event.currentTarget) return;
      event.preventDefault();
      event.stopPropagation();
      if (proposalBuilderState) proposalBuilderState.pricebookSearch = null;
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-pricebook-query]').forEach((input) => input.addEventListener('input', (event) => {
      proposalBuilderState.pricebookSearch = { ...(proposalBuilderState.pricebookSearch || {}), query: event.target.value || '' };
      clearTimeout(proposalBuilderSearchRefreshTimer);
      proposalBuilderSearchRefreshTimer = setTimeout(() => refreshProposalBuilderViews({ quiet: true }), 120);
    }));
    root.querySelectorAll('[data-builder-add-pricebook]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderAddPricebookChoice(btn.dataset.builderAddPricebook || '', btn.dataset.builderAddGroup || 'shingle_profile');
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-optional]').forEach((btn) => btn.addEventListener('click', () => {
      const item = findProposalScopeItem({ scope: { root_items: [proposalBuilderState.root] } }, btn.dataset.builderOptional || '');
      if (item?.selection) item.selection.selected = item.selection.selected !== true;
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-customer-toggle]').forEach((input) => input.addEventListener('change', () => {
      const targetStep = proposalBuilderState.steps.find((item) => item.id === input.dataset.builderCustomerToggle);
      if (targetStep?.items) targetStep.items.forEach((item) => {
        item.selection ||= {};
        if (input.checked && !targetStep.items.some((entry) => entry.selection?.customer_visible === true) && item.selection.selected === true) {
          item.selection.customer_visible = true;
        }
        proposalBuilderSetCustomerSelectable(item.selection, input.checked && item.selection.customer_visible === true);
      });
      if (targetStep?.item) proposalBuilderSetCustomerSelectable(targetStep.item.selection ||= {}, input.checked);
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-add-discount]').forEach((btn) => btn.addEventListener('click', () => {
      proposalBuilderAddDiscount(btn.dataset.builderAddDiscount || 'amount');
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-remove-discount]').forEach((btn) => btn.addEventListener('click', () => {
      if (!proposalBuilderState?.root?.children) return;
      proposalBuilderState.root.children = proposalBuilderState.root.children.filter((item) => String(item.id || '') !== String(btn.dataset.builderRemoveDiscount || ''));
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-discount-mode]').forEach((btn) => btn.addEventListener('click', () => {
      const item = findProposalScopeItem({ scope: { root_items: [proposalBuilderState.root] } }, btn.dataset.builderDiscountId || '');
      if (!item) return;
      item.discount_mode = btn.dataset.builderDiscountMode === 'percent' ? 'percent' : 'amount';
      if (item.discount_mode === 'percent' && !item.discount_percent) item.discount_percent = item.quantity || '10';
      refreshProposalBuilderViews({ quiet: true });
    }));
    root.querySelectorAll('[data-builder-discount] [data-builder-discount-field]').forEach((input) => {
      input.addEventListener('focus', () => clearTimeout(proposalBuilderSearchRefreshTimer));
      input.addEventListener('input', (event) => {
        clearTimeout(proposalBuilderSearchRefreshTimer);
        event.stopPropagation();
        const item = findProposalScopeItem({ scope: { root_items: [proposalBuilderState.root] } }, input.closest('[data-builder-discount]')?.dataset.builderDiscount || '');
        if (!item) return;
        const field = input.dataset.builderDiscountField;
        if (field === 'name') {
          item.name = input.value || 'Discount';
          item.display_name = item.name;
        } else if (field === 'value') {
          if (String(item.discount_mode || 'amount') === 'percent') {
            item.discount_percent = normalizeProposalNumber(input.value || 0);
            item.quantity = item.discount_percent;
          } else {
            const amount = Number(normalizeProposalNumber(input.value || 0) || 0);
            item.discount_amount = String(amount);
            item.unit_price = amount;
            item.base_price = amount;
          }
        }
      });
      input.addEventListener('change', () => proposalBuilderSyncScopeTotals(document));
    });
  }

  function renderProposalBuilderSection(section, label, list){
    ensureProposalBuilderAnimationStyles();
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    if (section) {
      section.classList.toggle('visible', visible);
      section.classList.remove('mode-list', 'mode-edit', 'mode-send');
      section.classList.add('mode-list');
    }
    if (label) label.hidden = visible;
    const builder = proposalBuilderState || { mode: 'select', query: '' };
    list.innerHTML = proposalBuilderSidebarHtml(builder);
    bindProposalBuilderControls(list);
  }

  function renderProposalSendSection(section, label, list){
    normalizeProposalCollection();
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    if (label) label.hidden = visible;
    if (section) {
      section.classList.toggle('visible', visible);
      section.classList.remove('mode-list', 'mode-edit', 'mode-send');
      section.classList.add('mode-send');
    }
    if (label) label.textContent = (globalThis.PlatformLanguage?.text("proposals","m_069690ba66778e","Send Proposal") ?? "Send Proposal");
    const contacts = collectContacts();
    const selectedIds = new Set(selectedProposalIdsForSend());
    list.innerHTML = `
      <div class="r-proposal-workspace-head">
        <button type="button" class="r-proposal-back" id="rProposalSendBack" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_121372231b5699","Back") ?? "Back")}"><i class="fas fa-arrow-left"></i></button>
        <div>
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_069690ba66778e","Send Proposal") ?? "Send Proposal")}</strong>
          <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_51c636bcc13a08","Confirm the selected proposal, contacts, and delivery options") ?? "Confirm the selected proposal, contacts, and delivery options")}</span>
        </div>
      </div>
      <div class="r-proposal-send-form">
        <div class="r-proposal-send-block">
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_c68907938160b5","Proposal Options") ?? "Proposal Options")}</strong>
          <div class="r-proposal-send-tile-grid" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;max-height:168px;overflow:auto;padding:2px">
            ${String(proposals.map((proposal, index) => {
              const id = proposalStableId(proposal, index);
              const selected = selectedIds.has(id);
              const alreadySent = !!(proposal.sent_at || proposal.delivery?.sent_at || ['sent', 'viewed', 'signed'].includes(String(proposal.status || '').toLowerCase()));
              return `
                <button type="button" class="r-proposal-send-tile${selected ? ' selected' : ''}" data-send-proposal-id="${escapeHtml(id)}" aria-pressed="${selected ? 'true' : 'false'}" style="border:1px solid ${selected ? 'rgba(var(--primary-rgb,217,48,37),.42)' : '#e4e7ec'};background:${selected ? 'rgba(var(--primary-rgb,217,48,37),.07)' : '#fff'};border-radius:10px;padding:9px 10px;text-align:left;display:grid;gap:3px;align-content:start;cursor:pointer">
                  <span style="font-weight:1000;color:#111827;line-height:1.15;overflow-wrap:anywhere">${escapeHtml(proposalDisplayName(proposal, index))}</span>
                  <em style="font-style:normal;font-size:11px;font-weight:900;line-height:1.2;color:#667085">${escapeHtml(alreadySent ? 'Already sent' : proposalStatusLabel(proposal.status))}</em>
                </button>
              `;
            }).join(''))}
          </div>
        </div>
        <div class="r-proposal-send-block">
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_c1791596944182","Recipients") ?? "Recipients")}</strong>
          <div class="r-proposal-send-list">
            ${String(contacts.length ? contacts.map((contact, index) => {
              const key = proposalContactKey(contact, index);
              const needsEmail = !proposalRecipientEmailIsValid(contact.email);
              return `
                <div data-send-recipient-index="${index}" style="display:grid;gap:7px">
                  <label class="r-proposal-send-check">
                    <input type="checkbox" data-send-contact-key="${escapeHtml(key)}" ${proposalSendContactKeys.has(key) ? 'checked' : ''}>
                    <span>${escapeHtml(proposalContactLabel(contact))}</span>
                  </label>
                  ${needsEmail ? `
                    <label style="display:grid;gap:5px;padding:0 4px 4px;color:#b42318;font-size:10px;font-weight:950">${(globalThis.PlatformLanguage?.htmlText("proposals","m_7fcfaa1f4fcd66","\n                      Email required to send\n                      ") ?? "\n                      Email required to send\n                      ")}<input class="r-inp" type="email" autocomplete="email" data-send-contact-email-index="${index}" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_2780de7b9bd16a","customer@example.com") ?? "customer@example.com")}" style="border-color:#f2b8b5;background:#fff7f6">
                    </label>
                  ` : ''}
                </div>
              `;
            }).join('') : `
              <div class="r-proposal-send-empty" style="padding-bottom:0">${(globalThis.PlatformLanguage?.htmlText("proposals","m_df09193988aeb7","No customer email is on this project yet.") ?? "No customer email is on this project yet.")}</div>
              <label style="display:grid;gap:5px;padding:0 4px 4px;color:#b42318;font-size:10px;font-weight:950">${(globalThis.PlatformLanguage?.htmlText("proposals","m_c10134dc02336b","\n                Email required to send\n                ") ?? "\n                Email required to send\n                ")}<input class="r-inp" type="email" autocomplete="email" data-send-contact-email-index="0" placeholder="${(globalThis.PlatformLanguage?.htmlText("proposals","m_2780de7b9bd16a","customer@example.com") ?? "customer@example.com")}" style="border-color:#f2b8b5;background:#fff7f6">
              </label>
            `)}
          </div>
        </div>
        <label class="r-proposal-send-message">
          <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a16cfd85cfd122","Message") ?? "Message")}</span>
          <textarea class="r-inp" id="rProposalSendMessage" rows="6">${String(escapeHtml(proposalSendMessage))}</textarea>
        </label>
        <div class="r-proposal-send-options" style="display:grid;gap:8px">
          <label class="r-proposal-send-toggle" style="display:flex;align-items:center;gap:10px;font-weight:900;color:#344054;cursor:pointer">
            <span style="width:42px;height:24px;border-radius:999px;background:${String(proposalSendIncludePdf ? 'var(--primary-readable,var(--primary,#d93025))' : '#d0d5dd')};position:relative;display:inline-flex;flex:0 0 auto">
              <input type="checkbox" id="rProposalSendPdf" ${String(proposalSendIncludePdf ? 'checked' : '')} style="position:absolute;opacity:0;inset:0;cursor:pointer">
              <span style="position:absolute;width:18px;height:18px;left:${String(proposalSendIncludePdf ? '21px' : '3px')};top:3px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(15,23,42,.24);pointer-events:none"></span>
            </span>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_cb0f5faf8487ab","Include PDF attachment") ?? "Include PDF attachment")}</span>
          </label>
          ${String(customerPortalEnabled() ? `
            <label class="r-proposal-send-toggle" style="display:flex;align-items:center;gap:10px;font-weight:900;color:#344054;cursor:pointer">
              <span style="width:42px;height:24px;border-radius:999px;background:${proposalSendIncludePortal ? 'var(--primary-readable,var(--primary,#d93025))' : '#d0d5dd'};position:relative;display:inline-flex;flex:0 0 auto">
                <input type="checkbox" id="rProposalSendPortal" ${proposalSendIncludePortal ? 'checked' : ''} style="position:absolute;opacity:0;inset:0;cursor:pointer">
                <span style="position:absolute;width:18px;height:18px;left:${proposalSendIncludePortal ? '21px' : '3px'};top:3px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(15,23,42,.24);pointer-events:none"></span>
              </span>
              <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_cbb41dfafd178f","Include customer portal link") ?? "Include customer portal link")}</span>
            </label>
            <label class="r-proposal-send-toggle" style="display:flex;align-items:center;gap:10px;font-weight:900;color:#344054;cursor:pointer">
              <span style="width:42px;height:24px;border-radius:999px;background:${proposalSendAllowMultipleSelection ? 'var(--primary-readable,var(--primary,#d93025))' : '#d0d5dd'};position:relative;display:inline-flex;flex:0 0 auto">
                <input type="checkbox" id="rProposalSendAllowMultiple" ${proposalSendAllowMultipleSelection ? 'checked' : ''} style="position:absolute;opacity:0;inset:0;cursor:pointer">
                <span style="position:absolute;width:18px;height:18px;left:${proposalSendAllowMultipleSelection ? '21px' : '3px'};top:3px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(15,23,42,.24);pointer-events:none"></span>
              </span>
              <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a9fa064a3c9985","Allow customer to sign multiple proposals") ?? "Allow customer to sign multiple proposals")}</span>
            </label>
          ` : '')}
        </div>
        <button type="button" class="r-proposal-send-submit" id="rProposalSendSubmit"><i class="fas fa-paper-plane"></i> ${String(selectedIds.size > 1 ? `Send ${selectedIds.size} proposals` : 'Send')}</button>
      </div>
    `;
    const returnFromSend = () => {
      if (proposalSendOrigin === 'edit') enterProposalEditMode(activeProposalIndex);
      else enterProposalListMode(activeProposalIndex);
    };
    list.querySelector('#rProposalSendBack')?.addEventListener('click', returnFromSend);
    list.querySelectorAll('[data-send-proposal-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.sendProposalId || '';
        if (proposalSendSelectedIds.has(id)) proposalSendSelectedIds.delete(id);
        else proposalSendSelectedIds.add(id);
        renderProposalSendSection(section, label, list);
      });
    });
    list.querySelectorAll('[data-send-contact-key]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) proposalSendContactKeys.add(input.dataset.sendContactKey);
        else proposalSendContactKeys.delete(input.dataset.sendContactKey);
      });
    });
    list.querySelector('#rProposalSendMessage')?.addEventListener('input', (event) => {
      proposalSendMessage = event.target.value || '';
    });
    list.querySelector('#rProposalSendPdf')?.addEventListener('change', (event) => {
      proposalSendMessage = list.querySelector('#rProposalSendMessage')?.value || proposalSendMessage;
      proposalSendIncludePdf = !!event.target.checked;
      renderProposalSendSection(section, label, list);
    });
    list.querySelector('#rProposalSendPortal')?.addEventListener('change', (event) => {
      proposalSendMessage = list.querySelector('#rProposalSendMessage')?.value || proposalSendMessage;
      proposalSendIncludePortal = !!event.target.checked;
      renderProposalSendSection(section, label, list);
    });
    list.querySelector('#rProposalSendAllowMultiple')?.addEventListener('change', (event) => {
      proposalSendMessage = list.querySelector('#rProposalSendMessage')?.value || proposalSendMessage;
      proposalSendAllowMultipleSelection = !!event.target.checked;
      renderProposalSendSection(section, label, list);
    });
    list.querySelector('#rProposalSendSubmit')?.addEventListener('click', async () => {
      const ids = selectedProposalIdsForSend();
      if (!ids.length) {
        showToast((globalThis.PlatformLanguage?.text("proposals","m_416dc1906db152","Choose a proposal") ?? "Choose a proposal"), (globalThis.PlatformLanguage?.text("proposals","m_227260f7540d02","Select at least one proposal to send.") ?? "Select at least one proposal to send."), false);
        return;
      }
      if (contacts.length && !proposalSendContactKeys.size) {
        showToast((globalThis.PlatformLanguage?.text("proposals","m_dd0b464b9e566f","Choose a recipient") ?? "Choose a recipient"), (globalThis.PlatformLanguage?.text("proposals","m_3583bf020a417b","Select at least one customer contact.") ?? "Select at least one customer contact."), false);
        return;
      }
      const selectedKeys = new Set([...proposalSendContactKeys].map((key) => String(key || '').trim()));
      const recipientsNeedingEmail = contacts.length
        ? contacts.map((contact, index) => ({ contact, index, key: proposalContactKey(contact, index) }))
          .filter((entry) => selectedKeys.has(entry.key) && !proposalRecipientEmailIsValid(entry.contact.email))
        : [{ contact: {}, index: 0, key: '' }];
      for (const entry of recipientsNeedingEmail) {
        const input = list.querySelector(`[data-send-contact-email-index="${entry.index}"]`);
        const email = String(input?.value || '').trim();
        if (!proposalRecipientEmailIsValid(email)) {
          input?.setAttribute('aria-invalid', 'true');
          input?.focus();
          showToast((globalThis.PlatformLanguage?.text("proposals","m_af28e75ce68abd","Email required") ?? "Email required"), (globalThis.PlatformLanguage?.text("proposals","m_d166660323b5d2","Enter a valid customer email address before sending the proposal.") ?? "Enter a valid customer email address before sending the proposal."), false);
          return;
        }
      }
      const selected = ids.map((id) => ({
        id,
        index: proposals.findIndex((proposal, proposalIndex) => proposalStableId(proposal, proposalIndex) === id)
      })).filter((item) => item.index >= 0);
      if (!selected.length) {
        showToast((globalThis.PlatformLanguage?.text("proposals","m_416dc1906db152","Choose a proposal") ?? "Choose a proposal"), (globalThis.PlatformLanguage?.text("proposals","m_0f27fb06f487e3","The selected proposal could not be found.") ?? "The selected proposal could not be found."), false);
        return;
      }
      const submit = list.querySelector('#rProposalSendSubmit');
      const priorHtml = submit?.innerHTML || '';
      if (submit) {
        submit.disabled = true;
        submit.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Sending ${selected.length > 1 ? `${selected.length} proposals` : '...'}`;
      }
      try {
        for (const entry of recipientsNeedingEmail) {
          const input = list.querySelector(`[data-send-contact-email-index="${entry.index}"]`);
          const oldKey = entry.key;
          const updated = await saveProposalRecipientEmail(entry.contact, entry.index, input?.value || '');
          entry.contact.email = updated.email;
          if (oldKey) proposalSendContactKeys.delete(oldKey);
          proposalSendContactKeys.add(proposalContactKey(updated, entry.index));
        }
        const sent = [];
        for (const item of selected) {
          const result = await sendProposalToBackend(item.index, {
            include_pdf: proposalSendIncludePdf,
            include_portal: customerPortalEnabled() && proposalSendIncludePortal,
            allow_multiple_proposal_selection: proposalSendAllowMultipleSelection,
            message: proposalSendMessage
          });
          sent.push({ ...item, proposal: result.proposal });
        }
        trackRequestActivity({
          type: 'proposal_sent',
          summary: sent.length > 1 ? `Sent ${sent.length} proposals` : 'Sent a proposal',
          target: {
            project_id: activeBaseProject?.id || '',
            project_title: activeBaseProject?.title || sent[0]?.proposal?.title || '',
            project_address: activeBaseProject?.address || sent[0]?.proposal?.address || '',
            proposal_id: sent[0]?.id || ''
          },
          metadata: {
            proposal_ids: sent.map((item) => item.id),
            include_pdf: proposalSendIncludePdf,
            include_portal_link: customerPortalEnabled() && proposalSendIncludePortal,
            allow_multiple_proposal_selection: proposalSendAllowMultipleSelection,
            recipients: [...proposalSendContactKeys],
            message: proposalSendMessage
          }
        });
        queueAutosaveNotice();
        const sentWithPortal = customerPortalEnabled() && proposalSendIncludePortal;
        showToast(
          sent.length > 1 ? 'Proposals sent' : 'Proposal sent',
          sentWithPortal
            ? (sent.length > 1 ? `${sent.length} proposals were sent and the customer portal is ready.` : `${proposalDisplayName(sent[0]?.proposal, sent[0]?.index)} was sent and the customer portal is ready.`)
            : (sent.length > 1 ? `${sent.length} proposals were sent.` : `${proposalDisplayName(sent[0]?.proposal, sent[0]?.index)} was sent.`),
          true
        );
        returnFromSend();
      } catch (error) {
        console.warn('Proposal send failed', error);
        showProposalError('Proposal send failed', error, 'Could not send this proposal. Nothing was marked as sent.');
        if (submit) {
          submit.disabled = false;
          submit.innerHTML = priorHtml;
        }
      }
    });
  }

  function proposalScopeTemplateName(proposal = {}){
    const scope = proposal?.scope && typeof proposal.scope === 'object' ? proposal.scope : {};
    const root = Array.isArray(scope.root_items) ? scope.root_items[0] : null;
    return String(
      scope.template?.name ||
      proposal.scope_template?.name ||
      root?.template_name ||
      root?.display_name ||
      root?.name ||
      'Custom Scope'
    ).trim() || 'Custom Scope';
  }

  function proposalEditorScopeSummaryItems(proposal = {}){
    const scope = normalizeExistingProposalScope(proposal);
    const seen = new Map();
    walkProposalScopeItems(scope.root_items || [], (item) => {
      const selection = item?.selection && typeof item.selection === 'object' ? item.selection : {};
      if (String(selection.mode || '') !== 'choice') return;
      const groupId = String(selection.group_id || selection.groupId || '').trim();
      if (!groupId) return;
      if (!seen.has(groupId)) {
        const group = proposalScopeChoiceGroup(proposal, item);
        seen.set(groupId, {
          id: groupId,
          title: group?.title || titleFromKey(groupId),
          selected: ''
        });
      }
      if (selection.selected === true) {
        const entry = seen.get(groupId);
        entry.selected = String(item.display_name || item.name || item.title || (globalThis.PlatformLanguage?.text("proposals","m_ecefc9f177951e","Selected") ?? "Selected")).trim();
      }
    });
    return Array.from(seen.values());
  }

  function proposalRailTitleHtml(title, subtitle = ''){
    return `
      <span class="r-proposal-rail-title">
        <strong>${escapeHtml(title)}</strong>
        ${subtitle ? `<small> - ${escapeHtml(subtitle)}</small>` : ''}
      </span>
    `;
  }

  function proposalScopeRailBodyHtml(proposal = {}){
    const rows = proposalEditorScopeSummaryItems(proposal);
    if (!rows.length) return `<div class="r-proposal-scope-empty">${(globalThis.PlatformLanguage?.htmlText("proposals","m_d4bd92478d3105","No workflow choices recorded.") ?? "No workflow choices recorded.")}</div>`;
    return `
      <div class="r-proposal-scope-summary">
        ${rows.map((row) => `
          <div class="r-proposal-scope-row">
            <span>${escapeHtml(row.title)}</span>
            <strong>${escapeHtml(row.selected || 'Not selected')}</strong>
          </div>
        `).join('')}
      </div>
    `;
  }

  function proposalControlParkMount(){
    const overlay = document.querySelector('#rOverlay');
    if (!overlay) return null;
    let park = overlay.querySelector('#rProposalControlPark');
    if (!park) {
      park = document.createElement('div');
      park.id = 'rProposalControlPark';
      park.hidden = true;
      overlay.appendChild(park);
    }
    return park;
  }

  function proposalParkRailMountedControls(){
    const park = proposalControlParkMount();
    if (!park) return;
    const agent = document.querySelector('#rOverlay #rProposalAgent');
    const notes = document.querySelector('#rOverlay .r-bottom-notes');
    if (agent && agent.closest('#rProposalList')) park.appendChild(agent);
    if (notes && notes.closest('#rProposalList')) {
      park.appendChild(notes);
    }
  }

  function mobileProposalMainWorkspaceActive(){
    return !!window.matchMedia?.('(max-width: 720px)')?.matches
      && proposalsEnabled()
      && proposalWorkspaceOpen
      && activePreviewTab === 'proposal'
      && !proposalSettingsPanelOpen
      && ['list', 'send'].includes(proposalWorkspaceMode);
  }

  function mobileProposalBuilderActive(){
    return !!window.matchMedia?.('(max-width: 720px)')?.matches
      && proposalsEnabled()
      && proposalWorkspaceOpen
      && activePreviewTab === 'proposal'
      && !proposalSettingsPanelOpen
      && proposalWorkspaceMode === 'builder';
  }

  function renderMobileProposalMainWorkspace(root = proposalPreviewRoot()){
    if (!root || !mobileProposalMainWorkspaceActive()) return false;
    const primaryColor = getProposalPrimaryColor();
    const accentColor = getProposalAccentColor();
    const accentReadable = getProposalAccentReadableColor();
    root.style.setProperty('--primary', primaryColor);
    root.style.setProperty('--primary-readable', primaryColor);
    root.style.setProperty('--primary-rgb', hexToRgbString(primaryColor));
    root.style.setProperty('--accent', accentColor);
    root.style.setProperty('--accent-readable', accentReadable);
    root.style.setProperty('--accent-rgb', hexToRgbString(accentReadable));
    root.innerHTML = '<div class="r-proposal-mobile-main"><div class="r-proposal-listing" id="rProposalMobileMain"></div></div>';
    const list = root.querySelector('#rProposalMobileMain');
    if (!list) return false;
    if (proposalWorkspaceMode === 'list') renderProposalListSection(null, null, list);
    else if (proposalWorkspaceMode === 'builder') renderProposalBuilderSection(null, null, list);
    else if (proposalWorkspaceMode === 'send') renderProposalSendSection(null, null, list);
    return true;
  }

  function renderProposalSectionCore(){
    const section = $('#rProposalSection');
    const label = $('#rProposalLabel');
    const list = $('#rProposalList');
    if (!section || !list) return;
    proposalParkRailMountedControls();
    normalizeProposalCollection();
    const primaryColor = getProposalPrimaryColor();
    const accentColor = getProposalAccentColor();
    const accentReadable = getProposalAccentReadableColor();
    list.style.setProperty('--primary', primaryColor);
    list.style.setProperty('--primary-readable', primaryColor);
    list.style.setProperty('--primary-rgb', hexToRgbString(primaryColor));
    list.style.setProperty('--accent', accentColor);
    list.style.setProperty('--accent-readable', accentReadable);
    list.style.setProperty('--accent-rgb', hexToRgbString(accentReadable));
    list.style.setProperty('--accent-soft', `${accentColor}66`);
    syncProposalWorkspaceChrome();
    if (mobileProposalMainWorkspaceActive() || mobileProposalBuilderActive()) {
      section.classList.remove('visible', 'mode-list', 'mode-edit', 'mode-send');
      list.innerHTML = '';
      if (mobileProposalMainWorkspaceActive()) renderMobileProposalMainWorkspace();
      syncProposalNotesPlacement();
      return;
    }
    if (proposalWorkspaceMode === 'list') {
      renderProposalListSection(section, label, list);
      syncProposalWorkspaceChrome();
      syncProposalNotesPlacement();
      return;
    }
    if (proposalWorkspaceMode === 'builder') {
      renderProposalBuilderSection(section, label, list);
      syncProposalWorkspaceChrome();
      syncProposalNotesPlacement();
      return;
    }
    if (proposalWorkspaceMode === 'send') {
      renderProposalSendSection(section, label, list);
      syncProposalWorkspaceChrome();
      syncProposalNotesPlacement();
      return;
    }
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    section.classList.toggle('visible', visible);
    section.classList.remove('mode-list', 'mode-edit', 'mode-send');
    section.classList.add('mode-edit');
    if (label) label.textContent = (globalThis.PlatformLanguage?.text("proposals","m_3129f3f0e39249","Proposals") ?? "Proposals");
    const proposal = proposals[activeProposalIndex];
    if (!proposal) {
      enterProposalListMode();
      return;
    }
    if (label) label.hidden = visible;
    ensureProposalPageIds(proposal);
    const proposalKey = proposalStableId(proposal, activeProposalIndex);
    normalizeActiveProposalPage(proposal);
    ensureProposalSignatureData(proposal, proposalSigningMode);
    const measurements = ensureProposalMeasurements(proposal);
    const measurementsReady = proposalMeasurementsHaveValues(measurements);
    const measurementStatus = proposal.measurement_source === 'firstmeasure'
      ? 'Pulled from FirstMeasure'
      : (proposal.measurement_source === 'loading'
        ? 'Loading measurements from FirstMeasure'
        : (measurementsReady ? 'Custom measurements' : 'Measurements needed to generate pricing.'));
    const proposalTemplates = visibleProposalTemplates();
    const proposalTemplateCount = allProposalTemplates().length;
    const proposalSectionPageCountCache = new Map();
    const cachedProposalSectionPageCount = (page) => {
      const key = page?.id || proposal.pages.indexOf(page);
      if (!proposalSectionPageCountCache.has(key)) proposalSectionPageCountCache.set(key, proposalSectionPageCount(page));
      return proposalSectionPageCountCache.get(key);
    };
    list.innerHTML = `
      <div class="r-proposal-workspace-head r-proposal-editor-head">
        <button type="button" class="r-proposal-back" id="rProposalBackToList" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_cbdf97ba53cb91","Back to proposals") ?? "Back to proposals")}"><i class="fas fa-arrow-left"></i></button>
        <input class="r-proposal-workspace-title" id="rProposalTitleInput" value="${String(escapeHtml(proposalDisplayName(proposal, activeProposalIndex)))}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_f79017f6ed7635","Proposal name") ?? "Proposal name")}">
        ${String(proposalStatusBadgesHtml(proposal))}
      </div>
      <div class="r-proposal-rail-scroll">
      <section class="r-proposal-rail-section${String(proposalScopeExpanded ? ' expanded' : ' collapsed')}">
        <button type="button" class="r-proposal-rail-toggle" data-proposal-rail-toggle="scope" aria-expanded="${String(proposalScopeExpanded ? 'true' : 'false')}">
          ${String(proposalRailTitleHtml('Scope', proposalScopeTemplateName(proposal)))}
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="r-proposal-rail-body">
          ${String(proposalScopeRailBodyHtml(proposal))}
        </div>
      </section>
      <section class="r-proposal-rail-section r-proposal-measurements${String(proposalMeasurementsExpanded ? ' expanded' : ' collapsed')}">
        <button type="button" class="r-proposal-rail-toggle r-proposal-measure-toggle" id="rProposalMeasureToggle" aria-expanded="${String(proposalMeasurementsExpanded ? 'true' : 'false')}">
          ${String(proposalRailTitleHtml('Measurements', measurementStatus))}
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="r-proposal-rail-body r-proposal-measure-details">
          <div class="r-proposal-pitch-table">
            ${String(PROPOSAL_PITCH_FIELDS.filter((field) => field.key !== 'flatRoofSquares').map((field) => `<div class="r-proposal-pitch-head">${escapeHtml(field.label)}</div>`).join(''))}
            ${String(PROPOSAL_PITCH_FIELDS.filter((field) => field.key !== 'flatRoofSquares').map((field) => `
              <div class="r-proposal-pitch-cell">
                <input type="number" step="0.1" min="0" data-proposal-measurement="${field.key}" value="${escapeHtml(String(measurements[field.key] ?? 0))}">
              </div>
            `).join(''))}
          </div>
          <div class="r-proposal-measure-grid">
            <div class="r-proposal-measure-group">
              <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_291a4d3f753410","Pitched Squares (calculated)") ?? "Pitched Squares (calculated)")}</label>
              <input type="number" step="0.1" min="0" readonly tabindex="-1" data-proposal-calculated="shingleSquares" value="${String(escapeHtml(String(measurements.shingleSquares ?? 0)))}">
            </div>
            <div class="r-proposal-measure-group">
              <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_1501e330cf2cbe","Flat Squares") ?? "Flat Squares")}</label>
              <input type="number" step="0.1" min="0" data-proposal-measurement="flatRoofSquares" value="${String(escapeHtml(String(measurements.flatRoofSquares ?? 0)))}">
            </div>
            <div class="r-proposal-measure-group">
              <label>${(globalThis.PlatformLanguage?.htmlText("proposals","m_13564e80871af7","Total Squares (calculated)") ?? "Total Squares (calculated)")}</label>
              <input type="number" step="0.1" min="0" readonly tabindex="-1" data-proposal-calculated="roofSquares" value="${String(escapeHtml(String(measurements.roofSquares ?? 0)))}">
            </div>
          </div>
          <div class="r-proposal-measure-grid">
            ${String(PROPOSAL_MEASUREMENT_FIELDS.map((field) => `
              <div class="r-proposal-measure-group">
                <label>${escapeHtml(field.label)}</label>
                <input type="number" step="0.1" min="0" data-proposal-measurement="${field.key}" value="${escapeHtml(String(measurements[field.key] ?? 0))}">
              </div>
            `).join(''))}
          </div>
        </div>
      </section>
      <section class="r-proposal-rail-section${String(proposalStyleTemplatesExpanded ? ' expanded' : ' collapsed')}">
        <button type="button" class="r-proposal-rail-toggle" data-proposal-rail-toggle="templates" aria-expanded="${String(proposalStyleTemplatesExpanded ? 'true' : 'false')}">
          ${String(proposalRailTitleHtml('Style Templates', `${proposalTemplateCount} available`))}
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="r-proposal-rail-body">
          <div class="r-proposal-template-row">
            ${String(proposalTemplates.map((template) => `
              <button type="button" class="r-proposal-template-card" data-proposal-template="${escapeHtml(template.id)}">
                <strong>${escapeHtml(template.name)}</strong>
                <span>${escapeHtml(template.description || PROPOSAL_THEMES[template.theme]?.label || 'Proposal template')}</span>
              </button>
            `).join(''))}
          </div>
          <div class="r-proposal-template-actions">
            <button type="button" class="r-proposal-template-action" id="rProposalTemplateMore"><i class="fas fa-layer-group"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_608d7d9597e5d6"," More") ?? " More")}</button>
            <button type="button" class="r-proposal-template-action" id="rProposalTemplateCreate"><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("proposals","m_9bc25b9a45d94c"," Create") ?? " Create")}</button>
          </div>
        </div>
      </section>
      <section class="r-proposal-rail-section${String(proposalStylesExpanded ? ' expanded' : ' collapsed')}">
        <button type="button" class="r-proposal-rail-toggle" data-proposal-rail-toggle="styles" aria-expanded="${String(proposalStylesExpanded ? 'true' : 'false')}">
          ${String(proposalRailTitleHtml('Styles', 'Layout, paper, color, and font'))}
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="r-proposal-rail-body">
          <div class="r-proposal-style-row">
            ${String(Object.keys(PROPOSAL_THEMES).map((theme) => `
              <button type="button" class="r-proposal-style-btn${proposal.theme === theme ? ' active' : ''}" data-proposal-theme="${theme}" data-fm-tooltip="${PROPOSAL_THEMES[theme].label}">
                ${proposalStylePreview(theme)}
              </button>
            `).join(''))}
          </div>
          <div class="r-proposal-color-row">
            <label class="r-proposal-color-field">
              <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_2436076ece8629","Primary") ?? "Primary")}</span>
              <input type="color" data-proposal-color="primary" value="${String(escapeHtml(primaryColor))}">
            </label>
            <label class="r-proposal-color-field">
              <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_af67be591500a3","Secondary") ?? "Secondary")}</span>
              <input type="color" data-proposal-color="secondary" value="${String(escapeHtml(accentColor))}">
            </label>
          </div>
          <div class="r-proposal-type-paper-row">
            <label class="r-proposal-font-field">
              <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_ce1ba13960e5a4","Font") ?? "Font")}</span>
              <select data-proposal-font>
                ${String(PROPOSAL_FONT_OPTIONS.map((font) => `<option value="${escapeHtml(font)}" ${getProposalFontFamily(proposal) === font ? 'selected' : ''}>${escapeHtml(font)}</option>`).join(''))}
              </select>
            </label>
            <label class="r-proposal-font-field">
              <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_b128ef8b7d700d","Paper size") ?? "Paper size")}</span>
              <select data-proposal-paper-size>
                ${String(Object.values(PROPOSAL_PAPER_SIZES).map((paper) => `<option value="${paper.key}" ${getProposalPaperSize(proposal).key === paper.key ? 'selected' : ''}>${paper.label} (${paper.detail})</option>`).join(''))}
              </select>
            </label>
          </div>
        </div>
      </section>
      <section class="r-proposal-rail-section${String(proposalPagesExpanded ? ' expanded' : ' collapsed')} pages-section">
        <button type="button" class="r-proposal-rail-toggle" data-proposal-rail-toggle="pages" aria-expanded="${String(proposalPagesExpanded ? 'true' : 'false')}">
          ${String(proposalRailTitleHtml('Pages', `${proposal.pages.length} page${proposal.pages.length === 1 ? '' : 's'}`))}
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="r-proposal-rail-body r-proposal-pages-list">
        ${String(proposal.pages.map((page, index) => `
          ${index > 0 ? `<div class="r-proposal-list-insert"><button type="button" class="r-proposal-list-insert-btn" data-list-insert-index="${index - 1}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_4d405fa2a01074","Add page") ?? "Add page")}"><i class="fas fa-plus"></i></button></div>` : ''}
          <div class="r-proposal-page-item${index === activeProposalPageIndex ? ' active' : ''}${proposalPageEnabled(page) ? '' : ' disabled'}" data-page-index="${index}" draggable="true" role="button" tabindex="0">
            <div class="r-proposal-page-chip">${index + 1}</div>
            <div class="r-proposal-page-copy">
              <strong>${escapeHtml(page.title || ((v0) => globalThis.PlatformLanguage?.text("proposals","m_5cc367ea2b4774",`Page ${v0}`,{v0}) ?? `Page ${v0}`)(index + 1))}</strong>
              <span>${escapeHtml(proposalPageSubtitle(page))}${cachedProposalSectionPageCount(page) > 1 ? ` • ${cachedProposalSectionPageCount(page)} pages` : ''}</span>
            </div>
            <div class="r-proposal-page-actions">
              ${cachedProposalSectionPageCount(page) > 1 ? `<span class="r-proposal-page-count">${cachedProposalSectionPageCount(page)}</span>` : ''}
              <button type="button" class="r-proposal-page-enable${proposalPageEnabled(page) ? '' : ' off'}" data-page-enabled-toggle="${index}" aria-label="${proposalPageEnabled(page) ? 'Hide page' : 'Show page'}" aria-pressed="${proposalPageEnabled(page) ? 'true' : 'false'}"><i class="fas fa-check"></i></button>
              ${proposal.pages.length > 1 ? (
                proposalDeleteConfirmPageId === page.id
                  ? `<button type="button" class="r-proposal-page-delete confirm" data-page-delete-confirm="${escapeHtml(page.id)}">${(globalThis.PlatformLanguage?.htmlText("proposals","m_4fc60207629a44","Delete") ?? "Delete")}</button>`
                  : `<button type="button" class="r-proposal-page-delete" data-page-delete-arm="${escapeHtml(page.id)}" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_af64ff308ca58e","Delete page") ?? "Delete page")}"><i class="fas fa-trash"></i></button>`
              ) : ''}
              <div class="r-proposal-drag"><i class="fas fa-grip-vertical"></i></div>
            </div>
          </div>
        `).join(''))}
        </div>
      </section>
      <section class="r-proposal-rail-section r-proposal-agent-section" id="rProposalAgentRailSection">
        <div class="r-proposal-rail-body r-proposal-rail-mount" id="rProposalAgentRailMount"></div>
      </section>
      <section class="r-proposal-rail-section r-proposal-notes-section" id="rProposalNotesRailSection">
        <div class="r-proposal-rail-body r-proposal-rail-mount" id="rProposalNotesRailMount"></div>
      </section>
      </div>
    `;
    syncProposalNotesPlacement();
    list.querySelector('#rProposalBackToList')?.addEventListener('click', () => enterProposalListMode(activeProposalIndex));
    list.querySelector('#rProposalTitleInput')?.addEventListener('input', (event) => {
      proposal.title = event.target.value || '';
      queueAutosaveNotice();
    });
    list.querySelector('#rProposalTitleInput')?.addEventListener('blur', (event) => {
      const fallback = proposalDefaultTitle(activeProposalIndex);
      proposal.title = (event.target.value || '').trim() || fallback;
      event.target.value = proposal.title;
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
    });
    list.querySelector('.r-proposal-card')?.addEventListener('click', () => {
      setActivePreviewTab('proposal');
      renderProposalPreview();
    });
    list.querySelectorAll('[data-proposal-template]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const template = allProposalTemplates().find((item) => item.id === btn.dataset.proposalTemplate);
        if (template) applyProposalTemplate(template);
      });
    });
    list.querySelectorAll('[data-proposal-rail-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.proposalRailToggle || '';
        if (section === 'scope') proposalScopeExpanded = !proposalScopeExpanded;
        if (section === 'templates') proposalStyleTemplatesExpanded = !proposalStyleTemplatesExpanded;
        if (section === 'styles') proposalStylesExpanded = !proposalStylesExpanded;
        if (section === 'pages') proposalPagesExpanded = !proposalPagesExpanded;
        renderProposalSection();
      });
    });
    list.querySelector('#rProposalTemplateMore')?.addEventListener('click', openProposalTemplateBrowser);
    list.querySelector('#rProposalTemplateCreate')?.addEventListener('click', openProposalTemplateCreateModal);
    list.querySelectorAll('[data-proposal-theme]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const current = proposalBySaveKey(activeProposalIndex, proposalKey);
        const currentProposal = current.proposal || proposal;
        if (current.proposal) activeProposalIndex = current.index;
        markProposalLocalMutation(currentProposal);
        currentProposal.theme = btn.dataset.proposalTheme || 'margin';
        renderProposalSection();
        renderProposalPreview();
        queueAutosaveNotice();
      });
    });
    list.querySelectorAll('[data-proposal-color]').forEach((input) => {
      input.addEventListener('change', () => {
        const color = normalizeProposalHexColor(input.value, '');
        if (!color) return;
        if (input.dataset.proposalColor === 'primary') proposal.primaryColor = color;
        if (input.dataset.proposalColor === 'secondary') proposal.secondaryColor = color;
        proposal.brandColors = {
          ...(proposal.brandColors && typeof proposal.brandColors === 'object' ? proposal.brandColors : {}),
          primary: proposal.primaryColor || '',
          secondary: proposal.secondaryColor || '',
        };
        renderProposalSection();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    list.querySelector('[data-proposal-font]')?.addEventListener('change', (event) => {
      const current = proposalBySaveKey(activeProposalIndex, proposalKey);
      const currentProposal = current.proposal || proposal;
      if (current.proposal) activeProposalIndex = current.index;
      const font = normalizeProposalFontFamily(event.target.value);
      markProposalLocalMutation(currentProposal);
      currentProposal.fontFamily = font;
      currentProposal.font_family = font;
      currentProposal.typography = {
        ...(currentProposal.typography && typeof currentProposal.typography === 'object' ? currentProposal.typography : {}),
        font_family: font
      };
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
    });
    list.querySelector('[data-proposal-paper-size]')?.addEventListener('change', (event) => {
      const current = proposalBySaveKey(activeProposalIndex, proposalKey);
      const currentProposal = current.proposal || proposal;
      if (current.proposal) activeProposalIndex = current.index;
      const paperSize = normalizeProposalPaperSize(event.target.value);
      markProposalLocalMutation(currentProposal);
      currentProposal.paperSize = paperSize;
      currentProposal.paper_size = paperSize;
      renderProposalSection();
      renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      queueAutosaveNotice();
    });
    list.querySelector('#rProposalMeasureToggle')?.addEventListener('click', () => {
      proposalMeasurementsExpanded = !proposalMeasurementsExpanded;
      renderProposalSection();
    });
    list.querySelectorAll('[data-page-enabled-toggle]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = proposalBySaveKey(activeProposalIndex, proposalKey);
        const currentProposal = current.proposal || proposal;
        if (current.proposal) activeProposalIndex = current.index;
        const index = Number(btn.dataset.pageEnabledToggle || 0);
        const page = currentProposal.pages[index];
        if (!page) return;
        markProposalLocalMutation(currentProposal);
        page.enabled = page.enabled === false;
        proposalDeleteConfirmPageId = null;
        if (index === activeProposalPageIndex && !proposalPageEnabled(page)) normalizeActiveProposalPage(currentProposal);
        renderProposalSection();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    list.querySelectorAll('[data-proposal-measurement]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.proposalMeasurement;
        proposal.measurements = normalizeProposalMeasurements({
          ...ensureProposalMeasurements(proposal),
          [key]: input.value,
        });
        proposal.measurement_source = proposalMeasurementsHaveValues(proposal.measurements) ? 'manual' : 'manual_needed';
        syncProposalMeasurementsToScope(proposal);
        syncProposalPricebookItems(proposal);
        list.querySelectorAll('[data-proposal-calculated]').forEach((calculated) => {
          const calculatedKey = calculated.dataset.proposalCalculated;
          calculated.value = String(proposal.measurements[calculatedKey] ?? 0);
        });
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    const proposalMeasurementInputs = [...list.querySelectorAll('[data-proposal-measurement]')];
    proposalMeasurementInputs.forEach((input) => input.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const currentIndex = proposalMeasurementInputs.indexOf(input);
      const nextInput = proposalMeasurementInputs[currentIndex + (event.shiftKey ? -1 : 1)];
      if (!nextInput) return;
      event.preventDefault();
      nextInput.focus();
      nextInput.select?.();
    }));
    list.querySelectorAll('[data-list-insert-index]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = proposalBySaveKey(activeProposalIndex, proposalKey);
        if (current.proposal) activeProposalIndex = current.index;
        proposalDeleteConfirmPageId = null;
        openProposalInsertChooser(Number(btn.dataset.listInsertIndex || 0));
      });
    });
    list.querySelectorAll('[data-page-delete-arm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        proposalDeleteConfirmPageId = btn.dataset.pageDeleteArm || null;
        renderProposalSection();
      });
    });
    list.querySelectorAll('[data-page-delete-confirm]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pageId = btn.dataset.pageDeleteConfirm || '';
        const pageIndex = proposal.pages.findIndex((page) => page.id === pageId);
        if (pageIndex < 0 || proposal.pages.length <= 1) return;
        proposal.pages = proposal.pages.filter((page) => page.id !== pageId);
        delete proposal.markup?.pages?.[pageId];
        activeProposalPageIndex = Math.max(0, Math.min(activeProposalPageIndex, proposal.pages.length - 1));
        normalizeActiveProposalPage(proposal);
        proposalDeleteConfirmPageId = null;
        renderProposalSection();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    list.querySelectorAll('.r-proposal-page-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        proposalDeleteConfirmPageId = null;
        const pageIndex = Number(btn.dataset.pageIndex || 0);
        if (!proposalPageEnabled(proposal.pages[pageIndex])) return;
        activeProposalPageIndex = pageIndex;
        setActivePreviewTab('proposal');
        renderProposalSection();
        renderProposalPreview();
        setTimeout(() => {
          document.querySelector(`#rProposalPreview [data-proposal-page-index="${activeProposalPageIndex}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 20);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        btn.click();
      });
      btn.addEventListener('dragstart', () => {
        btn.classList.add('dragging');
      });
      btn.addEventListener('dragend', () => {
        btn.classList.remove('dragging');
      });
      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
      });
      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        const dragging = list.querySelector('.r-proposal-page-item.dragging');
        if (!dragging || dragging === btn) return;
        const from = Number(dragging.dataset.pageIndex || 0);
        const to = Number(btn.dataset.pageIndex || 0);
        const pages = [...proposal.pages];
        const [moved] = pages.splice(from, 1);
        pages.splice(to, 0, moved);
        proposal.pages = pages;
        proposalDeleteConfirmPageId = null;
        activeProposalPageIndex = to;
        normalizeActiveProposalPage(proposal);
        renderProposalSection();
        renderProposalPreview();
        queueAutosaveNotice();
      });
    });
  }

  function proposalPreviewRoot(){
    const current = $('#rProposalPreview');
    return current || (state.previewRoot?.isConnected ? state.previewRoot : null);
  }

  function proposalPreviewAvailableWidth(wrap){
    if (!wrap) return PROPOSAL_PREVIEW_PAGE_WIDTH;
    const styles = window.getComputedStyle ? window.getComputedStyle(wrap) : null;
    const horizontalPadding = (parseFloat(styles?.paddingLeft) || 0) + (parseFloat(styles?.paddingRight) || 0);
    return Math.max(1, (wrap.clientWidth || PROPOSAL_PREVIEW_PAGE_WIDTH) - horizontalPadding);
  }

  function syncProposalPreviewScale(root = proposalPreviewRoot()){
    const wrap = root?.querySelector?.('.r-proposal-wrap');
    const pages = root?.querySelector?.('.r-proposal-pages');
    if (!wrap || !pages) return;
    const baseWidth = parseFloat(pages.style.getPropertyValue('--proposal-page-base-width')) || proposalPaperDimensions().widthPx;
    const scale = Math.min(1, Math.max(0.05, proposalPreviewAvailableWidth(wrap) / baseWidth));
    pages.style.setProperty('--proposal-page-scale', String(Math.round(scale * 10000) / 10000));
  }

  function observeProposalPreviewScale(root = proposalPreviewRoot()){
    const wrap = root?.querySelector?.('.r-proposal-wrap');
    if (!root || !wrap) return;
    syncProposalPreviewScale(root);
    root.__proposalPreviewScaleObserver?.disconnect?.();
    if (typeof ResizeObserver !== 'function') return;
    root.__proposalPreviewScaleObserver = new ResizeObserver(() => syncProposalPreviewScale(root));
    root.__proposalPreviewScaleObserver.observe(wrap);
  }

  function renderProposalBuilderPreview(root){
    ensureProposalBuilderAnimationStyles();
    root.classList.toggle('r-builder-no-pane-animation', proposalBuilderQuietRender);
    const primaryColor = getProposalPrimaryColor();
    const accentColor = getProposalAccentColor();
    const accentReadable = getProposalAccentReadableColor();
    root.style.setProperty('--primary', primaryColor);
    root.style.setProperty('--primary-readable', primaryColor);
    root.style.setProperty('--primary-rgb', hexToRgbString(primaryColor));
    root.style.setProperty('--accent', accentColor);
    root.style.setProperty('--accent-readable', accentReadable);
    root.style.setProperty('--accent-rgb', hexToRgbString(accentReadable));
    root.style.setProperty('--accent-soft', `${accentColor}66`);
    const builder = proposalBuilderState || { mode: 'select', query: '' };
    const mobileBuilder = mobileProposalBuilderActive();
    const mobilePicker = mobileBuilder && builder.mode !== 'loading' && !builder.root;
    const content = builder.mode === 'loading'
      ? proposalBuilderLoadingHtml(builder)
      : (!builder.root ? proposalBuilderTemplatePickerHtml(builder, { showBack: false, mobile: false }) : proposalBuilderStepBodyHtml(builder));
    const mainActions = builder.root && builder.mode !== 'loading' ? proposalBuilderMainActionsHtml(builder, { mobile:mobileBuilder }) : '';
    root.innerHTML = mobileBuilder ? `
      <div class="r-proposal-wrap r-builder-wrap r-builder-mobile-wrap">
        <div class="r-builder-mobile-shell">
          <div class="r-builder-step-pane r-builder-mobile-content">
            ${builder.root && builder.mode !== 'loading' ? proposalBuilderMobileHeaderHtml(builder) : ''}
            ${content}
          </div>
          ${mobilePicker ? `<footer class="r-builder-mobile-picker-footer">${proposalBuilderActiveScopeHtml(builder, { compact:true })}</footer>` : ''}
          ${builder.root && builder.mode !== 'loading' ? `<footer class="r-builder-mobile-footer">${proposalBuilderScopeTotalHtml(builder, { compact:true })}${proposalBuilderMobileStepNavHtml(builder)}${mainActions}</footer>` : ''}
        </div>
      </div>
    ` : `
      <div class="r-proposal-wrap r-builder-wrap">
        <div class="r-builder-step-pane" style="width:min(980px,calc(100% - 40px));height:calc(100% - 56px);min-height:0;margin:28px auto;display:flex;flex-direction:column;gap:14px">
          ${content}
          ${mainActions}
        </div>
      </div>
    `;
    bindProposalBuilderControls(root);
    proposalBuilderSyncInfoModal();
  }

  function renderProjectScopeBuilder(roots = {}, options = {}){
    ensureProposalBuilderAnimationStyles();
    const leftRoot = roots.left || roots.sidebar || state.leftRoot;
    const previewRoot = roots.main || roots.preview || state.previewRoot || $('#rProposalPreview');
    const previousQuietRender = proposalBuilderQuietRender;
    proposalBuilderQuietRender = !!options.quiet;
    try {
      if (leftRoot) {
        leftRoot.innerHTML = proposalBuilderSidebarHtml(proposalBuilderState || { mode: 'select', query: '' });
        bindProposalBuilderControls(leftRoot);
      }
      if (previewRoot) renderProposalBuilderPreview(previewRoot);
    } finally {
      proposalBuilderQuietRender = previousQuietRender;
    }
  }

  function renderProposalPreviewCore(preservedScrollTop = null, rootOverride = null){
    const root = rootOverride || proposalPreviewRoot();
    if (!root) return;
    closeProposalPricebookSuggest();
    if (proposalSettingsPanelOpen) {
      mountProposalSettingsPanel();
      return;
    }
    if (mobileProposalMainWorkspaceActive()) {
      renderMobileProposalMainWorkspace(root);
      return;
    }
    if (proposalWorkspaceMode === 'builder') {
      renderProposalBuilderPreview(root);
      return;
    }
    root.classList.remove('r-builder-no-pane-animation');
    normalizeProposalCollection();
    const proposal = proposals[activeProposalIndex];
    if (!proposal) {
      root.innerHTML = `
        <div class="r-proposal-preview-empty">
          <i class="fas fa-file-circle-plus"></i>
          <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_0db7d031187d44","No proposal selected") ?? "No proposal selected")}</strong>
          <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_a054fbc345e731","Create a proposal from the left column to preview it here.") ?? "Create a proposal from the left column to preview it here.")}</span>
          <button type="button" class="r-proposal-preview-create" data-proposal-preview-create>
            <i class="fas fa-plus"></i>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_f92c72190aa503","Create proposal") ?? "Create proposal")}</span>
          </button>
        </div>
      `;
      root.querySelector('[data-proposal-preview-create]')?.addEventListener('click', createNewProposalAndEdit);
      return;
    }
    ensureProposalPageIds(proposal);
    normalizeActiveProposalPage(proposal);
    ensureProposalMarkup(proposal);
    ensureProposalSignatureData(proposal, proposalSigningMode);
    const primaryColor = getProposalPrimaryColor();
    const accentColor = getProposalAccentColor();
    const accentReadable = getProposalAccentReadableColor();
    const fontFamily = getProposalFontFamily(proposal);
    root.style.setProperty('--primary', primaryColor);
    root.style.setProperty('--primary-readable', primaryColor);
    root.style.setProperty('--primary-rgb', hexToRgbString(primaryColor));
    root.style.setProperty('--accent', accentColor);
    root.style.setProperty('--accent-readable', accentReadable);
    root.style.setProperty('--accent-rgb', hexToRgbString(accentReadable));
    root.style.setProperty('--accent-soft', `${accentColor}66`);
    root.style.setProperty('--proposal-font-family', proposalFontStack(fontFamily));
    const priorWrap = root.querySelector('.r-proposal-wrap');
    const scrollTop = preservedScrollTop ?? priorWrap?.scrollTop ?? 0;
    const viewMode = proposalWorkspaceMode === 'edit' ? proposalEditorMode : 'preview';
    root.innerHTML = `
      <div class="r-proposal-wrap${proposalMarkupMode && viewMode === 'edit' ? ' markup-active' : ''}">
        <div class="r-proposal-pages" style="${proposalPageCssVariables(proposal)}">
          ${proposalRenderedPageStackHtml(proposal, { viewMode, includeInsertControls: viewMode === 'edit' })}
        </div>
      </div>
      ${viewMode === 'edit' ? proposalLineChoiceSettingsPopoverHtml(proposal) : ''}
    `;
    const wrap = root.querySelector('.r-proposal-wrap');
    observeProposalPreviewScale(root);
    renderProposalPdfCanvasPages(root);
    bindProposalVideoPlayback(root);
    if (wrap) wrap.scrollTop = scrollTop;
    if (wrap) {
      wrap.style.cursor = proposalMarkupMode ? proposalMarkupCursorSvg() : '';
      wrap.addEventListener('scroll', () => {
        document.querySelectorAll('body > .r-proposal-rich-toolbar').forEach((toolbar) => toolbar._reposition?.());
      }, { passive: true });
    }
    if (!state.richToolbarResizeBound) {
      state.richToolbarResizeBound = true;
      window.addEventListener('resize', () => {
        syncProposalPreviewScale();
        document.querySelectorAll('body > .r-proposal-rich-toolbar').forEach((toolbar) => toolbar._reposition?.());
      }, { passive: true });
    }
    wrap?.addEventListener('click', (e) => {
      if (proposalVariationMenuState && !e.target.closest('.r-proposal-variation-cell')) {
        proposalVariationMenuState = null;
        renderProposalPreview(wrap?.scrollTop ?? 0);
        return;
      }
      if (proposalLineMenuState && !e.target.closest('.r-proposal-line-more-wrap')) {
        proposalLineMenuState = null;
        renderProposalPreview(wrap?.scrollTop ?? 0);
        return;
      }
      if (proposalInsertIndex === null) return;
      if (e.target.closest('.r-proposal-page-insert')) return;
      proposalInsertIndex = null;
      renderProposalPreview(wrap?.scrollTop ?? 0);
    });
    const focusProposalField = (el, placeAtEnd = false) => {
      if (!el) return;
      el.focus();
      const selection = window.getSelection?.();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(!placeAtEnd);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const selectProposalFieldContents = (el) => {
      if (!el) return;
      el.focus();
      const selection = window.getSelection?.();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const editableFields = () => Array.from(root.querySelectorAll('[data-proposal-field][contenteditable="true"]:not(.is-preview):not([data-proposal-derived="true"])'));
    const controlPageIndex = (el) => Number(el?.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
    const focusProposalFieldByPath = (pageIndex, fieldPath, placeAtEnd = false) => {
      const fields = Array.from(root.querySelectorAll(`[data-proposal-page-index="${pageIndex}"] [data-proposal-field="${fieldPath}"]`));
      const target = fields[fields.length - 1];
      if (!target) return;
      activeProposalPageIndex = pageIndex;
      target.closest('.r-proposal-page')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      requestAnimationFrame(() => focusProposalField(target, placeAtEnd));
    };
    const applyRichFieldVisualState = (field) => {
      if (!field?.dataset?.proposalRich) return;
      const textAlign = field.dataset.textAlign || '';
      const vAlign = field.dataset.vAlign || '';
      if (textAlign) field.setAttribute('data-text-align', textAlign);
      else field.removeAttribute('data-text-align');
      if (vAlign) field.setAttribute('data-v-align', vAlign);
      else field.removeAttribute('data-v-align');
    };
    const proposalPlainTextFromField = (field) => {
      if (!field) return '';
      const clone = field.cloneNode(true);
      clone.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')));
      clone.querySelectorAll('div,p').forEach((block) => {
        if (block !== clone) block.after(document.createTextNode('\n'));
      });
      return normalizeProposalPlainText(clone.textContent || field.innerText || '');
    };
    const syncProposalFieldValue = (field, pageIndex, fieldPath, fieldType, options = {}) => {
      if (!field || field.dataset.proposalDerived === 'true') return;
      if (field.dataset.proposalRich === 'true') {
        const nextHtml = sanitizeProposalRichHtml(field.innerHTML);
        if (field.innerHTML !== nextHtml) field.innerHTML = nextHtml;
        setProposalField(activeProposalIndex, pageIndex, fieldPath, nextHtml);
        setProposalFieldStyles(proposals[activeProposalIndex]?.pages?.[pageIndex], fieldPath, {
          textAlign: field.dataset.textAlign || '',
          verticalAlign: field.dataset.vAlign || '',
        });
        applyRichFieldVisualState(field);
        return;
      }
      let nextValue = fieldPath === 'preparedFor'
        ? proposalPlainTextFromField(field)
        : field.innerText.replace(/\u00a0/g, ' ').trim();
      if (fieldType === 'integer') {
        nextValue = normalizeProposalInteger(nextValue);
        field.textContent = nextValue;
      } else if (fieldType === 'number') {
        nextValue = normalizeProposalNumber(nextValue);
        if (options.commit) field.textContent = nextValue;
      } else if (fieldType === 'currency') {
        const normalized = normalizeProposalNumber(nextValue);
        nextValue = proposalCurrencyDisplay(normalized || 0);
        if (options.commit) field.textContent = proposalCurrencyEditText(nextValue);
      }
      setProposalField(activeProposalIndex, pageIndex, fieldPath, nextValue);
    };
    const removeRichToolbars = () => {
      root.querySelectorAll('.r-proposal-rich-toolbar').forEach((toolbar) => {
        toolbar._cleanup?.();
        toolbar.classList.remove('visible');
        toolbar.remove();
      });
      document.querySelectorAll('body > .r-proposal-rich-toolbar').forEach((toolbar) => {
        toolbar._cleanup?.();
        toolbar.classList.remove('visible');
        toolbar.remove();
      });
    };
    const updateRichToolbarState = (field, toolbar) => {
      if (!field || !toolbar) return;
      toolbar.querySelectorAll('[data-rich-align]').forEach((btn) => btn.classList.toggle('active', btn.dataset.richAlign === (field.dataset.textAlign || '')));
      toolbar.querySelectorAll('[data-rich-valign]').forEach((btn) => btn.classList.toggle('active', btn.dataset.richValign === (field.dataset.vAlign || '')));
      try {
        toolbar.querySelectorAll('[data-rich-command]').forEach((btn) => btn.classList.toggle('active', document.queryCommandState?.(btn.dataset.richCommand || '') || false));
      } catch (err) {}
    };
    const showRichToolbar = (field, pageIndex, fieldPath) => {
      if (!field || field.dataset.proposalRich !== 'true' || field.dataset.proposalReadonly === 'true') return;
      const existing = document.body.querySelector('.r-proposal-rich-toolbar.visible');
      if (existing?._field === field) {
        existing._saveRange?.();
        existing._reposition?.();
        updateRichToolbarState(field, existing);
        return;
      }
      removeRichToolbars();
      let savedRange = null;
      const saveRange = () => {
        const selection = window.getSelection?.();
        if (!selection || !selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!field.contains(range.commonAncestorContainer)) return;
        savedRange = range.cloneRange();
      };
      const restoreRange = () => {
        field.focus();
        const selection = window.getSelection?.();
        if (!selection) return;
        selection.removeAllRanges();
        if (savedRange) {
          selection.addRange(savedRange);
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        selection.addRange(range);
      };
      const toolbar = document.createElement('div');
      toolbar.className = 'r-proposal-rich-toolbar';
      toolbar.innerHTML = `
        <div class="group">
          <button type="button" class="r-proposal-rich-btn" data-rich-command="bold" data-fm-tooltip="Bold"><i class="fas fa-bold"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-command="italic" data-fm-tooltip="Italic"><i class="fas fa-italic"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-command="underline" data-fm-tooltip="Underline"><i class="fas fa-underline"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-command="strikeThrough" data-fm-tooltip="Strike Through"><i class="fas fa-strikethrough"></i></button>
        </div>
        <div class="group">
          <label class="r-proposal-rich-color" data-fm-tooltip="Text color">
            <span style="--swatch:${escapeHtml(proposalMarkupStrokeColor)}"></span>
            <input type="color" value="${escapeHtml(proposalMarkupStrokeColor)}" data-rich-color="true">
          </label>
        </div>
        <div class="group">
          <button type="button" class="r-proposal-rich-btn" data-rich-align="left" data-fm-tooltip="Align Left"><i class="fas fa-align-left"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-align="center" data-fm-tooltip="Align Center"><i class="fas fa-align-center"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-align="right" data-fm-tooltip="Align Right"><i class="fas fa-align-right"></i></button>
        </div>
        <div class="group">
          <button type="button" class="r-proposal-rich-btn" data-rich-valign="top" data-fm-tooltip="Align Top"><i class="fas fa-arrow-up"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-valign="center" data-fm-tooltip="Align Middle"><i class="fas fa-grip-lines"></i></button>
          <button type="button" class="r-proposal-rich-btn" data-rich-valign="bottom" data-fm-tooltip="Align Bottom"><i class="fas fa-arrow-down"></i></button>
        </div>
      `;
      toolbar.addEventListener('mousedown', (evt) => evt.preventDefault());
      const handleSelectionChange = () => saveRange();
      document.addEventListener('selectionchange', handleSelectionChange);
      toolbar._cleanup = () => document.removeEventListener('selectionchange', handleSelectionChange);
      toolbar._field = field;
      toolbar._saveRange = saveRange;
      saveRange();
      const applyRichCommand = (handler) => (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        restoreRange();
        handler();
        saveRange();
        syncProposalFieldValue(field, pageIndex, fieldPath, field.dataset.proposalType || '');
        renderProposalSection();
        updateRichToolbarState(field, toolbar);
        requestAnimationFrame(() => {
          const nextField = document.querySelector(`#rProposalPreview [data-proposal-page-index="${pageIndex}"] [data-proposal-field="${CSS.escape(fieldPath)}"]`);
          if (nextField?.dataset?.proposalRich === 'true') showRichToolbar(nextField, pageIndex, fieldPath);
        });
      };
      toolbar.querySelectorAll('[data-rich-command]').forEach((btn) => {
        btn.addEventListener('mousedown', applyRichCommand(() => {
          restoreRange();
          document.execCommand?.('styleWithCSS', false, true);
          document.execCommand?.(btn.dataset.richCommand || '', false, null);
        }));
      });
      toolbar.querySelectorAll('[data-rich-align]').forEach((btn) => {
        btn.addEventListener('mousedown', applyRichCommand(() => {
          field.dataset.textAlign = btn.dataset.richAlign || 'left';
          applyRichFieldVisualState(field);
        }));
      });
      toolbar.querySelectorAll('[data-rich-valign]').forEach((btn) => {
        btn.addEventListener('mousedown', applyRichCommand(() => {
          field.dataset.vAlign = btn.dataset.richValign || 'top';
          applyRichFieldVisualState(field);
        }));
      });
      toolbar.querySelector('[data-rich-color="true"]')?.addEventListener('input', applyRichCommand((evt) => {
        const input = toolbar.querySelector('[data-rich-color="true"]');
        const color = normalizeProposalHexColor(input?.value, proposalMarkupStrokeColor);
        toolbar.querySelector('.r-proposal-rich-color span')?.style.setProperty('--swatch', color);
        document.execCommand?.('styleWithCSS', false, true);
        document.execCommand?.('foreColor', false, color);
      }));
      document.body.appendChild(toolbar);
      const positionToolbar = () => {
        const rect = field.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const centerX = rect.left + (rect.width / 2);
        const minX = toolbarRect.width / 2 + 12;
        const maxX = window.innerWidth - (toolbarRect.width / 2) - 12;
        toolbar.style.left = `${Math.max(minX, Math.min(maxX, centerX))}px`;
        toolbar.style.top = `${rect.bottom - 42}px`;
        toolbar.style.transform = 'translate(-50%,0)';
      };
      requestAnimationFrame(() => {
        positionToolbar();
        toolbar.classList.add('visible');
      });
      toolbar._reposition = positionToolbar;
      updateRichToolbarState(field, toolbar);
    };
    const attachMarkupOverlay = () => {
      if (!proposalMarkupMode) return;
      let drawing = null;
      let textEditor = null;
      let pendingArrowStart = null;
      let draggingHandle = null;
      const deleteMarkupItem = (pageId, itemId) => {
        const markup = ensureProposalMarkup(proposal);
        const items = markup.pages[pageId] || [];
        const nextItems = items.filter((item) => item.id !== itemId);
        if (nextItems.length === items.length) return false;
        markup.pages[pageId] = nextItems;
        pushProposalMarkupHistory(proposal);
        queueAutosaveNotice();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        return true;
      };
      const refreshMarkupItemDom = (layer, item) => {
        if (!layer || !item) return;
        if (item.type === 'text') {
          const text = layer.querySelector(`[data-markup-text-id="${item.id}"]`);
          const handle = layer.querySelector(`[data-markup-handle-id="${item.id}"][data-markup-handle-kind="text"]`);
          const deleteBtn = layer.querySelector(`[data-markup-delete-id="${item.id}"]`);
          const pos = pointToPercent({ x: item.x, y: item.y });
          if (text) {
            text.style.left = pos.x;
            text.style.top = pos.y;
            text.style.color = item.color || '#111111';
          }
          if (handle) {
            handle.style.left = pos.x;
            handle.style.top = pos.y;
          }
          if (deleteBtn) {
            deleteBtn.style.left = `calc(${pos.x} + 88px)`;
            deleteBtn.style.top = `calc(${pos.y} - 10px)`;
          }
          return;
        }
        if (item.type === 'arrow') {
          const geom = proposalArrowGeometry(item);
          const lines = layer.querySelectorAll(`[data-markup-arrow-id="${item.id}"]`);
          const start = pointToPercent({ x: item.x1, y: item.y1 });
          const end = pointToPercent({ x: item.x2, y: item.y2 });
          const deleteBtn = layer.querySelector(`[data-markup-delete-id="${item.id}"]`);
          lines.forEach((line) => {
            const part = line.dataset.arrowPart || 'shaft';
            const segment = geom[part] || geom.shaft;
            line.setAttribute('x1', String((segment.x1 * 100).toFixed(3)));
            line.setAttribute('y1', String((segment.y1 * 100).toFixed(3)));
            line.setAttribute('x2', String((segment.x2 * 100).toFixed(3)));
            line.setAttribute('y2', String((segment.y2 * 100).toFixed(3)));
            line.style.stroke = item.color || '#111111';
            line.style.strokeWidth = String(item.size || 2.2);
          });
          const startHandle = layer.querySelector(`[data-markup-handle-id="${item.id}"][data-markup-handle-kind="arrow-start"]`);
          const endHandle = layer.querySelector(`[data-markup-handle-id="${item.id}"][data-markup-handle-kind="arrow-end"]`);
          if (startHandle) {
            startHandle.style.left = start.x;
            startHandle.style.top = start.y;
          }
          if (endHandle) {
            endHandle.style.left = end.x;
            endHandle.style.top = end.y;
          }
          if (deleteBtn) {
            deleteBtn.style.left = `${(((item.x1 + item.x2) / 2) * 100).toFixed(3)}%`;
            deleteBtn.style.top = `${(((item.y1 + item.y2) / 2) * 100).toFixed(3)}%`;
          }
        }
      };
      const openTextEditorAt = (layer, page, point, existingItem = null) => {
        finishTextEditor(false);
        const markup = ensureProposalMarkup(proposal);
        const itemId = existingItem?.id || createProposalPageId();
        markup.pages[page.id] ||= [];
        if (!existingItem) {
          markup.pages[page.id].push({ id: itemId, type: 'text', x: point.x, y: point.y, text: '', color: proposalMarkupStrokeColor });
          pushProposalMarkupHistory(proposal);
        }
        const editor = document.createElement('textarea');
        editor.className = 'r-proposal-page-markup-editor';
        editor.style.left = `${((existingItem?.x ?? point.x) * 100).toFixed(3)}%`;
        editor.style.top = `${((existingItem?.y ?? point.y) * 100).toFixed(3)}%`;
        editor.style.color = existingItem?.color || proposalMarkupStrokeColor;
        editor.value = existingItem?.text || '';
        layer.querySelector('.r-proposal-page-markup-surface')?.appendChild(editor);
        textEditor = { proposalRef: proposal, pageRef: page, itemId, editor };
        editor.focus();
        editor.addEventListener('keydown', (keyEvt) => {
          if (keyEvt.key === 'Escape') {
            keyEvt.preventDefault();
            finishTextEditor(false);
          } else if (keyEvt.key === 'Enter' && !keyEvt.shiftKey) {
            keyEvt.preventDefault();
            finishTextEditor(true);
          }
        });
        editor.addEventListener('blur', () => finishTextEditor(true));
      };
      const eraseAtPoint = (pageId, point) => {
        const markup = ensureProposalMarkup(proposal);
        const items = markup.pages[pageId] || [];
        const targetIndex = findNearestMarkupItem(items, point);
        if (targetIndex < 0) return false;
        items.splice(targetIndex, 1);
        pushProposalMarkupHistory(proposal);
        queueAutosaveNotice();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        return true;
      };
      const finishTextEditor = (commit = true) => {
        if (!textEditor) return;
        const { proposalRef, pageRef, itemId, editor } = textEditor;
        const markup = ensureProposalMarkup(proposalRef);
        const pageItems = markup.pages[pageRef.id] || [];
        const item = pageItems.find((entry) => entry.id === itemId);
        if (item) {
          const nextText = editor.value.replace(/\r/g, '').trim();
          if (commit && nextText) item.text = nextText;
          else markup.pages[pageRef.id] = pageItems.filter((entry) => entry.id !== itemId);
          pushProposalMarkupHistory(proposalRef);
          queueAutosaveNotice();
          renderProposalPreview(wrap?.scrollTop ?? 0);
        }
        textEditor = null;
      };
      root.querySelectorAll('[data-markup-page-id]').forEach((layer) => {
        const pageId = layer.dataset.markupPageId;
        const page = proposal.pages.find((entry) => entry.id === pageId);
        if (!page) return;
        const getPoint = (evt) => {
          const rect = layer.getBoundingClientRect();
          return {
            x: Math.max(0, Math.min(1, (evt.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (evt.clientY - rect.top) / rect.height)),
          };
        };
        layer.addEventListener('pointerdown', (evt) => {
          if (evt.button !== 0 || textEditor) return;
          const deleteBtn = evt.target.closest('[data-markup-delete-id]');
          if (deleteBtn) {
            evt.preventDefault();
            evt.stopPropagation();
            deleteMarkupItem(pageId, deleteBtn.dataset.markupDeleteId);
            return;
          }
          const handle = evt.target.closest('[data-markup-handle-id]');
          if (handle) {
            evt.preventDefault();
            const markup = ensureProposalMarkup(proposal);
            const items = markup.pages[pageId] || [];
            const item = items.find((entry) => entry.id === handle.dataset.markupHandleId);
            if (!item) return;
            draggingHandle = { layer, pageId, item, kind: handle.dataset.markupHandleKind };
            layer.setPointerCapture?.(evt.pointerId);
            return;
          }
          evt.preventDefault();
          const point = getPoint(evt);
          if (proposalMarkupTool === 'text') {
            openTextEditorAt(layer, page, point);
            return;
          }
          if (proposalMarkupTool === 'eraser') {
            drawing = { erase: true, pageId };
            eraseAtPoint(pageId, point);
            return;
          }
          if (proposalMarkupTool === 'arrow') {
            const markup = ensureProposalMarkup(proposal);
            if (pendingArrowStart && pendingArrowStart.pageId === pageId) {
              drawing = { arrow: true, pageId, start: pendingArrowStart.point, current: point, markup };
              pendingArrowStart = null;
            } else {
              drawing = { arrow: true, pageId, start: point, current: point, markup };
            }
            layer.setPointerCapture?.(evt.pointerId);
            const svg = layer.querySelector('.r-proposal-page-markup-svg');
            const makeLine = (part) => {
              const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              line.setAttribute('class', 'r-proposal-page-markup-arrow');
              line.dataset.arrowPart = part;
              line.setAttribute('style', `stroke:${proposalMarkupStrokeColor};stroke-width:${proposalMarkupStrokeSize}`);
              svg?.appendChild(line);
              return line;
            };
            drawing.lines = {
              shaft: makeLine('shaft'),
              left: makeLine('left'),
              right: makeLine('right'),
            };
            const geom = proposalArrowGeometry({ x1: drawing.start.x, y1: drawing.start.y, x2: point.x, y2: point.y, size: proposalMarkupStrokeSize });
            Object.entries(drawing.lines).forEach(([part, line]) => {
              const segment = geom[part];
              line.setAttribute('x1', String((segment.x1 * 100).toFixed(3)));
              line.setAttribute('y1', String((segment.y1 * 100).toFixed(3)));
              line.setAttribute('x2', String((segment.x2 * 100).toFixed(3)));
              line.setAttribute('y2', String((segment.y2 * 100).toFixed(3)));
            });
            return;
          }
          const markup = ensureProposalMarkup(proposal);
          drawing = { pageId, points: [point] };
          layer.setPointerCapture?.(evt.pointerId);
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'r-proposal-page-markup-path');
          path.setAttribute('d', proposalMarkupSvgPath(drawing.points));
          path.setAttribute('style', `stroke:${proposalMarkupStrokeColor};stroke-width:${proposalMarkupStrokeSize}`);
          layer.querySelector('.r-proposal-page-markup-svg')?.appendChild(path);
          drawing.path = path;
          drawing.markup = markup;
        });
        layer.addEventListener('pointermove', (evt) => {
          if (draggingHandle && draggingHandle.pageId === pageId) {
            const point = getPoint(evt);
            if (draggingHandle.item.type === 'text') {
              draggingHandle.item.x = point.x;
              draggingHandle.item.y = point.y;
            } else if (draggingHandle.item.type === 'arrow') {
              if (draggingHandle.kind === 'arrow-start') {
                draggingHandle.item.x1 = point.x;
                draggingHandle.item.y1 = point.y;
              } else {
                draggingHandle.item.x2 = point.x;
                draggingHandle.item.y2 = point.y;
              }
            }
            refreshMarkupItemDom(layer, draggingHandle.item);
            return;
          }
          if (!drawing || drawing.pageId !== pageId) return;
          if (drawing.erase) {
            eraseAtPoint(pageId, getPoint(evt));
            return;
          }
          if (drawing.arrow) {
            const point = getPoint(evt);
            drawing.current = point;
            const geom = proposalArrowGeometry({ x1: drawing.start.x, y1: drawing.start.y, x2: point.x, y2: point.y, size: proposalMarkupStrokeSize });
            Object.entries(drawing.lines || {}).forEach(([part, line]) => {
              const segment = geom[part];
              if (!line || !segment) return;
              line.setAttribute('x1', String((segment.x1 * 100).toFixed(3)));
              line.setAttribute('y1', String((segment.y1 * 100).toFixed(3)));
              line.setAttribute('x2', String((segment.x2 * 100).toFixed(3)));
              line.setAttribute('y2', String((segment.y2 * 100).toFixed(3)));
            });
            return;
          }
          const point = getPoint(evt);
          drawing.points.push(point);
          drawing.path?.setAttribute('d', proposalMarkupSvgPath(drawing.points));
        });
        const endStroke = (evt) => {
          if (draggingHandle && draggingHandle.pageId === pageId) {
            evt?.preventDefault?.();
            pushProposalMarkupHistory(proposal);
            queueAutosaveNotice();
            renderProposalPreview(wrap?.scrollTop ?? 0);
            draggingHandle = null;
            return;
          }
          if (!drawing || drawing.pageId !== pageId) return;
          evt?.preventDefault?.();
          if (drawing.erase) {
            drawing = null;
            return;
          }
          if (drawing.arrow) {
            const start = drawing.start;
            const end = drawing.current;
            Object.values(drawing.lines || {}).forEach((line) => line?.remove());
            const traveled = Math.hypot((end.x - start.x), (end.y - start.y));
            if (traveled < 0.008) {
              if (!pendingArrowStart) pendingArrowStart = { pageId, point: start };
              else if (pendingArrowStart.pageId === pageId) {
                drawing.markup.pages[pageId] ||= [];
                drawing.markup.pages[pageId].push({ id: createProposalPageId(), type: 'arrow', x1: pendingArrowStart.point.x, y1: pendingArrowStart.point.y, x2: end.x, y2: end.y, color: proposalMarkupStrokeColor, size: proposalMarkupStrokeSize });
                pushProposalMarkupHistory(proposal);
                pendingArrowStart = null;
                queueAutosaveNotice();
                renderProposalPreview(wrap?.scrollTop ?? 0);
              }
              drawing = null;
              return;
            }
            drawing.markup.pages[pageId] ||= [];
            drawing.markup.pages[pageId].push({ id: createProposalPageId(), type: 'arrow', x1: start.x, y1: start.y, x2: end.x, y2: end.y, color: proposalMarkupStrokeColor, size: proposalMarkupStrokeSize });
            pushProposalMarkupHistory(proposal);
            drawing = null;
            pendingArrowStart = null;
            queueAutosaveNotice();
            renderProposalPreview(wrap?.scrollTop ?? 0);
            return;
          }
          const points = drawing.points;
          const traveled = points.reduce((sum, point, index) => {
            if (!index) return sum;
            const prev = points[index - 1];
            return sum + Math.hypot(point.x - prev.x, point.y - prev.y);
          }, 0);
          drawing.path?.remove();
          if (traveled < 0.008) {
            drawing = null;
            return;
          }
          drawing.markup.pages[pageId] ||= [];
          drawing.markup.pages[pageId].push({ id: createProposalPageId(), type: 'stroke', points, color: proposalMarkupStrokeColor, size: proposalMarkupStrokeSize });
          pushProposalMarkupHistory(proposal);
          drawing = null;
          queueAutosaveNotice();
          renderProposalPreview(wrap?.scrollTop ?? 0);
        };
        layer.addEventListener('pointerup', endStroke);
        layer.addEventListener('pointercancel', endStroke);
        layer.addEventListener('dblclick', (evt) => {
          if (proposalMarkupTool === 'eraser' || proposalMarkupTool === 'text') return;
          const textEl = evt.target.closest('[data-markup-text-id]');
          if (textEl) {
            evt.preventDefault();
            const markup = ensureProposalMarkup(proposal);
            const item = (markup.pages[pageId] || []).find((entry) => entry.id === textEl.dataset.markupTextId);
            if (item) openTextEditorAt(layer, page, { x: item.x, y: item.y }, item);
            return;
          }
          evt.preventDefault();
          openTextEditorAt(layer, page, getPoint(evt));
        });
      });
    };
    attachMarkupOverlay();
    root.querySelectorAll('[data-proposal-add-line-item="true"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!page || page.kind !== 'pricing') return;
        activeProposalPageIndex = pageIndex;
        const parentItemId = btn.dataset.proposalAddParent || '';
        const newIndex = appendProposalLineItem(page, proposal, null, parentItemId);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        requestAnimationFrame(() => focusProposalFieldByPath(pageIndex, `lineItems.${newIndex}.label`));
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-proposal-add-section="true"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!page || page.kind !== 'pricing') return;
        activeProposalPageIndex = pageIndex;
        const parentItemId = btn.dataset.proposalAddParent || '';
        const newIndex = appendProposalSectionLineItem(page, proposal, null, parentItemId);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        requestAnimationFrame(() => focusProposalFieldByPath(pageIndex, `lineItems.${newIndex}.label`));
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-proposal-add-discount="true"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!page || page.kind !== 'pricing') return;
        activeProposalPageIndex = pageIndex;
        const parentItemId = btn.dataset.proposalAddParent || '';
        const newIndex = appendProposalDiscountLineItem(page, proposal, null, parentItemId);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        requestAnimationFrame(() => focusProposalFieldByPath(pageIndex, `lineItems.${newIndex}.discountValue`, true));
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-discount-mode-toggle]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page || page.kind !== 'pricing') return;
        const rowIndex = Number(btn.dataset.discountRow || -1);
        const scopeRow = proposalPricingRowsForPage(page, proposal, { includeDisabledRows: proposalEditorMode === 'edit' })[rowIndex];
        const scopeItem = scopeRow?.__scopeItemId ? findProposalScopeItem(proposal, scopeRow.__scopeItemId) : null;
        if (!scopeItem || !proposalScopeItemIsDiscount(scopeItem)) return;
        scopeItem.discount_mode = btn.dataset.discountModeToggle === 'percent' ? 'percent' : 'amount';
        if (scopeItem.discount_mode === 'percent' && !scopeItem.discount_percent) scopeItem.discount_percent = scopeItem.quantity || '10';
        if (scopeItem.discount_mode === 'amount' && !scopeItem.discount_amount) scopeItem.discount_amount = String(scopeItem.unit_price || 0);
        recomputeProposalPricing(page, proposal);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-proposal-choice-settings]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page || page.kind !== 'pricing') return;
        const scopeItemId = btn.dataset.scopeItemId || '';
        const item = scopeItemId ? ensureProposalLineChoiceGroup(proposal, scopeItemId) : null;
        if (!item) return;
        activeProposalPageIndex = pageIndex;
        proposalLineChoicePopoverState = { proposalIndex: activeProposalIndex, pageIndex, itemId: item.id };
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('[data-choice-scope-item]').forEach((card) => {
      if (card.matches('[data-choice-popover]')) return;
      const selectChoiceCard = () => {
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(card.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const optionId = card.dataset.choiceScopeItem || '';
        if (!proposal || !page || page.kind !== 'pricing' || !optionId) return false;
        activeProposalPageIndex = pageIndex;
        if (!proposalSelectCustomerChoiceOption(proposal, page, optionId)) return false;
        proposalLineChoicePopoverState = null;
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
        return true;
      };
      card.addEventListener('pointerdown', (evt) => {
        if (evt.target.closest('[data-choice-popover]')) return;
        evt.preventDefault();
        evt.stopPropagation();
        selectChoiceCard();
      });
      card.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        evt.preventDefault();
        selectChoiceCard();
      });
    });
    root.querySelectorAll('[data-proposal-line-menu]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const scopeItemId = btn.dataset.scopeItemId || '';
        if (!proposal || !scopeItemId) return;
        const alreadyOpen = proposalLineMenuState
          && proposalLineMenuState.proposalIndex === activeProposalIndex
          && Number(proposalLineMenuState.pageIndex) === pageIndex
          && String(proposalLineMenuState.itemId || '') === String(scopeItemId);
        proposalLineMenuState = alreadyOpen ? null : { proposalIndex: activeProposalIndex, pageIndex, itemId: scopeItemId };
        activeProposalPageIndex = pageIndex;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('[data-proposal-variation-menu]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const scopeItemId = btn.dataset.scopeItemId || '';
        if (!proposal || !scopeItemId) return;
        const alreadyOpen = proposalVariationMenuState
          && proposalVariationMenuState.proposalIndex === activeProposalIndex
          && Number(proposalVariationMenuState.pageIndex) === pageIndex
          && String(proposalVariationMenuState.itemId || '') === String(scopeItemId);
        proposalVariationMenuState = alreadyOpen ? null : { proposalIndex: activeProposalIndex, pageIndex, itemId: scopeItemId };
        activeProposalPageIndex = pageIndex;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('[data-proposal-variation-select]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || proposalVariationMenuState?.pageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const scopeItemId = btn.dataset.scopeItemId || '';
        const item = scopeItemId ? findProposalScopeItem(proposal, scopeItemId) : null;
        if (!proposal || !page || page.kind !== 'pricing' || !item) return;
        item.variation_selection = item.variation_selection && typeof item.variation_selection === 'object' ? item.variation_selection : {};
        item.variation_selection.selected_variation_id = btn.dataset.proposalVariationSelect || '';
        item.variation_selection.default_variation_id ||= item.variation_selection.selected_variation_id;
        proposalVariationMenuState = null;
        activeProposalPageIndex = pageIndex;
        recomputeProposalPricing(page, proposal);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-line-feature-toggle]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || proposalLineMenuState?.pageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const scopeItemId = btn.dataset.scopeItemId || '';
        if (!proposal || !page || page.kind !== 'pricing' || !scopeItemId) return;
        activeProposalPageIndex = pageIndex;
        proposalToggleLineFeature(proposal, page, scopeItemId, btn.dataset.lineFeatureToggle || '');
        proposalLineMenuState = { proposalIndex: activeProposalIndex, pageIndex, itemId: scopeItemId };
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-choice-popover-close]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        proposalLineChoicePopoverState = null;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('[data-choice-popover-backdrop]').forEach((backdrop) => {
      backdrop.addEventListener('click', (evt) => {
        evt.preventDefault();
        proposalLineChoicePopoverState = null;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('[data-choice-popover]').forEach((form) => {
      form.querySelectorAll('input[name="proposal-choice-selected"], [data-choice-option-customer]').forEach((input) => {
        input.addEventListener('change', () => {
          const proposal = proposals[activeProposalIndex];
          const pageIndex = Number(form.dataset.choicePageIndex || proposalLineChoicePopoverState?.pageIndex || activeProposalPageIndex || 0);
          const page = proposal?.pages?.[pageIndex];
          if (!proposal || !page || page.kind !== 'pricing') return;
          proposalApplyLineChoiceSettings(proposal, page, form);
          proposalLineChoicePopoverState = { proposalIndex: activeProposalIndex, pageIndex, itemId: form.dataset.choiceScopeItem };
          activeProposalPageIndex = pageIndex;
          renderProposalSection();
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        });
      });
      form.addEventListener('submit', (evt) => {
        evt.preventDefault();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(form.dataset.choicePageIndex || proposalLineChoicePopoverState?.pageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page || page.kind !== 'pricing') return;
        proposalApplyLineChoiceSettings(proposal, page, form);
        proposalLineChoicePopoverState = null;
        activeProposalPageIndex = pageIndex;
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
      form.querySelector('[data-choice-option-add]')?.addEventListener('click', (evt) => {
        evt.preventDefault();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(form.dataset.choicePageIndex || proposalLineChoicePopoverState?.pageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page || page.kind !== 'pricing') return;
        const option = proposalAddLineChoiceOption(proposal, page, form.dataset.choiceScopeItem, form);
        if (option) proposalLineChoicePopoverState = { proposalIndex: activeProposalIndex, pageIndex, itemId: form.dataset.choiceScopeItem };
        activeProposalPageIndex = pageIndex;
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
      form.querySelectorAll('[data-choice-option-remove]').forEach((btn) => {
        btn.addEventListener('click', (evt) => {
          evt.preventDefault();
          const proposal = proposals[activeProposalIndex];
          const pageIndex = Number(form.dataset.choicePageIndex || proposalLineChoicePopoverState?.pageIndex || activeProposalPageIndex || 0);
          const page = proposal?.pages?.[pageIndex];
          if (!proposal || !page || page.kind !== 'pricing') return;
          proposalRemoveLineChoiceOption(proposal, page, form.dataset.choiceScopeItem, btn.dataset.choiceOptionRemove, form);
          proposalLineChoicePopoverState = { proposalIndex: activeProposalIndex, pageIndex, itemId: form.dataset.choiceScopeItem };
          activeProposalPageIndex = pageIndex;
          renderProposalSection();
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        });
      });
    });
    root.querySelectorAll('[data-proposal-delete-line-item]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!page || page.kind !== 'pricing') return;
        const scopeItemId = btn.closest('[data-scope-item-id]')?.dataset.scopeItemId || '';
        const itemIndex = Number(btn.dataset.proposalDeleteLineItem || -1);
        if (scopeItemId) {
          deleteProposalScopeItem(proposal, scopeItemId);
          if (!ensureProposalScope(proposal).root_items.length) appendProposalLineItem(page, proposal, { label: '', quantity: '1', unitPrice: '$0.00', amount: '$0.00' });
        } else {
          page.lineItems = (page.lineItems || []).filter((_, index) => index !== itemIndex);
          if (!page.lineItems.length) appendProposalLineItem(page, proposal, { label: '', quantity: '1', unitPrice: '$0.00', amount: '$0.00' });
        }
        recomputeProposalPricing(page, proposal);
        activeProposalPageIndex = pageIndex;
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-full-insert-asset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!page || !proposalIsFullPageInsert(page)) return;
        const assets = page.kind === 'measurement_insert' ? proposalMeasurementInsertAssets() : getOrganizationMarketingPages();
        const asset = assets.find((item) => item.id === btn.dataset.fullInsertAsset) || assets[0];
        if (!asset) return;
        activeProposalPageIndex = pageIndex;
        page.assetId = asset.id;
        page.title = page.kind === 'measurement_insert' ? 'FirstMeasure' : (asset.title || page.title);
        page.kicker = page.kind === 'measurement_insert' ? 'Measurements' : (page.kicker || 'Marketing');
        if (page.kind === 'measurement_insert') {
          page.measurementSource = asset.source || page.measurementSource || 'report';
          page.measurementPage = asset.page || page.measurementPage || 1;
        }
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-media-divider]').forEach((handle) => {
      handle.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(handle);
        const page = proposal?.pages?.[pageIndex];
        if (!page || !['image_text', 'scope'].includes(page.kind)) return;
        activeProposalPageIndex = pageIndex;
        const blockIndex = Number(handle.dataset.mediaDivider || 0);
        const blockEl = handle.closest('.r-proposal-media-block');
        if (!blockEl) return;
        const startX = evt.clientX;
        const startRatio = Number(page.blocks?.[blockIndex]?.ratio || PROPOSAL_IMAGE_TEXT_DEFAULT.ratio);
        const width = blockEl.getBoundingClientRect().width || 1;
        handle.setPointerCapture?.(evt.pointerId);
        const move = (moveEvt) => {
          const delta = ((moveEvt.clientX - startX) / width) * 100;
          page.blocks = (page.blocks || []).map((block) => ({ ...block }));
          page.blocks[blockIndex] ||= defaultImageTextBlock();
          page.blocks[blockIndex].ratio = Math.max(25, Math.min(75, startRatio + (page.blocks[blockIndex].imageLeft === false ? -delta : delta)));
          const ratioA = page.blocks[blockIndex].ratio;
          const ratioB = 100 - ratioA;
          blockEl.style.gridTemplateColumns = page.blocks[blockIndex].imageLeft === false ? `${ratioB}fr 14px ${ratioA}fr` : `${ratioA}fr 14px ${ratioB}fr`;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    root.querySelectorAll('[data-media-heightgrab]').forEach((handle) => {
      handle.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(handle);
        const page = proposal?.pages?.[pageIndex];
        if (!page || !['image_text', 'scope'].includes(page.kind)) return;
        activeProposalPageIndex = pageIndex;
        const blockIndex = Number(handle.dataset.mediaHeightgrab || 0);
        const blockEl = handle.closest('.r-proposal-media-block');
        if (!blockEl) return;
        const startY = evt.clientY;
        const startHeight = Number(page.blocks?.[blockIndex]?.height || PROPOSAL_IMAGE_TEXT_DEFAULT.height);
        const maxHeight = proposalMediaBlockMaxHeight(blockEl);
        handle.setPointerCapture?.(evt.pointerId);
        const move = (moveEvt) => {
          const delta = moveEvt.clientY - startY;
          page.blocks = (page.blocks || []).map((block) => ({ ...block }));
          page.blocks[blockIndex] ||= defaultImageTextBlock();
          page.blocks[blockIndex].height = Math.max(140, Math.min(maxHeight, startHeight + delta));
          blockEl.style.height = `${page.blocks[blockIndex].height}px`;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          renderProposalSection();
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    root.querySelectorAll('[data-media-remove]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(btn);
        const page = proposal?.pages?.[pageIndex];
        if (!page || !['image_text', 'scope'].includes(page.kind)) return;
        activeProposalPageIndex = pageIndex;
        const blockIndex = Number(btn.dataset.mediaRemove || 0);
        const blockId = btn.dataset.mediaRemoveId || String(blockIndex);
        const confirmId = `${page.id}:${blockId}`;
        if (proposalDeleteConfirmBlockId !== confirmId) {
          proposalDeleteConfirmBlockId = confirmId;
          renderProposalPreview(wrap?.scrollTop ?? 0);
          return;
        }
        proposalDeleteConfirmBlockId = null;
        page.blocks = (page.blocks || []).filter((_, index) => index !== blockIndex);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-media-flip]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(btn);
        const page = proposal?.pages?.[pageIndex];
        if (!page || !['image_text', 'scope'].includes(page.kind)) return;
        activeProposalPageIndex = pageIndex;
        const blockIndex = Number(btn.dataset.mediaFlip || 0);
        page.blocks = (page.blocks || []).map((block) => ({ ...block }));
        page.blocks[blockIndex] ||= defaultImageTextBlock();
        page.blocks[blockIndex].imageLeft = !page.blocks[blockIndex].imageLeft;
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-media-pick]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        if (evt.target.closest('video')) {
          evt.stopPropagation();
          return;
        }
        evt.preventDefault();
        evt.stopPropagation();
        const pageIndex = controlPageIndex(btn);
        activeProposalPageIndex = pageIndex;
        openProposalPhotoPicker(pageIndex, Number(btn.dataset.mediaPick || 0));
      });
    });
    root.querySelectorAll('[data-proposal-cobrand-pick]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        openProposalCoBrandPicker().catch((error) => {
          console.warn('Unable to open co-brand picker', error);
          showToast((globalThis.PlatformLanguage?.text("proposals","m_561bb8c5a1fd14","Branding media unavailable") ?? "Branding media unavailable"), (globalThis.PlatformLanguage?.text("proposals","m_919b8c1b0a4373","Could not load company branding images.") ?? "Could not load company branding images."), false);
        });
      });
    });
    root.querySelectorAll('[data-proposal-cobrand-remove]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        if (!proposal) return;
        delete proposal.coBrandLogo;
        delete proposal.co_brand_logo;
        delete proposal.cobrandLogo;
        delete proposal.cobrand_logo;
        renderProposalPreview(wrap?.scrollTop ?? 0);
        renderProposalSection();
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-cover-pick="true"]').forEach((coverBtn) => {
      coverBtn.addEventListener('click', (evt) => {
        if (evt.target.closest('video')) {
          evt.stopPropagation();
          return;
        }
        if (proposalCoverAdjustOpen) return;
        const pageIndex = Number(coverBtn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || 0);
        activeProposalPageIndex = pageIndex;
        openProposalPhotoPicker(pageIndex, 0, { mode: 'cover' });
      });
    });
    root.querySelectorAll('[data-cover-adjust-toggle="true"]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        activeProposalPageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        proposalCoverAdjustOpen = !proposalCoverAdjustOpen;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('[data-cover-toggle="true"]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(btn.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page || page.kind !== 'cover') return;
        activeProposalPageIndex = pageIndex;
        proposalCoverAdjustOpen = false;
        page.coverImageEnabled = page.coverImageEnabled === false ? true : false;
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-cover-adjust]').forEach((input) => {
      input.addEventListener('pointerdown', (evt) => evt.stopPropagation());
      input.addEventListener('click', (evt) => evt.stopPropagation());
      input.addEventListener('input', () => {
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(input.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        if (!proposal || !page || page.kind !== 'cover') return;
        activeProposalPageIndex = pageIndex;
        const key = input.dataset.coverAdjust;
        if (key === 'zoom') page.coverImageZoom = Number(input.value || 1);
        const img = input.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-image-grid.count-1 img');
        if (img) {
          img.style.transform = `translate(${page.coverImagePanX || 0}px,${page.coverImagePanY || 0}px) scale(${page.coverImageZoom ?? 1})`;
        }
      });
      input.addEventListener('change', () => {
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-cover-pick="true"]').forEach((coverEl) => {
      coverEl.addEventListener('pointerdown', (evt) => {
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(coverEl.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const img = coverEl?.querySelector('.r-proposal-cover-image-grid.count-1 img');
        if (!proposalCoverAdjustOpen || !proposal || !page || page.kind !== 'cover' || !img || evt.target.closest('[data-cover-adjust], [data-cover-adjust-toggle], [data-cover-toggle], .r-proposal-cover-widthgrab, .r-proposal-cover-heightgrab, .r-proposal-cover-cornergrab')) return;
        activeProposalPageIndex = pageIndex;
        evt.preventDefault();
        evt.stopPropagation();
        const rect = coverEl.getBoundingClientRect();
        const startX = evt.clientX;
        const startY = evt.clientY;
        const startPanX = Number(page.coverImagePanX || 0);
        const startPanY = Number(page.coverImagePanY || 0);
        if (Number(page.coverImageZoom || 1) <= 1.01) {
          page.coverImageZoom = 1.15;
          const slider = coverEl.closest('[data-proposal-page-index]')?.querySelector('[data-cover-adjust="zoom"]');
          if (slider) slider.value = String(page.coverImageZoom);
          img.style.transform = `translate(${page.coverImagePanX || 0}px,${page.coverImagePanY || 0}px) scale(${page.coverImageZoom})`;
        }
        coverEl.classList.add('is-adjusting');
        coverEl.setPointerCapture?.(evt.pointerId);
        const move = (moveEvt) => {
          const deltaX = moveEvt.clientX - startX;
          const deltaY = moveEvt.clientY - startY;
          const zoom = Math.max(1, Number(page.coverImageZoom || 1));
          const naturalWidth = img.naturalWidth || rect.width;
          const naturalHeight = img.naturalHeight || rect.height;
          const baseScale = Math.max(rect.width / naturalWidth, rect.height / naturalHeight);
          const renderedWidth = naturalWidth * baseScale * zoom;
          const renderedHeight = naturalHeight * baseScale * zoom;
          const maxPanX = Math.max(0, (renderedWidth - rect.width) / 2);
          const maxPanY = Math.max(0, (renderedHeight - rect.height) / 2);
          page.coverImagePanX = Math.max(-maxPanX, Math.min(maxPanX, startPanX + deltaX));
          page.coverImagePanY = Math.max(-maxPanY, Math.min(maxPanY, startPanY + deltaY));
          img.style.transform = `translate(${page.coverImagePanX}px,${page.coverImagePanY}px) scale(${page.coverImageZoom || 1})`;
        };
        const up = () => {
          coverEl.classList.remove('is-adjusting');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    root.querySelectorAll('[data-cover-widthgrab="true"]').forEach((handle) => {
      handle.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(handle.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const coverEl = handle.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-image');
        const coverStageEl = handle.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-stage');
        if (!proposal || !page || page.kind !== 'cover' || !coverEl || !coverStageEl) return;
        activeProposalPageIndex = pageIndex;
        const startX = evt.clientX;
        const startWidth = Number(page.coverImageWidth || PROPOSAL_COVER_DEFAULT_SIZE);
        evt.currentTarget.setPointerCapture?.(evt.pointerId);
        const move = (moveEvt) => {
          page.coverImageWidth = Math.max(180, Math.min(520, startWidth + (moveEvt.clientX - startX)));
          coverEl.style.width = `min(100%,${page.coverImageWidth}px)`;
          coverStageEl.style.width = `min(100%,${page.coverImageWidth}px)`;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    root.querySelectorAll('[data-cover-heightgrab="true"]').forEach((handle) => {
      handle.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(handle.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const coverEl = handle.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-image');
        const coverStageEl = handle.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-stage');
        if (!proposal || !page || page.kind !== 'cover' || !coverEl || !coverStageEl) return;
        activeProposalPageIndex = pageIndex;
        const startY = evt.clientY;
        const startHeight = Number(page.coverImageHeight || PROPOSAL_COVER_DEFAULT_SIZE);
        evt.currentTarget.setPointerCapture?.(evt.pointerId);
        const move = (moveEvt) => {
          page.coverImageHeight = Math.max(180, Math.min(520, startHeight + (moveEvt.clientY - startY)));
          coverEl.style.height = `${page.coverImageHeight}px`;
          coverStageEl.style.height = `${page.coverImageHeight}px`;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    root.querySelectorAll('[data-cover-cornergrab="true"]').forEach((handle) => {
      handle.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = Number(handle.closest('[data-proposal-page-index]')?.dataset.proposalPageIndex || activeProposalPageIndex || 0);
        const page = proposal?.pages?.[pageIndex];
        const coverEl = handle.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-image');
        const coverStageEl = handle.closest('[data-proposal-page-index]')?.querySelector('.r-proposal-cover-stage');
        if (!proposal || !page || page.kind !== 'cover' || !coverEl || !coverStageEl) return;
        activeProposalPageIndex = pageIndex;
        const startX = evt.clientX;
        const startY = evt.clientY;
        const startWidth = Number(page.coverImageWidth || PROPOSAL_COVER_DEFAULT_SIZE);
        const startHeight = Number(page.coverImageHeight || PROPOSAL_COVER_DEFAULT_SIZE);
        evt.currentTarget.setPointerCapture?.(evt.pointerId);
        const move = (moveEvt) => {
          page.coverImageWidth = Math.max(180, Math.min(520, startWidth + (moveEvt.clientX - startX)));
          page.coverImageHeight = Math.max(180, Math.min(520, startHeight + (moveEvt.clientY - startY)));
          coverEl.style.width = `min(100%,${page.coverImageWidth}px)`;
          coverEl.style.height = `${page.coverImageHeight}px`;
          coverStageEl.style.width = `min(100%,${page.coverImageWidth}px)`;
          coverStageEl.style.height = `${page.coverImageHeight}px`;
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          renderProposalPreview(wrap?.scrollTop ?? 0);
          queueAutosaveNotice();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      });
    });
    root.querySelectorAll('[data-media-add-block]').forEach((btn) => {
      btn.addEventListener('pointerdown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(btn);
        const page = proposal?.pages?.[pageIndex];
        if (!page || !['image_text', 'scope'].includes(page.kind)) return;
        activeProposalPageIndex = pageIndex;
        const previous = (page.blocks || [])[page.blocks.length - 1];
        page.blocks = [...(page.blocks || []), createProposalMediaBlock(btn.dataset.mediaAddBlock || 'image_text', previous)];
        proposalDeleteConfirmBlockId = null;
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-fineprint-signature-toggle="true"]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(btn);
        const page = proposal?.pages?.[pageIndex];
        if (!page || page.kind !== 'fine_print') return;
        page.requireCustomerSignature = page.requireCustomerSignature === false;
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('[data-signature-option]').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const proposal = proposals[activeProposalIndex];
        const pageIndex = controlPageIndex(btn);
        const page = proposal?.pages?.[pageIndex];
        if (!page || page.kind !== 'signature') return;
        const option = btn.dataset.signatureOption || '';
        if (option === 'require-company') {
          page.requireCompanySignature = page.requireCompanySignature === false;
        } else if (option === 'show-date') {
          page.showDate = page.showDate === false;
        } else if (option === 'show-tax') {
          page.showTax = page.showTax === false;
        }
        ensureProposalSignatureData(proposal, false);
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.querySelectorAll('.r-proposal-page-insert-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (viewMode !== 'edit') return;
        const index = Number(btn.closest('[data-insert-index]')?.dataset.insertIndex || -1);
        proposalInsertIndex = proposalInsertIndex === index ? null : index;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('.r-proposal-page-insert-close').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        proposalInsertIndex = null;
        renderProposalPreview(wrap?.scrollTop ?? 0);
      });
    });
    root.querySelectorAll('.r-proposal-page-option').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const insertAfter = Number(btn.closest('[data-insert-index]')?.dataset.insertIndex || -1);
        const template = btn.dataset.pageTemplate || 'image_text';
        if (insertAfter < 0) return;
        const newPage = createProposalPage(template, proposal);
        if (newPage.kind === 'pricing') recomputeProposalPricing(newPage, proposal, { seedScope: true });
        proposal.pages = [
          ...proposal.pages.slice(0, insertAfter + 1),
          newPage,
          ...proposal.pages.slice(insertAfter + 1),
        ];
        activeProposalPageIndex = insertAfter + 1;
        proposalInsertIndex = null;
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
    root.onkeydown = null;
    root.querySelectorAll('[data-proposal-field]').forEach((field) => {
      if (field.dataset.proposalReadonly === 'true' || !field.hasAttribute('contenteditable')) return;
      const pageEl = field.closest('[data-proposal-page-index]');
      const pageIndex = Number(pageEl?.dataset.proposalPageIndex || 0);
      const fieldPath = field.dataset.proposalField || '';
      const fieldType = field.dataset.proposalType || '';
      applyRichFieldVisualState(field);
      const syncFieldValue = (options = {}) => {
        syncProposalFieldValue(field, pageIndex, fieldPath, fieldType, options);
      };
      const handleLiveUpdate = () => {
        syncFieldValue();
        renderProposalSection();
      };
      const handleCommit = () => {
        syncFieldValue({ commit: true });
        renderProposalSection();
        if (field.dataset.proposalRich === 'true' || fieldType === 'currency' || fieldType === 'number' || fieldPath.startsWith('paymentSchedule.') || fieldPath.startsWith('lineItems.') || fieldPath === 'taxRatePercent' || fieldPath === 'projectType' || fieldPath === 'notes') {
          renderProposalPreview(wrap?.scrollTop ?? 0);
        }
      };
      field.addEventListener('input', handleLiveUpdate);
      field.addEventListener('blur', handleCommit);
      field.addEventListener('keydown', (e) => {
        if (field.dataset.proposalDerived === 'true') {
          e.preventDefault();
          return;
        }
        if (field.dataset.proposalRich === 'true') {
          updateRichToolbarState(field, field.querySelector('.r-proposal-rich-toolbar'));
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const fields = editableFields();
          const currentIndex = fields.indexOf(field);
          handleCommit();
          if (currentIndex === -1) return;
          const nextIndex = e.shiftKey ? currentIndex - 1 : currentIndex + 1;
          const nextField = editableFields()[nextIndex];
          if (nextField) focusProposalField(nextField, !!e.shiftKey);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && fieldPath.startsWith('lineItems.')) {
          e.preventDefault();
          const match = fieldPath.match(/^lineItems\.(\d+)\.([a-zA-Z]+)$/);
          handleCommit();
          if (!match) return;
          const currentRow = Number(match[1]);
          const currentField = match[2];
          const proposal = proposals[activeProposalIndex];
          const page = proposal?.pages?.[pageIndex];
          if (!page || page.kind !== 'pricing') return;
          let nextRow = currentRow + 1;
          if (!proposalPricingRowsForPage(page, proposal, { includeDisabledRows: proposalEditorMode === 'edit' })[nextRow]) {
            nextRow = appendProposalLineItem(page, proposal);
            renderProposalSection();
            renderProposalPreview(wrap?.scrollTop ?? 0);
            queueAutosaveNotice();
          }
          const targetField = currentField === 'amount' ? 'label' : currentField;
          requestAnimationFrame(() => focusProposalFieldByPath(pageIndex, `lineItems.${nextRow}.${targetField}`));
          return;
        }
        if (fieldType === 'integer' || fieldType === 'number' || fieldType === 'currency') {
          const allowed = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab', 'Home', 'End', 'Enter'];
          if (allowed.includes(e.key) || e.ctrlKey || e.metaKey) return;
          if (fieldType === 'integer' && /\d/.test(e.key)) return;
          if (fieldType === 'number' && /[\d.]/.test(e.key)) return;
          if (fieldType === 'currency' && /[\d.]/.test(e.key)) return;
          e.preventDefault();
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          field.blur();
        }
      });
      field.addEventListener('focus', () => {
        editableFields().forEach((el) => el.classList.toggle('is-keyboard-focus', el === field));
        activeProposalPageIndex = pageIndex;
        if (/^lineItems\.\d+\.label$/.test(fieldPath)) {
          const match = fieldPath.match(/^lineItems\.(\d+)\.label$/);
          if (match) showProposalPricebookSuggest(field, pageIndex, Number(match[1]));
        }
        if (field.dataset.proposalRich === 'true') showRichToolbar(field, pageIndex, fieldPath);
        renderProposalSection();
        if (fieldType === 'integer' || fieldType === 'number' || fieldType === 'currency') {
          requestAnimationFrame(() => {
            if (document.activeElement === field) selectProposalFieldContents(field);
          });
        }
      });
      field.addEventListener('input', () => {
        if (/^lineItems\.\d+\.label$/.test(fieldPath)) {
          const match = fieldPath.match(/^lineItems\.(\d+)\.label$/);
          if (match) showProposalPricebookSuggest(field, pageIndex, Number(match[1]));
        }
      });
      field.addEventListener('mouseup', () => {
        if (field.dataset.proposalRich === 'true') {
          showRichToolbar(field, pageIndex, fieldPath);
          updateRichToolbarState(field, field.querySelector('.r-proposal-rich-toolbar'));
        }
      });
      field.addEventListener('keyup', () => {
        if (field.dataset.proposalRich === 'true') updateRichToolbarState(field, field.querySelector('.r-proposal-rich-toolbar'));
      });
      field.addEventListener('blur', () => {
        field.classList.remove('is-keyboard-focus');
        if (/^lineItems\.\d+\.label$/.test(fieldPath)) {
          setTimeout(closeProposalPricebookSuggest, 120);
        }
        if (field.dataset.proposalRich === 'true') {
          setTimeout(() => {
            if (!field.contains(document.activeElement)) removeRichToolbars();
          }, 0);
        }
      });
    });
  }

  function showProposalWorkspace(options = {}){
    if (!proposalsEnabled()) return;
    proposalWorkspaceOpen = true;
    if (!['list', 'builder', 'edit', 'send'].includes(proposalWorkspaceMode)) proposalWorkspaceMode = 'list';
    proposalSigningMode = false;
    proposalSigningSession = null;
    closeSignatureChooser();
    setActivePreviewTab('proposal', options);
    renderWorkflowState();
    setTimeout(() => callHost('revealProposalSection'), 40);
  }

  function mountProposalSettingsPanel(){
    const root = $('#rProposalPreview');
    if (!root || !proposalSettingsPanelOpen) return;
    closeProposalPricebookSuggest();
    root.innerHTML = `
      <div class="r-settings-panel">
        <div class="r-settings-panel-head">
          <div>
            <strong>${(globalThis.PlatformLanguage?.htmlText("proposals","m_72f0a27f9ae574","Proposal Settings") ?? "Proposal Settings")}</strong>
            <span>${(globalThis.PlatformLanguage?.htmlText("proposals","m_2483b19ab4ae38","Defaults for new proposals in this branch") ?? "Defaults for new proposals in this branch")}</span>
          </div>
          <button type="button" class="r-settings-panel-close" id="rProposalSettingsClose" aria-label="${(globalThis.PlatformLanguage?.htmlText("proposals","m_cb25aa10e60505","Close proposal settings") ?? "Close proposal settings")}" data-fm-tooltip="Back to proposal preview"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-settings-panel-body" id="rProposalSettingsPanel"></div>
      </div>
    `;
    root.querySelector('#rProposalSettingsClose')?.addEventListener('click', closeProposalSettingsPanel);
    const panel = root.querySelector('#rProposalSettingsPanel');
    if (!window.FirstMateSettingsPages?.mount) {
      panel.innerHTML = `<div class="cs-note" style="padding:18px">${(globalThis.PlatformLanguage?.htmlText("proposals","m_728f33c2030828","Proposal settings library is unavailable.") ?? "Proposal settings library is unavailable.")}</div>`;
      return;
    }
    window.FirstMateSettingsPages.mount(panel, 'proposals', {
      orgId: String(window.__APP?.userOrgId || '').trim(),
      branchId: String(window.Portal?.branchModules?.currentBranchId?.() || window.__APP?.userBranchId || 'default').trim() || 'default',
      source: 'project_modal_proposals',
      embedded: true
    });
  }

  function clearProposalSettingsPanel(){
    if (!proposalSettingsPanelOpen) return false;
    $('#rProposalSettingsPanel')?.__fmSettingsPageDestroy?.();
    proposalSettingsPanelOpen = false;
    return true;
  }

  function closeProposalSettingsPanel(){
    if (!clearProposalSettingsPanel()) return;
    if (activePreviewTab !== 'proposal') setActivePreviewTab('proposal');
    else {
      renderProposalPreview();
      renderProposalSection();
      syncProposalWorkspaceChrome();
    }
  }

  function openProposalSettingsPanel(){
    if (!proposalsEnabled()) return;
    proposalSettingsPanelOpen = true;
    proposalWorkspaceOpen = true;
    proposalWorkspaceMode = 'list';
    proposalEditorMode = 'preview';
    proposalActionExpanded = false;
    proposalSigningMode = false;
    proposalSigningSession = null;
    closeSignatureChooser();
    syncProjectViewerTabs();
    setActivePreviewTab('proposal');
    renderWorkflowState();
  }

  function launchProposalBuilder(){
    if (!proposalsEnabled()) return;
    ensureProposalOnlyBaseProject();
    normalizeProposalCollection();
    proposalWorkspaceMode = 'list';
    proposalEditorMode = 'preview';
    proposalWorkspaceOpen = true;
    proposalActionExpanded = false;
    proposalSigningMode = false;
    proposalSigningSession = null;
    showProposalWorkspace();
    queueAutosaveNotice();
  }

  function hideProposalWorkspace(){
    proposalWorkspaceOpen = false;
    proposalWorkspaceMode = 'list';
    proposalEditorMode = 'preview';
    proposalMarkupMode = false;
    proposalMarkupDockOpen = false;
    proposalMarkupPopover = null;
    proposalActionExpanded = false;
    proposalSigningMode = false;
    proposalSigningSession = null;
    closeSignatureChooser();
    photoViewerOpen = false;
    setActivePreviewTab(projectDefaultPreviewTab());
    renderWorkflowState();
    setTimeout(revealCustomerSection, 40);
  }

  function bindProposalModeToggle(){
    const wrap = $('#rProposalTopMode');
    if (!wrap) return;
    wrap.querySelectorAll('[data-proposal-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.proposalMode === proposalEditorMode);
      btn.addEventListener('click', () => {
        const currentScrollTop = $('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0;
        proposalEditorMode = btn.dataset.proposalMode || 'preview';
        bindProposalModeToggle();
        renderProposalPreview(currentScrollTop);
        queueAutosaveNotice();
      });
    });
  }

  function bindProposalMarkupToggle(){
    const dock = $('#rProposalMarkupDock');
    const btn = $('#rProposalMarkupToggle');
    if (!dock || !btn) return;
    dock.classList.toggle('expanded', proposalMarkupDockOpen);
    btn.classList.toggle('active', proposalMarkupMode);
    btn.onclick = () => {
      const currentScrollTop = $('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0;
      proposalMarkupDockOpen = true;
      proposalMarkupMode = true;
      proposalMarkupTool = proposalMarkupTool || 'pen';
      proposalInsertIndex = null;
      bindProposalMarkupToggle();
      renderProposalPreview(currentScrollTop);
      queueAutosaveNotice();
    };
    const eraserBtn = $('#rProposalMarkupEraser');
    const arrowBtn = $('#rProposalMarkupArrow');
    const textBtn = $('#rProposalMarkupText');
    const sizeBtn = $('#rProposalMarkupSize');
    const colorBtn = $('#rProposalMarkupColor');
    const undoBtn = $('#rProposalMarkupUndo');
    const redoBtn = $('#rProposalMarkupRedo');
    const clearBtn = $('#rProposalMarkupClear');
    const closeBtn = $('#rProposalMarkupClose');
    const sizePop = $('#rProposalMarkupSizePop');
    const colorPop = $('#rProposalMarkupColorPop');
    if (sizePop) sizePop.classList.toggle('visible', proposalMarkupPopover === 'size');
    if (colorPop) colorPop.classList.toggle('visible', proposalMarkupPopover === 'color');
    if (eraserBtn) {
      eraserBtn.classList.toggle('active', proposalMarkupTool === 'eraser');
      eraserBtn.onclick = () => {
        proposalMarkupDockOpen = true;
        proposalMarkupMode = true;
        proposalMarkupPopover = null;
        proposalMarkupTool = 'eraser';
        bindProposalMarkupToggle();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      };
    }
    if (arrowBtn) {
      arrowBtn.classList.toggle('active', proposalMarkupTool === 'arrow');
      arrowBtn.onclick = () => {
        proposalMarkupDockOpen = true;
        proposalMarkupMode = true;
        proposalMarkupPopover = null;
        proposalMarkupTool = 'arrow';
        bindProposalMarkupToggle();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      };
    }
    if (textBtn) {
      textBtn.classList.toggle('active', proposalMarkupTool === 'text');
      textBtn.onclick = () => {
        proposalMarkupDockOpen = true;
        proposalMarkupMode = true;
        proposalMarkupPopover = null;
        proposalMarkupTool = 'text';
        bindProposalMarkupToggle();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      };
    }
    btn.classList.toggle('active', proposalMarkupMode && proposalMarkupTool === 'pen');
    const proposal = proposals[activeProposalIndex];
    const markup = proposal ? ensureProposalMarkup(proposal) : null;
    if (undoBtn) {
      undoBtn.disabled = !markup || markup.historyIndex <= 0;
      undoBtn.onclick = () => {
        const current = proposals[activeProposalIndex];
        if (!current) return;
        const state = ensureProposalMarkup(current);
        if (!restoreProposalMarkupHistory(current, state.historyIndex - 1)) return;
        proposalMarkupPopover = null;
        queueAutosaveNotice();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      };
    }
    if (redoBtn) {
      redoBtn.disabled = !markup || markup.historyIndex < 0 || markup.historyIndex >= markup.history.length - 1;
      redoBtn.onclick = () => {
        const current = proposals[activeProposalIndex];
        if (!current) return;
        const state = ensureProposalMarkup(current);
        if (!restoreProposalMarkupHistory(current, state.historyIndex + 1)) return;
        proposalMarkupPopover = null;
        queueAutosaveNotice();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
      };
    }
    if (sizeBtn) {
      sizeBtn.querySelector('.r-proposal-markup-tool-size').textContent = proposalMarkupSizeLabel();
      sizeBtn.onclick = () => {
        proposalMarkupPopover = proposalMarkupPopover === 'size' ? null : 'size';
        bindProposalMarkupToggle();
      };
    }
    if (sizePop) {
      const input = sizePop.querySelector('input');
      if (input) {
        input.value = String(proposalMarkupStrokeSize);
        input.oninput = () => {
          proposalMarkupStrokeSize = Number(input.value || proposalMarkupStrokeSize);
          bindProposalMarkupToggle();
          renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        };
      }
    }
    if (colorBtn) {
      colorBtn.querySelector('.r-proposal-markup-tool-swatch').style.background = proposalMarkupStrokeColor;
      colorBtn.onclick = () => {
        proposalMarkupPopover = proposalMarkupPopover === 'color' ? null : 'color';
        bindProposalMarkupToggle();
      };
    }
    if (colorPop) {
      if (window.FirstMateMarkup?.markupColorPaletteHtml) {
        colorPop.innerHTML = window.FirstMateMarkup.markupColorPaletteHtml(proposalMarkupStrokeColor);
      }
      colorPop.querySelectorAll('[data-markup-color]').forEach((swatch) => {
        swatch.onclick = () => {
          proposalMarkupStrokeColor = swatch.dataset.markupColor || proposalMarkupStrokeColor;
          window.FirstMateMarkup?.rememberMarkupColor?.(proposalMarkupStrokeColor);
          proposalMarkupPopover = null;
          bindProposalMarkupToggle();
          renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        };
      });
      const custom = colorPop.querySelector('input[type="color"]');
      if (custom) {
        custom.value = proposalMarkupStrokeColor;
        custom.oninput = () => {
          proposalMarkupStrokeColor = custom.value || proposalMarkupStrokeColor;
          window.FirstMateMarkup?.rememberMarkupColor?.(proposalMarkupStrokeColor);
          bindProposalMarkupToggle();
          renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        };
      }
    }
    btn.onclick = () => {
      const currentScrollTop = $('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0;
      proposalMarkupDockOpen = true;
      proposalMarkupMode = true;
      proposalMarkupPopover = null;
      proposalMarkupTool = 'pen';
      proposalInsertIndex = null;
      bindProposalMarkupToggle();
      renderProposalPreview(currentScrollTop);
      queueAutosaveNotice();
    };
    if (clearBtn) {
      clearBtn.onclick = () => {
        const proposal = proposals[activeProposalIndex];
        const page = currentProposalPage();
        if (!proposal || !page) return;
        const markup = ensureProposalMarkup(proposal);
        if (!(markup.pages[page.id] || []).length) return;
        markup.pages[page.id] = [];
        pushProposalMarkupHistory(proposal);
        proposalMarkupPopover = null;
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      };
    }
    if (closeBtn) {
      closeBtn.onclick = () => {
        const currentScrollTop = $('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0;
        proposalMarkupDockOpen = false;
        proposalMarkupMode = false;
        proposalMarkupPopover = null;
        proposalMarkupTool = 'pen';
        bindProposalMarkupToggle();
        renderProposalPreview(currentScrollTop);
        queueAutosaveNotice();
      };
    }
  }

  function syncProposalAgentState(){
    const agent = $('#rProposalAgent');
    if (!agent) return;
    agent.classList.toggle('collapsed', proposalAgentCollapsed);
    agent.querySelector('.r-proposal-agent-toggle')?.setAttribute('aria-expanded', proposalAgentCollapsed ? 'false' : 'true');
    const textarea = $('#rProposalAgentPrompt');
    if (textarea && document.activeElement !== textarea && textarea.value !== proposalAgentPrompt) textarea.value = proposalAgentPrompt;
    const progress = $('#rProposalAgentProgress');
    if (progress) {
      progress.classList.toggle('visible', proposalAgentRunning || proposalAgentProgress > 0);
      progress.style.setProperty('--progress', `${Math.max(0, Math.min(100, proposalAgentProgress))}%`);
    }
    const submit = $('#rProposalAgentSubmit');
    if (submit) submit.disabled = proposalAgentRunning || !proposalAgentPrompt.trim();
  }

  function syncProposalBottomSendState(){
    const btn = $('#rProposalBottomSend');
    if (!btn) return;
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal' && proposalWorkspaceMode === 'edit' && !!proposals.length;
    btn.classList.toggle('visible', visible);
  }

  function positionProposalWorkspaceChrome(){
    const right = $('#rMapWrap');
    const stage = $('#rOverlay .r-preview-stage');
    const topMode = $('#rProposalTopMode');
    const markupDock = $('#rProposalMarkupDock');
    if (!right || !stage || !topMode || !markupDock) return;
    const rightRect = right.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (!rightRect.width || !stageRect.width) return;
    const stageTop = Math.max(0, stageRect.top - rightRect.top);
    const stageRight = Math.max(0, rightRect.right - stageRect.right);
    topMode.style.top = `${Math.round(stageTop + 14)}px`;
    topMode.style.right = `${Math.round(stageRight + 48)}px`;
    markupDock.style.top = `${Math.round(stageTop + 74)}px`;
    markupDock.style.right = `${Math.round(stageRight + 21)}px`;
  }

  function syncProposalWorkspaceChrome(){
    const editingProposal = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal' && proposalWorkspaceMode === 'edit' && !!proposals.length;
    // The host owns the responsive left-region presentation. Re-evaluate it
    // whenever the proposal workspace moves between its list/setup/editor modes.
    callHost('syncLeftColumnOverride');
    const overlay = $('#rOverlay');
    if (overlay) {
      const activeProposalWorkspace = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
      overlay.classList.toggle('proposal-list-mode', activeProposalWorkspace && proposalWorkspaceMode === 'list');
      overlay.classList.toggle('proposal-edit-mode', editingProposal);
      overlay.classList.toggle('proposal-send-mode', activeProposalWorkspace && proposalWorkspaceMode === 'send');
      overlay.classList.toggle('proposal-builder-mode', activeProposalWorkspace && proposalWorkspaceMode === 'builder');
    }
    $('#rProposalTopMode')?.classList.toggle('visible', editingProposal);
    $('#rProposalMarkupDock')?.classList.toggle('visible', editingProposal);
    if (editingProposal) requestAnimationFrame(positionProposalWorkspaceChrome);
    syncProposalBottomSendState();
  }

  function startProposalAgentProgress(){
    proposalAgentPrompt = ($('#rProposalAgentPrompt')?.value || proposalAgentPrompt || '').trim();
    if (!proposalAgentPrompt) {
      showToast((globalThis.PlatformLanguage?.text("proposals","m_84ac8c915cb845","Add instructions") ?? "Add instructions"), (globalThis.PlatformLanguage?.text("proposals","m_ef77057c6fda39","Tell the Proposal Agent what you want included first.") ?? "Tell the Proposal Agent what you want included first."), false);
      syncProposalAgentState();
      return;
    }
    clearInterval(proposalAgentTimer);
    proposalAgentRunning = true;
    proposalAgentProgress = 8;
    syncProposalAgentState();
    proposalAgentTimer = setInterval(() => {
      proposalAgentProgress = Math.min(94, proposalAgentProgress + Math.max(3, Math.round(Math.random() * 9)));
      syncProposalAgentState();
    }, 420);
    setTimeout(() => {
      if (!proposalAgentRunning) return;
      clearInterval(proposalAgentTimer);
      proposalAgentTimer = null;
      proposalAgentProgress = 100;
      proposalAgentRunning = false;
      syncProposalAgentState();
      showToast((globalThis.PlatformLanguage?.text("proposals","m_85be6ea540bee3","Proposal Agent queued") ?? "Proposal Agent queued"), (globalThis.PlatformLanguage?.text("proposals","m_f35a14165cc920","The prompt UI is ready; model generation can be wired into this action next.") ?? "The prompt UI is ready; model generation can be wired into this action next."), true);
      setTimeout(() => {
        if (proposalAgentRunning) return;
        proposalAgentProgress = 0;
        syncProposalAgentState();
      }, 1300);
    }, 3600);
  }

  function toggleProposalAgentDictation(){
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const dictateBtn = $('#rProposalAgentDictate');
    const textarea = $('#rProposalAgentPrompt');
    if (!SpeechRecognition || !textarea) {
      showToast((globalThis.PlatformLanguage?.text("proposals","m_bbe27879ebf26c","Dictation unavailable") ?? "Dictation unavailable"), (globalThis.PlatformLanguage?.text("proposals","m_79af74d554f5a6","This browser does not expose speech recognition here.") ?? "This browser does not expose speech recognition here."), false);
      return;
    }
    if (proposalAgentRecognition) {
      try { proposalAgentRecognition.stop(); } catch (_) {}
      proposalAgentRecognition = null;
      dictateBtn?.classList.remove('active');
      return;
    }
    const recognition = new SpeechRecognition();
    proposalAgentRecognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    const initialText = textarea.value || '';
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const transcript = event.results[i]?.[0]?.transcript || '';
        if (event.results[i].isFinal) finalText += transcript;
        else interimText += transcript;
      }
      const spoken = `${finalText}${interimText ? ` ${interimText}` : ''}`.trim();
      const next = `${initialText}${initialText && spoken ? ' ' : ''}${spoken}`.trim();
      textarea.value = next;
      proposalAgentPrompt = next;
      syncProposalAgentState();
    };
    recognition.onerror = () => {
      proposalAgentRecognition = null;
      dictateBtn?.classList.remove('active');
    };
    recognition.onend = () => {
      proposalAgentRecognition = null;
      dictateBtn?.classList.remove('active');
    };
    dictateBtn?.classList.add('active');
    textarea.focus();
    recognition.start();
  }

  function stopProposalAgentActivity(){
    clearInterval(proposalAgentTimer);
    proposalAgentTimer = null;
    proposalAgentRunning = false;
    proposalAgentProgress = 0;
    if (proposalAgentRecognition) {
      try { proposalAgentRecognition.stop(); } catch (_) {}
      proposalAgentRecognition = null;
    }
    $('#rProposalAgentDictate')?.classList.remove('active');
  }

  function renderReadOnlyPreview(options = {}){
    const root = options.root || null;
    const project = options.project || null;
    const projectProposals = Array.isArray(project?.proposals) ? project.proposals : [];
    const requestedIndex = Number(options.proposalIndex);
    const proposal = options.proposal || projectProposals[Number.isFinite(requestedIndex) ? requestedIndex : 0] || null;
    if (!root || !proposal) return false;
    window.Portal?.modules?.request?.ensureStyles?.();
    window.Portal?.modules?.request?.ensureProposalContext?.();
    if (!options.presentationStyleLoaded && !Object.keys(getBranchPresentationStyle()).length && window.Portal?.branchModules?.get) {
      const token = {};
      root.__proposalReadOnlyStyleToken = token;
      state.readOnlyPresentationStyleLoad = loadBranchPresentationStyle()
        .then(() => {
          if (root.isConnected && root.__proposalReadOnlyStyleToken === token) {
            renderReadOnlyPreview({ ...options, root, presentationStyleLoaded: true });
          }
        })
        .catch(() => null);
    }
    const photosTab = window.Portal?.modules?.projectPhotosTab || window.Portal?.ProjectPhotosTab || null;
    const previewPhotos = photosTab?.invoke?.('normalizeProjectPhotoList', [project]) || (Array.isArray(project?.photos) ? project.photos : []);
    const identityIndex = projectProposals.indexOf(proposal);
    const proposalIndex = identityIndex >= 0
      ? identityIndex
      : (Number.isFinite(requestedIndex) && requestedIndex >= 0 && requestedIndex < projectProposals.length ? requestedIndex : 0);
    const renderProposals = projectProposals.length ? projectProposals : [proposal];
    const activeIndex = proposalIndex >= 0 ? proposalIndex : 0;
    const previousState = {
      mounted: state.mounted
    };
    const previousGlobals = {
      activeBaseProject: window.activeBaseProject,
      proposals: window.proposals,
      activeProposalIndex: window.activeProposalIndex,
      activeProposalPageIndex: window.activeProposalPageIndex,
      activePreviewTab: window.activePreviewTab,
      proposalWorkspaceOpen: window.proposalWorkspaceOpen,
      proposalWorkspaceMode: window.proposalWorkspaceMode,
      proposalEditorMode: window.proposalEditorMode,
      proposalSettingsPanelOpen: window.proposalSettingsPanelOpen,
      proposalSigningMode: window.proposalSigningMode,
      proposalInsertIndex: window.proposalInsertIndex,
      proposalMarkupMode: window.proposalMarkupMode,
      proposalMarkupDockOpen: window.proposalMarkupDockOpen,
      proposalMarkupPopover: window.proposalMarkupPopover,
      proposalPricebookSuggest: window.proposalPricebookSuggest,
      projectPhotos: window.projectPhotos
    };
    try {
      state.mounted = true;
      window.activeBaseProject = project;
      window.projectPhotos = previewPhotos;
      window.proposals = renderProposals;
      window.activeProposalIndex = activeIndex;
      window.activeProposalPageIndex = 0;
      window.activePreviewTab = 'proposal';
      window.proposalWorkspaceOpen = true;
      window.proposalWorkspaceMode = 'list';
      window.proposalEditorMode = 'preview';
      window.proposalSettingsPanelOpen = false;
      window.proposalSigningMode = false;
      window.proposalInsertIndex = null;
      window.proposalMarkupMode = false;
      window.proposalMarkupDockOpen = false;
      window.proposalMarkupPopover = null;
      window.proposalPricebookSuggest = null;
      renderProposalPreviewCore(options.preservedScrollTop ?? null, root);
      root.querySelectorAll('[contenteditable="true"]').forEach((el) => {
        el.setAttribute('contenteditable', 'false');
        el.classList.add('is-preview');
      });
      return true;
    } catch (error) {
      console.warn('Global proposal preview render failed', error);
      return false;
    } finally {
      state.mounted = previousState.mounted;
      Object.entries(previousGlobals).forEach(([key, value]) => {
        window[key] = value;
      });
    }
  }

  async function runReadOnlyProposalAction(options = {}){
    const project = options.project || null;
    const projectProposals = Array.isArray(project?.proposals) ? project.proposals : [];
    const requestedIndex = Number(options.proposalIndex);
    const proposal = options.proposal || projectProposals[Number.isFinite(requestedIndex) ? requestedIndex : 0] || null;
    const action = String(options.action || '').trim().toLowerCase();
    if (!proposal || !action) return null;
    window.Portal?.modules?.request?.ensureStyles?.();
    window.Portal?.modules?.request?.ensureProposalContext?.();
    const photosTab = window.Portal?.modules?.projectPhotosTab || window.Portal?.ProjectPhotosTab || null;
    const previewPhotos = photosTab?.invoke?.('normalizeProjectPhotoList', [project]) || (Array.isArray(project?.photos) ? project.photos : []);
    const identityIndex = projectProposals.indexOf(proposal);
    const proposalIndex = identityIndex >= 0
      ? identityIndex
      : (Number.isFinite(requestedIndex) && requestedIndex >= 0 && requestedIndex < projectProposals.length ? requestedIndex : 0);
    const renderProposals = projectProposals.length ? projectProposals : [proposal];
    const activeIndex = proposalIndex >= 0 ? proposalIndex : 0;
    const previousState = { mounted: state.mounted };
    const previousGlobals = {
      activeBaseProject: window.activeBaseProject,
      proposals: window.proposals,
      activeProposalIndex: window.activeProposalIndex,
      activeProposalPageIndex: window.activeProposalPageIndex,
      activePreviewTab: window.activePreviewTab,
      proposalWorkspaceOpen: window.proposalWorkspaceOpen,
      proposalWorkspaceMode: window.proposalWorkspaceMode,
      proposalEditorMode: window.proposalEditorMode,
      proposalSettingsPanelOpen: window.proposalSettingsPanelOpen,
      proposalSigningMode: window.proposalSigningMode,
      proposalInsertIndex: window.proposalInsertIndex,
      proposalMarkupMode: window.proposalMarkupMode,
      proposalMarkupDockOpen: window.proposalMarkupDockOpen,
      proposalMarkupPopover: window.proposalMarkupPopover,
      proposalPricebookSuggest: window.proposalPricebookSuggest,
      proposalDeleteConfirmProposalId: window.proposalDeleteConfirmProposalId,
      projectPhotos: window.projectPhotos
    };
    try {
      state.mounted = true;
      window.activeBaseProject = project;
      window.projectPhotos = previewPhotos;
      window.proposals = renderProposals;
      window.activeProposalIndex = activeIndex;
      window.activeProposalPageIndex = 0;
      window.activePreviewTab = 'proposal';
      window.proposalWorkspaceOpen = true;
      window.proposalWorkspaceMode = 'list';
      window.proposalEditorMode = 'preview';
      window.proposalSettingsPanelOpen = false;
      window.proposalSigningMode = false;
      window.proposalInsertIndex = null;
      window.proposalMarkupMode = false;
      window.proposalMarkupDockOpen = false;
      window.proposalMarkupPopover = null;
      window.proposalPricebookSuggest = null;
      if (action === 'duplicate') {
        duplicateProposal(activeIndex);
        if (window.activeBaseProject) window.activeBaseProject.proposals = proposals;
        await saveProposalToBackend(activeProposalIndex, { silent: true }).catch((error) => console.warn('Duplicated proposal save failed', error));
      } else if (action === 'delete') {
        window.proposalDeleteConfirmProposalId = proposalStableId(proposals[activeIndex], activeIndex);
        removeProposal(activeIndex);
        if (window.activeBaseProject) window.activeBaseProject.proposals = proposals;
        await window.persistActiveBaseProject?.()?.catch?.((error) => console.warn('Deleted proposal project save failed', error));
      } else if (action === 'print') {
        printProposal(activeIndex);
      } else if (action === 'download') {
        await downloadProposalPdf(activeIndex);
      } else {
        return null;
      }
      return {
        proposals: Array.isArray(proposals) ? proposals : [],
        activeProposalIndex: Number(activeProposalIndex || 0) || 0
      };
    } finally {
      state.mounted = previousState.mounted;
      Object.entries(previousGlobals).forEach(([key, value]) => {
        window[key] = value;
      });
    }
  }

  function renderProposalSection(){ return renderProposalSectionCore(); }

  function renderProposalPreview(preservedScrollTop = null){ return renderProposalPreviewCore(preservedScrollTop); }

  const proposalEngineApi = {
    proposalNumericValue,
    normalizeProposalMeasurements,
    defaultProposalMeasurements,
    firstNumberFromObject,
    meters2ToProposalSquares,
    pitchDegreesToRise12,
    pitchBucketForRise,
    proposalMeasurementsFromRoofSegments,
    xmlTextToMeasurementObject,
    fetchProposalArtifact,
    loadProposalMeasurementSource,
    requestProposalMeasurementHydration,
    firstMeasureProposalMeasurements,
    proposalMeasurementsHaveValues,
    proposalMeasurementsLookPlaceholder,
    ensureProposalMeasurements,
    buildLinkedPricebookLineItem,
    seedProposalPricingFromPricebook,
    syncProposalPricebookItems,
    proposalUsedPricebookState,
    proposalPricebookOpenState,
    showAutosaveNotice,
    queueAutosaveNotice,
    proposalContactFallback,
    formatProposalPhone,
    proposalPreparedForText,
    normalizeProposalPlainText,
    proposalPreparedForShouldRefresh,
    proposalPreparedByText,
    proposalCustomerPrimaryContact,
    proposalTodayText,
    proposalNumericCurrency,
    proposalPricingSummary,
    proposalSignatureTemplateName,
    proposalSignatureTemplate,
    proposalSignedSlot,
    proposalRenderSignatureValue,
    ensureProposalSignatureData,
    proposalSignatureTargets,
    ensureProposalSigningSession,
    proposalSigningComplete,
    proposalNextUnsignedTarget,
    proposalCoverImages,
    proposalCoverImage,
    proposalPageSubtitle,
    proposalDisplayTitle,
    proposalTriangleHeaderVars,
    getOrganizationMarketingPages,
    proposalMeasurementInsertAssets,
    proposalFullPageAssetUrl,
    proposalFullPageInsertMarkup,
    proposalIsFullPageInsert,
    ensureProposalPdfJs,
    proposalPdfDocument,
    renderProposalPdfCanvasPage,
    renderProposalPdfCanvasPages,
    createProposalMediaBlock,
    defaultImageTextBlock,
    proposalMediaBlockMaxHeight,
    proposalPricingMetrics,
    proposalPricingCapacity,
    proposalPricingRowsForPage,
    proposalSelectCustomerChoiceOption,
    proposalSplitPricingSections,
    appendProposalLineItem,
    appendProposalSectionLineItem,
    appendProposalDiscountLineItem,
    proposalPlainTextLength,
    proposalIntroReserve,
    proposalMediaPageLimit,
    proposalMediaBlockHeight,
    proposalMediaSectionUsed,
    proposalSplitContentBlocks,
    proposalSplitFinePrintSections,
    proposalSectionPageCount,
    proposalPageEnabled,
    proposalBuilderScopeForTemplate,
    projectHasDefinedScope,
    projectScopeLabel,
    projectScopeFromBuilder,
    applyProjectScopeToProposal,
    createProposalFromProjectScope,
    saveProjectScope,
    startProjectScopeWorkflow,
    openProjectScopeWorkflow,
    renderProjectScopeBuilder,
    firstEnabledProposalPageIndex,
    normalizeActiveProposalPage,
    proposalRenderSections,
    normalizeProposalNumber,
    normalizeProposalInteger,
    proposalCurrencyEditText,
    proposalCurrencyDisplay,
    proposalStylePreview,
    getBranchPresentationStyle,
    platformTheme,
    proposalPlatformApiBaseUrl,
    proposalMediaUrl,
    normalizeProposalLogoUrl,
    logoFromBrandObject,
    loadBranchPresentationStyle,
    getProposalBrandLogo,
    getProposalBrandName,
    proposalBrandColorCandidates,
    proposalAccentColorCandidates,
    styleColor,
    cssThemeColor,
    normalizeProposalHexColor,
    normalizeProposalFontFamily,
    proposalFontStack,
    normalizeProposalImageRef,
    hexToRgbString,
    getProposalPrimaryColor,
    getProposalAccentColor,
    getProposalAccentReadableColor,
    getProposalFontFamily,
    proposalLogoMarkup,
    proposalCoBrandLogo,
    proposalImageFallbackAttrs,
    proposalCoBrandMarkup,
    proposalBrandLockup,
    normalizeProposalBrandingMediaItem,
    loadProposalBrandingMedia,
    uploadProposalBrandingFiles,
    createProposalPageId,
    ensureProposalPageIds,
    cloneMarkupState,
    ensureProposalMarkup,
    getPageMarkupItems,
    pushProposalMarkupHistory,
    restoreProposalMarkupHistory,
    proposalMarkupSvgPath,
    proposalMarkupSizeLabel,
    getProposalFieldStyles,
    setProposalFieldStyles,
    sanitizeProposalRichHtml,
    proposalMarkupCursorSvg,
    pointToPercent,
    distanceToSegment,
    splitStrokeByErase,
    currentProposalPage,
    findNearestMarkupItem,
    proposalArrowGeometry,
    proposalMarkupHtml,
    createProposalPage,
    normalizeProposalTemplate,
    proposalTemplatesCustom,
    allProposalTemplates,
    visibleProposalTemplates,
    proposalTemplatePageType,
    proposalTemplateCreatorName,
    proposalTemplateSnapshot,
    loadBranchProposalTemplates,
    saveBranchProposalTemplates,
    applyProposalTemplate,
    closeProposalTemplateModal,
    openProposalTemplateBrowser,
    openProposalTemplateCreateModal,
    proposalEditableTag,
    recomputeProposalPricing,
    proposalMediaBlocksMarkup,
    proposalPageMarkup,
    setProposalField,
    proposalMarkupDockHtml,
    closeProposalPhotoPicker,
    openProposalPhotoPicker,
    openProposalCoBrandPicker,
    handleProposalPreviewKeydown,
    openProposalInsertChooser,
    buildProposalFromForm,
    proposalStableId,
    proposalLocalVersion,
    setProposalLocalVersion,
    markProposalLocalMutation,
    proposalBySaveKey,
    markActiveProposalLocalMutation,
    proposalIndexLabel,
    proposalDefaultTitle,
    normalizeProposalPageRecord,
    normalizeProposalRecord,
    normalizeProposalCollection,
    proposalDisplayName,
    proposalStatusLabel,
    proposalApiReady,
    proposalBranchId,
    cloneProposalJson,
    proposalContacts,
    proposalThemeKey,
    proposalThemePayload,
    proposalEditablePayload,
    proposalApiPayload,
    localProposalFromApi,
    mergeSavedProposal,
    mergeSavedProposalMetadata,
    proposalsApiRouteMissing,
    proposalApiErrorMessage,
    ensureProposalErrorToast,
    showProposalError,
    saveProposalEmbeddedFallback,
    ensureProposalBackendProject,
    saveProposalToBackend,
    queueProposalBackendAutosave,
    hydrateProposalsFromBackend,
    proposalHasCustomerSignature,
    proposalHasView,
    proposalDeliveryStatus,
    proposalDeliveryLabel,
    proposalContactKey,
    proposalContactLabel,
    selectedProposalIdsForSend,
    enterProposalListMode,
    enterProposalEditMode,
    enterProposalSendMode,
    createNewProposalAndEdit,
    duplicateProposal,
    removeProposal,
    proposalBackendId,
    proposalPdfFileName,
    proposalPlainTextForPdf,
    proposalPagePdfText,
    wrapPdfLine,
    pdfEscape,
    proposalLocalPdfBlob,
    downloadProposalBlob,
    proposalRenderedPageStackHtml,
    proposalPdfDocumentHtml,
    proposalBackendPdfUrl,
    openProposalPdfUrl,
    downloadProposalPdfUrl,
    syncProposalDownloadButtons,
    printProposal,
    downloadProposalPdf,
    createProposalFromFormAndTrack,
    closeSignatureChooser,
    applySignatureToPageSlot,
    scrollSigningToTarget,
    openSignatureChooser,
    renderSignatureChooser,
    closeProposalPricebookSuggest,
    applyPricebookItemToRow,
    showProposalPricebookSuggest,
    openProposalPricebookEditor,
    renderProposalListSection,
    renderProposalSendSection,
    renderProposalSectionCore,
    renderProposalPreviewCore,
    renderReadOnlyPreview,
    runReadOnlyProposalAction,
    showProposalWorkspace,
    mountProposalSettingsPanel,
    clearProposalSettingsPanel,
    closeProposalSettingsPanel,
    openProposalSettingsPanel,
    launchProposalBuilder,
    hideProposalWorkspace,
    bindProposalModeToggle,
    bindProposalMarkupToggle,
    syncProposalAgentState,
    syncProposalBottomSendState,
    positionProposalWorkspaceChrome,
    syncProposalWorkspaceChrome,
    startProposalAgentProgress,
    toggleProposalAgentDictation,
    stopProposalAgentActivity,
    renderProposalSection,
    renderProposalPreview
  };
  // END PROPOSAL ENGINE

  function callHost(method, ...args){
    const fn = state.host && state.host[method];
    if (typeof fn !== 'function') return undefined;
    return fn(...args);
  }

  function mount(options = {}){
    state.context = options;
    state.model = options.projectModel || options.model || (options.host ? null : (state.model || window.FirstMateAppContext?.modelFromContext?.(options))) || null;
    if (state.model && window.FirstMateAppContext?.installProjectContextAccessors) {
      window.FirstMateAppContext.installProjectContextAccessors(state.model, { overwrite: false });
    }
    state.host = options.host || (state.model && window.FirstMateAppContext?.createProjectHost?.(state.model)) || state.host;
    state.leftRoot = options.leftRoot || $('#rProposalSection');
    state.previewRoot = options.previewRoot || $('#rProposalPreview');
    state.overlayRoot = options.overlayRoot || $('#rOverlay');
    state.mounted = !!(state.leftRoot || state.previewRoot);
    if (state.mounted) {
      state.leftRoot?.setAttribute('data-proposals-tab-mounted', 'true');
      state.previewRoot?.setAttribute('data-proposals-tab-mounted', 'true');
    }
    loadProposalScopeTemplates().catch(() => null);
    return api;
  }

  function ensureMounted(options = {}){
    if (!state.mounted || options.force) mount(options);
    return state.mounted;
  }

  function setActive(active){
    const nextActive = !!active;
    if (state.active === nextActive) {
      syncChrome();
      return;
    }
    state.active = nextActive;
    state.overlayRoot?.classList.toggle('proposal-workspace', nextActive);
    if (!nextActive) state.overlayRoot?.classList.remove('proposal-list-mode', 'proposal-edit-mode', 'proposal-send-mode', 'proposal-builder-mode');
    callHost(nextActive ? 'onActivate' : 'onDeactivate');
    if (state.active) {
      loadProposalScopeTemplates().catch(() => null);
      hydrateProposalsFromBackend({ render: true }).catch((error) => console.warn('Proposal tab load failed', error));
      renderAll();
    }
    syncChrome();
  }

  function renderManager(){
    if (!ensureMounted()) return;
    if (state.renderDepth > 24) {
      console.warn('Proposal manager render loop stopped.');
      return;
    }
    state.renderDepth += 1;
    try {
      renderProposalSectionCore();
    } finally {
      state.renderDepth -= 1;
    }
  }

  function renderPreview(preservedScrollTop = null){
    if (!ensureMounted()) return;
    if (preservedScrollTop !== null && preservedScrollTop !== undefined) {
      state.pendingPreviewScrollTop = preservedScrollTop;
    }
    if (state.renderDepth > 24) {
      console.warn('Proposal preview render loop stopped.');
      return;
    }
    state.renderDepth += 1;
    try {
      const scrollTop = state.pendingPreviewScrollTop;
      state.pendingPreviewScrollTop = null;
      renderProposalPreviewCore(scrollTop);
    } finally {
      state.renderDepth -= 1;
    }
  }

  function renderAll(options = {}){
    if (!ensureMounted()) return;
    renderManager();
    renderPreview(options.preservedScrollTop ?? null);
    syncChrome();
  }

  function syncChrome(){
    if (typeof syncProposalWorkspaceChrome === 'function') syncProposalWorkspaceChrome(); else callHost('syncChrome');
  }

  function reset(){
    state.active = false;
    state.pendingPreviewScrollTop = null;
    if (typeof stopProposalAgentActivity === 'function') stopProposalAgentActivity();
    callHost('onReset');
    syncChrome();
  }

  function unmount(){
    callHost('onUnmount');
    state.mounted = false;
    state.active = false;
    state.leftRoot = null;
    state.previewRoot = null;
    state.overlayRoot = null;
    state.host = null;
    state.pendingPreviewScrollTop = null;
  }

  function context(){
    return {
      mounted: state.mounted,
      active: state.active,
      leftRoot: state.leftRoot,
      previewRoot: state.previewRoot,
      overlayRoot: state.overlayRoot
    };
  }

  function panelHtml(){
    return '<div id="rProposalPreview" style="height:100%"></div>';
  }

  function invoke(name, args = []){
    const fn = proposalEngineApi[name];
    if (typeof fn !== 'function') return undefined;
    return fn(...(Array.isArray(args) ? args : []));
  }

  function functionNames(){
    return Object.keys(proposalEngineApi);
  }

  const api = {
    invoke,
    functionNames,
    mount,
    ensureMounted,
    setActive,
    activate: () => setActive(true),
    deactivate: () => setActive(false),
    renderManager,
    renderPreview,
    renderAll,
    syncChrome,
    reset,
    unmount,
    context
  };

  Portal.modules = Portal.modules || {};
  Portal.modules.proposalsTab = api;
  Portal.ProposalsTab = api;
  window.Portal?.navigation?.registerHandler?.('project-proposal-route', {
    priority:600,
    apply:(route) => {
      if (!route.project || route.projectTab !== 'proposal' || !state.mounted || !proposals.length) return;
      const requestedIndex = route.proposal
        ? proposals.findIndex((proposal, index) => proposalStableId(proposal, index) === route.proposal)
        : activeProposalIndex;
      const index = requestedIndex >= 0 ? requestedIndex : 0;
      if (route.proposalMode === 'edit') enterProposalEditMode(index, { updateRoute:false });
      else if (route.proposalMode === 'send') enterProposalSendMode('list', [proposalStableId(proposals[index], index)], { updateRoute:false });
      else enterProposalListMode(index, { updateRoute:false });
    }
  });
  window.addEventListener('fm:scope-templates:updated', () => {
    proposalScopeTemplatesLoaded = false;
    loadProposalScopeTemplates({ refresh:true }).then(() => {
      if (state.active) renderAll();
    }).catch(() => null);
  });
  window.addEventListener('fm:project-media-upload-resolved', replaceResolvedProposalMedia);

  runtime?.registerApp?.({
    id: 'project.proposal',
    kind: 'project_modal_app',
    title: (globalThis.PlatformLanguage?.text("proposals","m_9964312e9c85ac","Project Proposals") ?? "Project Proposals"),
    label: (globalThis.PlatformLanguage?.text("proposals","m_3129f3f0e39249","Proposals") ?? "Proposals"),
    icon: 'fa-file-signature',
    order: 50,
    // DEPRECATED (see file header): the tab is hidden — documents now live on
    // the unified Docs tab. The module stays registered for its exports.
    visible: false,
    surfaces: ['project_modal'],
    regions: ['main', 'left'],
    requiresContext: ['project'],
    dependencies: ['project.photos'],
    enabled: (context = {}) => context.proposalsEnabled !== false,
    panelHtml,
    mount: (context = {}) => mount(context)
  });
})();
