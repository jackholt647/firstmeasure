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
  dialog.innerHTML=`<form><h3>Initial inputs</h3>${schemaControls(schema)}<button type="submit">Create</button> <button type="button" data-cancel>Cancel</button><p role="status"></p></form>`;
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
    <strong>Data & behavior</strong><p style="margin:0">Connect published data, calculate values, and expose results. The visual builder continues to control the layout.</p>
    <label><input type="checkbox" data-enabled ${program.enabled ? 'checked' : ''}> Enable custom behavior</label>
    <label>JavaScript<textarea data-source rows="12" spellcheck="false" style="width:100%;font-family:monospace"></textarea></label>
    <small>Use inputs, state, api.data.read(name), and api.actions.invoke(name, values). Return { outputs, privateState?, view? }. api.mode distinguishes evaluation from an explicit command.</small>
    <details open><summary>Connected data and actions</summary><div data-catalog></div><label>Bindings<textarea data-bindings rows="8" style="width:100%"></textarea></label></details>
    <details><summary>Inputs and published outputs</summary>
      <label>Input schema<textarea data-inputSchema rows="7" style="width:100%"></textarea></label>
      <label>Output schema<textarea data-outputSchema rows="7" style="width:100%"></textarea></label>
      <label>Exports<textarea data-exports rows="7" style="width:100%"></textarea></label>
      <small>Each export has path (such as /outputs/total), schema, and access: read, write, or private. Writable exports address inputs. Workflow controls write params inputs; code owns calculated outputs.</small>
    </details><button type="button" data-apply>Apply behavior to this design</button><p role="status" data-status></p>
  </section>`;
  const el = key => host.querySelector(`[data-${key}]`);
  for (const key of ['source','bindings','inputSchema','outputSchema','exports']) el(key).value = key === 'source' ? program[key] : JSON.stringify(program[key], null, 2);
  el('apply').onclick = () => {
    try {
      const next = { ...program, enabled: el('enabled').checked, source: el('source').value };
      for (const key of ['bindings','inputSchema','outputSchema','exports']) next[key] = JSON.parse(el(key).value || '{}');
      if (next.enabled && !next.source.trim()) throw new Error('Code is required when custom behavior is enabled.');
      options.onChange(next); program = next;
      el('status').textContent = 'Applied. Save or publish the design to retain these changes.';
    } catch (error) { el('status').textContent = error.message; }
  };
  await mountBindingCatalog(el('catalog'), { organizationId: options.organizationId, executionKind: options.executionKind, onSelect(name, binding) {
    try { const bindings = JSON.parse(el('bindings').value || '{}'); bindings[name] = binding; el('bindings').value = JSON.stringify(bindings, null, 2); }
    catch (error) { el('status').textContent = error.message; }
  } });
}

export async function mountBindingCatalog(host, options) {
  host.innerHTML = '<p role="status">Loading published capabilities…</p>';
  try {
    const api = window.PlatformAPI;
    const base = new URL(api.baseUrl().replace(/\/platform\/?$/, '/publication'), location.href).href.replace(/\/$/, '');
    const catalog = await api.request(`${base}/organizations/${encodeURIComponent(options.organizationId)}/catalog?scope=all&executionKind=${encodeURIComponent(options.executionKind || "module")}`);
    if (!host.isConnected) return;
    const choices = [];
    for (const p of catalog.providers || []) for (const [name, entry] of Object.entries(p.exports)) choices.push({ label:`Data · ${p.id}.${name}`, kind:'data', provider:p.id, export:name, version:p.version, ...entry });
    for (const a of catalog.actions || []) choices.push({ label:`Action · ${a.id}`, kind:'action', ...a, access:a.policy });
    host.innerHTML = `<label>Published capability<input data-filter placeholder="Search data or actions" style="width:100%"></label><select data-choice size="5" style="width:100%;margin:8px 0"></select><p data-description></p>
      <label>Binding name<input data-name value="source" style="width:100%"></label>
      <label>Resource ID<input data-resource placeholder="For exports that select one record" style="width:100%"></label>
      <label>Policy<select data-policy><option value="live">Live</option><option value="frozen">Frozen</option></select></label>
      <button type="button" data-add>Add binding</button><details><summary>Contract</summary><pre data-contract style="white-space:pre-wrap;max-height:220px;overflow:auto"></pre></details>`;
    const el = name => host.querySelector(`[data-${name}]`);
    const render = () => { el('choice').replaceChildren(); choices.forEach((c,i) => { if (c.label.toLowerCase().includes(el('filter').value.toLowerCase())) el('choice').add(new Option(c.label,String(i))); }); };
    const selected = () => choices[Number(el('choice').value)];
    el('filter').oninput = render;
    el('choice').onchange = () => { const c = selected(); if (!c) return; el('description').textContent = c.description; el('contract').textContent = JSON.stringify(c.kind === 'data' ? { schema:c.schema, arguments:c.argsSchema, access:c.access } : { inputs:c.inputSchema, outputs:c.outputSchema, effect:c.effect, access:c.access },null,2); };
    el('add').onclick = () => {
      const c = selected(), name = el('name').value.trim();
      if (!c || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) { el('description').textContent = 'Choose a capability and a valid binding name.'; return; }
      const scope = c.access.scopes.includes('project') ? 'project' : c.access.scopes[0];
      const target = { scope, ...(scope === 'global' ? {} : { organizationId:'$organization' }), ...(scope === 'project' ? { projectId:'$project' } : {}), ...(el('resource').value.trim() ? { id:el('resource').value.trim() } : {}) };
      const binding = c.kind === 'data' ? { kind:'data',policy:el('policy').value,required:true,source:{provider:c.provider,version:c.version,export:c.export,target} } : { kind:'action',policy:el('policy').value,action:{action:c.id,version:c.version,target} };
      options.onSelect(name,binding); el('description').textContent = `Added ${name}. Fill any required arguments in its binding.`;
    };
    render(); el('choice').onchange();
  } catch (error) { host.textContent = `Catalog unavailable: ${error.message}`; }
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
  dialog.innerHTML = `<form method="dialog"><button style="float:right">Close</button></form><h2>Documents & workflows</h2><div style="display:flex;gap:12px;flex-wrap:wrap"><label>Published design <select data-modules></select></label><label>Code <select data-code><option value="frozen">Pinned version</option><option value="live">Follow published updates</option></select></label><button data-create>Create instance</button><label>Project instance <select data-instances></select></label></div><p role="status" data-status></p><p data-attempt role="alert"></p><details data-review hidden><summary>Review uncertain command</summary><p>Verify the recorded command and its effects in the affected app. Recording this review retains the last accepted result and allows a new explicit command; it does not repeat the previous command.</p><textarea data-review-note rows="3" placeholder="What happened, and what did you verify?" style="width:100%"></textarea><button data-reconcile>Record review & unlock</button></details><div data-inputs></div><details data-connections><summary>Instance bindings</summary><p>Choose live or frozen policy and resource IDs for declared bindings.</p><textarea data-bindings rows="8" style="width:100%"></textarea></details><div style="display:flex;gap:8px;margin:16px 0"><button data-save>Save & recalculate</button><button data-refresh>Refresh live data</button><button data-command>Run command</button><button data-freeze>Freeze result</button><button data-document>Create portal document</button></div><div data-preview></div><details><summary>Published values</summary><pre data-output></pre></details>`;
  document.body.append(dialog); dialog.showModal();
  const el = key => dialog.querySelector(`[data-${key}]`);
  let instance, handle, busy = false, commandKey, edited = false;
  let workflowValues = null;
  const perform = async task => { if (busy) return; busy = true; el('status').textContent = 'Working…'; try { await task(); el('status').textContent = instance?.frozen ? 'Frozen result · retained values and source versions.' : 'Up to date.'; } catch(error) { if(instance && !edited) { try {show(await request(path()));if(instance.lastAttempt?.status==='failed')commandKey=null;}catch{} } el('status').textContent = error.message; } finally { busy = false; } };
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
  el('document').onclick=()=>perform(async()=>{const result=await request(`${path()}/document`,'POST',{}); el('output').textContent=`Portal document created: ${result.document.id}`;});
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
  dialog.innerHTML = `<form method="dialog"><button style="float:right">Close</button></form><h2>Scope data & behavior</h2><p>Programs run at their configured trigger using the publishing author's current access. Existing project plans retain their saved version.</p><label>Plan or task <select data-owner></select></label> <label>Trigger <select data-hook><option value="onStarted">Started</option><option value="onActivated">Activated</option><option value="onCompleted">Completed</option><option value="onUpdated">Updated</option></select></label><br><label>Program <select data-program></select></label> <button data-new>New program</button><label style="display:block">Program name <input data-id value="calculate"></label><label>Execution <select data-mode><option value="evaluate">Calculate only</option><option value="command">Allow declared actions</option></select></label><label> Code policy <select data-code-policy><option value="frozen">Pin code for each scope instance</option><option value="live">Use the plan's current code</option></select></label><label style="display:block">Initial inputs (JSON)<textarea data-initial rows="3" style="width:100%">{}</textarea></label><div data-panel></div><button data-save>Save scope version</button><p role="status" data-status></p>`;
  document.body.append(dialog); dialog.showModal();
  const el = key => dialog.querySelector(`[data-${key}]`);
  const owners = [{label:'Entire plan',value:definition.work_plan}];
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
      template.version=saved.version; el('status').textContent='Scope version saved. New plans use this version.'; options.onSaved?.(saved); list(owner.automation_bindings[hook].at(-1).id);
    } catch(error) {el('status').textContent=error.message;} finally {el('save').disabled=false;}
  };
  dialog.addEventListener('close',()=>dialog.remove());list();
}
