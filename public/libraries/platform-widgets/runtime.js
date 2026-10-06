/* Platform widget runtime. Definitions are reusable; every mount owns its state and resources. */
(function(global){
  'use strict';
  if(global.FirstMateWidgets)return;
  const base=new URL('./',document.currentScript.src),definitions=new Map(),renderers=new Map();
  const clone=v=>JSON.parse(JSON.stringify(v));
  const key=(id,version='1')=>id+'@'+version;
  function validate(def,config){
    const schema=def.configSchema||{properties:{},additionalProperties:false};
    for(const [name,value] of Object.entries(config||{})){
      const rule=schema.properties?.[name];if(!rule){if(schema.additionalProperties===false)throw Error('Unknown widget option: '+name);continue;}
      if(rule.type==='integer'&&!Number.isInteger(value)||rule.type==='string'&&typeof value!=='string'||rule.type==='boolean'&&typeof value!=='boolean')throw Error('Invalid widget option: '+name);
      if(rule.enum&&!rule.enum.includes(value)||rule.minimum!=null&&value<rule.minimum||rule.maxLength&&value.length>rule.maxLength)throw Error('Invalid widget option: '+name);
    }
  }
  function register(def,renderer){
    if(!def.id||!def.version||!def.sizing)throw Error('A widget needs identity, version and sizing');
    const k=key(def.id,def.version);if(definitions.has(k))throw Error('Duplicate widget: '+k);
    definitions.set(k,Object.freeze(clone(def)));if(renderer)renderers.set(k,renderer);
  }
  const ready=fetch(new URL('catalog.json?v=20261006-todo-widget',base),{credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error('Widget catalog unavailable');return r.json();}).then(rows=>rows.forEach(def=>register(def)));
  ready.catch(()=>{});
  function styles(){
    if(document.getElementById('fm-widget-styles'))return;
    const el=document.createElement('style');el.id='fm-widget-styles';el.textContent=`
    .fm-widget-presentation{flex-shrink:0;min-width:0;width:100%;margin:10px 0}.fm-widget-preview{max-height:max(600px,80vh);overflow:hidden}.fm-widget-presentation[data-expanded=true]>.fm-widget-preview,.fm-widget-presentation[data-side=true]>.fm-widget-preview{max-height:none;overflow:visible}.fm-widget-preview>fm-platform-widget{display:block;min-width:0;width:100%}.fm-widget-preview>fm-platform-widget[data-sizing=fill]{height:max(480px,65vh)}.fm-widget-presentation[data-side=true] fm-platform-widget[data-sizing=fill]{height:var(--fma-widget-height,65vh)}.fm-widget-presentation[data-side=true] .fm-widget-expand{display:none}.fm-widget-expand{font:inherit;font-size:12px;border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;margin-top:8px}
    .fm-widget,.fm-widget *,.fm-widget-library,.fm-widget-library *{box-sizing:border-box}
    .fm-widget{min-width:0;width:100%;font:inherit;color:inherit}.fm-widget[data-sizing=fill]{height:100%;min-height:var(--fm-widget-min-height,280px)}.fm-widget[data-sizing=aspect]{min-height:240px;aspect-ratio:1.5;position:relative}.fm-widget[data-sizing=content]{height:auto}
    .fm-widget-status{padding:20px;color:#667085;font-size:12px;line-height:1.5}.fm-widget-stack{display:flex;flex-direction:column;gap:12px;min-width:0}.fm-widget-stack>.fm-widget{flex:none}
    .fm-widget-library{height:100%;min-height:360px;min-width:0;display:grid;grid-template-columns:210px minmax(0,1fr);gap:10px;padding:10px;background:#f5f6f8;overflow:hidden}
    .fm-widget-library[data-layout=stacked]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}
    .fm-widget-stage{min-height:0;min-width:0;overflow:auto;grid-column:2;grid-row:1}.fm-widget-pane{height:100%;min-width:0}.fm-widget-pane[hidden]{display:none!important}
    .fm-widget-selector{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;grid-column:1;grid-row:1}
    .fm-widget-selector button{font:inherit;flex:none;cursor:pointer;padding:12px;border:1px solid #e4e7ec;border-radius:9px;background:#fff;color:#475467;text-align:left;font-size:12px;min-width:0}
    .fm-widget-selector button[aria-selected=true]{border-color:var(--primary,#d93025);box-shadow:inset 0 0 0 1px var(--primary,#d93025);color:#101828}
    .fm-widget-library[data-layout=stacked]>.fm-widget-stage{grid-column:1;grid-row:1}.fm-widget-library[data-layout=stacked]>.fm-widget-selector{grid-column:1;grid-row:2;flex-direction:row;overflow-x:auto;padding:2px 1px 4px}.fm-widget-library[data-layout=stacked]>.fm-widget-selector button{white-space:nowrap}
    .fm-widget-card{background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:12px;min-width:0}.fm-widget-card h3{font-size:12px;margin:0 0 10px}.fm-widget-values{display:grid;grid-template-columns:repeat(auto-fit,minmax(125px,1fr));gap:8px}.fm-widget-value{min-width:0;border-radius:7px;background:#f8fafc;padding:8px}.fm-widget-value span{font-size:11px;color:#667085;display:block;overflow-wrap:anywhere}.fm-widget-value strong{display:block;font-size:14px;margin-top:4px;overflow-wrap:anywhere}.fm-widget-list{display:grid;gap:8px}.fm-widget-list article{border:1px solid #e4e7ec;border-radius:8px;padding:10px;font-size:12px}.fm-widget-list small{display:block;color:#667085;margin-top:4px}.fm-widget-photo{width:100%;height:100%;min-height:240px;object-fit:contain;background:#eef1f5;border-radius:10px;display:block}
    `;document.head.append(el);
  }
  function status(root,message){root.replaceChildren();const el=document.createElement('div');el.className='fm-widget-status';el.setAttribute('role','status');el.textContent=message;root.append(el);}
  function mount(root,reference,context={}){
    styles();const ref=clone(reference),config=ref.config||{};let alive=true,revision=0,instance,children=[],visible=true,definition;
    root.classList.add('fm-widget');
    const content=document.createElement('div');content.style.cssText='height:100%;min-width:0';root.append(content);
    const observer=new ResizeObserver(()=>{if(alive&&visible){instance?.resize?.({width:root.clientWidth,height:root.clientHeight});context.onSize?.({width:root.clientWidth,height:root.scrollHeight});}});observer.observe(root);
    function clear(){instance?.destroy?.();instance=null;children.forEach(c=>c.destroy());children=[];content.replaceChildren();}
    async function update(next=context){
      context=next;const generation=++revision;
      try{
        await ready;if(!alive||generation!==revision)return;
        definition=definitions.get(key(ref.id,ref.version||'1'));if(!definition)throw Error('This widget version is unavailable');
        if(!definition.surfaces.includes(context.surface||'project'))throw Error('This widget is not supported on this surface');
        validate(definition,config);root.dataset.sizing=definition.sizing.mode;root.style.setProperty('--fm-widget-min-height',(definition.sizing.minHeight ?? 280)+'px');content.style.height=definition.sizing.mode==='content'?'auto':'100%';
        const renderer=renderers.get(key(definition.id,definition.version));clear();
        if(definition.children){content.className='fm-widget-stack';content.style.height='auto';for(const child of definition.children){const el=document.createElement('div');content.append(el);children.push(mount(el,child,{...context,target:ref.target||context.target}));}await Promise.all(children.map(c=>c.ready));return;}
        if(!renderer)throw Error('The widget renderer is unavailable');
        status(content,'Loading…');
        const source=definition.sources[0];let data=context.data?.[ref.id];
        if(data===undefined&&source){
          const target=ref.target||context.target;
          if(!target?.organizationId||(target.scope!=='organization'&&!target?.projectId))throw Error('Choose a project to display this widget');
          const result=await (context.read||((source,target)=>global.PlatformAPI.publication.read(target.organizationId,{...source,target})))(source,target);
          if(!alive||generation!==revision)return;
          if(result.status!=='ready'){clear();status(content,result.message||({missing:'No data is available yet.',pending:'This report is not ready yet.',denied:'You do not have access to this widget.'}[result.status]||'Unable to load this widget.'));return;}
          data=result.value;
        }
        if(!alive||generation!==revision)return;content.replaceChildren();
        const renderRoot=document.createElement('div');renderRoot.style.cssText=definition.sizing.mode==='content'?'min-width:0':'height:100%;min-width:0';content.append(renderRoot);
        const result=await renderer(renderRoot,{data,config,context,reference:ref,state:ref.state||{},visible});
        if(!alive||generation!==revision){result?.destroy?.();return;}instance=result;instance?.setVisible?.(visible);
      }catch(error){if(alive&&generation===revision){clear();status(content,error.message||'Unable to display this widget.');}}
    }
    const handle={ready:null,update,async configure(next){await ready;validate(definition||definitions.get(key(ref.id,ref.version||'1')),next);Object.keys(config).forEach(k=>delete config[k]);Object.assign(config,clone(next));ref.config=config;return update();},setVisible(value){visible=!!value;instance?.setVisible?.(visible);children.forEach(c=>c.setVisible(visible));},serialize(){return {...clone(ref),...(instance?.serialize?{state:instance.serialize()}:{})};},destroy(){if(!alive)return;alive=false;revision++;observer.disconnect();clear();root.replaceChildren();root.classList.remove('fm-widget');delete root.dataset.sizing;}};
    handle.ready=update();return handle;
  }
  function library(root,{items=[],selected,layout='auto',context={},onSelect}={}){
    styles();root.replaceChildren();const shell=document.createElement('div');shell.className='fm-widget-library';const stage=document.createElement('div'),selector=document.createElement('div');stage.className='fm-widget-stage';selector.className='fm-widget-selector';selector.setAttribute('role','tablist');selector.setAttribute('aria-label','Views');shell.append(selector,stage);root.append(shell);
    let alive=true,current=selected||items[0]?.key;const mounted=new Map(),buttons=new Map(),prefix='fmwv-'+Math.random().toString(36).slice(2);
    const sharedContext=()=>({...context,read:context.read||((source,target)=>global.PlatformAPI.publication.read(target.organizationId,{...source,target}))});
    function select(k){if(!alive)return;const item=items.find(i=>i.key===k);if(!item)return;current=k;
      if(!mounted.has(k)){const pane=document.createElement('div');pane.className='fm-widget-pane';pane.id=prefix+'-'+items.indexOf(item);pane.setAttribute('role','tabpanel');pane.setAttribute('aria-labelledby',pane.id+'-tab');stage.append(pane);mounted.set(k,{pane,widget:mount(pane,item,sharedContext())});}
      for(const [id,{pane,widget}]of mounted){pane.hidden=id!==k;widget.setVisible(id===k);}
      for(const [id,button]of buttons){button.setAttribute('aria-selected',String(id===k));button.tabIndex=id===k?0:-1;}
      onSelect?.(k);
    }
    items.forEach((item,index)=>{const b=document.createElement('button');b.type='button';b.textContent=item.title||item.id;b.id=prefix+'-'+index+'-tab';b.setAttribute('role','tab');b.setAttribute('aria-controls',prefix+'-'+index);b.onclick=()=>select(item.key);b.onkeydown=e=>{const step=e.key==='ArrowRight'||e.key==='ArrowDown'?1:e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:0;if(step){e.preventDefault();const next=items[(index+step+items.length)%items.length];select(next.key);buttons.get(next.key).focus();}};selector.append(b);buttons.set(item.key,b);});
    const observer=new ResizeObserver(()=>{shell.dataset.layout=layout==='stacked'||layout==='auto'&&shell.clientWidth<1200?'stacked':'wide';});observer.observe(shell);shell.dataset.layout=layout==='wide'?'wide':'stacked';select(current);
    return {select,update(next,options={}){context=next;for(const [k,entry] of mounted){const item=items.find(i=>i.key===k);if(!options.ids||options.ids.includes(item.id))entry.widget.update(sharedContext());}},serialize(){return {selected:current,layout,items:items.map(item=>mounted.get(item.key)?.widget.serialize()||clone(item))};},destroy(){alive=false;observer.disconnect();for(const entry of mounted.values())entry.widget.destroy();root.replaceChildren();},setVisible(value){for(const [k,entry]of mounted)entry.widget.setVisible(value&&k===current);}};
  }
  function attachRenderer(id,version,render){renderers.set(key(id,version),render);}
  // Adapter for the existing document registry: it retains its own pagination contract.
  function registerDocumentWidget(def){if(definitions.has(key('document.'+def.id,String(def.version))))return;register({id:'document.'+def.id,version:String(def.version),title:def.title,description:def.title,app:'documents',surfaces:['document','dashboard'],configSchema:{type:'object',properties:{},additionalProperties:true},sources:[],sizing:{mode:'content',minWidth:180}},(root,{context,config})=>{const render=context.interactive?def.renderInteractive||def.renderStatic:def.renderStatic;return render(root,{...context.documentContext,config});});}
  function adoptDocumentWidgets(){for(const def of global.FMDocWidgets?.list?.()||[])registerDocumentWidget(def);}
  global.addEventListener('fm:document-widget-registered',event=>registerDocumentWidget(event.detail));
  adoptDocumentWidgets();
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function presentationHtml(renders=[],{side=false}={}){
    styles();
    const widgetHtml=r=>`<section class="fm-widget-presentation" data-side="${side}"><div class="fm-widget-preview"><fm-platform-widget surface="assistant" reference="${escape(JSON.stringify(r.widget))}" aria-label="${escape(r.title||'Project widget')}"></fm-platform-widget></div><button type="button" class="fm-widget-expand" aria-expanded="false">Expand widget</button></section>`;
    return (Array.isArray(renders)?renders:[]).map(r=>{
      if(r.type==='platform_widget'&&r.widget)return widgetHtml(r);
      if(r.type!=='panel')return '';
      const children=(Array.isArray(r.widgets)?r.widgets:[]).slice(0,6).filter(w=>w.type==='platform_widget'&&w.widget);
      if(!children.length)return '';
      return `<section class="fm-chat-panel" data-chat-panel-id="${escape(r.id||'')}"><header><h3>${escape(r.title||'Panel')}</h3></header>${children.map(widgetHtml).join('')}</section>`;
    }).join('');
  }
  global.document.addEventListener('click',event=>{const button=event.target.closest?.('.fm-widget-expand');if(!button)return;const card=button.closest('.fm-widget-presentation');const expanded=card.dataset.expanded!=='true';card.dataset.expanded=String(expanded);button.setAttribute('aria-expanded',String(expanded));button.textContent=expanded?'Collapse widget':'Expand widget';});
  if(!customElements.get('fm-platform-widget'))customElements.define('fm-platform-widget',class extends HTMLElement{
    static get observedAttributes(){return ['reference','surface'];}
    connectedCallback(){this.refresh();let seen=false,wasVisible=false;this.visibility=new IntersectionObserver(entries=>{const visible=entries.some(e=>e.isIntersecting);this.handle?.setVisible(visible);if(seen&&visible&&!wasVisible)this.refresh();seen=true;wasVisible=visible;});this.visibility.observe(this);}
    disconnectedCallback(){this.visibility?.disconnect();this.handle?.destroy();this.handle=null;}
    attributeChangedCallback(){if(this.isConnected)this.refresh();}
    refresh(){this.handle?.destroy();try{const ref=JSON.parse(this.getAttribute('reference')||'{}');const org=global.__APP?.userOrgId;if(org&&ref.target?.organizationId&&ref.target.organizationId!==org)throw Error('This widget belongs to another organization.');this.handle=mount(this,ref,{surface:this.getAttribute('surface')||'assistant'});}catch(error){status(this,error.message);}}
  });
  global.FirstMateWidgets={presentationHtml,ready,register,attachRenderer,mount,library,registerDocumentWidget,list:async()=>{await ready;return [...definitions.values()].map(clone);},describe:async(id,version='1')=>{await ready;const def=definitions.get(key(id,version));return def?clone(def):null;}};
  global.FirstMateProjectTrays?.registerWidgets?.();
})(window);
