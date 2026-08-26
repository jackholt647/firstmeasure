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
    if (host === '127.0.0.1' || host === 'localhost') return 'http://127.0.0.1:3111/v1/firstmeasure';
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
    sync(projectId, data = {}){ return requestPost(projectPath(projectId, '/pdfs/sync'), data); },
    syncStatus(projectId, jobId){ return requestGet(projectPath(projectId, `/pdfs/sync/${enc(jobId)}`)); },
    registerLocalChecksums(projectId, jobId, checksums = {}){ return requestPost(projectPath(projectId, `/pdfs/sync/${enc(jobId)}/client-checksums`), { checksums }); },
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
    queue
  };

  configure({ baseUrl: APP.firstMeasureApiBase || '' });
  root.FirstMeasureAPI = api;
})();
