function element(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
// Children are created on expansion, so large catalogs start at their top level.
export function jsonTree(value,name='Contract'){
 if(value===null||typeof value!=='object')return element('div',name+': '+JSON.stringify(value),'fm-dev-json-leaf');
 const node=element('details',undefined,'fm-dev-json');
 const entries=Object.entries(value);node.append(element('summary',name+' '+(Array.isArray(value)?`[${entries.length}]`:`{${entries.length}}`)));
 let rendered=false;node.addEventListener('toggle',()=>{if(!node.open||rendered)return;rendered=true;const children=element('div');for(const [key,v]of entries)children.append(jsonTree(v,key));node.append(children);});return node;
}
export function mountSoftwareLayers(root,api){
 root.innerHTML='<p class="fm-dev-layer-intro">Inspect declared contracts across apps, connections and documents. Expand a namespace to see its declarations, then expand a declaration to browse its schema.</p><div class="fm-dev-layer-controls"><label>Layer<select data-layer><option value="all">All layers</option><option value="artifacts">Artifacts</option><option value="widgets">Widgets</option><option value="data">Data (including custom fields)</option><option value="actions">Actions</option><option value="dataset types">Dataset types</option><option value="modules">Modules</option></select></label><label>Declared in<select data-scope><option value="all">All scopes</option><option value="global">Global</option><option value="organization">Organization</option><option value="project">Project</option></select></label><label>Project<select data-project><option value="">Organization declarations</option></select></label><label>Search<input data-search type="search" placeholder="Name, app or nested field"></label><button type="button" data-refresh>Refresh</button></div><p data-layer-status role="status" aria-live="polite"></p><div data-layer-list></div><div data-layer-notes class="fm-dev-layer-notes"></div>';
 const list=root.querySelector('[data-layer-list]'),status=root.querySelector('[data-layer-status]'),project=root.querySelector('[data-project]'),refresh=root.querySelector('[data-refresh]');
 let data,request=0;
 function paint(){
  if(!data)return;
  const layer=root.querySelector('[data-layer]').value,scope=root.querySelector('[data-scope]').value,search=root.querySelector('[data-search]').value.trim().toLowerCase();
  const rows=data.items.filter(item=>(layer==='all'||item.layer===layer)&&(scope==='all'||item.declarationScope===scope)&&(!search||JSON.stringify(item).toLowerCase().includes(search))).sort((a,b)=>['global','organization','project'].indexOf(a.declarationScope)-['global','organization','project'].indexOf(b.declarationScope)||a.layer.localeCompare(b.layer)||a.id.localeCompare(b.id));
  list.replaceChildren();status.textContent=`${rows.length} of ${data.items.length} declarations`;
  const groups=new Map();
  for(const item of rows){const key=item.declarationScope+' \u00b7 '+item.layer;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
  for(const [key,items]of groups){
   list.append(element('h3',key,'fm-dev-layer-heading'));
   const tree={children:new Map(),items:[]};
   for(const item of items){let node=tree;for(const part of item.id.split('.')){if(!node.children.has(part))node.children.set(part,{children:new Map(),items:[]});node=node.children.get(part);}node.items.push(item);}
   const count=node=>node.items.length+[...node.children.values()].reduce((total,child)=>total+count(child),0);
   const declaration=item=>{
    const row=element('details',undefined,'fm-dev-layer-row');const summary=element('summary');const label=element('span');label.append(element('strong',item.id),element('small',item.origin+(item.version?' \u00b7 v'+item.version:'')));summary.append(label,element('span','Used in: '+item.scopes.join(', '),'fm-dev-layer-badge'));row.append(summary);
    let rendered=false;row.addEventListener('toggle',()=>{if(!row.open||rendered)return;rendered=true;const content=element('div',undefined,'fm-dev-layer-contract');for(const [name,value]of Object.entries(item.details||{}))content.append(jsonTree(value,name));row.append(content);});return row;
   };
   const branch=(node,path)=>{
    if(!node.children.size&&node.items.length===1)return declaration(node.items[0]);
    const row=element('details',undefined,'fm-dev-namespace');row.dataset.namespace=path;
    const summary=element('summary');summary.append(element('strong',path),element('small',count(node)+' declarations'));row.append(summary);
    let rendered=false;row.addEventListener('toggle',()=>{if(!row.open||rendered)return;rendered=true;const children=element('div',undefined,'fm-dev-namespace-children');for(const item of node.items)children.append(declaration(item));for(const [name,child]of node.children)children.append(branch(child,path+'.'+name));row.append(children);});return row;
   };
   for(const [name,node]of tree.children)list.append(branch(node,name));
  }
  if(!rows.length)list.append(element('p','No declarations match these filters.'));
 }
 async function load(){
  const token=++request;status.textContent='Loading declarations…';refresh.disabled=true;list.replaceChildren();data=null;
  try{const result=await api('/software-layers'+(project.value?'?projectId='+encodeURIComponent(project.value):''));if(token!==request)return;
   // Some interactive app widgets register only in the current browser host.
   const local=await window.FirstMateWidgets?.list?.()||[];if(token!==request)return;
   for(const widget of local)if(!result.items.some(item=>item.layer==='widgets'&&item.id===widget.id&&String(item.version)===String(widget.version)))result.items.push({layer:'widgets',id:widget.id,version:widget.version,origin:widget.app+' (browser registry)',declarationScope:'global',scopes:['project'],details:widget});
   data=result;
   const selected=project.value;project.replaceChildren(new Option('Organization declarations',''));for(const p of result.projects)project.append(new Option(p.label,p.id));project.value=selected;
   root.querySelector('[data-layer-notes]').replaceChildren(...result.notes.map(note=>element('p',note)));paint();
  }catch(error){if(token===request)status.textContent=error.message||'Could not load declarations. Use Refresh to retry.';}
  finally{if(token===request)refresh.disabled=false;}
 }
 root.querySelector('[data-layer]').onchange=paint;root.querySelector('[data-scope]').onchange=paint;root.querySelector('[data-search]').oninput=paint;project.onchange=load;refresh.onclick=load;load();
}
