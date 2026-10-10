/* Summary and field adapters use domain publications and existing editors. */
(function(global){
 'use strict';const W=global.FirstMateWidgets,base=new URL('./',document.currentScript.src),loads=new Map();
 if(!document.getElementById('fm-typed-widget-styles')){const style=document.createElement('style');style.id='fm-typed-widget-styles';style.textContent='.fm-typed-widget{box-sizing:border-box;min-width:0}.fm-typed-widget input:not([type=checkbox]):not([type=radio]),.fm-typed-widget textarea,.fm-typed-widget select{box-sizing:border-box;max-width:100%;width:100%;padding:9px 11px;border:1px solid var(--border,#d0d5dd);border-radius:7px;background:var(--card,#fff);color:inherit;font:inherit}.fm-typed-widget textarea{min-height:90px}.fm-typed-widget button{border:1px solid var(--border,#d0d5dd);border-radius:7px;padding:9px 12px;background:var(--card,#fff);color:inherit;font:inherit;cursor:pointer}.fm-typed-widget button:hover{background:var(--hover,#f2f4f7)}.fm-typed-widget button:disabled{opacity:.5;cursor:default}.fm-typed-widget input:focus-visible,.fm-typed-widget button:focus-visible,.fm-typed-widget textarea:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}';document.head.append(style);}
 if(!document.getElementById('fm-project-summary-styles')){const style=document.createElement('style');style.id='fm-project-summary-styles';style.textContent=`
  .fm-project-summary.fm-typed-widget{display:grid;gap:14px;padding:16px;background:var(--card,#fff);border:1px solid var(--border,#e4e7ec);border-radius:14px;box-shadow:0 12px 32px #10182812;color:var(--text,#182230);font:13px/1.4 system-ui}
  .fm-project-summary-head{min-width:0}.fm-project-summary-head.has-cover{display:grid;grid-template-columns:128px minmax(0,1fr);gap:14px;align-items:start}
  .fm-project-summary-cover{width:128px;height:118px;border-radius:10px;overflow:hidden}
  .fm-project-summary-cover img{width:100%;height:100%;object-fit:cover;display:block}
  .fm-project-summary-identity{min-width:0}.fm-project-summary-name{display:block;font-size:16px;line-height:1.25;color:#101828;overflow-wrap:anywhere}.fm-project-summary-address{display:block;margin-top:7px;color:#667085;line-height:1.4;overflow-wrap:anywhere}
  .fm-project-summary-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px}.fm-project-summary-meta[hidden]{display:none}.fm-project-summary-meta>div{min-width:0;padding:9px;background:#f7f9fc;border:1px solid #edf0f4;border-radius:9px}.fm-project-summary-meta small,.fm-project-summary-contact small{display:block;color:#667085;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.fm-project-summary-meta strong{display:block;margin-top:4px;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
  .fm-project-summary-contact{padding:12px;border:1px solid #e4e7ec;border-radius:10px;background:#fff}.fm-project-summary-contact-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fm-project-summary-contact-identity{min-width:0}.fm-project-summary-contact strong{display:block;font-size:14px;overflow-wrap:anywhere}.fm-project-summary-contact small+strong{margin-top:4px}.fm-project-summary-contact-detail{display:block;margin-top:3px;color:#667085;font-size:12px;overflow-wrap:anywhere}.fm-project-summary-actions{display:flex;gap:6px;flex:none}.fm-project-summary.fm-typed-widget .fm-project-summary-actions a{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #d0d5dd;border-radius:7px;color:#344054;text-decoration:none}.fm-project-summary-actions svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.fm-project-summary-actions a:hover{background:#f2f4f7}.fm-project-summary-actions a:focus-visible{outline:2px solid var(--primary,#175cd3);outline-offset:2px}
  .fm-project-summary-footer{display:flex;justify-content:flex-end;border-top:1px solid #eaecf0;padding-top:12px}.fm-project-summary.fm-typed-widget .fm-project-summary-open{background:var(--primary,#175cd3);color:#fff;border-color:var(--primary,#175cd3);font-weight:700}.fm-project-summary.fm-typed-widget .fm-project-summary-open:hover{filter:brightness(.92);background:var(--primary,#175cd3)}
  @media(max-width:390px){.fm-project-summary-head.has-cover{grid-template-columns:96px minmax(0,1fr)}.fm-project-summary-cover{width:96px;height:96px}}
 `;document.head.append(style);}
 function load(path){if(!loads.has(path))loads.set(path,new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=new URL(path,base);s.onload=resolve;s.onerror=()=>{loads.delete(path);reject(Error('Control is unavailable'));};document.head.append(s);}));return loads.get(path);}
 const element=(tag,text)=>{const el=document.createElement(tag);if(text!=null)el.textContent=String(text);return el;};
 function shell(root,title){const card=element('section');card.className='fm-typed-widget';card.style.cssText='background:var(--card,#fff);border:1px solid var(--border,#e4e7ec);border-radius:12px;padding:14px;color:var(--text,#344054);font:13px system-ui;display:grid;gap:12px';card.append(element('strong',title));root.replaceChildren(card);return card;}
 const userStyles=document.createElement('style');userStyles.textContent=`
 .fm-user-summary{gap:10px!important;padding:14px!important;line-height:1.4}
 .fm-user-summary-head{display:grid;grid-template-columns:80px minmax(0,1fr);gap:12px;align-items:center;min-width:0}
 .fm-user-summary-photo{width:80px;height:80px;border-radius:12px;object-fit:cover;background:#e9eef4;display:grid;place-items:center;color:#475467;font-size:26px;font-weight:700}
 .fm-user-summary-identity{display:grid;gap:5px;align-content:center;min-width:0}
 .fm-user-summary-heading{display:flex;align-items:center;gap:8px;min-width:0}
 .fm-user-summary-name{min-width:0;font-size:17px;line-height:1.25;color:var(--text,#182230);overflow-wrap:anywhere}
 .fm-user-summary-subtitle{color:#667085;overflow-wrap:anywhere}
 .fm-user-summary-presence{display:inline-flex;align-items:center;gap:6px;flex:none;padding:3px 7px;border-radius:999px;background:#f2f4f7;color:#667085;font-size:11px;font-weight:600}
 .fm-user-summary-presence[data-status="active"]{background:#ecfdf3;color:#067647}
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
  const head=element('div');head.className='fm-user-summary-head';card.append(head);
  if(photo){try{const url=new URL(photo,location.href);if(['http:','https:'].includes(url.protocol)){const image=element('img');image.className='fm-user-summary-photo';image.src=url.href;image.alt=`${name} profile photo`;head.append(image);}}catch{}}
  if(!head.firstChild){const fallback=element('div',name.split(/\s+/).slice(0,2).map(part=>part[0]||'').join('').toUpperCase()||'?');fallback.className='fm-user-summary-photo';fallback.setAttribute('aria-label',`${name} profile photo`);head.append(fallback);}
  const identity=element('div');identity.className='fm-user-summary-identity';const headingRow=element('div');headingRow.className='fm-user-summary-heading';const heading=element('strong',name);heading.className='fm-user-summary-name';headingRow.append(heading);
  const presence=element('div');presence.className='fm-user-summary-presence';const dot=element('span');dot.className='fm-user-summary-dot';dot.setAttribute('role','img');const status=element('span','Away');presence.append(dot,status);headingRow.append(presence);identity.append(headingRow);
  const subtitle=[data.title,data.department].map(value=>String(value||'').trim()).filter(Boolean).join(', ');if(subtitle){const line=element('div',subtitle);line.className='fm-user-summary-subtitle';identity.append(line);}head.append(identity);
  const updatePresence=users=>{const person=users.find(user=>user.user_id===data.id),active=person?.status==='active',label=active?'Active':awayLabel(person?.last_active_at);presence.dataset.status=active?'active':'away';dot.dataset.status=active?'active':'away';dot.title=label;dot.setAttribute('aria-label',label);status.textContent=active?'Active':'Away';};
  updatePresence([]);const orgId=(reference.target||context.target)?.organizationId;const stop=orgId&&global.PlatformRealtime?.watchPresence?.(orgId,'online',updatePresence);
  const details=element('dl');details.className='fm-user-summary-details';const rows=[['Email',data.email,'mailto:'],['Phone',data.phone,'tel:'],...(Array.isArray(data.phone_fields)?data.phone_fields:[]).map(field=>[field.label,field.number,'tel:']),['Location',data.location],['Time zone',data.time_zone],['Pronouns',data.pronouns],['About',data.bio]];for(const [label,raw,scheme]of rows){const value=String(raw||'').trim();if(!value)continue;const row=element('div'),term=element('dt',String(label||'Phone')),definition=element('dd');if(scheme){const link=element('a',value);link.href=scheme+value;definition.append(link);}else definition.textContent=value;row.append(term,definition);details.append(row);}if(details.childElementCount)card.append(details);
  if(data.id&&String(data.id)!==String(global.__APP?.userId||'')){const button=element('button','Message in Channels'),error=element('div');button.type='button';button.className='fm-user-summary-action';error.className='fm-user-summary-error';error.setAttribute('role','status');button.onclick=async()=>{button.disabled=true;error.textContent='';try{if(!global.ChannelsAPI?.channels?.create||!global.FirstMateChannelsNavigation?.openMessage)throw Error('Channels is unavailable.');const result=await global.ChannelsAPI.channels.create(orgId,{type:'dm',member_user_ids:[data.id]});await global.FirstMateChannelsNavigation.openMessage({channel_id:result.channel.id});}catch(e){error.textContent=e?.message||'Could not open the message.';button.disabled=false;}};card.append(button,error);}
  return {destroy(){stop?.();root.replaceChildren();}};
 });
 async function projectSummary(root,data,reference,context){
  const target=reference.target||context.target||{},projectId=String(target.projectId||data.id||'');
  const card=element('section');card.className='fm-typed-widget fm-project-summary';root.replaceChildren(card);
  const head=element('div');head.className='fm-project-summary-head';card.append(head);
  const mediaId=String(data.cover_media_id||'');if(mediaId&&target.organizationId&&global.PlatformAPI?.media?.fileUrl){const cover=element('div'),img=element('img');cover.className='fm-project-summary-cover';img.alt='';img.onerror=()=>{cover.remove();head.classList.remove('has-cover');};img.src=global.PlatformAPI.media.fileUrl(target.organizationId,mediaId,'thumb_320');cover.append(img);head.append(cover);head.classList.add('has-cover');}
  const identity=element('div');identity.className='fm-project-summary-identity';const name=element('strong',data.title||data.name||'Project');name.className='fm-project-summary-name';identity.append(name);if(data.address){const address=element('span',data.address);address.className='fm-project-summary-address';identity.append(address);}head.append(identity);
  const metadata=element('div');metadata.className='fm-project-summary-meta';metadata.hidden=true;card.append(metadata);
  const contact=element('div');contact.className='fm-project-summary-contact';card.append(contact);
  const contactHead=element('div');contactHead.className='fm-project-summary-contact-head';contact.append(contactHead);
  const contactIdentity=element('div');contactIdentity.className='fm-project-summary-contact-identity';contactHead.append(contactIdentity);
  if(Number(data.project_contact_count)>1)contactIdentity.append(element('small','Primary contact'));
  contactIdentity.append(element('strong',data.primary_contact_visible===false?'Contact details unavailable':data.primary_contact_name||'No contact'));
  if(data.primary_contact_phone){const line=element('span',data.primary_contact_phone);line.className='fm-project-summary-contact-detail';contact.append(line);}
  if(data.primary_contact_email){const line=element('span',data.primary_contact_email);line.className='fm-project-summary-contact-detail';contact.append(line);}
  const actions=element('div');actions.className='fm-project-summary-actions';
  const phone=String(data.primary_contact_phone||'').trim(),dial=phone.replace(/[^+0-9]/g,''),email=String(data.primary_contact_email||'').trim();
  const icons={Call:'M22 16.92v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 3.09 5.18 2 2 0 0 1 5.08 3h3a2 2 0 0 1 2 1.72c.12.96.34 1.91.66 2.83a2 2 0 0 1-.45 2.11L9.1 10.91a16 16 0 0 0 4 4l1.25-1.19a2 2 0 0 1 2.11-.45c.92.32 1.87.54 2.83.66A2 2 0 0 1 22 16.92Z',Text:'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z',Email:'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 2-10 7L2 6'};
  const action=(label,href)=>{const link=element('a');link.href=href;link.title=label;link.setAttribute('aria-label',`${label} ${data.primary_contact_name||'contact'}`);const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',icons[label]);icon.append(path);link.append(icon);actions.append(link);};
  if(/^[+0-9() .-]{3,32}$/.test(phone)&&dial.length>=3){action('Call','tel:'+dial);action('Text','sms:'+dial);}
  if(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))action('Email','mailto:'+encodeURIComponent(email));
  if(actions.childElementCount)contactHead.append(actions);
  const footer=element('div');footer.className='fm-project-summary-footer';const open=element('button','Open project');open.type='button';open.className='fm-project-summary-open';open.disabled=!projectId;open.onclick=()=>{const project={id:projectId,title:data.title||data.name||'',address:data.address||''};if(global.Portal?.modules?.request?.openProject)global.Portal.modules.request.openProject(project,{tab:'map'});else global.FirstMateProjectWindows?.open?.(project,{tab:'map'});};footer.append(open);card.append(footer);
  if(projectId&&target.organizationId){try{
   if(!global.FirstMatePriorityFields)await load('../priority-fields/priority-fields.js');
   const fields=global.FirstMatePriorityFields,items=await fields.resolve(target.organizationId,projectId);
   for(const item of items){if(item.result?.status!=='ready'||item.result.value==null||item.result.value==='')continue;const value=fields.format(item);if(!value)continue;const cell=element('div');cell.append(element('small',item.label),element('strong',value));metadata.append(cell);}metadata.hidden=!metadata.childElementCount;
  }catch{metadata.hidden=true;}}
  return {destroy(){root.replaceChildren();}};
 }
 for(const kind of ['project','contact','document'])W.attachRenderer(kind+'.summary','1',(root,{data,config,reference,context})=>{
  if(kind==='project')return projectSummary(root,data,reference||{},context||{});
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
  if(!global.FirstMatePickerWidgets)await load('pickers.js?v=20261010');const card=shell(root,config.prompt||'Choose an emoji'),body=element('div');card.append(body);const picker=global.FirstMatePickerWidgets.mountEmojiPicker(body,emoji=>notifySelection({value:emoji},{confirmed:true,label:emoji}));return {destroy(){picker.destroy();root.replaceChildren();}};
 });
 W.attachRenderer('gif.picker','1',async(root,{config,reference,context,notifySelection})=>{
  if(!global.FirstMatePickerWidgets)await load('pickers.js?v=20261010');const card=shell(root,config.prompt||'Choose a GIF');const picker=global.FirstMatePickerWidgets.createGifPickerButton({orgId:(reference.target||context.target).organizationId,onSend:item=>{const url=item.url||item.src;if(url&&url.length<=512)notifySelection({value:url},{confirmed:true,label:'GIF'});}});card.append(picker);return {destroy(){picker.destroy();root.replaceChildren();}};
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
  const projectPreview=target.dataset.fmSummaryType==='summary.project',width=projectPreview?420:340;
  hover=element('div');hover.setAttribute('role',projectPreview?'group':'tooltip');if(projectPreview)hover.setAttribute('aria-label','Project preview');hover.style.cssText=`position:fixed;z-index:100000;width:min(${width}px,calc(100vw - 24px));max-height:75vh;overflow:auto;box-shadow:0 12px 40px #0002;border-radius:14px`;document.body.append(hover);const rect=target.getBoundingClientRect();hover.style.left=Math.max(12,Math.min(rect.left,innerWidth-hover.offsetWidth-12))+'px';hover.style.top=Math.max(12,Math.min(rect.bottom+6,innerHeight-Math.min(projectPreview?420:280,innerHeight*.75)-12))+'px';handle=W.mount(hover,{...result.widget,target:ref},{surface:'hover'});
 }catch{/* A hover cannot grant access or interrupt the feed. */}}
 document.addEventListener('pointerover',event=>{if(hover?.contains(event.target)){clearTimeout(closeTimer);return;}const target=event.target.closest?.('[data-fm-summary-type]');if(target){clearTimeout(closeTimer);show(target);}});
 document.addEventListener('focusin',event=>{const target=event.target.closest?.('[data-fm-summary-type]');if(target)show(target);});
 document.addEventListener('pointerout',event=>{if(owner&&!owner.contains(event.relatedTarget)&&!hover?.contains(event.relatedTarget)&&(owner.contains(event.target)||hover?.contains(event.target)))scheduleClose();});
 document.addEventListener('focusout',event=>{if((owner?.contains(event.target)||hover?.contains(event.target))&&!owner?.contains(event.relatedTarget)&&!hover?.contains(event.relatedTarget))close();});
 document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});global.addEventListener('scroll',event=>{if(!hover?.contains(event.target))close();},true);
})(window);
