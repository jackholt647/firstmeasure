const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function surface(host) {
  host.classList.add('fm-program-surface');
  if(document.getElementById('fm-program-style'))return;
  const style=document.createElement('style');style.id='fm-program-style';style.textContent=`
  .fm-program-surface{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#243247;background:#fff;box-sizing:border-box}
  .fm-program-surface *{box-sizing:border-box}.fm-program-surface::backdrop{background:rgba(15,23,42,.48)}
  .fm-program-surface h2{font-size:23px;letter-spacing:-.5px;margin:0 0 18px}.fm-program-surface h3{font-size:18px}
  .fm-program-surface p,.fm-program-surface small{color:#627086}.fm-program-surface label{font-weight:550}
  .fm-program-surface input:not([type=checkbox]),.fm-program-surface textarea,.fm-program-surface select{font:inherit;color:inherit;border:1px solid #cdd5df;border-radius:7px;padding:8px;background:#fff;max-width:100%}
  .fm-program-surface textarea{font:12px/1.6 ui-monospace,Consolas,monospace;resize:vertical;margin-top:6px}.fm-program-surface input:focus,.fm-program-surface textarea:focus,.fm-program-surface select:focus{outline:2px solid #80a8e5;outline-offset:1px}
  .fm-program-surface button{font:600 12px/1.4 system-ui,sans-serif;border:1px solid #cdd5df;border-radius:7px;padding:9px 13px;background:#f8fafc;color:#334155;cursor:pointer}
  .fm-program-surface button:hover{background:#eaf0f8}.fm-program-surface button:disabled{opacity:.45;cursor:default}.fm-program-surface button[data-save],.fm-program-surface button[data-apply],.fm-program-surface button[type=submit]{background:#235c9d;color:white;border-color:#235c9d}
  .fm-program-surface details{border:1px solid #e3e8ef;border-radius:8px;padding:12px;margin:8px 0}.fm-program-surface summary{cursor:pointer;font-weight:600}.fm-program-surface pre{white-space:pre-wrap;overflow:auto;background:#f5f7fb;padding:12px;border-radius:7px}
  .fm-program-surface [role=status]:not(:empty){background:#f0f5fb;border-radius:7px;padding:10px 12px}.fm-program-surface [data-catalog]>label{display:block;margin:10px 0}
  .fm-program-surface [data-preview]{overflow:auto}.fm-program-surface [data-preview]:empty{display:none}
  `;document.head.append(style);
}
function schemaControls(schema, values = {}) {
  return Object.entries(schema?.properties || {}).map(([key,field]) => {
    const required = (schema.required || []).includes(key) ? 'required' : '';
    const value = values[key] ?? field.default;
    const control = field.enum ? `<select data-field="${esc(key)}" data-type="${esc(field.type)}">${field.enum.map(v=>`<option value="${esc(JSON.stringify(v))}" ${v===value?'selected':''}>${esc(v)}</option>`).join('')}</select>`
      : field.type === 'boolean' ? `<input type="checkbox" data-field="${esc(key)}" ${value?'checked':''}>`
      : ['object','array'].includes(field.type) ? `<textarea data-field="${esc(key)}" data-type="${field.type}" ${required}>${esc(JSON.stringify(value ?? (field.type==='array'?[]:{}),null,2))}</textarea>`
      : `<input data-field="${esc(key)}" data-type="${esc(field.type)}" type="${['number','integer'].includes(field.type)?'number':'text'}" ${field.type==='number'?'step="any"':''} value="${esc(value ?? '')}" ${required}>`;
    return `<label style="display:grid;gap:4px;margin:10px 0">${esc(field.title || key)}${control}</label>`;
  }).join('');
}
function readControls(host, initial = {}) {
  const result=clone(initial);
  for(const control of host.querySelectorAll('[data-field]')) {
    if(!control.checkValidity()) {control.reportValidity();throw new Error('Complete the required inputs.');}
    const kind=control.dataset.type;
    if(control.tagName==='SELECT')result[control.dataset.field]=JSON.parse(control.value);
    else if(control.type==='checkbox')result[control.dataset.field]=control.checked;
    else if(['number','integer'].includes(kind)){if(control.value===''){delete result[control.dataset.field];continue;}result[control.dataset.field]=Number(control.value);}
    else result[control.dataset.field]=['object','array'].includes(kind)?JSON.parse(control.value):control.value;
  }
  return result;
}
async function initialInputs(schema) {
  const dialog=document.createElement('dialog');surface(dialog);dialog.style.cssText='width:min(550px,90vw);max-height:85vh;overflow:auto;padding:24px';
  dialog.innerHTML=`<form><h3>${(globalThis.PlatformLanguage?.htmlText("documents","m_ab60675f59df94","Initial inputs") ?? "Initial inputs")}</h3>${schemaControls(schema)}<button type="submit">${(globalThis.PlatformLanguage?.htmlText("documents","m_3c21a9590eb762","Create") ?? "Create")}</button> <button type="button" data-cancel>${(globalThis.PlatformLanguage?.htmlText("documents","m_cbef679b21abb4","Cancel") ?? "Cancel")}</button><p role="status"></p></form>`;
  document.body.append(dialog);dialog.showModal();
  return new Promise(resolve=>{let result=null;dialog.querySelector('form').onsubmit=event=>{event.preventDefault();try{result=readControls(dialog);dialog.close();}catch(error){dialog.querySelector('[role=status]').textContent=error.message;}};dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dialog.remove();resolve(result);});});
}
export function moduleRequest(organizationId) {
  const api = window.PlatformAPI;
  const base = new URL(api.baseUrl().replace(/\/platform\/?$/, '/document-modules'), location.href).href.replace(/\/$/, '');
  return (path, method = 'GET', body) => api.request(`${base}/organizations/${encodeURIComponent(organizationId)}${path}`, { method, ...(body === undefined ? {} : { body }) });
}

