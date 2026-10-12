/* Read-only presentation of recorded activity. Resource lookups use the
 * existing authenticated clients; activity never runs or replays an action. */
(function(root){
  'use strict';
  const clean=v=>String(v??'').trim(),obj=v=>v&&typeof v==='object'?v:{},first=(...v)=>v.map(clean).find(Boolean)||'';
  const data=e=>obj(e.data||e),payload=e=>obj(e.payload||data(e).payload),target=e=>obj(data(e).target);
  const type=e=>first(e.type,data(e).type).toLowerCase();
  const stamp=e=>first(data(e).occurred_at,e.occurred_at,data(e).created_at,e.created_at);
  const get=(catalog,kind,id)=>obj(catalog?.[kind]?.get?.(clean(id)));
  const node=(e,c)=>get(c,'nodes',first(e.node_id,payload(e).node_id,target(e).node_id));
  const plan=(e,c)=>get(c,'plans',first(e.plan_id,payload(e).plan_id,target(e).plan_id,node(e,c).plan_id));
  const isTask=(e,c)=>{
    const n=node(e,c),p=plan(e,c),m=obj(n.metadata);
    return n.actionable===true||n.show_in_todo_list===true||['manual','follow_up'].includes(m.kind)||['manual_todo','follow_up'].includes(p.source_type)||/^task[._]|^todo[._]|action[._]item/.test(type(e));
  };
  const categories={project:['Project changes','fa-pen'],tasks:['To-dos','fa-check'],notes:['Notes','fa-note-sticky'],schedule:['Scheduling','fa-calendar'],reports:['Reports & measurements','fa-ruler-combined'],files:['Files & photos','fa-image'],documents:['Documents & signatures','fa-file-signature'],scope:['Scope & materials','fa-layer-group'],payments:['Payments & billing','fa-credit-card'],contacts:['Contacts & people','fa-user-group'],communications:['Calls & communications','fa-phone'],workflow:['Workflow & stages','fa-diagram-project'],field:['Field work & checklists','fa-clipboard-check']};
  function category(e,c){
    const t=type(e),p=payload(e),m=get(c,'media',first(p.media_id,target(e).media_id));
    if(/^project\.note\.|note[._]/.test(t))return 'notes';
    if(/^crew\.|^checklist\.|^punch_list\.|^field\./.test(t))return 'field';
    if(/^work\.node\./.test(t))return isTask(e,c)?'tasks':'workflow';
    if(/^work\.plan\./.test(t))return ['manual_todo','follow_up'].includes(plan(e,c).source_type)?'tasks':'workflow';
    if(/^task[._]|^todo[._]|action[._]item/.test(t))return 'tasks';
    if(/^(payment|invoice|receipt|expense|project_expense|payroll|billing)[._]/.test(t))return 'payments';
    if(/^(schedule|appointment|booking)[._]|^project\.event[._]/.test(t))return 'schedule';
    if(/^(report|measurement)[._]/.test(t))return 'reports';
    if(/^(document|proposal|signature|contract)[._]/.test(t))return 'documents';
    if(/^(scope|material|material_list|material_order|material_delivery)[._]/.test(t))return 'scope';
    if(/^(media|file|photo|upload|attachment)[._]/.test(t))return obj(m.owner).slot==='documents'?'documents':'files';
    if(/^(contact|customer|user|member|assignee|assignment|collaborator)[._]/.test(t))return 'contacts';
    if(/^(call|communication|email|sms|comment|mention|huddle)[._]/.test(t))return 'communications';
    if(/^work[._]|^stage[._]|status/.test(t))return 'workflow';
    return 'project';
  }
  function actor(e,c){
    const d=data(e),p=payload(e),ctx=obj(e.context||d.context),t=type(e);
    // Scheduled start/end and child rollups are automatic. A scheduler or an
    // assignee is not the actor who performed those transitions.
    let id=first(e.actor_user_id,d.actor_user_id,ctx.actor_user_id,p.actor_user_id,d.actor?.id,p.uploaded_by_user_id);
    let name=first(p.actor_name,d.actor_name,d.actor?.name,p.uploaded_by_name);
    if(t==='project.event_scheduled'||t==='project.event.updated'||t==='appointment.scheduled'){
      id=first(id,obj(p.event).scheduled_by_user_id);name=first(name,obj(p.event).scheduled_by_name);
    }
    if(!id&&t.startsWith('payment.'))id=first(obj(p.payment).created_by_user_id);
    const delivery=get(c,'deliveries',p.delivery_id);
    if(!id&&/delivery/.test(t)&&Math.abs(Date.parse(delivery.created_at)-Date.parse(stamp(e)))<1500){id=first(delivery.created_by_user_id,obj(delivery.received_by).user_id);name=first(name,obj(delivery.received_by).name);}
    const message=get(c,'messages',p.message_id);
    if(!id&&/^(communication|email|sms)\./.test(t))id=first(obj(message.source).actor_user_id,obj(message.source).type==='user'?obj(message.source).user_id:'',obj(message.context).actor_user_id,obj(message.metadata).actor_user_id);
    if(!id&&e.node_id&&p.reason!=='child_rollup'){
      const transition=(obj(node(e,c).metadata).history||[]).find(h=>h.to===p.to_status&&Math.abs(Date.parse(h.at)-Date.parse(stamp(e)))<1500);
      id=first(transition?.actor_user_id);
    }
    const u=get(c,'users',id);
    return {id,name:first(u.name,u.display_name,name),email:first(u.email,d.actor_email,ctx.actor_email)};
  }
  const money=(cents,currency='USD')=>{
    const value=Number(cents);if(!Number.isFinite(value))return '';
    try{return new Intl.NumberFormat(undefined,{style:'currency',currency}).format(value/100);}catch{return (value/100).toFixed(2)+' '+currency;}
  };
  const title=(e,c)=>{
    const p=payload(e),d=data(e),n=node(e,c),pl=plan(e,c),m=get(c,'media',first(p.media_id,target(e).media_id)),doc=get(c,'documents',first(p.document_id,target(e).document_id));
    const order=get(c,'orders',p.order_id),list=get(c,'materialLists',first(p.material_list_id,order.material_list_id));
    return first(p.node_title,p.plan_title,p.event_title,obj(p.event).title,p.document_title,p.title,n.title,pl.title,doc.title,obj(m.metadata).caption,obj(m.metadata).title,m.label,m.file_name,list.title,order.title,p.file_name,d.title);
  };
  function describe(e,c={}){
    const t=type(e),p=payload(e),d=data(e),label=title(e,c),a=actor(e,c);
    let action='',subject='',detail='';
    if(/^project\.event[._]|^appointment[._]/.test(t)){
      action=t.endsWith('started')?'Started':t.endsWith('completed')?'Finished':t.includes('cancel')?'Canceled':t.includes('reschedul')?'Rescheduled':t.includes('confirm')?'Confirmed':t.includes('schedule')?'Scheduled':'Updated';
      subject=label||'appointment';
    }else if(/^work\.node\./.test(t)){
      action=({completed:'Completed',started:'Started',ready:'Made ready',blocked:'Paused',skipped:'Skipped',canceled:'Canceled',claimed:'Claimed',updated:'Updated',assigned:'Assigned',status_changed:'Updated'})[t.slice(10)]||'Updated';
      subject=label||(isTask(e,c)?'to-do':'stage');
    }else if(/^work\.plan\./.test(t)){
      if(t.endsWith('stage_manually_set')){action='Moved';subject=first(p.to_stage_title,'project stage');detail=p.from_stage_title?'from '+p.from_stage_title:'';}
      else{action=({created:'Added',started:'Started',completed:'Completed',canceled:'Canceled'})[t.slice(10)]||'Updated';subject=(label||'Project')+(['manual_todo','follow_up'].includes(plan(e,c).source_type)?' to-do':' workflow');}
    }else if(/^crew\.checklist\.|^checklist\.|^punch_list\./.test(t)){
      action=t.includes('requested')?'Requested':t.includes('submitted')?'Submitted':t.includes('reopened')?'Reopened':t.includes('accepted')?'Approved':t.includes('completed')?'Completed':'Updated';subject=label||(/punch/.test(t)?'punch list':'checklist');
    }else if(/^document\.|^proposal\.|^signature\.|^contract\./.test(t)){
      action=({sent:'Sent',viewed:'Viewed',signed:'Signed',created:'Created',issued:'Issued',voided:'Canceled',expired:'Expired',declined:'Declined',updated:'Updated',ingested:'Uploaded'})[t.split('.').pop()]||'Updated';
      subject=label||({change_order:'change order',proposal:'proposal',contract:'agreement',invoice:'invoice'})[p.document_type]||'document';
    }else if(/^media\.|^file\.|^photo\.|^attachment\./.test(t)){
      action=t.includes('tags')?'Updated tags for':t.includes('rename')?'Renamed':t.includes('delete')||t.includes('remove')?'Removed':t.includes('restore')?'Restored':t.includes('upload')?'Uploaded':'Updated';subject=label||(first(p.content_type).startsWith('image/')?'photo':'file');
    }else if(/^receipt\./.test(t)){action=t.includes('applied')?'Applied':t.includes('upload')?'Uploaded':'Updated';subject=label||'receipt';}
    else if(/^expense\.|^project_expense\./.test(t)){action=p.projected_cents!=null&&t.endsWith('recorded')?'Budgeted':'Recorded';subject=label||'expense';detail=money(p.amount_cents??p.projected_cents??p.actual_cents);}
    else if(/^invoice\./.test(t)){action=({created:'Created',paid:'Paid',sent:'Sent',voided:'Canceled',marked_due:'Issued'})[t.split('.').pop()]||'Updated';subject=first(p.invoice_number,label,'invoice');detail=money(p.total_cents??p.amount_cents);}
    else if(/^payment\./.test(t)){action=({received:'Received',settled:'Settled',failed:'Failed',refunded:'Refunded',cleared:'Cleared',reallocated:'Allocated'})[t.split('.').pop()]||'Recorded';subject=(money(p.amount_cents,obj(p.payment).currency||'USD')+' payment').trim();}
    else if(/^material[._]|^material_list\.|^material_order\.|^material_delivery\./.test(t)){
      action=t.includes('delivery.completed')||t.endsWith('delivered')?'Received':t.includes('order')&&t.endsWith('created')?'Ordered':t.endsWith('created')?'Created':t.includes('schedule')?'Scheduled':'Updated';subject=label||(/delivery/.test(t)?'material delivery':/order/.test(t)?'materials':'material list');
    }else if(/^communication\.|^email\.|^sms\./.test(t)){
      action=t.endsWith('received')?'Received':t.endsWith('failed')?'Failed to send':t.endsWith('sent')?'Sent':'Updated';
      const person=(c.project?.contacts||[]).find(x=>x.id===p.contact_id||x.email===p.sender_address);
      subject=(p.channel==='sms'?'text message':p.channel||'message')+(t.endsWith('received')&&first(person?.name,p.sender_address)?' from '+first(person?.name,p.sender_address):'');
      detail=first(p.subject,obj(get(c,'messages',p.message_id).content).subject);
    }else if(/^call\./.test(t)){action=t.endsWith('completed')?'Completed':t.endsWith('started')?'Started':t.endsWith('missed')?'Missed':'Updated';const person=(c.project?.contacts||[]).find(x=>p.phone&&clean(x.phone).replace(/\D/g,'')===clean(p.phone).replace(/\D/g,''));subject='call'+(first(p.customer_name,person?.name,p.phone)?' with '+first(p.customer_name,person?.name,p.phone):'');}
    else if(/^project\.note\./.test(t)){action=({created:'Added',edited:'Edited',deleted:'Removed',restored:'Restored',pinned:'Pinned',unpinned:'Unpinned',shared:'Shared'})[t.split('.').pop()]||'Updated';subject='project note';}
    else if(/^project\./.test(t)){action=t.endsWith('created')?'Created':t.endsWith('completed')?'Completed':'Updated';subject=label||'project';}
    else if(/^(task|todo|action[._]item)[._]/.test(t)){action=t.endsWith('completed')?'Completed':t.endsWith('created')?'Added':'Updated';subject=label||'to-do';}
    else if(/^(report|measurement)[._]/.test(t)){action=t.endsWith('created')||t.endsWith('completed')?'Completed':t.endsWith('ordered')?'Ordered':'Updated';subject=label||'measurement report';}
    else if(/^(contact|customer|user|member|assignment)[._]/.test(t)){action=t.endsWith('created')||t.endsWith('added')?'Added':t.endsWith('removed')?'Removed':'Updated';subject=label||'contact';}
    else{
      const summary=first(d.summary,d.description,p.summary,p.description,label);
      const match=summary.match(/^(Completed|Started|Finished|Uploaded|Sent|Viewed|Signed|Received|Recorded|Created|Added|Updated|Removed|Applied|Scheduled|Rescheduled|Canceled|Approved|Paused)\b\s*(.*)$/i);
      if(match){action=match[1];subject=match[2];}else subject=summary||'Project activity';
    }
    // Existing audit-only records may carry the precise task name in their
    // readable summary, without a node reference. Never replace it with a noun.
    if(!label&&first(d.summary,p.summary)){
      const summary=first(d.summary,p.summary),match=summary.match(/^(Completed|Started|Finished|Uploaded|Sent|Viewed|Signed|Received|Recorded|Created|Added|Updated|Removed|Applied|Scheduled|Rescheduled|Canceled|Approved|Paused)\s+(.+)$/i);
      if(match){action=match[1];subject=match[2];detail='';}else{action='';subject=summary;detail='';}
    }
    const text=[action,subject,detail?'— '+detail:''].filter(Boolean).join(' ');
    return {action,subject,detail,text,actor:a,category:category(e,c),timestamp:stamp(e)};
  }
  function merge(rows){
    const works=rows.filter(e=>e._source==='work'),audits=rows.filter(e=>e._source==='audit'),byId=new Map(works.map(e=>[clean(e.id),e])),used=new Set();
    const refKeys=['media_id','document_id','payment_id','invoice_id','receipt_id','call_id','node_id','delivery_id','order_id'];
    for(const audit of audits){
      const d=data(audit),t=target(audit),meta=obj(d.metadata),backed=first(meta.backed_work_event_id,t.work_event_id);
      let work=byId.get(backed);
      if(!work){work=works.find(w=>type(w)===type(audit)&&Math.abs(Date.parse(stamp(w))-Date.parse(stamp(audit)))<=1500&&refKeys.some(k=>first(w[k],payload(w)[k])&&first(w[k],payload(w)[k])===first(t[k],d[k],payload(audit)[k]))&&!used.has(w.id));}
      if(work){used.add(work.id);byId.set(work.id,{...work,actor_user_id:first(work.actor_user_id,d.actor_user_id),actor_name:first(d.actor_name,work.actor_name),summary:first(d.summary,work.summary)});}
    }
    return [...byId.values(),...audits.filter(a=>{const d=data(a),t=target(a);if(byId.has(first(obj(d.metadata).backed_work_event_id,t.work_event_id)))return false;return !works.some(w=>used.has(w.id)&&type(w)===type(a)&&Math.abs(Date.parse(stamp(w))-Date.parse(stamp(a)))<=1500&&refKeys.some(k=>first(w[k],payload(w)[k])&&first(w[k],payload(w)[k])===first(t[k],d[k],payload(a)[k])));})].sort((a,b)=>Date.parse(stamp(b))-Date.parse(stamp(a)));
  }
  function context(){return {project:{},users:new Map(),nodes:new Map(),plans:new Map(),media:new Map(),documents:new Map(),orders:new Map(),deliveries:new Map(),materialLists:new Map(),messages:new Map()};}
  async function hydrate(c,events,api,oid,pid,project={}){
    c.project=project;
    const read=async(call)=>{let timer;try{return await Promise.race([Promise.resolve().then(call),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),5000);})]);}catch{return null;}finally{clearTimeout(timer);}};
    const jobs=[];
    if(api.platform?.users?.list)jobs.push(read(()=>api.platform.users.list(oid)).then(r=>(r?.users||r?.documents||[]).forEach(u=>{const v=u.data?{...u.data,id:u.id}:u;c.users.set(v.id,v);})));
    if(api.platform?.media?.list)jobs.push(read(()=>api.platform.media.list(oid,{projectId:pid})).then(r=>(r?.media||[]).forEach(m=>c.media.set(m.id,m))));
    if(api.documents?.documents?.listForProject)jobs.push(read(()=>api.documents.documents.listForProject(oid,pid)).then(r=>(r?.documents||[]).forEach(d=>c.documents.set(d.id,d))));
    if(api.platform?.projectDocuments?.list)jobs.push(read(()=>api.platform.projectDocuments.list(oid,pid)).then(r=>(r?.documents||[]).forEach(d=>c.documents.set(d.id,d))));
    const planIds=[...new Set(events.map(e=>first(e.plan_id,payload(e).plan_id,target(e).plan_id)).filter(Boolean))];
    const walk=nodes=>{for(const n of nodes||[]){c.nodes.set(n.id,n);walk(n.children);}};
    for(const id of planIds)if(!c.plans.has(id)&&api.platform?.work?.plan)jobs.push(read(()=>api.platform.work.plan(oid,id)).then(r=>{if(r?.plan){c.plans.set(id,r.plan);walk(r.plan.root_nodes);}}));
    const orderIds=[...new Set(events.map(e=>payload(e).order_id).filter(Boolean))];
    for(const id of orderIds){
      if(!c.orders.has(id)&&api.materials?.orders?.get)jobs.push(read(()=>api.materials.orders.get(oid,id)).then(r=>{if(r?.order)c.orders.set(id,r.order);}));
      if(api.materials?.orders?.deliveries)jobs.push(read(()=>api.materials.orders.deliveries(oid,id)).then(r=>(r?.deliveries||[]).forEach(d=>c.deliveries.set(d.id,d))));
    }
    if(orderIds.length&&api.materials?.projects?.list)jobs.push(read(()=>api.materials.projects.list(oid,pid)).then(r=>(r?.material_lists||[]).forEach(l=>c.materialLists.set(l.id,l))));
    for(const id of [...new Set(events.map(e=>payload(e).message_id).filter(Boolean))])if(!c.messages.has(id)&&api.communications?.messages?.get)jobs.push(read(()=>api.communications.messages.get(oid,id)).then(r=>{if(r)c.messages.set(id,r.message||r);}));
    await Promise.all(jobs);
    for(const m of project.photos||[])if(!c.media.has(first(m.media_id,m.id)))c.media.set(first(m.media_id,m.id),m);
    return c;
  }
  root.FirstMateActivity={categories,context,hydrate,describe,merge,type,timestamp:stamp};
})(typeof window==='undefined'?globalThis:window);
