/* Document modules use the same DocModel renderer while owning independent instances. */
export async function openModuleEditor(organizationId) {
  const platform = window.PlatformAPI;
  const base = new URL(platform.baseUrl().replace(/\/platform\/?$/, '/document-modules'), location.href).href.replace(/\/$/, '');
  const request = (path, method = 'GET', body) => platform.request(`${base}/organizations/${encodeURIComponent(organizationId)}${path}`, { method, ...(body === undefined ? {} : { body }) });
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'width:min(1100px,95vw);max-height:92vh;overflow:auto;border:1px solid #cbd5e1;border-radius:12px;padding:24px;color:inherit;background:var(--surface,#fff)';
  dialog.innerHTML = `<form method="dialog"><button style="float:right" aria-label="${(globalThis.PlatformLanguage?.htmlText("documents","m_b68909450f4727","Close module editor") ?? "Close module editor")}">${(globalThis.PlatformLanguage?.htmlText("documents","m_3742924668fb10","Close") ?? "Close")}</button></form>
    <h2>${(globalThis.PlatformLanguage?.htmlText("documents","m_68b21459ee2100","Document modules") ?? "Document modules")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("documents","m_fe3a959009cd51","Create independent documents and workflows with declared data, code, and reusable document layouts. Existing signed documents stay unchanged.") ?? "Create independent documents and workflows with declared data, code, and reusable document layouts. Existing signed documents stay unchanged.")}</p>
    <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_44eba3dfebb355","Published module ") ?? "Published module ")}<select data-modules><option value="">${(globalThis.PlatformLanguage?.htmlText("documents","m_e52eb3cf6e86a4","New module") ?? "New module")}</option></select></label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_006d986794e9db","Name ") ?? "Name ")}<input data-name value="Estimate workflow" style="width:100%"></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_b2efb7e5eb919d","Kind ") ?? "Kind ")}<select data-kind><option value="workflow">${(globalThis.PlatformLanguage?.htmlText("documents","m_7dbbeae35a4717","Workflow") ?? "Workflow")}</option><option value="document">${(globalThis.PlatformLanguage?.htmlText("documents","m_9c9b98b1f4e8c9","Document") ?? "Document")}</option></select></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_0361a1fe0fb35a","Input JSON schema") ?? "Input JSON schema")}<textarea data-input-schema rows="5" style="width:100%"></textarea></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_51149eeec20cb6","Output JSON schema") ?? "Output JSON schema")}<textarea data-output-schema rows="5" style="width:100%"></textarea></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_d8e85b0a530052","Published exports") ?? "Published exports")}<textarea data-exports rows="6" style="width:100%"></textarea></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_04a28958ee6626","Data and action bindings") ?? "Data and action bindings")}<textarea data-bindings rows="6" style="width:100%">{}</textarea></label>
    </div>
    <p>${(globalThis.PlatformLanguage?.htmlText("documents","m_7b08730169bb04","Code receives ") ?? "Code receives ")}<code>${(globalThis.PlatformLanguage?.htmlText("documents","m_8b5499d2caa985","inputs") ?? "inputs")}</code>, <code>${(globalThis.PlatformLanguage?.htmlText("documents","m_e01c1a535af306","state") ?? "state")}</code>, <code>${(globalThis.PlatformLanguage?.htmlText("documents","m_c8caac68077565","api.data.read(name)") ?? "api.data.read(name)")}</code>, <code>${(globalThis.PlatformLanguage?.htmlText("documents","m_d2fb1e54cbdfd8","api.actions.invoke(name,input)") ?? "api.actions.invoke(name,input)")}</code>${(globalThis.PlatformLanguage?.htmlText("documents","m_1d9586e7817b5c"," and captured ") ?? " and captured ")}<code>${(globalThis.PlatformLanguage?.htmlText("documents","m_262122707ed922","api.now") ?? "api.now")}</code>${(globalThis.PlatformLanguage?.htmlText("documents","m_fde1da98af96b9",". Return ") ?? ". Return ")}<code>{outputs, privateState?, view?}</code>${(globalThis.PlatformLanguage?.htmlText("documents","m_578c9ab20bb0be",". Evaluate cannot perform external effects.") ?? ". Evaluate cannot perform external effects.")}</p>
    <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_516efe41a0d392","JavaScript") ?? "JavaScript")}<textarea data-source rows="9" spellcheck="false" style="width:100%;font-family:monospace"></textarea></label>
    <details><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_d82d0ec72506ae","Private state schema and optional DocModel layout") ?? "Private state schema and optional DocModel layout")}</summary><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_96b4650a5bafce","Private state schema") ?? "Private state schema")}<textarea data-private rows="4" style="width:100%">{"type":"object"}</textarea></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_55d3ed4e8c56d6","Renderer JSON (optional)") ?? "Renderer JSON (optional)")}<textarea data-renderer rows="6" style="width:100%"></textarea></label><button type="button" data-blank>${(globalThis.PlatformLanguage?.htmlText("documents","m_a96ca887c39091","Use blank document layout") ?? "Use blank document layout")}</button></details>
    <button type="button" data-publish>${(globalThis.PlatformLanguage?.htmlText("documents","m_4da85656d1ee77","Publish version") ?? "Publish version")}</button>
    <hr><h3>${(globalThis.PlatformLanguage?.htmlText("documents","m_767be0e86cb8f8","Project instances") ?? "Project instances")}</h3><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_421a0c0e04127f","Project ID ") ?? "Project ID ")}<input data-project></label><button type="button" data-list>${(globalThis.PlatformLanguage?.htmlText("documents","m_ea9003a58c378a","Load instances") ?? "Load instances")}</button>
    <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_19d5672c672a98","Instance ") ?? "Instance ")}<select data-instances><option value="">${(globalThis.PlatformLanguage?.htmlText("documents","m_47efedaf84e76f","New instance") ?? "New instance")}</option></select></label>
    <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_059f8abfdab708","Input values (JSON)") ?? "Input values (JSON)")}<textarea data-inputs rows="5" style="width:100%">{"hours":4,"rate":150}</textarea></label>
    <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_c195fef7a1a346","Binding overrides (JSON)") ?? "Binding overrides (JSON)")}<textarea data-overrides rows="4" style="width:100%">{}</textarea></label>
    <p><button type="button" data-create>${(globalThis.PlatformLanguage?.htmlText("documents","m_b712da264d369a","Create independent instance") ?? "Create independent instance")}</button> <button type="button" data-save>${(globalThis.PlatformLanguage?.htmlText("documents","m_33dcd283092afe","Save inputs") ?? "Save inputs")}</button> <button type="button" data-evaluate>${(globalThis.PlatformLanguage?.htmlText("documents","m_cb07942f8578c9","Evaluate") ?? "Evaluate")}</button> <button type="button" data-command>${(globalThis.PlatformLanguage?.htmlText("documents","m_7a6cfe9bc05241","Run command") ?? "Run command")}</button> <button type="button" data-freeze>${(globalThis.PlatformLanguage?.htmlText("documents","m_bb48291d2a831e","Freeze result") ?? "Freeze result")}</button> <button type="button" data-document>${(globalThis.PlatformLanguage?.htmlText("documents","m_c8b16daae3fdc2","Create portal document") ?? "Create portal document")}</button></p>
    <details><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_cd4f7970d53704","Generate a separate document from workflow exports") ?? "Generate a separate document from workflow exports")}</summary>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_816b6e7b551767","Document module ID ") ?? "Document module ID ")}<input data-generate-module></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_0ac02d75482884","Target binding name ") ?? "Target binding name ")}<input data-generate-binding value="estimate"></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_1a5e50c560cc68","Workflow export name ") ?? "Workflow export name ")}<input data-generate-export value="total"></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_c893ea0bf53cb4","Policy ") ?? "Policy ")}<select data-policy><option value="frozen">${(globalThis.PlatformLanguage?.htmlText("documents","m_e542847c9b465c","Frozen") ?? "Frozen")}</option><option value="live">${(globalThis.PlatformLanguage?.htmlText("documents","m_430a0cf632da94","Live") ?? "Live")}</option></select></label><button type="button" data-generate>${(globalThis.PlatformLanguage?.htmlText("documents","m_bf82b278ebbd0e","Generate document instance") ?? "Generate document instance")}</button>
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
    el('status').textContent = (globalThis.PlatformLanguage?.text("documents","m_0d8180a62bfe82","Working…") ?? "Working…");
    try { await task(); el('status').textContent = (globalThis.PlatformLanguage?.text("documents","m_47bbabb50774cf","Saved.") ?? "Saved."); }
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