/** Shared authoring panel mounted by the existing document and workflow builders. */
export async function mountProgramPanel(host, options) {
  surface(host);
  let program = clone(options.getProgram?.() || {});
  const defaults = { enabled: false, inputSchema: { type:'object', properties:{} }, outputSchema: { type:'object', properties:{} }, exports:{}, bindings:{}, source:'return { outputs: { ...inputs } };' };
  program = { ...defaults, ...program };
  host.innerHTML = `<section style="padding:16px;display:grid;gap:14px;font-size:12px">
    <strong>${(globalThis.PlatformLanguage?.htmlText("documents","m_f8e3874860785b","Data & behavior") ?? "Data & behavior")}</strong><p style="margin:0">${(globalThis.PlatformLanguage?.htmlText("documents","m_d64eb158b8a6c9","Connect published data, calculate values, and expose results. The visual builder continues to control the layout.") ?? "Connect published data, calculate values, and expose results. The visual builder continues to control the layout.")}</p>
    <label><input type="checkbox" data-enabled ${program.enabled ? 'checked' : ''}>${(globalThis.PlatformLanguage?.htmlText("documents","m_56a03fdd7a6c37"," Enable custom behavior") ?? " Enable custom behavior")}</label>
    <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_516efe41a0d392","JavaScript") ?? "JavaScript")}<textarea data-source rows="12" spellcheck="false" style="width:100%;font-family:monospace"></textarea></label>
    <small>Use inputs, state, api.data.read(name), and api.actions.invoke(name, values). Return { outputs, privateState?, view? }. api.mode distinguishes evaluation from an explicit command.</small>
    <details open><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_605ba37c1b1fb8","Connected data and actions") ?? "Connected data and actions")}</summary><div data-catalog></div><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_db1852c8bf6b55","Bindings") ?? "Bindings")}<textarea data-bindings rows="8" style="width:100%"></textarea></label></details>
    <details><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_c7cd70e4a1ea79","Inputs and published outputs") ?? "Inputs and published outputs")}</summary>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_ae6e64ee3f6845","Input schema") ?? "Input schema")}<textarea data-inputSchema rows="7" style="width:100%"></textarea></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_4eb9a4a3047e30","Output schema") ?? "Output schema")}<textarea data-outputSchema rows="7" style="width:100%"></textarea></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_d697bbeec653a1","Exports") ?? "Exports")}<textarea data-exports rows="7" style="width:100%"></textarea></label>
      <small>${(globalThis.PlatformLanguage?.htmlText("documents","m_c4837daf1b3ad0","Each export has path (such as /outputs/total), schema, and access: read, write, or private. Writable exports address inputs. Workflow controls write params inputs; code owns calculated outputs.") ?? "Each export has path (such as /outputs/total), schema, and access: read, write, or private. Writable exports address inputs. Workflow controls write params inputs; code owns calculated outputs.")}</small>
    </details><button type="button" data-apply>${(globalThis.PlatformLanguage?.htmlText("documents","m_53a1260a13e590","Apply behavior to this design") ?? "Apply behavior to this design")}</button><p role="status" data-status></p>
  </section>`;
  const el = key => host.querySelector(`[data-${key}]`);
  for (const key of ['source','bindings','inputSchema','outputSchema','exports']) el(key).value = key === 'source' ? program[key] : JSON.stringify(program[key], null, 2);
  el('apply').onclick = () => {
    try {
      const next = { ...program, enabled: el('enabled').checked, source: el('source').value };
      for (const key of ['bindings','inputSchema','outputSchema','exports']) next[key] = JSON.parse(el(key).value || '{}');
      if (next.enabled && !next.source.trim()) throw new Error('Code is required when custom behavior is enabled.');
      options.onChange(next); program = next;
      el('status').textContent = (globalThis.PlatformLanguage?.text("documents","m_01d9d6f2080583","Applied. Save or publish the design to retain these changes.") ?? "Applied. Save or publish the design to retain these changes.");
    } catch (error) { el('status').textContent = error.message; }
  };
  await mountBindingCatalog(el('catalog'), { organizationId: options.organizationId, executionKind: options.executionKind, onSelect(name, binding) {
    try { const bindings = JSON.parse(el('bindings').value || '{}'); bindings[name] = binding; el('bindings').value = JSON.stringify(bindings, null, 2); }
    catch (error) { el('status').textContent = error.message; }
  } });
}

