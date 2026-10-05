/* Adapt document requirements to the existing material grid; the ledger remains
 * the only mutable source. No second material-list records are created. */
export function nativeCalculusAPI(base, currentProject) {
  let ledger = { revision: 0, sets: [], orders: [], deliveries: [] }, project = '', org = '';
  const path = () => `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/calculus`;
  const set = id => ledger.sets.find(s => s.id === id);
  const command = async (operation, input) => {
    const requestProject=project;
    const response = await base.request(`${path()}/commands`, { method: 'POST', body: {key:crypto.randomUUID(),expected_revision:ledger.revision,operation,input} });
    if(currentProject()!==requestProject)throw Error('The material operation completed on the previous project. Reopen that project to review it.');
    ledger = response.ledger;
    return response;
  };
  const item = l => ({...l.presentation,id:l.id,name:l.name,quantity:l.quantity,unit:l.unit,order_quantity:l.order_quantity,order_unit:l.order_unit,
    section_id:l.group || 'materials',section:l.group || 'materials',structure_name:l.structure,variant_id:l.variant,
    projected_unit_price:l.unit_cost, currency:l.currency,
    pricebook_ref:{...l.presentation?.pricebook_ref,item_id:l.product_id},
    ...(l.packaging?{order_packaging:{order_unit:l.packaging.unit,units_per_package:l.packaging.coverage}}:{}),
    metadata:{...l.presentation?.metadata,calculus_line_id:l.id,explanation:l.explanation}});
  const list = s => {
    const ordered=s.lines.length>0 && s.lines.every(l=>l.balance.outstanding===0);
    return {...s.presentation,id:s.id,project_id:project,title:s.title,revision:s.revision,resource_type:'material',status:ordered?'ordered':'planning',
      current_items:s.lines.map(item),sections:[...new Set(s.lines.map(l=>l.group || 'materials'))].map(id=>({id,name:id,title:id})),
      color:s.presentation?.color || ['#d92d20','#2563eb','#12b76a','#7f56d9'][ledger.sets.indexOf(s)%4],
      metadata:{...s.presentation?.metadata,calculus:true,calculus_pending:!s.applied_evaluation,source_document:s.origin.title,
        calculation_warnings:s.evaluations.find(e=>e.id===s.applied_evaluation)?.warnings || []}};
  };
  function requirement(row, old) {
    const coverage=Number(row.order_packaging?.units_per_package) || (Number(row.order_packaging?.packages_per_unit)>0?1/Number(row.order_packaging.packages_per_unit):0);
    return {key:old?.key || `item_${crypto.randomUUID()}`,product_id:row.pricebook_ref?.item_id || old?.product_id || row.id,
      name:row.name,quantity:Number(row.quantity),unit:row.unit || old?.unit || 'each',variant:row.variant_id || '',
      group:row.section_id || row.section || old?.group || 'materials',structure:row.structure_name || old?.structure || '',
      explanation:old?.explanation || 'Material added during review',currency:row.currency || 'USD',
      ...(Number.isFinite(Number(row.projected_unit_price))?{unit_cost:Number(row.projected_unit_price)}:{}),
      ...(coverage>0?{packaging:{unit:row.order_packaging.order_unit,coverage}}:old?.packaging?{packaging:old.packaging}:{}),
      presentation:row,...(old?{replaces:old.id}:{})};
  }
  const result = id => ({material_list:list(set(id))});
  return {
    ...base,
    calculus: {
      async generate(id) {
        const evaluation=await command('evaluate',{set_id:id});
        const preview=set(id).evaluations.find(e=>e.id===evaluation.result.evaluation_id);
        // Review quantities in the familiar grid after applying. Missing inputs
        // stay visible as warnings beside the source list.
        await command('apply',{set_id:id,evaluation_id:preview.id,reason:'Generate from accepted document'});
        return result(id);
      }
    },
    projects:{...base.projects,async list(orgId,projectId) {
      const native=await base.projects.list(orgId,projectId);
      let response;
      try { response=await base.request(`/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/calculus`); }
      catch(error) { if(error.status===403){ledger={revision:0,sets:[],orders:[],deliveries:[]};return native;}throw error; }
      if(currentProject()!==projectId)return native;
      org=orgId;project=projectId;ledger=response.ledger;
      return {...native,material_lists:[...native.material_lists,...ledger.sets.map(list)]};
    }},
    lists:{...base.lists,
      async get(o,id){return set(id)?result(id):base.lists.get(o,id);},
      async versions(o,id){return set(id)?{versions:set(id).history.map(h=>({...h,items:(h.added||[]).map(item)}))}:base.lists.versions(o,id);},
      async orders(o,id){return set(id)?{orders:ledger.orders.filter(order=>order.lines.some(l=>l.set_id===id)).map(order=>({...order.presentation,...order,title:order.reference || 'Material order',vendor:{name:order.supplier},delivery_status:order.lines.every(a=>a.received>=a.quantity-a.cancelled)?'delivered':order.lines.some(a=>a.received>0)?'partially_delivered':'ordered',items:order.lines.map(a=>({...item(a.line),quantity:a.quantity}))}))}:base.lists.orders(o,id);},
      async patch(o,id,patch){
        if(!set(id))return base.lists.patch(o,id,patch);
        await command('configure',{set_id:id,set_revision:patch.expected_revision ?? 0,title:patch.title || set(id).title,presentation:{...set(id).presentation,...patch}});
        return result(id);
      },
      async createVersion(o,id,payload){
        if(!set(id))return base.lists.createVersion(o,id,payload);
        const s=set(id);
        if(payload.expected_revision!==s.revision)throw Error('Materials changed. Refresh before saving.');
        const remove=new Set(payload.remove_item_ids || []), additions=[];
        if(payload.items){s.lines.forEach(l=>remove.add(l.id));payload.items.forEach(r=>additions.push(requirement(r,s.lines.find(l=>l.id===r.id))));}
        else {
          for(const patch of payload.update_items || []) {const old=s.lines.find(l=>l.id===patch.id);if(!old)throw Error('Material line changed. Refresh before saving.');remove.add(old.id);additions.push(requirement({...item(old),...patch},old));}
          for(const row of payload.add_items || []) additions.push(requirement(row));
        }
        await command('amend',{set_id:id,set_revision:s.revision,remove:[...remove],add:additions,reason:payload.reason || 'Material review'});
        return {...result(id),version:{id:`revision_${set(id).revision}`,items:set(id).lines.map(item)}};
      },
      async createOrder(o,id,payload){
        if(!set(id))return base.lists.createOrder(o,id,payload);
        const s=set(id);
        if(payload.expected_revision!==s.revision)throw Error('Materials changed. Refresh before ordering.');
        const response=await command('order',{supplier:String(payload.vendor?.name || 'Supplier'),reference:payload.title || '',presentation:payload,lines:s.lines.filter(l=>l.balance.outstanding>0).map(l=>({set_id:id,line_id:l.id,quantity:l.balance.outstanding}))});
        const date=payload.scheduled_window?.date || payload.scheduled_window?.start_date;
        if(date)await command('delivery',{title:payload.title || 'Material delivery',date,allocations:ledger.orders.find(x=>x.id===response.result.order_id).lines.map(x=>x.id)});
        return {...result(id),order:ledger.orders.find(x=>x.id===response.result.order_id)};
      },
      async scheduleEvent(o,id,payload){
        if(!set(id))return base.lists.scheduleEvent(o,id,payload);
        const response=await base.request(`${path()}/sets/${encodeURIComponent(id)}/schedule`,{method:'POST',body:{expected_revision:set(id).revision,event:payload.event}});
        await command('configure',{set_id:id,set_revision:set(id).revision,presentation:{schedule_event_id:response.event.id,schedule:{...set(id).presentation?.schedule,event_id:response.event.id,enabled:true}}});
        return {...result(id),event:response.event};
      },
      async events(o,id){return set(id)?{events:[]}:base.lists.events(o,id);},
      async archive(o,id,payload){if(!set(id))return base.lists.archive(o,id,payload);throw Error('Document material sets retain their accepted source. Remove their lines to amend the requirements.');}
    },
    orders:{...base.orders,
      async deliveries(o,id){return ledger.orders.some(x=>x.id===id)?{deliveries:ledger.deliveries.filter(d=>d.allocations.some(a=>ledger.orders.find(x=>x.id===id).lines.some(l=>l.id===a)))}:base.orders.deliveries(o,id);},
      async recordDelivery(o,id,payload){
        const order=ledger.orders.find(x=>x.id===id);if(!order)return base.orders.recordDelivery(o,id,payload);
        const unassigned=order.lines.filter(a=>!ledger.deliveries.some(d=>d.allocations.includes(a.id)));
        if(unassigned.length)await command('delivery',{title:order.reference || 'Material delivery',date:String(payload.actual_delivered_at || new Date().toISOString()).slice(0,10),allocations:unassigned.map(a=>a.id)});
        for(const allocation of order.lines){const quantity=allocation.quantity-allocation.cancelled-allocation.received;if(quantity>0)await command('receive',{allocation_id:allocation.id,delivery_id:ledger.deliveries.find(d=>d.allocations.includes(allocation.id)).id,quantity,reason:'Received through material order review'});}
        return {order:ledger.orders.find(x=>x.id===id)};
      }
    }
  };
}
