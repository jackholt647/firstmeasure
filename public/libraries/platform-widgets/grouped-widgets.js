/* Summary and field adapters use domain publications and existing editors. */
(function(global){
 'use strict';const W=global.FirstMateWidgets,base=new URL('./',document.currentScript.src),loads=new Map();
 if(!document.getElementById('fm-typed-widget-styles')){const style=document.createElement('style');style.id='fm-typed-widget-styles';style.textContent='.fm-typed-widget{box-sizing:border-box;min-width:0}.fm-typed-widget input:not([type=checkbox]):not([type=radio]),.fm-typed-widget textarea,.fm-typed-widget select{box-sizing:border-box;max-width:100%;width:100%;padding:9px 11px;border:1px solid var(--border,#d0d5dd);border-radius:7px;background:var(--card,#fff);color:inherit;font:inherit}.fm-typed-widget textarea{min-height:90px}.fm-typed-widget button{border:1px solid var(--border,#d0d5dd);border-radius:7px;padding:9px 12px;background:var(--card,#fff);color:inherit;font:inherit;cursor:pointer}.fm-typed-widget button:hover{background:var(--hover,#f2f4f7)}.fm-typed-widget button:disabled{opacity:.5;cursor:default}.fm-typed-widget input:focus-visible,.fm-typed-widget button:focus-visible,.fm-typed-widget textarea:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}';document.head.append(style);}
 function load(path){if(!loads.has(path))loads.set(path,new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=new URL(path,base);s.onload=resolve;s.onerror=()=>{loads.delete(path);reject(Error('Control is unavailable'));};document.head.append(s);}));return loads.get(path);}
 const element=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=String(text);return el;};
 function shell(root,title){const card=element('section');card.className='fm-typed-widget';card.style.cssText='background:var(--card,#fff);border:1px solid var(--border,#e4e7ec);border-radius:12px;padding:14px;color:var(--text,#344054);font:13px system-ui;display:grid;gap:12px';card.append(element('strong',title));root.replaceChildren(card);return card;}
 const userStyles=document.createElement('style');userStyles.textContent=`
 .fm-user-summary{gap:12px!important;padding:18px!important;line-height:1.45}
 .fm-user-summary-photo{width:88px;height:88px;border-radius:14px;object-fit:cover;background:#e9eef4;display:grid;place-items:center;color:#475467;font-size:28px;font-weight:700}
 .fm-user-summary-name{font-size:18px;line-height:1.25;color:var(--text,#182230)}
 .fm-user-summary-presence{display:flex;align-items:center;gap:7px;color:#667085;font-size:12px}
 .fm-user-summary-dot{width:9px;height:9px;border-radius:50%;background:#98a2b3;flex:none}
 .fm-user-summary-dot[data-status="active"]{background:#16a34a}
 .fm-user-summary-details{display:grid;gap:9px;margin:0;padding-top:12px;border-top:1px solid #eaecf0}
 .fm-user-summary-details>div{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;overflow-wrap:anywhere}
 .fm-user-summary-details dt{color:#667085}.fm-user-summary-details dd{margin:0}.fm-user-summary-details a{color:#175cd3}
 .fm-user-summary-action{width:100%;background:var(--primary,#175cd3)!important;color:#fff!important;border-color:var(--primary,#175cd3)!important}
 .fm-user-summary-error{color:#b42318;font-size:12px}
 `;document.head.append(userStyles);
 function awayLabel(lastActive){const elapsed=Date.now()-Number(lastActive);if(!Number.isFinite(elapsed)||elapsed<0)return 'Away';const minutes=Math.max(1,Math.floor(elapsed/60000));if(minutes<60)return `Away for ${minutes} minute${minutes===1?'':'s'}`;const hours=Math.floor(minutes/60);if(hours<24)return `Away for ${hours} hour${hours===1?'':'s'}`;const days=Math.floor(hours/24);return `Away for ${days} day${days===1?'':'s'}`;}
 W.attachRenderer('user.summary','1',(root,{data,reference,context})=>{
  const card=shell(root,null);card.classList.add('fm-user-summary');card.replaceChildren();
  const name=String(data.name||'Team member'),photo=String(data.profile_photo||'');
  if(photo){try{const url=new URL(photo,location.href);if(['http:','https:'].includes(url.protocol)){const image=element('img');image.className='fm-user-summary-photo';image.src=url.href;image.alt=`${name} profile photo`;card.append(image);}}catch{}}
  if(!card.firstChild){const fallback=element('div',name.split(/\s+/).slice(0,2).map(part=>part[0]||'').join('').toUpperCase()||'?');fallback.className='fm-user-summary-photo';fallback.setAttribute('aria-label',`${name} profile photo`);card.append(fallback);}
  const heading=element('strong',name);heading.className='fm-user-summary-name';card.append(heading);
  const presence=element('div');presence.className='fm-user-summary-presence';const dot=element('span');dot.className='fm-user-summary-dot';dot.setAttribute('role','img');const status=element('span','Away');presence.append(dot,status);card.append(presence);
  const updatePresence=users=>{const person=users.find(user=>user.user_id===data.id),active=person?.status==='active',label=active?'Active':awayLabel(person?.last_active_at);dot.dataset.status=active?'active':'away';dot.title=label;dot.setAttribute('aria-label',label);status.textContent=active?'Active':'Away';};
  updatePresence([]);const orgId=(reference.target||context.target)?.organizationId;const stop=orgId&&global.PlatformRealtime?.watchPresence?.(orgId,'online',updatePresence);
  const details=element('dl');details.className='fm-user-summary-details';for(const [label,key,scheme]of [['Email','email','mailto:'],['Phone','phone','tel:'],['Department','department'],['Title','title'],['Location','location'],['Time zone','time_zone'],['Pronouns','pronouns'],['About','bio']]){const value=String(data[key]||'').trim();if(!value)continue;const row=element('div'),term=element('dt',label),definition=element('dd');if(scheme){const link=element('a',value);link.href=scheme+value;definition.append(link);}else definition.textContent=value;row.append(term,definition);details.append(row);}if(details.childElementCount)card.append(details);
  if(data.id&&String(data.id)!==String(global.__APP?.userId||'')){const button=element('button','Message in Channels'),error=element('div');button.type='button';button.className='fm-user-summary-action';error.className='fm-user-summary-error';error.setAttribute('role','status');button.onclick=async()=>{button.disabled=true;error.textContent='';try{if(!global.ChannelsAPI?.channels?.create||!global.FirstMateChannelsNavigation?.openMessage)throw Error('Channels is unavailable.');const result=await global.ChannelsAPI.channels.create(orgId,{type:'dm',member_user_ids:[data.id]});await global.FirstMateChannelsNavigation.openMessage({channel_id:result.channel.id});}catch(e){error.textContent=e?.message||'Could not open the message.';button.disabled=false;}};card.append(button,error);}
  return {destroy(){stop?.();root.replaceChildren();}};
 });
 for(const kind of ['project','contact','document'])W.attachRenderer(kind+'.summary','1',(root,{data,config})=>{
  if(kind==='document'&&config.documentType&&String(data.document_type||data.type)!==config.documentType)throw Error('This document does not match the requested type.');
  const card=shell(root,data.title||data.name||[data.first_name,data.last_name].filter(Boolean).join(' ')||kind);
  for(const [key,value]of Object.entries(data||{})){if(['id','title','name','first_name','last_name'].includes(key)||value==null||value==='')continue;const line=element('div');line.append(element('span',key.replace(/_/g,' ')+': '),element('span',value));card.append(line);}
  return {destroy(){root.replaceChildren();}};
 });
 W.attachRenderer('document.picker','1',(root,{data,config,reference,context,notifySelection})=>{
  const card=shell(root,config.prompt||'Choose a document'),search=element('input'),list=element('div');search.type='search';search.placeholder='Search documents';search.setAttribute('aria-label','Search documents');card.append(search,list);
  function paint(){list.replaceChildren();const items=(data?.items||[]).filter(item=>(!config.documentType||String(item.document_type||item.type)===config.documentType)&&String(item.title||item.name||item.id).toLowerCase().includes(search.value.toLowerCase()));for(const item of items){const button=element('button',item.title||item.name||item.id);button.type='button';button.style.cssText='display:block;width:100%;padding:10px;text-align:left;margin:4px 0';button.onclick=()=>notifySelection({document_id:item.id,project_id:(reference.target||context.target).projectId},{confirmed:true,label:item.title||item.name});list.append(button);}if(!items.length)list.append(element('p','No matching documents.'));}search.oninput=paint;paint();return {destroy(){root.replaceChildren();}};
 });
 const fieldRenderer=async(root,{config,reference,context,notifySelection})=>{
  if(config.fieldType==='timezone'){
   const section=shell(root,config.prompt||'Choose a time zone'),input=element('input'),list=element('datalist'),error=element('span'),confirm=element('button','Use this value');list.id='widget-timezones-'+Math.random().toString(36).slice(2);input.setAttribute('list',list.id);input.setAttribute('aria-label','Time zone');input.value=config.value||'';confirm.type='button';for(const zone of Intl.supportedValuesOf?.('timeZone')||['UTC']){const option=element('option');option.value=zone;list.append(option);}function read(){if(!input.value||input.value.length>100||/^[+-]/.test(input.value))throw Error('Choose an IANA time zone.');new Intl.DateTimeFormat('en',{timeZone:input.value});return {value:input.value};}input.oninput=()=>{try{notifySelection(read());confirm.disabled=false;error.textContent='';}catch{notifySelection(null);confirm.disabled=true;error.textContent='Choose an IANA time zone.';}};confirm.onclick=()=>{try{notifySelection(read(),{confirmed:true});}catch{error.textContent='Choose an IANA time zone.';}};section.append(input,list,confirm,error);return {destroy(){root.replaceChildren();}};
  }
  if(!global.FirstMateCustomFields)await load('../custom-fields/firstmate-custom-fields.js');
  const F=global.FirstMateCustomFields,type=config.fieldType||config.field?.type||'text',field=F.normalizeDefinition({...config.field,type,entity:'project',path:'value',key:'value',label:config.prompt||config.field?.label||'Choose a value',enabled:true,required:true}),card=shell(root,field.label),body=element('div'),confirm=element('button','Use this value'),error=element('span');confirm.type='button';card.append(body,error,confirm);
  const target=reference.target||context.target,entity={id:target.projectId,custom_field_values:{value:config.value}};
  body.innerHTML=F.inputHtml(field,config.value,{orgId:target.organizationId,branchId:config.branchId||target.branchId});F.wireStructured(body);
  // Reference controls need the editor's ordinary authorized option hydration.
  if(field.data_type==='reference')await F.renderEditor(body,entity,'project',{orgId:target.organizationId,branchId:config.branchId||target.branchId,definitions:[field],flat:true,location:'all',showSave:false});
  const read=()=>{const validation=F.validateEditor(body,entity,'project',[field]);if(!validation.valid)throw Error(validation.errors?.[0]?.message||'Check the value.');return validation.values.value;};
  const report=()=>{try{const value=read();error.textContent='';confirm.disabled=false;notifySelection({value});}catch(e){confirm.disabled=true;error.textContent=e.message;notifySelection(null);}};
  body.addEventListener('input',report);body.addEventListener('change',report);confirm.onclick=()=>{try{notifySelection({value:read()},{confirmed:true});}catch(e){error.textContent=e.message;}};report();return {destroy(){body.removeEventListener('input',report);body.removeEventListener('change',report);root.replaceChildren();}};
 };for(const id of ['field.input','field.input.contact','field.input.assignment'])W.attachRenderer(id,'1',fieldRenderer);
 W.attachRenderer('emoji.picker','1',async(root,{config,notifySelection})=>{
  if(!global.FirstMateChannels)await load('../channels-ui/channels-ui.js');const card=shell(root,config.prompt||'Choose an emoji'),body=element('div');card.append(body);const picker=global.FirstMateChannels.mountEmojiPicker(body,emoji=>notifySelection({value:emoji},{confirmed:true,label:emoji}));return {destroy(){picker.destroy();root.replaceChildren();}};
 });
 W.attachRenderer('gif.picker','1',async(root,{config,reference,context,notifySelection})=>{
  if(!global.FirstMateChannels)await load('../channels-ui/channels-ui.js');const card=shell(root,config.prompt||'Choose a GIF');card.append(global.FirstMateChannels.createGifPickerButton({orgId:(reference.target||context.target).organizationId,onSend:item=>{const url=item.url||item.src;if(url&&url.length<=512)notifySelection({value:url},{confirmed:true,label:'GIF'});}}));return {destroy(){root.replaceChildren();}};
 });
 // Any object producer can opt in with type + target attributes. Hosts do not switch on object kind.
 let hover,owner,handle,generation=0,closeTimer;
 function close(){clearTimeout(closeTimer);generation++;handle?.destroy();handle=null;hover?.remove();hover=null;owner=null;}
 function scheduleClose(){clearTimeout(closeTimer);closeTimer=setTimeout(close,250);}
 async function show(target){if(owner===target)return;close();owner=target;const current=++generation;try{
  const organizationId=global.__APP?.userOrgId;if(!organizationId)return;
  const ref=target.dataset.fmSummaryTarget?JSON.parse(target.dataset.fmSummaryTarget):{scope:'project',organizationId,projectId:target.dataset.fmSummaryProject};
  const result=await global.PlatformAPI.publication.resolveWidget(organizationId,{type:target.dataset.fmSummaryType,surface:'hover',target:ref});
  if(current!==generation||result.status!=='ready')return;
  hover=element('div');hover.setAttribute('role','tooltip');hover.style.cssText='position:fixed;z-index:100000;width:min(340px,calc(100vw - 24px));max-height:70vh;overflow:auto;box-shadow:0 12px 40px #0002;border-radius:12px';document.body.append(hover);const rect=target.getBoundingClientRect();hover.style.left=Math.max(12,Math.min(rect.left,innerWidth-hover.offsetWidth-12))+'px';hover.style.top=Math.min(rect.bottom+6,innerHeight-160)+'px';handle=W.mount(hover,{...result.widget,target:ref},{surface:'hover'});
 }catch{/* A hover cannot grant access or interrupt the feed. */}}
 document.addEventListener('pointerover',event=>{if(hover?.contains(event.target)){clearTimeout(closeTimer);return;}const target=event.target.closest?.('[data-fm-summary-type]');if(target){clearTimeout(closeTimer);show(target);}});
 document.addEventListener('focusin',event=>{const target=event.target.closest?.('[data-fm-summary-type]');if(target)show(target);});
 document.addEventListener('pointerout',event=>{if(owner&&!owner.contains(event.relatedTarget)&&!hover?.contains(event.relatedTarget)&&(owner.contains(event.target)||hover?.contains(event.target)))scheduleClose();});
 document.addEventListener('focusout',event=>{if(owner?.contains(event.target)&&!owner.contains(event.relatedTarget)&&!hover?.contains(event.relatedTarget))close();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});global.addEventListener('scroll',event=>{if(!hover?.contains(event.target))close();},true);
})(window);
