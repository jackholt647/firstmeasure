import { mountSoftwareLayers } from './software-layers.js?v=20261006-tree4';
let mounted = false;
export async function mount() {
 if (mounted || window.top !== window) return;
 const api = (path, options) => window.PlatformAPI.request(location.origin + '/v1/signup-sandbox/development' + path, options);
 const catalog = await api('');
 const anchor = document.getElementById('platformAssistantSlot');
 if (!anchor) return;
 mounted = true;
 const style = document.createElement('link');style.rel='stylesheet';style.href='/libraries/development-tools/development-tools.css?v=20261006-tree4-layers';document.head.append(style);
 const slot=document.createElement('div');slot.className='fm-dev-slot';
 slot.innerHTML='<button type="button" class="ptb-bell" aria-label="Development tools" aria-haspopup="dialog" aria-expanded="false" data-dev-open><i class="fas fa-code" aria-hidden="true"></i></button>';
 anchor.before(slot);
 const button=slot.querySelector('[data-dev-open]');
 let frame,busy=false,requestId,activeAnchor=button,suppressHover=false,hoverTimer;
 const isOpen=()=>!!frame&&!frame.hidden;
 function position(){if(!isOpen())return;const fontHost=document.querySelector(window.matchMedia('(max-width:820px)').matches?'.mobile-topbar':'#platformTopbar')||anchor;frame.style.fontFamily=getComputedStyle(fontHost).fontFamily;if(frame.classList.contains('fm-dev-fullscreen')){frame.style.top='8px';frame.style.right='8px';frame.style.maxHeight='calc(100dvh - 16px)';return;}const mobile=window.matchMedia('(max-width:820px)').matches;const bar=document.querySelector(mobile?'.mobile-topbar':'#platformTopbar');const bounds=bar?.getBoundingClientRect()||activeAnchor.getBoundingClientRect();frame.style.top=Math.max(8,bounds.bottom+8)+'px';frame.style.right='12px';frame.style.maxHeight=Math.max(160,window.innerHeight-bounds.bottom-24)+'px';}
 function close(){clearTimeout(hoverTimer);if(frame)frame.hidden=true;suppressHover=true;slot.classList.remove('fm-dev-open');button.setAttribute('aria-expanded','false');}
 function toggle(){if(isOpen())close();else open();}
 document.addEventListener('pointerdown',event=>{if(isOpen()&&!frame.contains(event.target)&&!slot.contains(event.target)&&!event.target.closest('[data-dev-mobile]'))close();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&isOpen()){close();activeAnchor.focus();}});
 window.addEventListener('resize',position);window.addEventListener('scroll',position,true);
 function open(){
  slot.classList.add('fm-dev-open');button.setAttribute('aria-expanded','true');
  if(frame){frame.hidden=false;position();return;}
  frame=document.createElement('section');frame.className='fm-dev-window';frame.setAttribute('role','dialog');frame.setAttribute('aria-label','Development tools');
  const header=document.createElement('header');header.innerHTML='<i class="fas fa-code fm-dev-mark" aria-hidden="true"></i><strong>Development</strong><button type="button" class="fm-dev-expand" aria-label="Expand development tools" aria-pressed="false"><i class="fas fa-expand" aria-hidden="true"></i></button><button type="button" class="fm-dev-close" aria-label="Close development tools"><i class="fas fa-xmark" aria-hidden="true"></i></button>';header.querySelector('.fm-dev-close').onclick=close;
  header.querySelector('.fm-dev-expand').onclick=()=>{const expanded=frame.classList.toggle('fm-dev-fullscreen');header.querySelector('.fm-dev-expand').setAttribute('aria-pressed',String(expanded));header.querySelector('.fm-dev-expand').setAttribute('aria-label',expanded?'Restore development dropdown':'Expand development tools');position();};
  const body=document.createElement('div');body.className='fm-dev-body';
  body.innerHTML='<div class="fm-dev-fields"><label class="fm-dev-company">Company type<select data-dev-company></select></label><label class="fm-dev-company">Amount<select data-dev-amount><option value="1">1×</option><option value="3">3×</option><option value="5">5×</option><option value="10">10×</option></select></label></div><details class="fm-dev-section" open><summary><span><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Synthetic data</span><small data-dev-count></small></summary><div data-dev-categories></div></details><div class="fm-dev-results" role="status" aria-live="polite" hidden></div><div class="fm-dev-footer"><button type="button" class="fm-dev-generate" data-dev-generate><i class="fas fa-plus" aria-hidden="true"></i> Add synthetic data</button></div>';
  for(const company of catalog.companies){const option=document.createElement('option');option.value=company.id;option.textContent=company.label;body.querySelector('select').append(option);}
  for(const category of catalog.categories){
   const row=document.createElement('label');row.className='fm-dev-option';
   const icon=document.createElement('i');icon.className='fas '+category.icon;icon.setAttribute('aria-hidden','true');
   const text=document.createElement('span');const name=document.createElement('strong');name.textContent=category.label;text.append(name);
   const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=true;toggle.dataset.devCategory=category.id;toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',category.label);
   row.append(icon,text,toggle);body.querySelector('[data-dev-categories]').append(row);
  }
  const generate=body.querySelector('[data-dev-generate]');
  const update=()=>{const count=body.querySelectorAll('[data-dev-category]:checked').length;body.querySelector('[data-dev-count]').textContent=count+' of '+catalog.categories.length;generate.disabled=busy||!count;};
  body.addEventListener('change',update);update();
  generate.onclick=async()=>{
   if(busy)return;requestId ||= crypto.randomUUID();busy=true;update();
   const report=body.querySelector('.fm-dev-results');report.hidden=false;report.textContent='Adding your sample data…';generate.textContent='Adding data…';
   body.querySelectorAll('input,select').forEach(el=>el.disabled=true);
   try {
    const result=await api('/synthetic-data',{method:'POST',body:{company:body.querySelector('[data-dev-company]').value,amount:Number(body.querySelector('[data-dev-amount]').value),request_id:requestId,categories:Object.fromEntries([...body.querySelectorAll('[data-dev-category]')].map(el=>[el.dataset.devCategory,el.checked]))}});
    report.replaceChildren();const heading=document.createElement('strong');const failed=Object.values(result.results).some(r=>r.status==='failed');if(!failed)requestId=null;heading.textContent=failed?'Some samples need attention':'Data added';report.append(heading);
    for(const [key,value]of Object.entries(result.results)){
     const line=document.createElement('div');line.className=value.status==='failed'?'fm-dev-error':'';
     const label=catalog.categories.find(c=>c.id===key)?.label||key;
     const count=typeof value.created==='number'?value.created: Object.values(value.created||{}).reduce((a,b)=>a+Number(b||0),0);
     line.textContent=label+': '+(value.status==='failed'?value.error:key==='communication'?count+' emails · '+Number(value.channels?.messages||0)+' channel messages':count+' added'+(value.drafts?' · '+value.drafts+' drafts':''));report.append(line);
    }
    const refresh=document.createElement('button');refresh.type='button';refresh.className='fm-dev-refresh';refresh.textContent='Refresh workspace';refresh.onclick=()=>location.reload();report.append(refresh);
    window.dispatchEvent(new CustomEvent('development:synthetic-data',{detail:result}));
   } catch(error){report.textContent=error.message||'Could not add sample data. You can retry safely.';}
   finally {busy=false;body.querySelectorAll('input,select').forEach(el=>el.disabled=false);generate.textContent='Add synthetic data';update();report.scrollIntoView({block:'nearest',behavior:'smooth'});}
  };
  const tabs=document.createElement('nav');tabs.className='fm-dev-tabs';tabs.setAttribute('aria-label','Development views');tabs.innerHTML='<button type="button" aria-pressed="true" data-dev-tab="synthetic">Synthetic data</button><button type="button" aria-pressed="false" data-dev-tab="layers">Software layers</button>';
  const layers=document.createElement('div');layers.className='fm-dev-body fm-dev-layers';layers.hidden=true;let layersMounted=false;
  tabs.onclick=event=>{const tab=event.target.closest('[data-dev-tab]');if(!tab)return;const software=tab.dataset.devTab==='layers';body.hidden=software;layers.hidden=!software;tabs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===tab)));if(software&&!layersMounted){layersMounted=true;mountSoftwareLayers(layers,api);}};
  frame.append(header,tabs,body,layers);document.body.append(frame);position();

 }
 button.onclick=()=>{clearTimeout(hoverTimer);activeAnchor=button;toggle();};
 slot.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse'&&!suppressHover)hoverTimer=setTimeout(()=>{activeAnchor=button;open();},350);});slot.addEventListener('pointerleave',()=>{clearTimeout(hoverTimer);suppressHover=false;});
 const more=document.getElementById('mobilePlatformMoreMenu');
 if(more){const mobile=document.createElement('button');mobile.type='button';mobile.className='ptb-more-item';mobile.dataset.devMobile='';mobile.innerHTML='<i class="fas fa-code" aria-hidden="true"></i><span>Development tools</span>';more.prepend(mobile);mobile.onclick=()=>{activeAnchor=document.getElementById('mobilePlatformMoreBtn');activeAnchor?.click();toggle();};}

}
