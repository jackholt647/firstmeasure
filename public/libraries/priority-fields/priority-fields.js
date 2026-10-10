/* Shared published field selection and quick-display contract. */
(function(root){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const meta={scope_type:['Scope type','text','fa-layer-group'],stage:['Stage','text','fa-circle-dot'],dollar_value:['Value','currency','fa-dollar-sign'],project_type:['Property type','text','fa-house'],start_date:['Start date','date'],end_date:['End date','date'],customer:['Customer','text','fa-user'],address:['Address','text','fa-location-dot'],owner:['Project owner','text','fa-user-tie'],created_date:['Created date','date'],updated_date:['Last updated','date'],project_number:['Project number','text','fa-hashtag']};
  const sharedOwners=new Set(['organization','user','branch','department','division','team']);
  const ownerTarget=entity=>entity==='project'?clone(target):{scope:'organization',organizationId:'$organization',id:'$record'};
  const target={scope:'project',organizationId:'$organization',projectId:'$project'};
  function builtin(id){const [label,format,icon]=meta[id];return {id,label,format,currency:'USD',icon:icon||'fa-tag',empty:'hide',source:{provider:'project-summary',export:id==='dollar_value'?'value':'details',target:clone(target),path:id==='dollar_value'?'/amount':'/'+id}};}
  function custom(field,entity=field.entity||'project'){const path=String(field.path||field.key);return {id:'custom_field:'+path,label:field.ui?.project_tag_label||field.label||path,format:field.type==='currency'?'currency':['number','integer','formula','slider','percentage'].includes(field.type)?'number':['date','datetime'].includes(field.type)?'date':['array','object','json'].includes(field.type)?'json':'text',currency:field.currency||'USD',icon:field.ui?.project_tag_icon||field.ui?.icon||'fa-tag',empty:field.ui?.project_tag_empty_behavior||field.ui?.empty_behavior||'hide',source:{provider:'custom-fields-'+entity,export:'values',target:ownerTarget(entity),args:{field:path},path:'/'+path.split('.').map(escapePointer).join('/')}};}
  function normalize(config={},customFields=[],entity='project'){
    if(Array.isArray(config.priority_fields))return clone(config.priority_fields);
    if(entity!=='project')return [];
    const ids=[...new Set([...(Array.isArray(config.project_header_pills)?config.project_header_pills:['scope_type','stage','dollar_value']),...customFields.filter(f=>f.ui?.project_tag||f.ui?.visible_tag).map(f=>'custom_field:'+(f.path||f.key)),'project_type'])];
    return ids.flatMap(id=>meta[id]?[builtin(id)]:customFields.some(f=>'custom_field:'+(f.path||f.key)===id)?[custom(customFields.find(f=>'custom_field:'+(f.path||f.key)===id))]:[]);
  }
  const escapePointer=value=>String(value).replace(/~/g,'~0').replace(/\//g,'~1');
  const human=value=>String(value||'').replace(/[_.-]/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
  function format(item,locale=root.PlatformLanguage?.formatLocale?.()){
    const result=item.result;if(result?.status!=='ready'||result.value==null||typeof result.value==='string'&&!result.value.trim()||Array.isArray(result.value)&&!result.value.length||result.value&&typeof result.value==='object'&&!Object.keys(result.value).length)return '';
    const value=result.value;
    if(item.format==='currency'&&typeof value==='number')return new Intl.NumberFormat(locale,{style:'currency',currency:item.currency||'USD',maximumFractionDigits:2}).format(value);
    if(item.format==='number'&&typeof value==='number')return new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(value);
    if(item.format==='date'){const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString(locale);}
    if(item.source?.provider==='project-summary'&&item.source.path==='/project_type')return human(value);
    return typeof value==='object'?JSON.stringify(value):String(value);
  }
  function visible(items=[]){return items.filter(item=>!['denied','error','pending'].includes(item.result?.status)&&(format(item)!==''||item.empty==='show'));}
  function html(items=[],options={}){return visible(items).map(item=>`<span class="${escape(options.className||'fm-priority-field')}" data-priority-field="${escape(item.id)}" title="${escape(item.label)}"><i class="fas ${escape(/^fa-[a-z0-9-]+$/.test(item.icon||'')?item.icon:'fa-tag')}" aria-hidden="true"></i><span>${escape(format(item)||item.label+': Unassigned')}</span></span>`).join('');}
  async function resolve(orgId,recordId,{entity='project',branchId,projectId}={}){const result=await root.PlatformAPI.publication.read(orgId,{provider:'priority-fields',export:entity==='project'?'values':entity+'-values',target:{...(entity==='project'?{scope:'project',projectId:recordId}:{scope:entity==='contact'&&projectId?'project':'organization',id:recordId,...(projectId?{projectId}:{})}),organizationId:orgId,...(branchId?{branchId}:{})}});if(result.status!=='ready')throw Error(result.message||'Priority fields could not be loaded.');return result.value.items;}
  async function catalog(orgId,branchId,entity='project'){
    const [published,module]=await Promise.all([root.PlatformAPI.publication.catalog(orgId,{scope:'all',branchId}),root.PlatformAPI.branchModules.get(orgId,sharedOwners.has(entity)?'default':branchId,'custom_fields',{refresh:true}).catch(e=>{if(Number(e.status)===404)return null;throw e;})]);
    const definitions=(module?.data?.fields||module?.fields||[]).filter(f=>(f.entity||'project')===entity);
    const entries=[];
    for(const provider of published.providers||[])for(const [name,entry]of Object.entries(provider.exports||{})){
      if(provider.id==='priority-fields'||name==='contract')continue;
      const scopes=entry.access?.scopes||[];if(entity!=='project'&&!scopes.includes('organization')&&!scopes.includes('global'))continue;const scope=entity==='project'&&scopes.includes('project')?'project':scopes.includes('organization')?'organization':'global';
      const base={provider:provider.id,version:provider.version,export:name,target:{scope,...(scope!=='global'?{organizationId:'$organization'}:{}),...(scope==='project'?{projectId:'$project'}:{})}};
      if(provider.id==='projects')base.target.id='$project';if(provider.id==='custom-fields-'+entity || entity==='contact'&&provider.id==='customers')base.target.id=entity==='project'?'$project':'$record';
      const walk=(schema,path='',depth=0)=>{
        if(depth>8)return;
        const properties=schema?.properties;
        if(properties&&Object.keys(properties).length){for(const [key,child]of Object.entries(properties))walk(child,path+'/'+escapePointer(key),depth+1);return;}
        const type=schema?.type;
        entries.push({id:provider.id+'.'+name+path,label:human(provider.id)+' · '+human(name)+(path?' · '+path.slice(1).replace(/\//g,' / '):''),source:{...clone(base),...(path?{path}:{})},format:type==='number'||type==='integer'?'number':schema?.format==='date'||schema?.format==='datetime'?'date':type==='object'||type==='array'?'json':'text',listable:entry.listable,argsSchema:entry.argsSchema,description:entry.description});
      };
      walk(entry.schema);
    }
    for(const field of definitions){const item=custom(field,entity);entries.push({...item,label:field.label||field.path,listable:false});}
    for(const id of entity==='project'?Object.keys(meta):[]){const item=builtin(id);const exportName=item.source.export;if(published.providers?.some(p=>p.id==='project-summary'&&p.exports?.[exportName]))entries.unshift({...item,listable:false});}
    return {entries,definitions};
  }
  function style(){if(document.getElementById('fmPriorityStyles'))return;const node=document.createElement('style');node.id='fmPriorityStyles';node.textContent=`.fm-priority-editor{display:grid;gap:12px}.fm-priority-editor input,.fm-priority-editor select,.fm-priority-editor textarea{box-sizing:border-box;max-width:100%;width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;font:inherit;color:inherit}.fm-priority-row{display:grid;grid-template-columns:minmax(120px,1fr) auto;gap:10px;align-items:start;padding:10px;border:1px solid #e4e7ec;border-radius:8px}.fm-priority-actions{display:flex;gap:5px;flex-wrap:wrap}.fm-priority-actions button,.fm-priority-editor button{cursor:pointer;padding:6px 10px;border:1px solid #d0d5dd;border-radius:7px;background:white;color:inherit}.fm-priority-source{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.fm-priority-source label{display:grid;gap:4px;font-size:11px}.fm-priority-source .wide{grid-column:1/-1}.fm-priority-help{font-size:11px;color:#667085;line-height:1.5}.fm-priority-calc{display:grid;gap:10px;padding:12px;border:1px solid #e4e7ec;border-radius:8px}.fm-priority-status{font-size:12px;color:#b42318}@media(max-width:600px){.fm-priority-source,.fm-priority-row{grid-template-columns:1fr}}`;document.head.append(node);}
  function sourceEditor(host,entries,node={},onchange=()=>{},options={}){
    style();let source=clone(node.source||entries[0]?.source||{provider:'projects',export:'record',target:clone(target)}),selection=node.select?clone(node.select):null;
    const choice=entries.find(e=>e.source.provider===source.provider&&e.source.export===source.export&&e.source.path===source.path)||entries.find(e=>e.source.provider===source.provider&&e.source.export===source.export);
    let selectedId=choice?.id||'';
    const render=()=>{
      const entry=entries.find(e=>e.id===selectedId);
      host.innerHTML=`<div class="fm-priority-source"><label class="wide">Variable<select data-source-choice>${!selectedId?'<option value="">Saved source</option>':''}${entries.map(e=>`<option value="${escape(e.id)}" ${e.id===selectedId?'selected':''}>${escape(e.label)}</option>`).join('')}</select></label><label>Record${source.target.scope==='project'?' (within this project)':''}<input data-source-id value="${escape(source.target.id||'')}" placeholder="Record ID, if required"></label><label>Field within variable<input data-source-path value="${escape(source.path||'')}" placeholder="/total"></label>${entry?.listable&&options.allowSelection!==false?`<label>Document or record selection<select data-selection><option value="single" ${!selection?'selected':''}>Specific record</option><option value="first" ${selection?.pick==='first'?'selected':''}>First matching record</option><option value="all" ${selection?.pick==='all'?'selected':''}>All matching records</option></select></label>`:''}${selection?`<label>Template<input data-template value="${escape(selection.where?.template_id||'')}" placeholder="Any template"></label><label>Status<input data-state value="${escape(selection.where?.status||'')}" placeholder="Any status"></label><label>Order<select data-direction><option value="desc" ${selection.direction==='desc'?'selected':''}>Newest first</option><option value="asc" ${selection.direction!=='desc'?'selected':''}>Oldest first</option></select></label>`:''}<div class="wide" data-source-args></div><p class="fm-priority-help wide">${escape(entry?.description||'A declared published variable.')} ${selection?'Each matching record is read through its published contract.':''}</p></div>`;
      const argsHost=host.querySelector('[data-source-args]');
      for(const [key,schema]of Object.entries(entry?.argsSchema?.properties||{})){
        const label=document.createElement('label');label.textContent=human(key);const input=document.createElement('input');input.value=typeof source.args?.[key]==='object'?JSON.stringify(source.args[key]):String(source.args?.[key]??'');input.placeholder=schema.description||'';label.append(input);argsHost.append(label);
        input.onchange=()=>{source.args||={};if(!input.value)delete source.args[key];else source.args[key]=schema.type==='number'||schema.type==='integer'?Number(input.value):schema.type==='boolean'?input.value==='true':schema.type==='object'||schema.type==='array'?JSON.parse(input.value):input.value;onchange();};
      }
      host.querySelector('[data-source-choice]').onchange=e=>{selectedId=e.target.value;source=clone(entries.find(item=>item.id===selectedId).source);selection=null;render();onchange();};
      host.querySelector('[data-source-id]').onchange=e=>{if(e.target.value.trim())source.target.id=e.target.value.trim();else delete source.target.id;onchange();};
      host.querySelector('[data-source-path]').onchange=e=>{if(e.target.value.trim())source.path=e.target.value.trim();else delete source.path;onchange();};
      const select=host.querySelector('[data-selection]');if(select)select.onchange=e=>{selection=e.target.value==='single'?null:{where:{},orderBy:'created_at',direction:'desc',pick:e.target.value};if(selection)delete source.target.id;render();onchange();};
      for(const [selector,key]of [['[data-template]','template_id'],['[data-state]','status']]){const input=host.querySelector(selector);if(input)input.onchange=e=>{if(e.target.value)selection.where[key]=e.target.value;else delete selection.where[key];onchange();};}
      const direction=host.querySelector('[data-direction]');if(direction)direction.onchange=e=>{selection.direction=e.target.value;onchange();};
    };render();return {get:()=>({op:'source',source:clone(source),...(selection?{select:clone(selection)}:{})})};
  }
  function calculationEditor(host,entries,value){
    style();let operation=value?.op==='source'?'source':value?.op||'first',missing=value?.missing||'propagate';let nodes=value?.op==='source'?[clone(value)]:clone(value?.inputs||[{op:'source',source:entries[0]?.source}]);let editors=[];
    const capture=()=>{nodes=editors.map(e=>e.get());};
    const render=()=>{
      host.innerHTML=`<div class="fm-priority-calc"><label>Calculate this field<select data-calc-op>${[['source','One variable'],['first','First available variable'],['sum','Sum'],['product','Multiply'],['difference','Subtract'],['quotient','Divide']].map(([id,label])=>`<option value="${id}" ${id===operation?'selected':''}>${label}</option>`).join('')}</select></label><div data-calc-sources></div><div class="fm-priority-actions"><button type="button" data-calc-add>Add source variable</button><label>Missing inputs<select data-calc-missing><option value="propagate" ${missing==='propagate'?'selected':''}>Leave field unset</option><option value="skip" ${missing==='skip'?'selected':''}>Use available inputs</option></select></label></div><p class="fm-priority-help">Zero is a value. Permission or source errors stop the calculation. Use matching currencies and units; select one revision per document when totaling.</p></div>`;
      editors=[];const list=host.querySelector('[data-calc-sources]');
      nodes.forEach((node,index)=>{const row=document.createElement('div');row.className='fm-priority-row';const body=document.createElement('div');row.append(body);const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.disabled=nodes.length===1;remove.onclick=()=>{capture();nodes.splice(index,1);render();};row.append(remove);list.append(row);
        if(node.op==='source')editors.push(sourceEditor(body,entries,node));else{body.textContent='Saved expression: '+node.op;editors.push({get:()=>clone(node)});}
      });
      host.querySelector('[data-calc-op]').onchange=e=>{capture();operation=e.target.value;if(operation==='source')nodes=nodes.slice(0,1);render();};
      host.querySelector('[data-calc-add]').disabled=operation==='source'||nodes.length>=32;host.querySelector('[data-calc-add]').onclick=()=>{capture();nodes.push({op:'source',source:clone(entries[0]?.source)});render();};
      host.querySelector('[data-calc-missing]').onchange=e=>{missing=e.target.value;};
    };render();return {get:()=>{capture();return operation==='source'?nodes[0]:{op:operation,inputs:clone(nodes),...(operation==='first'?{}:{missing})};}};
  }
  async function mountEditor(host,{orgId,branchId,config,entity='project',onchange=()=>{}}){
    style();host.classList.add('fm-priority-editor');host.textContent='Loading declared fields…';const {entries,definitions}=await catalog(orgId,branchId,entity);if(!host.isConnected)return;
    let fields=normalize(config,definitions,entity);let changed=false;
    const update=()=>{changed=true;config.priority_fields=clone(fields);onchange(fields);};
    const render=()=>{
      host.innerHTML=`<p class="fm-priority-help">Choose the ordered fields used in ${escape(human(entity))} headers and other quick displays. A calculated value is its own declared field.</p><div data-priority-list></div><div class="fm-priority-actions"><select data-priority-add aria-label="Add priority field"><option value="">Choose a declared variable…</option>${entries.map(e=>`<option value="${escape(e.id)}">${escape(e.label)}</option>`).join('')}</select><button type="button" data-priority-calculate>Create calculated field</button></div><div data-priority-new></div><div class="fm-priority-status" role="status"></div>`;
      const list=host.querySelector('[data-priority-list]');
      fields.forEach((field,index)=>{
        const row=document.createElement('div');row.className='fm-priority-row';row.innerHTML=`<div><input aria-label="Field label" data-label value="${escape(field.label)}"><small class="fm-priority-help">${escape(human(field.source.provider)+' · '+human(field.source.path?.split('/').at(-1)||field.source.export))}</small><div class="fm-priority-actions"><label>Display<select data-format>${['text','number','currency','date','json'].map(f=>`<option value="${f}" ${field.format===f?'selected':''}>${human(f)}</option>`).join('')}</select></label><label>Currency<input data-currency value="${escape(field.currency||'USD')}" maxlength="3"></label><label>Empty field<select data-empty><option value="hide" ${field.empty!=='show'?'selected':''}>Hide</option><option value="show" ${field.empty==='show'?'selected':''}>Show unset</option></select></label></div><details><summary>Change source variable</summary><div data-source-editor></div></details></div><div class="fm-priority-actions"><button type="button" data-up aria-label="Move ${escape(field.label)} up" ${index===0?'disabled':''}>↑</button><button type="button" data-down aria-label="Move ${escape(field.label)} down" ${index===fields.length-1?'disabled':''}>↓</button><button type="button" data-remove>Remove</button></div>`;
        list.append(row);const source=sourceEditor(row.querySelector('[data-source-editor]'),entries,{op:'source',source:field.source},()=>{field.source=source.get().source;update();},{allowSelection:false});
        // The priority reference stays singular; multi-source selection belongs to a calculated field.
        row.querySelector('[data-selection]')?.closest('label')?.remove();
        for(const [selector,key]of [['[data-label]','label'],['[data-format]','format'],['[data-currency]','currency'],['[data-empty]','empty']])row.querySelector(selector).onchange=e=>{field[key]=key==='currency'?e.target.value.toUpperCase():e.target.value;update();};
        row.querySelector('[data-up]').onclick=()=>{[fields[index-1],fields[index]]=[fields[index],fields[index-1]];update();render();};row.querySelector('[data-down]').onclick=()=>{[fields[index+1],fields[index]]=[fields[index],fields[index+1]];update();render();};row.querySelector('[data-remove]').onclick=()=>{fields.splice(index,1);update();render();};
      });
      host.querySelector('[data-priority-add]').onchange=e=>{const entry=entries.find(item=>item.id===e.target.value);if(!entry)return;if(fields.length>=32){host.querySelector('[role=status]').textContent='Choose at most 32 priority fields.';return;}const field={id:entry.id,label:entry.label,source:clone(entry.source),format:entry.format||'text',currency:entry.currency||'USD',icon:entry.icon||'fa-tag',empty:'hide'};if(fields.some(f=>f.id===field.id))field.id+=':'+root.crypto.randomUUID().slice(0,8);fields.push(field);update();render();};
      host.querySelector('[data-priority-calculate]').onclick=()=>{
        const panel=host.querySelector('[data-priority-new]');panel.innerHTML=`<div class="fm-priority-calc"><label>Field name<input data-new-label placeholder="Contract value"></label><label>Stable field key<input data-new-key placeholder="contract_value"></label><label>Field type<select data-new-type><option value="currency">Currency</option><option value="number">Number</option><option value="text">Text</option></select></label><div data-new-calc></div><div class="fm-priority-actions"><button type="button" data-new-save>Save field and add to priorities</button><button type="button" data-new-cancel>Cancel</button></div></div>`;
        const editor=calculationEditor(panel.querySelector('[data-new-calc]'),entries);
        panel.querySelector('[data-new-cancel]').onclick=()=>{panel.innerHTML='';};
        panel.querySelector('[data-new-save]').onclick=async e=>{
          const label=panel.querySelector('[data-new-label]').value.trim(),key=panel.querySelector('[data-new-key]').value.trim(),type=panel.querySelector('[data-new-type]').value;
          const status=host.querySelector('[role=status]');if(!label||!key||fields.length>=32){status.textContent='Enter a field name and stable key; choose at most 32 priorities.';return;}
          e.target.disabled=true;
          try{
            const module=await root.PlatformAPI.branchModules.get(orgId,sharedOwners.has(entity)?'default':branchId,'custom_fields',{refresh:true}).catch(error=>{if(Number(error.status)===404)return {data:{fields:[]}};throw error;}),data=module?.data||module||{fields:[]};
            if((data.fields||[]).some(f=>(f.entity||'project')===entity&&(f.path||f.key)===key))throw Error('This field key already exists.');
            const definition={entity,path:key,key,label,type,currency:'USD',read_only:true,enabled:true,calculation:editor.get()};
            await root.PlatformAPI.branchModules.save(orgId,sharedOwners.has(entity)?'default':branchId,'custom_fields',{...data,fields:[...(data.fields||[]),definition]},{kind:'branch_custom_fields',source:'priority_fields'});
            const field=custom(definition,entity);fields.push(field);definitions.push(definition);entries.push({...field,listable:false});update();render();root.dispatchEvent(new CustomEvent('fm:custom-fields:definitions-updated',{detail:{orgId,branchId,fields:definitions}}));
          }catch(error){status.textContent=error.message||'Could not save this field.';e.target.disabled=false;}
        };
      };
    };render();
    return {get:()=>clone(fields),commit:()=>{if(!changed)config.priority_fields=clone(fields);}};
  }
  const loadedConfigurations=new WeakSet();
  async function mountOwnerEditor(host,{orgId,branchId='default',entity='project',config:provided,onchange}){
    const configBranch=sharedOwners.has(entity)?'default':branchId;
    const module=await root.PlatformAPI.branchModules.get(orgId,configBranch,'priority_fields',{refresh:true}).catch(error=>{if(Number(error.status)===404)return null;throw error;});
    const data=module?.data||module||{},config=provided||{};if(!loadedConfigurations.has(config)&&Array.isArray(data.entities?.[entity]))config.priority_fields=clone(data.entities[entity]);loadedConfigurations.add(config);
    if(entity==='project'&&!provided&&!config.priority_fields){const legacy=await root.PlatformAPI.branchModules.get(orgId,branchId,'project_configuration').catch(error=>{if(Number(error.status)===404)return null;throw error;});Object.assign(config,legacy?.data||legacy||{});}
    const editor=await mountEditor(host,{orgId,branchId,entity,config,onchange});
    return {...editor,save:async()=>{editor.commit();const latest=await root.PlatformAPI.branchModules.get(orgId,configBranch,'priority_fields',{refresh:true}).catch(error=>{if(Number(error.status)===404)return null;throw error;});const current=latest?.data||latest||{};await root.PlatformAPI.branchModules.save(orgId,configBranch,'priority_fields',{entities:{...current.entities,[entity]:config.priority_fields}},{kind:'priority_fields',source:'priority_fields'});root.dispatchEvent(new CustomEvent('fm:priority-fields:updated',{detail:{orgId,branchId:configBranch,entity}}));}};
  }
  root.FirstMatePriorityFields={builtin,custom,normalize,format,visible,html,resolve,catalog,sourceEditor,calculationEditor,mountEditor,mountOwnerEditor};
})(window);
