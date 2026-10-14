/* Settings discovery: generated UI text plus the current user's rendered controls. */
(function(root){
  'use strict';
  const clean = value => String(value ?? '').replace(/\s+/g,' ').trim();
  const normalize = value => clean(value).normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const controls = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]),select,textarea,[role="switch"],[aria-pressed]';
  const ignored = 'script,style,option,textarea,input,select,[contenteditable],.rp-state,[data-settings-search-results],[data-settings-search-ignore]';
  let attachment = null, pending = null;
  const subscriptions = new Set();
  const sourceEntries = () => root.FirstMateSettingsIndex?.entries || [];
  const textOf = (element, labelOnly=false) => {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll(ignored+(labelOnly?',small,[data-fm-tooltip],[data-tooltip],.fm-ui-help':'')).forEach(node=>node.remove());
    const walker=document.createTreeWalker(clone,NodeFilter.SHOW_TEXT);const parts=[];while(walker.nextNode())parts.push(walker.currentNode.textContent);
    return clean(parts.join(' ')).replace(/\s*\?\s*$/,'');
  };
  const tooltip = element => clean([element?.getAttribute('data-fm-tooltip'),element?.getAttribute('data-tooltip'),element?.getAttribute('title')].filter(Boolean).join(' '));
  function selectorFor(element){
    if (element.id && !element.id.includes('FM_DYNAMIC')) return `[id="${CSS.escape(element.id)}"]`;
    for (const attr of element.attributes) {
      if (/^data-/.test(attr.name) && !/(?:value|state|loaded|mounted|val|index|settings-search)/.test(attr.name) && !attr.value.includes('FM_DYNAMIC')) return `[${attr.name}="${CSS.escape(attr.value)}"]`;
    }
    if (element.getAttribute('name')) return `[name="${CSS.escape(element.name)}"]`;
    return '';
  }
  function extract(host, context = {}){
    const entries = [], seen = new Set();
    const add = (node,title,description,kind,selector='') => {
      title=clean(title); description=clean(description);
      if (!title || title.length>120 || /FM_DYNAMIC|Loading|Could not load|^return |^Search |^Filter /i.test(title)) return;
      if (node.closest('[data-settings-search-ignore],[data-settings-search-results],script,style,pre,code')) return;
      let view=context.view||'';
      for(let parent=node;parent&&parent!==host;parent=parent.parentElement){
        const attr=Array.from(parent.attributes||[]).find(a=>/^data-(?:[\w-]+-)?(?:view-pane|pane|panel)$/.test(a.name)&&a.name!=='data-settings-pane'&&/^[a-z][a-z0-9_-]*$/.test(a.value));
        if(attr){view=attr.value;break;}
      }
      const nav=Array.from(node.attributes||[]).find(a=>/^data-(?:[\w-]+-)?(?:view|subtab|subtab-value|tab)$/.test(a.name)&&/^[a-z][a-z0-9_-]*$/.test(a.value));
      if(nav)view=nav.value;
      const key=normalize(title)+'|'+view+'|'+selector;
      if (seen.has(key)) return; seen.add(key);
      entries.push({...context,view,title,description:description.includes('FM_DYNAMIC')?'':description,kind,selector,element:node});
    };
    host.querySelectorAll(controls).forEach(control=>{
      if (control.closest('[data-settings-search-ignore]')) return;
      const labels=Array.from(control.labels || []);
      const label=labels[0] || control.closest('label');
      const selfLabelled=control.matches('button,[role="switch"],[role="checkbox"]');
      let wrapper=label || (selfLabelled?control:control.parentElement);
      if(!label){for(let i=0;i<3&&wrapper?.parentElement&&wrapper!==host&&!textOf(wrapper);i++)wrapper=wrapper.parentElement;}
      // Many older settings use a sibling .*-label rather than <label for>.
      if (selfLabelled || (!label && wrapper?.querySelectorAll(controls).length<=3 && textOf(wrapper).length<400)) {} else if (!label) wrapper=null;
      const labelled=clean((control.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>textOf(host.querySelector(`[id="${CSS.escape(id)}"]`))).join(' '));
      const strong=label?.querySelector('strong,.rp-label') || wrapper?.querySelector('[class$="-label"],.bl-pill,.rp-label');
      const title=labelled || control.getAttribute('aria-label') || textOf(strong) || textOf(label,true) || textOf(wrapper,true);
      const described=clean((control.getAttribute('aria-describedby') || '').split(/\s+/).map(id=>textOf(host.querySelector(`[id="${CSS.escape(id)}"]`))).join(' '));
      const tips=Array.from((wrapper || control).querySelectorAll('[data-fm-tooltip],[data-tooltip],[title]')).map(tooltip);
      add(control,title,[tooltip(control),tooltip(wrapper),described,...Array.from((wrapper||control).querySelectorAll('small')).map(e=>textOf(e)),...tips].filter(Boolean).join(' '),'control',selectorFor(control));
    });
    host.querySelectorAll('h1,h2,h3,h4,h5,h6,summary,[role="tab"],label,[class$="-label"],button').forEach(node=>{
      if(node.tagName==='BUTTON'&&!Array.from(node.attributes).some(a=>/^data-(?:[\w-]+-)?(?:view|subtab|subtab-value|tab)$/.test(a.name)))return;
      if (node.matches('label') && node.querySelector(controls)) return;
      if (node.matches('[class$="-label"]') && (node.parentElement?.matches(controls)||node.parentElement?.querySelector(controls))) return;
      add(node,textOf(node),tooltip(node),node.matches('[role="tab"],button')?'view':'heading',selectorFor(node));
    });
    return entries;
  }
  function distanceOne(a,b){
    if(Math.abs(a.length-b.length)>1)return false;
    let i=0,j=0,edits=0;
    while(i<a.length&&j<b.length){if(a[i]===b[j]){i++;j++;continue;}if(++edits>1)return false;
      if(a[i]===b[j+1]&&a[i+1]===b[j]){i+=2;j+=2;continue;}
      if(a.length>=b.length)i++;if(b.length>=a.length)j++;
    }
    return edits+(i<a.length||j<b.length?1:0)<=1;
  }
  function localized(item){
    const title=item.translation ? root.PlatformLanguage?.text?.(...item.translation) || item.title : item.title;
    const tab=attachment?.sections.get(item.section)?.title || item.tab;
    return {...item,title,tab};
  }
  function search(query, options={}){
    const needle=normalize(query);if(!needle)return [];
    const tokens=needle.split(' '), allowed=options.sections?new Set(options.sections):attachment?new Set(attachment.sections.keys()):null;
    const entries=[...(attachment?.live || []),...sourceEntries()], unique=new Map();
    for(const original of entries){
      if(allowed&&!allowed.has(original.section))continue;
      if(attachment&&!attachment.sections.has(original.section))continue;
      const item=localized(original), title=normalize(item.title), desc=normalize(item.description), tab=normalize(item.tab), words=(title+' '+tab+' '+desc+' '+normalize(item.keywords)).split(' ');
      let penalty=0;
      if(!tokens.every(token=>{
        if(words.some(word=>word===token))return true;
        if(words.some(word=>word.startsWith(token))){penalty+=1;return true;}
        if(token.length>=5&&title.split(' ').some(word=>word.length>=4&&distanceOne(word,token))){penalty+=5;return true;}
        return false;
      }))continue;
      const score=(title===needle?0:title.startsWith(needle)?10:tokens.every(t=>title.includes(t))?20:30)+penalty+(item.kind==='section'?3:0);
      const key=item.section+'|'+(item.view||'')+'|'+title;
      const old=unique.get(key);if(!old||score<old.score)unique.set(key,{...item,score});
    }
    return [...unique.values()].sort((a,b)=>a.score-b.score||a.title.localeCompare(b.title)).slice(0,options.limit||40);
  }
  function notify(){subscriptions.forEach(fn=>fn());}
  function attach(panel, sections, route){
    attachment?.destroy();
    const current={panel,sections:new Map(sections.map(s=>[s.id,s])),live:[],route,destroy:null};attachment=current;
    let timer;
    const refresh=()=>{
      if(!panel.isConnected){current.destroy();return;}
      const entries=[];
      for(const section of sections){
        const pane=panel.querySelector(`[data-settings-pane="${CSS.escape(section.id)}"]`);if(!pane)continue;
        const location=route?.()||{};
        // Only the active page has a reliable nested route. Never associate stale DOM with a new route.
        if(!pane.classList.contains('active'))continue;
        entries.push(...extract(pane,{section:section.id,tab:section.title,view:location.settingsView||'',live:true}));
      }
      current.live=entries;notify();reveal();
    };
    const observer=new MutationObserver(records=>{
      if(records.every(r=>(r.target.nodeType===3?r.target.parentElement:r.target).closest?.('[data-settings-search-results],.cs-settings-search')))return;
      clearTimeout(timer);timer=setTimeout(refresh,150);
    });
    observer.observe(panel,{subtree:true,childList:true,characterData:true});
    current.destroy=()=>{observer.disconnect();clearTimeout(timer);if(attachment===current)attachment=null;};
    refresh();return current;
  }
  function reveal(){
    if(!pending||!attachment)return;
    if(Date.now()>pending.until){pending=null;return;}
    const {item}=pending,pane=attachment.panel.querySelector(`[data-settings-pane="${CSS.escape(item.section)}"].active`);
    if(!pane)return;
    let target=item.selector?pane.querySelector(item.selector):null;
    if(!target)target=extract(pane).find(entry=>normalize(entry.title)===normalize(item.title))?.element;
    if(!target)return;
    for(let parent=target.parentElement;parent&&parent!==pane;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    if(!target.getClientRects().length)return;
    target.scrollIntoView({block:'center',behavior:'smooth'});
    if(target.matches('input,select,textarea,button,[tabindex]'))target.focus({preventScroll:true});
    target.animate?.([{outline:'3px solid #f4b740',outlineOffset:'5px'},{outline:'3px solid transparent',outlineOffset:'5px'}],{duration:2200});
    pending=null;
  }
  function open(item,options={}){
    if(!item?.section||!root.Portal?.navigation?.navigate)return false;
    if(attachment&&!attachment.sections.has(item.section))return false;
    pending={item,until:Date.now()+10000};
    root.Portal.navigation.navigate({tab:'company_settings',sub:item.section,settingsView:item.view||'',settingsEntity:'',scopeTemplateView:'',workflow:'',workflow_step:''},{source:options.source||'settings-search',ownedKeys:['tab','sub','settingsView','settingsEntity','scopeTemplateView','workflow','workflow_step']});
    setTimeout(reveal,0);return true;
  }
  root.FirstMateSettingsSearch={get catalog(){return sourceEntries();},search,open,extract,attach,normalize,subscribe(fn){subscriptions.add(fn);return()=>subscriptions.delete(fn);}};
})(window);
