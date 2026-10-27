// Operations uses the document workflow player and the ordinary guide player.
// This file owns only their presentation; documents, artifacts and setup progress live on the server.
const array=value=>Array.isArray(value)?value:[];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const copy=(key,fallback)=>window.PlatformLanguage?.text?.('guided-experiences',key,fallback)??fallback;
const scripts=new Map();
function loadScript(path){
  if(!scripts.has(path))scripts.set(path,new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src=path;script.onload=resolve;script.onerror=()=>{script.remove();scripts.delete(path);reject(Error(copy('gx_ops_script_error','Could not load the workflow. Try again.')));};document.head.append(script);
  }));
  return scripts.get(path);
}
async function workflowRuntime(){
  if(!window.FMDocModel)await loadScript('/libraries/doc-model/firstmate-doc-model.js');
  if(!window.FMDocRenderer)await loadScript('/libraries/doc-renderer/firstmate-doc-renderer.js');
  if(!window.FMDocWorkflow)await loadScript('/libraries/doc-workflow/firstmate-doc-workflow.js');
  return window.FMDocWorkflow;
}
function installStyle(){
  if(document.getElementById('gx-operations-style'))return;
  const style=document.createElement('style');style.id='gx-operations-style';style.textContent=`
  .ops-setup{display:flex;flex-direction:column;gap:20px;min-height:0;height:100%;color:#17212f}.ops-setup p{margin:0;color:#657083;line-height:1.65}.ops-paths,.ops-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.ops-choice,.ops-card{font:inherit;text-align:left;background:#fff;border:1px solid #dce2e9;border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:12px;color:inherit;cursor:pointer}.ops-choice:hover,.ops-card:hover{border-color:var(--primary,#d93025);box-shadow:0 5px 18px #17212f0b}.ops-choice strong,.ops-card strong{font-size:17px}.ops-choice span,.ops-card span{font-size:13px;line-height:1.5;color:#657083}.ops-choice i{font-size:26px;color:var(--primary,#d93025)}.ops-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.ops-check{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:#e7f4ec;color:#25804a;font-size:22px}.ops-minutes{font-size:11px!important;font-weight:700}.ops-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:auto;padding-top:12px}.ops-btn{font:inherit;font-weight:700;font-size:13px;cursor:pointer;border:1px solid #d0d7df;border-radius:9px;padding:11px 17px;background:white;color:#344054;min-height:44px}.ops-btn.primary{background:var(--primary,#d93025);border-color:transparent;color:white}.ops-btn:disabled,.ops-card:disabled,.ops-choice:disabled{opacity:.55;cursor:wait}.ops-error{color:#b42318!important;font-size:13px}.ops-error:empty{display:none}.ops-workflow,.ops-app{min-height:0;flex:1;overflow:hidden}.ops-workflow>.fmdw{height:100%}.ops-notice{font-size:12px;padding:10px 13px;background:#f3f6fa;border-radius:8px}.ops-success{display:flex;align-items:center;gap:14px;padding:16px;background:#edf7f0;border-radius:12px}.ops-success strong{display:block;margin-bottom:4px}.ops-success p{font-size:13px}.ops-loading{display:grid;place-items:center;min-height:120px;color:#667085}.gxs:has(.ops-workflow) .gxs-sheet,.gxs:has(.ops-app) .gxs-sheet{width:min(1320px,calc(100vw - 32px))}.gxs-step:has(.ops-setup) .gxs-body{min-height:0;flex:1}.gxs:has(.ops-setup) .gxs-step[data-fill]{overflow:hidden}.ops-ready{overflow:auto;padding-bottom:4px}.ops-status{font-size:12px;color:#667085}.ops-status:empty{display:none}@media(max-width:640px){.ops-paths,.ops-cards{grid-template-columns:1fr}.ops-choice,.ops-card{padding:17px}.ops-actions{align-items:stretch}.ops-actions .ops-btn{flex:1 1 100%;width:100%}.ops-actions>span{width:100%;text-align:center;font-size:12px}.ops-setup{gap:14px}.gxs:has(.ops-workflow) .gxs-sheet,.gxs:has(.ops-app) .gxs-sheet{width:100vw}.ops-path{overflow:auto}}
  `;document.head.append(style);
}
function environment(ctx){
  const orgId=String(window.__APP?.userOrgId||window.Portal?.currentUser?.orgId||'');
  const projectId=String(ctx.where?.projectId||'');
  const target={scope:'project',organizationId:orgId,projectId};
  const invoke=async(action,input={},key)=>{
    const result=await window.PlatformAPI.publication.invoke(orgId,action,target,input,key?{idempotencyKey:key}:{});
    return result.value??result.result??result;
  };
  return {orgId,projectId,target,invoke};
}
async function activate(appId,orgId){
  const entries=window.Portal?.currentUser?.appEntitlements||[];
  if(!entries.find(entry=>entry.id===appId)?.offered)return;
  await window.PlatformAPI.request(`/organizations/${encodeURIComponent(orgId)}/app-offers/${encodeURIComponent(appId)}/start`,{method:'POST',body:{}});
  await Promise.all([window.PlatformAPI.capabilities.load(orgId,{refresh:true}),window.PlatformAPI.appFlags.load(orgId,{refresh:true})]);
  await window.Portal.auth.syncPlatformSession();
  await window.FirstMateGuides?.refresh?.();
}
function setPath(target,path,value){
  const parts=String(path).split('.').filter(Boolean);if(parts.some(part=>['__proto__','constructor','prototype'].includes(part)))return;
  let at=target;for(const part of parts.slice(0,-1)){if(!at[part]||typeof at[part]!=='object')at[part]={};at=at[part];}at[parts.at(-1)]=value;
}
function pathWidget(el,ctx){
  el.innerHTML=`<div class="ops-setup ops-path"><p>${esc(copy('gx_ops_path_explanation','A clear scope is the starting point for your materials and work order. Build it into a proposal for your customer, or keep it simple and plan the work here.'))}</p><div class="ops-paths"><button class="ops-choice" data-path="proposal"><i class="fas fa-file-signature" aria-hidden="true"></i><strong>${esc(copy('gx_ops_create_proposal','Create a proposal'))}</strong><span>${esc(copy('gx_ops_proposal_description','Plan the work, set your payment terms, and get a proposal ready to present, send and sign.'))}</span></button><button class="ops-choice" data-path="scope"><i class="fas fa-list-check" aria-hidden="true"></i><strong>${esc(copy('gx_ops_quick_scope','Just build my scope of work'))}</strong><span>${esc(copy('gx_ops_quick_description','Skip the proposal for now. Define what this project needs and get straight to your materials.'))}</span></button></div></div>`;
  const click=event=>{const path=event.target.closest('[data-path]')?.dataset.path;if(!path)return;ctx.change({operation_path:path,...(ctx.selections.operation_path&&ctx.selections.operation_path!==path?{operations_document_id:'',operations_scope_ready:false}:{})},path==='proposal'?copy('gx_ops_create_proposal','Create a proposal'):copy('gx_ops_quick_scope','Just build my scope of work'));ctx.advance();};
  el.addEventListener('click',click);return {destroy(){el.removeEventListener('click',click);}};
}
function documentWidget(el,ctx){
  const env=environment(ctx),path=ctx.options.path||ctx.selections.operation_path||'scope';
  let alive=true,documentRecord=null,handle=null,saving=null,timer=null,changed=0,saved=0,busy=false,stepState={},documentEngine=null,documentEngineHost=null;
  let values={params:{},outputs:{}};
  el.innerHTML=`<div class="ops-setup"><p class="ops-notice">${esc(path==='proposal'?copy('gx_ops_proposal_hint','Your answers build the proposal beside you. You can review it before sharing it.'):copy('gx_ops_scope_hint','Choose the work, confirm the measurements, then review what this project needs. No signature or payment is needed.'))}</p><div class="ops-workflow"><div class="ops-loading">${esc(copy('gx_operations_loading','Opening Operations…'))}</div></div><p class="ops-error" role="alert"></p><p class="ops-status" role="status"></p></div>`;
  const host=el.querySelector('.ops-workflow'),error=el.querySelector('.ops-error'),status=el.querySelector('.ops-status');
  const fail=exception=>{if(alive){error.textContent=exception?.message||copy('gx_ops_save_error','Could not save. Please try again.');status.textContent='';}};
  async function flush(){
    clearTimeout(timer);if(saving){await saving;if(saved<changed)return flush();return;}
    if(saved>=changed||!documentRecord)return;
    const revision=changed,params=structuredClone(values.params);
    saving=env.invoke('operations.document.save',{document_id:documentRecord.id,expected_revision:documentRecord.revision,params,...stepState},`operations.save:${documentRecord.id}:${documentRecord.revision}:${revision}`).then(result=>{documentRecord=result.document;saved=revision;}).finally(()=>{saving=null;});
    await saving;if(saved<changed)return flush();
  }
  async function finish(){
    if(busy||!alive)return;busy=true;host.inert=true;error.textContent='';status.textContent=copy('gx_ops_publishing','Saving your scope of work…');
    try{
      await flush();
      // Sending/presenting uses the ordinary document host and can revise this same document.
      if(documentEngine){const latest=await env.invoke('operations.document.prepare',{project_id:env.projectId,path,document_id:documentRecord.id},`operations.resume:${documentRecord.id}:${Date.now()}`);documentRecord=latest.document;}
      const result=await env.invoke('operations.scope.complete',{document_id:documentRecord.id,expected_revision:documentRecord.revision},`operations.publish:${documentRecord.id}:${documentRecord.revision}`);
      if(!alive)return;
      documentRecord=result.document||documentRecord;
      ctx.change({operations_document_id:documentRecord.id,operations_project_id:env.projectId,operations_scope_ready:true,operation_path:path},copy('gx_ops_scope_saved','Scope of work saved'));
      await ctx.advance();
    }catch(exception){fail(exception);}finally{busy=false;if(alive)host.inert=false;}
  }
  async function openProposalAction(action){
    await flush();
    if(!documentEngine){
      documentEngineHost=document.createElement('div');documentEngineHost.hidden=true;el.append(documentEngineHost);
      let service=null;
      documentEngine=await window.FirstMateEmbeddableApps.mount(documentEngineHost,'project.documents',{orgId:env.orgId,projectId:env.projectId,project:{id:env.projectId},surface:'project_modal',active:true,params:{embed:{enabled:true,onReady:api=>{service=api;}}}});
      documentEngine.service=service;
    }
    if(!alive)return;
    const service=documentEngine.service;if(!service)throw Error(copy('gx_ops_proposal_open_error','Could not open the proposal tools. Please try again.'));
    await service.openDocument(documentRecord);
    if(action==='send')service.openSendModal(documentRecord);
    else service.openPresentation();
  }
  async function open(){
    if(!env.projectId)throw Error(copy('gx_ops_project_required','Create or open a project first, then set up its scope of work.'));
    if(path==='proposal')await activate('project.docs',env.orgId);
    const previous=ctx.selections.operations_project_id===env.projectId?ctx.selections.operations_document_id:undefined;
    const [runtime,initial]=await Promise.all([workflowRuntime(),env.invoke('operations.document.prepare',{project_id:env.projectId,path,...(previous?{document_id:previous}:{})},`operations.prepare:${env.projectId}:${path}:${previous?previous+':'+crypto.randomUUID():'first'}`)]);
    // A retried first create may return its original receipt; resume the same saved instance freshly.
    const prepared=previous?initial:await env.invoke('operations.document.prepare',{project_id:env.projectId,path,document_id:initial.document.id},`operations.resume:${initial.document.id}:${crypto.randomUUID()}`);
    if(!alive)return;
    documentRecord=prepared.document;values={params:structuredClone(object(documentRecord.params)),outputs:structuredClone(object(documentRecord.outputs))};
    ctx.change({operations_document_id:documentRecord.id,operations_project_id:env.projectId,operation_path:path});
    await ctx.checkpoint?.();if(!alive)return;
    // Preparing Operations can offer optional apps. Refresh discovery before the checklist
    // needs those entries; this does not activate them or interrupt the current guide.
    await Promise.all([window.PlatformAPI.capabilities.load(env.orgId,{refresh:true}),window.PlatformAPI.appFlags.load(env.orgId,{refresh:true})]);
    await window.Portal.auth.syncPlatformSession();if(!alive)return;
    if(path==='scope'&&documentRecord.status==='completed'){
      const status=await env.invoke('operations.setup.status',{operations_document_id:documentRecord.id});
      if(status.scope_ready){ctx.change({operations_scope_ready:true});await ctx.advance();return;}
    }
    const definition=prepared.workflow?.definition||prepared.workflow;
    const fields=prepared.measurement_fields_by_piece||{};
    host.innerHTML='';
    handle=runtime.mount(host,{workflow:definition,audience:'internal',showWorkflowTitle:false,contract:definition.contract,state:{...values,...object(documentRecord.workflow_state),...object(prepared.workflow?.state)},scope:{project:{id:env.projectId}},labels:{finish:copy('gx_ops_finish_scope','Finish scope of work')},
      onWrite(name,value){setPath(values,name,value);changed++;clearTimeout(timer);timer=setTimeout(()=>flush().catch(fail),500);},
      onStepState(next){stepState={current_step:next.current_step,completed_steps:next.completed_steps};changed++;clearTimeout(timer);timer=setTimeout(()=>flush().catch(fail),500);},
      onComplete:()=>{void finish();},
      ...(path==='proposal'?{preview:{resolve:async()=>{await flush();return env.invoke('operations.document.resolve',{document_id:documentRecord.id});}}}:{}),
      services:{
        ...(path==='proposal'?{deliverables:async()=>[
          {id:'send_proposal',label:copy('gx_ops_send_proposal','Send proposal'),icon:'fa-paper-plane',run:()=>openProposalAction('send').catch(fail)},
          {id:'present_proposal',label:copy('gx_ops_present_proposal','Present'),icon:'fa-chalkboard-user',run:()=>openProposalAction('present').catch(fail)}
        ]}:{}),
        pieceCatalog:async()=>prepared.piece_catalog||prepared.pieces||[],
        measurementKeysForSelection:async selection=>[...new Set(array(selection).flatMap(piece=>array(fields[piece.template_id||piece.id]).map(field=>typeof field==='string'?field:field.key||field.id)))],
        projectMeasurements:async()=>{const result=await window.PlatformAPI.publication.measurements(env.orgId,env.projectId),data=object(result.value||result.result?.value);return {values:Object.fromEntries(Object.entries(object(data.measurements)).map(([key,entry])=>[key,Number(typeof entry==='number'?entry:entry?.value)]).filter(([,value])=>Number.isFinite(value))),source:copy('gx_ops_measurement_source','Project measurements')};},
        generateScopeItems:async(selection,measurements)=>array((await env.invoke('operations.scope.generate',{selection,measurements})).items),
        scopeCandidates:async(templateId,group,measurements)=>{const result=await window.PlatformAPI.publication.invoke(env.orgId,'pricebook.scope.candidates',{scope:'organization',organizationId:env.orgId},{templateId,group,measurements});return array(result.value);}
      }
    });
    // This is the ordinary tutorial player over the ordinary workflow. It keeps the
    // work cards interactive, and a dismissed/completed walkthrough never auto-replays.
    await ctx.runGuide?.('operations.workflow_tutorial',{keepVisible:true,replay:false});
  }
  function startupError(exception){
    fail(exception);if(!alive)return;
    host.innerHTML=`<div class="ops-loading"><button class="ops-btn" data-retry>${esc(copy('gx_ops_retry','Try again'))}</button></div>`;
    host.querySelector('[data-retry]').addEventListener('click',()=>{error.textContent='';host.innerHTML=`<div class="ops-loading">${esc(copy('gx_operations_loading','Opening Operations…'))}</div>`;void open().catch(startupError);});
  }
  open().catch(startupError);
  return {valid:()=>ctx.selections.operations_scope_ready===true,destroy(){alive=false;clearTimeout(timer);handle?.destroy?.();documentEngine?.destroy?.();documentEngineHost?.remove();void flush().catch(()=>{});}};
}
function readyWidget(el,ctx){
  const env=environment(ctx);let alive=true,busy=false,child=null;
  const workforce=window.PlatformTerminology?.get?.('workforce.resource_group_plural','Workforce')||'Workforce';
  const cards=[{id:'suppliers',label:copy('gx_ops_suppliers','Suppliers'),minutes:5,guide:'operations.suppliers.setup',body:copy('gx_ops_suppliers_body','Choose who supplies your materials and add their costs.')},{id:'equipment',label:copy('gx_ops_equipment','Equipment'),minutes:3,body:copy('gx_ops_equipment_body','Connect your equipment to the work your projects require.')},{id:'workforce',label:workforce,minutes:5,guide:'operations.workforce.setup',body:copy('gx_ops_workforce_body','Add who does the work and how you pay them.')},{id:'proposals',label:copy('gx_ops_proposals','Proposals'),minutes:10,guide:'operations.proposal.setup',body:copy('gx_ops_proposals_body','Create proposals with payment terms and customer approval.')}];
  for(const card of cards){const config=array(ctx.options.setups).find(item=>item.id===card.id);if(config){card.minutes=config.minutes??card.minutes;card.guide=config.experience||card.guide;}}
  async function refresh(){
    const state=await env.invoke('operations.setup.status',{operations_document_id:ctx.selections.operations_project_id===env.projectId?ctx.selections.operations_document_id:undefined});if(!alive)return;
    if(!state.scope_ready){
      el.innerHTML=`<div class="ops-setup"><p>${esc(copy('gx_ops_scope_missing','Let’s build the scope of work for this project first. Your other project’s scope stays with that project.'))}</p><button class="ops-btn primary" data-restart>${esc(copy('gx_ops_build_scope','Build this project’s scope'))}</button></div>`;
      el.querySelector('[data-restart]').addEventListener('click',()=>{ctx.change({operations_document_id:'',operations_project_id:env.projectId,operations_scope_ready:false});ctx.restart();});return;
    }
    el.innerHTML=`<div class="ops-setup ops-ready"><div class="ops-success"><span class="ops-check" aria-hidden="true">✓</span><div><strong>${esc(copy('gx_ops_congratulations','You’ve built your scope of work!'))}</strong><p>${esc(copy('gx_ops_ready_body','You’re ready to generate materials. Set up anything else now, or come back to it later.'))}</p></div></div><div class="ops-cards">${cards.map(card=>{const value=state.setup?.[card.id];const complete=value===true||value?.complete===true||value?.completed===true;return `<button class="ops-card" data-setup="${card.id}"><div class="ops-card-head"><strong>${esc(card.label)}</strong>${complete?'<span class="ops-check" aria-label="'+esc(copy('gx_ops_done','Set up'))+'">✓</span>':'<span class="ops-minutes">'+card.minutes+' '+esc(copy('gx_ops_minutes','min'))+'</span>'}</div><span>${esc(card.body)}</span></button>`;}).join('')}</div><p class="ops-error" role="alert"></p><div class="ops-actions"><button class="ops-btn primary" data-generate>${esc(copy('gx_ops_generate','Generate my materials'))}</button><span>${esc(copy('gx_ops_optional','The other setup steps are optional.'))}</span></div></div>`;
    el.querySelector('[data-generate]').addEventListener('click',async()=>{if(busy)return;busy=true;el.querySelector('[data-generate]').disabled=true;try{await ctx.complete({generate:true});}catch(error){showError(error);busy=false;if(alive)el.querySelector('[data-generate]').disabled=false;}});
    el.querySelectorAll('[data-setup]').forEach(button=>button.addEventListener('click',()=>openSetup(button.dataset.setup)));
  }
  function showError(error){if(alive){const node=el.querySelector('.ops-error');if(node)node.textContent=error?.message||copy('gx_ops_setup_error','Could not open setup. Please try again.');}}
  async function openSetup(id){
    if(busy)return;busy=true;
    try{
      const card=cards.find(item=>item.id===id);
      if(id==='equipment'){
        await activate('portal.equipment',env.orgId);if(!alive)return;
        el.innerHTML=`<div class="ops-setup"><div class="ops-actions" style="margin-top:0"><button class="ops-btn" data-return>← ${esc(copy('gx_ops_back_hub','Back to setup'))}</button><p>${esc(copy('gx_ops_equipment_return','Add your equipment here, then return to your setup checklist.'))}</p></div><div class="ops-app"></div><p class="ops-error" role="alert"></p></div>`;
        child=await window.FirstMateEmbeddableApps.mount(el.querySelector('.ops-app'),'portal.equipment',{orgId:env.orgId,surface:'portal_tab',active:true});
        el.querySelector('[data-return]').addEventListener('click',async()=>{child?.destroy?.();child=null;await refresh().catch(showError);});
        await ctx.runGuide?.('equipment.tab_tutorial',{keepVisible:true});
      }else{
        if(id==='workforce'){
          await env.invoke('operations.workforce.setup.start',{},`operations.workforce.start:${env.orgId}`);
          await Promise.all([window.PlatformAPI.capabilities.load(env.orgId,{refresh:true}),window.PlatformAPI.appFlags.load(env.orgId,{refresh:true})]);
          await window.Portal.auth.syncPlatformSession();await window.FirstMateGuides?.refresh?.();
        }
        const result=await ctx.runGuide?.(card.guide);
        if(result?.status==='unavailable')throw Error(copy('gx_ops_setup_unavailable','This setup is not available for your account.'));
        await refresh();
      }
    }catch(error){showError(error);}finally{busy=false;}
  }
  el.innerHTML=`<div class="ops-loading">${esc(copy('gx_ops_checking','Checking your setup…'))}</div>`;refresh().catch(error=>{el.innerHTML='<p class="ops-error" role="alert"></p>';showError(error);});
  return {destroy(){alive=false;child?.destroy?.();}};
}
export function mountWidget(id,el,ctx){installStyle();if(id==='operations-path')return pathWidget(el,ctx);if(id==='operations-document')return documentWidget(el,ctx);return readyWidget(el,ctx);}
