/* libraries/firstmeasure-api/firstmeasure-api.js
 * Browser client for /v1/firstmeasure.
 *
 * FirstMeasure owns measurement/report processing. Platform-owned data belongs in
 * PlatformAPI, not here.
 */
(function(){
  const root = window;
  const APP = root.__APP || {};

  const state = {
    baseUrl: '',
    defaultHeaders: {}
  };

  const cleanText = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(cleanText(value));

  function defaultBaseUrl(){
    if (APP.firstMeasureApiBase) return cleanText(APP.firstMeasureApiBase).replace(/\/+$/, '');
    const host = cleanText(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:3101/v1/firstmeasure';
    return `${location.origin}/v1/firstmeasure`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = cleanText(options.baseUrl).replace(/\/+$/, '');
    if (options.headers && typeof options.headers === 'object') {
      state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    }
    return api;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function url(path = ''){
    const raw = cleanText(path);
    if (/^https?:\/\//i.test(raw)) return raw;
    return `${baseUrl()}/${raw.replace(/^\/+/, '')}`;
  }

  function jsonBody(body){
    if (body == null || body instanceof FormData || typeof body === 'string') return body;
    return JSON.stringify(body);
  }

  async function request(path, options = {}){
    const body = jsonBody(options.body);
    const res = await fetch(url(path), {
      ...options,
      body,
      cache: options.cache || 'no-store',
      headers: {
        Accept: 'application/json',
        ...state.defaultHeaders,
        ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch(e) {}
    if (!res.ok || data?.ok === false) {
      const error = new Error(cleanText(data?.message || data?.error) || `FirstMeasure request failed (${res.status})`);
      error.status = res.status;
      error.data = data;
      error.responseText = text;
      throw error;
    }
    return data;
  }

  const requestGet = (path, options = {}) => request(path, { ...options, method: options.method || 'GET' });
  const requestPost = (path, body, options = {}) => request(path, { ...options, method: 'POST', body });
  const requestPut = (path, body, options = {}) => request(path, { ...options, method: 'PUT', body });
  const requestPatch = (path, body, options = {}) => request(path, { ...options, method: 'PATCH', body });

  const projectPath = (projectId, suffix = '') => `/projects/${enc(projectId)}${suffix}`;
  const instantPath = (instantId, suffix = '') => `/instants/${enc(instantId)}${suffix}`;

  const artifacts = {
    list(projectId){ return requestGet(projectPath(projectId, '/artifacts')); },
    url(projectId, name){ return url(projectPath(projectId, `/artifacts/${cleanText(name).split('/').map(enc).join('/')}`)); },
    thumbnailUrl(projectId, source = 'google.png', width = 320){
      const w = Math.max(80, Math.min(1600, parseInt(width, 10) || 320));
      return url(projectPath(projectId, `/thumbnail?w=${w}&source=${enc(source)}`));
    },
    reportUrl(projectId){ return artifacts.url(projectId, 'Report.pdf'); },
    summaryUrl(projectId){ return artifacts.url(projectId, 'Summary.pdf'); },
    instantReportUrl(projectId){ return artifacts.url(projectId, 'Instant Report.pdf'); },
    xmlUrl(projectId){ return artifacts.url(projectId, 'model_data.xml'); },
    upload(projectId, formData, options = {}) {
      return request(projectPath(projectId, '/artifacts'), { ...options, method: 'POST', body: formData });
    }
  };

  const projects = {
    list(payload = {}){ return requestPost('/projects/list', payload); },
    query(payload = {}){ return requestPost('/projects/query', payload); },
    findByAddress(payload = {}){ return requestPost('/projects/find-by-address', payload); },
    queue(payload = {}){ return requestPost('/projects/queue', payload); },
    create(payload = {}){ return requestPost('/projects', payload); },
    get(projectId){ return requestGet(projectPath(projectId)); },
    measurements(projectId){ return requestGet(projectPath(projectId, '/measurements')); },
    patch(projectId, data = {}){ return requestPatch(projectPath(projectId), data); },
    setStatus(projectId, data = {}){ return requestPost(projectPath(projectId, '/status'), data); },
    editor(projectId){ return requestGet(projectPath(projectId, '/editor')); },
    getPdfState(projectId){ return requestGet(projectPath(projectId, '/pdf-state')); },
    savePdfState(projectId, data = {}){ return requestPut(projectPath(projectId, '/pdf-state'), data); },
    getAppMetadata(projectId){ return requestGet(projectPath(projectId, '/app-metadata')); },
    saveAppMetadata(projectId, data = {}){ return requestPut(projectPath(projectId, '/app-metadata'), data); },
    getBrandingDefaults(projectId){ return requestGet(projectPath(projectId, '/branding-defaults')); },
    saveBrandingDefaults(projectId, data = {}){ return requestPut(projectPath(projectId, '/branding-defaults'), data); },
    google3dManifest(projectId){ return requestGet(projectPath(projectId, '/google-3d/manifest.json')); },
    google3dTileUrl(projectId, tileName){ return url(projectPath(projectId, `/google-3d/tiles/${enc(tileName)}`)); },
    captureGoogle3d(projectId, data = {}){ return requestPost(projectPath(projectId, '/google-3d/capture'), data); },
    ensureMask(projectId, data = {}){ return requestPost(projectPath(projectId, '/mask/ensure'), data); },
    processImagery(projectId, data = {}){ return requestPost(projectPath(projectId, '/process/imagery'), data); },
    processMask(projectId, data = {}){ return requestPost(projectPath(projectId, '/process/mask'), data); },
    processInsights(projectId, data = {}){ return requestPost(projectPath(projectId, '/process/insights'), data); },
    artifacts
  };

  const instant = {
    create(payload = {}){ return requestPost('/instants', payload); },
    getForProject(projectId){ return requestGet(projectPath(projectId, '/instant')); },
    getInstant(instantId){ return requestGet(instantPath(instantId)); },
    ensureForProject(projectId, data = {}){ return requestPost(projectPath(projectId, '/instant/ensure'), data); },
    ensureInstant(instantId, data = {}){ return requestPost(instantPath(instantId, '/ensure'), data); },
    renderPdfForProject(projectId, data = {}){ return requestPost(projectPath(projectId, '/instant/pdf'), data); },
    renderPdfForInstant(instantId, data = {}){ return requestPost(instantPath(instantId, '/pdf'), data); },
    refund(projectId, data = {}){ return requestPost(projectPath(projectId, '/instant/refund'), data); }
  };

  const pdfs = {
    get(projectId, slot = ''){ return requestGet(projectPath(projectId, `/pdf${slot ? `?slot=${enc(slot)}` : ''}`)); },
    reportUrl(projectId){ return url(projectPath(projectId, '/pdfs/report')); },
    generate(projectId, data = {}){ return requestPost(projectPath(projectId, '/pdfs/generate'), data); },
    generateServer(projectId, data = {}){ return requestPost(projectPath(projectId, '/pdfs/generate/server'), data); },
    preview(projectId, data = {}){ return requestPost(projectPath(projectId, '/pdfs/preview'), data); },
    runtime(projectId){ return requestGet(projectPath(projectId, '/pdfs/runtime')); },
    assemble(projectId, data = {}){ return requestPost(projectPath(projectId, '/pdf/assemble'), data); },
    assembleReport(projectId, data = {}){ return requestPost(projectPath(projectId, '/pdfs/report/assemble'), data); },
    renderReport(projectId, data = {}){ return requestPost(projectPath(projectId, '/render/report'), data); },
    renderPdf(projectId, data = {}){ return requestPost(projectPath(projectId, '/render/pdf'), data); },
    renderPages(projectId, data = {}){ return requestPost(projectPath(projectId, '/render/pages'), data); },
    renderPage(projectId, data = {}){ return requestPost(projectPath(projectId, '/render/page'), data); }
  };

  const xml = {
    url(projectId){ return url(projectPath(projectId, '/xml')); },
    assemble(projectId, data = {}){ return requestPost(projectPath(projectId, '/xml/assemble'), data); }
  };

  const queue = {
    status(data = {}){ return requestPost('/queue/status', data); },
    claimNext(data = {}){ return requestPost('/queue/claim-next', data); },
    adminOverview(data = {}){ return requestPost('/queue/admin/overview', data); },
    reserve(projectId, data = {}){ return requestPost(projectPath(projectId, '/queue/reserve'), data); },
    releaseReservation(projectId, data = {}){ return requestPost(projectPath(projectId, '/queue/release-reservation'), data); },
    releaseAssignment(projectId, data = {}){ return requestPost(projectPath(projectId, '/queue/release-assignment'), data); }
  };

  // A single, product-facing roof-measurement adapter.  Consumers should use this
  // rather than knowing which FirstMeasure artifact happens to contain a value.
  // It intentionally returns a detached snapshot: the proposal/scope layer owns
  // persistence and overrides, while FirstMeasure remains the external source.
  const roofMeasurementCache = new Map();
  const roofMeasurementLoads = new Map();
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const numberValue = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[$,%\s,]/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (isObject(value)) {
      for (const key of ['value', 'amount', 'total', 'measurement', 'quantity', 'number', 'area', 'length', 'count']) {
        const parsed = numberValue(value[key]);
        if (parsed != null) return parsed;
      }
    }
    return null;
  };
  const normalizedKey = (value) => cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const measurementProjectId = (project = {}, reportOrderState = {}) => {
    const measurement = isObject(project.measurement_project) ? project.measurement_project : (isObject(project.measurement) ? project.measurement : {});
    const raw = isObject(measurement.raw) ? measurement.raw : {};
    const report = isObject(reportOrderState.data) ? reportOrderState.data : reportOrderState;
    const candidates = [
      measurement.id, measurement.project_id, measurement.folder, measurement.measurement_project_id,
      raw.id, raw.project_id, raw.folder,
      report.folder, report.project_id, report?.project?.id, report?.project?.project_id,
      project.firstmeasure_project_id, project.measurement_project_id
    ];
    for (const value of candidates) {
      const id = cleanText(value);
      // Platform project ids are intentionally excluded. FirstMeasure ids are
      // generated as hex strings, so this does not discard valid report ids.
      if (id && !/^(project|base|__optimistic)_/i.test(id)) return id;
    }
    const urls = [project.report_url, project.pdf_url, project.summary_url, project.xml_url, measurement.report_url, measurement.pdf_url, measurement.summary_url, measurement.xml_url, raw.report_url, raw.pdf_url, raw.summary_url, raw.xml_url];
    for (const value of urls) {
      const match = cleanText(value).match(/\/projects\/([^/?#]+)/i);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return '';
  };
  const firstNumber = (source, keys = []) => {
    if (!source || typeof source !== 'object') return null;
    const aliases = new Set();
    keys.forEach((key) => {
      const clean = normalizedKey(key);
      if (clean) [clean, `${clean}sum`, `${clean}total`, `${clean}value`].forEach((item) => aliases.add(item));
    });
    const seen = new Set();
    const scan = (value) => {
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) { const result = scan(item); if (result != null) return result; }
        return null;
      }
      for (const key of keys) {
        const direct = String(key).split('.').reduce((item, part) => isObject(item) ? item[part] : undefined, value);
        const parsed = numberValue(direct);
        if (parsed != null && parsed > 0) return parsed;
      }
      for (const [key, item] of Object.entries(value)) {
        if (!aliases.has(normalizedKey(key))) continue;
        const parsed = numberValue(item);
        if (parsed != null && parsed > 0) return parsed;
      }
      const label = normalizedKey(value.key || value.name || value.label || value.title || value.type || value.field || value.metric);
      if (label && aliases.has(label)) {
        const parsed = numberValue(value);
        if (parsed != null && parsed > 0) return parsed;
      }
      for (const item of Object.values(value)) { const result = scan(item); if (result != null) return result; }
      return null;
    };
    return scan(source);
  };
  const sqftToSquares = (value) => {
    const parsed = numberValue(value);
    return parsed != null && parsed > 0 ? Math.round((parsed / 100) * 10) / 10 : null;
  };
  const meters2ToSquares = (value) => {
    const parsed = numberValue(value);
    return parsed != null && parsed > 0 ? Math.round(((parsed * 10.7639104167) / 100) * 10) / 10 : null;
  };
  const pitchBucket = (rise) => {
    const value = numberValue(rise);
    if (value == null) return 'pitch4to6Squares';
    if (value <= 2) return 'flatRoofSquares';
    if (value <= 4) return 'pitch2to4Squares';
    if (value <= 6) return 'pitch4to6Squares';
    if (value <= 8) return 'pitch6to8Squares';
    if (value <= 12) return 'pitch9to12Squares';
    return 'pitch13PlusSquares';
  };
  const lineBucket = (type) => {
    const value = normalizedKey(type);
    if (value.includes('ridge')) return 'ridgesLf';
    if (value.includes('hip')) return 'hipsLf';
    if (value.includes('eave')) return 'eavesLf';
    if (value.includes('rake')) return 'rakesLf';
    if (value.includes('valley')) return 'valleyLf';
    if (value.includes('headwall') || value.includes('apron')) return 'headWallLf';
    if (value.includes('sidewall') || value.includes('stepflashing')) return 'sideWallLf';
    if (value.includes('trans')) return 'transitionsLf';
    return '';
  };
  const measurementsFromXml = (xmlText) => {
    const text = cleanText(xmlText);
    if (!text || typeof DOMParser === 'undefined') return {};
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return {};
      const result = {};
      const add = (key, value) => {
        const parsed = numberValue(value);
        if (!key || parsed == null || parsed <= 0) return;
        result[key] = Number(result[key] || 0) + parsed;
      };
      const points = new Map();
      doc.querySelectorAll('POINT').forEach((point) => {
        const id = cleanText(point.getAttribute('id'));
        const values = cleanText(point.getAttribute('data')).split(',').map(numberValue);
        if (id && values.length >= 2 && values[0] != null && values[1] != null) points.set(id, { x: values[0], y: values[1], z: values[2] || 0 });
      });
      const distance = (start, end) => {
        if (!start || !end) return null;
        const value = Math.sqrt(((start.x - end.x) ** 2) + ((start.y - end.y) ** 2) + ((start.z - end.z) ** 2));
        return Number.isFinite(value) && value > 0 ? value : null;
      };
      doc.querySelectorAll('LINE').forEach((line) => {
        let length = numberValue(line.getAttribute('length') || line.getAttribute('length_ft'));
        if (length == null) {
          const path = cleanText(line.getAttribute('path')).split(',').map((value) => cleanText(value)).filter(Boolean);
          length = distance(points.get(path[0]), points.get(path[path.length - 1]));
        }
        add(lineBucket(line.getAttribute('type')), length);
      });
      let area = 0;
      doc.querySelectorAll('SURFACE, FACE').forEach((surface) => {
        const polygon = surface.querySelector('POLYGON');
        const squareFeet = numberValue(surface.getAttribute('area')) ?? numberValue(polygon?.getAttribute('size')) ?? numberValue(polygon?.getAttribute('area'));
        if (squareFeet == null || squareFeet <= 0) return;
        area += squareFeet;
        const rise = numberValue(surface.getAttribute('pitch')) ?? numberValue(polygon?.getAttribute('pitch'));
        const bucket = pitchBucket(rise);
        result[bucket] = Number(result[bucket] || 0) + squareFeet / 100;
      });
      if (area > 0) {
        result.roofSquares = Math.round((area / 100) * 10) / 10;
        result.shingleSquares = result.roofSquares;
      }
      return result;
    } catch (_) { return {}; }
  };
  const normalizeRoofMeasurements = (source = {}) => {
    const read = (keys) => firstNumber(source, keys);
    const readSquares = (direct, sqft, meters) => read(direct) ?? sqftToSquares(read(sqft)) ?? meters2ToSquares(read(meters));
    const metrics = {
      flatRoofSquares: readSquares(['flatRoofSquares', 'flat_roof_squares', 'flat_squares'], ['flat_roof_sqft', 'flat_roof_area_sqft'], ['flat_roof_meters2', 'flat_roof_area_meters2']) || 0,
      pitch2to4Squares: readSquares(['pitch2to4Squares', 'pitch_2_4_squares', 'pitch_2to4_squares'], ['pitch_2_4_sqft', 'pitch_2to4_sqft'], []) || 0,
      pitch4to6Squares: readSquares(['pitch4to6Squares', 'pitch_4_6_squares', 'pitch_4to6_squares'], ['pitch_4_6_sqft', 'pitch_4to6_sqft'], []) || 0,
      pitch6to8Squares: readSquares(['pitch6to8Squares', 'pitch_6_8_squares', 'pitch_6to8_squares'], ['pitch_6_8_sqft', 'pitch_6to8_sqft'], []) || 0,
      pitch9to12Squares: readSquares(['pitch9to12Squares', 'pitch_9_12_squares', 'pitch_9to12_squares'], ['pitch_9_12_sqft', 'pitch_9to12_sqft'], []) || 0,
      pitch13PlusSquares: readSquares(['pitch13PlusSquares', 'pitch_13_plus_squares', 'pitch_13plus_squares'], ['pitch_13_plus_sqft', 'pitch_13plus_sqft'], []) || 0,
      eavesLf: read(['eavesLf', 'eaves_lf', 'eave_length', 'eaves']) || 0,
      rakesLf: read(['rakesLf', 'rakes_lf', 'rake_length', 'rakes']) || 0,
      hipsLf: read(['hipsLf', 'hips_lf', 'hip_length', 'hips']) || 0,
      ridgesLf: read(['ridgesLf', 'ridges_lf', 'ridge_length', 'ridges']) || 0,
      valleyLf: read(['valleyLf', 'valley_lf', 'valley_length', 'valleys']) || 0,
      transitionsLf: read(['transitionsLf', 'transitions_lf', 'transition_lf']) || 0,
      sideWallLf: read(['sideWallLf', 'side_wall_lf', 'sidewall_lf', 'step_flashing_lf']) || 0,
      headWallLf: read(['headWallLf', 'head_wall_lf', 'headwall_lf', 'apron_flashing_lf']) || 0,
      gutterLf: read(['gutterLf', 'gutters_lf', 'gutter_lf']) || 0,
      downspoutLf: read(['downspoutLf', 'downspouts_lf', 'downspout_lf']) || 0,
      chimneysEa: read(['chimneysEa', 'chimneys', 'chimney_count']) || 0,
      skylightsEa: read(['skylightsEa', 'skylights', 'skylight_count']) || 0,
      pipeBootsEa: read(['pipeBootsEa', 'pipe_boots', 'pipe_boot_count']) || 0,
      roofVentsEa: read(['roofVentsEa', 'roof_vents', 'roof_vent_count']) || 0,
      ridgeVentLf: read(['ridgeVentLf', 'ridge_vent_lf', 'ridge_vent_length']) || 0,
      boxVentsEa: read(['boxVentsEa', 'box_vents', 'box_vent_count']) || 0,
      wastePercent: read(['wastePercent', 'waste_percent']) || 0
    };
    const total = readSquares(['roofSquares', 'roof_squares', 'totalSquares', 'total_squares', 'total_roof_squares'], ['roof_sqft', 'roof_area_sqft', 'total_roof_area_sqft', 'total_area_sqft'], ['roof_area_meters2', 'total_roof_area_meters2']);
    const pitched = ['pitch2to4Squares', 'pitch4to6Squares', 'pitch6to8Squares', 'pitch9to12Squares', 'pitch13PlusSquares'].reduce((sum, key) => sum + Number(metrics[key] || 0), 0);
    metrics.shingleSquares = read(['shingleSquares', 'shingle_squares', 'slopeSquares', 'slope_squares']) || pitched || Math.max(0, Number(total || 0) - metrics.flatRoofSquares);
    metrics.slopeSquares = metrics.shingleSquares;
    metrics.roofSquares = total || Math.round((metrics.shingleSquares + metrics.flatRoofSquares) * 10) / 10;
    return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : 0]));
  };
  const hasRoofMeasurements = (measurements = {}) => Object.values(measurements).some((value) => Number(value) > 0);
  const sourceFromProject = (project = {}, reportOrderState = {}, extra = {}) => {
    const measurement = isObject(project.measurement_project) ? project.measurement_project : (isObject(project.measurement) ? project.measurement : {});
    const raw = isObject(measurement.raw) ? measurement.raw : {};
    const report = isObject(reportOrderState.data) ? reportOrderState.data : reportOrderState;
    return { ...raw, ...report, ...measurement, ...project, ...extra, measurement, raw, report };
  };
  const artifactText = async (projectId, name) => {
    const response = await fetch(artifacts.url(projectId, name), { credentials: 'include', cache: 'no-store' });
    return response.ok ? response.text() : null;
  };
  const artifactJson = async (projectId, name) => {
    const response = await fetch(artifacts.url(projectId, name), { credentials: 'include', cache: 'no-store' });
    return response.ok ? response.json() : null;
  };
  const roofMeasurements = {
    projectId: measurementProjectId,
    async import(project = {}) {
      const projectId = cleanText(project.platform_project_id || project.base_project_id || project.id);
      const organizationId = cleanText(project.organization_id || window.__APP?.userOrgId);
      if (!projectId || !organizationId || !window.PlatformAPI?.publication?.invoke) throw new Error('Measurement import is unavailable for this project.');
      const result = await window.PlatformAPI.publication.invoke(organizationId, 'firstmeasure.measurements.import', { scope: 'project', organizationId, projectId }, {}, { idempotencyKey: `measurement-import:${crypto.randomUUID()}` });
      roofMeasurements.clear(measurementProjectId(project));
      return result;
    },
    fromProject(project = {}, options = {}) {
      const source = sourceFromProject(project, options.reportOrderState || {}, options.source || {});
      return { projectId: measurementProjectId(project, options.reportOrderState || {}), source, measurements: normalizeRoofMeasurements(source), origin: 'project_data' };
    },
    async load(project = {}, options = {}) {
      const id = measurementProjectId(project, options.reportOrderState || {});
      const local = roofMeasurements.fromProject(project, options);
      const platformProjectId = cleanText(project.platform_project_id || project.base_project_id || project.id);
      const organizationId = cleanText(project.organization_id || window.__APP?.userOrgId);
      if (platformProjectId && organizationId && window.PlatformAPI?.publication?.measurements) {
        const dataset = await window.PlatformAPI.publication.measurements(organizationId, platformProjectId).catch(error => {
          if (error?.status === 404) return { status: 'missing', code: 'legacy_project_without_dataset' };
          throw error;
        });
        if (dataset?.status === 'ready') {
          const values = {};
          for (const [key, entry] of Object.entries(dataset.value?.measurements || {})) {
            if (!entry || entry.value == null || !Number.isFinite(Number(entry.value))) continue;
            const expected = /Squares$/.test(key) ? 'roofing_square' : /Lf$/.test(key) ? 'ft' : /Ea$/.test(key) ? 'count' : '';
            if (!expected) continue;
            let value = Number(entry.value);
            if (entry.unit === 'm' && expected === 'ft') value *= 3.280839895;
            else if (entry.unit !== expected) continue;
            values[key] = value;
          }
          return { projectId: id, source: dataset, measurements: values, origin: 'project_measurement_dataset', datasetId: dataset.datasetId, revision: dataset.revision };
        }
        if (dataset?.status !== 'missing') throw new Error('Project measurement dataset is unavailable.');
        local.legacyFallback = true;
        local.legacyFallbackReason = dataset.code || 'measurement_dataset_unselected';
      }
      if (!id) return local;
      if (!options.force && roofMeasurementCache.has(id)) return roofMeasurementCache.get(id);
      if (!options.force && roofMeasurementLoads.has(id)) return roofMeasurementLoads.get(id);
      const loading = (async () => {
        const canonical = await projects.measurements(id).catch(() => null);
        if (canonical?.measurements && hasRoofMeasurements(canonical.measurements)) {
          const result = {
            projectId: id,
            source: sourceFromProject(project, options.reportOrderState || {}, { firstmeasure_measurements: canonical }),
            measurements: normalizeRoofMeasurements(canonical.measurements),
            origin: 'firstmeasure_measurements_api', legacyFallback: true, legacyFallbackReason: local.legacyFallbackReason || 'measurement_dataset_unselected'
          };
          roofMeasurementCache.set(id, result);
          return result;
        }
        const detail = await projects.get(id).catch(() => null);
        const reportProject = isObject(detail?.project) ? detail.project : {};
        const files = Array.isArray(reportProject.files) ? reportProject.files : [];
        const names = new Map(files.map((file) => [cleanText(file?.name).toLowerCase(), cleanText(file?.name)]));
        const source = sourceFromProject(project, options.reportOrderState || {}, { detail, firstmeasure_project: reportProject, firstmeasure_manifest: isObject(reportProject.manifest) ? reportProject.manifest : {} });
        const xmlName = names.get('model_data.xml') || 'model_data.xml';
        const xml = await artifactText(id, xmlName).catch(() => null);
        if (xml) Object.assign(source, measurementsFromXml(xml), { model_data_xml: measurementsFromXml(xml) });
        await Promise.all(['measurements.json', 'measurement.json', 'report.json', 'summary.json', 'insights.json', 'instant-structures.json'].map(async (name) => {
          const stored = names.get(name) || name;
          const data = await artifactJson(id, stored).catch(() => null);
          if (data) source[name.replace(/[^a-z0-9]/gi, '_')] = data;
        }));
        const result = { projectId: id, source, measurements: normalizeRoofMeasurements(source), origin: xml ? 'firstmeasure_artifacts' : 'firstmeasure_project', legacyFallback: true, legacyFallbackReason: local.legacyFallbackReason || 'measurement_dataset_unselected' };
        roofMeasurementCache.set(id, result);
        return result;
      })().finally(() => roofMeasurementLoads.delete(id));
      roofMeasurementLoads.set(id, loading);
      return loading;
    },
    normalize: normalizeRoofMeasurements,
    hasValues: hasRoofMeasurements,
    clear(projectId = '') { if (projectId) roofMeasurementCache.delete(cleanText(projectId)); else roofMeasurementCache.clear(); }
  };

  const api = {
    configure,
    baseUrl,
    url,
    request,
    get: requestGet,
    post: requestPost,
    put: requestPut,
    patch: requestPatch,
    projects,
    artifacts,
    instant,
    pdfs,
    xml,
    queue,
    roofMeasurements
  };

  configure({ baseUrl: APP.firstMeasureApiBase || '' });
  root.FirstMeasureAPI = api;
})();
