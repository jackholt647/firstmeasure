/* public/libraries/financials-api/financials-api.js
 * Browser client for the FirstMate Financials v1 read API.
 */
(function(){
  'use strict';

  const root = window;
  const APP = root.__APP || {};
  const state = { baseUrl:'', defaultHeaders:{} };
  const clean = (value) => String(value ?? '').trim();
  const enc = (value) => encodeURIComponent(clean(value));
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  function defaultBaseUrl(){
    if (APP.financialsApiBase) return clean(APP.financialsApiBase).replace(/\/+$/, '');
    if (APP.platformApiBase) return clean(APP.platformApiBase).replace(/\/v1\/platform\/?$/i, '/v1/financials').replace(/\/+$/, '');
    const host = clean(location.hostname).toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost') return `${location.origin}/v1/financials`;
    return `${location.origin}/v1/financials`;
  }

  function configure(options = {}){
    if (options.baseUrl) state.baseUrl = clean(options.baseUrl).replace(/\/+$/, '');
    if (object(options.headers)) state.defaultHeaders = { ...state.defaultHeaders, ...options.headers };
    return api;
  }

  function baseUrl(){
    if (!state.baseUrl) state.baseUrl = defaultBaseUrl();
    return state.baseUrl;
  }

  function queryString(values = {}){
    const params = new URLSearchParams();
    Object.entries(object(values)).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : clean(value));
    });
    const query = params.toString();
    return query ? `?${query}` : '';
  }

  async function request(path, options = {}){
    const response = await fetch(`${baseUrl()}/${clean(path).replace(/^\/+/, '')}`, {
      ...options,
      cache:options.cache || 'no-store',
      credentials:options.credentials || 'include',
      headers:{ Accept:'application/json', ...state.defaultHeaders, ...object(options.headers) }
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) {
      const error = new Error(clean(data?.message || data?.error) || `Financials API request failed (${response.status})`);
      error.status = response.status;
      error.code = clean(data?.error);
      error.data = data;
      throw error;
    }
    return data;
  }

  function orgPath(orgId, suffix){ return `organizations/${enc(orgId)}${suffix}`; }

  const api = {
    version:1,
    configure,
    baseUrl,
    overview(orgId, options = {}){ return request(`${orgPath(orgId, '/overview')}${queryString(options)}`); },
    projects(orgId, options = {}){ return request(`${orgPath(orgId, '/projects')}${queryString(options)}`); },
    cashFlow(orgId, options = {}){ return request(`${orgPath(orgId, '/cash-flow')}${queryString(options)}`); }
  };

  configure({ baseUrl:APP.financialsApiBase || '' });
  root.FinancialsAPI = api;
})();
