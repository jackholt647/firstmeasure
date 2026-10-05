/* Shared appointment configuration editor. Catalog administration lives in Settings. */
(function(){
  if(window.FirstMateAppointmentConfiguration)return;
  const source=document.currentScript?.src||new URL('/libraries/appointment-booking/configuration.js',location.href).href;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const empty=()=>({title:'Appointment',department_ids:[],delivery:false,timing_mode:'timed',duration_days:2,location:{mode:'project',address:''},duration_minutes:60,window_minutes:60,slot_minutes:30,requirements:[],recurrence:null});
  const tip=text=>`<span class="fm-ap-help" tabindex="0" role="img" aria-label="${esc(text)}" title="${esc(text)}" data-fm-tooltip="${esc(text)}">?</span>`;
  const options=(rows,value)=>rows.map(([id,label])=>`<option value="${esc(id)}" ${id===value?'selected':''}>${esc(label)}</option>`).join('');
  function ensureStyle(){if(document.getElementById('fm-appointment-style'))return;const link=document.createElement('link');link.id='fm-appointment-style';link.rel='stylesheet';link.href=new URL('booking.css',source).href;document.head.append(link);}
  function readLocal(key){try{return JSON.parse(localStorage.getItem(key)||'[]');}catch{return [];}}
  function writeLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
  async function mount(host,{orgId,onChange,initialValue,settingsMode=false,projectControl,projectId}={}){
    ensureStyle();
    const response=await window.PlatformAPI.appointments.catalog(orgId),catalog=response.catalog;
    let config={...empty(),...structuredClone(initialValue||{})},disposed=false,advanced=settingsMode,projectAddress='',projectSequence=0;
    const user=window.Portal?.cfg?.userId||window.__APP?.userId||'session';
    const recentKey=`fm:appointment-presets:${orgId}:${user}`,addressKey=`fm:appointment-addresses:${orgId}:${user}`;
    const resources=response.resources.filter(r=>['organization_user','resource_group'].includes(r.subject_type));
    const $=s=>host.querySelector(s);
    const markCustom=()=>{delete config.preset_id;host.querySelectorAll('[data-preset-button]').forEach(b=>b.setAttribute('aria-pressed',String(!b.dataset.presetButton)));};
    const notify=()=>onChange?.(structuredClone(config));
    const number=(label,attr,value,min,max)=>`<label class="fm-ap-field"><span>${label}</span><input type="number" ${attr} value="${value}" min="${min}" max="${max}"></label>`;
    const toggle=(label,attr,checked,help)=>`<label class="fm-ap-toggle"><input type="checkbox" role="switch" ${attr} ${checked?'checked':''}><span class="fm-ap-track" aria-hidden="true"></span><span>${label}</span>${help?tip(help):''}</label>`;
    function peoplePicker(index,quick=false){
      const rule=config.requirements[index],keys=rule.subject_keys||[];
      const names=resources.filter(r=>keys.includes(r.key)).map(r=>r.name);
      return `<details class="fm-ap-picker" data-people-picker="${index}-${quick}"><summary aria-label="Choose people or groups">${esc(names.length?names.length>1?`${names[0]} +${names.length-1}`:names[0]:'Choose people or groups')}<span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><input type="search" data-filter-people placeholder="Search people or groups" aria-label="Search people or groups"><div class="fm-ap-people">${resources.map(r=>`<label data-person-row><input type="checkbox" data-specific="${index}" value="${esc(r.key)}" ${keys.includes(r.key)?'checked':''}><span>${esc(r.name)}${r.subject_type==='resource_group'?'<small>Group</small>':''}</span></label>`).join('')}</div></div></details>`;
    }
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
      const ordered=[...readLocal(recentKey),...catalog.presets.map(p=>p.id)];
      const recent=[...new Set(ordered)].map(id=>catalog.presets.find(p=>p.id===id)).filter(Boolean).slice(0,4);
      if(config.preset_id&&!recent.some(p=>p.id===config.preset_id)){const selected=catalog.presets.find(p=>p.id===config.preset_id);if(selected)recent[recent.length?recent.length-1:0]=selected;}
      const locations=locationRows(),windowOn=config.timing_mode!=='days'&&config.window_minutes>config.duration_minutes;
      host.innerHTML=`<div class="fm-booking-options ${settingsMode?'fm-ap-settings-editor':''}">
        ${settingsMode?'':`<div class="fm-ap-presets" aria-label="Appointment presets">${recent.map(p=>`<button type="button" data-preset-button="${esc(p.id)}" aria-pressed="${p.id===config.preset_id}" title="${esc(p.label)}">${esc(p.label.replace(/ appointments$/i,'').replace(/ appointment$/i,'').replace(/^Company sales meeting$/,'Sales meeting'))}</button>`).join('')}<button type="button" data-preset-button="" aria-pressed="${!config.preset_id}">Custom</button><details class="fm-ap-picker fm-ap-more"><summary>More<span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><input type="search" data-filter-presets placeholder="Search presets" aria-label="Search appointment presets"><div class="fm-ap-menu">${catalog.presets.map(p=>`<button type="button" data-preset-button="${esc(p.id)}">${esc(p.label)}</button>`).join('')}</div></div></details></div>`}
        <div class="fm-ap-context">
          ${projectControl?'<div data-project-slot></div>':''}
          <details class="fm-ap-picker fm-ap-name"><summary title="Rename appointment"><span class="fm-ap-icon" aria-hidden="true">✎</span><span data-title-label>${esc(config.title)}</span><span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover"><label class="fm-ap-field">Appointment name<input data-title value="${esc(config.title)}" maxlength="200" required></label></div></details>
          <div class="fm-ap-location"><span class="fm-ap-icon" aria-hidden="true">⌖</span><input data-address aria-label="Appointment location" maxlength="1000" value="${esc(locationValue())}" placeholder="${config.location?.mode==='company_office'?'Company office address':config.location?.mode==='none'?'No location':'Type an address'}" title="${esc(config.location?.mode==='company_office'?'Company office — uses the address in Company Settings. Type to override.':'Type any address, or choose a saved location.')}" autocomplete="street-address"><details class="fm-ap-picker"><summary aria-label="Location presets" title="Location presets"><span class="fm-ap-chevron"></span></summary><div class="fm-ap-popover fm-ap-location-menu">${locations.map((l,i)=>`<button type="button" data-location-preset="${i}"><span>${esc(l.label)}</span>${l.mode!=='custom'&&l.address?`<small>${esc(l.address)}</small>`:''}</button>`).join('')}</div></details></div>
        </div>
        <div class="fm-ap-quick"><label class="fm-ap-inline"><span>${config.timing_mode==='days'?'Days':'Duration'}</span><input type="number" ${config.timing_mode==='days'?'data-days':'data-duration'} value="${config.timing_mode==='days'?config.duration_days:config.duration_minutes}" min="${config.timing_mode==='days'?1:5}" max="${config.timing_mode==='days'?31:1440}"><span>${config.timing_mode==='days'?'full days':'min'}</span></label>${config.delivery?'<span class="fm-ap-badge">Delivery</span>':''}${config.recurrence?`<span class="fm-ap-badge">${esc(config.recurrence.frequency)}</span>`:''}${windowOn?`<span class="fm-ap-badge">${config.window_minutes/60}h arrival window</span>`:''}${config.requirements.map((r,i)=>r.mode==='specific'?peoplePicker(i,true):'').join('')}</div>
        <details class="fm-ap-advanced" data-advanced ${advanced?'open':''}><summary><span>Advanced</span><span class="fm-ap-chevron"></span></summary><div class="fm-ap-advanced-body">
          <div class="fm-ap-departments"><span class="fm-ap-caption">Departments</span><div>${catalog.departments.map(d=>`<label class="fm-ap-chip"><input type="checkbox" data-department value="${esc(d.id)}" ${config.department_ids.includes(d.id)?'checked':''}><span>${esc(d.label)}</span></label>`).join('')}</div></div>
          <div class="fm-ap-switches">${toggle('Delivery','data-delivery',config.delivery,'Marks a delivery without creating a material order.')}${toggle('Recurring','data-recurring',!!config.recurrence,'Checks all occurrences with the same team. Up to 52 within two years.')}${config.timing_mode==='days'?'':toggle('Arrival window','data-window-toggle',windowOn,'Reserve the duration inside a longer customer arrival window.')}</div>
          <div class="fm-ap-fields"><label class="fm-ap-field"><span>Schedule by</span><select data-timing>${options([['timed','Time'],['days','Full days']],config.timing_mode)}</select></label>${config.timing_mode==='days'?'':`${windowOn?number('Arrival window · min','data-window',config.window_minutes,config.duration_minutes,1440):''}${number('Start interval · min','data-step',config.slot_minutes,5,240)}`}</div>
          ${config.recurrence?`<div class="fm-ap-fields"><label class="fm-ap-field"><span>Repeat</span><select data-frequency>${options([['daily','Daily'],['weekly','Weekly'],['monthly','Monthly'],['quarterly','Quarterly'],['yearly','Yearly']],config.recurrence.frequency)}</select></label>${number('Every','data-interval',config.recurrence.interval,1,52)}${number('Occurrences','data-count',config.recurrence.occurrence_count,2,52)}</div>`:''}
          <div class="fm-ap-staff-heading"><span class="fm-ap-caption">Staffing ${tip('All rules must be satisfied before a time is available.')}</span><button type="button" class="fm-ap-text-button" data-add-rule>+ Add rule</button></div>
          <div class="fm-ap-rules">${config.requirements.map((r,i)=>`<div class="fm-ap-rule" data-requirement="${i}"><div class="fm-ap-rule-line"><span class="fm-ap-rule-title">${esc(catalog.departments.find(d=>d.id===r.department_id)?.label||'Anyone')}</span><select data-kind aria-label="Eligible resources">${options([['any','People / groups'],['organization_user','People'],['resource_group','Groups']],r.subject_type||'any')}</select><select data-mode aria-label="Attendance">${options([['count','At least'],['all','Everyone'],['percent','Percent'],['specific','Specific']],r.mode||'count')}</select>${['all','specific'].includes(r.mode)?'':`<input type="number" data-amount aria-label="${r.mode==='percent'?'Percentage required':'Number required'}" min="1" max="100" value="${r.mode==='percent'?r.percent:r.count||1}">`}<button type="button" class="fm-ap-icon-button" data-remove-rule="${i}" aria-label="Remove staffing rule" title="Remove rule">×</button></div>${r.mode==='specific'?peoplePicker(i):''}${r.subject_type!=='organization_user'?`<label class="fm-ap-inline fm-ap-roster"><span>Group attendance ${tip('0 checks the group calendar only. 100 also requires and reserves every member.')}</span><input type="number" min="0" max="100" data-crew-percent value="${r.crew_member_percent||0}"><span>%</span></label>`:''}</div>`).join('')}</div>
        </div></details>
      </div>`;
      if(projectControl)$('[data-project-slot]').append(projectControl);
      $('[data-advanced]').ontoggle=()=>{advanced=$('[data-advanced]').open;};
      host.querySelectorAll('details.fm-ap-picker').forEach(details=>details.ontoggle=()=>{if(details.open){host.querySelectorAll('details.fm-ap-picker').forEach(other=>{if(other!==details&&!other.contains(details))other.open=false;});details.querySelector('input:not([type=checkbox])')?.focus();}});
      host.querySelectorAll('[data-preset-button]').forEach(button=>button.onclick=()=>{
        const id=button.dataset.presetButton,preset=catalog.presets.find(p=>p.id===id);config={...empty(),...structuredClone(preset?.configuration||{})};if(preset)config.preset_id=id;
        if(id)writeLocal(recentKey,[id,...readLocal(recentKey).filter(value=>value!==id)].slice(0,8));render();notify();
      });
      $('[data-filter-presets]')?.addEventListener('input',event=>{const q=event.target.value.toLowerCase();host.querySelectorAll('.fm-ap-menu [data-preset-button]').forEach(b=>b.hidden=!b.textContent.toLowerCase().includes(q));});
      host.querySelectorAll('[data-filter-people]').forEach(input=>input.oninput=()=>input.closest('.fm-ap-popover').querySelectorAll('[data-person-row]').forEach(row=>row.hidden=!row.textContent.toLowerCase().includes(input.value.toLowerCase())));
      host.querySelectorAll('[data-specific]').forEach(input=>input.onchange=()=>{const r=config.requirements[Number(input.dataset.specific)],keys=new Set(r.subject_keys||[]);input.checked?keys.add(input.value):keys.delete(input.value);r.subject_keys=[...keys];const picker=input.closest("details").dataset.peoplePicker;render();const reopened=host.querySelector(`[data-people-picker="${picker}"]`);if(reopened)reopened.open=true;notify();});
      $('[data-title]').onchange=event=>{config.title=event.target.value.trim()||'Appointment';markCustom();$('[data-title-label]').textContent=config.title;notify();};
      $('[data-address]').onchange=event=>{const address=event.target.value.trim();config.location={mode:address?'custom':'none',address};markCustom();if(address)writeLocal(addressKey,[address,...readLocal(addressKey).filter(a=>a!==address)].slice(0,6));notify();};
      host.querySelectorAll('[data-location-preset]').forEach(b=>b.onclick=()=>{const row=locations[Number(b.dataset.locationPreset)];config.location={mode:row.mode,address:row.mode==='custom'?row.address:''};markCustom();render();notify();});
      host.querySelectorAll('[data-days],[data-duration],[data-window],[data-step],[data-interval],[data-count]').forEach(input=>input.onchange=()=>{
        const value=Number(input.value);if(!input.checkValidity())return;
        if(input.hasAttribute('data-days'))config.duration_days=value;
        if(input.hasAttribute('data-duration')){const exact=config.window_minutes===config.duration_minutes;config.duration_minutes=value;config.window_minutes=exact?value:Math.max(value,config.window_minutes);}
        if(input.hasAttribute('data-window'))config.window_minutes=value;
        if(input.hasAttribute('data-step'))config.slot_minutes=value;
        if(input.hasAttribute('data-interval'))config.recurrence.interval=value;
        if(input.hasAttribute('data-count'))config.recurrence.occurrence_count=value;
        markCustom();render();notify();
      });
      $('[data-timing]').onchange=e=>{config.timing_mode=e.target.value;markCustom();render();notify();};
      $('[data-frequency]')?.addEventListener('change',e=>{config.recurrence.frequency=e.target.value;markCustom();render();notify();});
      $('[data-delivery]').onchange=e=>{config.delivery=e.target.checked;markCustom();render();notify();};
      $('[data-recurring]').onchange=e=>{config.recurrence=e.target.checked?{frequency:'weekly',interval:1,occurrence_count:8}:null;markCustom();render();notify();};
      $('[data-window-toggle]')?.addEventListener('change',e=>{config.window_minutes=e.target.checked?Math.min(1440,Math.max(240,config.duration_minutes+30)):config.duration_minutes;markCustom();render();notify();});
      host.querySelectorAll('[data-department]').forEach(input=>input.onchange=()=>{if(input.checked){config.department_ids.push(input.value);config.requirements.push({department_id:input.value,subject_type:'any',mode:'count',count:1,percent:100,subject_keys:[],crew_member_percent:0});}else{config.department_ids=config.department_ids.filter(id=>id!==input.value);config.requirements=config.requirements.filter(r=>r.department_id!==input.value);}markCustom();render();notify();});
      host.querySelectorAll('[data-requirement]').forEach(row=>row.querySelectorAll('[data-kind],[data-mode],[data-amount],[data-crew-percent]').forEach(input=>input.onchange=()=>{const r=config.requirements[Number(row.dataset.requirement)];if(input.type==='number'&&!input.checkValidity())return;if(input.hasAttribute('data-kind'))r.subject_type=input.value;if(input.hasAttribute('data-mode'))r.mode=input.value;if(input.hasAttribute('data-amount'))r[r.mode==='percent'?'percent':'count']=Number(input.value);if(input.hasAttribute('data-crew-percent'))r.crew_member_percent=Number(input.value);markCustom();render();notify();}));
      $('[data-add-rule]').onclick=()=>{config.requirements.push({subject_type:'any',mode:'count',count:1,percent:100,subject_keys:[],crew_member_percent:0});markCustom();render();notify();};
      host.querySelectorAll('[data-remove-rule]').forEach(b=>b.onclick=()=>{config.requirements.splice(Number(b.dataset.removeRule),1);markCustom();render();notify();});
    }
    async function setProject(id){const ticket=++projectSequence;projectAddress='';if(id){try{const result=await window.PlatformAPI.projects.get(orgId,id),data=result.document?.data||{};if(ticket!==projectSequence||disposed)return;projectAddress=typeof data.address==='string'?data.address:typeof data.project_address==='string'?data.project_address:'';}catch{}}if(!disposed&&ticket===projectSequence&&config.location.mode==='project'){const input=$('[data-address]');if(input)input.value=projectAddress;}}
    render();void setProject(projectId);
    return {get value(){return structuredClone(config);},get catalog(){return catalog;},setProject,destroy(){disposed=true;projectSequence++;host.replaceChildren();}};
  }
  window.FirstMateAppointmentConfiguration={mount,ensureStyle};
})();
