let mounted = false;
export async function mount() {
 if (mounted || window.top !== window) return;
 const api = (path, options) => window.PlatformAPI.request(location.origin + '/v1/signup-sandbox/development' + path, options);
 const catalog = await api('');
 const anchor = document.getElementById('platformAssistantSlot');
 if (!anchor || !window.FirstMateWindows) return;
 mounted = true;
 const style = document.createElement('link');style.rel='stylesheet';style.href='/libraries/development-tools/development-tools.css?v=20261005-1';document.head.append(style);
 const slot=document.createElement('div');slot.className='fm-dev-slot';
 slot.innerHTML='<button type="button" class="ptb-bell" aria-label="Development tools" aria-haspopup="dialog" aria-expanded="false" data-dev-open><i class="fas fa-code" aria-hidden="true"></i></button><div class="fm-dev-preview" role="tooltip"><span class="fm-dev-eyebrow">DEVELOPMENT</span><strong>Build your test workspace</strong><span>Add realistic roofing data to this sandbox.</span><button type="button" data-dev-launch><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Synthetic data <i class="fas fa-arrow-right" aria-hidden="true"></i></button></div>';
 anchor.before(slot);
 const button=slot.querySelector('[data-dev-open]');
 let controller,frame,busy=false;
 function open(){
  slot.classList.add('fm-dev-open');button.setAttribute('aria-expanded','true');
  if(controller){controller.setVisible(true);controller.restore();controller.focus();return;}
  frame=document.createElement('section');frame.className='fm-dev-window';
  const header=document.createElement('header');header.innerHTML='<i class="fas fa-code fm-dev-mark" aria-hidden="true"></i><strong>Development</strong>';
  const body=document.createElement('div');body.className='fm-dev-body';
  body.innerHTML='<div class="fm-dev-intro"><span class="fm-dev-eyebrow">SANDBOX WORKSPACE</span><h2>Make it feel like a real company.</h2><p>Add sample data, then explore your workflows.</p></div><label class="fm-dev-company">Company type<select data-dev-company></select></label><details class="fm-dev-section" open><summary><span><i class="fas fa-wand-magic-sparkles" aria-hidden="true"></i> Synthetic data</span><small data-dev-count></small></summary><div data-dev-categories></div></details><p class="fm-dev-hint">Adds missing samples and preserves your edits. Messages are fictional; nothing is sent.</p><div class="fm-dev-results" role="status" aria-live="polite" hidden></div><div class="fm-dev-footer"><button type="button" class="fm-dev-generate" data-dev-generate><i class="fas fa-plus" aria-hidden="true"></i> Add synthetic data</button></div>';
  for(const company of catalog.companies){const option=document.createElement('option');option.value=company.id;option.textContent=company.label;body.querySelector('select').append(option);}
  for(const category of catalog.categories){
   const row=document.createElement('label');row.className='fm-dev-option';
   const icon=document.createElement('i');icon.className='fas '+category.icon;icon.setAttribute('aria-hidden','true');
   const text=document.createElement('span');const name=document.createElement('strong');name.textContent=category.label;const description=document.createElement('small');description.textContent=category.description;text.append(name,description);
   const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=true;toggle.dataset.devCategory=category.id;toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',category.label);
   row.append(icon,text,toggle);body.querySelector('[data-dev-categories]').append(row);
  }
  const generate=body.querySelector('[data-dev-generate]');
  const update=()=>{const count=body.querySelectorAll('[data-dev-category]:checked').length;body.querySelector('[data-dev-count]').textContent=count+' of '+catalog.categories.length;generate.disabled=busy||!count;};
  body.addEventListener('change',update);update();
  generate.onclick=async()=>{
   if(busy)return;busy=true;update();
   const report=body.querySelector('.fm-dev-results');report.hidden=false;report.textContent='Adding your sample data…';generate.textContent='Adding data…';
   body.querySelectorAll('input,select').forEach(el=>el.disabled=true);
   try {
    const result=await api('/synthetic-data',{method:'POST',body:{company:body.querySelector('select').value,categories:Object.fromEntries([...body.querySelectorAll('[data-dev-category]')].map(el=>[el.dataset.devCategory,el.checked]))}});
    report.replaceChildren();const heading=document.createElement('strong');const failed=Object.values(result.results).some(r=>r.status==='failed');heading.textContent=failed?'Some samples need attention':'Your sample data is ready';report.append(heading);
    for(const [key,value]of Object.entries(result.results)){
     const line=document.createElement('div');line.className=value.status==='failed'?'fm-dev-error':'';
     const label=catalog.categories.find(c=>c.id===key)?.label||key;
     const count=typeof value.created==='number'?value.created: Object.values(value.created||{}).reduce((a,b)=>a+Number(b||0),0);
     line.textContent=label+': '+(value.status==='failed'?value.error:count+' added'+(value.drafts?' · '+value.drafts+' drafts':'')+(value.note?' · '+value.note:''));report.append(line);
    }
    const refresh=document.createElement('button');refresh.type='button';refresh.className='fm-dev-refresh';refresh.textContent='Refresh workspace';refresh.onclick=()=>location.reload();report.append(refresh);
    window.dispatchEvent(new CustomEvent('development:synthetic-data',{detail:result}));
   } catch(error){report.textContent=error.message||'Could not add sample data. You can retry safely.';}
   finally {busy=false;body.querySelectorAll('input,select').forEach(el=>el.disabled=false);generate.textContent='Add synthetic data';update();report.scrollIntoView({block:'nearest',behavior:'smooth'});}
  };
  frame.append(header,body);const host=document.querySelector('main.main')||document.body;host.append(frame);
  controller=window.FirstMateWindows.attach({element:frame,header,title:header.querySelector('strong'),body,host,contentTarget:document.getElementById('mainPanels'),name:'development',label:'Development tools',width:420,height:610,minWidth:340,minHeight:450,mode:'floating',onClose:()=>{controller.setVisible(false);slot.classList.remove('fm-dev-open');button.setAttribute('aria-expanded','false');button.focus();}});
  frame.addEventListener('keydown',event=>{if(event.key==='Escape'){controller.setVisible(false);slot.classList.remove('fm-dev-open');button.setAttribute('aria-expanded','false');button.focus();}});
  body.querySelector('select').focus();
 }
 button.onclick=open;slot.querySelector('[data-dev-launch]').onclick=open;
 const more=document.getElementById('mobilePlatformMoreMenu');
 if(more){const mobile=document.createElement('button');mobile.type='button';mobile.className='ptb-more-item';mobile.dataset.devMobile='';mobile.innerHTML='<i class="fas fa-code" aria-hidden="true"></i><span>Development tools</span>';more.prepend(mobile);mobile.onclick=()=>{document.getElementById('mobilePlatformMoreBtn')?.click();open();};}

}