export async function mountBindingCatalog(host, options) {
  host.innerHTML = `<p role="status">${(globalThis.PlatformLanguage?.htmlText("documents","m_63e6d82edc25f2","Loading published capabilities…") ?? "Loading published capabilities…")}</p>`;
  try {
    const api = window.PlatformAPI;
    const base = new URL(api.baseUrl().replace(/\/platform\/?$/, '/publication'), location.href).href.replace(/\/$/, '');
    const catalog = await api.request(`${base}/organizations/${encodeURIComponent(options.organizationId)}/catalog?scope=all&executionKind=${encodeURIComponent(options.executionKind || "module")}`);
    if (!host.isConnected) return;
    const choices = [];
    for (const p of catalog.providers || []) for (const [name, entry] of Object.entries(p.exports)) choices.push({ label:((v0,v1) => globalThis.PlatformLanguage?.text("documents","m_cd2865dc2ffe4e",`Data · ${v0}.${v1}`,{v0,v1}) ?? `Data · ${v0}.${v1}`)(p.id,name), kind:'data', provider:p.id, export:name, version:p.version, ...entry });
    for (const a of catalog.actions || []) choices.push({ label:((v0) => globalThis.PlatformLanguage?.text("documents","m_99ae395d438f37",`Action · ${v0}`,{v0}) ?? `Action · ${v0}`)(a.id), kind:'action', ...a, access:a.policy });
    host.innerHTML = `<label>${(globalThis.PlatformLanguage?.htmlText("documents","m_ed07a9385e3b17","Published capability") ?? "Published capability")}<input data-filter placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_c237018b6f343c","Search data or actions") ?? "Search data or actions")}" style="width:100%"></label><select data-choice size="5" style="width:100%;margin:8px 0"></select><p data-description></p>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_6524d61739faf0","Binding name") ?? "Binding name")}<input data-name value="source" style="width:100%"></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_b5fbd856d3ffa7","Resource ID") ?? "Resource ID")}<input data-resource placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_0b41802d9e0109","For exports that select one record") ?? "For exports that select one record")}" style="width:100%"></label>
      <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_de24af4062bcb4","Policy") ?? "Policy")}<select data-policy><option value="live">${(globalThis.PlatformLanguage?.htmlText("documents","m_430a0cf632da94","Live") ?? "Live")}</option><option value="frozen">${(globalThis.PlatformLanguage?.htmlText("documents","m_e542847c9b465c","Frozen") ?? "Frozen")}</option></select></label>
      <button type="button" data-add>${(globalThis.PlatformLanguage?.htmlText("documents","m_ded8af0bcce7df","Add binding") ?? "Add binding")}</button><details><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_06c8cfa66b1dbc","Contract") ?? "Contract")}</summary><pre data-contract style="white-space:pre-wrap;max-height:220px;overflow:auto"></pre></details>`;
    const el = name => host.querySelector(`[data-${name}]`);
    const render = () => { el('choice').replaceChildren(); choices.forEach((c,i) => { if (c.label.toLowerCase().includes(el('filter').value.toLowerCase())) el('choice').add(new Option(c.label,String(i))); }); };
    const selected = () => choices[Number(el('choice').value)];
    el('filter').oninput = render;
    el('choice').onchange = () => { const c = selected(); if (!c) return; el('description').textContent = c.description; el('contract').textContent = JSON.stringify(c.kind === 'data' ? { schema:c.schema, arguments:c.argsSchema, access:c.access } : { inputs:c.inputSchema, outputs:c.outputSchema, effect:c.effect, access:c.access },null,2); };
    el('add').onclick = () => {
      const c = selected(), name = el('name').value.trim();
      if (!c || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) { el('description').textContent = (globalThis.PlatformLanguage?.text("documents","m_89a3f699c4f364","Choose a capability and a valid binding name.") ?? "Choose a capability and a valid binding name."); return; }
      const scope = c.access.scopes.includes('project') ? 'project' : c.access.scopes[0];
      const target = { scope, ...(scope === 'global' ? {} : { organizationId:'$organization' }), ...(scope === 'project' ? { projectId:'$project' } : {}), ...(el('resource').value.trim() ? { id:el('resource').value.trim() } : {}) };
      const binding = c.kind === 'data' ? { kind:'data',policy:el('policy').value,required:true,source:{provider:c.provider,version:c.version,export:c.export,target} } : { kind:'action',policy:el('policy').value,action:{action:c.id,version:c.version,target} };
      options.onSelect(name,binding); el('description').textContent = ((v0) => globalThis.PlatformLanguage?.text("documents","m_530978bb231ba7",`Added ${v0}. Fill any required arguments in its binding.`,{v0}) ?? `Added ${v0}. Fill any required arguments in its binding.`)(name);
    };
    render(); el('choice').onchange();
  } catch (error) { host.textContent = ((v0) => globalThis.PlatformLanguage?.text("documents","m_51d6e40d44039d",`Catalog unavailable: ${v0}`,{v0}) ?? `Catalog unavailable: ${v0}`)(error.message); }
}

