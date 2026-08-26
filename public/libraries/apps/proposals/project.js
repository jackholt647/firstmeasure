/* public/libraries/apps/proposals/project.js
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
    readOnlyPresentationStyleLoad: null
  };

  const PROPOSAL_DEFAULT_SALES_TAX_PERCENT = 0;
  const PROPOSAL_DEFAULT_PAYMENT_SCHEDULE = [
    { key: 'deposit', label: 'Deposit', percent: 30, due_rule: 'on_signature' },
    { key: 'progress', label: 'Progress Payment', percent: 30, due_rule: 'manual' },
    { key: 'final', label: 'Final Payment', percent: 40, due_rule: 'project_completion' },
  ];
  const PROPOSAL_PAYMENT_ROWS = [
    { key: 'deposit', labelField: 'depositLabel', amountField: 'depositAmount', percentField: 'depositPercent', defaultLabel: 'Deposit', due_rule: 'on_signature' },
    { key: 'progress', labelField: 'completionLabel', amountField: 'completionAmount', percentField: 'completionPercent', defaultLabel: 'Progress Payment', due_rule: 'manual' },
    { key: 'final', labelField: 'financedLabel', amountField: 'financedAmount', percentField: 'financedPercent', defaultLabel: 'Final Payment', due_rule: 'project_completion' },
  ];


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

  function normalizeProposalMeasurements(input = {}){
    const numeric = (value, fallback = 0) => {
      const next = proposalNumericValue(value);
      return Number.isFinite(next) ? next : fallback;
    };
    const structures = Math.max(1, numeric(input.structures, 1));
    let flatRoofSquares = Math.max(0, numeric(input.flatRoofSquares, 0));
    let pitch2to4Squares = Math.max(0, numeric(input.pitch2to4Squares, 0));
    let pitch4to6Squares = Math.max(0, numeric(input.pitch4to6Squares, 0));
    let pitch6to8Squares = Math.max(0, numeric(input.pitch6to8Squares, 0));
    let pitch9to12Squares = Math.max(0, numeric(input.pitch9to12Squares, 0));
    let pitch13PlusSquares = Math.max(0, numeric(input.pitch13PlusSquares, 0));
    let shingleSquares = pitch2to4Squares + pitch4to6Squares + pitch6to8Squares + pitch9to12Squares + pitch13PlusSquares;
    let roofSquares = shingleSquares + flatRoofSquares;
    const suppliedRoofSquares = Math.max(0, numeric(input.roofSquares, 0));
    const suppliedShingleSquares = Math.max(0, numeric(input.shingleSquares, 0));
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
      flatRoofSquares,
      pitch2to4Squares,
      pitch4to6Squares,
      pitch6to8Squares,
      pitch9to12Squares,
      pitch13PlusSquares,
      shingleSquares,
      roofSquares,
      wastePercent: Math.max(0, numeric(input.wastePercent, 0)),
      eavesLf: Math.max(0, numeric(input.eavesLf, 0)),
      rakesLf: Math.max(0, numeric(input.rakesLf, 0)),
      hipsLf: Math.max(0, numeric(input.hipsLf, 0)),
      ridgesLf: Math.max(0, numeric(input.ridgesLf, 0)),
      valleyLf: Math.max(0, numeric(input.valleyLf, 0)),
      transitionsLf: Math.max(0, numeric(input.transitionsLf, 0)),
      sideWallLf: Math.max(0, numeric(input.sideWallLf, 0)),
      headWallLf: Math.max(0, numeric(input.headWallLf, 0)),
      gutterLf: Math.max(0, numeric(input.gutterLf, 0)),
      downspoutLf: Math.max(0, numeric(input.downspoutLf, 0)),
      structures,
      chimneysEa: Math.max(0, numeric(input.chimneysEa, 0)),
      skylightsEa: Math.max(0, numeric(input.skylightsEa, 0)),
    };
  }

  function defaultProposalMeasurements(){
    return normalizeProposalMeasurements({
      structures: Math.max(1, pinCount() || 1),
    });
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

  function xmlTextToMeasurementObject(xmlText){
    const text = String(xmlText || '').trim();
    if (!text || typeof DOMParser === 'undefined') return {};
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return {};
      const out = {};
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

  async function loadProposalMeasurementSource(projectId){
    if (!projectId || !fmJson) return {};
    if (proposalMeasurementCache.has(projectId)) return proposalMeasurementCache.get(projectId);
    if (proposalMeasurementLoads.has(projectId)) return null;
    proposalMeasurementLoads.add(projectId);
    try {
      const data = await fmJson(`projects/${encodeURIComponent(projectId)}`);
      const project = data?.project && typeof data.project === 'object' ? data.project : {};
      const manifest = project?.manifest && typeof project.manifest === 'object' ? project.manifest : {};
      const files = Array.isArray(project.files) ? project.files : [];
      const names = new Set(files.map((file) => String(file?.name || '')));
      const fileByLower = new Map(files.map((file) => [String(file?.name || '').toLowerCase(), String(file?.name || '')]));
      const artifactName = (name) => fileByLower.get(String(name || '').toLowerCase()) || '';
      const source = { detail: data, project, manifest };
      const xmlName = artifactName('model_data.xml');
      if (xmlName) {
        const xml = await fetchProposalArtifact(projectId, xmlName, 'text');
        source.model_data_xml = xmlTextToMeasurementObject(xml);
      }
      for (const fileName of ['measurements.json', 'measurement.json', 'insights.json', 'instant-structures.json']) {
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
    }
  }

  function requestProposalMeasurementHydration(proposal){
    const projectId = activeMeasurementProjectId();
    if (!proposal || !projectId || proposalMeasurementLoads.has(projectId)) return;
    proposal.measurement_source = 'loading';
    loadProposalMeasurementSource(projectId).then((source) => {
      if (!source) return;
      const hydrated = firstMeasureProposalMeasurements(source);
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
    const reportData = reportOrderState?.data && typeof reportOrderState.data === 'object' ? reportOrderState.data : {};
    const projectMeasurement = activeBaseProject?.measurement && typeof activeBaseProject.measurement === 'object' ? activeBaseProject.measurement : {};
    const projectMeasurementProject = activeBaseProject?.measurement_project && typeof activeBaseProject.measurement_project === 'object' ? activeBaseProject.measurement_project : {};
    const measurement = {
      ...reportData,
      ...projectMeasurement,
      ...projectMeasurementProject,
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
      activeProjectMeasurement: activeBaseProject?.measurement,
      activeProjectMeasurementProject: activeBaseProject?.measurement_project,
    };
    const squaresFromSqft = (keys) => {
      const value = firstNumberFromObject(source, keys);
      return value == null ? null : Math.round((value / 100) * 10) / 10;
    };
    const squaresFromMeters2 = (keys) => meters2ToProposalSquares(firstNumberFromObject(source, keys));
    const segmentMeasurements = proposalMeasurementsFromRoofSegments(source);
    const extracted = normalizeProposalMeasurements({
      structures: firstNumberFromObject(source, ['structures', 'structure_count', 'building_count', 'pins_count']) || Math.max(1, pinCount() || 1),
      flatRoofSquares: firstNumberFromObject(source, ['flatRoofSquares', 'flat_roof_squares', 'flat_squares', 'flat', 'low_slope', 'low_slope_squares']) ?? squaresFromSqft(['flat_roof_sqft', 'flat_roof_area_sqft', 'flat_area_sqft']) ?? squaresFromMeters2(['flat_roof_meters2', 'flat_roof_area_meters2']) ?? segmentMeasurements?.flatRoofSquares,
      pitch2to4Squares: firstNumberFromObject(source, ['pitch2to4Squares', 'pitch_2_4_squares', 'pitch_2to4_squares', '2_4_squares', '2to4', '2-4']) ?? squaresFromSqft(['pitch_2_4_sqft', 'pitch_2to4_sqft']) ?? segmentMeasurements?.pitch2to4Squares,
      pitch4to6Squares: firstNumberFromObject(source, ['pitch4to6Squares', 'pitch_4_6_squares', 'pitch_4to6_squares', '4_6_squares', '4to6', '4-6']) ?? squaresFromSqft(['pitch_4_6_sqft', 'pitch_4to6_sqft']) ?? segmentMeasurements?.pitch4to6Squares,
      pitch6to8Squares: firstNumberFromObject(source, ['pitch6to8Squares', 'pitch_6_8_squares', 'pitch_6to8_squares', '6_8_squares', '6to8', '6-8']) ?? squaresFromSqft(['pitch_6_8_sqft', 'pitch_6to8_sqft']) ?? segmentMeasurements?.pitch6to8Squares,
      pitch9to12Squares: firstNumberFromObject(source, ['pitch9to12Squares', 'pitch_9_12_squares', 'pitch_9to12_squares', '9_12_squares', '9to12', '9-12']) ?? squaresFromSqft(['pitch_9_12_sqft', 'pitch_9to12_sqft']) ?? segmentMeasurements?.pitch9to12Squares,
      pitch13PlusSquares: firstNumberFromObject(source, ['pitch13PlusSquares', 'pitch_13_plus_squares', 'pitch_13plus_squares', '13_plus_squares', '13plus', '13+']) ?? squaresFromSqft(['pitch_13_plus_sqft', 'pitch_13plus_sqft']) ?? segmentMeasurements?.pitch13PlusSquares,
      wastePercent: firstNumberFromObject(source, ['wastePercent', 'waste_percent']),
      eavesLf: firstNumberFromObject(source, ['eavesLf', 'eaves_lf', 'eave_length', 'eaves', 'eave']),
      rakesLf: firstNumberFromObject(source, ['rakesLf', 'rakes_lf', 'rake_length', 'rakes', 'rake']),
      hipsLf: firstNumberFromObject(source, ['hipsLf', 'hips_lf', 'hip_length', 'hips', 'hip']),
      ridgesLf: firstNumberFromObject(source, ['ridgesLf', 'ridges_lf', 'ridge_length', 'ridges', 'ridge']),
      valleyLf: firstNumberFromObject(source, ['valleyLf', 'valley_lf', 'valleys_lf', 'valley_length', 'valleys', 'valley']),
      transitionsLf: firstNumberFromObject(source, ['transitionsLf', 'transitions_lf']),
      sideWallLf: firstNumberFromObject(source, ['sideWallLf', 'side_wall_lf']),
      headWallLf: firstNumberFromObject(source, ['headWallLf', 'head_wall_lf']),
      gutterLf: firstNumberFromObject(source, ['gutterLf', 'gutters_lf', 'gutter_lf']),
      downspoutLf: firstNumberFromObject(source, ['downspoutLf', 'downspouts_lf', 'downspout_lf']),
      chimneysEa: firstNumberFromObject(source, ['chimneysEa', 'chimneys', 'chimney_count']),
      skylightsEa: firstNumberFromObject(source, ['skylightsEa', 'skylights', 'skylight_count']),
    });
    const totalSquares = firstNumberFromObject(source, ['roofSquares', 'roof_squares', 'total_squares', 'total_roof_squares'])
      ?? squaresFromSqft(['roof_sqft', 'roof_area_sqft', 'total_roof_area_sqft', 'total_roof_sqft', 'total_area_sqft', 'area_sqft', 'roof_area', 'roofarea', 'total_roof_area', 'total_area'])
      ?? squaresFromMeters2(['total_roof_area_meters2', 'whole_roof_area_meters2', 'roof_area_meters2']);
    if (totalSquares && extracted.roofSquares <= 0) {
      extracted.pitch4to6Squares = totalSquares;
      extracted.shingleSquares = totalSquares;
      extracted.roofSquares = totalSquares;
    }
    return proposalMeasurementsHaveValues(extracted) ? extracted : null;
  }

  function proposalMeasurementsHaveValues(measurements = {}){
    return ['roofSquares', 'shingleSquares', 'flatRoofSquares', 'pitch2to4Squares', 'pitch4to6Squares', 'pitch6to8Squares', 'pitch9to12Squares', 'pitch13PlusSquares', 'eavesLf', 'rakesLf', 'hipsLf', 'ridgesLf', 'valleyLf', 'gutterLf', 'downspoutLf']
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
    return proposal.measurements;
  }

  function buildLinkedPricebookLineItem(itemId, proposal, overrides = {}){
    const pricebook = getPricebookModule();
    if (!pricebook?.lineItemFromPricebook) return null;
    const measurements = ensureProposalMeasurements(proposal);
    return pricebook.lineItemFromPricebook(itemId, measurements, overrides);
  }

  function seedProposalPricingFromPricebook(proposal){
    const pricebook = getPricebookModule();
    if (!proposal) return [];
    const measurements = ensureProposalMeasurements(proposal);
    const items = pricebook?.defaultLineItems?.(measurements) || [];
    return items.length ? items : [{ label: 'New Line Item', quantity: '1', unitPrice: '$0.00', amount: '$0.00' }];
  }

  function syncProposalPricebookItems(proposal){
    if (!proposal?.pages?.length) return;
    ensureProposalMeasurements(proposal);
    proposal.pages.forEach((page) => {
      if (page.kind !== 'pricing') return;
      recomputeProposalPricing(page, proposal);
    });
  }

  function proposalUsedPricebookState(proposal){
    const usedItemIds = new Set();
    const usedCategories = new Set();
    proposal?.pages?.forEach((page) => {
      if (page.kind !== 'pricing') return;
      (page.lineItems || []).forEach((item) => {
        if (item.pricebookItemId) usedItemIds.add(item.pricebookItemId);
        if (item.category) usedCategories.add(item.category);
      });
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
    return new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
  }

  function proposalNumericCurrency(value){
    return Number(normalizeProposalNumber(value || 0) || 0);
  }

  function proposalPricingSummary(proposal){
    const subtotal = (proposal?.pages || []).filter((page) => page.kind === 'pricing').reduce((sum, page) => {
      return sum + (page.lineItems || []).reduce((pageSum, item) => pageSum + proposalNumericCurrency(item.amount || 0), 0);
    }, 0);
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
      return `<span class="r-proposal-signature-script"><img src="${escapeHtml(signature.dataUrl)}" alt="Signature"></span>`;
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
        const pricingSubtotal = (proposal?.pages || []).filter((item) => item.kind === 'pricing').reduce((sum, pricingPage) => {
          return sum + (pricingPage.lineItems || []).reduce((pageSum, item) => pageSum + proposalNumericCurrency(item.amount || 0), 0);
        }, 0);
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
      return assets.find((asset) => asset.id === page.assetId)?.title || page.title || 'Marketing Page';
    }
    if (page.kind === 'cover') return page.heading || page.title || 'Cover';
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
      { id: 'marketing_shingles', title: 'Premium Shingles', subtitle: 'Manufacturer brochure preview', image: '' },
      { id: 'marketing_warranty', title: 'Warranty Coverage', subtitle: 'Coverage and workmanship preview', image: '' },
    ];
  }

  function proposalMeasurementInsertAssets(){
    const projectId = activeMeasurementProjectId();
    const cached = projectId ? primeMeasurementAssetCacheFromKnownUrls(projectId) : null;
    if (projectId && !cached?.hasCheckedArtifacts && !measurementAssetLoads.has(projectId)) {
      loadMeasurementAssets(projectId).then(() => {
        if (proposalsEnabled() && activePreviewTab === 'proposal' && proposalWorkspaceOpen) {
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
            ? `<div class="r-proposal-pdf-canvas-page" data-pdf-canvas-url="${escapeHtml(active.pdf || active.url || '')}" data-pdf-canvas-page="${escapeHtml(String(active.page || 1))}"><div class="r-proposal-full-placeholder"><strong>Rendering page...</strong><span>${escapeHtml(active?.title || page.title || 'Summary page')}</span></div></div>`
            : (isPdf
              ? `<iframe src="${escapeHtml(url)}" title="${escapeHtml(active?.title || page.title || 'Proposal insert')}"></iframe>`
            : `<img src="${escapeHtml(url)}" alt="${escapeHtml(active?.title || page.title || 'Proposal insert')}">`
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
      el.innerHTML = '<div class="r-proposal-full-placeholder"><strong>Summary unavailable</strong><span>Could not render this Summary PDF page.</span></div>';
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
      text: type === 'image' ? '' : (previous?.text || 'Add supporting copy here.'),
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

  function proposalPricingMetrics(theme = 'margin'){
    if (theme === 'triangles') {
      return { bodyHeight: 640, lineHeight: 46, addRowHeight: 58, totalHeight: 64 };
    }
    if (theme === 'clean') {
      return { bodyHeight: 694, lineHeight: 46, addRowHeight: 58, totalHeight: 64 };
    }
    return { bodyHeight: 714, lineHeight: 46, addRowHeight: 58, totalHeight: 64 };
  }

  function proposalPricingCapacity(theme = 'margin', { isFinal = false, isEdit = false } = {}){
    const metrics = proposalPricingMetrics(theme);
    let available = metrics.bodyHeight;
    if (isFinal) {
      available -= metrics.totalHeight;
      if (isEdit) available -= metrics.addRowHeight;
    }
    return Math.max(1, Math.floor(available / metrics.lineHeight));
  }

  function proposalSplitPricingSections(page, theme = 'margin', isEdit = proposalEditorMode === 'edit'){
    const items = (page?.lineItems || []).map((item, index) => ({ ...item, __logicalLineItemIndex: index }));
    if (!items.length) {
      return [{
        ...page,
        lineItems: [],
        showAddRow: isEdit,
        showTotal: true,
      }];
    }
    const finalCapacity = proposalPricingCapacity(theme, { isFinal: true, isEdit });
    const continuedCapacity = proposalPricingCapacity(theme, { isFinal: false, isEdit });
    const sections = [];
    let cursor = 0;
    while (cursor < items.length) {
      const remaining = items.length - cursor;
      const isFinal = remaining <= finalCapacity;
      const take = isFinal
        ? remaining
        : Math.max(1, Math.min(continuedCapacity, remaining - finalCapacity));
      sections.push({
        ...page,
        lineItems: items.slice(cursor, cursor + take),
        showAddRow: isFinal && isEdit,
        showTotal: isFinal,
      });
      cursor += take;
    }
    return sections;
  }

  function appendProposalLineItem(page, proposal = null, item = null){
    if (!page || page.kind !== 'pricing') return -1;
    const nextItem = item ? { ...item } : { label: 'New Line Item', quantity: '1', unitPrice: '$0.00', amount: '$0.00' };
    page.lineItems = [...(page.lineItems || []), nextItem];
    recomputeProposalPricing(page, proposal);
    return page.lineItems.length - 1;
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

  function proposalMediaPageLimit(page, includeAddPicker = false){
    return Math.max(
      180,
      PROPOSAL_MEDIA_PAGE_HEIGHT
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

  function proposalSplitContentBlocks(page, isEdit = proposalEditorMode === 'edit'){
    const blocks = page.blocks || [];
    const sections = [];
    let current = [];
    let used = 0;
    let physicalIndex = 0;
    const pageLimit = (index, includeAddPicker = false) => proposalMediaPageLimit({ ...page, showIntro: index === 0 }, includeAddPicker);
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

  function proposalSplitFinePrintSections(page){
    const body = String(page?.body || '');
    const plain = proposalPlainTextLength(body);
    const signatureReserve = page?.requireCustomerSignature === false ? 0 : 150;
    const firstCapacity = Math.max(240, Math.floor((PROPOSAL_ITEM_PAGE_HEIGHT - 210 - signatureReserve) * 2.15));
    const continuedCapacity = Math.max(260, Math.floor((PROPOSAL_ITEM_PAGE_HEIGHT - 96 - signatureReserve) * 2.35));
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

  function proposalSectionPageCount(page, theme = proposals[activeProposalIndex]?.theme || 'margin'){
    if (!page) return 1;
    if (page.kind === 'pricing') return proposalSplitPricingSections(page, theme).length;
    if (page.kind === 'image_text' || page.kind === 'scope') return proposalSplitContentBlocks(page).length;
    if (page.kind === 'fine_print') return proposalSplitFinePrintSections(page).length;
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

  function proposalRenderSections(proposal){
    const sections = [];
    (proposal?.pages || []).forEach((page, logicalIndex) => {
      if (!proposalPageEnabled(page)) return;
      if (page.kind === 'pricing') {
        const chunks = proposalSplitPricingSections(page, proposal?.theme || 'margin');
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
        const blockSections = proposalSplitContentBlocks(page);
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
        const textSections = proposalSplitFinePrintSections(page);
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
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
      return `<span class="r-proposal-cobrand${isEdit ? ' editable' : ''}" ${isEdit ? 'data-proposal-cobrand-pick="true" data-fm-tooltip="Change co-brand logo"' : ''}><img src="${escapeHtml(primary)}" alt="${escapeHtml(logo.alt || 'Co-branded logo')}"${proposalImageFallbackAttrs(primary, fallback)}><span class="r-proposal-cobrand-error">Logo unavailable</span>${isEdit ? '<button type="button" class="r-proposal-cobrand-remove" data-proposal-cobrand-remove="true" aria-label="Remove co-brand logo"><i class="fas fa-times"></i></button>' : ''}</span>`;
    }
    return isEdit ? `<button type="button" class="r-proposal-cobrand-add" data-proposal-cobrand-pick="true" data-fm-tooltip="Add co-brand logo" aria-label="Add co-brand logo"><i class="fas fa-plus"></i></button>` : '';
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
        title: 'Section Cover',
        kicker: '',
        heading: address,
        preparedFor,
        preparedBy: proposalPreparedByText(),
        date: new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }),
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
        title: 'Pricing',
        kicker: 'Pricing',
        lineItems: seedProposalPricingFromPricebook(proposal),
        notes,
        total: proposalCurrencyDisplay(0),
      };
    }
    if (template === 'marketing') {
      const asset = getOrganizationMarketingPages()[0];
      return {
        id: createProposalPageId(),
        kind: 'marketing',
        title: asset?.title || 'Marketing Page',
        kicker: 'Marketing',
        assetId: asset?.id || '',
      };
    }
    if (template === 'measurement_insert') {
      const asset = proposalMeasurementInsertAssets()[0];
      return {
        id: createProposalPageId(),
        kind: 'measurement_insert',
        title: 'FirstMeasure',
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
        title: 'Authorization',
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
        title: 'Terms and Conditions',
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
      title: 'Image & Text',
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
      if (page.kind === 'pricing') recomputeProposalPricing(page, proposal);
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
    showToast('Template applied', normalized.name, true);
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
      <div class="r-proposal-template-dialog" role="dialog" aria-modal="true" aria-label="Proposal templates">
        <div class="r-proposal-template-head">
          <div><strong>Proposal Templates</strong><span>Choose a saved page and style configuration.</span></div>
          <button type="button" class="r-proposal-template-close" aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-proposal-template-body">
          ${templates.map((template) => `
            <div class="r-proposal-template-list-item">
              <div>
                <strong>${escapeHtml(template.name)}</strong>
                <p>${escapeHtml(template.description || 'No description')}</p>
                <div class="r-proposal-template-meta">${escapeHtml(template.createdBy || 'Unknown user')}${template.preset ? ' • Built-in' : ' • Custom'} • ${escapeHtml(PROPOSAL_THEMES[template.theme]?.label || 'Style')}</div>
              </div>
              <button type="button" class="r-proposal-template-use" data-template-use="${escapeHtml(template.id)}">Use</button>
            </div>
          `).join('')}
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
      <div class="r-proposal-template-dialog small" role="dialog" aria-modal="true" aria-label="Save proposal template">
        <div class="r-proposal-template-head">
          <div><strong>Save current settings as new template</strong><span>Stores the current pages and style for reuse.</span></div>
          <button type="button" class="r-proposal-template-close" aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <form class="r-proposal-template-form">
          <label>Name<input type="text" name="name" required maxlength="80" placeholder="Template name"></label>
          <label>Description<textarea name="description" rows="3" maxlength="240" placeholder="When should this template be used?"></textarea></label>
          <div class="r-proposal-template-error" aria-live="polite"></div>
          <div class="r-proposal-template-footer">
            <button type="button" class="r-proposal-template-action secondary" data-template-cancel="true">Cancel</button>
            <button type="submit" class="r-proposal-template-action primary">Save</button>
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
        if (error) error.textContent = 'Name is required.';
        return;
      }
      const template = proposalTemplateSnapshot(proposal, name, description);
      branchProposalTemplates.templates = [template, ...proposalTemplatesCustom().filter((item) => item.id !== template.id)];
      try {
        await saveBranchProposalTemplates();
        renderProposalSection();
        close();
        showToast('Template saved', name, true);
      } catch (saveError) {
        console.warn('Unable to save proposal template', saveError);
        if (error) error.textContent = 'Could not save this template. Please try again.';
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
    if (options.derived) attrs.push('data-proposal-derived="true"');
    if (isPreview) attrs.push('data-proposal-readonly="true"', 'tabindex="-1"');
    else if (!options.derived) attrs.push('tabindex="0"');
    if (options.rich && fieldStyles.textAlign) attrs.push(`data-text-align="${escapeHtml(fieldStyles.textAlign)}"`);
    if (options.rich && fieldStyles.verticalAlign) attrs.push(`data-v-align="${escapeHtml(fieldStyles.verticalAlign)}"`);
    if (options.rich && fieldStyles.color) attrs.push(`style="--proposal-text-color:${escapeHtml(fieldStyles.color)}"`);
    return `<${tag} ${attrs.join(' ')}>${options.rich ? sanitizeProposalRichHtml(editableValue ?? '') : escapeHtml(editableValue ?? '')}</${tag}>`;
  }

  function recomputeProposalPricing(page, proposal = proposals[activeProposalIndex]){
    if (!page || page.kind !== 'pricing') return;
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
                        ${images.slice(0, 4).map((image) => `<img src="${escapeHtml(image.thumb || image.src)}" alt="">`).join('')}
                      </div>
                    ` : (isEdit ? `<div class="r-proposal-media-placeholder">+</div>` : '')}
                  </div>
                </div>
              ` : ''}
              ${hasImage && hasText ? `<div class="r-proposal-media-divider">${isEdit ? `<div class="r-proposal-media-grab" data-media-divider="${logicalIndex}"><i class="fas fa-grip-lines"></i></div>` : ''}</div>` : ''}
              ${hasText ? `
                <div class="r-proposal-media-text">
                  ${maybeEditable('div', 'r-proposal-edit-paragraph', `blocks.${logicalIndex}.text`, block.text || '', { rich: true })}
                </div>
              ` : ''}
              ${isEdit ? `<div class="r-proposal-media-heightgrab" data-media-heightgrab="${logicalIndex}"><i class="fas fa-grip-lines"></i></div>` : ''}
            </div>
          `;
        }).join('')}
        ${showAddPicker ? `
          <div class="r-proposal-media-addpicker">
            <button type="button" class="r-proposal-media-addoption" data-media-add-block="image">
              <i class="fas fa-image"></i>
              <strong>Image</strong>
            </button>
            <button type="button" class="r-proposal-media-addoption" data-media-add-block="text">
              <i class="fas fa-font"></i>
              <strong>Text</strong>
            </button>
            <button type="button" class="r-proposal-media-addoption" data-media-add-block="image_text">
              <i class="fas fa-table-columns"></i>
              <strong>Image and Text</strong>
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
      return `
        ${page.kicker ? `<div class="r-proposal-kicker">${escapeHtml(page.kicker)}</div>` : ''}
        <div class="r-proposal-cover-shell">
          <div class="r-proposal-cover-stage${page.coverImageEnabled === false ? ' is-hidden' : ''}" style="width:${coverWidth}px;max-width:100%;height:${page.coverImageEnabled === false ? 0 : coverHeight}px">
            ${isEdit ? `
              <div class="r-proposal-cover-toggle-anchor">
              <button type="button" class="r-proposal-media-btn r-proposal-cover-toggle" data-cover-toggle="true">${page.coverImageEnabled === false ? 'Show Cover Image' : 'Hide Cover Image'}</button>
              </div>
            ` : ''}
            <div class="r-proposal-cover-image${isEdit ? ' is-editable' : ''}${coverImages.length ? '' : ' is-empty'}" data-cover-pick="true" style="${page.coverImageEnabled === false ? 'display:none' : ''};width:${coverWidth}px;max-width:100%;height:${coverHeight}px">
              ${isEdit && coverImages.length === 1 && page.coverImageEnabled !== false ? `<button type="button" class="r-proposal-media-btn r-proposal-cover-editbtn" data-cover-adjust-toggle="true">${proposalCoverAdjustOpen ? 'Done' : 'Adjust'}</button>` : ''}
              ${isEdit && coverImages.length === 1 && page.coverImageEnabled !== false ? `
                <div class="r-proposal-cover-adjust${proposalCoverAdjustOpen ? ' visible' : ''}" id="rProposalCoverAdjust">
                  <label>Zoom<input type="range" min="1" max="3" step="0.02" value="${coverZoom}" data-cover-adjust="zoom"></label>
                </div>
              ` : ''}
              ${coverImages.length ? `
                <div class="r-proposal-cover-image-grid count-${Math.min(coverImages.length, 4)}">
                  ${coverImages.slice(0, 4).map((image, index) => `<img src="${escapeHtml(image.thumb || image.src)}" alt=""${index === 0 && coverImages.length === 1 ? ` style="object-position:center center;transform:translate(${coverPanX}px,${coverPanY}px) scale(${coverZoom})"` : ''}>`).join('')}
                </div>
              ` : (isEdit ? `<div class="r-proposal-cover-image-empty">+</div>` : '')}
              ${isEdit ? `<div class="r-proposal-cover-image-badge">${coverImages.length ? 'Edit Cover Photos' : 'Add Cover Photos'}</div>` : ''}
              ${isEdit ? `<div class="r-proposal-cover-widthgrab" data-cover-widthgrab="true"><i class="fas fa-grip-lines"></i></div><div class="r-proposal-cover-heightgrab" data-cover-heightgrab="true"><i class="fas fa-grip-lines"></i></div><div class="r-proposal-cover-cornergrab" data-cover-cornergrab="true"><i class="fas fa-up-right-and-down-left-from-center"></i></div>` : ''}
            </div>
          </div>
        </div>
        ${maybeEditable('h2', 'r-proposal-edit-heading', 'heading', page.heading || '')}
        <div class="r-proposal-meta">
          <div class="r-proposal-meta-card wide"><strong>Prepared For</strong>${maybeEditable('div', 'r-proposal-edit-meta multiline', 'preparedFor', page.preparedFor || '')}</div>
          <div class="r-proposal-meta-card"><strong>Prepared By</strong>${maybeEditable('div', 'r-proposal-edit-meta', 'preparedBy', page.preparedBy || '')}</div>
          <div class="r-proposal-meta-card"><strong>Date</strong>${maybeEditable('div', 'r-proposal-edit-meta', 'date', page.date || '')}</div>
        </div>
      `;
    }
    if (page.kind === 'scope') {
      const blocks = page.blocks || [];
      return `
        ${page.showIntro === false ? '' : `${maybeEditable('div', 'r-proposal-page-title', 'title', page.title || 'Image & Text')}
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
          emptyTitle: active?.title || 'Marketing Page',
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
        ${page.showIntro === false ? '' : maybeEditable('div', 'r-proposal-page-title', 'title', page.title || 'Image & Text')}
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
            <div class="r-proposal-payment-row">
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
        <div class="r-proposal-page-title">${escapeHtml(page.title || 'Authorization')}</div>
        ${maybeEditable('div', 'r-proposal-edit-paragraph r-proposal-signature-intro', 'summary', page.summary || '', { rich: true })}
        <div class="r-proposal-signature-stack">
          <div class="r-proposal-signature-grid">
            <div class="r-proposal-signature-left">
              <div class="r-proposal-signature-group">
                <div class="r-proposal-signature-box${isSigning ? ' is-signing' : ''}${customerSignature ? ' signed' : ''}" data-sign-slot="${isSigning ? 'customerSignature' : ''}" data-sign-signer="customer">
                  <strong>Customer Signature</strong>
                  <div class="r-proposal-signature-value">${customerSignature ? proposalRenderSignatureValue(customerSignature) : (isSigning ? `<button type="button" class="r-proposal-signature-tab">Tap to Sign</button>` : '')}</div>
                  <div class="r-proposal-signature-line"></div>
                  <div class="r-proposal-signature-autofill">${maybeEditable('div', 'r-proposal-edit-meta', 'customerPrintedNameValue', page.customerPrintedNameValue || 'Customer')}</div>
                </div>
              </div>
              ${page.requireCompanySignature === false ? '' : `
                <div class="r-proposal-signature-group">
                  <div class="r-proposal-signature-box${isSigning ? ' is-signing' : ''}${companySignature ? ' signed' : ''}" data-sign-slot="${isSigning ? 'companySignature' : ''}" data-sign-signer="company">
                    <strong>Company Representative</strong>
                    <div class="r-proposal-signature-value">${companySignature ? proposalRenderSignatureValue(companySignature) : (isSigning ? `<button type="button" class="r-proposal-signature-tab">Tap to Sign</button>` : '')}</div>
                    <div class="r-proposal-signature-line"></div>
                    <div class="r-proposal-signature-autofill">${maybeEditable('div', 'r-proposal-edit-meta', 'companyRepresentativeValue', page.companyRepresentativeValue || proposalPreparedByText())}</div>
                  </div>
                </div>
              `}
              ${page.showDate === false ? '' : `
                <div class="r-proposal-signature-group">
                  <div class="r-proposal-signature-box compact">
                    <strong>Date</strong>
                    <div class="r-proposal-signature-autofill">${maybeEditable('div', 'r-proposal-edit-meta', 'dateValue', page.dateValue || proposalTodayText())}</div>
                  </div>
                </div>
              `}
              ${isEdit ? `
                <div class="r-proposal-signature-options">
                <button type="button" class="r-proposal-signature-option" data-signature-option="require-company"><i class="fas ${page.requireCompanySignature === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.requireCompanySignature === false ? 'No company representative signature required' : 'Require company representative signature'}</button>
                  <button type="button" class="r-proposal-signature-option" data-signature-option="show-date"><i class="fas ${page.showDate === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.showDate === false ? 'Date hidden' : 'Show date'}</button>
                </div>
              ` : ''}
            </div>
            <div class="r-proposal-signature-right">
              <div class="r-proposal-financial-card">
                <div class="r-proposal-financial-head">
                  <strong>${escapeHtml(page.pricingSummaryTitle || 'Contract Amount')}</strong>
                </div>
                <div class="r-proposal-financial-rows">
                  <div class="r-proposal-financial-row"><span>Subtotal</span><span>${escapeHtml(page.subtotalValue || '$0.00')}</span></div>
                  ${page.showTax === false ? '' : `<div class="r-proposal-financial-row tax"><span>Sales Tax</span>${isEdit ? `<span class="r-proposal-tax-rate">${maybeEditable('div', 'r-proposal-edit-percent', 'taxRatePercent', page.taxRatePercent || '0', { type: 'number' })}<em>%</em></span>` : ''}<span>${escapeHtml(page.taxAmount || '$0.00')}</span></div>`}
                  <div class="r-proposal-financial-row total"><span>Total</span><span>${escapeHtml(page.totalValue || '$0.00')}</span></div>
                </div>
              </div>
              <div class="r-proposal-payment-card${isEdit && scheduleInvalid ? ' invalid' : ''}">
                <strong>${escapeHtml(page.paymentScheduleTitle || 'Payment Schedule')}</strong>
                ${paymentScheduleRows}
                ${isEdit && scheduleInvalid ? `<div class="r-proposal-payment-warning">Payment schedule is ${escapeHtml(scheduleTotal)}%. It must add up to 100%.</div>` : ''}
                ${isEdit ? `<div class="r-proposal-payment-options"><button type="button" class="r-proposal-signature-option" data-signature-option="show-tax"><i class="fas ${page.showTax === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.showTax === false ? 'No sales tax' : 'Show sales tax'}</button></div>` : ''}
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
        <div class="r-proposal-page-title">${escapeHtml(page.title || 'Terms and Conditions')}</div>
        <div class="r-proposal-fineprint">
          ${page.summary ? maybeEditable('div', 'r-proposal-edit-paragraph', 'summary', page.summary || '', { rich: true }) : ''}
          ${finePrintBodyMarkup}
          ${page.requireCustomerSignature === false ? `${isEdit ? `<button type="button" class="r-proposal-signature-option" data-fineprint-signature-toggle="true"><i class="fas fa-toggle-off"></i>No signature required</button>` : ''}` : `
          ${page.showSignature === false ? '' : `
            <div class="r-proposal-signature-box${isSigning ? ' is-signing' : ''}${customerSignature ? ' signed' : ''}" data-sign-slot="${isSigning ? 'customerSignature' : ''}" data-sign-signer="customer">
              <strong>Customer Signature</strong>
              ${isEdit ? `<button type="button" class="r-proposal-fineprint-toggle" data-fineprint-signature-toggle="true"><i class="fas ${page.requireCustomerSignature === false ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>${page.requireCustomerSignature === false ? 'No signature required' : 'Signature Required'}</button>` : ''}
              <div class="r-proposal-signature-value">${customerSignature ? proposalRenderSignatureValue(customerSignature) : (isSigning ? `<button type="button" class="r-proposal-signature-tab">Tap to Sign</button>` : '')}</div>
              <div class="r-proposal-signature-line"></div>
              <div class="r-proposal-signature-autofill">${maybeEditable('div', 'r-proposal-edit-meta', 'customerPrintedNameValue', page.customerPrintedNameValue || proposalCustomerPrimaryContact(proposals[activeProposalIndex]).name || 'Customer')}</div>
            </div>
          `}
          `}
        </div>
      `;
    }
    const lineItems = page.lineItems || [];
    return `
      <div class="r-proposal-page-title">${escapeHtml(page.title || 'Estimated Proposal')}</div>
      <div class="r-proposal-list">
        <div class="r-proposal-line-items">
          ${lineItems.map((item, index) => `
            <div class="r-proposal-line-item">
              ${isEdit ? `<button type="button" class="r-proposal-line-delete" data-proposal-delete-line-item="${item.__logicalLineItemIndex ?? index}" aria-label="Delete line item"><i class="fas fa-times"></i></button>` : ''}
              <div class="r-proposal-line-labelwrap">
                ${maybeEditable('div', 'r-proposal-line-label', `lineItems.${item.__logicalLineItemIndex ?? index}.label`, item.label || '')}
                ${item.unit || item.formula ? `<div class="r-proposal-line-meta">${escapeHtml(item.unit ? `${item.unit} item` : '')}${item.unit && item.autoDerived ? ' · ' : ''}${item.autoDerived ? 'measured' : ''}</div>` : ''}
              </div>
              <div class="r-proposal-row-value">${maybeEditable('div', 'r-proposal-edit-rowvalue', `lineItems.${item.__logicalLineItemIndex ?? index}.quantity`, item.quantity || '0', { type: 'number' })}</div>
              <div class="r-proposal-row-value">${maybeEditable('div', 'r-proposal-edit-rowvalue', `lineItems.${item.__logicalLineItemIndex ?? index}.unitPrice`, item.unitPrice || '$0.00', { type: 'currency' })}</div>
              <div class="r-proposal-row-value">${proposalEditableTag('div', 'r-proposal-edit-rowvalue', `lineItems.${item.__logicalLineItemIndex ?? index}.amount`, item.amount || '$0.00', { derived: true, preview: !isEdit })}</div>
            </div>
          `).join('')}
          ${isEdit && page.showAddRow !== false ? `<button type="button" class="r-proposal-addrow" data-proposal-add-line-item="true"><span><i class="fas fa-plus"></i> Add line item</span><span></span><span></span><span></span></button>` : ''}
        </div>
      </div>
      ${page.showTotal === false ? '' : `<div class="r-proposal-total${page.showTotal ? ' is-final-page-total' : ''}"><strong>Total</strong>${proposalEditableTag('div', 'r-proposal-edit-total', 'total', page.total || '$0.00', { derived: true, preview: !isEdit })}</div>`}
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

  function openProposalPhotoPicker(pageIndex, blockIndex, options = {}){
    closeProposalPhotoPicker();
    const mode = options.mode || 'block';
    const proposal = proposals[activeProposalIndex];
    const page = proposal?.pages?.[pageIndex];
    const existing = mode === 'cover'
      ? new Set(page?.coverImageIds || [])
      : new Set(page?.blocks?.[blockIndex]?.imageIds || []);
    if (window.Portal?.PhotoFeed?.openProjectMediaPicker) {
      proposalPhotoPicker = window.Portal.PhotoFeed.openProjectMediaPicker({
        id: 'proposal-photo-picker',
        title: mode === 'cover' ? 'Select Cover Photos' : 'Select Project Photos',
        subtitle: 'Choose images from this project or upload new ones.',
        photos: projectPhotos,
        getPhotos: () => projectPhotos,
        selectedIds: [...existing],
        multiple: true,
        imageOnly: true,
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
      return;
    }
    proposalPhotoPicker = { pageIndex, blockIndex, mode, selected: existing };
    const mount = document.createElement('div');
    mount.id = 'rProposalPhotoPicker';
    mount.className = 'r-proposal-media-pick';
    const selectedCount = () => proposalPhotoPicker?.selected?.size || 0;
    const render = () => {
      const imagePhotos = projectPhotos.filter(isImageMedia);
      const hasPhotos = !!imagePhotos.length;
      mount.innerHTML = `
        <div class="r-proposal-media-pick-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><strong>${mode === 'cover' ? 'Select Cover Photos' : 'Select Project Photos'}</strong><button type="button" class="r-proposal-media-btn" id="rProposalPhotoPickerClose">Close</button></div>
          ${hasPhotos ? `
            <div class="r-proposal-media-pick-grid">
              ${imagePhotos.map((photo, index) => {
                const photoId = projectPhotoId(photo, String(index));
                return `<button type="button" class="r-proposal-media-pick-thumb${proposalPhotoPicker.selected.has(photoId) ? ' selected' : ''}" data-proposal-pick-photo="${escapeHtml(photoId)}"><img src="${escapeHtml(photo.thumb || photo.src)}" alt=""></button>`;
              }).join('')}
            </div>
          ` : `
            <div class="r-photo-empty" id="rProposalPhotoDropZone" style="height:240px">
              <strong>No photos uploaded yet</strong>
              <div>This project does not have any image files yet.</div>
              <div class="r-photo-empty-tile" id="rProposalPhotoUploadEmpty">
                <div class="r-photo-empty-plus">+</div>
              </div>
            </div>
          `}
          <div class="r-proposal-media-pick-actions">
            <div><button type="button" class="r-proposal-media-btn" id="rProposalPhotoUploadInline">Upload Photo</button><input type="file" id="rProposalPhotoUploadInlineInput" accept="image/*" multiple style="display:none"></div>
            <button type="button" class="r-btn primary" id="rProposalPhotoPickerAdd"${hasPhotos ? '' : ' style="display:none"'}>${selectedCount() ? `Add ${selectedCount()} photo${selectedCount() === 1 ? '' : 's'}` : 'Add photo'}</button>
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
      showToast('Photo picker unavailable', 'The shared photo library is not loaded yet.', false);
      return;
    }
    proposalPhotoPicker = window.Portal.PhotoFeed.openProjectMediaPicker({
      id: 'proposal-cobrand-picker',
      title: 'Select Co-brand Logo',
      subtitle: 'Choose a company branding image or upload a reusable co-brand logo.',
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
          showToast('Logo not selected', 'That branding image could not be loaded. Try another logo or upload it again.', false);
          return false;
        }
        if (!(logo.src || logo.thumb)) {
          showToast('Logo unavailable', 'That branding image is missing a usable image file. Try another logo or upload it again.', false);
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
      createdAt: now.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }),
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
          title: 'Cover',
          kicker: '',
          heading: address || 'New Project',
          preparedFor: proposalPreparedForText(contacts),
          preparedBy: proposalPreparedByText(),
          date: now.toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' }),
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
          title: 'Image & Text',
          kicker: 'Image & Text',
          blocks: [defaultImageTextBlock()],
        },
        {
          id: createProposalPageId(),
          kind: 'pricing',
          title: 'Estimated Proposal',
          kicker: 'Pricing',
          lineItems: [],
          notes: notes || 'Included',
          total: proposalCurrencyDisplay(0),
        },
        {
          id: createProposalPageId(),
          kind: 'signature',
          title: 'Authorization',
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
          title: 'Terms and Conditions',
          kicker: 'Fine Print',
          summary: '',
          body: 'Owner authorizes the contractor to perform the work described in this proposal and to furnish the required labor and materials. Any concealed deck repairs, permit fees, or code-required upgrades discovered after work begins will be documented and approved before additional charges are incurred. Final payment is due according to the agreed schedule once the contracted scope is substantially complete.',
          requireCustomerSignature: true,
          customerSignatureLabel: 'Customer Signature',
          signedSlots: {},
        }
      ]
    };
    proposal.pages[2].lineItems = seedProposalPricingFromPricebook(proposal);
    recomputeProposalPricing(proposal.pages[2], proposal);
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
    return page;
  }

  function normalizeProposalRecord(proposal, index = 0){
    if (!proposal || typeof proposal !== 'object') return proposal;
    proposalStableId(proposal, index);
    proposal.status = ['draft', 'sent', 'viewed', 'signed', 'archived', 'void', 'discarded'].includes(String(proposal.status || '').toLowerCase())
      ? String(proposal.status).toLowerCase()
      : 'draft';
    const currentTitle = String(proposal.title || '').trim();
    const addressTitle = String(proposal.address || activeBaseProject?.address || $('#rAddress')?.value || '').trim();
    if (!currentTitle || (addressTitle && currentTitle === addressTitle)) proposal.title = proposalDefaultTitle(index);
    proposal.createdAt = proposal.createdAt || proposal.created_at || new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    proposal.created_at = proposal.created_at || new Date().toISOString();
    proposal.fontFamily = getProposalFontFamily(proposal);
    proposal.font_family = proposal.fontFamily;
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
      branch_id: proposalBranchId(),
      contacts: proposalContacts(),
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
      <button type="button" data-proposal-error-close aria-label="Dismiss" style="width:32px;height:32px;border-radius:12px;border:1px solid rgba(0,0,0,.08);background:#fff;color:#475467;cursor:pointer;flex:0 0 auto"><i class="fas fa-times"></i></button>
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
      if (saved && !silent) showToast('Proposal saved', proposalDisplayName(saved, index), true);
      return saved;
    })();
    proposalSaveInFlight.set(key, { promise, startVersion });
    try {
      return await promise;
    } catch (error) {
      console.warn('Proposal save failed', error);
      if (proposalsApiRouteMissing(error)) {
        await saveProposalEmbeddedFallback(index);
        if (!silent) showToast('Proposal API unavailable', 'The proposals backend route is not mounted on the running server. Saved this draft on the project for now.', false);
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
    const response = await window.ProposalsAPI.proposals.send(orgId, backendId, {
      expected_revision: Number(current.revision || saved?.revision || 0) || undefined,
      recipients: selectedProposalRecipients(),
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
    return { proposal: next, response };
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
    if (proposalHasCustomerSignature(proposal)) return 'signed';
    if (proposalHasView(proposal)) return 'viewed';
    return 'unviewed';
  }

  function proposalDeliveryLabel(status){
    const value = String(status || '').toLowerCase();
    if (value === 'signed') return 'Signed';
    if (value === 'viewed') return 'Viewed';
    return 'Unviewed';
  }

  function proposalContactKey(contact = {}, index = 0){
    return contact.email || contact.phone || contact.name || `contact_${index}`;
  }

  function proposalContactLabel(contact = {}){
    return [contact.name, contact.email, contact.phone].filter(Boolean).join(' - ') || 'Customer';
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
      .filter((contact) => contact.name || contact.email || contact.phone || contact.id);
  }

  function selectedProposalIdsForSend(){
    normalizeProposalCollection();
    const ids = [...proposalSendSelectedIds].filter((id) => proposals.some((proposal, index) => proposalStableId(proposal, index) === id));
    if (ids.length) return ids.slice(0, 1);
    const fallbackId = proposalStableId(proposals[activeProposalIndex], activeProposalIndex);
    return fallbackId ? [fallbackId] : [];
  }

  function enterProposalListMode(index = activeProposalIndex){
    normalizeProposalCollection();
    clearProposalSettingsPanel();
    proposalWorkspaceMode = 'list';
    proposalEditorMode = 'preview';
    proposalMarkupMode = false;
    proposalMarkupDockOpen = false;
    proposalMarkupPopover = null;
    proposalSigningMode = false;
    proposalSigningSession = null;
    proposalDeleteConfirmProposalId = null;
    activeProposalIndex = proposals.length ? Math.max(0, Math.min(index, proposals.length - 1)) : 0;
    renderProposalSection();
    renderProposalPreview();
    bindProposalMarkupToggle();
  }

  function enterProposalEditMode(index = activeProposalIndex){
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
    activeProposalIndex = Math.max(0, Math.min(index, proposals.length - 1));
    activeProposalPageIndex = 0;
    normalizeActiveProposalPage(proposals[activeProposalIndex]);
    renderProposalSection();
    renderProposalPreview();
    syncProjectNotesPlacement();
    bindProposalModeToggle();
    bindProposalMarkupToggle();
  }

  function enterProposalSendMode(origin = 'list', ids = null){
    normalizeProposalCollection();
    if (!proposals.length) return;
    clearProposalSettingsPanel();
    proposalWorkspaceMode = 'send';
    proposalSendOrigin = origin || 'list';
    proposalEditorMode = 'preview';
    proposalMarkupMode = false;
    proposalMarkupDockOpen = false;
    proposalMarkupPopover = null;
    const fallbackId = proposalStableId(proposals[activeProposalIndex], activeProposalIndex);
    proposalSendSelectedIds = new Set([(ids && ids.length ? ids[0] : fallbackId)].filter(Boolean));
    if (!proposalSendMessage) {
      const primary = primaryContact();
      proposalSendMessage = `Hi ${primary.name || 'there'},\n\nHere is your proposal for review.`;
    }
    const proposalDefaults = getBranchPresentationStyle().proposal_defaults || {};
    proposalSendIncludePdf = proposalDefaults.send_include_pdf !== false;
    proposalSendIncludePortal = customerPortalEnabled() && proposalDefaults.send_include_portal !== false;
    if (!proposalSendContactKeys.size) {
      proposalSendContactKeys = new Set(collectContacts().map(proposalContactKey).filter(Boolean));
    }
    renderProposalSection();
    renderProposalPreview();
    syncProjectNotesPlacement();
    bindProposalMarkupToggle();
  }

  function createNewProposalAndEdit(){
    ensureProposalOnlyBaseProject();
    const proposal = normalizeProposalRecord(createProposalFromFormAndTrack('proposal_list_create'), proposals.length);
    activeProposalIndex = proposals.findIndex((item) => item === proposal);
    if (activeProposalIndex < 0) activeProposalIndex = proposals.length - 1;
    activeProposalPageIndex = 0;
    enterProposalEditMode(activeProposalIndex);
    queueAutosaveNotice();
    saveProposalToBackend(activeProposalIndex, { silent: true }).catch((error) => console.warn('Initial proposal save failed', error));
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
    clone.createdAt = new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    clone.created_at = new Date().toISOString();
    delete clone.sent_at;
    proposals = [...proposals.slice(0, index + 1), normalizeProposalRecord(clone, index + 1), ...proposals.slice(index + 1)];
    activeProposalIndex = index + 1;
    proposalDeleteConfirmProposalId = null;
    renderProposalSection();
    renderProposalPreview();
    queueAutosaveNotice();
    showToast('Proposal duplicated', proposalDisplayName(clone, activeProposalIndex), true);
  }

  function removeProposal(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    const proposalId = proposalStableId(proposal, index);
    if (proposalDeleteConfirmProposalId !== proposalId) {
      proposalDeleteConfirmProposalId = proposalId;
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
    activeProposalIndex = Math.max(0, Math.min(index, proposals.length - 1));
    if (!proposals.length) proposalWorkspaceMode = 'list';
    renderProposalSection();
    renderProposalPreview();
    queueAutosaveNotice();
    showToast('Proposal deleted', 'The proposal was removed from this project.', true);
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
      (Array.isArray(page.lineItems) ? page.lineItems : []).forEach((item) => {
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
      contentLines.push('56 740 Td');
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
      const pageRef = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`);
      pageRefs.push(pageRef);
    });
    const createdAt = new Date();
    const padDatePart = (value) => String(value).padStart(2, '0');
    const pdfDate = `D:${createdAt.getUTCFullYear()}${padDatePart(createdAt.getUTCMonth() + 1)}${padDatePart(createdAt.getUTCDate())}${padDatePart(createdAt.getUTCHours())}${padDatePart(createdAt.getUTCMinutes())}${padDatePart(createdAt.getUTCSeconds())}+00'00'`;
    const infoRef = addObject(`<< /Title (${pdfEscape(title)}) /Author (FirstMate) /Creator (FirstMate) /Producer (FirstMate) /Subject (Proposal generated by FirstMate) /Keywords (FirstMate, proposal) /CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>`);
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
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${xref}\n%%EOF`;
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
    const renderSections = proposalRenderSections(proposal);
    const measurementInsertAvailable = includeInsertControls && proposalMeasurementInsertAssets().length > 0;
    if (!renderSections.length) {
      return `<div class="r-proposal-empty"><i class="fas fa-eye-slash"></i>All proposal pages are hidden. Re-enable a page from the left column to show it here.</div>`;
    }
    return renderSections.map((entry, overallIndex) => {
      const fullPageInsert = proposalIsFullPageInsert(entry.page);
      return `
      <div class="r-proposal-page-stack${includeInsertControls && proposalInsertIndex === entry.logicalIndex ? ' insert-after' : ''}" data-proposal-stack-index="${overallIndex}">
        <section class="r-proposal-page theme-${proposal.theme || 'margin'}${fullPageInsert ? ' is-full-replacement' : ''}${options.activePages !== false && entry.logicalIndex === activeProposalPageIndex ? ' is-active' : ''}${overallIndex === 0 ? ' is-cover' : ' is-inner'}" data-proposal-page-index="${entry.logicalIndex}" style="${proposal.theme === 'triangles' && overallIndex !== 0 && !fullPageInsert ? proposalTriangleHeaderVars(entry.page) : ''}">
          ${fullPageInsert ? '' : '<div class="r-proposal-page-shape-top"></div>'}
          ${!fullPageInsert && proposal.theme === 'margin' && overallIndex === 0 ? `<div class="r-proposal-margin-logo">${proposalBrandLockup('margin', viewMode)}</div>` : ''}
          ${!fullPageInsert && proposal.theme === 'triangles' && overallIndex === 0 ? `<div class="r-proposal-triangle-logo">${proposalBrandLockup('triangles', viewMode, true)}</div>` : ''}
          ${fullPageInsert ? '' : `<div class="r-proposal-page-header">
            ${proposalBrandLockup('clean', viewMode)}
            <div class="r-proposal-page-number">${overallIndex === 0 ? '' : String(overallIndex + 1).padStart(2, '0')}</div>
          </div>`}
          <div class="r-proposal-page-content">
            ${proposalPageMarkup(entry.page, viewMode)}
          </div>
          ${proposalMarkupHtml(proposal, entry.page)}
        </section>
        ${includeInsertControls ? `
          <div class="r-proposal-page-insert${proposalInsertIndex === entry.logicalIndex ? ' active' : ''}" data-mode="${viewMode}" data-insert-index="${entry.logicalIndex}">
            <button type="button" class="r-proposal-page-insert-btn" aria-label="Add page"><i class="fas fa-plus"></i></button>
            <div class="r-proposal-page-insert-picker">
              <div class="r-proposal-page-insert-rail">
                <button type="button" class="r-proposal-page-option" data-page-template="cover"><div class="r-proposal-page-option-mini"></div><strong>Cover</strong><span>Section intro</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="image_text"><div class="r-proposal-page-option-mini"></div><strong>Image & Text</strong><span>Custom page</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="pricing"><div class="r-proposal-page-option-mini"></div><strong>Pricing</strong><span>Line items</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="marketing"><div class="r-proposal-page-option-mini"></div><strong>Marketing</strong><span>Brochure insert</span></button>
                ${measurementInsertAvailable ? '<button type="button" class="r-proposal-page-option" data-page-template="measurement_insert"><div class="r-proposal-page-option-mini"></div><strong>FirstMeasure</strong><span>Measurements</span></button>' : ''}
                <button type="button" class="r-proposal-page-option" data-page-template="signature"><div class="r-proposal-page-option-mini"></div><strong>Signature</strong><span>Approval page</span></button>
                <button type="button" class="r-proposal-page-option" data-page-template="fine_print"><div class="r-proposal-page-option-mini"></div><strong>Fine Print</strong><span>Terms and signature</span></button>
              </div>
              <button type="button" class="r-proposal-page-insert-close" aria-label="Cancel add page"><i class="fas fa-times"></i></button>
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
    const title = escapeHtml(proposalDisplayName(proposal, index));
    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>${title}</title>
          <style>
            ${proposalBaseStylesheetText()}
            @page{size:8.5in 11in;margin:0}
            html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
            body{width:8.5in}
            .r-proposal-pdf-doc{--primary:${primaryColor};--primary-readable:${primaryColor};--primary-rgb:${hexToRgbString(primaryColor)};--accent:${accentColor};--accent-readable:${accentReadable};--accent-rgb:${hexToRgbString(accentReadable)};--accent-soft:${accentColor}66;--proposal-font-family:${proposalFontStack(fontFamily)};background:#fff;color:#111827}
            .r-proposal-pdf-doc .r-proposal-wrap{height:auto;min-height:0;overflow:visible;background:#fff;padding:0}
            .r-proposal-pdf-doc .r-proposal-pages{gap:0;padding:0;align-items:center;background:#fff}
            .r-proposal-pdf-doc .r-proposal-page-stack{width:8.5in;height:11in;margin:0;break-after:page;page-break-after:always;display:flex;justify-content:center;transform:none!important}
            .r-proposal-pdf-doc .r-proposal-page-stack:last-child{break-after:auto;page-break-after:auto}
            .r-proposal-pdf-doc .r-proposal-page{width:8.5in;height:11in;min-height:0;max-height:11in;max-width:none;aspect-ratio:auto;overflow:hidden;border:0;box-shadow:none;box-sizing:border-box}
            .r-proposal-pdf-doc .r-proposal-page.is-active{box-shadow:none}
            .r-proposal-pdf-doc :is(button,.r-proposal-page-insert,.r-proposal-media-btn,.r-proposal-cover-widthgrab,.r-proposal-cover-heightgrab,.r-proposal-cover-cornergrab,.r-proposal-line-delete,.r-proposal-page-markup-delete,.r-proposal-page-markup-handle,.r-proposal-signature-option,.r-proposal-payment-options,.r-proposal-marketing-select,.r-proposal-full-select){display:none!important}
            .r-proposal-pdf-doc [contenteditable="true"]{outline:0!important}
          </style>
        </head>
        <body>
          <main class="r-proposal-pdf-doc">
            <div class="r-proposal-wrap">
              <div class="r-proposal-pages">
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
      title: proposalDisplayName(proposal, index),
      html: proposalPdfDocumentHtml(proposal, index)
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

  function proposalPrintHtml(proposal, index = 0){
    return proposalPdfDocumentHtml(proposal, index);
  }

  function printProposal(index){
    normalizeProposalCollection();
    const proposal = proposals[index];
    if (!proposal) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('Popup blocked', 'Allow popups to print this proposal.', false);
      return;
    }
    printWindow.document.open();
    printWindow.document.write(proposalPrintHtml(proposal, index));
    printWindow.document.close();
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (error) {
        console.warn('Unable to print proposal', error);
      }
    }, 350);
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
          showToast('PDF downloaded', 'The generated proposal PDF was downloaded.', true);
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
        showToast('PDF downloaded', 'The proposals API route is not mounted, so a local PDF was downloaded instead.', false);
        return;
      }
      if (!backendError) {
        const fallbackProposal = proposals[index] || proposal;
        await saveProposalEmbeddedFallback(index);
        downloadProposalBlob(proposalLocalPdfBlob(fallbackProposal, index), fallbackProposal, index);
        showToast('PDF downloaded', 'A local PDF was downloaded because the backend PDF URL was unavailable.', false);
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
      ? `<img src="${escapeHtml(state.drawDataUrl)}" alt="Signature preview">`
      : `<div class="r-signature-preview-text ${escapeHtml(state.adoptStyle || 'style-classic')}">${escapeHtml(state.adoptName || proposalSignatureTemplateName(proposals[activeProposalIndex], state.signer))}</div>`;
    mount.innerHTML = `
      <div class="r-signature-modal-card">
        <div class="r-signature-modal-top">
          <div>
            <h3 class="r-signature-modal-title">Choose Your Signature</h3>
            <p class="r-signature-modal-sub">Create a signature for ${escapeHtml(state.signer === 'company' ? 'the company representative' : 'the customer')} and place it where required.</p>
          </div>
          <button type="button" class="r-signature-modal-close" id="rSignatureModalClose"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-signature-modal-body">
          <div class="r-signature-modal-main">
            <div class="r-signature-mode-row">
              <button type="button" class="r-signature-mode-btn${state.mode === 'adopt' ? ' active' : ''}" data-signature-mode="adopt"><i class="fas fa-signature"></i> Adopt</button>
              <button type="button" class="r-signature-mode-btn${state.mode === 'draw' ? ' active' : ''}" data-signature-mode="draw"><i class="fas fa-pen-fancy"></i> Draw</button>
            </div>
            ${state.mode === 'adopt' ? `
              <input type="text" class="r-signature-adopt-name" id="rSignatureAdoptName" value="${escapeHtml(state.adoptName || '')}" placeholder="Type the signer name">
              <div class="r-signature-style-grid">
                <button type="button" class="r-signature-style-btn${state.adoptStyle === 'style-classic' ? ' active' : ''}" data-signature-style="style-classic"><div class="r-signature-style-sample style-classic">${escapeHtml(state.adoptName || 'Signature')}</div></button>
                <button type="button" class="r-signature-style-btn${state.adoptStyle === 'style-elegant' ? ' active' : ''}" data-signature-style="style-elegant"><div class="r-signature-style-sample style-elegant">${escapeHtml(state.adoptName || 'Signature')}</div></button>
                <button type="button" class="r-signature-style-btn${state.adoptStyle === 'style-modern' ? ' active' : ''}" data-signature-style="style-modern"><div class="r-signature-style-sample style-modern">${escapeHtml(state.adoptName || 'Signature')}</div></button>
              </div>
            ` : `
              <div class="r-signature-draw-wrap">
                <div class="r-signature-draw-pad" id="rSignatureDrawPad">
                  <div class="r-signature-draw-hint">Draw your signature here</div>
                  <canvas id="rSignatureDrawCanvas"></canvas>
                </div>
                <div><button type="button" class="r-signature-secondary" id="rSignatureClear">Clear</button></div>
              </div>
            `}
          </div>
          <div class="r-signature-side">
            <div>
              <strong style="display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#667085">Preview</strong>
              <div class="r-signature-preview-box">${previewHtml}</div>
            </div>
            <div class="r-signature-modal-actions">
              <button type="button" class="r-signature-secondary" id="rSignatureCancel">Cancel</button>
              <button type="button" class="r-signature-apply" id="rSignatureApply">Use Signature</button>
            </div>
          </div>
        </div>
      </div>
    `;
    const syncSignaturePreview = () => {
      const preview = mount.querySelector('.r-signature-preview-box');
      if (!preview) return;
      if (proposalSignatureModalState?.mode === 'draw' && proposalSignatureModalState.drawDataUrl) {
        preview.innerHTML = `<img src="${escapeHtml(proposalSignatureModalState.drawDataUrl)}" alt="Signature preview">`;
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
        <strong>Pricebook Items</strong>
        <button type="button" class="r-proposal-pricebook-btn" data-open-pricebook-inline="true"><i class="fas fa-book"></i> Edit</button>
      </div>
      <div class="r-pricebook-suggest-list">
        ${suggestions.map((item) => `<button type="button" class="r-pricebook-suggest-item" data-pricebook-item="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.formula)} · $${Number(item.unitPrice || 0).toFixed(2)} / ${escapeHtml(item.unit)}</span></button>`).join('')}
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

  function renderProposalListSection(section, label, list){
    normalizeProposalCollection();
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    section.classList.toggle('visible', visible);
    section.classList.remove('mode-list', 'mode-edit', 'mode-send');
    section.classList.add('mode-list');
    if (label) label.hidden = visible;
    list.innerHTML = `
      <div class="r-proposal-workspace-head">
        <div>
          <strong>Proposals</strong>
          <span>${proposals.length ? `${proposals.length} saved for this project` : 'Create proposal variants for this project'}</span>
        </div>
        <button type="button" class="r-proposal-settings-link" id="rProposalSettingsOpen"><i class="fas fa-gear"></i> Settings</button>
      </div>
      <button type="button" class="r-proposal-add-card" id="rProposalCreateNew">
        <i class="fas fa-plus"></i>
        <span>Create New Proposal</span>
      </button>
      <div class="r-proposal-list-view">
        ${proposals.length ? proposals.map((proposal, index) => {
          const id = proposalStableId(proposal, index);
          const isActive = index === activeProposalIndex;
          const deliveryStatus = proposalDeliveryStatus(proposal);
          const sent = ['sent', 'viewed', 'signed'].includes(String(proposal.status || '').toLowerCase());
          const locked = proposalDeliveryStatus(proposal) === 'signed' || String(proposal.status || '').toLowerCase() === 'signed' || proposal.editable === false || proposal.locked === true;
          return `
            <div class="r-proposal-list-card${isActive ? ' active' : ''}" data-proposal-select="${index}" role="button" tabindex="0">
              <div class="r-proposal-list-main">
                <strong>${escapeHtml(proposalDisplayName(proposal, index))}</strong>
                <span>${escapeHtml(proposal.createdAt || proposal.created_at || 'Draft')}</span>
              </div>
              <div class="r-proposal-list-side">
                <div class="r-proposal-status-row">
                  ${sent ? `<span class="r-proposal-status-badge r-proposal-delivery-badge ${escapeHtml(deliveryStatus)}">${escapeHtml(proposalDeliveryLabel(deliveryStatus))}</span>` : ''}
                  <span class="r-proposal-status-badge ${escapeHtml(proposal.status || 'draft')}">${escapeHtml(proposalStatusLabel(proposal.status))}</span>
                </div>
                <div class="r-proposal-list-actions">
                  <button type="button" ${locked ? 'disabled' : `data-proposal-edit="${index}"`} data-fm-tooltip="${locked ? 'Signed proposals require a change order' : 'Edit'}"><i class="fas fa-pen"></i></button>
                  <button type="button" data-proposal-download="${index}" data-fm-tooltip="Download PDF"><i class="fas fa-download"></i></button>
                  <button type="button" data-proposal-print="${index}" data-fm-tooltip="Print"><i class="fas fa-print"></i></button>
                  <button type="button" data-proposal-copy="${index}" data-fm-tooltip="Duplicate"><i class="fas fa-copy"></i></button>
                  <button type="button" ${locked ? 'disabled' : `data-proposal-send="${index}"`} data-fm-tooltip="${locked ? 'Signed proposals require a change order' : 'Send'}"><i class="fas fa-paper-plane"></i></button>
                  <button type="button" class="${proposalDeleteConfirmProposalId === id ? 'confirm' : ''}" data-proposal-delete="${index}" data-fm-tooltip="${proposalDeleteConfirmProposalId === id ? 'Confirm delete' : 'Delete'}">${proposalDeleteConfirmProposalId === id ? 'Delete' : '<i class="fas fa-trash"></i>'}</button>
                </div>
              </div>
            </div>
          `;
        }).join('') : `
          <div class="r-proposal-empty-list">
            <i class="fas fa-file-signature"></i>
            <strong>No proposals yet</strong>
            <span>Create the first draft, then duplicate it when you want variants.</span>
          </div>
        `}
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
        proposalDeleteConfirmProposalId = null;
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
        enterProposalSendMode('list', [proposalStableId(proposals[index], index)]);
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

  function renderProposalSendSection(section, label, list){
    normalizeProposalCollection();
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    if (label) label.hidden = visible;
    section.classList.toggle('visible', visible);
    section.classList.remove('mode-list', 'mode-edit', 'mode-send');
    section.classList.add('mode-send');
    if (label) label.textContent = 'Send Proposal';
    const contacts = collectContacts();
    const selectedIds = new Set(selectedProposalIdsForSend());
    list.innerHTML = `
      <div class="r-proposal-workspace-head">
        <button type="button" class="r-proposal-back" id="rProposalSendBack" aria-label="Back"><i class="fas fa-arrow-left"></i></button>
        <div>
          <strong>Send Proposal</strong>
          <span>Confirm the selected proposal, contacts, and delivery options</span>
        </div>
      </div>
      <div class="r-proposal-send-form">
        <div class="r-proposal-send-block">
          <strong>Selected Proposal</strong>
          <div class="r-proposal-send-list">
            ${(() => {
              const id = [...selectedIds][0] || proposalStableId(proposals[activeProposalIndex], activeProposalIndex);
              const index = proposals.findIndex((proposal, proposalIndex) => proposalStableId(proposal, proposalIndex) === id);
              const proposal = proposals[index >= 0 ? index : activeProposalIndex] || {};
              return `
                <div class="r-proposal-send-check selected">
                  <span>${escapeHtml(proposalDisplayName(proposal, index >= 0 ? index : activeProposalIndex))}</span>
                  <em>${escapeHtml(proposalStatusLabel(proposal.status))}</em>
                </div>
              `;
            })()}
          </div>
        </div>
        <div class="r-proposal-send-block">
          <strong>Recipients</strong>
          <div class="r-proposal-send-list">
            ${contacts.length ? contacts.map((contact, index) => {
              const key = proposalContactKey(contact, index);
              return `
                <label class="r-proposal-send-check">
                  <input type="checkbox" data-send-contact-key="${escapeHtml(key)}" ${proposalSendContactKeys.has(key) ? 'checked' : ''}>
                  <span>${escapeHtml(proposalContactLabel(contact))}</span>
                </label>
              `;
            }).join('') : '<div class="r-proposal-send-empty">No customer contacts are on this project yet.</div>'}
          </div>
        </div>
        <label class="r-proposal-send-message">
          <span>Message</span>
          <textarea class="r-inp" id="rProposalSendMessage" rows="6">${escapeHtml(proposalSendMessage)}</textarea>
        </label>
        <div class="r-proposal-send-options">
          <label><input type="checkbox" id="rProposalSendPdf" ${proposalSendIncludePdf ? 'checked' : ''}> Include PDF attachment</label>
          ${customerPortalEnabled() ? `<label><input type="checkbox" id="rProposalSendPortal" ${proposalSendIncludePortal ? 'checked' : ''}> Include customer portal link</label>` : ''}
        </div>
        <button type="button" class="r-proposal-send-submit" id="rProposalSendSubmit"><i class="fas fa-paper-plane"></i> Send Proposal</button>
      </div>
    `;
    const returnFromSend = () => {
      if (proposalSendOrigin === 'edit') enterProposalEditMode(activeProposalIndex);
      else enterProposalListMode(activeProposalIndex);
    };
    list.querySelector('#rProposalSendBack')?.addEventListener('click', returnFromSend);
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
      proposalSendIncludePdf = !!event.target.checked;
    });
    list.querySelector('#rProposalSendPortal')?.addEventListener('change', (event) => {
      proposalSendIncludePortal = !!event.target.checked;
    });
    list.querySelector('#rProposalSendSubmit')?.addEventListener('click', async () => {
      const ids = selectedProposalIdsForSend();
      if (!ids.length) {
        showToast('Choose a proposal', 'Select at least one proposal to send.', false);
        return;
      }
      if (contacts.length && !proposalSendContactKeys.size) {
        showToast('Choose a recipient', 'Select at least one customer contact.', false);
        return;
      }
      const id = ids[0];
      const index = proposals.findIndex((proposal, proposalIndex) => proposalStableId(proposal, proposalIndex) === id);
      if (index < 0) {
        showToast('Choose a proposal', 'The selected proposal could not be found.', false);
        return;
      }
      const submit = list.querySelector('#rProposalSendSubmit');
      const priorHtml = submit?.innerHTML || '';
      if (submit) {
        submit.disabled = true;
        submit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
      }
      try {
        const { proposal } = await sendProposalToBackend(index, {
          include_pdf: proposalSendIncludePdf,
          include_portal: customerPortalEnabled() && proposalSendIncludePortal,
          message: proposalSendMessage
        });
        trackRequestActivity({
          type: 'proposal_sent',
          summary: 'Sent a proposal',
          target: {
            project_id: activeBaseProject?.id || '',
            project_title: activeBaseProject?.title || proposal.title || proposal.address || '',
            project_address: activeBaseProject?.address || proposal.address || '',
            proposal_id: id
          },
          metadata: {
            proposal_id: id,
            include_pdf: proposalSendIncludePdf,
            include_portal_link: customerPortalEnabled() && proposalSendIncludePortal,
            recipients: [...proposalSendContactKeys],
            message: proposalSendMessage
          }
        });
        queueAutosaveNotice();
        showToast('Proposal sent', `${proposalDisplayName(proposal, index)} is ready in the customer portal.`, true);
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

  function renderProposalSectionCore(){
    const section = $('#rProposalSection');
    const label = $('#rProposalLabel');
    const list = $('#rProposalList');
    if (!section || !list) return;
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
    if (proposalWorkspaceMode === 'list') {
      renderProposalListSection(section, label, list);
      syncProposalWorkspaceChrome();
      return;
    }
    if (proposalWorkspaceMode === 'send') {
      renderProposalSendSection(section, label, list);
      syncProposalWorkspaceChrome();
      return;
    }
    const visible = proposalsEnabled() && proposalWorkspaceOpen && activePreviewTab === 'proposal';
    section.classList.toggle('visible', visible);
    section.classList.remove('mode-list', 'mode-edit', 'mode-send');
    section.classList.add('mode-edit');
    if (label) label.textContent = 'Proposals';
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
    list.innerHTML = `
      <div class="r-proposal-workspace-head">
        <button type="button" class="r-proposal-back" id="rProposalBackToList" aria-label="Back to proposals"><i class="fas fa-arrow-left"></i></button>
        <input class="r-proposal-workspace-title" id="rProposalTitleInput" value="${escapeHtml(proposalDisplayName(proposal, activeProposalIndex))}" aria-label="Proposal name">
      </div>
      <div class="r-proposal-settings">
        <div class="r-proposal-settings-head">
          <strong>Templates</strong>
          <span>${proposalTemplateCount} available</span>
        </div>
        <div class="r-proposal-template-row">
          ${proposalTemplates.map((template) => `
            <button type="button" class="r-proposal-template-card" data-proposal-template="${escapeHtml(template.id)}">
              <strong>${escapeHtml(template.name)}</strong>
              <span>${escapeHtml(template.description || PROPOSAL_THEMES[template.theme]?.label || 'Proposal template')}</span>
            </button>
          `).join('')}
        </div>
        <div class="r-proposal-template-actions">
          <button type="button" class="r-proposal-template-action" id="rProposalTemplateMore"><i class="fas fa-layer-group"></i> More</button>
          <button type="button" class="r-proposal-template-action" id="rProposalTemplateCreate"><i class="fas fa-plus"></i> Create</button>
        </div>
      </div>
      <div class="r-proposal-settings style-section">
        <div class="r-proposal-settings-head">
          <strong>Styles</strong>
        </div>
        <div class="r-proposal-style-row">
          ${Object.keys(PROPOSAL_THEMES).map((theme) => `
            <button type="button" class="r-proposal-style-btn${proposal.theme === theme ? ' active' : ''}" data-proposal-theme="${theme}" data-fm-tooltip="${PROPOSAL_THEMES[theme].label}">
              ${proposalStylePreview(theme)}
            </button>
          `).join('')}
        </div>
        <div class="r-proposal-color-row">
          <label class="r-proposal-color-field">
            <span>Primary</span>
            <input type="color" data-proposal-color="primary" value="${escapeHtml(primaryColor)}">
          </label>
          <label class="r-proposal-color-field">
            <span>Secondary</span>
            <input type="color" data-proposal-color="secondary" value="${escapeHtml(accentColor)}">
          </label>
        </div>
        <label class="r-proposal-font-field">
          <span>Font</span>
          <select data-proposal-font>
            ${PROPOSAL_FONT_OPTIONS.map((font) => `<option value="${escapeHtml(font)}" ${getProposalFontFamily(proposal) === font ? 'selected' : ''}>${escapeHtml(font)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="r-proposal-pages-list">
        ${proposal.pages.map((page, index) => `
          ${index > 0 ? `<div class="r-proposal-list-insert"><button type="button" class="r-proposal-list-insert-btn" data-list-insert-index="${index - 1}" aria-label="Add page"><i class="fas fa-plus"></i></button></div>` : ''}
          <div class="r-proposal-page-item${index === activeProposalPageIndex ? ' active' : ''}${proposalPageEnabled(page) ? '' : ' disabled'}" data-page-index="${index}" draggable="true" role="button" tabindex="0">
            <div class="r-proposal-page-chip">${index + 1}</div>
            <div class="r-proposal-page-copy">
              <strong>${escapeHtml(page.title || `Page ${index + 1}`)}</strong>
              <span>${escapeHtml(proposalPageSubtitle(page))}${proposalSectionPageCount(page) > 1 ? ` • ${proposalSectionPageCount(page)} pages` : ''}</span>
            </div>
            <div class="r-proposal-page-actions">
              ${proposalSectionPageCount(page) > 1 ? `<span class="r-proposal-page-count">${proposalSectionPageCount(page)}</span>` : ''}
              <button type="button" class="r-proposal-page-enable${proposalPageEnabled(page) ? '' : ' off'}" data-page-enabled-toggle="${index}" aria-label="${proposalPageEnabled(page) ? 'Hide page' : 'Show page'}" aria-pressed="${proposalPageEnabled(page) ? 'true' : 'false'}"><i class="fas fa-check"></i></button>
              ${proposal.pages.length > 1 ? (
                proposalDeleteConfirmPageId === page.id
                  ? `<button type="button" class="r-proposal-page-delete confirm" data-page-delete-confirm="${escapeHtml(page.id)}">Delete</button>`
                  : `<button type="button" class="r-proposal-page-delete" data-page-delete-arm="${escapeHtml(page.id)}" aria-label="Delete page"><i class="fas fa-trash"></i></button>`
              ) : ''}
              <div class="r-proposal-drag"><i class="fas fa-grip-vertical"></i></div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="r-proposal-measurements${proposalMeasurementsExpanded ? ' expanded' : ''}">
        <button type="button" class="r-proposal-measure-toggle" id="rProposalMeasureToggle">
          <span class="r-proposal-measure-title">
            <strong>Measurements</strong>
            <span class="r-proposal-measure-status${measurementsReady ? '' : ' needed'}">${escapeHtml(measurementStatus)}</span>
          </span>
          <i class="fas fa-chevron-down"></i>
        </button>
        <div class="r-proposal-measure-details">
          <div class="r-proposal-measure-strip">
            <strong>Squares</strong>
            <span>${measurements.roofSquares.toFixed(1)} total</span>
          </div>
          <div class="r-proposal-pitch-table">
            ${PROPOSAL_PITCH_FIELDS.map((field) => `<div class="r-proposal-pitch-head">${escapeHtml(field.label)}</div>`).join('')}
            ${PROPOSAL_PITCH_FIELDS.map((field) => `
              <div class="r-proposal-pitch-cell">
                <input type="number" step="0.1" min="0" data-proposal-measurement="${field.key}" value="${escapeHtml(String(measurements[field.key] ?? 0))}">
              </div>
            `).join('')}
          </div>
          <div class="r-proposal-measure-grid">
            ${PROPOSAL_MEASUREMENT_FIELDS.map((field) => `
              <div class="r-proposal-measure-group">
                <label>${escapeHtml(field.label)}</label>
                <input type="number" step="0.1" min="0" data-proposal-measurement="${field.key}" value="${escapeHtml(String(measurements[field.key] ?? 0))}">
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
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
        syncProposalPricebookItems(proposal);
        renderProposalSection();
        renderProposalPreview($('#rProposalPreview .r-proposal-wrap')?.scrollTop ?? 0);
        queueAutosaveNotice();
      });
    });
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

  function renderProposalPreviewCore(preservedScrollTop = null, rootOverride = null){
    const root = rootOverride || proposalPreviewRoot();
    if (!root) return;
    closeProposalPricebookSuggest();
    if (proposalSettingsPanelOpen) {
      mountProposalSettingsPanel();
      return;
    }
    normalizeProposalCollection();
    const proposal = proposals[activeProposalIndex];
    if (!proposal) {
      root.innerHTML = `
        <div class="r-proposal-preview-empty">
          <i class="fas fa-file-circle-plus"></i>
          <strong>No proposal selected</strong>
          <span>Create a proposal from the left column to preview it here.</span>
        </div>
      `;
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
        <div class="r-proposal-pages">
          ${proposalRenderedPageStackHtml(proposal, { viewMode, includeInsertControls: viewMode === 'edit' })}
        </div>
      </div>
    `;
    const wrap = root.querySelector('.r-proposal-wrap');
    renderProposalPdfCanvasPages(root);
    if (wrap) wrap.scrollTop = scrollTop;
    if (wrap) {
      wrap.style.cursor = proposalMarkupMode ? proposalMarkupCursorSvg() : '';
      wrap.addEventListener('scroll', () => {
        document.querySelectorAll('body > .r-proposal-rich-toolbar').forEach((toolbar) => toolbar._reposition?.());
      }, { passive: true });
    }
    window.addEventListener('resize', () => {
      document.querySelectorAll('body > .r-proposal-rich-toolbar').forEach((toolbar) => toolbar._reposition?.());
    }, { passive: true });
    wrap?.addEventListener('click', (e) => {
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
        const newIndex = appendProposalLineItem(page, proposal);
        renderProposalSection();
        renderProposalPreview(wrap?.scrollTop ?? 0);
        requestAnimationFrame(() => focusProposalFieldByPath(pageIndex, `lineItems.${newIndex}.label`));
        queueAutosaveNotice();
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
        const itemIndex = Number(btn.dataset.proposalDeleteLineItem || -1);
        page.lineItems = (page.lineItems || []).filter((_, index) => index !== itemIndex);
        if (!page.lineItems.length) appendProposalLineItem(page, proposal, { label: '', quantity: '1', unitPrice: '$0.00', amount: '$0.00' });
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
          showToast('Branding media unavailable', 'Could not load company branding images.', false);
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
        if (newPage.kind === 'pricing') recomputeProposalPricing(newPage, proposal);
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
          if (!(page.lineItems || [])[nextRow]) {
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

  function showProposalWorkspace(){
    if (!proposalsEnabled()) return;
    proposalWorkspaceOpen = true;
    if (!['list', 'edit', 'send'].includes(proposalWorkspaceMode)) proposalWorkspaceMode = 'list';
    proposalSigningMode = false;
    proposalSigningSession = null;
    closeSignatureChooser();
    setActivePreviewTab('proposal');
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
            <strong>Proposal Settings</strong>
            <span>Defaults for new proposals in this branch</span>
          </div>
          <button type="button" class="r-settings-panel-close" id="rProposalSettingsClose" aria-label="Close proposal settings" data-fm-tooltip="Back to proposal preview"><i class="fas fa-times"></i></button>
        </div>
        <div class="r-settings-panel-body" id="rProposalSettingsPanel"></div>
      </div>
    `;
    root.querySelector('#rProposalSettingsClose')?.addEventListener('click', closeProposalSettingsPanel);
    const panel = root.querySelector('#rProposalSettingsPanel');
    if (!window.FirstMateSettingsPages?.mount) {
      panel.innerHTML = `<div class="cs-note" style="padding:18px">Proposal settings library is unavailable.</div>`;
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
    $('#rProposalTopMode')?.classList.toggle('visible', editingProposal);
    $('#rProposalMarkupDock')?.classList.toggle('visible', editingProposal);
    if (editingProposal) requestAnimationFrame(positionProposalWorkspaceChrome);
    syncProposalBottomSendState();
  }

  function startProposalAgentProgress(){
    proposalAgentPrompt = ($('#rProposalAgentPrompt')?.value || proposalAgentPrompt || '').trim();
    if (!proposalAgentPrompt) {
      showToast('Add instructions', 'Tell the Proposal Agent what you want included first.', false);
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
      showToast('Proposal Agent queued', 'The prompt UI is ready; model generation can be wired into this action next.', true);
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
      showToast('Dictation unavailable', 'This browser does not expose speech recognition here.', false);
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

  function updateScrollCue(){
    const scroller = document.querySelector('#rOverlay .r-scroll');
    const cue = $('#rScrollCue');
    if (!scroller || !cue) return;
    if (proposalWorkspaceOpen) {
      cue.classList.remove('visible');
      return;
    }
    const canScroll = scroller.scrollHeight > scroller.clientHeight + 12;
    const nearBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 18;
    cue.classList.toggle('visible', canScroll && !nearBottom);
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
    proposalSplitPricingSections,
    appendProposalLineItem,
    proposalPlainTextLength,
    proposalIntroReserve,
    proposalMediaPageLimit,
    proposalMediaBlockHeight,
    proposalMediaSectionUsed,
    proposalSplitContentBlocks,
    proposalSplitFinePrintSections,
    proposalSectionPageCount,
    proposalPageEnabled,
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
    proposalPrintHtml,
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
    updateScrollCue,
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
    state.model = options.projectModel || options.model || state.model || window.FirstMateAppContext?.modelFromContext?.(options) || null;
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
    return api;
  }

  function ensureMounted(options = {}){
    if (!state.mounted || options.force) mount(options);
    return state.mounted;
  }

  function setActive(active){
    state.active = !!active;
    state.overlayRoot?.classList.toggle('proposal-workspace', !!active);
    callHost(active ? 'onActivate' : 'onDeactivate');
    if (state.active) {
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

  runtime?.registerApp?.({
    id: 'project.proposal',
    kind: 'project_modal_app',
    title: 'Project Proposals',
    label: 'Proposals',
    icon: 'fa-file-signature',
    order: 50,
    visible: true,
    surfaces: ['project_modal'],
    regions: ['main', 'left'],
    requiresContext: ['project'],
    dependencies: ['project.photos'],
    enabled: (context = {}) => context.proposalsEnabled !== false,
    panelHtml,
    mount: (context = {}) => mount(context)
  });
})();
