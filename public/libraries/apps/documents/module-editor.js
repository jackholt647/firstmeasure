/* Document modules use the same DocModel renderer while owning independent instances. */
export async function openModuleEditor(organizationId) {
  const platform = window.PlatformAPI;
  const base = new URL(platform.baseUrl().replace(/\/platform\/?$/, '/document-modules'), location.href).href.replace(/\/$/, '');
  const request = (path, method = 'GET', body) => platform.request(`${base}/organizations/${encodeURIComponent(organizationId)}${path}`, { method, ...(body === undefined ? {} : { body }) });
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'width:min(1100px,95vw);max-height:92vh;overflow:auto;border:1px solid #cbd5e1;border-radius:12px;padding:24px;color:inherit;background:var(--surface,#fff)';
  dialog.innerHTML = `<form method="dialog"><button style="float:right" aria-label="Close module editor">Close</button></form>
    <h2>Document modules</h2><p>Create independent documents and workflows with declared data, code, and reusable document layouts. Existing signed documents stay unchanged.</p>
    <label>Published module <select data-modules><option value="">New module</option></select></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
      <label>Name <input data-name value="Estimate workflow" style="width:100%"></label>
      <label>Kind <select data-kind><option value="workflow">Workflow</option><option value="document">Document</option></select></label>
      <label>Input JSON schema<textarea data-input-schema rows="5" style="width:100%"></textarea></label>
      <label>Output JSON schema<textarea data-output-schema rows="5" style="width:100%"></textarea></label>
      <label>Published exports<textarea data-exports rows="6" style="width:100%"></textarea></label>
      <label>Data and action bindings<textarea data-bindings rows="6" style="width:100%">{}</textarea></label>
    </div>
    <p>Code receives <code>inputs</code>, <code>state</code>, <code>api.data.read(name)</code>, <code>api.actions.invoke(name,input)</code> and captured <code>api.now</code>. Return <code>{outputs, privateState?, view?}</code>. Evaluate cannot perform external effects.</p>
    <label>JavaScript<textarea data-source rows="9" spellcheck="false" style="width:100%;font-family:monospace"></textarea></label>
    <details><summary>Private state schema and optional DocModel layout</summary><label>Private state schema<textarea data-private rows="4" style="width:100%">{"type":"object"}</textarea></label><label>Renderer JSON (optional)<textarea data-renderer rows="6" style="width:100%"></textarea></label><button type="button" data-blank>Use blank document layout</button></details>
    <button type="button" data-publish>Publish version</button>
    <hr><h3>Project instances</h3><label>Project ID <input data-project></label><button type="button" data-list>Load instances</button>
    <label>Instance <select data-instances><option value="">New instance</option></select></label>
    <label>Input values (JSON)<textarea data-inputs rows="5" style="width:100%">{"hours":4,"rate":150}</textarea></label>
    <label>Binding overrides (JSON)<textarea data-overrides rows="4" style="width:100%">{}</textarea></label>
    <p><button type="button" data-create>Create independent instance</button> <button type="button" data-save>Save inputs</button> <button type="button" data-evaluate>Evaluate</button> <button type="button" data-command>Run command</button> <button type="button" data-freeze>Freeze result</button> <button type="button" data-document>Create portal document</button></p>
    <details><summary>Generate a separate document from workflow exports</summary>
      <label>Document module ID <input data-generate-module></label><label>Target binding name <input data-generate-binding value="estimate"></label><label>Workflow export name <input data-generate-export value="total"></label><label>Policy <select data-policy><option value="frozen">Frozen</option><option value="live">Live</option></select></label><button type="button" data-generate>Generate document instance</button>
    </details><p role="status" data-status></p><pre data-result style="white-space:pre-wrap;max-height:250px;overflow:auto"></pre><div data-preview></div>`;
  let previewHandle = null;
  document.body.append(dialog); dialog.addEventListener('close', () => { previewHandle?.destroy?.(); dialog.remove(); }); dialog.showModal();
  const el = name => dialog.querySelector(`[data-${name}]`);
  const value = name => el(name).value;
  const parse = name => JSON.parse(value(name) || '{}');
  const fill = (name, val) => { el(name).value = typeof val === 'string' ? val : JSON.stringify(val, null, 2); };
  fill('input-schema', { type: 'object', properties: { hours: { type: 'number', minimum: 0 }, rate: { type: 'number', minimum: 0 } }, required: ['hours', 'rate'], additionalProperties: false });
  fill('output-schema', { type: 'object', properties: { total: { type: 'number' } }, required: ['total'], additionalProperties: false });
  fill('exports', { total: { path: '/outputs/total', schema: { type: 'number' }, access: 'read' } });
  fill('source', 'return { outputs: { total: inputs.hours * inputs.rate } };');
  let moduleId = '', instance = null, commandKey = null;
  const show = async result => {
    if (result.instance) instance = result.instance;
    el('result').textContent = JSON.stringify(result, null, 2);
    previewHandle?.destroy?.(); previewHandle = null; el('preview').replaceChildren();
    if (instance?.view && window.FMDocRenderer?.render) {
      previewHandle = window.FMDocRenderer.render(el('preview'), { document: instance.view, mode: 'static', readonly: true, widgetData: {} });
    }
  };
  const perform = task => async () => {
    el('status').textContent = 'Working…';
    try { await task(); el('status').textContent = 'Saved.'; }
    catch (error) { el('status').textContent = error.message || 'Request failed.'; }
  };
  async function loadModules() {
    const { modules } = await request('/modules');
    el('modules').replaceChildren(new Option('New module', ''));
    for (const module of modules) el('modules').add(new Option(`${module.name} (${module.kind})`, module.id));
    el('modules').value = moduleId;
  }
  el('modules').onchange = perform(async () => {
    moduleId = value('modules'); instance = null; commandKey = null;
    if (!moduleId) return;
    const { module } = await request(`/modules/${encodeURIComponent(moduleId)}`);
    const d = module.definition;
    for (const [field, key] of [['name','name'],['kind','kind'],['input-schema','inputSchema'],['output-schema','outputSchema'],['private','privateStateSchema'],['exports','exports'],['bindings','bindings'],['source','source']]) fill(field,d[key]);
    fill('renderer',d.renderer || '');
  });
  el('blank').onclick = () => fill('renderer', window.FMDocModel.createBlankDocument());
  el('publish').onclick = perform(async () => {
    const definition = { name: value('name'), kind: value('kind'), inputSchema: parse('input-schema'), outputSchema: parse('output-schema'), privateStateSchema: parse('private'), exports: parse('exports'), bindings: parse('bindings'), source: value('source'), ...(value('renderer').trim() ? { renderer: parse('renderer') } : {}) };
    const result = await request('/modules','POST',{ ...(moduleId ? { moduleId } : {}), definition });
    moduleId = result.module.id; await loadModules(); await show(result);
  });
  el('list').onclick = perform(async () => {
    const { instances } = await request(`/instances?projectId=${encodeURIComponent(value('project'))}`);
    el('instances').replaceChildren(new Option('New instance',''));
    for (const item of instances) el('instances').add(new Option(`${item.kind} · ${item.id}${item.frozen ? ' (frozen)' : ''}`,item.id));
  });
  el('instances').onchange = perform(async () => {
    commandKey = null;
    if (!value('instances')) { instance = null; return; }
    await show(await request(`/instances/${encodeURIComponent(value('instances'))}`));
    if (instance.inputs) fill('inputs',instance.inputs);
  });
  el('create').onclick = perform(async () => {
    if (!moduleId) throw new Error('Publish or select a module first.');
    await show(await request('/instances','POST',{ moduleId, projectId: value('project'), inputs: parse('inputs'), bindings: parse('overrides') })); commandKey = null;
  });
  const instancePath = () => { if (!instance) throw new Error('Create or select an instance first.'); return `/instances/${encodeURIComponent(instance.id)}`; };
  el('save').onclick = perform(async () => { await show(await request(instancePath(),'PATCH',{ inputs: parse('inputs'), expectedRevision:instance.revision })); commandKey = null; });
  el('evaluate').onclick = perform(async () => show(await request(`${instancePath()}/evaluate`,'POST',{ expectedRevision:instance.revision })));
  el('command').onclick = perform(async () => {
    // Retain the same key on an uncertain network outcome; a successful command resets it.
    commandKey ||= crypto.randomUUID();
    await show(await request(`${instancePath()}/command`,'POST',{ expectedRevision:instance.revision, idempotencyKey:commandKey })); commandKey = null;
  });
  el('freeze').onclick = perform(async () => show(await request(`${instancePath()}/freeze`,'POST',{ expectedRevision:instance.revision })));
  el('document').onclick = perform(async () => show(await request(`${instancePath()}/document`,'POST',{})));
  el('generate').onclick = perform(async () => show(await request(`${instancePath()}/generate`,'POST',{ moduleId:value('generate-module'),bindingName:value('generate-binding'),exportName:value('generate-export'),policy:value('policy'),inputs:parse('inputs') })));
  await perform(loadModules)();
}