const runtimeLoads=new Map();
async function ensureRuntime(globalName,url){
  if(window[globalName])return;
  if(!runtimeLoads.has(url))runtimeLoads.set(url,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=resolve;script.onerror=()=>{runtimeLoads.delete(url);reject(new Error('Could not load the document renderer.'));};document.head.append(script);}));
  await runtimeLoads.get(url);
}
/** Project users work with schema inputs and the existing workflow renderer. */
export async function openModuleInstances(organizationId, projectId, selectedModuleId = '') {
  const request = moduleRequest(organizationId);
  await ensureRuntime('FMDocModel','/libraries/doc-model/firstmate-doc-model.js');
  await ensureRuntime('FMDocWorkflow','/libraries/doc-workflow/firstmate-doc-workflow.js');
  await ensureRuntime('FMDocRenderer','/libraries/doc-renderer/firstmate-doc-renderer.js');
  const dialog = document.createElement('dialog');surface(dialog);
  dialog.style.cssText = 'width:min(1050px,95vw);max-height:94vh;overflow:auto;padding:24px;border:1px solid #d0d5dd;border-radius:12px';
  dialog.innerHTML = `<form method="dialog"><button style="float:right">${(globalThis.PlatformLanguage?.htmlText("documents","m_3742924668fb10","Close") ?? "Close")}</button></form><h2>${(globalThis.PlatformLanguage?.htmlText("documents","m_abe699167c0dad","Documents & workflows") ?? "Documents & workflows")}</h2><div style="display:flex;gap:12px;flex-wrap:wrap"><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_b4475a73bc382c","Published design ") ?? "Published design ")}<select data-modules></select></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_7ef14a97e46ed5","Code ") ?? "Code ")}<select data-code><option value="frozen">${(globalThis.PlatformLanguage?.htmlText("documents","m_c06239d1eadef2","Pinned version") ?? "Pinned version")}</option><option value="live">${(globalThis.PlatformLanguage?.htmlText("documents","m_fa6735ecbdb187","Follow published updates") ?? "Follow published updates")}</option></select></label><button data-create>${(globalThis.PlatformLanguage?.htmlText("documents","m_728257cbafbb08","Create instance") ?? "Create instance")}</button><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_3ed739a51d7d68","Project instance ") ?? "Project instance ")}<select data-instances></select></label></div><p role="status" data-status></p><p data-attempt role="alert"></p><details data-review hidden><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_4260e85b469e2c","Review uncertain command") ?? "Review uncertain command")}</summary><p>${(globalThis.PlatformLanguage?.htmlText("documents","m_d05c383f26e81a","Verify the recorded command and its effects in the affected app. Recording this review retains the last accepted result and allows a new explicit command; it does not repeat the previous command.") ?? "Verify the recorded command and its effects in the affected app. Recording this review retains the last accepted result and allows a new explicit command; it does not repeat the previous command.")}</p><textarea data-review-note rows="3" placeholder="${(globalThis.PlatformLanguage?.htmlText("documents","m_598b1cf398c094","What happened, and what did you verify?") ?? "What happened, and what did you verify?")}" style="width:100%"></textarea><button data-reconcile>${(globalThis.PlatformLanguage?.htmlText("documents","m_4f6aff69606818","Record review & unlock") ?? "Record review & unlock")}</button></details><div data-inputs></div><details data-connections><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_8c2e5307262ed7","Instance bindings") ?? "Instance bindings")}</summary><p>${(globalThis.PlatformLanguage?.htmlText("documents","m_42571d8de6e368","Choose live or frozen policy and resource IDs for declared bindings.") ?? "Choose live or frozen policy and resource IDs for declared bindings.")}</p><textarea data-bindings rows="8" style="width:100%"></textarea></details><div style="display:flex;gap:8px;margin:16px 0"><button data-save>${(globalThis.PlatformLanguage?.htmlText("documents","m_4841765b925deb","Save & recalculate") ?? "Save & recalculate")}</button><button data-refresh>${(globalThis.PlatformLanguage?.htmlText("documents","m_61a69fff17a6ce","Refresh live data") ?? "Refresh live data")}</button><button data-command>${(globalThis.PlatformLanguage?.htmlText("documents","m_7a6cfe9bc05241","Run command") ?? "Run command")}</button><button data-freeze>${(globalThis.PlatformLanguage?.htmlText("documents","m_bb48291d2a831e","Freeze result") ?? "Freeze result")}</button><button data-document>${(globalThis.PlatformLanguage?.htmlText("documents","m_c8b16daae3fdc2","Create portal document") ?? "Create portal document")}</button></div><div data-preview></div><details><summary>${(globalThis.PlatformLanguage?.htmlText("documents","m_219c27b55c0a55","Published values") ?? "Published values")}</summary><pre data-output></pre></details>`;
  document.body.append(dialog); dialog.showModal();
  const el = key => dialog.querySelector(`[data-${key}]`);
  let instance, handle, busy = false, commandKey, edited = false;
  let workflowValues = null;
  const perform = async task => { if (busy) return; busy = true; el('status').textContent = (globalThis.PlatformLanguage?.text("documents","m_0d8180a62bfe82","Working…") ?? "Working…"); try { await task(); el('status').textContent = instance?.frozen ? 'Frozen result · retained values and source versions.' : 'Up to date.'; } catch(error) { if(instance && !edited) { try {show(await request(path()));if(instance.lastAttempt?.status==='failed')commandKey=null;}catch{} } el('status').textContent = error.message; } finally { busy = false; } };
  const path = () => { if (!instance) throw new Error('Create or select an instance first.'); return `/instances/${encodeURIComponent(instance.id)}`; };
  const values = () => {
    if (workflowValues) return clone(workflowValues);
    return readControls(el('inputs'),instance?.inputs || {});
  };
  const show = result => {
    instance = result.instance; edited = false; workflowValues = null;
    el('attempt').textContent=instance.lastAttempt?.error ? `Last command: ${instance.lastAttempt.status}. ${instance.lastAttempt.error}` : '';
    el('review').hidden=!(instance.uncertainExecution && instance.canReconcile);
    handle?.destroy?.(); handle = null; el('preview').replaceChildren();
    el('inputs').innerHTML = schemaControls(instance.inputSchema,instance.inputs);
    el('inputs').oninput = () => { edited = true; };
    for(const control of el('inputs').querySelectorAll('input,select,textarea'))control.disabled=instance.frozen || !!instance.uncertainExecution || !instance.canEdit;
    el('connections').hidden=!instance.canEdit;el('bindings').value=JSON.stringify(instance.bindings||{},null,2);el('bindings').disabled=instance.frozen || !!instance.uncertainExecution;el('bindings').oninput=()=>{edited=true;};
    if (instance.workflow && window.FMDocWorkflow?.mount) {
      el('inputs').hidden = true; workflowValues = clone(instance.inputs || {});
      handle = window.FMDocWorkflow.mount(el('preview'), { workflow:instance.workflow,state:{params:workflowValues,outputs:instance.exports},audience:'internal',readonly:instance.frozen || !!instance.uncertainExecution || !instance.canEdit,
        onWrite(target,value) { if (!target.startsWith('params.')) return; const parts=target.slice(7).split('.'); if(parts.some(p=>['__proto__','constructor','prototype'].includes(p))) return; let parent=workflowValues; for(const p of parts.slice(0,-1)) parent=parent[p] ||= {}; parent[parts.at(-1)]=value; edited=true; },
        onComplete() { void perform(save); } });
    } else { el('inputs').hidden = false; if (instance.view && window.FMDocRenderer?.render) handle = window.FMDocRenderer.render(el('preview'), { document:instance.view,mode:'static',readonly:true,widgetData:{} }); }
    el('output').textContent = JSON.stringify(instance.exports,null,2);
    for(const name of ['save','refresh','command','freeze']) el(name).disabled = instance.frozen || !!instance.uncertainExecution || !instance.canEdit;
    el('command').disabled ||= !Object.values(instance.bindings||{}).some(b=>b.kind==='action');
    el('document').disabled = !instance.canEdit || !!instance.uncertainExecution || instance.kind !== 'document' || !instance.lastExecutionId;
  };
  const reloadList = async () => { const data=await request(`/instances?projectId=${encodeURIComponent(projectId)}`); el('instances').replaceChildren(new Option('Select an instance','')); for(const i of data.instances) el('instances').add(new Option(`${i.kind} · ${i.moduleId} · ${i.id.slice(-8)}${i.frozen?' · frozen':''}`,i.id)); if(instance) el('instances').value=instance.id; };
  const refresh = async () => show(await request(`${path()}/refresh`,'POST',{expectedRevision:instance.revision}));
  const save = async () => { const input=values(),bindings=JSON.parse(el('bindings').value); if(JSON.stringify(bindings)!==JSON.stringify(instance.bindings)) { instance=(await request(`${path()}/bindings`,'PATCH',{bindings,expectedRevision:instance.revision})).instance; } show(await request(path(),'PATCH',{inputs:input,expectedRevision:instance.revision})); commandKey=null; await refresh(); };
  el('create').onclick = () => perform(async()=>{ if(!el('modules').value)throw new Error('Publish a design in the builder first.'); const module=(await request(`/modules/${encodeURIComponent(el('modules').value)}`)).module; const inputs=await initialInputs(module.definition.inputSchema);if(inputs===null)return;
    show(await request('/instances','POST',{moduleId:el('modules').value,codePolicy:el('code').value,projectId,inputs})); await reloadList(); await refresh(); });
  el('instances').onchange = () => perform(async()=>{ if(el('instances').value) show(await request(`/instances/${encodeURIComponent(el('instances').value)}`)); });
  el('save').onclick=()=>perform(save); el('refresh').onclick=()=>perform(async()=>{if(edited)await save();else await refresh();});
  el('command').onclick=()=>perform(async()=>{if(edited) await save(); commandKey ||= crypto.randomUUID(); show(await request(`${path()}/command`,'POST',{expectedRevision:instance.revision,idempotencyKey:commandKey})); commandKey=null;});
  el('freeze').onclick=()=>perform(async()=>{if(edited) await save(); else await refresh(); show(await request(`${path()}/freeze`,'POST',{expectedRevision:instance.revision}));});
  el('reconcile').onclick=()=>perform(async()=>{const note=el('review-note').value.trim();if(note.length<10)throw new Error('Describe the review before unlocking this command.');show(await request(`${path()}/reconcile`,'POST',{expectedRevision:instance.revision,executionId:instance.uncertainExecution,note}));commandKey=null;});
  el('document').onclick=()=>perform(async()=>{const result=await request(`${path()}/document`,'POST',{}); el('output').textContent=((v0) => globalThis.PlatformLanguage?.text("documents","m_1caafc386fd960",`Portal document created: ${v0}`,{v0}) ?? `Portal document created: ${v0}`)(result.document.id);});
  const timer=setInterval(()=>{if(!instance||!instance.canEdit||instance.frozen||instance.uncertainExecution||busy||edited||document.hidden)return; void perform(async()=>{if((await request(`${path()}/freshness`)).stale)await refresh();});},10000);
  dialog.addEventListener('close',()=>{clearInterval(timer);handle?.destroy?.();dialog.remove();});
  await perform(async()=>{const {modules}=await request('/modules'); for(const m of modules)el('modules').add(new Option(`${m.name} (${m.kind})`,m.id)); if(selectedModuleId)el('modules').value=selectedModuleId; await reloadList();});
}


