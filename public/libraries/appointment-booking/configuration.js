/* Shared appointment configuration editor. Catalog administration lives in Settings. */
(function(){
  if(window.FirstMateAppointmentConfiguration)return;
  const source=document.currentScript?.src||new URL('/libraries/appointment-booking/configuration.js',location.href).href;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const empty=()=>({title:'Appointment',department_ids:[],delivery:false,timing_mode:'timed',duration_days:2,location:{mode:'project',address:''},duration_minutes:60,window_minutes:60,slot_minutes:30,requirements:[],recurrence:null});
  /* A help mark is a button with its own bubble, never inside a label: a tap there would flip the switch instead (FM-558). */
  const tip=text=>`<span class="fm-ap-help-wrap"><button type="button" class="fm-ap-help" data-help aria-expanded="false" aria-label="${esc(text)}">?</button><span class="fm-ap-help-bubble" role="tooltip">${esc(text)}</span></span>`;
  const options=(rows,value)=>rows.map(([id,label])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('');
  function ensureStyle(){if(document.getElementById('fm-appointment-style'))return;const link=document.createElement('link');link.id='fm-appointment-style';link.rel='stylesheet';const url=new URL('booking.css',source);url.searchParams.set('v',new URL(source).searchParams.get('v')||'20261005-appointment-picker-v1');link.href=url.href;document.head.append(link);}
  function readLocal(key){try{return JSON.parse(localStorage.getItem(key)||'[]');}catch{return [];}}
  function writeLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
  const durationText=c=>c.timing_mode==='days'?`${c.duration_days||1} day${(c.duration_days||1)===1?'':'s'}`:(m=>m%60?`${m} min`:`${m/60} hour${m===60?'':'s'}`)(Number(c.duration_minutes)||60);
  /* slots:{type,quick,advanced} renders the phone steps: a type list, the duration row and the Advanced sheet.
     typeMode renders the New appointment type editor: a type name and the type's settings, saved with saveType() (FM-558).
     A type says whether it needs a project (FM-557); the catalog gives every type the value the server enforces. */
  async function mount(host,{orgId,onChange,onPreset,onNewType,initialValue,settingsMode=false,typeMode=false,projectControl,projectId,slots}={}){
    ensureStyle();
    let response=await window.PlatformAPI.appointments.catalog(orgId),catalog=response.catalog;
    const steps=!!slots&&!settingsMode&&!typeMode,hosts=steps?[slots.type,slots.quick,slots.advanced]:[host];
    const all=s=>hosts.flatMap(h=>[...h.querySelectorAll(s)]);
    const departmentChoices=catalog.departments.filter(d=>d.status!=='archived'&&(!response.department_context||response.department_context.department_ids.includes(d.id)));
    const showDepartments=departmentChoices.length>1&&(settingsMode||response.department_context?.show_selector!==false);
    let config={...empty(),...structuredClone(initialValue||{})},chosen=!slots||!!initialValue?.preset_id,disposed=false,advanced=settingsMode,moreOpen=false,typeName='',projectAddress='',projectSequence=0,projectTitle='',titleEdited=!!initialValue?.title,defaultTitle=config.title;
    const user=window.Portal?.cfg?.userId||window.__APP?.userId||'session';
    const recentKey=`fm:appointment-presets:${orgId}:${user}`,addressKey=`fm:appointment-addresses:${orgId}:${user}`;
    const resources=response.resources.filter(r=>['organization_user','resource_group'].includes(r.subject_type));
    const $=s=>all(s)[0]||null;
    const markCustom=()=>{delete config.preset_id;chosen=true;all('[data-preset-button]').forEach(b=>b.setAttribute('aria-pressed',String(!b.dataset.presetButton)));};
    const notify=()=>onChange?.(structuredClone(config));
    const number=(label,attr,value,min,max)=>`<label class="fm-ap-field"><span>${label}</span><input type="number" ${attr} value="${value}" min="${min}" max="${max}"></label>`;
    const toggle=(label,attr,checked,help)=>`<span class="fm-ap-switch"><label class="fm-ap-toggle"><input type="checkbox" role="switch" ${attr} ${checked?'checked':''}><span class="fm-ap-track" aria-hidden="true"></span><span>${label}</span></label>${help?tip(help):''}</span>`;
    function peoplePicker(index,quick=false){
      const rule=config.requirements[index],keys=rule.subject_keys||[];
      const names=resources.filter(r=>keys.includes(r.key)).map(r=>r.name);
      return `<details class="fm-ap-picker" data-people-picker="${index}-${quick}"><summary aria-label="Choose people or groups">${esc(names.length?names.length>1?`${names[0]} +${names.length-1}`:names[0]:'Choose people or groups')}<span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><input type="search" data-filter-people placeholder="Search people or groups" aria-label="Search people or groups"><div class="fm-ap-people">${resources.map(r=>`<label data-person-row><input type="checkbox" data-specific="${index}" value="${esc(r.key)}" ${keys.includes(r.key)?'checked':''}><span>${esc(r.name)}${r.subject_type==='resource_group'?'<small>Group</small>':''}</span></label>`).join('')}</div></div></details>`;
    }
    function typeMeta(c){c={...empty(),...c};return [durationText(c),...(c.department_ids||[]).map(id=>catalog.departments.find(d=>d.id===id)?.label).filter(Boolean)].join(' · ');}
    function typeCard(p){const dept=catalog.departments.find(d=>p.configuration?.department_ids?.includes(d.id)),color=/^#[0-9a-f]{3,8}$/i.test(dept?.color||'')?dept.color:'#d93025';return `<button type="button" class="fm-ap-type" data-preset-button="${esc(p.id)}" aria-pressed="${p.id===config.preset_id}" style="--fm-ap-type-color:${color}"><span class="fm-ap-type-mark" aria-hidden="true">${esc(p.label.trim().slice(0,1).toUpperCase())}</span><span class="fm-ap-type-text"><b>${esc(p.label)}</b><small>${esc(typeMeta(p.configuration))}</small></span><span class="fm-ap-type-go" aria-hidden="true"></span></button>`;}
    function locationValue(){return config.location?.mode==='company_office'?response.company_office?.address||'':config.location?.mode==='project'?projectAddress:config.location?.mode==='custom'?config.location.address:'';}
    function locationRows(){
      const rows=[{label:'Project address',mode:'project',address:projectAddress},{label:'Company office',mode:'company_office',address:response.company_office?.address||''},{label:'No location',mode:'none',address:''}];
      const addresses=[...readLocal(addressKey),...catalog.presets.filter(p=>p.configuration.location?.mode==='custom').map(p=>p.configuration.location.address)].filter(Boolean);
      for(const address of [...new Set(addresses)].slice(0,10))rows.push({label:address,mode:'custom',address});
      return rows;
    }
    function render(){
      if(disposed)return;
      if(projectControl)projectControl.remove();
      const ordered=[...new Set([...readLocal(recentKey),...catalog.presets.map(p=>p.id)])].map(id=>catalog.presets.find(p=>p.id===id)).filter(Boolean);
      const shownTypes=ordered.length>6?ordered.slice(0,4):ordered;
      if(config.preset_id&&!shownTypes.some(p=>p.id===config.preset_id)){const selected=ordered.find(p=>p.id===config.preset_id);if(selected)shownTypes[shownTypes.length-1]=selected;}
      const recent=ordered.slice(0,4);
      if(config.preset_id&&!recent.some(p=>p.id===config.preset_id)){const selected=catalog.presets.find(p=>p.id===config.preset_id);if(selected)recent[recent.length?recent.length-1:0]=selected;}
      const locations=locationRows(),windowOn=config.timing_mode!=='days'&&config.window_minutes>config.duration_minutes;
      const presetsHtml=`<div class="fm-ap-presets" aria-label="Appointment presets">${recent.map(p=>`<button type="button" data-preset-button="${esc(p.id)}" aria-pressed="${p.id===config.preset_id}" title="${esc(p.label)}">${esc(p.label.replace(/ appointments$/i,'').replace(/ appointment$/i,'').replace(/^Company sales meeting$/,'Sales meeting'))}</button>`).join('')}<button type="button" data-preset-button="" aria-pressed="${!config.preset_id}">Custom</button><details class="fm-ap-picker fm-ap-more"><summary>More<span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><input type="search" data-filter-presets placeholder="Search presets" aria-label="Search appointment presets"><div class="fm-ap-menu">${catalog.presets.map(p=>`<button type="button" data-preset-button="${esc(p.id)}">${esc(p.label)}</button>`).join('')}</div></div></details></div>`;
      const nameHtml=`<details class="fm-ap-picker fm-ap-name"><summary title="Rename appointment"><span class="fm-ap-icon" aria-hidden="true">✎</span><span data-title-label>${esc(config.title)}</span><span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><label class="fm-ap-field">Appointment name<input data-title value="${esc(config.title)}" maxlength="200" required></label></div></details>`;
      const locationHtml=`<div class="fm-ap-location"><span class="fm-ap-icon" aria-hidden="true">⌖</span><input data-address aria-label="Appointment location" maxlength="1000" value="${esc(locationValue())}" placeholder="${config.location?.mode==='company_office'?'Company office address':config.location?.mode==='none'?'No location':'Type an address'}" title="${esc(config.location?.mode==='company_office'?'Company office — uses the address in Company Settings. Type to override.':'Type any address, or choose a saved location.')}" autocomplete="street-address"><details class="fm-ap-picker"><summary aria-label="Location presets" title="Location presets"><span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover fm-ap-location-menu">${locations.map((l,i)=>`<button type="button" data-location-preset="${i}"><span>${esc(l.label)}</span>${l.mode!=='custom'&&l.address?`<small>${esc(l.address)}</small>`:''}</button>`).join('')}</div></details></div>`;
      const durationHtml=`<div class="fm-ap-duration" aria-label="Duration">${(config.timing_mode==='days'?[[1,'1 day'],[2,'2 days'],[3,'3 days'],[7,'1 week'],[14,'2 weeks']]:[[15,'15 min'],[30,'30 min'],[60,'1 hour'],[90,'90 min'],[120,'2 hours']]).map(([value,label])=>`<button type="button" data-duration-preset="${value}" title="${config.timing_mode==='days'?`${value} consecutive calendar days`:label}" aria-pressed="${value===(config.timing_mode==='days'?config.duration_days:config.duration_minutes)}">${label}</button>`).join('')}<details class="fm-ap-picker"><summary>${(config.timing_mode==='days'?[1,2,3,7,14]:[15,30,60,90,120]).includes(config.timing_mode==='days'?config.duration_days:config.duration_minutes)?'Custom':config.timing_mode==='days'?`${config.duration_days} days`:`${config.duration_minutes} min`}<span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover">${number(config.timing_mode==='days'?'Calendar days':'Minutes',config.timing_mode==='days'?'data-days':'data-duration',config.timing_mode==='days'?config.duration_days:config.duration_minutes,config.timing_mode==='days'?1:5,config.timing_mode==='days'?31:1440)}</div></details></div>`;
      const badgesHtml=`${config.delivery?'<span class="fm-ap-badge">Delivery</span>':''}${config.recurrence?`<span class="fm-ap-badge">${esc(config.recurrence.frequency)}</span>`:''}${windowOn?`<span class="fm-ap-badge">${config.window_minutes/60}h arrival window</span>`:''}`;
      const peopleHtml=`${config.requirements.map((r,i)=>r.mode==='specific'?peoplePicker(i,true):'').join('')}`;
      const advancedHtml=`
          ${showDepartments?`<div class="fm-ap-departments"><span class="fm-ap-caption">Departments</span><div>${departmentChoices.map(d=>`<label class="fm-ap-chip"><input type="checkbox" data-department value="${esc(d.id)}" ${config.department_ids.includes(d.id)?'checked':''}><span>${esc(d.label)}</span></label>`).join('')}</div></div>`:''}
          <div class="fm-ap-switches">${toggle('Delivery','data-delivery',config.delivery,'Marks a delivery without creating a material order.')}${toggle('Recurring','data-recurring',!!config.recurrence,'Checks all occurrences with the same team. Up to 52 within two years.')}${config.timing_mode==='days'?'':toggle('Arrival window','data-window-toggle',windowOn,'Reserve the duration inside a longer customer arrival window.')}${settingsMode||typeMode?toggle('Needs a project','data-requires-project',config.requires_project===true,'Bookings of this type must name a project: No project and a bare address are not offered.'):''}</div>
          <div class="fm-ap-fields"><label class="fm-ap-field"><span>Schedule by</span><select data-timing>${options([['timed','Time'],['days','Full days']],config.timing_mode)}</select></label>${settingsMode||typeMode?`<label class="fm-ap-field" data-fm-tooltip="What a booking counts as: a sales appointment advances sales scopes and the funnel"><span>Counts as</span><select data-event-type>${options([['','Appointment'],['sales_appointment','Sales appointment'],['sales_follow_up','Sales follow-up'],['project_work','Project work'],...(config.event_type_id&&!['sales_appointment','sales_follow_up','project_work'].includes(config.event_type_id)?[[config.event_type_id,config.event_type_id]]:[])],config.event_type_id||'')}</select></label>`:''}${config.timing_mode==='days'?'':`${windowOn?number('Arrival window · min','data-window',config.window_minutes,config.duration_minutes,1440):''}${number('Start interval · min','data-step',config.slot_minutes,5,240)}`}</div>
          ${config.recurrence?`<div class="fm-ap-fields"><label class="fm-ap-field"><span>Repeat</span><select data-frequency>${options([['daily','Daily'],['weekly','Weekly'],['monthly','Monthly'],['quarterly','Quarterly'],['yearly','Yearly']],config.recurrence.frequency)}</select></label>${number('Every','data-interval',config.recurrence.interval,1,52)}${number('Occurrences','data-count',config.recurrence.occurrence_count,2,52)}</div>`:''}
          <div class="fm-ap-staff-heading"><span class="fm-ap-caption">Staffing ${tip('All rules must be satisfied before a time is available.')}</span><button type="button" class="fm-ap-text-button" data-add-rule>+ Add rule</button></div>
          <div class="fm-ap-rules">${config.requirements.map((r,i)=>`<div class="fm-ap-rule" data-requirement="${i}"><div class="fm-ap-rule-line"><span class="fm-ap-rule-title">${esc(catalog.departments.find(d=>d.id===r.department_id)?.label||'Anyone')}</span><select data-kind aria-label="Eligible resources">${options([['any','People / groups'],['organization_user','People'],['resource_group','Groups']],r.subject_type||'any')}</select><select data-mode aria-label="Attendance">${options([['count','At least'],['all','Everyone'],['percent','Percent'],['specific','Specific']],r.mode||'count')}</select>${['all','specific'].includes(r.mode)?'':`<input type="number" data-amount aria-label="${r.mode==='percent'?'Percentage required':'Number required'}" min="1" max="100" value="${r.mode==='percent'?r.percent:r.count||1}">`}<button type="button" class="fm-ap-icon-button" data-remove-rule="${i}" aria-label="Remove staffing rule" title="Remove rule">×</button></div>${r.mode==='specific'?peoplePicker(i):''}${r.subject_type!=='organization_user'?`<label class="fm-ap-inline fm-ap-roster"><span>Group attendance ${tip('0 checks the group calendar only. 100 also requires and reserves every member.')}</span><input type="number" min="0" max="100" data-crew-percent value="${r.crew_member_percent||0}"><span>%</span></label>`:''}</div>`).join('')}</div>`;
      if(steps){
        const more=ordered.length>6?ordered.filter(p=>!shownTypes.includes(p)):[];
        slots.type.innerHTML=`<div class="fm-booking-options fm-ap-step-types"><div class="fm-ap-types" aria-label="Appointment types">${shownTypes.map(typeCard).join('')}</div>${more.length?`<details class="fm-ap-more-types" data-more-types ${moreOpen?'open':''}><summary><span>More types</span><small>${more.length}</small><span class="fm-ap-chevron"></span></summary><div class="fm-ap-more-body">${more.length>6?'<input type="search" data-filter-presets placeholder="Search types" aria-label="Search appointment types">':''}<div class="fm-ap-menu">${more.map(p=>`<button type="button" data-preset-button="${esc(p.id)}" aria-pressed="${p.id===config.preset_id}"><span>${esc(p.label)}</span><small>${esc(typeMeta(p.configuration))}</small></button>`).join('')}</div></div></details>`:''}<div class="fm-ap-types fm-ap-types-own"><button type="button" class="fm-ap-type fm-ap-type-custom" data-preset-button="" aria-pressed="${chosen&&!config.preset_id}"><span class="fm-ap-type-mark" aria-hidden="true">✎</span><span class="fm-ap-type-text"><b>Custom</b><small>Set it up just for this event</small></span><span class="fm-ap-type-go" aria-hidden="true"></span></button>${response.can_manage?`<button type="button" class="fm-ap-type fm-ap-type-new" data-new-type><span class="fm-ap-type-mark" aria-hidden="true">+</span><span class="fm-ap-type-text"><b>New type</b><small>Save a type for everyone, then book it</small></span><span class="fm-ap-type-go" aria-hidden="true"></span></button>`:''}</div></div>`;
        slots.quick.innerHTML=`<div class="fm-booking-options fm-ap-step-quick"><div class="fm-ap-step-row"><span class="fm-ap-caption">Duration</span>${durationHtml}</div>${peopleHtml?`<div class="fm-ap-step-row"><span class="fm-ap-caption">With</span><div class="fm-ap-step-people">${peopleHtml}</div></div>`:''}${badgesHtml?`<div class="fm-ap-badges">${badgesHtml}</div>`:''}</div>`;
        slots.advanced.innerHTML=`<div class="fm-booking-options fm-ap-sheet-fields"><label class="fm-ap-field"><span>Appointment name</span><input data-title value="${esc(config.title)}" maxlength="200" required></label><div class="fm-ap-field"><span>Location</span>${locationHtml}</div>${advancedHtml}</div>`;
      }else if(typeMode)host.innerHTML=`<div class="fm-booking-options fm-ap-sheet-fields fm-ap-type-editor"><label class="fm-ap-field"><span>Type name</span><input data-type-name maxlength="100" placeholder="e.g. Roof inspection" value="${esc(typeName)}" required autocomplete="off" enterkeyhint="done"></label><div class="fm-ap-field"><span>Duration</span>${durationHtml}</div><div class="fm-ap-field"><span>Location</span>${locationHtml}</div>${advancedHtml}</div>`;
      else host.innerHTML=`<div class="fm-booking-options ${settingsMode?'fm-ap-settings-editor':''}">
        ${settingsMode?'':presetsHtml}
        <div class="fm-ap-context">
          ${projectControl?'<div data-project-slot></div>':''}
          ${nameHtml}
          ${locationHtml}
        </div>
        <div class="fm-ap-quick">${durationHtml}${badgesHtml}${peopleHtml}</div>
        <details class="fm-ap-advanced" data-advanced ${advanced?'open':''}><summary><span>Advanced</span><span class="fm-ap-chevron"></span></summary><div class="fm-ap-advanced-body">${advancedHtml}
        </div></details>
      </div>`;
      if(projectControl)$('[data-project-slot]').append(projectControl);
      const advancedDetails=$('[data-advanced]');if(advancedDetails)advancedDetails.ontoggle=()=>{advanced=advancedDetails.open;};
      const moreTypes=$('[data-more-types]');if(moreTypes)moreTypes.ontoggle=()=>{moreOpen=moreTypes.open;};
      all('details.fm-ap-picker').forEach(details=>details.ontoggle=()=>{if(details.open){all('details.fm-ap-picker').forEach(other=>{if(other!==details&&!other.contains(details))other.open=false;});details.querySelector('input:not([type=checkbox])')?.focus();}});
      all('[data-preset-button]').forEach(button=>button.onclick=()=>choosePreset(button.dataset.presetButton));
      $('[data-new-type]')?.addEventListener('click',()=>onNewType?.());
      $('[data-type-name]')?.addEventListener('input',event=>{typeName=event.target.value;});
      $('[data-filter-presets]')?.addEventListener('input',event=>{const q=event.target.value.toLowerCase();all('.fm-ap-menu [data-preset-button]').forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(q));});
      all('[data-filter-people]').forEach(input=>input.oninput=()=>input.closest('.fm-ap-popover').querySelectorAll('[data-person-row]').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(input.value.toLowerCase())));
      all('[data-specific]').forEach(input=>input.onchange=()=>{const r=config.requirements[Number(input.dataset.specific)],keys=new Set(r.subject_keys||[]);input.checked?keys.add(input.value):keys.delete(input.value);r.subject_keys=[...keys];const picker=input.closest("details").dataset.peoplePicker;render();const reopened=$(`[data-people-picker="${picker}"]`);if(reopened)reopened.open=true;notify();});
      const titleField=$('[data-title]');
      if(titleField)titleField.oninput=event=>{titleEdited=!!event.target.value.trim();config.title=event.target.value.trim()||projectTitle||defaultTitle;};
      if(titleField)titleField.onchange=event=>{config.title=event.target.value.trim()||projectTitle||defaultTitle;event.target.value=config.title;if(!steps)markCustom();const label=$('[data-title-label]');if(label)label.textContent=config.title;notify();};
      $('[data-address]').onchange=event=>{const address=event.target.value.trim();config.location={mode:address?'custom':'none',address};if(!steps)markCustom();if(address)writeLocal(addressKey,[address,...readLocal(addressKey).filter(a=>a!==address)].slice(0,6));notify();};
      all('[data-location-preset]').forEach(b=>b.onclick=()=>{const row=locations[Number(b.dataset.locationPreset)];config.location={mode:row.mode,address:row.mode==='custom'?row.address:''};if(!steps)markCustom();render();notify();});
      all('[data-days],[data-duration],[data-window],[data-step],[data-interval],[data-count]').forEach(input=>input.onchange=()=>{
        const value=Number(input.value);if(!input.checkValidity())return;
        if(input.hasAttribute('data-days'))config.duration_days=value;
        if(input.hasAttribute('data-duration')){const exact=config.window_minutes===config.duration_minutes;config.duration_minutes=value;config.window_minutes=exact?value:Math.max(value,config.window_minutes);}
        if(input.hasAttribute('data-window'))config.window_minutes=value;
        if(input.hasAttribute('data-step'))config.slot_minutes=value;
        if(input.hasAttribute('data-interval'))config.recurrence.interval=value;
        if(input.hasAttribute('data-count'))config.recurrence.occurrence_count=value;
        markCustom();render();notify();
      });
      all('[data-duration-preset]').forEach(button=>button.onclick=()=>setDuration(Number(button.dataset.durationPreset)));
      $('[data-timing]').onchange=e=>{config.timing_mode=e.target.value;markCustom();render();notify();};
      const eventType=$('[data-event-type]');if(eventType)eventType.onchange=e=>{if(e.target.value)config.event_type_id=e.target.value;else delete config.event_type_id;notify();};
      $('[data-frequency]')?.addEventListener('change',e=>{config.recurrence.frequency=e.target.value;markCustom();render();notify();});
      $('[data-delivery]').onchange=e=>{config.delivery=e.target.checked;markCustom();render();notify();};
      $('[data-requires-project]')?.addEventListener('change',e=>{config.requires_project=e.target.checked;notify();});
      $('[data-recurring]').onchange=e=>{config.recurrence=e.target.checked?{frequency:'weekly',interval:1,occurrence_count:8}:null;markCustom();render();notify();};
      $('[data-window-toggle]')?.addEventListener('change',e=>{config.window_minutes=e.target.checked?Math.min(1440,Math.max(240,config.duration_minutes+30)):config.duration_minutes;markCustom();render();notify();});
      all('[data-department]').forEach(input=>input.onchange=()=>{if(input.checked){config.department_ids.push(input.value);config.requirements.push({department_id:input.value,subject_type:'any',mode:'count',count:1,percent:100,subject_keys:[],crew_member_percent:0});}else{config.department_ids=config.department_ids.filter(id=>id!==input.value);config.requirements=config.requirements.filter(r=>r.department_id!==input.value);}markCustom();render();notify();});
      all('[data-requirement]').forEach(row=>row.querySelectorAll('[data-kind],[data-mode],[data-amount],[data-crew-percent]').forEach(input=>input.onchange=()=>{const r=config.requirements[Number(row.dataset.requirement)];if(input.type==='number'&&!input.checkValidity())return;if(input.hasAttribute('data-kind'))r.subject_type=input.value;if(input.hasAttribute('data-mode'))r.mode=input.value;if(input.hasAttribute('data-amount'))r[r.mode==='percent'?'percent':'count']=Number(input.value);if(input.hasAttribute('data-crew-percent'))r.crew_member_percent=Number(input.value);markCustom();render();notify();}));
      $('[data-add-rule]').onclick=()=>{config.requirements.push({subject_type:'any',mode:'count',count:1,percent:100,subject_keys:[],crew_member_percent:0});markCustom();render();notify();};
      all('[data-remove-rule]').forEach(b=>b.onclick=()=>{config.requirements.splice(Number(b.dataset.removeRule),1);markCustom();render();notify();});
    }
    function choosePreset(id){
      const previousTitle=config.title,preset=catalog.presets.find(p=>p.id===id);config={...empty(),...structuredClone(preset?.configuration||{})};defaultTitle=config.title;config.title=titleEdited?previousTitle:projectTitle||defaultTitle;if(preset)config.preset_id=id;chosen=true;
      if(id)writeLocal(recentKey,[id,...readLocal(recentKey).filter(value=>value!==id)].slice(0,8));moreOpen=false;render();notify();onPreset?.(id);
    }
    function setDuration(value,emit=true){if(config.timing_mode==='days')config.duration_days=value;else{const exact=config.window_minutes===config.duration_minutes;config.duration_minutes=value;config.window_minutes=exact?value:Math.max(value,config.window_minutes);}render();if(emit)notify();}
    // A booking is named after the project as people see it (the branch's title mode, by default its contacts), not a stored title that is only the address.
    function projectName(data){
      const shown=(Array.isArray(data.contacts)&&data.contacts.length)||data.address?String(window.Portal?.modules?.request?.projectDisplayTitle?.(data)||'').trim():'';
      const stored=String(data.title||'').trim();
      return shown||(stored&&stored!==String(projectAddress||'').trim()?stored:'')||String(data.customer_name||'').trim()||stored;
    }
    async function setProject(id,emit=true){
      const ticket=++projectSequence;projectAddress='';projectTitle='';
      if(id){try{const result=await window.PlatformAPI.projects.get(orgId,id),data=result.document?.data||{};if(ticket!==projectSequence||disposed)return;projectAddress=typeof data.address==='string'?data.address:typeof data.project_address==='string'?data.project_address:'';projectTitle=projectName(data).slice(0,200);}catch{}}
      if(disposed||ticket!==projectSequence)return;
      if(config.location.mode==='project'){const input=$('[data-address]');if(input)input.value=projectAddress;}
      if(!settingsMode&&!titleEdited){const next=projectTitle||defaultTitle;if(config.title!==next){config.title=next;const field=$('[data-title]'),label=$('[data-title-label]');if(field)field.value=next;if(label)label.textContent=next;if(emit)notify();}}
    }
    function setLocation(location,emit=true){config.location={mode:location?.mode||'project',address:location?.mode==='custom'?String(location.address||'').trim():''};render();if(emit)notify();}
    /* The New appointment type editor saves its settings as a type named by the person; bookings of it are named after the type. */
    async function saveType(){
      const label=typeName.trim();
      if(!response.can_manage)throw new Error('Only people who manage appointment types can add one.');
      if(!label){$('[data-type-name]')?.focus();throw new Error('Name the type first.');}
      const next=structuredClone(response.catalog),id=crypto.randomUUID(),configuration=structuredClone(config);delete configuration.preset_id;configuration.title=label;
      next.presets.push({id,label,configuration});
      response=await window.PlatformAPI.appointments.saveCatalog(orgId,{catalog:next,revision:response.revision});catalog=response.catalog;
      return {id,response:structuredClone(response)};
    }
    /* A type saved elsewhere (the New appointment type editor) joins this catalog and is chosen, as if tapped. */
    function adoptType(id,saved){if(disposed)return;if(saved?.catalog){response=saved;catalog=saved.catalog;}choosePreset(id);}
    /* Help bubbles open on tap (and on hover where there is one), one at a time, kept inside the editor. */
    function showHelp(button,open){
      all('[data-help][aria-expanded=true]').forEach(other=>{if(other!==button)other.setAttribute('aria-expanded','false');});
      button.setAttribute('aria-expanded',String(open));
      const bubble=button.nextElementSibling;if(!open||!bubble)return;
      bubble.style.setProperty('--fm-ap-help-shift','0px');
      const box=bubble.getBoundingClientRect(),area=(button.closest('.fm-booking-options')||document.documentElement).getBoundingClientRect();
      const left=Math.max(area.left,0)+8,right=Math.min(area.right,document.documentElement.clientWidth)-8;
      const shift=box.left<left?left-box.left:box.right>right?right-box.right:0;
      bubble.style.setProperty('--fm-ap-help-shift',`${Math.round(shift)}px`);
    }
    /* A mouse shows the bubble while it rests on the mark; a click (or a tap) keeps it open until the next tap elsewhere. */
    function helpClick(event){const button=event.target.closest?.('[data-help]');if(!button)return;event.preventDefault();const hovered=button.dataset.helpHover==='1';delete button.dataset.helpHover;showHelp(button,hovered||button.getAttribute('aria-expanded')!=='true');}
    function helpHover(event){if(event.pointerType!=='mouse')return;const button=event.target.closest?.('[data-help]');if(button&&button.getAttribute('aria-expanded')!=='true'){button.dataset.helpHover='1';showHelp(button,true);}}
    function helpLeave(event){if(event.pointerType!=='mouse')return;const button=event.target.closest?.('[data-help]');if(button&&button.dataset.helpHover==='1'&&!button.contains(event.relatedTarget)){delete button.dataset.helpHover;button.setAttribute('aria-expanded','false');}}
    function dismissPickers(event){all('details.fm-ap-picker[open]').forEach(details=>{if(!details.contains(event.target))details.open=false;});all('[data-help][aria-expanded=true]').forEach(button=>{if(!button.contains(event.target))button.setAttribute('aria-expanded','false');});}
    function escapePicker(event){if(event.key!=='Escape')return;const help=$('[data-help][aria-expanded=true]');if(help){event.preventDefault();event.stopPropagation();help.setAttribute('aria-expanded','false');help.focus();return;}const open=$('details.fm-ap-picker[open]');if(open){event.preventDefault();event.stopPropagation();all('details.fm-ap-picker[open]').forEach(d=>d.open=false);open.querySelector('summary')?.focus();}}
    document.addEventListener('pointerdown',dismissPickers,true);document.addEventListener('focusin',dismissPickers,true);hosts.forEach(h=>{h.addEventListener('keydown',escapePicker,true);h.addEventListener('click',helpClick);h.addEventListener('pointerover',helpHover);h.addEventListener('pointerout',helpLeave);});

    render();await setProject(projectId,false);
    return {get value(){return structuredClone(config);},get catalog(){return catalog;},get availabilityHint(){return config.requirements.some(r=>r.subject_type==='resource_group')&&!resources.some(r=>r.subject_type==='resource_group')?'No crews are configured for this appointment. Add a crew in Settings.':'';},get canManage(){return !!response.can_manage;},get project(){return {title:projectTitle,address:projectAddress};},get requiresProject(){return config.requires_project===true;},get presetLabel(){return catalog.presets.find(p=>p.id===config.preset_id)?.label||'';},setProject,setDuration,setLocation,saveType,adoptType,destroy(){disposed=true;projectSequence++;document.removeEventListener('pointerdown',dismissPickers,true);document.removeEventListener('focusin',dismissPickers,true);hosts.forEach(h=>{h.removeEventListener('keydown',escapePicker,true);h.removeEventListener('click',helpClick);h.removeEventListener('pointerover',helpHover);h.removeEventListener('pointerout',helpLeave);h.replaceChildren();});}};
  }
  window.FirstMateAppointmentConfiguration={mount,ensureStyle};
})();
