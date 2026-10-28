/* libraries/platform-terminology/platform-terminology.js
 * Branch-scoped display terminology for navigation and shared product concepts.
 * Stable application, route, and database ids never pass through this layer.
 */
(function(){
  const root = window;

  // The terms (namespaces, keys, default English labels and kinds) are config library entries
  // (`terminology_namespace`, docs/architecture/terminology.md), read once per page through
  // PlatformLanguage, or directly where it is absent. Until they arrive get() answers from the
  // language catalog or the caller's fallback; load() and ready() wait for them.
  let CATALOG = [];
  let DEFAULT_LABELS = {};
  const termsUrl = (() => {
    try { return new URL('/v1/config-library/read/terminology_namespace', root.document?.currentScript?.src || root.location?.href).href; } catch { return ''; }
  })();
  let current = { orgId:'', branchId:'default', mappings:{ schema_version:1, labels:{} }, config:null };
  let loading = null;
  let loadingKey = '', loadSequence = 0;

  function clean(value){ return String(value ?? '').trim(); }
  function object(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function mergedMappings(input = {}){
    const mappings = object(input);
    const labels = object(mappings.labels);
    return {
      ...mappings,
      schema_version:Number(mappings.schema_version || 1),
      labels:Object.fromEntries(Object.entries({ ...DEFAULT_LABELS, ...labels }).map(([namespace, values]) => [namespace, { ...object(DEFAULT_LABELS[namespace]), ...object(values) }]))
    };
  }
  function splitKey(path){
    const value = clean(path);
    const dot = value.indexOf('.');
    return dot > 0 ? [value.slice(0, dot), value.slice(dot + 1)] : ['', value];
  }
  function get(path, fallback = '', options = {}){
    if (!clean(path)) return clean(fallback);
    const [namespace, key] = splitKey(path);
    const source = mergedMappings(options.mappings || options.config?.mappings || current.mappings);
    const defaultLabel = clean(DEFAULT_LABELS?.[namespace]?.[key]) || clean(fallback) || key;
    const legacy = clean(source.labels?.[namespace]?.[key]);
    return root.PlatformLanguage?.term?.(path, defaultLabel, source) || legacy || defaultLabel;
  }
  function appLabel(appOrMeta = {}, fallback = ''){
    const app = appOrMeta.app || appOrMeta;
    const key = clean(appOrMeta.terminologyKey || app?.terminologyKey);
    return key ? get(key, fallback || appOrMeta.title || appOrMeta.label || app?.title || app?.label) : clean(fallback || appOrMeta.title || appOrMeta.label || app?.title || app?.label);
  }
  function setConfig(config = {}, options = {}){
    current = {
      orgId:clean(options.orgId || config.org_id || current.orgId),
      branchId:clean(options.branchId || config.branch_id || current.branchId || 'default') || 'default',
      mappings:mergedMappings(config.mappings || options.mappings || config),
      config
    };
    root.PlatformLanguage?.setTerminology?.(current.mappings);
    if (options.silent !== true) root.dispatchEvent(new CustomEvent('fm:terminology:updated', { detail:{ orgId:current.orgId, branchId:current.branchId, mappings:current.mappings } }));
    return current;
  }

  // PlatformScheduling owns persistence for variable_mappings. Add the shared
  // defaults to that module without creating a second storage path.
  function installDefaults(namespaces){
    CATALOG = namespaces.map((entry) => ({ id:clean(entry.id), title:clean(entry.title), note:clean(entry.note), terms:(Array.isArray(entry.terms) ? entry.terms : []).map((item) => ({ key:clean(item.key), label:clean(item.label), kind:clean(item.kind) || 'entity' })) }));
    DEFAULT_LABELS = Object.fromEntries(CATALOG.map((entry) => [entry.id, Object.fromEntries(entry.terms.map((item) => [item.key, item.label]))]));
    const schedulingDefaults = root.PlatformScheduling?.DEFAULT_MAPPINGS;
    if (schedulingDefaults?.labels) {
      Object.entries(DEFAULT_LABELS).forEach(([namespace, labels]) => {
        schedulingDefaults.labels[namespace] = { ...labels, ...object(schedulingDefaults.labels[namespace]) };
      });
    }
    if (CATALOG.length) setConfig(current.config || { mappings:current.mappings }, { orgId:current.orgId, branchId:current.branchId });
  }
  async function readDefaults(){
    if (root.PlatformLanguage?.terminologyNamespaces) return root.PlatformLanguage.terminologyNamespaces();
    if (!termsUrl || typeof root.fetch !== 'function') return [];
    const response = await root.fetch(termsUrl, { credentials:'omit' });
    if (!response.ok) throw new Error('Terminology unavailable');
    const body = await response.json();
    return (Array.isArray(body?.entries) ? body.entries : [])
      .map((entry) => ({ id:entry.id, ...object(entry.data) }))
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || String(a.id).localeCompare(String(b.id)));
  }
  let defaultsReady = null;
  function ready(){
    return defaultsReady ||= Promise.resolve().then(readDefaults).then((namespaces) => { installDefaults(namespaces || []); return CATALOG; })
      .catch((error) => { defaultsReady = null; root.console?.warn?.('Terminology defaults unavailable', error); return CATALOG; });
  }

  async function load(orgId, branchId = 'default', options = {}){
    const organizationId = clean(orgId);
    const branch = clean(branchId || 'default') || 'default';
    if (!organizationId || !root.PlatformScheduling?.loadBranchConfig) return current;
    const key = `${organizationId}:${branch}`;
    if (loading && loadingKey === key && options.refresh !== true) return loading;
    const sequence = ++loadSequence;
    loadingKey = key;
    if(current.orgId !== organizationId || current.branchId !== branch) setConfig({mappings:{}},{orgId:organizationId,branchId:branch,silent:true});
    loading = Promise.all([root.PlatformScheduling.loadBranchConfig(organizationId, branch, { refresh:options.refresh === true }), ready()])
      .then(async ([config]) => {
        const persisted=await root.PlatformAPI?.terminologyConfiguration?.(organizationId,branch);
        if(sequence !== loadSequence) return current;
        return setConfig({...config,mappings:persisted?.mappings || config.mappings || {}},{orgId:organizationId,branchId:branch,silent:options.silent});
      })
      .finally(() => { if(sequence === loadSequence) loading = null; });
    return loading;
  }
  function sections(mappings = current.mappings){
    const resolved = mergedMappings(mappings);
    return CATALOG.map((entry) => ({
      ...entry,
      rows:entry.terms.map((item) => ({ ...item, id:`${entry.id}.${item.key}`, namespace:entry.id, value:clean(resolved.labels?.[entry.id]?.[item.key]) || item.label }))
    }));
  }

  root.PlatformTerminology = {
    get CATALOG(){ return CATALOG; },
    get DEFAULT_LABELS(){ return DEFAULT_LABELS; },
    mergedMappings,
    sections,
    get,
    appLabel,
    setConfig,
    load,
    ready,
    refresh(orgId, branchId){ return load(orgId, branchId, { refresh:true }); },
    current(){ return current; }
  };
  ready();
})();