/** Scope programs share the module sandbox and catalog, with explicit event hooks. */
export async function openScopePrograms(options) {
  const template = await options.read();
  const definition = clone(template.definition);
  const dialog = document.createElement('dialog');surface(dialog);
  dialog.style.cssText = 'width:min(950px,94vw);max-height:94vh;overflow:auto;border:1px solid #d0d5dd;border-radius:12px;padding:24px';
  dialog.innerHTML = `<form method="dialog"><button style="float:right">${(globalThis.PlatformLanguage?.htmlText("documents","m_3742924668fb10","Close") ?? "Close")}</button></form><h2>${(globalThis.PlatformLanguage?.htmlText("documents","m_517e5bcb9215a6","Scope data & behavior") ?? "Scope data & behavior")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("documents","m_0091ec45e4edca","Programs run at their configured trigger using the publishing author's current access. Existing project plans retain their saved version.") ?? "Programs run at their configured trigger using the publishing author's current access. Existing project plans retain their saved version.")}</p><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_8efc8e94ed6223","Plan or task ") ?? "Plan or task ")}<select data-owner></select></label> <label>${(globalThis.PlatformLanguage?.htmlText("documents","m_72cdd63dcac4e9","Trigger ") ?? "Trigger ")}<select data-hook><option value="onStarted">${(globalThis.PlatformLanguage?.htmlText("documents","m_705b16f536b804","Started") ?? "Started")}</option><option value="onActivated">${(globalThis.PlatformLanguage?.htmlText("documents","m_f1542bbe19bdd9","Activated") ?? "Activated")}</option><option value="onCompleted">${(globalThis.PlatformLanguage?.htmlText("documents","m_3c4d2141b2fa1c","Completed") ?? "Completed")}</option><option value="onUpdated">${(globalThis.PlatformLanguage?.htmlText("documents","m_6a171239c315c1","Updated") ?? "Updated")}</option></select></label><br><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_43b471e272e60f","Program ") ?? "Program ")}<select data-program></select></label> <button data-new>${(globalThis.PlatformLanguage?.htmlText("documents","m_a40d0357ef87d6","New program") ?? "New program")}</button><label style="display:block">${(globalThis.PlatformLanguage?.htmlText("documents","m_3060c885697e2a","Program name ") ?? "Program name ")}<input data-id value="calculate"></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_afbc30292d9718","Execution ") ?? "Execution ")}<select data-mode><option value="evaluate">${(globalThis.PlatformLanguage?.htmlText("documents","m_6b51c169a923fb","Calculate only") ?? "Calculate only")}</option><option value="command">${(globalThis.PlatformLanguage?.htmlText("documents","m_e12bc3953ed381","Allow declared actions") ?? "Allow declared actions")}</option></select></label><label>${(globalThis.PlatformLanguage?.htmlText("documents","m_6b98423bf36de5"," Code policy ") ?? " Code policy ")}<select data-code-policy><option value="frozen">${(globalThis.PlatformLanguage?.htmlText("documents","m_133e68b878ea89","Pin code for each scope instance") ?? "Pin code for each scope instance")}</option><option value="live">${(globalThis.PlatformLanguage?.htmlText("documents","m_ffa09a236996f6","Use the plan's current code") ?? "Use the plan's current code")}</option></select></label><label style="display:block">${(globalThis.PlatformLanguage?.htmlText("documents","m_74ad498594c0ac","Initial inputs (JSON)") ?? "Initial inputs (JSON)")}<textarea data-initial rows="3" style="width:100%">{}</textarea></label><div data-panel></div><button data-save>${(globalThis.PlatformLanguage?.htmlText("documents","m_bf364e4e682d22","Save scope version") ?? "Save scope version")}</button><p role="status" data-status></p>`;
  document.body.append(dialog); dialog.showModal();
  const el = key => dialog.querySelector(`[data-${key}]`);
  const owners = [{label:(globalThis.PlatformLanguage?.text("documents","m_bbad3c5157576d","Entire plan") ?? "Entire plan"),value:definition.work_plan}];
  function visit(nodes, prefix='') { for (const node of nodes || []) { owners.push({label:prefix+(node.title || node.id), value:node}); visit(node.children,prefix+'  '); } }
  visit(definition.work_plan.root_nodes);
  owners.forEach((owner,i)=>el('owner').add(new Option(owner.label,String(i))));
  let selected = null, program = {}, applied = false;
  const entries = () => owners[Number(el('owner').value)].value.automation_bindings?.[el('hook').value] || [];
  const load = () => {
    selected = entries().find(b=>b.id === el('program').value) || null;
    program = clone(selected?.input || {id:'calculate',mode:'evaluate',policy:'frozen',inputs:{},inputSchema:{type:'object'},outputSchema:{type:'object'},bindings:{},source:'return { outputs: { ...inputs } };'});
    el('id').value = program.id; el('mode').value = program.mode || 'evaluate'; el('code-policy').value=program.policy||'frozen'; el('initial').value=JSON.stringify(program.inputs||{},null,2); applied=false;
    void mountProgramPanel(el('panel'),{organizationId:options.organizationId,executionKind:'work',getProgram:()=>({...program,enabled:selected?.enabled!==false}),onChange:next=>{program=next;applied=true;}});
  };
  const list = (selection = '') => { el('program').replaceChildren(new Option('New program','')); for(const b of entries().filter(b=>b.automation==='scope.code.run.v1')) el('program').add(new Option(b.input?.id||b.id,b.id)); el('program').value=selection;load(); };
  el('owner').onchange=()=>list();el('hook').onchange=()=>list();el('program').onchange=load;el('new').onclick=()=>{el('program').value='';load();};
  el('save').onclick=async()=>{
    try {
      if(!applied) throw new Error('Apply behavior to this design before saving.');
      const id=el('id').value.trim(); if(!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(id))throw new Error('Use a program name starting with a letter.');
      const input={id,source:program.source,policy:el('code-policy').value,mode:el('mode').value,inputs:JSON.parse(el('initial').value),inputSchema:program.inputSchema,outputSchema:program.outputSchema,bindings:program.bindings};
      const owner=owners[Number(el('owner').value)].value, hook=el('hook').value;
      const remaining=entries().filter(b=>b!==selected);
      if(remaining.some(b=>b.automation==='scope.code.run.v1'&&b.input?.id===id))throw new Error('Choose a unique program name for this trigger.');
      const previousBindings=owner.automation_bindings;
      owner.automation_bindings={...previousBindings,[hook]:[...remaining,{id:selected?.id || 'program_'+crypto.randomUUID(),automation:'scope.code.run.v1',enabled:program.enabled,input}]};
      el('save').disabled=true;
      let saved;
      try { saved=await options.save({...definition,expected_version:template.version}); }
      catch(error) { owner.automation_bindings=previousBindings; throw error; }
      template.version=saved.version; el('status').textContent=(globalThis.PlatformLanguage?.text("documents","m_9d5f6a454749fd","Scope version saved. New plans use this version.") ?? "Scope version saved. New plans use this version."); options.onSaved?.(saved); list(owner.automation_bindings[hook].at(-1).id);
    } catch(error) {el('status').textContent=error.message;} finally {el('save').disabled=false;}
  };
  dialog.addEventListener('close',()=>dialog.remove());list();
}
